/**
 * RELEASING THE WORK A DEPARTED PERSON HELD (members re-audit 2, B1 / B9).
 *
 * Ending a workspace membership ended its standing reach (standing-reach.ts:
 * case access, case assignments, Collaboration Team membership) but left the
 * person holding their WORK: review workflows, open escalations, Team tasks,
 * Operations ownership, QC samples and evidence-request reviews all still
 * named them. Work held by somebody who can no longer open the workspace looks
 * owned and is not — invisibly stuck, where an unassigned item is visibly
 * waiting and reaches the people who hand work out.
 *
 * RELEASE = UNASSIGN. Nothing is cancelled, closed or deleted: the item goes
 * back to the pool it came from (a review back to the queue, a task back to
 * OPEN for its group), and its own history records who held it and why they
 * stopped. The person's past decisions, verdicts and events are untouched.
 *
 * One module, called inside the departure's own transaction by the canonical
 * departure path (`endStandingReachForMembers`), and — for the one group a
 * member leaves — by the Collaboration Team member removal and suspension.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

import { emitTenantAudit } from "../audit/tenant-audit.service.js";

export type ReleaseTx = Pick<
  PrismaClient,
  | "evidenceReviewWorkflow"
  | "evidenceReviewWorkflowEvent"
  | "reviewEscalation"
  | "collaborationTeamAssignment"
  | "collaborationTeamActivity"
  | "collaborationTeam"
  | "operationalWorkflow"
  | "operationalWorkflowEvent"
  | "operationalIncident"
  | "operationalIncidentEvent"
  | "qcSample"
  | "evidenceRequest"
  | "evidenceRequestEvent"
  | "reviewerDisagreement"
  | "caseSiuProfile"
>;

/** Why the work is released — recorded on every history row it writes. */
export type ReleaseReason =
  | "member_removed"
  | "member_suspended"
  | "member_left"
  | "membership_ended"
  | "group_member_removed"
  | "group_member_suspended";

export type ReleasedWork = {
  reviewWorkflows: number;
  escalations: number;
  teamTasks: number;
  operationsWorkflows: number;
  incidents: number;
  qcSamples: number;
  evidenceRequests: number;
  disagreements: number;
  siuAssignments: number;
};

/** Review states that are finished work — history, not held work. */
const FINISHED_REVIEW_STATUSES = ["CLOSED", "REJECTED_INSUFFICIENT", "APPROVED_INTERNAL"] as const;
const FINISHED_ESCALATION_STATUSES = ["RESOLVED", "SUPPRESSED"];
/** A Team task that is still live (every non-terminal state of the task machine). */
const LIVE_TEAM_TASK_STATUSES = ["OPEN", "IN_PROGRESS", "REASSIGNED"];
const FINISHED_OPERATIONS_STATUSES = ["RESOLVED", "SUPPRESSED", "FAILED"] as const;
const LIVE_INCIDENT_STATUSES = ["OPEN", "ACKNOWLEDGED"] as const;
const LIVE_QC_STATES = ["SAMPLED", "ASSIGNED"];
const FINISHED_REQUEST_STATUSES = ["FULFILLED", "CANCELLED", "CLOSED"] as const;

const NOTE: Record<ReleaseReason, string> = {
  member_removed: "Released: the assignee was removed from the workspace.",
  member_suspended: "Released: the assignee's workspace access was suspended.",
  member_left: "Released: the assignee left the workspace.",
  membership_ended: "Released: the assignee's workspace membership ended.",
  group_member_removed: "Released: the assignee was removed from this Collaboration Team.",
  group_member_suspended: "Released: the assignee was suspended in this Collaboration Team.",
};

/**
 * Release the open Team tasks `userIds` hold — in ONE group when
 * `collaborationTeamId` is given (B9: removal or suspension from that group),
 * otherwise in every group of the workspace (a workspace departure). The task
 * goes back to OPEN with no assignee, for the group's Lead to hand on; each one
 * is recorded on the group's timeline as a reassignment to nobody.
 */
