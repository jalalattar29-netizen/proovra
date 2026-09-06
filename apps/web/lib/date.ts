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

/**
 * HOW LONG AGO, FOR A ROW AN OPERATOR IS TRIAGING.
 *
 * An incident's "last seen" is the one timestamp whose RECENCY is the fact —
 * "3m ago" answers the operator's question and "05 Sept 2026, 16:21:53
 * Europe/Berlin" makes them subtract. /admin/operations printed the latter
 * under every condition's title, where it wrapped to two lines.
 *
 * Absolute precision is not lost, it moves: every call site pairs this with
 * the full stamp in a `title`, so hovering still gives the exact instant, and
 * the audit surfaces that need the seconds on the page keep using
 * `formatUtcAuditDateTime`.
 *
 * Two identical copies of this function already existed — one in
 * `NotificationBell.tsx`, one in `CasesIndex.tsx`. This is the third caller,
 * and rather than write it again it lives here with the other formatters.
 * Those two are outside this phase's surface and are left alone deliberately;
 * they are now the duplicates rather than the definition.
 */
/**
 * HOW LONG UNTIL — OR SINCE — A DEADLINE.
 *
 * A sibling of `formatRelativeTime`, not a replacement, and the difference is
 * deliberate. That one answers "how long ago", and treats a future instant as
 * clock skew because on an incident row it is: an incident cannot have been
 * last seen tomorrow. A reviewer SLA deadline is the opposite case — the
 * future IS the answer, and "just now" for a target three hours out would be
 * the wrong fact rather than a cautious one.
 *
 * Written here because `reviewer-ops/ui-tokens.ts` carried its own copy
 * alongside a hardcoded palette, and the formatter never had anything to do
 * with the styling it was shipped with. Deleting that module left this behind
 * as the only thing in it worth keeping.
 */
export function formatRelativeDeadline(iso?: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const ms = t - Date.now();
  const abs = Math.abs(ms);
  const minutes = Math.round(abs / 60_000);
  if (minutes < 60) return ms >= 0 ? `in ${minutes}m` : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return ms >= 0 ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return ms >= 0 ? `in ${days}d` : `${days}d ago`;
}

export function formatRelativeTime(value?: string | Date | null): string {
  if (value === null || value === undefined || value === "") return NOT_AVAILABLE;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (Number.isNaN(t)) return NOT_AVAILABLE;
  const minutes = Math.floor((Date.now() - t) / 60_000);
  // A clock skew or a future-dated row must not render "-4m ago".
  if (minutes < 0) return "just now";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatUserDate(value);
}
