/**
 * STANDING REACH — what a membership leaves behind when it ends.
 *
 * A workspace membership is the root of three kinds of standing reach that
 * live on other tables: a personal entry on a case's access list, an ACTIVE
 * case assignment, and Collaboration Team membership. Ending the membership
 * without ending those left a former member on case access lists and in
 * groups (members audit MEM-01 / ACC-11), so every path that ends a membership
 * — one member (suspend, revoke, remove, leave) or many at once (workspace,
 * organization and account closure) — ends them here, in the same
 * transaction, and nothing is deleted that is history: assignments and group
 * memberships move to their ended states; only the live access-list entry
 * (which IS the grant) is removed.
 *
 * It also RELEASES THE WORK the person held (members re-audit 2, B1): review
 * workflows, open escalations, Team tasks, Operations ownership, QC samples
 * and evidence-request reviews go back to their pools, unassigned, with their
 * history kept and the release audited (assignment/release-held-work.ts).
 *
 * One module, imported by the per-member engine and the mass orchestrator
 * alike, so the two cannot disagree about what "ended" means.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { COLLABORATION_TEAM_ROLES, type Permission } from "@proovra/shared";
import { decideMemberPermission, loadMemberPermissionFacts } from "@proovra/shared-runtime";

import { revokeCreatorShareGrantsTx } from "../sharing/creator-share-grants.js";
import {
  countWorkHeldBy,
  releaseWorkHeldByTx,
  type HeldWorkCounts,
  type ReleasedWork,
  type ReleaseReason,
  type ReleaseTx,
} from "../assignment/release-held-work.js";
import {
  evaluateCaseMutationPermission,
  type CaseAccessRole,
  type CaseAssignmentRole,
  type CaseMutation,
} from "../cases/case-permission.service.js";

type ReachTx = Pick<
  PrismaClient,
  | "caseAccess"
  | "caseAssignment"
  | "collaborationTeamMember"
  | "verificationShareToken"
  | "externalReviewGrant"
  | "workflowIntakeLink"
  // A2-10 — a departing creator's integration keys end with their grants.
  | "apiCredential"
  // B7B-F09 — and the webhooks they configured.
  | "webhookEndpoint"
  | "automationWebhookDestination"
  | "lifecycleWebhookEndpoint"
> &
  ReleaseTx;

export type EndStandingReachOptions = {
  /** Who ended the membership (null: PROOVRA's own act, e.g. a SCIM deprovision). */
  actorUserId?: string | null;
  /** Recorded on every released item's history. */
  reason?: ReleaseReason;
};

export async function endStandingReach(
  tx: ReachTx,
  input: { teamId: string; userId: string },
  options: EndStandingReachOptions = {},
): Promise<void> {
  await endStandingReachForMembers(tx, [input], options);
}

export async function endStandingReachForMembers(
  tx: ReachTx,
  members: ReadonlyArray<{ teamId: string; userId: string }>,
  options: EndStandingReachOptions = {},
): Promise<void> {
  if (members.length === 0) return;
  const now = new Date();
  // Grouped by workspace so a closure of N members is a handful of statements,
  // not N × 3.
  const byWorkspace = new Map<string, string[]>();
  for (const m of members) {
    const list = byWorkspace.get(m.teamId);
    if (list) list.push(m.userId);
    else byWorkspace.set(m.teamId, [m.userId]);
  }
  for (const [teamId, userIds] of byWorkspace) {
    // The work first, while the person's group memberships still say which
    // groups their tasks belong to.
    await releaseWorkHeldByTx(tx, {
      teamId,
      userIds,
      actorUserId: options.actorUserId ?? null,
      reason: options.reason ?? "membership_ended",
    });
    await tx.caseAccess.deleteMany({
      where: { userId: { in: userIds }, case: { teamId } },
    });
    await tx.caseAssignment.updateMany({
      where: { teamId, assignedToUserId: { in: userIds }, status: "ACTIVE" },
      data: { status: "REMOVED", removedAtUtc: now },
    });
    // Members re-audit T-2 — a legacy group membership whose role has no
    // canonical meaning (left for an operator by 20281026001400) cannot be
    // rewritten while it keeps that role: the NOT VALID vocabulary CHECK is
    // evaluated on every UPDATE of the row. Leaving the workspace must never
    // wait on that review, so such a membership closes as REMOVED with the
    // least role, VIEWER, and its original value is kept on the group's
    // timeline. A removed membership grants nothing, whatever its role.
    const legacyRoles = await tx.collaborationTeamMember.findMany({
      where: {
        userId: { in: userIds },
        status: { not: "REMOVED" },
        team: { workspaceId: teamId },
        role: { notIn: [...COLLABORATION_TEAM_ROLES] },
      },
      select: { id: true, teamId: true, userId: true, role: true },
    });
    for (const m of legacyRoles) {
      await tx.collaborationTeamMember.update({
        where: { id: m.id },
        data: { status: "REMOVED", removedAt: now, role: "VIEWER" },
      });
      await tx.collaborationTeamActivity.create({
        data: {
          teamId: m.teamId,
          workspaceId: teamId,
          actorUserId: options.actorUserId ?? null,
          eventType: "MEMBER_REMOVED",
          targetType: "USER",
          targetId: m.userId,
          metadata: {
            reason: options.reason ?? "membership_ended",
            legacyRole: m.role,
            roleRecordedAs: "VIEWER",
          } as Prisma.InputJsonValue,
        },
      });
    }
    await tx.collaborationTeamMember.updateMany({
      where: { userId: { in: userIds }, status: { not: "REMOVED" }, team: { workspaceId: teamId } },
      data: { status: "REMOVED", removedAt: now },
    });
  }
  // Members audit SEC-08 — the owner links and external-review grants a
  // departing member created end with their membership (a governed removal
  // may first transfer them to the workspace's ownership).
  await revokeCreatorShareGrantsTx(tx, { creators: members, reason: "CREATOR_REMOVED" });
}