export async function releaseTeamTasksTx(
  tx: Pick<ReleaseTx, "collaborationTeamAssignment" | "collaborationTeamActivity" | "collaborationTeam">,
  input: {
    workspaceId: string;
    userIds: readonly string[];
    collaborationTeamId?: string;
    actorUserId: string | null;
    reason: ReleaseReason;
  },
): Promise<number> {
  if (input.userIds.length === 0) return 0;
  const tasks = await tx.collaborationTeamAssignment.findMany({
    where: {
      workspaceId: input.workspaceId,
      ...(input.collaborationTeamId ? { teamId: input.collaborationTeamId } : {}),
      assigneeUserId: { in: [...input.userIds] },
      status: { in: LIVE_TEAM_TASK_STATUSES },
    },
    select: { id: true, teamId: true, status: true, assigneeUserId: true },
  });
  let released = 0;
  const touchedGroups = new Set<string>();
  for (const task of tasks) {
    // Guarded: a task that moved on meanwhile is not rewritten.
    const written = await tx.collaborationTeamAssignment.updateMany({
      where: { id: task.id, status: task.status, assigneeUserId: task.assigneeUserId },
      data: { assigneeUserId: null, status: "OPEN" },
    });
    if (written.count === 0) continue;
    released += 1;
    touchedGroups.add(task.teamId);
    await tx.collaborationTeamActivity.create({
      data: {
        teamId: task.teamId,
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        eventType: "ASSIGNMENT_REASSIGNED",
        targetType: "ASSIGNMENT",
        targetId: task.id,
        metadata: {
          assignmentId: task.id,
          assigneeUserId: null,
          previousAssigneeUserId: task.assigneeUserId,
          previousStatus: task.status,
          reason: input.reason,
        } as Prisma.InputJsonValue,
      },
    });
  }
  // The group's activity order is its row's `updatedAt` (CT-13).
  if (touchedGroups.size > 0) {
    await tx.collaborationTeam.updateMany({
      where: { id: { in: [...touchedGroups] } },
      data: { updatedAt: new Date() },
    });
  }
  return released;
}

/**
 * Release everything `userIds` hold in workspace `teamId`. Runs inside the
 * departure's transaction; writes one tenant audit row per person who held
 * anything, with what was released.
 */
