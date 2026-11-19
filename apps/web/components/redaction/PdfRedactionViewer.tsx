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

import { regionAddFailureMessage } from "../../lib/redaction/refusal";
import { AppListbox } from "../app-primitives/AppListbox";
import { useCallback, useRef, useState } from "react";

import { apiFetch } from "../../lib/api";
import { RegionCoordinateForm, isDeliberateDrag, type NormalizedRect } from "./region-authoring";

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
  const [addError, setAddError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

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
  const addRegion = useCallback(async (rect: NormalizedRect) => {
    try {
      await apiFetch(`/v1/redaction/versions/${versionId}/regions`, {
        method: "POST",
        body: JSON.stringify({
          kind: "PDF_PAGE_RECT",
          method,
          geometry: { pageIndex, rect },
        }),
      });
      setAddError(null);
      onChanged();
    } catch (err) {
      // B5B-F-200 — a refused region (VERSION_LOCKED from another tab, NOT_PERMITTED)
      // used to vanish silently.
      setAddError(regionAddFailureMessage(err));
    }
  }, [method, onChanged, pageIndex, versionId]);
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
          <AppListbox
            value={method}
            // PRO-R3-04 — the copy is a flattened raster with each region
            // blacked out; "remove content" is not a separate rendering.
            options={[{ value: "BLACKOUT", label: "Black out" }]}
            onChange={(next) => setMethod(next as "BLACKOUT" | "REMOVE_CONTENT")}
            disabled={versionLocked}
            triggerProps={{ "data-redaction-pdf-method": "" }}
          />
        </label>
      </header>

      <div
        ref={containerRef}
        data-redaction-pdf-canvas
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        // PRO-R3-18 — leaving the frame disarms the drag.
        onMouseLeave={() => setDrag(null)}
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
          Page {pageIndex + 1} — the page is not shown here. Open the record in another tab to read
          it, then draw (or enter) the region as a share of the full page.
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
        Redacted PDFs are generated in the background as a flattened copy:
        every page becomes an image with each region blacked out, so the text
        under a region is not in the copy. The original is never modified.
      </small>
      <RegionCoordinateForm disabled={versionLocked} onAdd={addRegion} />
      <p style={{ margin: "6px 0 0", fontSize: 11 }}>
        <a href={`/evidence/${evidenceId}`} target="_blank" rel="noreferrer" className="ui-link" data-redaction-pdf-open-record>
          Open the record in a new tab
        </a>
      </p>
      {addError ? (
        <p role="alert" data-redaction-region-add-error style={{ color: "var(--status-risk-fg, #991b1b)", fontSize: 12.5, margin: "8px 0 0" }}>
          {addError}
        </p>
      ) : null}
    </section>
  );
}
