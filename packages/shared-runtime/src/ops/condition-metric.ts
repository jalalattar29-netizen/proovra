/**
 * THE CONDITION METRIC SNAPSHOT.
 *
 * ---------------------------------------------------------------------------
 * WHAT WENT WRONG
 * ---------------------------------------------------------------------------
 * The number an aggregate condition is ABOUT lived in its title:
 *
 *     "Report backlog above threshold (26)"
 *
 * `recordIncident` never rewrote the title on re-observation, so 26 was
 * written once and then frozen. A workspace that worked its backlog down to 22
 * kept reading 26 — for as long as the condition existed, which for a
 * persistent backlog is indefinitely. Nothing anywhere could tell an operator
 * that the number they were looking at was stale, because nothing knew it was
 * a number at all.
 *
 * Two further consequences followed from the same cause. The title was also
 * the only place the value existed, so the grouped queue showed
 * `affectedCount: 1` — one INCIDENT — beside a title claiming 26, and the two
 * quantities were rendered as if they were the same kind of thing. And a
 * severity computed from the frozen number could not be recalculated, so a
 * backlog that crossed the CRITICAL threshold after the condition opened kept
 * its original posture.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS
 * ---------------------------------------------------------------------------
 * A small, strictly-decoded structured snapshot, persisted beside the
 * condition and REWRITTEN on every successful observation. Titles become
 * stable and count-free; the number lives here, where it can be refreshed,
 * compared with its previous value, and marked stale when an observation
 * fails.
 *
 * STALENESS IS RECORDED, NOT INFERRED. When a probe cannot read its source the
 * previous snapshot is KEPT and flagged — it is not replaced with zero, and it
 * is not deleted. Zero would read as recovery, which is the single most
 * dangerous thing an operations surface can say when it does not know.
 *
 * The codec is strict in both directions: anything that is not exactly this
 * shape decodes to null rather than to a partially-trusted object, because a
 * half-read metric rendered as a fact is worse than no metric at all.
 */

/** What the value counts. Bounded so nothing free-form reaches a browser. */
export const CONDITION_METRIC_UNITS = [
  "records",
  "workflows",
  "items",
  "conditions",
  "minutes",
] as const;
export type ConditionMetricUnit = (typeof CONDITION_METRIC_UNITS)[number];

export type ConditionMetricSnapshot = {
  /** What the source counted at `observedAtUtc`. */
  readonly currentValue: number;
  /** The value the previous successful observation recorded, if there was one. */
  readonly previousValue: number | null;
  /** currentValue - previousValue, or null when there is no previous. */
  readonly delta: number | null;
  /** At or above this, the condition is active. */
  readonly thresholdValue: number;
  /** At or above this, the condition is CRITICAL. Null when there is no tier. */
  readonly criticalThresholdValue: number | null;
  readonly unit: ConditionMetricUnit;
  /** ISO-8601. When the value was actually observed, not when it was read. */
  readonly observedAtUtc: string;
  /**
   * True when the LAST attempt to observe this source failed.
   *
   * The values above are then the last ones successfully observed, and every
   * surface must say so rather than presenting them as current.
   */
  readonly stale: boolean;
  /** True when the underlying read was bounded and the value is a floor. */
  readonly truncated: boolean;
  /** What the value counts, for the drill-down. Bounded vocabulary. */
  readonly affectedEntityType: string | null;
};

function isFiniteInt(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v);
}

/**
 * Decode a persisted snapshot. Null for anything that is not exactly one.
 *
 * Deliberately total and deliberately unforgiving: a row written by an older
 * image, a hand-edited JSON blob and a corrupted value all decode to null, and
 * a null metric renders as no metric. There is no partial acceptance, because
 * a snapshot missing its threshold would render "26 affected" with no way to
 * say what 26 is being compared against.
 */
