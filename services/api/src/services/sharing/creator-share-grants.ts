/**
 * CREATOR-SCOPED SHARE GRANTS (members audit SEC-08, owner decision 2026-10-25).
 *
 * Two kinds of outward access are held in a person's name:
 *
 *   - an owner share link (`verification_share_tokens`, purpose OWNER_SHARE),
 *     created by a member for a named audience;
 *   - an external-review grant (`external_review_grants`), issued by a member
 *     to an outside reviewer.
 *
 * Neither may outlive its creator's authority. When the creator is removed,
 * suspended, or loses the permission that let them create it, their live
 * grants in that workspace end — unless an OWNER/ADMIN transferred them to the
 * workspace's ownership in the same governed removal. Workspace closure ends
 * them all. History stays: rows are revoked (with the reason), never deleted,
 * and audit rows are untouched.
 *
 * What this module never touches: the record's canonical Public Verify
 * reference (`pvr_`) and the share tokens an issued REPORT or PACKAGE carries.
 * Those belong to the record's publication state, not to a person, and an
 * issued report's QR code must keep verifying whoever made it.
 */
import type { PrismaClient } from "@prisma/client";

type ShareTx = Pick<PrismaClient, "verificationShareToken" | "externalReviewGrant">;

export type CreatorShareRevocationReason =
  | "CREATOR_REMOVED"
  | "CREATOR_SUSPENDED"
  | "CREATOR_LOST_AUTHORITY"
  | "CREATOR_LOST_RECORD_REACH"
  | "WORKSPACE_CLOSED";

/**
 * End the named live owner links and external-review grants (members re-audit
 * defect 4). Used when a creator keeps their membership and role but loses
 * REACH to the record the grant is on — a restricted case closed it to them —
 * so ending every grant they hold in the workspace would be too much. The
 * caller decides which grants lost reach; this is only the revocation, the
 * same shape as `revokeCreatorShareGrantsTx`: rows are revoked with the
 * reason, never deleted, and a grant already ended is left as it is.
 */
export async function revokeShareGrantsByIdTx(
  tx: ShareTx,
  input: {
    ownerShareIds: readonly string[];
    externalReviewIds: readonly string[];
    reason: CreatorShareRevocationReason;
    actorUserId?: string | null;
  },
): Promise<{ ownerShares: number; externalReview: number }> {
  const now = new Date();
  let ownerShares = 0;
  let externalReview = 0;
  if (input.ownerShareIds.length > 0) {
    const r = await tx.verificationShareToken.updateMany({
      where: { id: { in: [...input.ownerShareIds] }, purpose: "OWNER_SHARE", revokedAtUtc: null },
      data: { revokedAtUtc: now, revokedByUserId: input.actorUserId ?? null, revocationReason: input.reason },
    });
    ownerShares = r.count;
  }
  if (input.externalReviewIds.length > 0) {
    const r = await tx.externalReviewGrant.updateMany({
      where: { id: { in: [...input.externalReviewIds] }, state: { in: ["INVITED", "ACTIVE"] } },
      data: {
        state: "REVOKED",
        revokedAtUtc: now,
        updatedAtUtc: now,
        ...(input.actorUserId ? { revokedByUserId: input.actorUserId } : {}),
      },
    });
    externalReview = r.count;
  }
  return { ownerShares, externalReview };
}

/** End the live owner links and external-review grants these creators hold. */
export async function revokeCreatorShareGrantsTx(
  tx: ShareTx,
  input: {
    creators: ReadonlyArray<{ teamId: string; userId: string }>;
    reason: CreatorShareRevocationReason;
    actorUserId?: string | null;
    kinds?: { ownerShares?: boolean; externalReview?: boolean };
  },
): Promise<{ ownerShares: number; externalReview: number }> {
  const out = { ownerShares: 0, externalReview: 0 };
  if (input.creators.length === 0) return out;
  const now = new Date();
  const byWorkspace = new Map<string, string[]>();
  for (const c of input.creators) {
    const list = byWorkspace.get(c.teamId);
    if (list) list.push(c.userId);
    else byWorkspace.set(c.teamId, [c.userId]);
  }
  for (const [teamId, userIds] of byWorkspace) {
    if (input.kinds?.ownerShares !== false) {
      const r = await tx.verificationShareToken.updateMany({
        where: { teamId, purpose: "OWNER_SHARE", createdByUserId: { in: userIds }, revokedAtUtc: null },
        data: { revokedAtUtc: now, revokedByUserId: input.actorUserId ?? null, revocationReason: input.reason },
      });
      out.ownerShares += r.count;
    }
    if (input.kinds?.externalReview !== false) {
      const r = await tx.externalReviewGrant.updateMany({
        where: { teamId, invitedByUserId: { in: userIds }, state: { in: ["INVITED", "ACTIVE"] } },
        data: { state: "REVOKED", revokedAtUtc: now, updatedAtUtc: now, ...(input.actorUserId ? { revokedByUserId: input.actorUserId } : {}) },
      });
      out.externalReview += r.count;
    }
  }
  return out;
}

/** End every live owner link in these workspaces (closure; external grants have their own leg). */
export async function revokeWorkspaceOwnerSharesTx(
  tx: Pick<PrismaClient, "verificationShareToken">,
  input: { teamIds: readonly string[]; actorUserId: string | null },
): Promise<number> {
  if (input.teamIds.length === 0) return 0;
  const r = await tx.verificationShareToken.updateMany({
    where: { teamId: { in: [...input.teamIds] }, purpose: "OWNER_SHARE", revokedAtUtc: null },
    data: { revokedAtUtc: new Date(), revokedByUserId: input.actorUserId, revocationReason: "WORKSPACE_CLOSED" },
  });
  return r.count;
}

/**
 * The governed removal's explicit choice: keep a departing member's live,
 * unexpired grants working by moving them to the workspace's OWNER. Expired or
 * revoked grants are not revived. Returns what moved, for the audit row.
 */
export async function transferCreatorShareGrantsToOwnerTx(
  tx: ShareTx,
  input: { teamId: string; fromUserId: string; ownerUserId: string },
): Promise<{ ownerShares: number; externalReview: number }> {
  const now = new Date();
  const shares = await tx.verificationShareToken.updateMany({
    where: {
      teamId: input.teamId,
      purpose: "OWNER_SHARE",
      createdByUserId: input.fromUserId,
      revokedAtUtc: null,
      expiresAtUtc: { gt: now },
    },
    data: { createdByUserId: input.ownerUserId },
  });
  const grants = await tx.externalReviewGrant.updateMany({
    where: {
      teamId: input.teamId,
      invitedByUserId: input.fromUserId,
      state: { in: ["INVITED", "ACTIVE"] },
      expiresAtUtc: { gt: now },
    },
    data: { invitedByUserId: input.ownerUserId, updatedAtUtc: now },
  });
  return { ownerShares: shares.count, externalReview: grants.count };
}