/**
 * A SUSPENSION releases the work too (re-audit B1): a suspended person cannot
 * open the workspace, so work left with them is stuck until somebody notices.
 * Their standing reach is NOT ended — suspension is reversible and a restore
 * gives back case access and groups — but the work goes back to its pools
 * (reassigning is a deliberate act after a restore, not an automatic one).
 * Called by the membership engine's suspend transition, in its transaction.
 */
export async function releaseWorkOnSuspension(
  tx: ReleaseTx,
  input: { teamId: string; userId: string; actorUserId: string | null },
): Promise<void> {
  await releaseWorkHeldByTx(tx, {
    teamId: input.teamId,
    userIds: [input.userId],
    actorUserId: input.actorUserId,
    reason: "member_suspended",
  });
}

// -----------------------------------------------------------------------------
// ROLE CHANGE — the work a lowered role can no longer act on (Team
// remediation T-099, members audit MEM-02).
// -----------------------------------------------------------------------------

/**
 * THE reviewer floor: the permission the decision authority asks of whoever
 * decides a review (`recordReviewDecision` → `evidence_request.review`). A
 * role below it can hold no review work.
 */
export const REVIEWER_FLOOR_PERMISSION: Permission = "evidence_request.review";

/**
 * The case mutation each case-assignment role exists to exercise. A case
 * assignment whose mutation the workspace role refuses (a VIEWER never
 * mutates a case) is an assignment its holder can no longer act on.
 */
const CASE_ASSIGNMENT_ROLE_MUTATION: Record<CaseAssignmentRole, CaseMutation | null> = {
  OWNER: "ASSIGN",
  INVESTIGATOR: "STATUS_CHANGE",
  REVIEWER: "COMMENT",
  GOVERNANCE: "COMMENT",
  // An observer only reads, which every workspace role may: never ended.
  OBSERVER: null,
};

/** May a member with workspace role `workspaceRole` exercise a case assignment of role `assignmentRole`? */
export function caseAssignmentExercisableBy(workspaceRole: string, assignmentRole: string): boolean {
  const mutation = CASE_ASSIGNMENT_ROLE_MUTATION[assignmentRole as CaseAssignmentRole];
  // A read-only role (OBSERVER) or an unknown legacy role is never ended silently.
  if (!mutation) return true;
  return evaluateCaseMutationPermission({
    mutation,
    accessRole: workspaceRole as CaseAccessRole,
    assignmentRoles: [assignmentRole as CaseAssignmentRole],
  }).allowed;
}

/**
 * Does the member hold `permission` — with `role` in place of their stored
 * role when given (a PREVIEW of a role change) — by THE canonical member
 * decision (capability grants and delegated scopes honoured; the access
 * window set aside, as for creator authority)? `null`: the facts could not be
 * read, so nothing is released.
 */
async function memberHoldsPermission(
  client: Pick<PrismaClient, "teamMember">,
  input: { teamId: string; userId: string; permission: Permission; role?: string },
): Promise<boolean | null> {
  let facts;
  try {
    facts = await loadMemberPermissionFacts(client, { teamId: input.teamId, userId: input.userId });
  } catch {
    return null;
  }
  if (!facts) return false;
  const decision = decideMemberPermission(
    { ...facts, ...(input.role ? { role: input.role as typeof facts.role } : {}), accessExpiresAtUtc: null },
    input.permission,
    new Date(),
  );
  return decision.allowed;
}

