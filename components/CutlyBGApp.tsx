"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Status = "idle" | "processing" | "done" | "error";

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

export default function CutlyBGApp() {
  const [status, setStatus] = useState<Status>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragDepth = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const busy = useRef(false);

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

  useEffect(() => {
    return () => {
      if (originalUrl) URL.revokeObjectURL(originalUrl);
      if (resultUrl) URL.revokeObjectURL(resultUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const process = useCallback(
    async (chosen: File) => {
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
      setOriginalUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(chosen);
      });
      setStatus("processing");

      const form = new FormData();
      form.append("file", chosen);

      try {
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

        const blob = await response.blob();
        if (!mounted.current) return;
        setResultUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return URL.createObjectURL(blob);
        });
        setStatus("done");
      } catch (err) {
        if (!mounted.current) return;
        setError(
          err instanceof Error
            ? err.message
            : "Something unexpected went wrong. Please try again.",
        );
        setStatus("error");
      } finally {
        busy.current = false;
      }
    },
    [],
  );

  const reset = useCallback(() => {
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
    setStatus("idle");
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
    const anchor = document.createElement("a");
    anchor.href = resultUrl;
    anchor.download = `${baseName(fileName)}-no-bg.png`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }, [resultUrl, fileName]);

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
                  <button type="button" className="btn btn--primary btn--full" onClick={download}>
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
                    Download PNG
                  </button>
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