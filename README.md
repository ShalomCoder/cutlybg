# CutlyBG

Remove backgrounds. Keep what matters.

Live at [cutlybg.vercel.app](https://cutlybg.vercel.app).

CutlyBG is a small, focused web app for removing image backgrounds. Upload an
image, and it returns a clean transparent PNG ready to download.

- Drag & drop or pick a PNG, JPG, or WEBP
- Background removal via the [BGNinja API](https://bgninja.com/api.html)
- Upscale the cutout 2× or 4× via [image-upscaling.net](https://image-upscaling.net)
- Results shown on a checkerboard transparency background
- Download as a transparent PNG

## What powers it

- **Next.js (App Router)** with React and TypeScript
- Background removal runs through a **server-side API route**
  (`app/api/remove-bg/route.ts`) so no provider credentials ever reach the
  browser
- Upscaling runs through another server-side proxy
  (`app/api/upscale/route.ts`) — upload, poll until done, then download the
  PNG. A random `client_id` is generated per request, so no API key is needed.

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
| `UPSCALER_API_URL`| Override the upscaling endpoint. Defaults to `https://image-upscaling.net`. |

## Scripts

```bash
npm run dev      # development server
npm run build    # production build
npm run start    # run the production build
npm run lint     # run ESLint
```