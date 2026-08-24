/**
 * THE INCIDENT SLA CYCLE AUTHORITY.
 *
 * ---------------------------------------------------------------------------
 * ONE PLACE THAT DECIDES WHAT WAS PROMISED
 * ---------------------------------------------------------------------------
 * Every write to `OperationalIncidentSlaCycle` happens here, and every read of
 * an incident's SLA posture is derived from what this module persisted. The
 * previous implementation derived posture per read from the workspace's
 * CURRENT policy, which meant a policy edit rewrote history: tightening a
 * window retroactively breached conditions nobody could have saved, and
 * loosening it erased breaches that really happened. Both were measured
 * against a live database before this was written.
 *
 * ---------------------------------------------------------------------------
 * THE PROMISE IS COPIED, NOT REFERENCED
 * ---------------------------------------------------------------------------
 * A cycle stores BOTH the immutable policy version that governed it AND a copy
 * of the resolved targets and deadlines. The copy is the load-bearing half:
 * reading targets back through the version would be correct today and fragile
 * the first time version resolution changed, and the entire point is that this
 * answer must not depend on anything that can move later.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NEVER INVENTED
 * ---------------------------------------------------------------------------
 * No cycle row  -> the condition predates this authority. UNTRACKED_LEGACY.
 * Cycle, no targets -> the workspace had no policy when it qualified.
 *                      NOT_APPLICABLE.
 *
 * Neither is backfilled and neither is guessed. A promise nobody recorded
 * cannot be recovered, and a deadline invented after the fact would be
 * indistinguishable from a real one while being false.
 */

import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { resolveEffectiveSlaPolicy } from "../reviewer-ops/sla-policy.service.js";

const HOUR_MS = 3_600_000;

/** The reason a cycle stopped running. */
export type SlaCycleEndReason = "RESOLVED" | "SUPPRESSED" | "REOPENED";

// ===========================================================================
// POLICY VERSIONS
// ===========================================================================

type PolicyHours = {
  assignmentHours: number;
  firstReviewHours: number;
  completionHours: number;
  escalationHours: number;
  dueSoonHours: number;
};

/**
 * The identity of a set of hours.
 *
 * Content-addressed rather than sequential, so a workspace that changes a
 * value and changes it back resolves to the SAME version instead of
 * accumulating rows that differ in nothing an incident could care about.
 * Field ORDER is fixed here rather than taken from object iteration, because
 * a digest whose value depends on key order is a digest that changes for no
 * reason.
 */
export function policyDigest(hours: PolicyHours): string {
  const canonical = [
    hours.assignmentHours,
    hours.firstReviewHours,
    hours.completionHours,
    hours.escalationHours,
    hours.dueSoonHours,
  ].join(":");
  return createHash("sha256").update(`sla-v1:${canonical}`).digest("hex");
}

/**
 * Resolve (or create) the immutable version carrying the workspace's CURRENT
 * hours.
 *
 * Called when a condition qualifies and when the policy is edited. It never
 * updates a row: the unique key is (team, digest), so a concurrent caller
 * either wins the insert or reads back the row the other one wrote.
 */
