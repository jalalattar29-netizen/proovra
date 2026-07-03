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
