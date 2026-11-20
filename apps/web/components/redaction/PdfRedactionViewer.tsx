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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiFetch } from "../../lib/api";
import {
  RegionAuthoringBlockedNotice,
  RegionCoordinateForm,
  isDeliberateDrag,
  type NormalizedRect,
} from "./region-authoring";

/**
 * PRO-R3-04 — the page under the regions.
 *
 * `GET /v1/redaction/projects/:id/preview/pages/:n` answers PENDING while the
 * worker renders the page, then READY with a short-lived image URL. The editor
 * asks after the page number settles, shows "Preparing preview…" and asks
 * again with a growing pause (1 s, 2 s, 4 s, 8 s, then every 10 s) for about
 * two minutes.
 *
 * Every other answer leaves the frame without a page: an API that predates
 * the route (404), a page with no preview (UNAVAILABLE), a refusal, a lost
 * connection, or a render that never arrives.
 *
 * WEB-OLD-API-COMPAT — without the page in view (any state but READY, image
 * shown) region authoring is DISABLED — drawing and the coordinate form — and
 * the editor says so. A blank frame that still accepted rectangles let a
 * region be placed over nothing the operator could see.
 */
export const PDF_PREVIEW_POLL_DELAYS_MS = [1000, 2000, 4000, 8000, 10000] as const;
export const PDF_PREVIEW_POLL_BUDGET_MS = 120_000;
export const PDF_PREVIEW_SETTLE_MS = 400;
/** The server renders pages below this 0-based index (REDACTION_PAGE_PREVIEW_MAX_PAGES). */
const PDF_PREVIEW_MAX_PAGES = 200;

type PagePreview =
  | { state: "none" }
  | { state: "pending" }
  | { state: "ready"; url: string; width: number | null; height: number | null };

