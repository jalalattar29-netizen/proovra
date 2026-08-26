/**
 * THE GROUPED OPERATIONS QUEUE PROJECTION.
 *
 * THE PROBLEM
 * -----------
 * Thirty-four Evidence records that each failed to be timestamped produce
 * thirty-four conditions. That is correct and is not negotiable — see
 * `evidence-integrity-correlation.ts`, where the "merge duplicate TSA
 * failures" finding is permanently retracted. Ten records that cannot be
 * proven are ten records that cannot be proven; collapsing them makes nine
 * invisible, and an invisible unprovable record is the worst failure available
 * on an evidence platform.
 *
 * But thirty-four visually identical rows is not a queue an operator can work
 * either. The first screen of Operations becomes one repeated sentence, and
 * every other condition in the workspace is pushed off it.
 *
 * THE DISTINCTION THIS MODULE RESTS ON
 * ------------------------------------
 * There are two different operations being confused when people say
 * "grouping":
 *
 *   1. CAUSAL MERGING — asserting that these failures ARE one incident, and
 *      giving them one lifecycle. That requires positive evidence of shared
 *      causation (a provider incident id, a batch id, a run id), it is what
 *      `deriveParentCorrelation` governs, and reason / filename / provider /
 *      workspace / date are permanently forbidden as inputs to it.
 *
 *   2. PRESENTATION GROUPING — arranging conditions that already exist into a
 *      queue a person can read, without changing any of them.
 *
 * This module does ONLY the second. It is a pure read-side projection:
 *
 *   * It never writes. No incident is created, merged, resolved, suppressed or
 *     re-fingerprinted by anything here.
 *   * Every per-record condition keeps its own id, fingerprint, severity,
 *     acknowledgement, assignment, SLA cycle and history. Drill-down reaches
 *     the individual record, and that is where action happens.
 *   * Closing a group is not an operation. A group stops existing when the
 *     last active condition in it stops being active — which happens because
 *     each RECORD recovered, one at a time.
 *
 * Because of that separation, this projection MAY use the failure class as a
 * sub-grouping key even though causal merging may not. Saying "of these 34, 30
 * are provider timeouts and 4 are digest failures" is a description of a set
 * that stays fully enumerable; it asserts nothing about why, and it takes
 * nothing away.
 */

import type { IncidentCategory } from "@proovra/shared";

import {
  classifyIntegrityFailure,
  describeFailureClass,
  type IntegrityFailureClass,
} from "./evidence-integrity-severity.js";
import {
  conditionDisplayLabel,
  lifecycleForSourceId,
  offersManualResolution,
  resolveConditionSource,
  UNREGISTERED_CONDITION_LIFECYCLE,
  type ConditionMetricSnapshot,
} from "@proovra/shared-runtime";

/** One condition, as the projection needs to see it. */
export type GroupableCondition = {
  id: string;
  category: IncidentCategory;
  fingerprint: string;
  severity: string;
  status: string;
  title: string;
  safeSummary: string;
  firstSeenAtUtc: Date;
  lastSeenAtUtc: Date;
  occurrenceCount: number;
  relatedEvidenceId: string | null;
  assignedOperatorUserId: string | null;
  /** The persisted machine-readable failure reason, when the domain has one. */
  failureReasonCode?: string | null;
  /**
   * The condition's current metric snapshot, for a source that carries one.
   *
   * THE WHOLE SNAPSHOT, not just its value. The value alone was enough to
   * answer "how many", and it was the reason a group could not answer
   * "how many of WHAT, and compared with what" — so a telemetry condition
   * whose value is 902 MINUTES was summed into a field called
   * `affectedRecordCount` and rendered as nine hundred and two affected
   * records. The unit and the threshold travel with the number now.
   */
  metric?: ConditionMetricSnapshot | null;
  /**
   * The condition's DECLARED source, when the row carries one.
   *
   * This is the grouping dimension now. It used to be
   * `category + parseIntegrityFingerprint(...)`, which grouped the two
   * integrity classes correctly and collapsed every other category into one
   * "default" bucket — so a report-generation failure, a package denial and a
   * governance escalation all became one group called GOVERNANCE.
   */
  sourceId?: string | null;
};

