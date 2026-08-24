/**
 * THE INCIDENT SLA PROJECTION — one authority, read from persisted history.
 *
 * ---------------------------------------------------------------------------
 * WHAT QUESTION THIS ANSWERS
 * ---------------------------------------------------------------------------
 * A queue can say a condition is CRITICAL and three days old without saying
 * whether anyone was ever supposed to have looked at it. Age is an
 * observation; lateness is a judgement against a commitment. Without the
 * second, every operator invents their own threshold and a workspace cannot
 * report on what it promised.
 *
 * ---------------------------------------------------------------------------
 * IT READS HISTORY; IT DOES NOT RECOMPUTE IT
 * ---------------------------------------------------------------------------
 * The targets and deadlines come from the `OperationalIncidentSlaCycle` that
 * `incident-sla-cycle.service.ts` persisted when the condition qualified —
 * NOT from the workspace's current policy. That distinction is the entire
 * closure: deriving from the live policy was measured to flip an existing
 * ON_TRACK condition to BREACHED when the policy tightened, and to erase a
 * real breach when it loosened.
 *
 * The only thing this module takes from the present is the clock.
 *
 * ---------------------------------------------------------------------------
 * IT FAILS CLOSED
 * ---------------------------------------------------------------------------
 * No cycle           -> UNTRACKED_LEGACY. The condition predates this
 *                       authority; nobody recorded a promise about it.
 * Cycle, no targets  -> NOT_APPLICABLE. The workspace had no policy when the
 *                       condition qualified.
 * Nonsensical targets-> NOT_APPLICABLE. A stored promise that cannot be
 *                       trusted is not measured against.
 *
 * None of those is counted as a breach, and none of them is repaired by
 * substituting today's numbers. A promise nobody recorded cannot be
 * recovered, and inventing one would be indistinguishable from a real one
 * while being false.
 */

import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";

/**
 * THE closed vocabulary. Every consumer — row, drawer, summary, filter, sort,
 * accessibility copy — speaks exactly these seven values and no others.
 */
export const SLA_POSTURES = [
  /** No promise was ever recorded for this condition. */
  "UNTRACKED_LEGACY",
  /** A cycle exists but the workspace had no policy, or it cannot be trusted. */
  "NOT_APPLICABLE",
  /** Inside the live window. */
  "ON_TRACK",
  /** Inside the window, within the workspace's own warning lead time. */
  "AT_RISK",
  /** A promise in this cycle was missed. Latched: it never un-breaches. */
  "BREACHED",
  /** Someone has it, and no promise has been missed. */
  "ACKNOWLEDGED",
  /** The cycle closed by the condition actually being resolved. */
  "RESOLVED",
] as const;

export type SlaPosture = (typeof SLA_POSTURES)[number];

/** Which commitment the live posture is measured against. */
export type SlaObligation = "ACKNOWLEDGEMENT" | "RESOLUTION" | "NONE";

export type IncidentSlaProjection = {
  posture: SlaPosture;
  obligation: SlaObligation;
  /** The deadline this posture was measured against. Null when none applies. */
  dueAtUtc: string | null;
  /** Hours the workspace committed to for the LIVE obligation. */
  targetHours: number | null;
  /**
   * The immutable policy version that governed this cycle, so a reader can
   * tell that two conditions were judged against different promises.
   */
  policyVersionId: string | null;
  /** Which occurrence this is. 1 unless the condition has reopened. */
  cycleNumber: number | null;
  /** Latched facts, kept even after the posture moves on. */
  acknowledgementBreached: boolean;
  resolutionBreached: boolean;
};

/** The projection for a condition that has no recorded promise. */
const UNTRACKED: IncidentSlaProjection = {
  posture: "UNTRACKED_LEGACY",
  obligation: "NONE",
  dueAtUtc: null,
  targetHours: null,
  policyVersionId: null,
  cycleNumber: null,
  acknowledgementBreached: false,
  resolutionBreached: false,
};

const HOUR_MS = 3_600_000;

/**
 * Postures that mean "this needs attention on time grounds".
 *
 * Exported so the queue's filter, the summary's counters and the row's badge
 * ask the SAME question. Three inline predicates would drift, and a count that
 * disagrees with the list it summarises is worse than no count.
 *
 * RESOLVED is excluded because it is an outcome, not work. UNTRACKED_LEGACY
 * and NOT_APPLICABLE are excluded because no promise exists to be behind on —
 * counting them would manufacture failures out of missing records.
 */
export const SLA_ATTENTION_POSTURES: ReadonlySet<SlaPosture> = new Set<SlaPosture>([
  "BREACHED",
  "AT_RISK",
]);

/**
 * The posture of one condition. Pure over (cycle, incident status, now), so
 * every case is testable against fixed instants rather than against whatever
 * the clock said during a run.
 */
