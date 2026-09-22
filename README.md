# CutlyBG

Remove backgrounds. Keep what matters.

Live at [cutlybg.vercel.app](https://cutlybg.vercel.app).

CutlyBG is a small, focused web app for removing image backgrounds. Upload an
image, watch the background disappear, and download a clean transparent PNG.

- Drag & drop or pick a PNG, JPG, or WEBP
- **On-device mode (default):** background removal runs in your browser with
  [ONNX Runtime Web](https://www.npmjs.com/package/onnxruntime-web) — photos
  never leave your device
- **Server mode:** removal via the [BGNinja API](https://bgninja.com/api.html)
  for a faster, server-side cutout
- **Enhance quality:** re-run the cutout with the higher-quality ISNet model
  (one-time ~84 MB download, cached) for hair edges and general objects
- **Upscale 2x / 4x:** sharpen and enlarge the result on-device with a tiny
  (240 KB) super-resolution model — works in both modes, transparent
  backgrounds stay transparent, capped at a 4096px long edge
- Results shown on a checkerboard transparency background
- Download as a transparent PNG, WEBP, or JPG (JPG flattens onto white)

## What powers it

- **Next.js (App Router)** with React and TypeScript
- **On-device pipeline** (`lib/background-removal.ts`): a thin wrapper that
  streams an ONNX model from Hugging Face, runs it through `onnxruntime-web`
  (WebGPU with a WASM fallback), applies the predicted mask, and composites a
  transparent PNG — all client-side. No provider credentials or images ever
  leave the browser.
- **Server fallback** (`app/api/remove-bg/route.ts`) proxies BGNinja so no
  provider credentials reach the browser. If the on-device pipeline fails, the
  UI automatically falls back to server mode with a notice.

### Models

| Model  | Source                                                                             | License    | Size  | Input |
| ------ | ---------------------------------------------------------------------------------- | ---------- | ----- | ----- |
| MODNet | [huggingface.co/Xenova/modnet](https://huggingface.co/Xenova/modnet)               | Apache-2.0 | 6 MB  | 512²  |
| ISNet  | [huggingface.co/imgly/isnet-general-onnx](https://huggingface.co/imgly/isnet-general-onnx) | MIT | 84 MB | 1024² |
| Super-Res | [ONNX Model Zoo — Sub-Pixel CNN](https://huggingface.co/onnxmodelzoo/super-resolution-10) | Apache-2.0 | 240 KB | 224² (→ 672²) |

### On-device upscaling

`lib/upscale.ts` runs the ONNX Model Zoo Sub-Pixel CNN model
(`public/models/super-resolution-10.onnx`, served same-origin) tile-by-tile to
sharpen the result's luminance without re-uploading anything. Chroma and alpha
are upscaled with high-quality smoothing on the same geometry, so transparent
cutouts stay transparent. The long edge of the result is capped at 4096 px to
bound browser memory on phones.

Model bytes are cached in the browser (Cache Storage), so repeat visits skip
the download. ONNX Runtime Web ships its `ort-wasm*.wasm` assets from
`public/ort/`, copied there by a `postinstall` script. The upscaler model
(`public/models/super-resolution-10.onnx`, Apache-2.0, from the
[ONNX Model Zoo](https://github.com/onnx/models/tree/main/validated/vision/super_resolution/sub_pixel_cnn_2016))
is committed to the repo so the same-origin fetch has no external dependency.

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Configuration

Copy `.env.example` to `.env.local` and set the values you need:

| Variable          | Description                                                        |
| ----------------- | ------------------------------------------------------------------ |
| `BGNINJA_API_KEY` | Optional. Sent as a Bearer token if BGNinja issues a key for you.  |
| `BGNINJA_API_URL` | Override the BGNinja endpoint. Defaults to `https://bgninja.com/api/remove`. |

## Scripts

```bash
npm run dev      # development server
npm run build    # production build
npm run start    # run the production build
npm run lint     # run ESLint
```

`npm install` also runs `postinstall`, which copies the ONNX Runtime WASM
binaries into `public/ort/`.