/** A record inside a group. Bounded, and never carrying provider error text. */
export type AffectedRecord = {
  conditionId: string;
  evidenceId: string | null;
  severity: string;
  status: string;
  firstSeenAtUtc: string;
  lastSeenAtUtc: string;
  assigned: boolean;
};

export type FailureGroupBreakdown = {
  /** Machine-readable class. Never a raw provider string. */
  failureClass: IntegrityFailureClass | "UNGROUPED";
  /** Operator-readable label for the class. */
  label: string;
  count: number;
};

export type OperationsConditionGroup = {
  /**
   * Deterministic identity for the group.
   *
   * A pure function of (category, grouping dimension) — never of the member
   * list, never of a timestamp, never of an ordering. The same workspace state
   * produces the same key on every read, and one record recovering changes the
   * group's COUNT without changing its identity, so a UI can keep a group
   * expanded across a refresh.
   */
  groupKey: string;
  /** The registered source every member belongs to. The grouping dimension. */
  sourceId: string;
  category: IncidentCategory;
  /** The one sentence that describes the whole group. */
  title: string;
  /**
   * HOW MANY CONDITIONS ARE IN THE GROUP.
   *
   * Renamed from `affectedCount`, which was true for per-record groups and
   * false for every other kind — and the false case was the one that mattered.
   * A report-backlog group has exactly ONE member and stands for twenty-six
   * evidence records, so a field called `affectedCount` returning 1 sat beside
   * a title claiming 26 with nothing to say they were different quantities.
   *
   * This is the number the CONSERVATION property is about: the sum of
   * `conditionCount` across groups equals the number of input conditions.
   */
  conditionCount: number;
  /**
   * HOW MANY REAL RECORDS THE GROUP STANDS FOR, or null when unknowable.
   *
   * A different question, answered differently per cardinality:
   *
   *   PER_RECORD           each condition IS one record, so it equals
   *                        conditionCount;
   *   AGGREGATE_THRESHOLD  the members' current metric values, summed — the
   *                        honest answer to "how many things are behind this";
   *   otherwise            null.
   *
   * AN AGE IS NOT A POPULATION. The previous rule was "everything that is not
   * EVIDENCE_INTEGRITY uses the summed metric", which swept in the two
   * AGE_THRESHOLD sources, whose value is a number of MINUTES. A sampler
   * fifteen hours behind was rendered as "902 affected records". Cardinality
   * and metric contract decide this now, and an age-based group answers null
   * here and carries `durationSeconds` instead.
   *
   * NULL IS A REAL ANSWER and must render as an absence, never as zero.
   */
  affectedRecordCount: number | null;
  /**
   * WHAT THE AFFECTED COUNT COUNTS. Null whenever that count is null.
   *
   * The retry-storm source counts CONDITIONS, not records: thirty-six
   * repeatedly-observed conditions is a true sentence and "36 affected
   * records" is not. The unit travels with the number so no renderer has to
   * assume one.
   */
  affectedUnit: string | null;
  /**
   * HOW MANY TIMES THE SOURCE WAS OBSERVED TO STILL BE TRUE.
   *
   * The members' occurrence counts, summed. A THIRD quantity, distinct from
   * both numbers above: four re-observations of one backlog of twenty-six
   * records is 4, 1 and 26, and the queue used to render all three the same
   * way. Rendered as "observed in N checks" and never as "occurrences", which
   * named nothing.
   */
  observations: number;
  /**
   * HOW OLD THE AGE-BASED MEASUREMENT IS, in seconds, or null.
   *
   * Present only for an AGE_THRESHOLD source, where the metric's value IS an
   * elapsed time. Carried in seconds — a unit — so the browser can render
   * "15h 2m" rather than the raw "902m" that used to sit inside a title.
   */
  durationSeconds: number | null;
  /** The instant the group's metric was last successfully observed, or null. */
  lastObservedAtUtc: string | null;
  /** Highest severity present, so the group sorts by its worst member. */
  severity: string;
  /** Earliest first-seen across members: how long this has been true. */
  firstSeenAtUtc: string;
  /** Latest last-seen: whether it is still happening. */
  lastSeenAtUtc: string;
  /** How many members somebody has taken. */
  assignedCount: number;
  /** Sub-counts by failure class. Description, never causal assertion. */
  failureGroups: FailureGroupBreakdown[];
  /**
   * A BOUNDED sample of affected records, for the inspector.
   *
   * Bounded because a group can contain every record in a workspace and an
   * unbounded expansion is a denial of service aimed at the operator's own
   * browser. `conditionCount` is the full number; this is a page of it, and
   * `hasMoreAffected` says so rather than letting the shorter list read as the
   * total.
   */
  affectedSample: AffectedRecord[];
  hasMoreAffected: boolean;
  /**
   * The most recent activity across the group's members.
   *
   * What an operator sorts a long queue by: "is this still happening?" is
   * answered by the LATEST member, not by the group's oldest.
   */
  latestActivityAtUtc: string;
  /**
   * The group's overall lifecycle posture.
   *
   * OPEN if any member is open; ACKNOWLEDGED if every unresolved member is
   * owned; SUPPRESSED if every one is silenced. A group is not "resolved"
   * while one member still is not.
   */
  statusPosture: string;
  /**
   * WHAT MAY BE DONE TO THE WHOLE GROUP, from the source contract.
   *
   * The same projection a single row gets, applied once per group — so a
   * grouped queue cannot offer an action the individual conditions inside it
   * would refuse. Capability is applied by the ROUTE on top of this; these are
   * the actions the SOURCE permits.
   */
  availableActions: string[];
  /**
   * THE GROUP'S CURRENT METRIC, whole.
   *
   * It used to be `{ currentValue, unit: "records" }` with the unit HARD-CODED,
   * so every aggregate group claimed to be counting records — including the
   * one counting minutes and the one counting conditions. The unit and the
   * thresholds are the source's now, and `stale` says when the last
   * observation failed so the values are not presented as current.
   */
  metric: {
    currentValue: number;
    unit: string;
    thresholdValue: number;
    criticalThresholdValue: number | null;
    observedAtUtc: string;
    stale: boolean;
    /** NONE, AGGREGATE_THRESHOLD or AGE_THRESHOLD. What the value MEANS. */
    contract: string;
  } | null;
};