export function decodeConditionMetric(
  raw: unknown,
): ConditionMetricSnapshot | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!isFiniteInt(o.currentValue) || o.currentValue < 0) return null;
  if (!isFiniteInt(o.thresholdValue) || o.thresholdValue < 0) return null;
  if (typeof o.observedAtUtc !== "string") return null;
  if (Number.isNaN(Date.parse(o.observedAtUtc))) return null;
  if (
    typeof o.unit !== "string" ||
    !(CONDITION_METRIC_UNITS as readonly string[]).includes(o.unit)
  ) {
    return null;
  }
  const previousValue =
    o.previousValue == null
      ? null
      : isFiniteInt(o.previousValue)
        ? o.previousValue
        : null;
  const criticalThresholdValue =
    o.criticalThresholdValue == null
      ? null
      : isFiniteInt(o.criticalThresholdValue)
        ? o.criticalThresholdValue
        : null;
  return Object.freeze({
    currentValue: o.currentValue,
    previousValue,
    delta: previousValue == null ? null : o.currentValue - previousValue,
    thresholdValue: o.thresholdValue,
    criticalThresholdValue,
    unit: o.unit as ConditionMetricUnit,
    observedAtUtc: new Date(o.observedAtUtc).toISOString(),
    stale: o.stale === true,
    truncated: o.truncated === true,
    affectedEntityType:
      typeof o.affectedEntityType === "string"
        ? o.affectedEntityType.slice(0, 64)
        : null,
  });
}

/**
 * Build the snapshot a successful observation should persist.
 *
 * `previous` is the snapshot already on the row, so `previousValue` and
 * `delta` describe a real transition rather than being recomputed by whoever
 * renders them. A previous snapshot that was STALE still supplies the previous
 * value: the value was real when it was observed, and its staleness described
 * the read that failed after it, not the value itself.
 */
export function buildConditionMetric(input: {
  currentValue: number;
  thresholdValue: number;
  criticalThresholdValue?: number | null;
  unit: ConditionMetricUnit;
  observedAtUtc: Date;
  truncated?: boolean;
  affectedEntityType?: string | null;
  previous?: ConditionMetricSnapshot | null;
}): ConditionMetricSnapshot {
  const previousValue = input.previous ? input.previous.currentValue : null;
  return Object.freeze({
    currentValue: Math.max(0, Math.trunc(input.currentValue)),
    previousValue,
    delta:
      previousValue == null
        ? null
        : Math.max(0, Math.trunc(input.currentValue)) - previousValue,
    thresholdValue: Math.max(0, Math.trunc(input.thresholdValue)),
    criticalThresholdValue:
      input.criticalThresholdValue == null
        ? null
        : Math.max(0, Math.trunc(input.criticalThresholdValue)),
    unit: input.unit,
    observedAtUtc: input.observedAtUtc.toISOString(),
    stale: false,
    truncated: input.truncated === true,
    affectedEntityType: input.affectedEntityType ?? null,
  });
}

/**
 * The snapshot to persist when an observation FAILED.
 *
 * The last successful values, flagged. Never zeroed, never dropped, and the
 * observation time is deliberately NOT advanced — it still says when the
 * numbers were true, which is the whole point of keeping them.
 */
export function markConditionMetricStale(
  previous: ConditionMetricSnapshot | null,
): ConditionMetricSnapshot | null {
  if (!previous) return null;
  if (previous.stale) return previous;
  return Object.freeze({ ...previous, stale: true });
}

/**
 * The severity tier a metric currently sits in.
 *
 * Returned as a bounded word rather than an `IncidentSeverity` so this module
 * stays free of the incident vocabulary; the writer maps it. Recomputed on
 * every observation, which is what stops a condition that has since crossed
 * the critical threshold from keeping the posture it opened with.
 */
export function metricPosture(
  metric: ConditionMetricSnapshot,
): "BELOW_THRESHOLD" | "AT_THRESHOLD" | "CRITICAL" {
  if (
    metric.criticalThresholdValue != null &&
    metric.currentValue >= metric.criticalThresholdValue
  ) {
    return "CRITICAL";
  }
  return metric.currentValue >= metric.thresholdValue
    ? "AT_THRESHOLD"
    : "BELOW_THRESHOLD";
}

/**
 * A bounded, operator-facing rendering of the value.
 *
 * Enterprise workspaces can carry five-digit backlogs, and a row is not the
 * place for an exact five-digit number that will be wrong by the time it is
 * read. Above the cap the value is presented as a floor — `2,000+` — and the
 * exact figure remains available in the Inspector and the API for a caller who
 * is authorized to see it.
 */
export const METRIC_DISPLAY_CAP = 2000;

export function formatMetricValue(
  value: number,
  cap: number = METRIC_DISPLAY_CAP,
): string {
  if (value > cap) return `${cap.toLocaleString("en-US")}+`;
  return value.toLocaleString("en-US");
}
