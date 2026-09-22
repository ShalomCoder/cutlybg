import type { InferenceSession, Tensor } from "onnxruntime-web";
import { MODELS, type ModelKind, type OnnxModel } from "./models";

export type ProgressPhase = "download" | "compile" | "inference";

export interface ProgressState {
  phase: ProgressPhase;
  loaded?: number;
  total?: number;
}

export type ProgressHandler = (progress: ProgressState) => void;

const CACHE_NAME = "cutlybg-models";
const sessionCache = new Map<
  ModelKind,
  Promise<InferenceSession> | undefined
>();

let ortPromise: Promise<typeof import("onnxruntime-web")> | null = null;

function loadOrt() {
  // Lazy-load only when the user first runs the on-device path.
  ortPromise ??= import("onnxruntime-web");
  return ortPromise;
}

function noop(): void {}

async function fetchWithProgress(
  url: string,
  fallbackSize: number,
  onProgress: ProgressHandler,
  signal?: AbortSignal,
): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(url);
  if (cached) return cached;

  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Model download failed (HTTP ${response.status}).`);
  }

  const body = response.body;
  if (!body) {
    onProgress({ phase: "download", loaded: fallbackSize, total: fallbackSize });
    return response;
  }

  const total = Number(response.headers.get("content-length")) || fallbackSize;
  const reader = body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let loaded = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength > 0) {
      chunks.push(new Uint8Array(value));
      loaded += value.byteLength;
      onProgress({ phase: "download", loaded, total });
    }
  }

  const combined = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const blob = new Blob([combined], { type: "application/octet-stream" });
  const constructed = new Response(blob);
  try {
    await cache.put(url, constructed.clone());
  } catch {
    // Caching is best-effort; a repeat download still "works".
  }
  return constructed;
}

async function loadModel(
  kind: ModelKind,
  onProgress: ProgressHandler,
  signal?: AbortSignal,
): Promise<InferenceSession> {
  const model = MODELS[kind];
  onProgress({ phase: "download", loaded: 0, total: model.sizeBytes });

  let buffer: ArrayBuffer;
  if (typeof caches !== "undefined") {
    const response = await fetchWithProgress(
      model.url,
      model.sizeBytes,
      onProgress,
      signal,
    );
    buffer = await response.arrayBuffer();
  } else {
    // Non-browser environment (shouldn't happen in practice).
    const response = await fetch(model.url, { signal });
    buffer = await response.arrayBuffer();
  }

  const ort = await loadOrt();
  ort.env.wasm.wasmPaths = "/ort/";

  onProgress({ phase: "compile" });
  const options = {
    executionProviders: ["webgpu"] as const,
    intraOpNumThreads: 1,
  };
  try {
    return await ort.InferenceSession.create(buffer, options);
  } catch {
    // WebGPU unavailable (Firefox/Safari) or compile failure: retry on WASM.
    onProgress({ phase: "compile" });
    return await ort.InferenceSession.create(buffer, {
      executionProviders: ["wasm"] as const,
      intraOpNumThreads: 1,
    });
  }
}

export function ensureModel(
  kind: ModelKind,
  onProgress: ProgressHandler = noop,
  signal?: AbortSignal,
): Promise<InferenceSession> {
  const existing = sessionCache.get(kind);
  if (existing) return existing;

  const loading = loadModel(kind, onProgress, signal);
  sessionCache.set(kind, loading);
  loading.catch(() => sessionCache.set(kind, undefined));
  return loading;
}

async function decodeBitmap(blob: Blob): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== "function") {
    throw new Error(
      "In-browser processing isn't supported in this browser — please switch to Server mode.",
    );
  }
  return createImageBitmap(blob);
}

interface PreparedInput {
  tensor: Float32Array;
  geometry: {
    w: number;
    h: number;
    drawW: number;
    drawH: number;
    offsetX: number;
    offsetY: number;
  };
}

async function prepareInput(bitmap: ImageBitmap, model: OnnxModel): Promise<PreparedInput> {
  const w = bitmap.width;
  const h = bitmap.height;
  const size = model.inputSize;
  const scale = Math.min(size / w, size / h);
  const drawW = Math.max(1, Math.round(w * scale));
  const drawH = Math.max(1, Math.round(h * scale));
  const offsetX = Math.round((size - drawW) / 2);
  const offsetY = Math.round((size - drawH) / 2);

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas is not supported.");
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(bitmap, offsetX, offsetY, drawW, drawH);

  const pixels = ctx.getImageData(0, 0, size, size).data;
  const tensor = new Float32Array(size * size * 3);
  const plane = size * size;

  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const index = i / 4;
    tensor[index] = (r - 127.5) / 127.5;
    tensor[plane + index] = (g - 127.5) / 127.5;
    tensor[2 * plane + index] = (b - 127.5) / 127.5;
  }

  return { tensor, geometry: { w, h, drawW, drawH, offsetX, offsetY } };
}

function sigmoidPixel(
  values: Float32Array,
  plane: number,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(plane * 4);
  for (let i = 0; i < plane; i += 1) {
    const v = 1 / (1 + Math.exp(-values[i]));
    const alpha = Math.round(v * 255);
    const o = i * 4;
    out[o] = alpha;
    out[o + 1] = alpha;
    out[o + 2] = alpha;
    out[o + 3] = 255;
  }
  return out;
}

export async function removeBackgroundOnDevice(
  blob: Blob,
  kind: ModelKind,
  onProgress: ProgressHandler = noop,
  signal?: AbortSignal,
): Promise<Blob> {
  const model = MODELS[kind];
  onProgress({ phase: "download", loaded: 0, total: model.sizeBytes });

  const session = await ensureModel(kind, onProgress, signal);
  const size = model.inputSize;

  onProgress({ phase: "compile" });
  const bitmap = await decodeBitmap(blob);
  const { tensor, geometry } = await prepareInput(bitmap, model);
  bitmap.close();

  onProgress({ phase: "inference" });
  const ort = await loadOrt();
  const feeds: Record<string, Tensor> = {};
  feeds[session.inputNames[0] ?? "input"] = new ort.Tensor(
    "float32",
    tensor,
    [1, 3, size, size],
  );
  const outputs = await session.run(feeds);
  const outputKey = session.outputNames[0] ?? "output";
  const maskValues = outputs[outputKey].data as Float32Array;

  const plane = size * size;
  const maskPixels = sigmoidPixel(maskValues, plane);
  const maskImage = new ImageData(maskPixels, size, size);
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = size;
  maskCanvas.height = size;
  maskCanvas.getContext("2d")?.putImageData(maskImage, 0, 0);

  const { w, h, drawW, drawH, offsetX, offsetY } = geometry;
  const outCanvas = document.createElement("canvas");
  outCanvas.width = w;
  outCanvas.height = h;
  const outCtx = outCanvas.getContext("2d", { willReadFrequently: true });
  if (!outCtx) throw new Error("Canvas is not supported.");

  const original = await decodeBitmap(blob);
  outCtx.drawImage(original, 0, 0, w, h);
  original.close();

  const alphaImage = outCtx.getImageData(0, 0, w, h);

  const bigMask = document.createElement("canvas");
  bigMask.width = w;
  bigMask.height = h;
  const maskCtx = bigMask.getContext("2d", { willReadFrequently: true });
  if (!maskCtx) throw new Error("Canvas is not supported.");
  maskCtx.fillStyle = "#000000";
  maskCtx.fillRect(0, 0, w, h);
  maskCtx.drawImage(maskCanvas, offsetX, offsetY, drawW, drawH);
  const maskBig = maskCtx.getImageData(0, 0, w, h).data;

  const pixels = alphaImage.data;
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i + 3] = maskBig[i];
  }
  outCtx.putImageData(alphaImage, 0, 0);

  return new Promise<Blob>((resolve, reject) => {
    outCanvas.toBlob(
      (result) => {
        if (result) resolve(result);
        else reject(new Error("Couldn't build the result image."));
      },
      "image/png",
    );
  });
}