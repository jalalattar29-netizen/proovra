/**
 * SIDEBAR STORAGE (T-09g / RC-10) — the native port of the web's
 * `SidebarStorageWidget` (components/app-shell-v2/SidebarStorageWidget.tsx).
 *
 * The web rail's footer shows storage used against the plan on every page; the
 * native rail had no footer at all. Same source (`/v1/billing/overview` →
 * `workspaces.personal.storage`), same arithmetic, same refusal to draw a bar
 * it cannot back: when the percentage or either label cannot be derived, the
 * widget renders NOTHING rather than a bar at 0%.
 *
 * PURE — the fetch lives in the component.
 */

export interface StorageView {
  readonly percent: number;
  readonly usedLabel: string;
  readonly limitLabel: string;
}

const GB = 1024 * 1024 * 1024;

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function parseBytes(raw: unknown): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** `bytesToGbLabel`, verbatim in effect. */
export function bytesToGbLabel(bytes: number): string {
  const gb = bytes / GB;
  const rounded = Math.round(gb * 100) / 100;
  const display = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(rounded < 100 ? 2 : 0);
  return `${display} GB`;
}

/** The web's `toView` over `workspaces.personal.storage`. */
export function storageViewFromOverview(overview: unknown): StorageView | null {
  const storage = obj(obj(obj(obj(overview)?.["workspaces"])?.["personal"])?.["storage"]);
  if (!storage) return null;

  const usedBytes = parseBytes(storage["usedBytes"]);
  const limitBytes = parseBytes(storage["limitBytes"]);

  let percent: number | null = typeof storage["usagePercent"] === "number" ? (storage["usagePercent"] as number) : null;
  if (percent == null && usedBytes != null && limitBytes != null && limitBytes > 0) {
    percent = (usedBytes / limitBytes) * 100;
  }
  if (percent == null) return null;
  percent = Math.min(100, Math.max(0, Math.round(percent * 10) / 10));

  const usedLabel =
    usedBytes != null ? bytesToGbLabel(usedBytes) : typeof storage["usedLabel"] === "string" ? storage["usedLabel"] : null;
  const limitLabel =
    limitBytes != null ? bytesToGbLabel(limitBytes) : typeof storage["limitLabel"] === "string" ? storage["limitLabel"] : null;
  if (usedLabel == null || limitLabel == null) return null;

  return { percent, usedLabel, limitLabel };
}
