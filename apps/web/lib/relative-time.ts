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
