import { formatUtcAuditDateTime } from "../../../../lib/date";

/** Page identity. Single source for the heading + supporting line so the
 *  header component declares no copy of its own. */
export const EVIDENCE_LIBRARY_TITLE = "Evidence Library";
/** Target reference wording — concise, two lines at the design width. */
export const EVIDENCE_LIBRARY_DESCRIPTION =
  "Operational workspace for managing, reviewing, and exporting preserved evidence records.";

/** Heading for the legal-boundary panel. The BODY below is the approved
 *  wording and is unchanged. */
export const EVIDENCE_LIBRARY_LEGAL_BOUNDARY_TITLE = "Legal boundary";

export const EVIDENCE_LIBRARY_LEGAL_BOUNDARY =
  "PROOVRA verifies the recorded integrity state of evidence records. It does not independently establish factual truth, authorship, identity, legal admissibility, or evidentiary weight.";

export function formatUtcDateTime(value: string | null | undefined): string {
  if (!value) return "Not recorded";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";

  return formatUtcAuditDateTime(value);
}

export function formatBytes(value: string | number | null | undefined): string {
  const numeric = typeof value === "number" ? value : value ? Number(value) : Number.NaN;

  if (!Number.isFinite(numeric) || numeric <= 0) return "Not recorded";

  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let size = numeric;
  let index = 0;

  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }

  return `${size.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

export function shortId(value: string | null | undefined): string {
  const text = (value ?? "").trim();
  if (!text) return "Not available";
  if (text.length <= 14) return text;
  return `${text.slice(0, 8)}…${text.slice(-6)}`;
}

export function safeText(
  value: string | null | undefined,
  fallback = "Not available"
): string {
  const text = (value ?? "").trim();
  return text || fallback;
}

export function buildVerificationUrl(evidenceId: string): string {
  const appBase =
    process.env.NEXT_PUBLIC_APP_BASE?.trim() ||
    process.env.NEXT_PUBLIC_WEB_BASE?.trim() ||
    "https://app.proovra.com";

  return `${appBase.replace(/\/+$/, "")}/verify/${evidenceId}`;
}

/**
 * Part 3 — the reference renders CREATED as a bold date with the UTC clock
 * time beneath it. This splits the single canonical string produced by
 * `formatUtcDateTime` rather than introducing a second date formatter.
 */
export function splitUtcDateTime(value: string | null | undefined): {
  date: string;
  time: string | null;
} {
  const text = formatUtcDateTime(value);
  const separator = text.indexOf(", ");
  if (separator === -1) return { date: text, time: null };
  return { date: text.slice(0, separator), time: text.slice(separator + 2) };
}
