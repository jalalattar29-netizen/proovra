/**
 * ONE relative-time description for the authenticated dashboard.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SHARED
 * ---------------------------------------------------------------------------
 * This began as a private helper inside the Intake Links route model. It is
 * not an intake-links concern: every operational surface needs to say how long
 * ago something happened, and the second copy of a function like this is where
 * "2h ago" and "2 hours ago" and "about 2 hours" start appearing on adjacent
 * screens of the same product.
 *
 * It stays a plain function over an explicit `now` so it can be tested without
 * a clock, and so a list of fifty rows resolves every age against the SAME
 * instant — a per-row `Date.now()` produces a table whose first and last rows
 * were measured against different presents.
 *
 * Beyond a month it hands over to `formatUserDate`, because "47d ago" is a
 * subtraction the reader has to do and "07 Jul 2026" is a date they can use.
 */

import { formatUserDate } from "./date";

export function describeRelativeTime(
  iso: string | null | undefined,
  now: number = Date.now(),
): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const past = t <= now;
  const deltaMs = Math.abs(now - t);
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return past ? "just now" : "in under a minute";
  if (minutes < 60) return past ? `${minutes}m ago` : `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return past ? `${hours}h ago` : `in ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return past ? `${days}d ago` : `in ${days}d`;
  return formatUserDate(iso);
}

/**
 * AN ELAPSED SPAN, IN WORDS.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `describeRelativeTime`
 * ---------------------------------------------------------------------------
 * That function turns an INSTANT into "how long ago". This turns a MEASURED
 * DURATION into words. They look similar and they are not interchangeable: a
 * source that reports "the last telemetry sample is 902 minutes old" has given
 * a number, not a timestamp, and the number is what the threshold is compared
 * against. Converting it back into an instant so it could be re-subtracted
 * would introduce a second, slightly different clock reading and make the
 * displayed age disagree with the one the server thresholded.
 *
 * The literal `902m` was reaching operators inside a condition title. Nobody
 * reads fifteen hours out of nine hundred and two minutes on the way past.
 *
 * Two units, never three. "15h 2m" is legible; "15h 2m 30s" is a stopwatch,
 * and the precision is false anyway — the underlying sample is a whole number
 * of minutes.
 */
export function describeDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.floor(seconds);
  if (total < 60) return "under a minute";
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) {
    return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}
