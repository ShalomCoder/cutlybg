import type { InferenceSession, Tensor } from "onnxruntime-web";
import { MODELS, type ModelKind } from "./models";

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

function normalizeChannel(v: number, kind: ModelKind): number {
  // ISNet (imgly) is trained with (value - 128) / 256; MODNet (transformers.js)
  // uses (value - 127.5) / 127.5. Both expect RGB channel order.
  return kind === "isnet" ? (v - 128) / 256 : (v - 127.5) / 127.5;
}

interface PreparedInput {
  tensor: Float32Array;
  outW: number;
  outH: number;
  modelW: number;
  modelH: number;
  maskCropW: number;
  maskCropH: number;
}

async function prepareInput(
  bitmap: ImageBitmap,
  kind: ModelKind,
): Promise<PreparedInput> {
  const outW = bitmap.width;
  const outH = bitmap.height;

  let modelW: number;
  let modelH: number;
  let drawW: number;
  let drawH: number;

  if (kind === "isnet") {
    // ISNet is fed a straight 1024x1024 stretch (no crop, no letterbox).
    modelW = 1024;
    modelH = 1024;
    drawW = 1024;
    drawH = 1024;
  } else {
    // MODNet resizes so the shortest edge is 512 and pads to a multiple of 32
    // (see Xenova/modnet preprocessor_config.json: shortest_edge 512,
    // size_divisibility 32). Aspect ratio is preserved.
    const scale = 512 / Math.min(outW, outH);
    drawW = Math.max(1, Math.round(outW * scale));
    drawH = Math.max(1, Math.round(outH * scale));
    modelW = Math.ceil(drawW / 32) * 32;
    modelH = Math.ceil(drawH / 32) * 32;
  }

  const canvas = document.createElement("canvas");
  canvas.width = modelW;
  canvas.height = modelH;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas is not supported.");
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, modelW, modelH);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, drawW, drawH);

  const pixels = ctx.getImageData(0, 0, modelW, modelH).data;
  const plane = modelW * modelH;
  const tensor = new Float32Array(plane * 3);

  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const index = i / 4;
    tensor[index] = normalizeChannel(r, kind);
    tensor[plane + index] = normalizeChannel(g, kind);
    tensor[2 * plane + index] = normalizeChannel(b, kind);
  }

  return { tensor, outW, outH, modelW, modelH, maskCropW: drawW, maskCropH: drawH };
}

function maskToAlpha(
  values: Float32Array,
  plane: number,
): Uint8ClampedArray<ArrayBuffer> {
  // Both models emit probabilities already in [0, 1] (sigmoid is baked into
  // the ONNX graph), so the value maps straight to alpha.
  const out = new Uint8ClampedArray(plane * 4);
  for (let i = 0; i < plane; i += 1) {
    const v = values[i] ?? 0;
    const alpha = Math.max(0, Math.min(255, Math.round(v * 255)));
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

  onProgress({ phase: "compile" });
  const bitmap = await decodeBitmap(blob);
  const prepared = await prepareInput(bitmap, kind);
  bitmap.close();

  onProgress({ phase: "inference" });
  const ort = await loadOrt();
  const feeds: Record<string, Tensor> = {};
  feeds[session.inputNames[0] ?? "input"] = new ort.Tensor(
    "float32",
    prepared.tensor,
    [1, 3, prepared.modelH, prepared.modelW],
  );
  const outputs = await session.run(feeds);
  const outputKey = session.outputNames[0] ?? "output";
  const maskValues = outputs[outputKey].data as Float32Array;

  const plane = prepared.modelW * prepared.modelH;
  const maskPixels = maskToAlpha(maskValues, plane);
  const maskImage = new ImageData(maskPixels, prepared.modelW, prepared.modelH);

  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = prepared.modelW;
  maskCanvas.height = prepared.modelH;
  maskCanvas.getContext("2d")?.putImageData(maskImage, 0, 0);

  const { outW, outH } = prepared;
  const outCanvas = document.createElement("canvas");
  outCanvas.width = outW;
  outCanvas.height = outH;
  const outCtx = outCanvas.getContext("2d", { willReadFrequently: true });
  if (!outCtx) throw new Error("Canvas is not supported.");

  const original = await decodeBitmap(blob);
  outCtx.drawImage(original, 0, 0, outW, outH);
  original.close();

  // Upscale the mask to the original resolution: the resized image back to
  // the full canvas (crop away any MODNet divisibility padding).
  const bigMask = document.createElement("canvas");
  bigMask.width = outW;
  bigMask.height = outH;
  const maskCtx = bigMask.getContext("2d", { willReadFrequently: true });
  if (!maskCtx) throw new Error("Canvas is not supported.");
  maskCtx.fillStyle = "#000000";
  maskCtx.fillRect(0, 0, outW, outH);
  maskCtx.imageSmoothingQuality = "high";
  maskCtx.drawImage(
    maskCanvas,
    0,
    0,
    prepared.maskCropW,
    prepared.maskCropH,
    0,
    0,
    outW,
    outH,
  );
  const maskBig = maskCtx.getImageData(0, 0, outW, outH).data;

  const pixels = outCtx.getImageData(0, 0, outW, outH);
  const data = pixels.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i + 3] = maskBig[i];
  }
  outCtx.putImageData(pixels, 0, 0);

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