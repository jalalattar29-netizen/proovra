"use client";

/**
 * Shared authoring helpers for the redaction editors (PRO-R3-04, PRO-R3-18).
 *
 *   - `useEvidenceImagePreview` loads the record's own preview through the
 *     Evidence detail read (GET /v1/evidence/:id), so reach, the
 *     original-download decision and custody stay with the canonical evidence
 *     authority. No URL is minted by the redaction surface itself.
 *   - `RegionCoordinateForm` is the keyboard / touch path for a region: four
 *     numeric fields (percent of the frame) and a button, sending exactly the
 *     normalized rectangle a drag would send.
 *   - `activateOnKey` gives a clickable row button semantics (Enter / Space).
 */

import { useEffect, useState, type KeyboardEvent } from "react";

import { apiFetch } from "../../lib/api";

export type NormalizedRect = { x: number; y: number; width: number; height: number };

/** A drag smaller than this (1% of the frame) is a click, not a region. */
export const MIN_REGION_DRAG = 0.01;

/**
 * True when a finished drag is a deliberate rectangle. A plain click (no
 * movement) used to add a 0.5% region.
 */
export function isDeliberateDrag(w: number, h: number): boolean {
  return !(w < MIN_REGION_DRAG || h < MIN_REGION_DRAG);
}

export type EvidenceImagePreview =
  | { state: "loading" }
  | { state: "ready"; url: string }
  /** No image preview is released to this viewer (refused, not an image, or the read failed). */
  | { state: "unavailable" };

type ContentItemLike = {
  mimeType?: unknown;
  kind?: unknown;
  viewUrl?: unknown;
  isPrimary?: unknown;
};

function isImageItem(item: ContentItemLike): boolean {
  const mime = typeof item.mimeType === "string" ? item.mimeType.toLowerCase() : "";
  if (mime.startsWith("image/")) return true;
  return typeof item.kind === "string" && item.kind.toLowerCase() === "image";
}

export function useEvidenceImagePreview(evidenceId: string): EvidenceImagePreview {
  const [preview, setPreview] = useState<EvidenceImagePreview>({ state: "loading" });
  useEffect(() => {
    let live = true;
    setPreview({ state: "loading" });
    (async () => {
      try {
        const res = (await apiFetch(`/v1/evidence/${evidenceId}`, { method: "GET" })) as
          | { evidence?: { contentItems?: unknown } ; contentItems?: unknown }
          | null;
        const raw = res?.evidence?.contentItems ?? res?.contentItems;
        const items = (Array.isArray(raw) ? raw : []) as ContentItemLike[];
        const images = items.filter(
          (i) => isImageItem(i) && typeof i.viewUrl === "string" && i.viewUrl.length > 0,
        );
        const chosen = images.find((i) => i.isPrimary === true) ?? images[0];
        if (!live) return;
        setPreview(
          chosen ? { state: "ready", url: chosen.viewUrl as string } : { state: "unavailable" },
        );
      } catch {
        if (live) setPreview({ state: "unavailable" });
      }
    })();
    return () => {
      live = false;
    };
  }, [evidenceId]);
  return preview;
}

export function activateOnKey(run: () => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      run();
    }
  };
}

const fieldStyle = {
  width: 64,
  marginLeft: 4,
  padding: "3px 6px",
  borderRadius: 6,
  border: "1px solid #cbd5e1",
  fontSize: 11,
} as const;

/**
 * Percent inputs -> a normalized rectangle inside the frame, or null when the
 * numbers do not describe one.
 */
export function percentRectToNormalized(p: {
  left: number;
  top: number;
  width: number;
  height: number;
}): NormalizedRect | null {
  const vals = [p.left, p.top, p.width, p.height];
  if (!vals.every((v) => Number.isFinite(v))) return null;
  const x = p.left / 100;
  const y = p.top / 100;
  const width = p.width / 100;
  const height = p.height / 100;
  if (x < 0 || y < 0 || width <= 0 || height <= 0) return null;
  if (x + width > 1 + 1e-9 || y + height > 1 + 1e-9) return null;
  return { x, y, width: Math.min(width, 1 - x), height: Math.min(height, 1 - y) };
}

export function RegionCoordinateForm({
  disabled,
  onAdd,
}: {
  disabled: boolean;
  onAdd: (rect: NormalizedRect) => void | Promise<void>;
}) {
  const [left, setLeft] = useState("10");
  const [top, setTop] = useState("10");
  const [width, setWidth] = useState("20");
  const [height, setHeight] = useState("10");
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const field = (label: string, value: string, set: (v: string) => void, name: string) => (
    <label style={{ fontSize: 11, color: "#475569" }}>
      {label}
      <input
        data-redaction-region-coordinate={name}
        type="number"
        min={0}
        max={100}
        step="any"
        inputMode="decimal"
        value={value}
        onChange={(e) => set(e.target.value)}
        disabled={disabled || busy}
        style={fieldStyle}
      />
    </label>
  );
  return (
    <form
      data-redaction-region-coordinate-form
      onSubmit={(e) => {
        e.preventDefault();
        if (disabled || busy) return;
        const rect = percentRectToNormalized({
          left: Number(left),
          top: Number(top),
          width: Number(width),
          height: Number(height),
        });
        if (!rect) {
          setInvalid(true);
          return;
        }
        setInvalid(false);
        setBusy(true);
        void Promise.resolve(onAdd(rect)).finally(() => setBusy(false));
      }}
      style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 8 }}
    >
      <span style={{ fontSize: 11, color: "#475569" }}>Add by position (% of the frame):</span>
      {field("Left", left, setLeft, "left")}
      {field("Top", top, setTop, "top")}
      {field("Width", width, setWidth, "width")}
      {field("Height", height, setHeight, "height")}
      <button type="submit" className="app-secondary-action" disabled={disabled || busy}>
        Add region
      </button>
      {invalid ? (
        <span role="alert" style={{ fontSize: 11, color: "var(--status-risk-fg, #991b1b)" }}>
          The rectangle must lie inside the frame: left + width and top + height at most 100.
        </span>
      ) : null}
    </form>
  );
}