export async function releaseWorkHeldByTx(
  tx: ReleaseTx,
  input: { teamId: string; userIds: readonly string[]; actorUserId: string | null; reason: ReleaseReason },
): Promise<Map<string, ReleasedWork>> {
  const now = new Date();
  const note = NOTE[input.reason];
  const userIds = [...input.userIds];
  const perUser = new Map<string, ReleasedWork>();
  const bucket = (userId: string): ReleasedWork => {
    let b = perUser.get(userId);
    if (!b) {
      b = {
        reviewWorkflows: 0,
        escalations: 0,
        teamTasks: 0,
        operationsWorkflows: 0,
        incidents: 0,
        qcSamples: 0,
        evidenceRequests: 0,
        disagreements: 0,
        siuAssignments: 0,
      };
      perUser.set(userId, b);
    }
    return b;
  };
  if (userIds.length === 0) return perUser;

  // 1. Review workflows — back to the queue, with an UNASSIGNED event.
  const workflows = await tx.evidenceReviewWorkflow.findMany({
    where: {
      teamId: input.teamId,
      assignedToUserId: { in: userIds },
      status: { notIn: [...FINISHED_REVIEW_STATUSES] },
    },
    select: { id: true, evidenceId: true, status: true, assignedToUserId: true },
  });
  for (const wf of workflows) {
    const nextStatus = wf.status === "ASSIGNED" ? "QUEUED" : wf.status;
    const written = await tx.evidenceReviewWorkflow.updateMany({
      where: { id: wf.id, assignedToUserId: wf.assignedToUserId, status: wf.status },
      data: { assignedToUserId: null, status: nextStatus },
    });
    if (written.count === 0) continue;
    bucket(wf.assignedToUserId!).reviewWorkflows += 1;
    await tx.evidenceReviewWorkflowEvent.create({
      data: {
        workflowId: wf.id,
        evidenceId: wf.evidenceId,
        actorUserId: input.actorUserId,
        eventType: "UNASSIGNED",
        previousValue: { assignedToUserId: wf.assignedToUserId, status: wf.status } as Prisma.InputJsonValue,
        nextValue: { assignedToUserId: null, status: nextStatus, reason: input.reason } as Prisma.InputJsonValue,
        note,
      },
    });
  }

  // 2. Open escalations — unassigned, so they reach the owners and admins.
  const escalations = await tx.reviewEscalation.findMany({
    where: {
      teamId: input.teamId,
      assignedToUserId: { in: userIds },
      status: { notIn: FINISHED_ESCALATION_STATUSES },
    },
    select: { id: true, assignedToUserId: true },
  });
  for (const e of escalations) {
    const written = await tx.reviewEscalation.updateMany({
      where: { id: e.id, assignedToUserId: e.assignedToUserId },
      data: { assignedToUserId: null },
    });
    if (written.count > 0) bucket(e.assignedToUserId!).escalations += 1;
  }

  // 3. Team tasks — every group of the workspace.
  for (const userId of userIds) {
    const n = await releaseTeamTasksTx(tx, {
      workspaceId: input.teamId,
      userIds: [userId],
      actorUserId: input.actorUserId,
      reason: input.reason,
    });
    if (n > 0) bucket(userId).teamTasks += n;
  }

  // 4. Operations workflows — ownerless again; an ASSIGNED one is OPEN again.
  const opsWorkflows = await tx.operationalWorkflow.findMany({
    where: {
      teamId: input.teamId,
      assignedOwnerUserId: { in: userIds },
      status: { notIn: [...FINISHED_OPERATIONS_STATUSES] },
    },
    select: { id: true, status: true, assignedOwnerUserId: true },
  });
  for (const w of opsWorkflows) {
    const toStatus = w.status === "ASSIGNED" ? "OPEN" : w.status;
    const written = await tx.operationalWorkflow.updateMany({
      where: { id: w.id, assignedOwnerUserId: w.assignedOwnerUserId, status: w.status },
      data: { assignedOwnerUserId: null, assignedByUserId: null, assignedAtUtc: null, status: toStatus },
    });
    if (written.count === 0) continue;
    bucket(w.assignedOwnerUserId!).operationsWorkflows += 1;
    await tx.operationalWorkflowEvent.create({
      data: {
        workflowId: w.id,
        teamId: input.teamId,
        eventType: "STATUS_CHANGED",
        actorUserId: input.actorUserId,
        fromStatus: w.status,
        toStatus,
        summary: note,
        metadataJson: { previousOwnerUserId: w.assignedOwnerUserId, reason: input.reason } as Prisma.InputJsonValue,
      },
    });
  }

  // 5. Operations incidents (conditions) — the same "unassigned" event an
  //    operator's unassign writes.
  const incidents = await tx.operationalIncident.findMany({
    where: {
      teamId: input.teamId,
      assignedOperatorUserId: { in: userIds },
      status: { in: [...LIVE_INCIDENT_STATUSES] },
    },
    select: { id: true, assignedOperatorUserId: true },
  });
  for (const i of incidents) {
    const written = await tx.operationalIncident.updateMany({
      where: { id: i.id, assignedOperatorUserId: i.assignedOperatorUserId },
      data: { assignedOperatorUserId: null, assignedByUserId: null, assignedAtUtc: null },
    });
    if (written.count === 0) continue;
    bucket(i.assignedOperatorUserId!).incidents += 1;
    await tx.operationalIncidentEvent.create({
      data: {
        incidentId: i.id,
        eventType: "unassigned",
        safeMessage: note,
        metadataJson: { previousAssigneeUserId: i.assignedOperatorUserId, reason: input.reason } as Prisma.InputJsonValue,
      },
    });
  }

  // 6. QC samples not yet judged — back to SAMPLED, for another QC reviewer.
  const samples = await tx.qcSample.findMany({
    where: {
      teamId: input.teamId,
      state: { in: LIVE_QC_STATES },
      OR: [{ qcReviewerUserId: { in: userIds } }, { assignedToUserId: { in: userIds } }],
    },
    select: { id: true, qcReviewerUserId: true, assignedToUserId: true },
  });
  for (const s of samples) {
    const holder = userIds.includes(s.qcReviewerUserId ?? "") ? s.qcReviewerUserId! : s.assignedToUserId!;
    const written = await tx.qcSample.updateMany({
      where: { id: s.id, state: { in: LIVE_QC_STATES } },
      data: {
        ...(userIds.includes(s.qcReviewerUserId ?? "") ? { qcReviewerUserId: null, assignedAtUtc: null, state: "SAMPLED" } : {}),
        ...(userIds.includes(s.assignedToUserId ?? "") ? { assignedToUserId: null } : {}),
      },
    });
    if (written.count > 0) bucket(holder).qcSamples += 1;
  }

  // 7. Evidence Requests still in flight — the assigned reviewer is cleared.
  const requests = await tx.evidenceRequest.findMany({
    where: {
      teamId: input.teamId,
      assignedReviewerUserId: { in: userIds },
      status: { notIn: [...FINISHED_REQUEST_STATUSES] },
    },
    select: { id: true, assignedReviewerUserId: true },
  });
  for (const r of requests) {
    const written = await tx.evidenceRequest.updateMany({
      where: { id: r.id, assignedReviewerUserId: r.assignedReviewerUserId },
      data: { assignedReviewerUserId: null },
    });
    if (written.count === 0) continue;
    bucket(r.assignedReviewerUserId!).evidenceRequests += 1;
    await tx.evidenceRequestEvent.create({
      data: {
        evidenceRequestId: r.id,
        eventType: "EVIDENCE_REQUEST_UNASSIGNED",
        actorUserId: input.actorUserId,
        payload: {
          assignedReviewerUserId: null,
          previousAssignedReviewerUserId: r.assignedReviewerUserId,
          reason: input.reason,
        } as Prisma.InputJsonValue,
      },
    });
  }

  // 8. Open disagreements — the departed second reviewer or supervisor no
  // longer holds the stage: it returns to the stage before they took it
  // (FILED, or UNDER_SECOND_REVIEW), for someone eligible to take again.
  const disputes = await tx.reviewerDisagreement.findMany({
    where: {
      teamId: input.teamId,
      OR: [
        { state: "UNDER_SECOND_REVIEW", secondReviewerUserId: { in: userIds } },
        { state: "UNDER_SUPERVISOR_REVIEW", supervisorUserId: { in: userIds } },
      ],
    },
    select: { id: true, state: true, secondReviewerUserId: true, supervisorUserId: true },
  });
  for (const d of disputes) {
    const atSecond = d.state === "UNDER_SECOND_REVIEW";
    const holder = atSecond ? d.secondReviewerUserId! : d.supervisorUserId!;
    const written = await tx.reviewerDisagreement.updateMany({
      where: { id: d.id, state: d.state },
      data: atSecond
        ? { state: "FILED", secondReviewerUserId: null }
        : { state: "UNDER_SECOND_REVIEW", supervisorUserId: null },
    });
    if (written.count > 0) bucket(holder).disagreements += 1;
  }

  // 9. SIU profiles — the departed adjuster or SIU reviewer is cleared.
  const adjusted = await tx.caseSiuProfile.findMany({
    where: { teamId: input.teamId, assignedAdjusterUserId: { in: userIds } },
    select: { id: true, assignedAdjusterUserId: true },
  });
  for (const profile of adjusted) {
    const written = await tx.caseSiuProfile.updateMany({
      where: { id: profile.id, assignedAdjusterUserId: profile.assignedAdjusterUserId },
      data: { assignedAdjusterUserId: null },
    });
    if (written.count > 0) bucket(profile.assignedAdjusterUserId!).siuAssignments += 1;
  }
  const reviewed = await tx.caseSiuProfile.findMany({
    where: { teamId: input.teamId, assignedSiuReviewerUserId: { in: userIds } },
    select: { id: true, assignedSiuReviewerUserId: true },
  });
  for (const profile of reviewed) {
    const written = await tx.caseSiuProfile.updateMany({
      where: { id: profile.id, assignedSiuReviewerUserId: profile.assignedSiuReviewerUserId },
      data: { assignedSiuReviewerUserId: null },
    });
    if (written.count > 0) bucket(profile.assignedSiuReviewerUserId!).siuAssignments += 1;
  }

  // One audit row per person who held anything: what was released, and why.
  for (const [userId, released] of perUser) {
    await emitTenantAudit(
      {
        action: "workspace.member.work_released",
        outcome: "success",
        sourceApp: "API",
        actorUserId: input.actorUserId,
        workspaceId: input.teamId,
        resourceType: "user",
        resourceId: userId,
        metadata: { subjectUserId: userId, reason: input.reason, releasedAtUtc: now.toISOString(), ...released },
      },
      tx as unknown as PrismaClient,
    );
  }
  return perUser;
}
