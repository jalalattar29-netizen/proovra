// D:\digital-witness\apps\web\components\EvidenceViewer.tsx
"use client";

import React from "react";

type EvidenceViewerProps = {
  url: string | null;
  mimeType: string | null;
  fileName?: string | null;
  sizeBytes?: string | null;
};

function formatBytes(sizeBytes?: string | null): string {
  const n = sizeBytes ? Number(sizeBytes) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return "Unknown size";

  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = n;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

function getKind(mimeType: string | null): "image" | "video" | "audio" | "pdf" | "text" | "other" {
  const mime = (mimeType ?? "").toLowerCase();

  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  if (
    mime.startsWith("text/") ||
    mime.includes("json") ||
    mime.includes("xml")
  ) {
    return "text";
  }

  return "other";
}

export default function EvidenceViewer({
  url,
  mimeType,
  fileName,
  sizeBytes,
}: EvidenceViewerProps) {
  const kind = getKind(mimeType);

  if (!url) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/5 p-5 text-sm text-slate-300">
        Original evidence is not available right now.
      </div>
    );
  }

  const meta = (
    <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-slate-300">
      <span>Type: {mimeType ?? "unknown"}</span>
      <span>Size: {formatBytes(sizeBytes)}</span>
      {fileName ? <span>Name: {fileName}</span> : null}
    </div>
  );

  const actions = (
    <div className="mb-5 flex flex-wrap gap-3">
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center justify-center rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-4 py-2 text-sm font-semibold text-cyan-200 transition hover:bg-cyan-400/20"
      >
        Open Original
      </a>

      <a
        href={url}
        download={fileName ?? true}
        className="inline-flex items-center justify-center rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/10"
      >
        Download Original
      </a>
    </div>
  );

  return (
    <div className="rounded-2xl border border-white/10 bg-slate-950/30 p-5">
      <h3 className="mb-3 text-xl font-semibold text-white">Original Evidence</h3>
      {meta}
      {actions}

      {kind === "image" && (
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/30 p-3">
          <img
            src={url}
            alt="Original evidence"
            className="mx-auto max-h-[520px] w-auto max-w-full rounded-xl object-contain"
          />
        </div>
      )}

      {kind === "video" && (
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/40 p-3">
          <video
            src={url}
            controls
            preload="metadata"
            className="mx-auto max-h-[520px] w-full rounded-xl bg-black"
          />
        </div>
      )}

      {kind === "audio" && (
        <div className="rounded-2xl border border-white/10 bg-black/30 p-5">
          <audio
            src={url}
            controls
            preload="metadata"
            className="w-full"
          />
        </div>
      )}

      {kind === "pdf" && (
        <div className="overflow-hidden rounded-2xl border border-white/10 bg-white">
          <iframe
            src={url}
            title="Original PDF evidence"
            className="h-[720px] w-full"
          />
        </div>
      )}

      {kind === "text" && (
        <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-5 text-sm text-slate-300">
          <p className="mb-3">
            This file type is best opened in a separate tab or downloaded.
          </p>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="text-cyan-300 underline underline-offset-4"
          >
            Open file
          </a>
        </div>
      )}

      {kind === "other" && (
        <div className="rounded-2xl border border-dashed border-white/15 bg-slate-900/40 p-5 text-sm text-slate-300">
          <p className="mb-3">
            Preview is not available for this file type inside the page.
          </p>
          <p className="mb-4">
            Use the buttons above to open or download the original evidence.
          </p>
        </div>
      )}
    </div>
  );
}