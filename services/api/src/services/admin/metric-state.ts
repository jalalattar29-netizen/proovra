/**
 * ADM-024 (2026-08-27) — A FAILED QUERY IS NOT AN UNMEASURED METRIC.
 *
 * THE DEFECT
 * ---------------------------------------------------------------------------
 * `overview.service.ts` wrapped all twenty-five of its queries in
 *
 *     async function safe(fn) { try { return await fn() } catch { return null } }
 *
 * and the page rendered every `null` as "Not measured". So a metric the
 * platform genuinely cannot measure — traffic before any consented page view —
 * and a metric whose query threw because a column was renamed under it looked
 * identical to the operator. The honest-null contract this codebase is careful
 * about everywhere else was, on this one surface, laundering outages into
 * calm-looking prose.
 *
 * The distinction matters most exactly when it is least visible: an admin
 * checking "are payments failing?" during an incident must be able to tell
 * "zero failures" from "I could not ask".
 *
 * THE FOUR STATES
 * ---------------------------------------------------------------------------
 *   VALUE         a real measurement.
 *   NOT_MEASURED  the platform does not model this. Permanent until something
 *                 is built. Carries the reason, which the UI shows.
 *   UNKNOWN       measurable in principle, but not proven this cycle — a
 *                 provider with no live probe in this build. Never "healthy".
 *   ERROR         the query failed. Operator-safe reason only; the technical
 *                 cause goes to the server log, never to the browser.
 *
 * `UNKNOWN` and `NOT_MEASURED` are deliberately separate. "We never built a
 * Twilio probe" and "the Twilio probe did not answer" lead to different
 * actions, and `platform-health.service.ts` already draws that line for service
 * rows; this generalises it to every metric.
 */

export type MetricState = "VALUE" | "NOT_MEASURED" | "UNKNOWN" | "ERROR";

export type Metric<T> =
  | { state: "VALUE"; value: T }
  | { state: "NOT_MEASURED"; value: null; reason: string }
  | { state: "UNKNOWN"; value: null; reason: string }
  | { state: "ERROR"; value: null; reason: string };

export function metricValue<T>(value: T): Metric<T> {
  return { state: "VALUE", value };
}

export function metricNotMeasured<T>(reason: string): Metric<T> {
  return { state: "NOT_MEASURED", value: null, reason };
}

export function metricUnknown<T>(reason: string): Metric<T> {
  return { state: "UNKNOWN", value: null, reason };
}

export function metricError<T>(reason: string): Metric<T> {
  return { state: "ERROR", value: null, reason };
}

/**
 * Run a measurement, classifying a throw as ERROR rather than as an absence.
 *
 * `label` names the metric in the operator-facing reason and in the log line.
 * The caught error is passed to `onError` (the caller's request logger) so the
 * technical cause is captured server-side; the returned reason is a fixed,
 * information-free sentence. A stack trace or a Prisma message must never reach
 * an admin browser — it is the same class of leak as an unsanitised
 * `error.message` in a toast.
 */
export async function measure<T>(
  label: string,
  fn: () => Promise<T>,
  onError?: (err: unknown, label: string) => void,
): Promise<Metric<T>> {
  try {
    return metricValue(await fn());
  } catch (err) {
    onError?.(err, label);
    return metricError(
      `${label} could not be read. The platform recorded the failure; this is not a zero.`,
    );
  }
}

/** The numeric value, or null for every non-VALUE state. Never coerces to 0. */
export function metricNumber(m: Metric<number> | undefined): number | null {
  return m?.state === "VALUE" ? m.value : null;
}

/**
 * Fold a metric into a plain value with an explicit fallback.
 *
 * Deliberately NOT defaulted to `0`. A caller that wants a zero must type the
 * zero, at which point a reviewer can see it and ask whether it is honest —
 * which is the whole failure this module exists to make visible.
 */
export function metricOr<T>(m: Metric<T> | undefined, fallback: T): T {
  return m?.state === "VALUE" ? m.value : fallback;
}