type RoleWorkClient = ReleaseTx & Pick<PrismaClient, "teamMember" | "caseAssignment">;

export type RoleChangeWorkImpact = {
  /** The new role is below the reviewer floor: held work is released. */
  releasesHeldWork: boolean;
  /** What the release would touch (zeros when `releasesHeldWork` is false). */
  heldWork: HeldWorkCounts;
  /** ACTIVE case assignments the new role cannot exercise: ended. */
  caseAssignmentsEnded: number;
};

async function caseAssignmentsBeyondRole(
  client: Pick<PrismaClient, "caseAssignment">,
  input: { teamId: string; userId: string; role: string },
): Promise<Array<{ id: string; role: string }>> {
  const rows = await client.caseAssignment.findMany({
    where: { teamId: input.teamId, assignedToUserId: input.userId, status: "ACTIVE" },
    select: { id: true, role: true },
  });
  return rows.filter((r) => !caseAssignmentExercisableBy(input.role, String(r.role)));
}

/**
 * PREVIEW of a role change, read-only, with the predicates the change itself
 * applies (`releaseWorkBeyondRoleTx`): the role-change confirmation states
 * these counts before the administrator confirms.
 */
export async function previewWorkBeyondRole(
  client: RoleWorkClient,
  input: { teamId: string; userId: string; newRole: string },
): Promise<RoleChangeWorkImpact> {
  const holds = await memberHoldsPermission(client, {
    teamId: input.teamId,
    userId: input.userId,
    permission: REVIEWER_FLOOR_PERMISSION,
    role: input.newRole,
  });
  const releasesHeldWork = holds === false;
  const heldWork = releasesHeldWork
    ? await countWorkHeldBy(client, { teamId: input.teamId, userIds: [input.userId] })
    : await countWorkHeldBy(client, { teamId: input.teamId, userIds: [] });
  const beyond = await caseAssignmentsBeyondRole(client, { teamId: input.teamId, userId: input.userId, role: input.newRole });
  return { releasesHeldWork, heldWork, caseAssignmentsEnded: beyond.length };
}

/**
 * At a ROLE CHANGE, inside the writer's transaction and AFTER the new role is
 * written (every role writer reaches it through the one role-change leg,
 * `endCreatorAuthorityOnRoleChangeTx`):
 *
 *   - below the reviewer floor, the work the person held is RELEASED exactly
 *     as a departure releases it (`releaseWorkHeldByTx`, reason
 *     `role_demoted`): reviews back to the queue with an UNASSIGNED event,
 *     escalations to the owners and admins, decision history untouched, one
 *     tenant audit row;
 *   - every ACTIVE case assignment the new role cannot exercise is ENDED
 *     (REMOVED, with who and when), as a departure ends it.
 *
 * A change that keeps the floor (reviewer → reviewer) releases nothing.
 */
export async function releaseWorkBeyondRoleTx(
  tx: RoleWorkClient,
  input: { teamId: string; userId: string; actorUserId: string | null },
): Promise<{ releasedWork: ReleasedWork | null; caseAssignmentsEnded: number }> {
  const holds = await memberHoldsPermission(tx, {
    teamId: input.teamId,
    userId: input.userId,
    permission: REVIEWER_FLOOR_PERMISSION,
  });
  let releasedWork: ReleasedWork | null = null;
  if (holds === false) {
    const released = await releaseWorkHeldByTx(tx, {
      teamId: input.teamId,
      userIds: [input.userId],
      actorUserId: input.actorUserId,
      reason: "role_demoted",
    });
    releasedWork = released.get(input.userId) ?? null;
  }
  const member = await tx.teamMember.findUnique({
    where: { teamId_userId: { teamId: input.teamId, userId: input.userId } },
    select: { role: true },
  });
  let caseAssignmentsEnded = 0;
  if (member) {
    const beyond = await caseAssignmentsBeyondRole(tx, { teamId: input.teamId, userId: input.userId, role: String(member.role) });
    if (beyond.length > 0) {
      const ended = await tx.caseAssignment.updateMany({
        where: { id: { in: beyond.map((b) => b.id) }, status: "ACTIVE" },
        data: { status: "REMOVED", removedAtUtc: new Date(), removedByUserId: input.actorUserId },
      });
      caseAssignmentsEnded = ended.count;
    }
  }
  return { releasedWork, caseAssignmentsEnded };
}
