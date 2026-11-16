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

/**
 * B2A-F-02 (Free-user audit 0ea0) — the server's own unit rule
 * (shared-billing `formatBytesHuman`: binary units printed MB/GB), used only
 * when the server sent no label. Free's 262,144,000 bytes read "250 MB" — the
 * Pricing figure — not "0.24 GB"; 5 MB is "5 MB", not "0 GB".
 */
export function bytesToHumanLabel(bytes: number): string {
  const MB = 1024 * 1024;
  const trim = (n: number) => (Math.abs(n - Math.round(n)) < 0.005 ? String(Math.round(n)) : n.toFixed(2).replace(/\.?0+$/, ""));
  if (bytes >= GB) return `${trim(bytes / GB)} GB`;
  if (bytes >= MB) return `${trim(bytes / MB)} MB`;
  if (bytes >= 1024) return `${trim(bytes / 1024)} KB`;
  return `${bytes} B`;
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

  // B2A-F-02 — the SERVER's labels first (formatBytesHuman); bytes only as a
  // fallback, formatted by the same unit rule rather than as two-decimal GB.
  const usedLabel =
    typeof storage["usedLabel"] === "string" ? storage["usedLabel"] : usedBytes != null ? bytesToHumanLabel(usedBytes) : null;
  const limitLabel =
    typeof storage["limitLabel"] === "string" ? storage["limitLabel"] : limitBytes != null ? bytesToHumanLabel(limitBytes) : null;
  if (usedLabel == null || limitLabel == null) return null;

  return { percent, usedLabel, limitLabel };
}
