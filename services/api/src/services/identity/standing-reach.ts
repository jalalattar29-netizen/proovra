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
 * One module, imported by the per-member engine and the mass orchestrator
 * alike, so the two cannot disagree about what "ended" means.
 */
import type { PrismaClient } from "@prisma/client";

import { revokeCreatorShareGrantsTx } from "../sharing/creator-share-grants.js";

type ReachTx = Pick<
  PrismaClient,
  "caseAccess" | "caseAssignment" | "collaborationTeamMember" | "verificationShareToken" | "externalReviewGrant"
>;

export async function endStandingReach(
  tx: ReachTx,
  input: { teamId: string; userId: string },
): Promise<void> {
  await endStandingReachForMembers(tx, [input]);
}

export async function endStandingReachForMembers(
  tx: ReachTx,
  members: ReadonlyArray<{ teamId: string; userId: string }>,
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
