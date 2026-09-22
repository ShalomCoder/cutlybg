import type { Tensor } from "onnxruntime-web";
import {
  ensureModel,
  loadOrt,
  type ProgressHandler,
} from "./background-removal";

export type UpscaleFactor = 2 | 4;

export interface UpscaleResult {
  blob: Blob;
  scale: number;
  outW: number;
  outH: number;
}

/**
 * On-device upscaling with the tiny ONNX Model Zoo Super-Resolution model
 * (super-resolution-10.onnx, Apache-2.0). The model is a fixed 224x224 ->
 * 672x672 luminance sharpener, so larger images are processed tile-by-tile
 * and the chroma + alpha channels are upscaled with high-quality smoothing on
 * the same geometry (keeps transparent cutouts transparent and avoids halos).
 */

const TILE = 224; // model input edge
const OUT_TILE = 672; // model output edge (3x)
const STRIDE = 208; // tile stride (input space); cores are 208 wide
const MAX_EDGE = 4096; // cap on the result's long edge

function abortIfRequested(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

async function decodeImage(blob: Blob): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== "function") {
    throw new Error(
      "In-browser processing isn't supported in this browser — please switch to Server mode.",
    );
  }
  return createImageBitmap(blob);
}

function rgbToY(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function rgbToCb(r: number, g: number, b: number): number {
  return -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
}

function rgbToCr(r: number, g: number, b: number): number {
  return 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/**
 * Draws the 224x224 window located at (ox, oy) in the source image into
 * `windowCanvas`, replicating edge pixels so windows that fall off the image
 * still produce a well-defined model input.
 */
function drawWindow(
  srcCanvas: HTMLCanvasElement,
  srcW: number,
  srcH: number,
  windowCanvas: HTMLCanvasElement,
  ox: number,
  oy: number,
): void {
  const ctx = windowCanvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas is not supported.");
  ctx.clearRect(0, 0, TILE, TILE);
  ctx.imageSmoothingQuality = "high";

  const x0 = Math.max(0, ox);
  const y0 = Math.max(0, oy);
  const x1 = Math.min(srcW, ox + TILE);
  const y1 = Math.min(srcH, oy + TILE);
  const sw = x1 - x0;
  const sh = y1 - y0;
  const dx = x0 - ox;
  const dy = y0 - oy;

  if (sw > 0 && sh > 0) {
    ctx.drawImage(srcCanvas, x0, y0, sw, sh, dx, dy, sw, sh);
  }

  // Fill any off-image margins by stretching the nearest edge pixels.
  if (dx > 0 && sh > 0) {
    ctx.drawImage(srcCanvas, x0, y0, 1, sh, 0, dy, dx, sh);
  }
  if (dy > 0 && sw > 0) {
    ctx.drawImage(srcCanvas, x0, y0, sw, 1, dx, 0, sw, dy);
  }
  if (dx > 0 && dy > 0 && sw > 0 && sh > 0) {
    ctx.drawImage(srcCanvas, x0, y0, 1, 1, 0, 0, dx, dy);
  }
  if (dx + sw < TILE && sh > 0) {
    ctx.drawImage(srcCanvas, x1 - 1, y0, 1, sh, dx + sw, dy, TILE - (dx + sw), sh);
  }
  if (dy + sh < TILE && sw > 0) {
    ctx.drawImage(srcCanvas, x0, y1 - 1, sw, 1, dx, dy + sh, sw, TILE - (dy + sh));
  }
  if (dx + sw < TILE && dy + sh < TILE && sw > 0 && sh > 0) {
    ctx.drawImage(
      srcCanvas,
      x1 - 1,
      y1 - 1,
      1,
      1,
      dx + sw,
      dy + sh,
      TILE - (dx + sw),
      TILE - (dy + sh),
    );
  }
}

export async function upscaleOnDevice(
  blob: Blob,
  factor: UpscaleFactor,
  onProgress: ProgressHandler,
  signal?: AbortSignal,
): Promise<UpscaleResult> {
  const session = await ensureModel("upscaler", onProgress, signal);
  abortIfRequested(signal);

  const bitmap = await decodeImage(blob);
  const srcW = bitmap.width;
  const srcH = bitmap.height;

  // Final size: requested factor, but never larger than MAX_EDGE on the long
  // side (and never smaller than the original).
  const longSide = Math.max(srcW, srcH);
  const scaleRaw = Math.max(1, Math.min(factor, MAX_EDGE / longSide));
  const outW = Math.max(1, Math.round(srcW * scaleRaw));
  const outH = Math.max(1, Math.round(srcH * scaleRaw));
  const scaleX = outW / srcW;
  const scaleY = outH / srcH;

  const srcCanvas = document.createElement("canvas");
  srcCanvas.width = srcW;
  srcCanvas.height = srcH;
  const srcCtx = srcCanvas.getContext("2d", { willReadFrequently: true });
  if (!srcCtx) throw new Error("Canvas is not supported.");
  srcCtx.drawImage(bitmap, 0, 0);
  bitmap.close();

  // Chroma + alpha: the source scaled straight to the final size (the same
  // geometry the luminance tiles are placed on), high quality smoothing.
  const chromaCanvas = document.createElement("canvas");
  chromaCanvas.width = outW;
  chromaCanvas.height = outH;
  const chromaCtx = chromaCanvas.getContext("2d", { willReadFrequently: true });
  if (!chromaCtx) throw new Error("Canvas is not supported.");
  chromaCtx.imageSmoothingQuality = "high";
  chromaCtx.drawImage(srcCanvas, 0, 0, outW, outH);
  const chroma = chromaCtx.getImageData(0, 0, outW, outH).data;

  // Luminance: assembled from per-tile model runs.
  const lumaCanvas = document.createElement("canvas");
  lumaCanvas.width = outW;
  lumaCanvas.height = outH;
  const lumaCtx = lumaCanvas.getContext("2d", { willReadFrequently: true });
  if (!lumaCtx) throw new Error("Canvas is not supported.");
  lumaCtx.imageSmoothingQuality = "high";

  const windowCanvas = document.createElement("canvas");
  windowCanvas.width = TILE;
  windowCanvas.height = TILE;

  const ort = await loadOrt();
  const tilesX = Math.ceil(srcW / STRIDE);
  const tilesY = Math.ceil(srcH / STRIDE);
  const totalTiles = tilesX * tilesY;

  const feedY = new Float32Array(TILE * TILE);
  const outTile = document.createElement("canvas");
  outTile.width = OUT_TILE;
  outTile.height = OUT_TILE;
  const outTileCtx = outTile.getContext("2d", { willReadFrequently: true });
  if (!outTileCtx) throw new Error("Canvas is not supported.");
  const outPixels = new Uint8ClampedArray(OUT_TILE * OUT_TILE * 4);

  let done = 0;
  for (let ty = 0; ty < tilesY; ty += 1) {
    for (let tx = 0; tx < tilesX; tx += 1) {
      abortIfRequested(signal);

      const ox = tx * STRIDE;
      const oy = ty * STRIDE;
      drawWindow(srcCanvas, srcW, srcH, windowCanvas, ox, oy);

      const windowPixels = windowCanvas
        .getContext("2d", { willReadFrequently: true })!
        .getImageData(0, 0, TILE, TILE).data;
      for (let i = 0; i < TILE * TILE; i += 1) {
        const o = i * 4;
        feedY[i] = rgbToY(windowPixels[o], windowPixels[o + 1], windowPixels[o + 2]) / 255;
      }

      const feeds: Record<string, Tensor> = {};
      feeds[session.inputNames[0] ?? "input"] = new ort.Tensor("float32", feedY, [
        1,
        1,
        TILE,
        TILE,
      ]);
      const outputs = await session.run(feeds);
      const values = outputs[session.outputNames[0] ?? "output"].data as Float32Array;

      for (let i = 0; i < OUT_TILE * OUT_TILE; i += 1) {
        const v = clamp255(values[i] * 255);
        const o = i * 4;
        outPixels[o] = v;
        outPixels[o + 1] = v;
        outPixels[o + 2] = v;
        outPixels[o + 3] = 255;
      }
      outTileCtx.putImageData(new ImageData(outPixels, OUT_TILE, OUT_TILE), 0, 0);

      lumaCtx.drawImage(outTile, ox * scaleX, oy * scaleY, TILE * scaleX, TILE * scaleY);

      done += 1;
      onProgress({ phase: "inference", loaded: done, total: totalTiles });
    }
  }

  const yData = lumaCanvas
    .getContext("2d", { willReadFrequently: true })!
    .getImageData(0, 0, outW, outH);

  // Reassemble: AI-sharpened Y + smoothed Cb/Cr/alpha.
  const dst = yData.data;
  const pxCount = outW * outH;
  for (let i = 0; i < pxCount; i += 1) {
    const o = i * 4;
    const cb = rgbToCb(chroma[o], chroma[o + 1], chroma[o + 2]);
    const cr = rgbToCr(chroma[o], chroma[o + 1], chroma[o + 2]);
    const y = dst[o];
    dst[o] = clamp255(y + 1.402 * (cr - 128));
    dst[o + 1] = clamp255(y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128));
    dst[o + 2] = clamp255(y + 1.772 * (cb - 128));
    dst[o + 3] = chroma[o + 3];
  }
  lumaCanvas.getContext("2d", { willReadFrequently: true })!.putImageData(yData, 0, 0);

  const blobOut = await new Promise<Blob>((resolve, reject) => {
    lumaCanvas.toBlob(
      (result) => {
        if (result) resolve(result);
        else reject(new Error("Couldn't build the upscaled image."));
      },
      "image/png",
    );
  });

  abortIfRequested(signal);

  return {
    blob: blobOut,
    scale: Math.min(scaleX, scaleY),
    outW,
    outH,
  };
}