/**
 * How many members of a group are returned inline.
 *
 * Small on purpose. The inspector's job is to make the group concrete and give
 * the operator a way in; the full list is a paginated drill-down, not a
 * payload.
 */
export const AFFECTED_SAMPLE_LIMIT = 10;

const SEVERITY_RANK: Record<string, number> = {
  CRITICAL: 4,
  HIGH: 3,
  WARNING: 2,
  INFO: 1,
};

function severityRank(s: string): number {
  return SEVERITY_RANK[s] ?? 0;
}

/**
 * The grouping dimension for one condition.
 *
 * EVIDENCE_INTEGRITY groups by its integrity class (`tsa_failure`,
 * `ots_failure`), which is the part of the fingerprint that is NOT the record
 * id — so every per-record condition keeps its own fingerprint and the group
 * is derived, not stored.
 *
 * Every other category groups by category alone. Those are already one
 * workspace-level condition each, so grouping is a no-op that keeps the shape
 * of the list uniform rather than special-casing the renderer.
 */
function groupDimensionFor(condition: GroupableCondition): string {
  // THE SOURCE IS THE DIMENSION. Resolved through the canonical authority —
  // declared id first, legacy fingerprint second — so a row written before
  // `source_id` existed lands in the same group as its modern twin instead of
  // in a "default" bucket beside three unrelated conditions.
  const { lifecycle } = resolveConditionSource({
    sourceId: condition.sourceId,
    category: condition.category,
    fingerprint: condition.fingerprint,
  });
  return lifecycle.sourceId;
}

