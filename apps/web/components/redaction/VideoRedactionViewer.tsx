"use client";

/**
 * PROOVRA — video record notice in the redaction editor.
 *
 * Product contract (PRO-R3-04 / WEB-OLD-API-COMPAT-1, closure 2026-11-21):
 * redaction REGIONS are authored and burned for IMAGE and PDF records only.
 * Video (and audio) redaction is FUTURE_NOT_SHIPPING: no frame preview is
 * served to this editor, no renderer burns a video region, and the API refuses
 * a redacted copy for video with UNSUPPORTED_REDACTION_MEDIA and a frame-range
 * region with REGION_KIND_UNSUPPORTED.
 *
 * So this panel offers NO drawing surface and no frame-range / method /
 * tracking controls: a region is never placed over a frame the operator cannot
 * see (no "blind drawing"), and nothing here suggests a masked video will be
 * produced. Do not reintroduce authoring here without a real frame preview, a
 * renderer, and a product decision that video regions are supported.
 */

export function VideoRedactionViewer() {
  return (
    <section
      data-redaction-video-viewer
      data-redaction-authoring="disabled"
      aria-labelledby="redaction-video-viewer-title"
      style={{
        background: "#fff",
        border: "1px solid rgba(15, 23, 42, 0.08)",
        borderRadius: 10,
        padding: 10,
      }}
    >
      <strong id="redaction-video-viewer-title" style={{ fontSize: 13 }}>
        Video regions are not supported
      </strong>
      <p
        role="note"
        data-redaction-authoring-blocked="unsupported"
        style={{ margin: "6px 0 0", fontSize: 12, color: "var(--status-warn-fg, #92400e)" }}
      >
        Redaction regions are drawn and blacked out on image and PDF records only. For a video
        record no region can be drawn and no redacted video copy is produced. The original video is
        never modified.
      </p>
      <small style={{ display: "block", marginTop: 6, color: "#475569", fontSize: 11 }}>
        Track and frame decisions in the review workspace below are a review record only; they do
        not produce a redacted copy.
      </small>
    </section>
  );
}