export function projectIncidentSla(
  incidentStatus: string,
  cycle: prismaPkg.OperationalIncidentSlaCycle | null,
  now: Date,
): IncidentSlaProjection {
  // No recorded promise. Deliberately not measured against today's policy.
  if (!cycle) return UNTRACKED;

  const latched = {
    policyVersionId: cycle.policyVersionId,
    cycleNumber: cycle.cycleNumber,
    acknowledgementBreached: cycle.acknowledgementBreached,
    resolutionBreached: cycle.resolutionBreached,
  };

  const ackTarget = cycle.acknowledgementTargetHours;
  const resTarget = cycle.resolutionTargetHours;

  // A cycle with no targets, or with targets that cannot be believed, is not
  // measured. A negative or zero window is not a strict promise — it is a
  // corrupt row, and treating it as a promise would report a breach the
  // instant the condition opened.
  const ackDue = cycle.acknowledgementDueAtUtc;
  const resDue = cycle.resolutionDueAtUtc;

  if (
    ackTarget === null ||
    resTarget === null ||
    ackTarget <= 0 ||
    resTarget <= 0 ||
    ackDue === null ||
    resDue === null
  ) {
    return {
      ...UNTRACKED,
      ...latched,
      posture: "NOT_APPLICABLE",
    };
  }

  // Suppression is a deliberate instruction to stop reporting. The latched
  // breach flags travel with the projection so the record survives, but the
  // workspace is not told it is behind on something it silenced.
  if (incidentStatus === "SUPPRESSED" || cycle.endReason === "SUPPRESSED") {
    return {
      posture: "NOT_APPLICABLE",
      obligation: "NONE",
      dueAtUtc: null,
      targetHours: null,
      ...latched,
    };
  }

  // The condition was actually fixed. Whether it was fixed in time is the
  // latched fact, not the posture.
  if (cycle.resolvedAtUtc !== null || cycle.endReason === "RESOLVED") {
    return {
      posture: "RESOLVED",
      obligation: "NONE",
      dueAtUtc: resDue.toISOString(),
      targetHours: resTarget,
      ...latched,
    };
  }

  const acknowledged = cycle.acknowledgedAtUtc !== null;
  const obligation: SlaObligation = acknowledged ? "RESOLUTION" : "ACKNOWLEDGEMENT";
  const due = acknowledged ? resDue : ackDue;
  const targetHours = acknowledged ? resTarget : ackTarget;
  const at = now.getTime();

  // BREACH WINS, and it wins over acknowledgement.
  //
  // A latched breach keeps the condition BREACHED for the rest of the cycle:
  // acknowledging something late does not make it on time, and a surface that
  // reported ACKNOWLEDGED there would let every missed promise be cleared by
  // clicking one button.
  if (
    cycle.acknowledgementBreached ||
    cycle.resolutionBreached ||
    at > due.getTime()
  ) {
    return {
      posture: "BREACHED",
      obligation,
      dueAtUtc: due.toISOString(),
      targetHours,
      ...latched,
    };
  }

  const leadMs = (cycle.dueSoonHours ?? 0) * HOUR_MS;
  if (due.getTime() - at <= leadMs) {
    return {
      posture: "AT_RISK",
      obligation,
      dueAtUtc: due.toISOString(),
      targetHours,
      ...latched,
    };
  }

  return {
    posture: acknowledged ? "ACKNOWLEDGED" : "ON_TRACK",
    obligation,
    dueAtUtc: due.toISOString(),
    targetHours,
    ...latched,
  };
}

/**
 * Load the live cycle for a page of conditions in ONE query.
 *
 * A read per row would issue one query per condition to answer a question the
 * database can answer once. The map is keyed by incident id and holds the
 * MOST RECENT cycle, live or closed — a resolved condition still has a
 * posture, and it comes from the cycle that closed.
 */
export async function loadSlaCycles(
  input: { teamId: string; incidentIds: ReadonlyArray<string> },
  client: PrismaClient = defaultPrisma,
): Promise<Map<string, prismaPkg.OperationalIncidentSlaCycle>> {
  const out = new Map<string, prismaPkg.OperationalIncidentSlaCycle>();
  if (input.incidentIds.length === 0) return out;

  const rows = await client.operationalIncidentSlaCycle
    .findMany({
      where: { teamId: input.teamId, incidentId: { in: [...input.incidentIds] } },
      orderBy: { cycleNumber: "asc" },
    })
    .catch(() => [] as prismaPkg.OperationalIncidentSlaCycle[]);

  // Ascending order means the LAST write per incident wins, which is the
  // highest cycle number — the occurrence the operator is looking at.
  for (const row of rows) out.set(row.incidentId, row);
  return out;
}
