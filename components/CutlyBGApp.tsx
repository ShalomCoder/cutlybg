"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ensureModel,
  removeBackgroundOnDevice,
  type ProgressState,
} from "@/lib/background-removal";
import { MODELS, type ModelKind } from "@/lib/models";

type Status = "idle" | "processing" | "done" | "error";
type Mode = "device" | "server";

const ACCEPTED_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
const ACCEPTED_EXT = /\.(png|jpe?g|webp)$/i;
const MAX_FILE_BYTES = 99 * 1024 * 1024; // matches BGNinja's limit

function validateFile(file: File): string | null {
  if (!ACCEPTED_MIME.has(file.type) && !ACCEPTED_EXT.test(file.name)) {
    return "Unsupported file type. Please upload a PNG, JPG, or WEBP image.";
  }
  if (file.size <= 0) {
    return "That file appears to be empty. Please choose another image.";
  }
  if (file.size > MAX_FILE_BYTES) {
    return "That image is too large (max 99 MB). Please choose a smaller one.";
  }
  return null;
}

function baseName(name: string) {
  return name.replace(/\.[^.]+$/, "").slice(0, 60) || "image";
}

function isAbort(err: unknown) {
  return err instanceof DOMException && err.name === "AbortError";
}

function errorMessage(err: unknown): string {
  return err instanceof Error
    ? err.message
    : "Something unexpected went wrong. Please try again.";
}

type DownloadFormat = "png" | "webp" | "jpg";

function isDownloadFormat(value: string): value is DownloadFormat {
  return value === "png" || value === "webp" || value === "jpg";
}

const FORMAT_EXT: Record<DownloadFormat, string> = {
  png: "png",
  webp: "webp",
  jpg: "jpg",
};

const FORMAT_MIME: Record<DownloadFormat, string> = {
  png: "image/png",
  webp: "image/webp",
  jpg: "image/jpeg",
};

const MODE_HINT: Record<Mode, string> = {
  device:
    "Private — photos are processed locally in your browser and never uploaded.",
  server: "Processed on our server — faster, but your photo is uploaded.",
};

