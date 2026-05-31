"use client";

/**
 * PROOVRA Phase 3A — PDF redaction viewer.
 *
 * Bounded PDF region authoring. Operators choose a page index, draw
 * a normalized bbox on that page, and pick the bounded redaction
 * method. The region is persisted as `PDF_PAGE_RECT` and the
 * derivative renderer maps the bbox onto the rendered page.
 *
 * Hard rules:
 *   * Drawing is a metadata-only event. The original PDF bytes are
 *     never mutated client-side.
 *   * Text-range regions (`PDF_TEXT_RANGE`) are produced by the
 *     detection engine + the operator promotes them via the
 *     decision panel — they are not authored from this viewer.
 */

import { useCallback, useRef, useState } from "react";

import { apiFetch } from "../../lib/api";

export function PdfRedactionViewer({
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
  const [pageIndex, setPageIndex] = useState<number>(0);
  const [method, setMethod] = useState<"BLACKOUT" | "REMOVE_CONTENT">(
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

  void evidenceId; // reserved for the future presigned-fetch hook.

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
    const rect = {
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
          kind: "PDF_PAGE_RECT",
          method,
          geometry: { pageIndex, rect },
        }),
      });
      onChanged();
    } catch {
      /* swallow */
    }
  }, [drag, method, onChanged, pageIndex, versionId, versionLocked]);

  return (
    <section
      data-redaction-pdf-viewer
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
        <strong style={{ fontSize: 13 }}>PDF redaction</strong>
        <label style={{ fontSize: 11, color: "#475569", marginLeft: 12 }}>
          Page
          <input
            data-redaction-pdf-page
            type="number"
            min={0}
            value={pageIndex}
            onChange={(e) => setPageIndex(Number(e.target.value))}
            disabled={versionLocked}
            style={{
              marginLeft: 4,
              width: 56,
              padding: "3px 6px",
              borderRadius: 6,
              border: "1px solid #cbd5e1",
              fontSize: 11,
            }}
          />
        </label>
        <span style={{ flex: 1 }} />
        <label style={{ fontSize: 11, color: "#475569" }}>
          Method&nbsp;
          <select
            data-redaction-pdf-method
            value={method}
            onChange={(e) =>
              setMethod(e.target.value as "BLACKOUT" | "REMOVE_CONTENT")
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
            <option value="REMOVE_CONTENT">REMOVE_CONTENT</option>
          </select>
        </label>
      </header>

      <div
        ref={containerRef}
        data-redaction-pdf-canvas
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: "1 / 1.4142",
          background: "#fff",
          border: "1px dashed rgba(15, 23, 42, 0.18)",
          borderRadius: 8,
          overflow: "hidden",
          cursor: versionLocked ? "not-allowed" : "crosshair",
        }}
      >
        <span
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
          PDF page {pageIndex + 1} preview · drag to draw a page region
        </span>
        {drag ? (
          <div
            data-redaction-pdf-active-rect
            style={{
              position: "absolute",
              left: `${drag.x * 100}%`,
              top: `${drag.y * 100}%`,
              width: `${drag.w * 100}%`,
              height: `${drag.h * 100}%`,
              border: "2px solid #0f172a",
              background: "rgba(15, 23, 42, 0.2)",
            }}
          />
        ) : null}
      </div>

      <small
        style={{
          display: "block",
          marginTop: 6,
          color: "#475569",
          fontSize: 11,
        }}
      >
        PDF derivatives are generated by the worker pipeline. The
        REMOVE_CONTENT method strips intersecting content-stream
        operators in addition to drawing the visual blackout. The
        derivative MUST be readable as the bounded redacted PDF —
        never as the original.
      </small>
    </section>
  );
}
