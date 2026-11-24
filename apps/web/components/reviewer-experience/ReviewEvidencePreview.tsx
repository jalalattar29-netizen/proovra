"use client";

/**
 * T-076 (stage D, High) — THE inline evidence preview of the Review page and
 * of its focus mode. One component, one read: `fetchEvidencePreview`, which
 * reads the primary part's `previewUrl` from `GET /v1/evidence/:id/parts`
 * (custody-logged as today; no new endpoint). Image, PDF, video and audio
 * render through the reviewer `MediaViewer`; a type without a preview, a
 * download-policy refusal and a failed read each say so in words.
 */

import Link from "next/link";
import { useEffect, useState } from "react";

import {
  fetchEvidencePreview,
  type EvidencePreviewMeta,
} from "../../lib/reviewer-workspace/reviewer-api";
import type { ReviewerAnnotationSummary } from "../../lib/reviewer-workspace/annotation-types";
import { MediaViewer } from "../reviewer-workspace/viewers/MediaViewer";

const NO_ANNOTATIONS: ReadonlyArray<ReviewerAnnotationSummary> = [];

export function useEvidencePreview(evidenceId: string | null): EvidencePreviewMeta | null {
  const [preview, setPreview] = useState<EvidencePreviewMeta | null>(null);
  useEffect(() => {
    setPreview(null);
    if (!evidenceId) return;
    let cancelled = false;
    void fetchEvidencePreview(evidenceId).then((p) => {
      if (!cancelled) setPreview(p);
    });
    return () => {
      cancelled = true;
    };
  }, [evidenceId]);
  return preview;
}

export function ReviewEvidencePreview({
  evidenceId,
  annotations = NO_ANNOTATIONS,
  headingLevel = 2,
  preview: suppliedPreview,
}: {
  evidenceId: string;
  annotations?: ReadonlyArray<ReviewerAnnotationSummary>;
  headingLevel?: 2 | 3;
  /** A host that already read the preview passes it (no second read). */
  preview?: EvidencePreviewMeta | null;
}) {
  const ownPreview = useEvidencePreview(suppliedPreview === undefined ? evidenceId : null);
  const preview = suppliedPreview === undefined ? ownPreview : suppliedPreview;
  const Heading = headingLevel === 3 ? "h3" : "h2";
  return (
    <section
      className="app-panel review-evidence-preview"
      aria-labelledby="review-evidence-preview-title"
      data-review-evidence-preview
      data-review-evidence-preview-state={preview ? (preview.previewUrl ? "ready" : preview.unavailable ?? "none") : "loading"}
    >
      <div className="app-panel__head">
        <Heading id="review-evidence-preview-title" className="app-panel__title">
          Evidence
        </Heading>
        <Link href={`/evidence/${encodeURIComponent(evidenceId)}`} className="app-ghost-action" data-review-preview-open-evidence>
          Open evidence
        </Link>
      </div>
      <div className="app-panel__body" style={{ minWidth: 0 }}>
        <MediaViewer
          evidenceId={evidenceId}
          src={preview?.previewUrl ?? null}
          mimeType={preview?.mimeType ?? null}
          annotations={annotations}
          unavailable={preview ? preview.unavailable ?? null : null}
        />
        {preview?.displayName ? (
          <p className="app-field-help" style={{ margin: "6px 0 0", overflowWrap: "anywhere" }} data-review-preview-file>
            {preview.displayName}
          </p>
        ) : null}
      </div>
    </section>
  );
}
