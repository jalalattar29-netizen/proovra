/**
 * THE INCIDENT SLA AUTHORITY.
 *
 * ---------------------------------------------------------------------------
 * WHAT QUESTION THIS ANSWERS
 * ---------------------------------------------------------------------------
 * A queue can say a condition is CRITICAL and three days old without saying
 * whether anyone was ever supposed to have looked at it. Those are different
 * facts: age is an observation, and lateness is a judgement against a
 * commitment. Without the second, every operator invents their own threshold,
 * and a workspace cannot say what it promised.
 *
 * This resolves ONE posture per condition against the workspace's OWN
 * published SLA policy.
 *
 * ---------------------------------------------------------------------------
 * IT IS NOT A SECOND SLA AUTHORITY
 * ---------------------------------------------------------------------------
 * The hours come from `resolveEffectiveSlaPolicy` — the canonical resolver
 * that already governs reviewer operations, with the same precedence
 * (template > workspace override > env > shared defaults) and the same
 * workspace overrides on `WorkspaceGovernancePolicy`. A workspace that edits
 * its SLA at `/governance/policy` moves incident posture with it, because
 * there is exactly one place where the number lives.
 *
 * Two of the policy's five windows are used, and the mapping is the obvious
 * one rather than a new vocabulary:
 *
 *   firstReviewHours -> RESPONSE.   From first observation to acknowledgement:
 *                                   "somebody has this."
 *   completionHours  -> RESOLUTION. From first observation to resolution:
 *                                   "the condition is gone."
 *   dueSoonHours     -> the warning lead time on whichever is open.
 *
 * `assignmentHours` and `escalationHours` are deliberately unused: neither
 * has a corresponding recorded instant on an incident, and inventing one
 * would be a number that looks measured and is not.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DEADLINE IS DERIVED AND NOT STORED
 * ---------------------------------------------------------------------------
 * There is no column here and no migration, deliberately.
 *
 * A stored deadline would have to be written when the condition opened, and
 * NOTHING was writing one — so every condition that exists today would need a
 * backfill, and a backfill would have to pick a policy that was not in force
 * and stamp it as though it had been. That is the invention this program
 * removes elsewhere; it would be strange to add it here.
 *
 * Deriving from `firstSeenAtUtc` — an instant that WAS observed and recorded —
 * against the policy the workspace publishes NOW yields a statement that is
 * true of the current policy for every condition, historical ones included.
 * When a workspace shortens its SLA, its backlog re-reads against the shorter
 * one, which is what "we now promise four hours" means.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT REFUSES TO SAY
 * ---------------------------------------------------------------------------
 * A suppressed condition has NO posture. Suppression means "stop telling me",
 * and reporting a breach against something the workspace deliberately silenced
 * would make the silencing look broken. Likewise `MET` is only ever claimed
 * from a RECORDED acknowledgement or resolution instant — never inferred from
 * a status whose timestamp is missing.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { resolveEffectiveSlaPolicy } from "../reviewer-ops/sla-policy.service.js";

/**
 * The posture of ONE condition against the workspace's commitment.
 *
 * There is no `UNKNOWN`. Every branch below reaches one of these from
 * recorded instants and the resolved policy, so an absent posture would mean
 * the resolver failed — which is reported as a missing envelope, not as a
 * value that renders like an answer.
 */
export const SLA_POSTURES = [
  /** Inside the window. */
  "ON_TRACK",
  /** Inside the window, but within the workspace's own warning lead time. */
  "DUE_SOON",
  /** Past the window with the obligation still open. */
  "BREACHED",
  /** The obligation was discharged inside the window. */
  "MET",
  /** Discharged, but late. Recorded rather than rounded up to MET. */
  "MET_LATE",
  /** Suppressed: the workspace asked not to be told. */
  "NOT_APPLICABLE",
] as const;

export type SlaPosture = (typeof SLA_POSTURES)[number];

/** Which commitment the posture is measured against. */
export type SlaObligation = "RESPONSE" | "RESOLUTION";

export type IncidentSlaProjection = {
  posture: SlaPosture;
  obligation: SlaObligation;
  /** The deadline this posture was measured against. Null when NOT_APPLICABLE. */
  dueAtUtc: string | null;
  /**
   * Hours the workspace committed to for THIS obligation, so the reader can
   * see the promise and not only the verdict.
   */
  targetHours: number | null;
};