function usePdfPagePreview(projectId: string | undefined, pageIndex: number): {
  preview: PagePreview;
  /** The image failed to load (an expired URL): ask once more, then give up. */
  onImageError: () => void;
} {
  const [preview, setPreview] = useState<PagePreview>({ state: "none" });
  const [attempt, setAttempt] = useState(0);
  const retriedRef = useRef(false);

  useEffect(() => {
    retriedRef.current = false;
  }, [projectId, pageIndex]);

  useEffect(() => {
    setPreview({ state: "none" });
    if (!projectId || !Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= PDF_PREVIEW_MAX_PAGES) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let waited = 0;
    let polls = 0;
    const ask = async () => {
      let answer: unknown;
      try {
        answer = await apiFetch(`/v1/redaction/projects/${projectId}/preview/pages/${pageIndex}`);
      } catch {
        // An older API (404), a refusal or a lost answer: the plain frame.
        if (!cancelled) setPreview({ state: "none" });
        return;
      }
      if (cancelled) return;
      const body = (answer ?? {}) as { state?: unknown; url?: unknown; width?: unknown; height?: unknown };
      if (body.state === "READY" && typeof body.url === "string" && body.url) {
        setPreview({
          state: "ready",
          url: body.url,
          width: typeof body.width === "number" && body.width > 0 ? body.width : null,
          height: typeof body.height === "number" && body.height > 0 ? body.height : null,
        });
        return;
      }
      if (body.state !== "PENDING") {
        setPreview({ state: "none" });
        return;
      }
      const delay = PDF_PREVIEW_POLL_DELAYS_MS[Math.min(polls, PDF_PREVIEW_POLL_DELAYS_MS.length - 1)]!;
      if (waited + delay > PDF_PREVIEW_POLL_BUDGET_MS) {
        setPreview({ state: "none" });
        return;
      }
      setPreview({ state: "pending" });
      polls += 1;
      waited += delay;
      timer = setTimeout(() => void ask(), delay);
    };
    // Wait for the page number to settle: each page asked for is rendered.
    timer = setTimeout(() => void ask(), PDF_PREVIEW_SETTLE_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [projectId, pageIndex, attempt]);

  const onImageError = useCallback(() => {
    if (retriedRef.current) {
      setPreview({ state: "none" });
      return;
    }
    retriedRef.current = true;
    setAttempt((n) => n + 1);
  }, []);

  return { preview, onImageError };
}

export function PdfRedactionViewer({
  evidenceId,
  projectId,
  versionId,
  versionLocked,
  regions: projectedRegions,
  onChanged,
}: {
  evidenceId: string;
  /** The redaction project: its page previews are read through it (PRO-R3-04). */
  projectId?: string;
  versionId: string;
  versionLocked: boolean;
  /** The version's regions from the project read; this page's rectangles are drawn back. */
  regions?: ReadonlyArray<{ id: string; kind: string; geometry: Record<string, unknown> }>;
  onChanged: () => void;
}) {
  const [pageIndex, setPageIndex] = useState<number>(0);
  const { preview, onImageError } = usePdfPagePreview(projectId, pageIndex);
  // WEB-OLD-API-COMPAT — the page counts as shown only once its image has
  // loaded; a new answer (another page, a re-ask) hides it again.
  const readyUrl = preview.state === "ready" ? preview.url : null;
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const pageShown = readyUrl !== null && loadedUrl === readyUrl;
  const canAuthor = !versionLocked && pageShown;
  const pageRegions = useMemo(() => {
    const out: Array<{ id: string; x: number; y: number; width: number; height: number }> = [];
    for (const r of projectedRegions ?? []) {
      if (r.kind !== "PDF_PAGE_RECT") continue;
      const g = r.geometry as { pageIndex?: unknown; rect?: Record<string, unknown> };
      const rect = g.rect;
      if (g.pageIndex !== pageIndex || !rect) continue;
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      out.push({ id: r.id, x: n(rect["x"]), y: n(rect["y"]), width: n(rect["width"]), height: n(rect["height"]) });
    }
    return out;
  }, [projectedRegions, pageIndex]);
  const frameAspect =
    preview.state === "ready" && preview.width && preview.height
      ? `${preview.width} / ${preview.height}`
      : "1 / 1.4142";
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
      if (!canAuthor) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      setDrag({ startX: x, startY: y, x, y, w: 0, h: 0 });
    },
    [canAuthor],
  );
  const onMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!drag || !canAuthor) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      const w = Math.abs(x - drag.startX);
      const h = Math.abs(y - drag.startY);
      const minX = Math.min(x, drag.startX);
      const minY = Math.min(y, drag.startY);
      setDrag({ ...drag, x: minX, y: minY, w, h });
    },
    [drag, canAuthor],
  );
  const addRegion = useCallback(async (rect: NormalizedRect) => {
    // Never sent without the page in view (the form is disabled too).
    if (!canAuthor) return;
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
  }, [canAuthor, method, onChanged, pageIndex, versionId]);
  const onMouseUp = useCallback(async () => {
    if (!drag || !canAuthor) {
      setDrag(null);
      return;
    }
    setDrag(null);
    // PRO-R3-18 — a click without a drag is not a region.
    if (!isDeliberateDrag(drag.w, drag.h)) return;
    await addRegion({
      x: Math.max(0, Math.min(1, drag.x)),
      y: Math.max(0, Math.min(1, drag.y)),
      width: Math.max(0.005, Math.min(1 - drag.x, drag.w)),
      height: Math.max(0.005, Math.min(1 - drag.y, drag.h)),
    });
  }, [addRegion, drag, canAuthor]);

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
        data-redaction-authoring={canAuthor ? "enabled" : "disabled"}
        aria-disabled={canAuthor ? undefined : true}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        // PRO-R3-18 — leaving the frame disarms the drag.
        onMouseLeave={() => setDrag(null)}
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: frameAspect,
          background: "#fff",
          border: "1px dashed rgba(15, 23, 42, 0.18)",
          borderRadius: 8,
          overflow: "hidden",
          cursor: canAuthor ? "crosshair" : "not-allowed",
        }}
      >
        {preview.state === "ready" ? (
          <img
            data-redaction-pdf-page-image
            src={preview.url}
            alt={`Page ${pageIndex + 1} of the record`}
            draggable={false}
            onLoad={() => setLoadedUrl(preview.url)}
            onError={() => {
              setLoadedUrl(null);
              onImageError();
            }}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              pointerEvents: "none",
              userSelect: "none",
            }}
          />
        ) : preview.state === "pending" ? (
          <span
            role="status"
            data-redaction-pdf-preview-pending
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
            Preparing preview…
          </span>
        ) : (
          <span
            data-redaction-pdf-no-preview
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
            Page {pageIndex + 1} — the page preview is not available, so regions cannot be added to
            this page here.
          </span>
        )}
        {pageRegions.map((r) => (
          <div
            key={r.id}
            data-redaction-pdf-region={r.id}
            style={{
              position: "absolute",
              left: `${r.x * 100}%`,
              top: `${r.y * 100}%`,
              width: `${r.width * 100}%`,
              height: `${r.height * 100}%`,
              border: "1px solid #dc2626",
              background: "rgba(220, 38, 38, 0.18)",
              pointerEvents: "none",
            }}
          />
        ))}
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
      <RegionCoordinateForm disabled={!canAuthor} onAdd={addRegion} />
      {!versionLocked && !pageShown ? (
        <RegionAuthoringBlockedNotice
          waiting={preview.state === "pending" || (preview.state === "ready" && loadedUrl !== preview.url)}
          subject="page"
        />
      ) : null}
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
