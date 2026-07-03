/**
 * PROOVRA Global Timestamp Display Policy — the single shared formatting layer.
 *
 * DISPLAY FORMATTING ONLY. These helpers never change stored values, never
 * migrate data, and never touch canonical/package/custody/manifest material.
 *
 * Policy:
 *   - PDF report + any legally-stable surface → UTC only:
 *       formatTimestampForReportUtc  → "03 Jul 2026, 00:48:42 UTC"
 *   - Authenticated dashboard / internal UI → viewer timezone:
 *       formatTimestampForDashboard  → "03 Jul 2026, 02:48:42 Europe/Berlin"
 *   - Public Verify page → viewer timezone, UTC fallback:
 *       formatTimestampForVerify
 *   - Verification Package → RAW ISO UTC preserved (validate only):
 *       formatTimestampForPackage
 *   - Device / EXIF original capture time → offset-aware, never fabricated:
 *       formatDeviceTime
 *
 * No GMT+X, no AM/PM, no browser-local strings in the report; the viewer tz is
 * the IANA name (e.g. Europe/Berlin), never "GMT+2".
 */

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

export const TIMESTAMP_NOT_RECORDED = "Not recorded";

export type TimestampInput = string | number | Date | null | undefined;

function toDate(value: TimestampInput): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * UTC-only human-readable timestamp: "03 Jul 2026, 00:48:42 UTC".
 * Viewer-timezone-independent — for the PDF report and any surface that must be
 * legally stable regardless of who opens it.
 */
export function formatTimestampForReportUtc(
  value: TimestampInput,
  opts?: { fallback?: string },
): string {
  const d = toDate(value);
  if (!d) return opts?.fallback ?? TIMESTAMP_NOT_RECORDED;
  return (
    `${two(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ` +
    `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} UTC`
  );
}

/**
 * Format a timestamp in a specific IANA time zone into display parts. No GMT+X,
 * no AM/PM. Invalid zone falls back to UTC parts. Returns null for no value.
 */
export function formatTimestampParts(
  value: TimestampInput,
  timeZone: string,
): { date: string; time: string; timeZone: string } | null {
  const d = toDate(value);
  if (!d) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const hour = get("hour") === "24" ? "00" : get("hour");
    return {
      date: `${get("day")} ${get("month")} ${get("year")}`,
      time: `${hour}:${get("minute")}:${get("second")}`,
      timeZone,
    };
  } catch {
    return {
      date: `${two(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
      time: `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`,
      timeZone: "UTC",
    };
  }
}

/**
 * Dashboard / internal UI timestamp in the viewer's IANA time zone:
 *   "03 Jul 2026, 02:48:42 Europe/Berlin"
 * timeZone falls back to UTC when omitted/blank. NEVER emits "GMT+2".
 */
export function formatTimestampForDashboard(
  value: TimestampInput,
  timeZone?: string | null,
  opts?: { fallback?: string },
): string {
  const tz = timeZone && timeZone.trim() ? timeZone.trim() : "UTC";
  const parts = formatTimestampParts(value, tz);
  if (!parts) return opts?.fallback ?? TIMESTAMP_NOT_RECORDED;
  return `${parts.date}, ${parts.time} ${parts.timeZone}`;
}

/**
 * Public Verify page timestamp: viewer time zone when known, else UTC fallback:
 *   with tz  → "03 Jul 2026, 02:48:42 Europe/Berlin"
 *   no tz    → "03 Jul 2026, 00:48:42 UTC"
 */
export function formatTimestampForVerify(
  value: TimestampInput,
  timeZone?: string | null,
  opts?: { fallback?: string },
): string {
  if (!timeZone || !timeZone.trim()) {
    return formatTimestampForReportUtc(value, opts);
  }
  return formatTimestampForDashboard(value, timeZone, opts);
}

/**
 * Verification Package timestamp — the RAW ISO UTC value is PRESERVED. This
 * helper validates only; it never reformats a stored package value. (Package
 * builders keep raw values directly and are allowlisted; this exists so a
 * caller that wants a validated ISO string has one canonical entry point.)
 */
export function formatTimestampForPackage(value: TimestampInput): string | null {
  if (typeof value === "string") {
    // Preserve the exact stored string when it is a valid instant.
    return toDate(value) ? value : null;
  }
  const d = toDate(value);
  return d ? d.toISOString() : null;
}

/**
 * Device / EXIF original capture time. This is NOT a server UTC timestamp and
 * must never be converted or have a `Z` invented.
 *
 *   - source has an offset (Z or ±HH:MM):
 *       { formatted: "03 Jul 2026, 02:23:34 UTC+02:00", hasZone: true }
 *   - source is naive (no offset):
 *       { formatted: "03 Jul 2026, 02:23:34", hasZone: false,
 *         note: "time zone unavailable" }
 *
 * The wall-clock fields are read verbatim from the string — never shifted.
 */
export function formatDeviceTime(
  value: string | null | undefined,
): { formatted: string; hasZone: boolean; note?: string } | null {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  const m = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/,
  );
  if (!m) return null;
  const [, y, mo, day, hh, mi, ss, , offRaw] = m;
  const monthIdx = Number(mo) - 1;
  if (monthIdx < 0 || monthIdx > 11) return null;
  const wall = `${day} ${MONTHS[monthIdx]} ${y}, ${hh}:${mi}:${ss ?? "00"}`;
  if (offRaw) {
    let off: string;
    if (offRaw === "Z") {
      off = "UTC+00:00";
    } else {
      const sign = offRaw[0];
      const digits = offRaw.slice(1).replace(":", "");
      off = `UTC${sign}${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
    }
    return { formatted: `${wall} ${off}`, hasZone: true };
  }
  return { formatted: wall, hasZone: false, note: "time zone unavailable" };
}

/**
 * Resolve the viewer's IANA time zone (browser). Returns "UTC" when it cannot
 * be determined. Safe to call in any environment. Callers may prefer a saved
 * user preference over this.
 */
export function resolveViewerTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && tz.trim() ? tz : "UTC";
  } catch {
    return "UTC";
  }
}
