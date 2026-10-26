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
import type { PrismaClient } from "@prisma/client";

import { revokeCreatorShareGrantsTx } from "../sharing/creator-share-grants.js";
import {
  releaseWorkHeldByTx,
  type ReleaseReason,
  type ReleaseTx,
} from "../assignment/release-held-work.js";

type ReachTx = Pick<
  PrismaClient,
  "caseAccess" | "caseAssignment" | "collaborationTeamMember" | "verificationShareToken" | "externalReviewGrant"
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
