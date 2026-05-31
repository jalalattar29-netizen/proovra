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

import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch } from "../../lib/api";

type Region = {
  id: string;
  kind: string;
  method: string;
  geometry: { x: number; y: number; width: number; height: number };
};

export function ImageRedactionViewer({
  evidenceId,
  versionId,
  versionLocked,
  onChanged,
}: {
  evidenceId: string;
  versionId: string;
  versionLocked: boolean;
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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [regions, setRegions] = useState<Region[]>([]);

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch(
        `/v1/redaction/projects/${evidenceId}`,
        { method: "GET" },
      );
      // The project endpoint returns the project; per-version regions
      // are included via the projection. Pluck the matching version.
      const project = res?.project;
      const version = project?.versions?.find(
        (v: { id: string }) => v.id === versionId,
      );
      // The projection does not currently expose regions inline; ship
      // an explicit fetch when the dedicated endpoint lands. For now
      // we render an empty list — the viewer is still authoritative
      // for drawing new regions.
      void version;
      setRegions([]);
    } catch {
      setRegions([]);
    }
  }, [evidenceId, versionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
  const onMouseUp = useCallback(async () => {
    if (!drag || versionLocked) return;
    const geometry = {
      x: Math.max(0, Math.min(1, drag.x)),
      y: Math.max(0, Math.min(1, drag.y)),
      width: Math.max(0.005, Math.min(1 - drag.x, drag.w)),
      height: Math.max(0.005, Math.min(1 - drag.y, drag.h)),
    };
    setDrag(null);
    try {
      await apiFetch(`/v1/redaction/versions/${versionId}/regions`, {
        method: "POST",
        body: JSON.stringify({
          kind: "BBOX_NORMALIZED",
          method,
          geometry,
        }),
      });
      onChanged();
    } catch {
      /* swallow — the parent reflects the banner */
    }
  }, [drag, method, onChanged, versionId, versionLocked]);

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
          <select
            data-redaction-image-method
            value={method}
            onChange={(e) =>
              setMethod(
                e.target.value as "BLUR" | "PIXELATE" | "BLACKOUT",
              )
            }
            disabled={versionLocked}
            style={{
              padding: "3px 6px",
              borderRadius: 6,
              border: "1px solid #cbd5e1",
              fontSize: 11,
            }}
          >
            <option value="BLACKOUT">BLACKOUT</option>
            <option value="BLUR">BLUR</option>
            <option value="PIXELATE">PIXELATE</option>
          </select>
        </label>
      </header>

      <div
        ref={containerRef}
        data-redaction-image-canvas
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: "16 / 10",
          background:
            "repeating-linear-gradient(45deg, #f1f5f9 0 8px, #e2e8f0 8px 16px)",
          borderRadius: 8,
          overflow: "hidden",
          cursor: versionLocked ? "not-allowed" : "crosshair",
        }}
      >
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
          }}
        >
          Original evidence preview · drag to draw a region
        </span>
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

      <small
        style={{
          display: "block",
          marginTop: 6,
          color: "#475569",
          fontSize: 11,
        }}
      >
        Regions are persisted server-side as normalized geometry. The
        derivative is generated by the worker pipeline; the original
        evidence bytes are never modified.
      </small>
    </section>
  );
}