/**
 * THE ONE SENTENCE THAT DESCRIBES A WHOLE GROUP — WITHOUT A COUNT IN IT.
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS HERE, AND WHY IT WENT
 * ---------------------------------------------------------------------------
 * A table of eight builders, each producing a sentence with the member count
 * baked into it: "Trusted timestamping failed for 34 records". Two problems,
 * one visible and one not.
 *
 * The visible one: the count then appeared TWICE in the same row, once inside
 * the title and once in a labelled field beside it, and the two were different
 * quantities whenever the group was aggregate — a title saying 26 next to a
 * member count of 1.
 *
 * The invisible one: the table was a SECOND naming authority. It covered eight
 * of the thirty-five sources; every other group fell back to its first
 * member's stored title, so a report-generation group of forty read as one
 * record's failure. And it could disagree with the label the flat list used
 * for the very same source.
 *
 * There is now one name per source, declared with the source, count-free, and
 * enforced count-free by a load-time invariant. This function reads it.
 */
function titleForGroup(
  members: readonly GroupableCondition[],
  resolved: ReturnType<typeof resolveConditionSource>,
): string {
  // An unregistered source has no declared label; its members' stored titles
  // are the only description that exists, and a group of them says it once.
  return conditionDisplayLabel(resolved, members[0].title);
}

/**
 * Project a flat list of conditions into the grouped queue.
 *
 * PURE. Same input, same output, no clock, no database, no ordering
 * dependence — which is what lets the conservation properties be tested by
 * enumeration rather than by fixture.
 *
 * CONSERVATION, which the tests pin:
 *   * every input condition appears in exactly one group;
 *   * the sum of `conditionCount` equals the number of input conditions;
 *   * no condition is dropped for having an unrecognised fingerprint —
 *     it falls into its category's default group rather than vanishing.
 */
