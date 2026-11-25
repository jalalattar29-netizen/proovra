"use client";

/**
 * PROOVRA Phase 2A Closure — MediaViewer dispatcher.
 *
 * Single entry point used by the reviewer workspace. Inspects the
 * evidence kind/mime and dispatches to the right concrete viewer
 * (image / pdf / video / audio). Honest fallback for unknown kinds.
 */

import { ImageViewer } from "./ImageViewer";
import { PdfViewer } from "./PdfViewer";
import { VideoViewer } from "./VideoViewer";
import { AudioViewer, type AudioTranscriptSegment } from "./AudioViewer";
import type { ReviewerAnnotationSummary } from "../../../lib/reviewer-workspace/annotation-types";

export type MediaKind = "IMAGE" | "PDF" | "VIDEO" | "AUDIO" | "UNKNOWN";

export type MediaViewerProps = {
  evidenceId: string;
  /** Public-safe URL to fetch the bytes (may be a presigned URL). */
  src: string | null;
  mimeType: string | null;
  annotations: ReadonlyArray<ReviewerAnnotationSummary>;
  imageMetadata?: Record<string, unknown> | null;
  transcript?: ReadonlyArray<AudioTranscriptSegment>;
  /** T-076 — why `src` is null (says so instead of "not yet available"). */
  unavailable?: "not_previewable" | "policy" | "no_file" | "failed" | null;
};

/** T-076 — what the viewer says when it has nothing to show. */
export const PREVIEW_UNAVAILABLE_COPY: Readonly<Record<"not_previewable" | "policy" | "no_file" | "failed" | "loading", string>> = {
  not_previewable: "This file type is not previewable here. Open evidence to download it.",
  policy: "This workspace's download policy does not allow the original file to be shown.",
  no_file: "This record has no stored file to preview.",
  failed: "The preview could not be loaded. Open evidence to view the file.",
  loading: "Loading preview…",
};

export function inferMediaKind(mimeType: string | null): MediaKind {
  if (!mimeType) return "UNKNOWN";
  if (mimeType.startsWith("image/")) return "IMAGE";
  if (mimeType === "application/pdf") return "PDF";
  if (mimeType.startsWith("video/")) return "VIDEO";
  if (mimeType.startsWith("audio/")) return "AUDIO";
  return "UNKNOWN";
}

export function MediaViewer(props: MediaViewerProps) {
  const kind = inferMediaKind(props.mimeType);
  if (!props.src) {
    return (
      <div
        data-media-viewer-empty
        data-media-viewer-unavailable={props.unavailable ?? "loading"}
        style={{
          background: "#0f172a",
          color: "#cbd5e1",
          padding: 20,
          borderRadius: 10,
          textAlign: "center",
          fontSize: 13,
        }}
      >
        {PREVIEW_UNAVAILABLE_COPY[props.unavailable ?? "loading"]}
      </div>
    );
  }
  switch (kind) {
    case "IMAGE":
      return (
        <ImageViewer
          src={props.src}
          evidenceId={props.evidenceId}
          annotations={props.annotations}
          metadata={props.imageMetadata}
        />
      );
    case "PDF":
      return (
        <PdfViewer
          src={props.src}
          evidenceId={props.evidenceId}
          annotations={props.annotations}
        />
      );
    case "VIDEO":
      return (
        <VideoViewer
          src={props.src}
          evidenceId={props.evidenceId}
          annotations={props.annotations}
        />
      );
    case "AUDIO":
      return (
        <AudioViewer
          src={props.src}
          evidenceId={props.evidenceId}
          annotations={props.annotations}
          transcript={props.transcript}
        />
      );
    case "UNKNOWN":
      return (
        <div
          data-media-viewer-unknown
          data-media-viewer-mime={props.mimeType ?? "none"}
          style={{
            background: "#0f172a",
            color: "#cbd5e1",
            padding: 16,
            borderRadius: 10,
            fontSize: 13,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <strong>Unsupported preview type</strong>
          <small>MIME: {props.mimeType ?? "unknown"}</small>
          <a
            href={props.src}
            target="_blank"
            rel="noreferrer"
            style={{ color: "#93c5fd" }}
          >
            Open the file in a new tab ↗
          </a>
        </div>
      );
  }
}
