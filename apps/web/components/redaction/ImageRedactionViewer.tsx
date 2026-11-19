"use client";

/**
 * PROOVRA Phase 3A — Image redaction viewer.
 *
 * Bounded canvas-style region authoring for IMAGE redaction
 * projects. Reviewer drags to select a normalized bbox (x, y, w, h
 * ∈ [0,1]) over the original evidence preview and submits it to
 * the API as a `BBOX_NORMALIZED` region with a bounded method.
 *
 * Hard rules:
 *   * Drawing happens on an overlay div above the original image —
 *     the original bytes are NEVER mutated client-side.
 *   * Geometry is sent normalized so the worker's renderer can map
 *     it to the actual image dimensions without losing precision.
 *   * `versionLocked` disables drawing once the version is out of
 *     DRAFT.
 */

import { regionAddFailureMessage } from "../../lib/redaction/refusal";
import { AppListbox } from "../app-primitives/AppListbox";
import { useCallback, useMemo, useRef, useState } from "react";

import { apiFetch } from "../../lib/api";
import {
  RegionCoordinateForm,
  isDeliberateDrag,
  useEvidenceImagePreview,
  type NormalizedRect,
} from "./region-authoring";

type Region = {
  id: string;
  kind: string;
  method: string;
  geometry: { x: number; y: number; width: number; height: number };
};

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function ImageRedactionViewer({
  evidenceId,
  versionId,
  versionLocked,
  regions: projectedRegions,
  onChanged,
}: {
  evidenceId: string;
  versionId: string;
  versionLocked: boolean;
  /**
   * PHASE 12B — regions come from the SERVER projection that the parent
   * page already reads (`GET /v1/redaction/projects/:id` →
   * versions[].regions). The viewer previously re-fetched
   * `/v1/redaction/projects/${evidenceId}` — an evidenceId passed where a
   * projectId belongs — and then discarded the result, so drawn regions
   * were never rendered back. One read, one owner.
   */
  regions?: ReadonlyArray<{
    id: string;
    kind: string;
    method: string;
    geometry: Record<string, unknown>;
  }>;
  onChanged: () => void;
}) {
  const [method, setMethod] = useState<"BLUR" | "PIXELATE" | "BLACKOUT">(
    "BLACKOUT",
  );
  const [drag, setDrag] = useState<null | {
    startX: number;
    startY: number;
    x: number;
    y: number;
    w: number;
    h: number;
  }>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // PRO-R3-04 — the record's own image, through the Evidence detail read
  // (reach, the original-download decision and custody stay canonical). The
  // frame takes the image's real proportions once it has loaded.
  const preview = useEvidenceImagePreview(evidenceId);
  const [aspect, setAspect] = useState<string | null>(null);
  const [previewBroken, setPreviewBroken] = useState(false);
  const showImage = preview.state === "ready" && !previewBroken;
  // Only normalized bounding boxes can be drawn as an overlay rectangle;
  // other region kinds (text spans, audio ranges) are listed in the
  // region panel instead of being painted on the image.
  const regions = useMemo<Region[]>(() => {
    void evidenceId;
    return (projectedRegions ?? [])
      .filter((r) => r.kind === "BBOX_NORMALIZED")
      .map((r) => {
        const g = r.geometry as Record<string, unknown>;
        return {
          id: r.id,
          kind: r.kind,
          method: r.method,
          geometry: {
            x: numberOr(g["x"], 0),
            y: numberOr(g["y"], 0),
            width: numberOr(g["width"], 0),
            height: numberOr(g["height"], 0),
          },
        };
      });
  }, [evidenceId, projectedRegions]);

  const onMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (versionLocked) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      setDrag({ startX: x, startY: y, x, y, w: 0, h: 0 });
    },
    [versionLocked],
  );
  const onMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!drag || versionLocked) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      const w = Math.abs(x - drag.startX);
      const h = Math.abs(y - drag.startY);
      const minX = Math.min(x, drag.startX);
      const minY = Math.min(y, drag.startY);
      setDrag({ ...drag, x: minX, y: minY, w, h });
    },
    [drag, versionLocked],
  );
  const addRegion = useCallback(async (geometry: NormalizedRect) => {
    try {
      await apiFetch(`/v1/redaction/versions/${versionId}/regions`, {
        method: "POST",
        body: JSON.stringify({
          kind: "BBOX_NORMALIZED",
          method,
          geometry,
        }),
      });
      setAddError(null);
      onChanged();
    } catch (err) {
      // B5B-F-200 — a refused region (VERSION_LOCKED from another tab, NOT_PERMITTED)
      // used to vanish silently.
      setAddError(regionAddFailureMessage(err));
    }
  }, [method, onChanged, versionId]);
  const onMouseUp = useCallback(async () => {
    if (!drag || versionLocked) return;
    setDrag(null);
    // PRO-R3-18 — a click without a drag is not a region.
    if (!isDeliberateDrag(drag.w, drag.h)) return;
    await addRegion({
      x: Math.max(0, Math.min(1, drag.x)),
      y: Math.max(0, Math.min(1, drag.y)),
      width: Math.max(0.005, Math.min(1 - drag.x, drag.w)),
      height: Math.max(0.005, Math.min(1 - drag.y, drag.h)),
    });
  }, [addRegion, drag, versionLocked]);

  return (
    <section
      data-redaction-image-viewer
      style={{
        background: "#fff",
        border: "1px solid rgba(15, 23, 42, 0.08)",
        borderRadius: 10,
        padding: 10,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <strong style={{ fontSize: 13 }}>Image redaction</strong>
        <span style={{ flex: 1 }} />
        <label style={{ fontSize: 11, color: "#475569" }}>
          Method&nbsp;
          <AppListbox
            value={method}
            // PRO-R3-04 — the renderer paints an opaque black-out for every
            // region; methods it does not render are not offered.
            options={[{ value: "BLACKOUT", label: "Blackout" }]}
            onChange={(next) => setMethod(
                            next as "BLUR" | "PIXELATE" | "BLACKOUT",
                          )}
            disabled={versionLocked}
            triggerProps={{ "data-redaction-image-method": "" }}
          />
        </label>
      </header>

      <div
        ref={containerRef}
        data-redaction-image-canvas
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        // PRO-R3-18 — leaving the frame disarms the drag.
        onMouseLeave={() => setDrag(null)}
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: aspect ?? "16 / 10",
          background:
            "repeating-linear-gradient(45deg, #f1f5f9 0 8px, #e2e8f0 8px 16px)",
          borderRadius: 8,
          overflow: "hidden",
          cursor: versionLocked ? "not-allowed" : "crosshair",
        }}
      >
        {showImage ? (
          <img
            data-redaction-image-preview
            src={preview.url}
            alt="The record being redacted"
            draggable={false}
            onLoad={(e) => {
              const el = e.currentTarget;
              if (el.naturalWidth > 0 && el.naturalHeight > 0) {
                setAspect(`${el.naturalWidth} / ${el.naturalHeight}`);
              }
            }}
            onError={() => setPreviewBroken(true)}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "fill",
              userSelect: "none",
              pointerEvents: "none",
            }}
          />
        ) : (
          <span
            data-redaction-image-placeholder
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#475569",
              fontSize: 12,
              textAlign: "center",
              padding: 12,
            }}
          >
            {preview.state === "loading"
              ? "Loading the image…"
              : "The image could not be shown here (your access may not include the original). Regions you draw apply to the full image frame."}
          </span>
        )}
        {drag ? (
          <div
            data-redaction-image-active-rect
            style={{
              position: "absolute",
              left: `${drag.x * 100}%`,
              top: `${drag.y * 100}%`,
              width: `${drag.w * 100}%`,
              height: `${drag.h * 100}%`,
              border: "2px solid #0f172a",
              background: "rgba(15, 23, 42, 0.18)",
              pointerEvents: "none",
            }}
          />
        ) : null}
        {regions.map((r) => (
          <div
            key={r.id}
            data-redaction-image-region={r.id}
            style={{
              position: "absolute",
              left: `${r.geometry.x * 100}%`,
              top: `${r.geometry.y * 100}%`,
              width: `${r.geometry.width * 100}%`,
              height: `${r.geometry.height * 100}%`,
              border: "1px solid #dc2626",
              background: "rgba(220, 38, 38, 0.18)",
            }}
          />
        ))}
      </div>

      <RegionCoordinateForm disabled={versionLocked} onAdd={addRegion} />

      <small
        style={{
          display: "block",
          marginTop: 6,
          color: "#475569",
          fontSize: 11,
        }}
      >
        Regions are saved as you draw them. The redacted copy is generated
        in the background; the original evidence is never modified.
      </small>
      {addError ? (
        <p role="alert" data-redaction-region-add-error style={{ color: "var(--status-risk-fg, #991b1b)", fontSize: 12.5, margin: "8px 0 0" }}>
          {addError}
        </p>
      ) : null}
    </section>
  );
}