export async function resolveCurrentPolicyVersion(
  input: { teamId: string; actorUserId?: string | null },
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.WorkspaceSlaPolicyVersion | null> {
  let hours: PolicyHours;
  try {
    const resolved = await resolveEffectiveSlaPolicy({ teamId: input.teamId }, client);
    hours = {
      assignmentHours: resolved.policy.assignmentHours,
      firstReviewHours: resolved.policy.firstReviewHours,
      completionHours: resolved.policy.completionHours,
      escalationHours: resolved.policy.escalationHours,
      dueSoonHours: resolved.policy.dueSoonHours,
    };
  } catch {
    // A policy that cannot be read produces NO version, which produces a cycle
    // with no targets, which reports NOT_APPLICABLE. Substituting defaults
    // here would record a promise the workspace never made.
    return null;
  }

  // A workspace that has never configured governance still resolves to the
  // shared defaults. Those are a fallback for REVIEW work and are not a
  // promise this workspace published, so they are NOT recorded as one.
  const configured = await client.workspaceGovernancePolicy
    .findUnique({ where: { teamId: input.teamId } })
    .catch(() => null);
  const hasOwnSlaPolicy =
    configured != null &&
    (configured.defaultFirstResponseDueHours != null ||
      configured.defaultCompletionDueHours != null ||
      configured.defaultDueSoonHours != null);
  if (!hasOwnSlaPolicy) return null;

  const digest = policyDigest(hours);
  const existing = await client.workspaceSlaPolicyVersion.findUnique({
    where: { teamId_digest: { teamId: input.teamId, digest } },
  });
  if (existing) return existing;

  try {
    return await client.workspaceSlaPolicyVersion.create({
      data: {
        teamId: input.teamId,
        digest,
        ...hours,
        effectiveFromUtc: new Date(),
        createdByUserId: input.actorUserId ?? null,
      },
    });
  } catch {
    // Lost the insert race. The winner's row is the same content by
    // construction, so reading it back is not a fallback — it is the answer.
    return client.workspaceSlaPolicyVersion.findUnique({
      where: { teamId_digest: { teamId: input.teamId, digest } },
    });
  }
}

// ===========================================================================
// CYCLE LIFECYCLE
// ===========================================================================

/**
 * Open the SLA cycle for a condition that has just qualified.
 *
 * Idempotent by the (incident, cycleNumber) unique key: two writers racing to
 * open the same cycle collide in the database rather than recording two
 * promises for one condition.
 */
export async function openSlaCycle(
  input: {
    teamId: string;
    incidentId: string;
    severity: string;
    startedAtUtc: Date;
    actorUserId?: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  // A live cycle already exists — this is a re-fire of a condition that is
  // still open, not a new qualification. The promise does not restart.
  const live = await client.operationalIncidentSlaCycle.findFirst({
    where: { incidentId: input.incidentId, endedAtUtc: null },
  });
  if (live) return;

  const last = await client.operationalIncidentSlaCycle.findFirst({
    where: { incidentId: input.incidentId },
    orderBy: { cycleNumber: "desc" },
  });
  const cycleNumber = (last?.cycleNumber ?? 0) + 1;

  const version = await resolveCurrentPolicyVersion(
    { teamId: input.teamId, actorUserId: input.actorUserId },
    client,
  );

  const targets = version
    ? {
        acknowledgementTargetHours: version.firstReviewHours,
        resolutionTargetHours: version.completionHours,
        dueSoonHours: version.dueSoonHours,
        acknowledgementDueAtUtc: new Date(
          input.startedAtUtc.getTime() + version.firstReviewHours * HOUR_MS,
        ),
        resolutionDueAtUtc: new Date(
          input.startedAtUtc.getTime() + version.completionHours * HOUR_MS,
        ),
      }
    : {
        // No policy: a cycle is still recorded, because "we looked and there
        // was no commitment" is a different and more useful fact than having
        // no row at all.
        acknowledgementTargetHours: null,
        resolutionTargetHours: null,
        dueSoonHours: null,
        acknowledgementDueAtUtc: null,
        resolutionDueAtUtc: null,
      };

  await client.operationalIncidentSlaCycle
    .create({
      data: {
        teamId: input.teamId,
        incidentId: input.incidentId,
        cycleNumber,
        policyVersionId: version?.id ?? null,
        policyDigest: version?.digest ?? null,
        severityAtStart: input.severity,
        startedAtUtc: input.startedAtUtc,
        ...targets,
      },
    })
    .catch(() => {
      /* lost the race; the winner recorded the same promise */
    });
}

/**
 * Latch whichever obligations are already past their deadline.
 *
 * Called before every lifecycle transition so a breach is recorded at the
 * moment it is observed rather than being inferred later from a clock that
 * has moved on. Once true these never go back to false — that is the whole
 * reason they are columns and not a computation.
 */
async function latchBreaches(
  cycle: prismaPkg.OperationalIncidentSlaCycle,
  now: Date,
  client: PrismaClient,
): Promise<prismaPkg.OperationalIncidentSlaCycle> {
  const ackBreached =
    cycle.acknowledgementBreached ||
    (cycle.acknowledgedAtUtc === null &&
      cycle.acknowledgementDueAtUtc !== null &&
      now.getTime() > cycle.acknowledgementDueAtUtc.getTime());
  const resBreached =
    cycle.resolutionBreached ||
    (cycle.resolvedAtUtc === null &&
      cycle.resolutionDueAtUtc !== null &&
      now.getTime() > cycle.resolutionDueAtUtc.getTime());

  if (
    ackBreached === cycle.acknowledgementBreached &&
    resBreached === cycle.resolutionBreached
  ) {
    return cycle;
  }
  return client.operationalIncidentSlaCycle.update({
    where: { id: cycle.id },
    data: {
      acknowledgementBreached: ackBreached,
      resolutionBreached: resBreached,
      version: { increment: 1 },
    },
  });
}

async function liveCycle(
  incidentId: string,
  client: PrismaClient,
): Promise<prismaPkg.OperationalIncidentSlaCycle | null> {
  return client.operationalIncidentSlaCycle.findFirst({
    where: { incidentId, endedAtUtc: null },
    orderBy: { cycleNumber: "desc" },
  });
}

/** Acknowledgement stops the ACKNOWLEDGEMENT clock. Resolution keeps running. */
export async function recordSlaAcknowledgement(
  input: { incidentId: string; at?: Date },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  const now = input.at ?? new Date();
  const cycle = await liveCycle(input.incidentId, client);
  if (!cycle || cycle.acknowledgedAtUtc) return;
  const latched = await latchBreaches(cycle, now, client);
  await client.operationalIncidentSlaCycle.update({
    where: { id: latched.id },
    data: { acknowledgedAtUtc: now, version: { increment: 1 } },
  });
}

/** Resolution closes the cycle. The record of what was promised survives. */
export async function closeSlaCycle(
  input: {
    incidentId: string;
    reason: SlaCycleEndReason;
    at?: Date;
  },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  const now = input.at ?? new Date();
  const cycle = await liveCycle(input.incidentId, client);
  if (!cycle) return;
  const latched = await latchBreaches(cycle, now, client);
  await client.operationalIncidentSlaCycle.update({
    where: { id: latched.id },
    data: {
      ...(input.reason === "RESOLVED" ? { resolvedAtUtc: now } : {}),
      endedAtUtc: now,
      endReason: input.reason,
      version: { increment: 1 },
    },
  });
}

/**
 * Suppression latches whatever has already happened and stops the clock.
 *
 * It does NOT delete the breach flags. Silencing a condition is an instruction
 * about notification; it is not a way to un-miss a deadline, and a system that
 * treated it as one would let any workspace clear its own SLA record.
 */
export async function suppressSlaCycle(
  input: { incidentId: string; at?: Date },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  await closeSlaCycle({ ...input, reason: "SUPPRESSED" }, client);
}

/**
 * Severity changed while a cycle is live.
 *
 * ESCALATION may TIGHTEN the deadline and never extend it: a condition that
 * became more urgent cannot thereby buy more time. DE-ESCALATION changes
 * nothing at all — the workspace already made a promise about this condition,
 * and relabelling it afterwards is not a renegotiation. Neither direction
 * clears a breach that has already been latched.
 */
export async function escalateIncidentSeverity(
  input: {
    incidentId: string;
    teamId: string;
    severity: string;
    at?: Date;
  },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  const now = input.at ?? new Date();
  const cycle = await liveCycle(input.incidentId, client);
  if (!cycle) return;

  const latched = await latchBreaches(cycle, now, client);

  // Recorded either way, so the cycle's severity reflects what the condition
  // actually is; only the DEADLINE is protected from moving outward.
  await client.operationalIncidentSlaCycle.update({
    where: { id: latched.id },
    data: { severityAtStart: input.severity, version: { increment: 1 } },
  });

  await client.operationalIncident
    .updateMany({
      where: { id: input.incidentId, teamId: input.teamId },
      data: { severity: input.severity as never },
    })
    .catch(() => null);
}