export default function CutlyBGApp() {
  const [status, setStatus] = useState<Status>("idle");
  const [mode, setMode] = useState<Mode>("device");
  const [file, setFile] = useState<File | null>(null);
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [downloadFormat, setDownloadFormat] = useState<DownloadFormat>("png");
  const [devicePath, setDevicePath] = useState(false);
  const [modelProgress, setModelProgress] = useState<ProgressState | null>(null);
  const [enhanced, setEnhanced] = useState(false);
  const [modeNotice, setModeNotice] = useState<string | null>(null);
  const dragDepth = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const busy = useRef(false);
  const modelAbort = useRef<AbortController | null>(null);
  const warmed = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const prevent = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  // Warm up the fast model after the first interaction so the first
  // on-device cutout usually doesn't wait on a download. Never blocks input.
  useEffect(() => {
    if (mode !== "device" || warmed.current) return;
    const warm = () => {
      if (warmed.current) return;
      warmed.current = true;
      ensureModel("modnet").catch(() => {});
    };
    const handle = () => warm();
    window.addEventListener("pointerdown", handle, { once: true });
    window.addEventListener("keydown", handle, { once: true });
    return () => {
      window.removeEventListener("pointerdown", handle);
      window.removeEventListener("keydown", handle);
    };
  }, [mode]);

  useEffect(() => {
    return () => {
      if (originalUrl) URL.revokeObjectURL(originalUrl);
      if (resultUrl) URL.revokeObjectURL(resultUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runServer = useCallback(async (chosen: File): Promise<Blob> => {
    const form = new FormData();
    form.append("file", chosen);

    const [response] = await Promise.all([
      fetch("/api/remove-bg", { method: "POST", body: form }),
      new Promise((resolve) => setTimeout(resolve, 700)),
    ]);

    if (!response.ok) {
      let message = "Background removal failed. Please try again.";
      try {
        const payload = (await response.json()) as { error?: string };
        if (payload.error) message = payload.error;
      } catch {
        // fall back to the default message
      }
      throw new Error(message);
    }

    return response.blob();
  }, []);

  const runDevice = useCallback(
    async (chosen: File, kind: ModelKind): Promise<Blob> => {
      modelAbort.current?.abort();
      const controller = new AbortController();
      modelAbort.current = controller;
      setDevicePath(true);
      setModelProgress({ phase: "download", loaded: 0, total: MODELS[kind].sizeBytes });

      let lastTick = 0;
      const onProgress = (next: ProgressState) => {
        const now = Date.now();
        if (now - lastTick < 90) return;
        lastTick = now;
        setModelProgress(next);
      };

      try {
        return await removeBackgroundOnDevice(chosen, kind, onProgress, controller.signal);
      } finally {
        if (modelAbort.current === controller) modelAbort.current = null;
        setDevicePath(false);
        setModelProgress(null);
      }
    },
    [],
  );

  const reset = useCallback(() => {
    modelAbort.current?.abort();
    setOriginalUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setResultUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setFile(null);
    setFileName("");
    setError(null);
    setDownloadFormat("png");
    setEnhanced(false);
    setModeNotice(null);
    setModelProgress(null);
    setStatus("idle");
  }, []);

  const process = useCallback(
    async (chosen: File, opts?: { kind?: ModelKind }) => {
      if (busy.current) return;
      const problem = validateFile(chosen);
      if (problem) {
        setFileName(chosen.name);
        setError(problem);
        setResultUrl(null);
        setStatus("error");
        return;
      }

      busy.current = true;
      setFile(chosen);
      setFileName(chosen.name);
      setError(null);
      setResultUrl(null);
      setEnhanced(false);
      setModeNotice(null);
      setModelProgress(null);
      setOriginalUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(chosen);
      });
      setStatus("processing");

      const useDevice = mode === "device";

      try {
        let blob: Blob;

        if (useDevice) {
          try {
            blob = await runDevice(chosen, opts?.kind ?? "modnet");
          } catch (err) {
            if (isAbort(err)) {
              reset();
              return;
            }
            // The on-device pipeline failed: fall back to the server path
            // rather than dead-ending the user.
            setMode("server");
            setModeNotice(
              "On-device processing isn't available right now, so this image was processed on the server instead.",
            );
            blob = await runServer(chosen);
          }
        } else {
          blob = await runServer(chosen);
        }

        if (!mounted.current) return;
        setResultUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return URL.createObjectURL(blob);
        });
        setStatus("done");
      } catch (err) {
        if (!mounted.current) return;
        setError(errorMessage(err));
        setStatus("error");
      } finally {
        busy.current = false;
        setModelProgress(null);
      }
    },
    [mode, reset, runDevice, runServer],
  );

  const enhance = useCallback(async () => {
    if (!file || enhanced || busy.current) return;
    busy.current = true;
    setError(null);
    setModeNotice(null);
    setStatus("processing");

    try {
      const blob = await runDevice(file, "isnet");
      if (!mounted.current) return;
      setResultUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(blob);
      });
      setEnhanced(true);
      setStatus("done");
    } catch (err) {
      if (isAbort(err)) {
        setStatus("done");
        return;
      }
      setModeNotice("Couldn't refresh with the HD model — showing the previous result.");
      setStatus("done");
    } finally {
      busy.current = false;
      setModelProgress(null);
    }
  }, [file, enhanced, runDevice]);

  const cancelProcessing = useCallback(() => {
    modelAbort.current?.abort();
  }, []);

  const openPicker = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openPicker();
      }
    },
    [openPicker],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setIsDragging(false);
      const dropped = e.dataTransfer.files?.[0];
      if (dropped) process(dropped);
    },
    [process],
  );

  const download = useCallback(() => {
    if (!resultUrl) return;

    const base = `${baseName(fileName)}-no-bg`;
    const save = (href: string, ext: string) => {
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = `${base}.${ext}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    };

    // PNG is the result as-is; WEBP/JPG are converted on a canvas so the
    // download never needs a server round trip.
    if (downloadFormat === "png") {
      save(resultUrl, "png");
      return;
    }

    const image = new Image();
    image.onerror = () => save(resultUrl, "png");
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx || typeof canvas.toBlob !== "function") {
        save(resultUrl, "png");
        return;
      }
      if (downloadFormat === "jpg") {
        // JPEG has no alpha channel: flatten transparency onto white.
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(image, 0, 0);
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            save(resultUrl, "png");
            return;
          }
          const url = URL.createObjectURL(blob);
          try {
            save(url, FORMAT_EXT[downloadFormat]);
          } finally {
            URL.revokeObjectURL(url);
          }
        },
        FORMAT_MIME[downloadFormat],
        0.92,
      );
    };
    image.src = resultUrl;
  }, [resultUrl, fileName, downloadFormat]);

  const progressPercent = modelProgress?.total
    ? Math.min(100, Math.round(((modelProgress.loaded ?? 0) / modelProgress.total) * 100))
    : 0;

  const statusLabel =
    status === "processing"
      ? "Removing background…"
      : status === "done"
        ? "Background removed"
        : status === "error"
          ? "Something went wrong"
          : null;

  return (
    <main className="shell__main">
      <header className="hero">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="6" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <line x1="20" y1="4" x2="8.12" y2="15.88" />
              <line x1="14.47" y1="14.48" x2="20" y2="20" />
              <line x1="8.12" y1="8.12" x2="12" y2="12" />
            </svg>
          </span>
          <span className="brand__name">CutlyBG</span>
        </div>
        <h1 className="hero__title">Remove backgrounds. Keep what matters.</h1>
        <p className="hero__tagline">
          Drop an image, watch the background disappear, download a clean PNG.
        </p>
      </header>

      <section
        className={`card${status === "idle" ? " card--narrow" : ""}`}
        aria-label="Background remover"
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            const chosen = e.target.files?.[0];
            e.target.value = "";
            if (chosen) process(chosen);
          }}
        />

        {status === "idle" && (
          <>
            <div
              className={`dropzone${isDragging ? " is-dragging" : ""}`}
              role="button"
              tabIndex={0}
              aria-label="Upload an image. Drag and drop a PNG, JPG, or WEBP, or press Enter to browse."
              onClick={(e) => {
                if ((e.target as HTMLElement).closest("button")) return;
                openPicker();
              }}
              onKeyDown={onKeyDown}
              onDragEnter={(e) => {
                e.preventDefault();
                dragDepth.current += 1;
                setIsDragging(true);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                dragDepth.current -= 1;
                if (dragDepth.current <= 0) {
                  dragDepth.current = 0;
                  setIsDragging(false);
                }
              }}
              onDrop={onDrop}
            >
              <span className="dropzone__icon" aria-hidden="true">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <path d="m21 15-5-5L5 21" />
                </svg>
              </span>
              <p className="dropzone__title">Drop an image here</p>
              <button type="button" className="btn btn--primary" onClick={openPicker}>
                Upload an image
              </button>
              <p className="dropzone__note">PNG, JPG or WEBP · up to 99 MB</p>
            </div>

            <div className="mode-toggle">
              <div
                className="segmented"
                role="radiogroup"
                aria-label="Processing mode"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={mode === "device"}
                  className="segmented__option"
                  onClick={() => setMode("device")}
                >
                  On device
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={mode === "server"}
                  className="segmented__option"
                  onClick={() => setMode("server")}
                >
                  Server
                </button>
              </div>
              <p className="mode-toggle__hint">{MODE_HINT[mode]}</p>
              {modeNotice && <p className="mode-notice">{modeNotice}</p>}
            </div>
          </>
        )}

        {(status === "processing" || status === "done" || status === "error") && (
          <div className="panels">
            <div className="panel">
              <div className="panel__label">Original</div>
              <div className="panel__body" aria-label="Original image preview">
                {originalUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={originalUrl} alt={`Original image: ${fileName}`} />
                )}
              </div>
              <span className="panel__meta">{fileName}</span>
            </div>

            <div className="panel">
              <div className="panel__label">Result</div>

              {status === "processing" && (
                <div className="panel__body">
                  {modelProgress && modelProgress.phase === "download" ? (
                    <div className="model-progress" role="status" aria-live="polite">
                      <p className="model-progress__label">
                        Loading AI model
                        <span className="loader__dots" aria-hidden="true">
                          <span />
                          <span />
                          <span />
                        </span>
                      </p>
                      <div className="model-progress__track">
                        <div
                          className={`model-progress__fill${
                            modelProgress.total ? "" : " model-progress__fill--indeterminate"
                          }`}
                          style={
                            modelProgress.total ? { width: `${progressPercent}%` } : undefined
                          }
                        />
                      </div>
                      <p className="model-progress__sub">
                        {formatMegabytes(modelProgress.loaded ?? 0)} of{" "}
                        {formatMegabytes(modelProgress.total ?? 0)} MB
                      </p>
                      <button
                        type="button"
                        className="btn btn--ghost model-progress__cancel"
                        onClick={cancelProcessing}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : devicePath ? (
                    <div className="loader" role="status" aria-live="polite">
                      <div className="loader__ring" aria-hidden="true" />
                      <p className="loader__title">
                        Removing background
                        <span className="loader__dots" aria-hidden="true">
                          <span />
                          <span />
                          <span />
                        </span>
                      </p>
                      <p className="loader__sub">
                        Running on your device — nothing is uploaded.
                      </p>
                    </div>
                  ) : (
                    <div className="loader" role="status" aria-live="polite">
                      <div className="loader__ring" aria-hidden="true" />
                      <p className="loader__title">
                        Removing background
                        <span className="loader__dots" aria-hidden="true">
                          <span />
                          <span />
                          <span />
                        </span>
                      </p>
                      <p className="loader__sub">This usually takes a few seconds.</p>
                    </div>
                  )}
                </div>
              )}

              {status === "done" && resultUrl && (
                <div className="panel__body panel__body--checker">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    className="result-art"
                    src={resultUrl}
                    alt={`${fileName} with the background removed`}
                  />
                </div>
              )}

              {status === "error" && (
                <div className="panel__body">
                  <div className="error-box" role="alert">
                    <span className="error-box__icon" aria-hidden="true">
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="8" x2="12" y2="12" />
                        <line x1="12" y1="16" x2="12.01" y2="16" />
                      </svg>
                    </span>
                    <p className="error-box__title">Couldn&rsquo;t remove the background</p>
                    <p className="error-box__msg">{error}</p>
                    <div className="actions">
                      <div className="actions__row">
                        {file && (
                          <button
                            type="button"
                            className="btn btn--primary"
                            onClick={() => process(file)}
                          >
                            Try again
                          </button>
                        )}
                        <button type="button" className="btn btn--ghost" onClick={reset}>
                          Choose another image
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {status === "done" && (
                <div className="actions">
                  <span className="done-chip">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                    Background removed
                  </span>
                  <div className="download-bar">
                    <label className="sr-only" htmlFor="download-format">
                      Download format
                    </label>
                    <select
                      id="download-format"
                      className="download-bar__select"
                      value={downloadFormat}
                      onChange={(e) => {
                        const value = e.target.value;
                        if (isDownloadFormat(value)) setDownloadFormat(value);
                      }}
                    >
                      <option value="png">PNG</option>
                      <option value="webp">WEBP</option>
                      <option value="jpg">JPG</option>
                    </select>
                    <button type="button" className="btn btn--primary" onClick={download}>
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                      Download
                    </button>
                  </div>
                  <p className="download-bar__hint">
                    PNG and WEBP keep transparency; JPG fills it with white.
                  </p>

                  {mode === "device" && !enhanced && (
                    <>
                      <button
                        type="button"
                        className="btn btn--ghost btn--full"
                        onClick={enhance}
                      >
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M12 3v3m0 12v3M5.64 5.64l2.12 2.12m8.48 8.48 2.12 2.12M3 12h3m12 0h3M5.64 18.36l2.12-2.12m8.48-8.48 2.12-2.12" />
                        </svg>
                        Enhance quality
                      </button>
                      <p className="enhance-bar__note">{MODELS.isnet.downloadLabel}</p>
                    </>
                  )}

                  {modeNotice && <p className="mode-notice">{modeNotice}</p>}

                  <button type="button" className="btn btn--ghost btn--full" onClick={reset}>
                    Remove another background
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      <div className="status" aria-live="polite" aria-atomic="true">
        {statusLabel}
      </div>

      <footer className="footer">
        <p className="footer__text">
          Built by <strong>Radicon Studios</strong>
        </p>
      </footer>
    </main>
  );
}

function formatMegabytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0.0";
  return (bytes / (1024 * 1024)).toFixed(1);
}