export function projectConditionGroups(
  conditions: readonly GroupableCondition[],
  options: { sampleLimit?: number } = {},
): OperationsConditionGroup[] {
  const sampleLimit = Math.max(1, options.sampleLimit ?? AFFECTED_SAMPLE_LIMIT);
  const buckets = new Map<string, GroupableCondition[]>();

  for (const condition of conditions) {
    // The source id IS the key. It used to be `${category}:${dimension}`,
    // parsed back apart with `split(":")` — which a source id like
    // `pipeline.report_backlog` survives and `upload:security_event` would
    // not. Keying on the id directly removes the round trip entirely.
    const key = groupDimensionFor(condition);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(condition);
    else buckets.set(key, [condition]);
  }

  const groups: OperationsConditionGroup[] = [];
  for (const [groupKey, members] of buckets) {
    const sourceId = groupKey;
    const lifecycle = lifecycleForSourceId(sourceId) ?? UNREGISTERED_CONDITION_LIFECYCLE;
    const category = members[0].category;
    // Resolved once more for the LABEL. Every member of a group resolves to
    // the same source by construction — that is what made the group — so the
    // first member's resolution is the group's.
    const resolved = resolveConditionSource({
      sourceId: members[0].sourceId,
      category: members[0].category,
      fingerprint: members[0].fingerprint,
    });

    let worst = members[0];
    let firstSeen = members[0].firstSeenAtUtc;
    let lastSeen = members[0].lastSeenAtUtc;
    let assignedCount = 0;
    const classCounts = new Map<IntegrityFailureClass | "UNGROUPED", number>();

    for (const m of members) {
      if (severityRank(m.severity) > severityRank(worst.severity)) worst = m;
      if (m.firstSeenAtUtc < firstSeen) firstSeen = m.firstSeenAtUtc;
      if (m.lastSeenAtUtc > lastSeen) lastSeen = m.lastSeenAtUtc;
      if (m.assignedOperatorUserId !== null) assignedCount += 1;

      // Sub-grouping is DESCRIPTIVE. A record whose reason we cannot classify
      // is counted as UNGROUPED rather than guessed into a class — an
      // invented cause is worse than an admitted unknown.
      const cls: IntegrityFailureClass | "UNGROUPED" =
        category === "EVIDENCE_INTEGRITY" && m.failureReasonCode
          ? classifyIntegrityFailure(m.failureReasonCode)
          : "UNGROUPED";
      classCounts.set(cls, (classCounts.get(cls) ?? 0) + 1);
    }

    // THE SAME SENTENCE WHETHER THE GROUP HOLDS ONE MEMBER OR FIVE THOUSAND.
    //
    // There used to be a special case here: a group of one rendered its
    // member's stored title instead of the group heading, on the reasoning
    // that "a group of one IS its condition". That was true of the OLD
    // headings, which counted — "…for 1 record" reads like a summary of
    // several. It is not true of a count-free label, and keeping the special
    // case would have meant a source's row changing its wording the moment a
    // second condition appeared, and changing back when it recovered.
    const derivedTitle = titleForGroup(members, resolved);

    const sorted = [...members].sort((a, b) => {
      const bySeverity = severityRank(b.severity) - severityRank(a.severity);
      if (bySeverity !== 0) return bySeverity;
      return a.firstSeenAtUtc.getTime() - b.firstSeenAtUtc.getTime();
    });

    // -------------------------------------------------------------------
    // THE THREE NUMBERS, EACH COMPUTED ONLY WHERE IT MEANS SOMETHING.
    // -------------------------------------------------------------------
    // A group can carry up to three quantities and they are routinely
    // different: for a report backlog they are 1 CONDITION, 26 AFFECTED
    // RECORDS and 4 OBSERVATIONS. Rendering any of them under another's name
    // is how a queue lies, so each is computed separately or not at all.
    //
    // `metricContract` decides which apply, because the source is the only
    // thing that knows what its number counts. The previous rule — "every
    // category except EVIDENCE_INTEGRITY sums the metric into
    // affectedRecordCount" — swept in the two AGE_THRESHOLD sources, whose
    // value is minutes, and reported an elapsed time as a population.
    const withMetric = members.filter(
      (m): m is GroupableCondition & { metric: ConditionMetricSnapshot } =>
        m.metric != null,
    );
    // The freshest observation represents the group's unit and thresholds.
    // For every aggregate source in the product a group has exactly one
    // member — the fingerprint is the workspace — so this is a single row in
    // practice; summing the VALUE anyway keeps the projection total if that
    // ever stops being true, while a summed THRESHOLD would be meaningless.
    const representative = withMetric.reduce<ConditionMetricSnapshot | null>(
      (best, m) =>
        best == null || m.metric.observedAtUtc > best.observedAtUtc
          ? m.metric
          : best,
      null,
    );
    const metricTotal =
      withMetric.length === 0
        ? null
        : withMetric.reduce((sum, m) => sum + m.metric.currentValue, 0);

    const contract = lifecycle.metricContract;
    const observations = members.reduce(
      (sum, m) => sum + (Number.isFinite(m.occurrenceCount) ? m.occurrenceCount : 0),
      0,
    );

    // PER_RECORD: each condition IS one record, and that is true of every
    // per-record source rather than of one category. AGGREGATE_THRESHOLD: the
    // counted population, in its OWN unit — the retry-storm source counts
    // conditions, not records. Anything else: null, rendered as an absence.
    const affectedRecordCount =
      lifecycle.cardinality === "PER_RECORD"
        ? members.length
        : contract === "AGGREGATE_THRESHOLD"
          ? metricTotal
          : null;
    const affectedUnit =
      affectedRecordCount == null
        ? null
        : lifecycle.cardinality === "PER_RECORD"
          ? "records"
          : (representative?.unit ?? "records");

    // AN AGE, EXPRESSED AS A DURATION. The AGE_THRESHOLD sources measure in
    // whole minutes; seconds is the unit a renderer can turn into "15h 2m"
    // without knowing which source it came from.
    const durationSeconds =
      contract === "AGE_THRESHOLD" &&
      representative != null &&
      representative.unit === "minutes"
        ? Math.max(0, Math.round(metricTotal ?? 0) * 60)
        : null;

    // The group's posture, from its members. A group with one open member is
    // open: an operator who has acknowledged nine of ten records has not dealt
    // with the tenth, and a group that claimed otherwise would hide it.
    const statuses = new Set(members.map((m) => m.status));
    const statusPosture = statuses.has("OPEN")
      ? "OPEN"
      : statuses.has("ACKNOWLEDGED")
        ? "ACKNOWLEDGED"
        : statuses.has("SUPPRESSED")
          ? "SUPPRESSED"
          : "RESOLVED";

    // The actions the SOURCE permits. Capability is layered on by the route;
    // this is what the contract allows before anyone's permissions are read.
    // Resolve is deliberately absent for everything but OPERATOR_DECISION, and
    // there is no bulk Resolve at all — recovery closes source-truth
    // conditions, so a bulk control would be unsafe and unnecessary.
    const availableActions = [
      "acknowledge",
      "assign",
      "suppress",
      ...(offersManualResolution(lifecycle) ? ["resolve"] : []),
    ];

    groups.push({
      groupKey,
      sourceId,
      latestActivityAtUtc: lastSeen.toISOString(),
      statusPosture,
      availableActions,
      metric:
        metricTotal != null && representative != null && contract !== "NONE"
          ? {
              currentValue: metricTotal,
              // THE SOURCE'S UNIT, not a hard-coded "records".
              unit: representative.unit,
              thresholdValue: representative.thresholdValue,
              criticalThresholdValue: representative.criticalThresholdValue,
              observedAtUtc: representative.observedAtUtc,
              stale: representative.stale,
              contract,
            }
          : null,
      category,
      title: derivedTitle,
      conditionCount: members.length,
      affectedRecordCount,
      affectedUnit,
      observations,
      durationSeconds,
      lastObservedAtUtc: representative?.observedAtUtc ?? null,
      severity: worst.severity,
      firstSeenAtUtc: firstSeen.toISOString(),
      lastSeenAtUtc: lastSeen.toISOString(),
      assignedCount,
      failureGroups: [...classCounts.entries()]
        .map(([failureClass, count]) => ({
          failureClass,
          label:
            failureClass === "UNGROUPED"
              ? "Reason not classified"
              : describeFailureClass(failureClass),
          count,
        }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
      affectedSample: sorted.slice(0, sampleLimit).map((m) => ({
        conditionId: m.id,
        evidenceId: m.relatedEvidenceId,
        severity: m.severity,
        status: m.status,
        firstSeenAtUtc: m.firstSeenAtUtc.toISOString(),
        lastSeenAtUtc: m.lastSeenAtUtc.toISOString(),
        assigned: m.assignedOperatorUserId !== null,
      })),
      hasMoreAffected: members.length > sampleLimit,
    });
  }

  // Worst first, then longest-standing. Deterministic to the last tiebreak so
  // two reads of one workspace state produce the same order.
  return groups.sort((a, b) => {
    const bySeverity = severityRank(b.severity) - severityRank(a.severity);
    if (bySeverity !== 0) return bySeverity;
    const byAge = a.firstSeenAtUtc.localeCompare(b.firstSeenAtUtc);
    if (byAge !== 0) return byAge;
    return a.groupKey.localeCompare(b.groupKey);
  });
}

/**
 * Total CONDITIONS represented by a set of groups.
 *
 * Exists so conservation is CHECKABLE at any boundary that consumes groups,
 * rather than being a property somebody has to remember to preserve.
 *
 * Deliberately NOT the affected-record total. Conservation is a statement
 * about conditions — every input appears in exactly one group — and summing a
 * quantity that is null for some groups and a live metric for others would not
 * conserve anything.
 */
export function totalConditions(
  groups: readonly OperationsConditionGroup[],
): number {
  return groups.reduce((sum, g) => sum + g.conditionCount, 0);
}