/** The inputs one posture needs. Deliberately only recorded instants. */
export type IncidentSlaInput = {
  status: string;
  firstSeenAtUtc: Date;
  acknowledgedAtUtc: Date | null;
  resolvedAtUtc: Date | null;
};

export type IncidentSlaPolicy = {
  responseHours: number;
  resolutionHours: number;
  dueSoonHours: number;
};

/**
 * Load the workspace's commitment ONCE per request.
 *
 * Resolved per page rather than per row: the policy is a workspace fact, and
 * re-resolving it for every condition would issue one query per row to learn
 * the same number.
 */
export async function loadIncidentSlaPolicy(
  teamId: string,
  client: PrismaClient = defaultPrisma,
): Promise<IncidentSlaPolicy | null> {
  try {
    const resolved = await resolveEffectiveSlaPolicy({ teamId }, client);
    return {
      responseHours: resolved.policy.firstReviewHours,
      resolutionHours: resolved.policy.completionHours,
      dueSoonHours: resolved.policy.dueSoonHours,
    };
  } catch {
    // A policy that cannot be read yields NO posture anywhere, rather than a
    // posture computed from a default the workspace never agreed to. The
    // queue still renders; it simply does not make a claim it cannot support.
    return null;
  }
}

const HOUR_MS = 3_600_000;

/**
 * The posture of one condition. Pure, so it is testable against fixed
 * instants rather than against whatever the clock says during a run.
 */
export function projectIncidentSla(
  incident: IncidentSlaInput,
  policy: IncidentSlaPolicy,
  now: Date,
): IncidentSlaProjection {
  // Suppression is a deliberate instruction to stop reporting. Measuring it
  // anyway would make the workspace's own decision look like a failure.
  if (incident.status === "SUPPRESSED") {
    return {
      posture: "NOT_APPLICABLE",
      obligation: "RESPONSE",
      dueAtUtc: null,
      targetHours: null,
    };
  }

  const opened = incident.firstSeenAtUtc.getTime();

  // ---- Which obligation is live -------------------------------------------
  //
  // Acknowledgement discharges RESPONSE and hands over to RESOLUTION. Both
  // are measured from first observation, not from the previous milestone:
  // an operator who acknowledges late has not thereby bought a fresh window
  // to resolve in, and measuring from acknowledgement would grant exactly
  // that.
  const acknowledged = incident.acknowledgedAtUtc?.getTime() ?? null;
  const resolved = incident.resolvedAtUtc?.getTime() ?? null;

  // A resolved condition answers about RESOLUTION even if it was never
  // separately acknowledged — resolving is a stronger discharge of the same
  // duty, and reporting a response breach on something already fixed would
  // be true but useless.
  if (resolved !== null) {
    const due = opened + policy.resolutionHours * HOUR_MS;
    return {
      posture: resolved <= due ? "MET" : "MET_LATE",
      obligation: "RESOLUTION",
      dueAtUtc: new Date(due).toISOString(),
      targetHours: policy.resolutionHours,
    };
  }

  const obligation: SlaObligation = acknowledged === null ? "RESPONSE" : "RESOLUTION";
  const targetHours =
    obligation === "RESPONSE" ? policy.responseHours : policy.resolutionHours;
  const due = opened + targetHours * HOUR_MS;
  const at = now.getTime();

  // The open obligation. `MET` is never claimed here: the RESPONSE half being
  // discharged does not make the condition met, it makes RESOLUTION the live
  // question, which is what the branch above selected.
  const posture: SlaPosture =
    at > due
      ? "BREACHED"
      : due - at <= policy.dueSoonHours * HOUR_MS
        ? "DUE_SOON"
        : "ON_TRACK";

  return {
    posture,
    obligation,
    dueAtUtc: new Date(due).toISOString(),
    targetHours,
  };
}

/**
 * Postures that mean "this needs attention on time grounds".
 *
 * Exported so the queue's filter, the summary count and any future alert all
 * ask the SAME question. Three separate inline predicates would drift, and a
 * count that disagrees with the list it summarises is worse than no count.
 */
export const SLA_ATTENTION_POSTURES: ReadonlySet<SlaPosture> = new Set<SlaPosture>([
  "BREACHED",
  "DUE_SOON",
]);
