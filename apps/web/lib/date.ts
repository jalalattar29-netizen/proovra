/**
 * apps/web date helpers — thin wrappers over the single shared timestamp layer
 * (@proovra/shared). Per the PROOVRA Global Timestamp Display Policy the
 * authenticated dashboard renders timestamps in the VIEWER's IANA time zone
 * (e.g. "03 Jul 2026, 02:48:42 Europe/Berlin") — never "GMT+2" — and audit
 * surfaces render UTC. No direct Intl/toLocale formatting lives here anymore;
 * the browser time zone is resolved inside the shared (allowlisted) helper.
 */
import {
  formatTimestampForDashboard,
  formatTimestampForReportUtc,
  formatTimestampParts,
  resolveViewerTimeZone,
} from "@proovra/shared";

const NOT_AVAILABLE = "Not available";

/** Viewer-timezone dashboard timestamp: "03 Jul 2026, 02:48:42 Europe/Berlin". */
export function formatUserDateTime(value?: string | Date | null): string {
  if (value === null || value === undefined || value === "") return NOT_AVAILABLE;
  return formatTimestampForDashboard(value, resolveViewerTimeZone(), {
    fallback: NOT_AVAILABLE,
  });
}

/** UTC audit timestamp: "03 Jul 2026, 00:48:42 UTC". */
export function formatUtcAuditDateTime(value?: string | Date | null): string {
  if (value === null || value === undefined || value === "") return NOT_AVAILABLE;
  return formatTimestampForReportUtc(value, { fallback: NOT_AVAILABLE });
}

/** Viewer-timezone date only: "03 Jul 2026". */
export function formatUserDate(value?: string | Date | null): string {
  if (value === null || value === undefined || value === "") return NOT_AVAILABLE;
  const parts = formatTimestampParts(value, resolveViewerTimeZone());
  return parts ? parts.date : NOT_AVAILABLE;
}

/** Viewer-timezone time only: "02:48:42 Europe/Berlin". */
export function formatUserTime(value?: string | Date | null): string {
  if (value === null || value === undefined || value === "") return NOT_AVAILABLE;
  const parts = formatTimestampParts(value, resolveViewerTimeZone());
  return parts ? `${parts.time} ${parts.timeZone}` : NOT_AVAILABLE;
}

/**
 * Compact viewer-timezone stamp for a narrow surface: "03 Jul 2026 · 02:48".
 *
 * WHY THIS LIVES HERE AND NOT AT THE CALL SITE
 * ---------------------------------------------------------------------------
 * The Settings sign-in card needs a short stamp: `formatUserDateTime` renders
 * "03 Jul 2026, 02:48:42 Europe/Berlin", and the card is one narrow column with
 * room for neither the seconds nor the zone name. A caller reached for
 * `toLocaleDateString` / `toLocaleTimeString` to get there, which is the
 * project's ONE forbidden move for timestamps — every locale-dependent
 * rendering is a different string per viewer, and a client component that
 * server-renders one and hydrates the other is a hydration mismatch that only
 * appears for readers outside the build machine's locale.
 *
 * This adds NO formatting authority. Every Intl call still happens exactly once,
 * in `packages/shared/src/timestamp-format.ts`; this composes
 * `formatTimestampParts` the same way `formatUserDate` and `formatUserTime`
 * directly above already do. `apps/web/lib/date.ts` is the app's allowlisted
 * thin wrapper precisely so a compact variant has somewhere to be that is not a
 * component file.
 *
 * The seconds are dropped by SLICING a known-shape string, not by re-formatting:
 * `formatTimestampParts` emits `HH:MM:SS` zero-padded on both its Intl path
 * (`hour12: false`, 2-digit) and its UTC fallback path (`two()`), so the first
 * five characters are always the hour and minute. A second `Intl` call to drop
 * two digits would be a second place for the format to drift.
 *
 * The ZONE is dropped from the text, not from the computation: the value is
 * still rendered in the viewer's IANA zone. A surface that hides the zone label
 * should pair this with a `<time dateTime={iso}>` element so the unambiguous
 * instant remains available to a screen reader and to copy-paste.
 */
export function formatUserDateTimeCompact(
  value?: string | Date | null,
): string {
  if (value === null || value === undefined || value === "") return NOT_AVAILABLE;
  const parts = formatTimestampParts(value, resolveViewerTimeZone());
  return parts ? `${parts.date} · ${parts.time.slice(0, 5)}` : NOT_AVAILABLE;
}

/** UTC date only: "03 Jul 2026" — for UTC-boundary labels (usage resets). */
export function formatUtcDate(value?: string | Date | null): string {
  if (value === null || value === undefined || value === "") return NOT_AVAILABLE;
  const parts = formatTimestampParts(value, "UTC");
  return parts ? parts.date : NOT_AVAILABLE;
}

/**
 * A timestamp for a TABLE CELL: the viewer-timezone stamp, or an em dash.
 *
 * `formatUserDateTime` answers "Not available" for a missing value, which is
 * the right answer in a fact list and the wrong one in a column of forty rows
 * — thirteen characters of prose repeated down a cell that is trying to be
 * scannable. Twelve admin surfaces had their own copy of this three-line
 * wrapper, in `admin/identity/ui-tokens.ts`, alongside the console's second
 * design system; the formatter had nothing to do with styling and outlived it.
 */
export function formatCellDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return formatUserDateTime(iso);
  } catch {
    return iso;
  }
}
