import type { NextRequest } from "next/server";

const UPSCALER_ENDPOINT =
  process.env.UPSCALER_API_URL ?? "https://image-upscaling.net";

const ACCEPTED_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_FILE_BYTES = 99 * 1024 * 1024;
const CLIENT_ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
const POLL_INTERVAL_MS = 1250;
// Fits inside Vercel Hobby's 60s function cap with room for upload/download.
const TOTAL_BUDGET_MS = 50_000;

export const maxDuration = 60;

function json(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

function randomClientId() {
  let id = "";
  for (let i = 0; i < 32; i += 1) {
    id += CLIENT_ID_CHARS[Math.floor(Math.random() * CLIENT_ID_CHARS.length)];
  }
  return id;
}

// Route every upstream URL through UPSCALER_API_URL. Absolute URLs returned by
// the status endpoint are rewritten to the configured base so a mirror or a
// local dev proxy continues to work end to end.
function resolveUrl(pathOrUrl: string) {
  const base = new URL(UPSCALER_ENDPOINT);
  if (/^https?:/i.test(pathOrUrl)) {
    const url = new URL(pathOrUrl);
    url.protocol = base.protocol;
    url.host = base.host;
    return url;
  }
  return new URL(pathOrUrl, UPSCALER_ENDPOINT);
}

export async function POST(request: NextRequest) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return json("We couldn't read the upload. Please try again.", 400);
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return json("No file was received. Please choose an image first.", 422);
  }

  const rawScale = String(formData.get("scale") ?? "4");
  const scale = rawScale === "2" ? 2 : rawScale === "4" ? 4 : null;
  if (!scale) {
    return json("The upscale factor must be 2x or 4x.", 422);
  }

  const type = file.type.toLowerCase();
  if (!ACCEPTED_MIME.has(type)) {
    return json(
      "Unsupported file type. Please upload a PNG, JPG, or WEBP image.",
      415,
    );
  }

  if (file.size <= 0) {
    return json("That file appears to be empty. Please choose another image.", 400);
  }

  if (file.size > MAX_FILE_BYTES) {
    return json("That image is too large (max 99 MB). Please choose a smaller one.", 413);
  }

  const clientId = randomClientId();
  const cookieHeaders = { Cookie: `client_id=${clientId}` };
  const deadline = Date.now() + TOTAL_BUDGET_MS;

  // Upload. The response body is the "original filename" used to match the
  // result in the status list. No API key: a random client_id is our identity.
  const upstream = new FormData();
  upstream.append("image", file, file.name);
  upstream.append("scale", String(scale));
  upstream.append("model", "general");

  let upload: Response;
  try {
    upload = await fetch(`${UPSCALER_ENDPOINT}/upscaling_upload`, {
      method: "POST",
      headers: cookieHeaders,
      body: upstream,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      return json(
        "The upload took too long. The image may be too large — please try again.",
        504,
      );
    }
    return json(
      "Upscaling is unavailable right now. Please try again in a moment.",
      502,
    );
  }

  if (!upload.ok) {
    const upstreamMessage = (await upload.text()).trim();
    if (upload.status === 429) {
      return json(
        "We're busy upscaling images right now. Please wait a moment and try again.",
        429,
      );
    }
    if (
      upload.status === 413 ||
      /too large|too high|limit/i.test(upstreamMessage)
    ) {
      return json(
        "That image is too large for upscaling. Please try a smaller one.",
        413,
      );
    }
    if (/quota/i.test(upstreamMessage)) {
      return json(
        "The free upscaling quota for today has been used up. Please try again tomorrow.",
        429,
      );
    }
    return json(
      `Upscaling failed: ${upstreamMessage || "unknown error"}`,
      upload.status >= 500 ? 502 : upload.status,
    );
  }

  const originalFilename = (await upload.text()).trim();
  if (!originalFilename) {
    return json("The upscaler didn't accept that image. Please try again.", 502);
  }

  // Poll until our file is done. We matched the upload's filename, so a random
  // client_id per request cannot collide with other users' results. The status
  // list only exposes original_filename once processing completes, so match on
  // either field.
  const statusUrl = new URL(`${UPSCALER_ENDPOINT}/upscaling_get_status_v2`);
  statusUrl.searchParams.set("client_id", clientId);

  let imageUrl: string | null = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    let status: Response;
    try {
      status = await fetch(statusUrl.toString(), {
        headers: cookieHeaders,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      continue;
    }

    if (!status.ok) continue;

    let entries: Array<{
      completed?: boolean;
      image_url?: string;
      filename?: string;
      original_filename?: string;
      status?: string;
    }> = [];
    try {
      entries = (await status.json()) as typeof entries;
    } catch {
      continue;
    }

    const entry = entries.find(
      (e) =>
        e.original_filename === originalFilename || e.filename === originalFilename,
    );
    if (!entry) continue;

    if (entry.status === "error") {
      return json(
        "That image could not be upscaled (it may be too large or corrupted). Please try a smaller image.",
        422,
      );
    }
    if (entry.completed && entry.image_url) {
      imageUrl = entry.image_url;
      break;
    }
  }

  if (!imageUrl) {
    return json(
      "Upscaling is taking too long. Please try a smaller image.",
      504,
    );
  }

  // Download the finished image and delete it from the provider.
  const downloadUrl = resolveUrl(imageUrl);
  downloadUrl.searchParams.set("delete_after_download", "");
  downloadUrl.searchParams.set("client_id", clientId);

  let download: Response;
  try {
    download = await fetch(downloadUrl.toString(), {
      headers: cookieHeaders,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return json(
      "The upscaled image could not be downloaded. Please try again.",
      502,
    );
  }

  if (!download.ok) {
    return json(
      "The upscaled image could not be downloaded. Please try again.",
      download.status >= 500 ? 502 : download.status,
    );
  }

  const bytes = await download.arrayBuffer();
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
    },
  });
}