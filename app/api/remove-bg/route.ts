import type { NextRequest } from "next/server";

const BGNINJA_ENDPOINT =
  process.env.BGNINJA_API_URL ?? "https://bgninja.com/api/remove";

const ACCEPTED_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_FILE_BYTES = 99 * 1024 * 1024; // BGNinja limit
const UPSTREAM_TIMEOUT_MS = 90_000;

function json(message: string, status: number) {
  return Response.json({ error: message }, { status });
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

  // Forward to BGNinja. Never stream the upstream through the browser: the
  // request is made server-side so no credentials ever reach client code.
  const upstream = new FormData();
  upstream.append("file", file, file.name);
  upstream.append("src", "cutlybg");

  const headers = new Headers();
  const apiKey = process.env.BGNINJA_API_KEY;
  if (apiKey) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }

  let response: Response;
  try {
    response = await fetch(BGNINJA_ENDPOINT, {
      method: "POST",
      headers,
      body: upstream,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      return json(
        "The request took too long. The image may be very large — please try again.",
        504,
      );
    }
    return json(
      "Background removal is unavailable right now. Please try again in a moment.",
      502,
    );
  }

  if (!response.ok) {
    let upstreamMessage: string | null = null;
    try {
      const payload = (await response.json()) as { error?: string };
      upstreamMessage = payload.error ?? null;
    } catch {
      // Non-JSON upstream error body; fall through to mapped messages below.
    }

    if (response.status === 413 || upstreamMessage?.includes("too large")) {
      return json(
        "That image is too large or too high in resolution for background removal.",
        413,
      );
    }
    if (response.status === 429) {
      return json(
        "We're busy removing backgrounds right now. Please wait a moment and try again.",
        429,
      );
    }
    if (upstreamMessage) {
      return json(
        `Background removal failed: ${upstreamMessage}`,
        response.status,
      );
    }
    return json(
      "Background removal failed. Please try again.",
      response.status >= 500 ? 502 : response.status,
    );
  }

  const bytes = await response.arrayBuffer();
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
    },
  });
}