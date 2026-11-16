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
 * (The same transitions also end the intake links, API keys and webhooks a
 * person created: INGEST-010, A2-10, B7B-F09. A role change ends those through
 * standing-credential-authority.ts, which also re-asks at use time. Expiry of
 * the creator's access window ends none of them: policy A2-26.)
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

type ShareTx = Pick<
  PrismaClient,
  | "verificationShareToken"
  | "externalReviewGrant"
  | "workflowIntakeLink"
  | "apiCredential"
  // B7B-F09 — the three webhook systems, each row held in its creator's name.
  | "webhookEndpoint"
  | "automationWebhookDestination"
  | "lifecycleWebhookEndpoint"
>;

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
    kinds?: {
      ownerShares?: boolean;
      externalReview?: boolean;
      intakeLinks?: boolean;
      apiKeys?: boolean;
      /** Integration webhook endpoints and automation webhook destinations. */
      webhooks?: boolean;
      /** Lifecycle (packaging) webhook endpoints; defaults to `webhooks`. */
      lifecycleWebhooks?: boolean;
    };
  },
): Promise<{ ownerShares: number; externalReview: number; intakeLinks: number; apiKeys: number; webhooks: number }> {
  const out = { ownerShares: 0, externalReview: 0, intakeLinks: 0, apiKeys: 0, webhooks: 0 };
  // INGEST-010 — a secure intake link is an anonymous capability held in its
  // creator's name, like an owner share link: it ends when the creator is
  // removed or suspended, or the workspace closes (rows kept, revoked with the
  // reason). It used to stay ACTIVE in the operator's list while every new
  // contributor's first file was refused, because the record is created in the
  // creator's name. A change of role ends it only when the role no longer holds
  // the permission that minted it (B3B-F-106: standing-credential-authority.ts
  // asks the canonical decision, separately for direct and request-bound
  // links), never because a share permission went.
  const endsIntakeLinks =
    input.kinds?.intakeLinks ??
    (input.reason === "CREATOR_REMOVED" || input.reason === "CREATOR_SUSPENDED" || input.reason === "WORKSPACE_CLOSED");
  // A2-10 — an integration API key is machine access held in its creator's
  // name the same way: it ends when the creator is removed or suspended
  // (revoked, with the reason, never deleted), or when a role change takes the
  // key permission away (B3A-F-002, passed explicitly by the role-change leg).
  // Workspace closure revokes every key of the workspace on its own leg.
  const endsApiKeys =
    input.kinds?.apiKeys ?? (input.reason === "CREATOR_REMOVED" || input.reason === "CREATOR_SUSPENDED");
  // B7B-F09 — a webhook is standing OUTBOUND access configured in its
  // creator's name (record ids, fingerprints, sizes and timestamps keep
  // flowing to a URL they chose). It ends on the same transitions as their API
  // keys (A2-10): removal and suspension, or the loss of the permission that
  // created it (the role-change leg passes it explicitly). Endpoints are
  // DISABLED / destinations disabled / lifecycle endpoints DEACTIVATED — kept,
  // never deleted, and re-enabled only deliberately. EXPIRY of the creator's
  // access window is not one of these transitions (A2-26). Workspace closure
  // and workspace suspension have their own legs.
  const endsWebhooks =
    input.kinds?.webhooks ?? (input.reason === "CREATOR_REMOVED" || input.reason === "CREATOR_SUSPENDED");
  const endsLifecycleWebhooks = input.kinds?.lifecycleWebhooks ?? endsWebhooks;
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
    if (endsIntakeLinks) {
      const r = await tx.workflowIntakeLink.updateMany({
        where: { teamId, createdByUserId: { in: userIds }, status: "ACTIVE" },
        data: {
          status: "REVOKED",
          revokedAtUtc: now,
          revokedByUserId: input.actorUserId ?? null,
          revokedReason: input.reason.toLowerCase(),
        },
      });
      out.intakeLinks += r.count;
    }
    if (endsApiKeys) {
      const r = await tx.apiCredential.updateMany({
        where: { teamId, createdByUserId: { in: userIds }, status: "ACTIVE" },
        data: {
          status: "REVOKED",
          revokedAtUtc: now,
          revokedByUserId: input.actorUserId ?? null,
          revokedReason: input.reason.toLowerCase(),
        },
      });
      out.apiKeys += r.count;
    }
    if (endsWebhooks) {
      const endpoints = await tx.webhookEndpoint.updateMany({
        where: { teamId, createdByUserId: { in: userIds }, status: "ACTIVE" },
        data: { status: "DISABLED" },
      });
      const destinations = await tx.automationWebhookDestination.updateMany({
        where: { teamId, createdByUserId: { in: userIds }, enabled: true },
        data: { enabled: false, disabledAt: now, disabledReason: input.reason.toLowerCase() },
      });
      out.webhooks += endpoints.count + destinations.count;
    }
    if (endsLifecycleWebhooks) {
      const lifecycle = await tx.lifecycleWebhookEndpoint.updateMany({
        where: { teamId, createdByUserId: { in: userIds }, state: "ACTIVE" },
        data: { state: "DEACTIVATED", deactivatedAtUtc: now },
      });
      out.webhooks += lifecycle.count;
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
 * B-06 — end the live owner links on the owner's LEGACY records that carry no
 * workspace (`team_id` NULL). Closure ends owner links by workspace, and creator
 * revocation is keyed per workspace, so a link minted on such a record (its
 * share row inherits the NULL) was reached by neither and kept working after
 * the account closed. Selected by the record's owner; same reason as the
 * owner's workspace links ending in the same closure.
 */
export async function revokeLegacyUnscopedOwnerSharesTx(
  tx: Pick<PrismaClient, "verificationShareToken">,
  input: { ownerUserId: string; actorUserId: string | null },
): Promise<number> {
  const r = await tx.verificationShareToken.updateMany({
    where: {
      teamId: null,
      purpose: "OWNER_SHARE",
      revokedAtUtc: null,
      evidence: { ownerUserId: input.ownerUserId },
    },
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
