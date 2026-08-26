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
import { parseIntegrityFingerprint } from "./evidence-integrity-conditions.service.js";

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
   * The condition's current aggregate value, for a source that carries one.
   *
   * Present ONLY for AGGREGATE conditions, where one condition stands for many
   * records. It is what makes `affectedRecordCount` below answerable for a
   * group whose member count is 1 and whose real population is 26.
   */
  metricCurrentValue?: number | null;
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
   *   PER_RECORD  each condition IS one record, so it equals conditionCount;
   *   AGGREGATE   the members' current metric values, summed — the honest
   *               answer to "how many records are behind this";
   *   otherwise   null, and the surface says nothing rather than printing the
   *               member count under a name that would claim more.
   *
   * NULL IS A REAL ANSWER and must render as an absence, never as zero.
   */
  affectedRecordCount: number | null;
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
  if (condition.category === "EVIDENCE_INTEGRITY") {
    const parsed = parseIntegrityFingerprint(condition.fingerprint);
    if (parsed) return parsed.integrityClass;
  }
  return "default";
}

function titleFor(category: IncidentCategory, dimension: string, count: number): string {
  if (category === "EVIDENCE_INTEGRITY") {
    if (dimension === "tsa_failure") {
      return count === 1
        ? "Trusted timestamping failed for 1 record"
        : `Trusted timestamping failed for ${count} records`;
    }
    if (dimension === "ots_failure") {
      return count === 1
        ? "Blockchain anchoring failed for 1 record"
        : `Blockchain anchoring failed for ${count} records`;
    }
  }
  return "";
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
    const dimension = groupDimensionFor(condition);
    const key = `${condition.category}:${dimension}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(condition);
    else buckets.set(key, [condition]);
  }

  const groups: OperationsConditionGroup[] = [];
  for (const [groupKey, members] of buckets) {
    const [category, dimension] = groupKey.split(":") as [IncidentCategory, string];

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

    // A single-member group is rendered as the condition itself: its own
    // title, not a manufactured "1 record" heading, which would make one
    // problem read like a summary of several.
    const derivedTitle =
      members.length === 1
        ? members[0].title
        : titleFor(category, dimension, members.length) || members[0].title;

    const sorted = [...members].sort((a, b) => {
      const bySeverity = severityRank(b.severity) - severityRank(a.severity);
      if (bySeverity !== 0) return bySeverity;
      return a.firstSeenAtUtc.getTime() - b.firstSeenAtUtc.getTime();
    });

    // THE SECOND NUMBER, computed only where it can be computed.
    //
    // Per-record conditions ARE their records. Aggregate conditions carry a
    // live metric, and the sum of those metrics is the real population — the
    // number that used to be frozen in a title while a field called
    // `affectedCount` said 1 beside it. Everything else gets null, which the
    // surface renders as an absence rather than as a zero.
    const metricTotal = members.reduce<number | null>((sum, m) => {
      if (typeof m.metricCurrentValue !== "number") return sum;
      return (sum ?? 0) + m.metricCurrentValue;
    }, null);
    const affectedRecordCount =
      category === "EVIDENCE_INTEGRITY" ? members.length : metricTotal;

    groups.push({
      groupKey,
      category,
      title: derivedTitle,
      conditionCount: members.length,
      affectedRecordCount,
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
