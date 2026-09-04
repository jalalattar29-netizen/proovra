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

export type MetricState =
  | "VALUE"
  | "NOT_MEASURED"
  | "UNKNOWN"
  | "ERROR"
  | "STALE"
  | "PARTIAL"
  | "NOT_APPLICABLE";

export type Metric<T> =
  | { state: "VALUE"; value: T; freshness?: MetricFreshness }
  | { state: "NOT_MEASURED"; value: null; reason: string }
  | { state: "UNKNOWN"; value: null; reason: string }
  | { state: "ERROR"; value: null; reason: string }
  // STALE and PARTIAL carry a real number. They are still not affirmative:
  // see `metricIsAffirmative`.
  | { state: "STALE"; value: T; reason: string; freshness: MetricFreshness }
  | { state: "PARTIAL"; value: T; reason: string; coverage: MetricCoverage }
  | { state: "NOT_APPLICABLE"; value: null; reason: string };

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

// ===========================================================================
// PHASE 2 — THE REST OF THE VOCABULARY, AND THE ENVELOPE THAT SCOPES IT
// ===========================================================================
//
// The four states above answered "did we measure it?". They could not answer
// three questions the Admin audit proved were being answered wrongly:
//
//   STALE           a real measurement exists but is older than its freshness
//                   rule. A worker heartbeat from twenty minutes ago is not a
//                   live worker, and rendering it as current is how a dead
//                   fleet looked healthy.
//   PARTIAL         a bounded read completed. "1,000 rows verified" is not
//                   "the chain is verified", and 25 loaded rows are not a
//                   population total.
//   NOT_APPLICABLE  the metric does not apply to this scope or configuration
//                   — distinct from "not built" and from "not answered".
//
// VALUE is the MEASURED state and ERROR is the UNAVAILABLE state; those are
// the names already on the wire and in `AdminMetric.tsx`, so they keep their
// spelling rather than gaining a synonym. One meaning, one label — which is
// the same rule that forbids two subsystems sharing the word "healthy" while
// meaning different things.

/** Where a number is true OF. A number without this is not yet a fact. */
export type MetricScope =
  | { kind: "PLATFORM" }
  | { kind: "ORGANIZATION"; organizationId: string }
  | { kind: "WORKSPACE"; teamId: string }
  | { kind: "ACCOUNT"; userId: string }
  | { kind: "EVIDENCE_COHORT"; teamId: string | null; cohort: string };

/**
 * The context every metric in one response inherits.
 *
 * Carried once per response rather than repeated on every card: a health
 * evaluation has ONE instant, and the defect this replaces was thirty cards
 * each calling `new Date()` and disagreeing about when "now" was.
 */
export type TruthEnvelope = {
  scope: MetricScope;
  /** One instant for the whole evaluation. Never per-card. */
  evaluatedAtUtc: string;
  /** The measurement window, when the numbers are windowed rather than lifetime. */
  window: { days: number } | { fromUtc: string; toUtc: string } | null;
  /** Identifier of the authority that produced these numbers. */
  source: string;
};

export type MetricFreshness = {
  /** When the underlying signal was actually observed. */
  measuredAtUtc: string;
  /** Older than this and the value is STALE, not current. */
  maxAgeSeconds: number;
};

export type MetricCoverage = {
  /** How many the read actually covered. */
  measured: number;
  /** The population, when it is known exactly. Null when it is not. */
  population: number | null;
  /** The cap that bounded the read. */
  limit: number;
};

export function metricStale<T>(
  value: T,
  freshness: MetricFreshness,
  reason: string,
): Metric<T> {
  return { state: "STALE", value, reason, freshness } as Metric<T>;
}

export function metricPartial<T>(
  value: T,
  coverage: MetricCoverage,
  reason: string,
): Metric<T> {
  return { state: "PARTIAL", value, reason, coverage } as Metric<T>;
}

export function metricNotApplicable<T>(reason: string): Metric<T> {
  return { state: "NOT_APPLICABLE", value: null, reason } as Metric<T>;
}

/**
 * Classify a measurement against its freshness rule.
 *
 * The caller supplies the observation time; this decides whether that counts
 * as current. Freshness is a property of the SIGNAL, not of the request, so a
 * page that re-renders does not make a stale reading fresh.
 */
export function metricWithFreshness<T>(
  value: T,
  freshness: MetricFreshness,
  nowMs: number,
  staleReason: string,
): Metric<T> {
  const ageSeconds = (nowMs - Date.parse(freshness.measuredAtUtc)) / 1000;
  return ageSeconds > freshness.maxAgeSeconds
    ? metricStale(value, freshness, staleReason)
    : ({ state: "VALUE", value, freshness } as Metric<T>);
}

/**
 * TRUE only for a state that may be painted as an all-clear.
 *
 * Every other state — including STALE and PARTIAL, which DO carry a number —
 * must not be rendered green. A stale green light is the specific failure this
 * phase exists to remove.
 */
export function metricIsAffirmative(m: { state: MetricState } | undefined): boolean {
  return m?.state === "VALUE";
}
