/**
 * STANDING CREDENTIALS ANSWER TO THEIR CREATOR'S CURRENT AUTHORITY
 * (free-user audit B3A-F-002 / B3B-F-106 / B7B-F09).
 *
 * An integration API key and a secure intake link act in the name of the
 * member who created them: an API call writes rows as that user, and an intake
 * submission creates a record owned by them. Removal and suspension already end
 * them (SEC-08 / INGEST-010 / A2-10, `revokeCreatorShareGrantsTx`). A DEMOTION
 * did not: the role check named only the share permissions, and nothing at use
 * time asked again, so a member lowered to VIEWER kept writing through a key or
 * a link minted while they were an administrator.
 *
 * The question is asked through THE canonical access evaluation
 * (`loadMemberAccessSnapshot` + `evaluateAccess`), so a capability grant or a
 * delegated scope that still carries the permission keeps the credential alive,
 * and a role that lost it ends it — whichever path changed the role (an
 * administrator, the directory, SCIM).
 *
 * What this module deliberately does NOT treat as lost authority:
 *
 *   - EXPIRY of the creator's access window (policy A2-26): a standing link,
 *     key or webhook outlives the window it was made in. The window is set
 *     aside before the evaluation, never read as a refusal.
 *   - the WORKSPACE's lifecycle (organization suspended, workspace closed or
 *     unprovable): reversible or owned by its own leg, and every caller has
 *     already refused on it before asking here. Revoking on it would make a
 *     suspension permanent.
 *
 * A failure to read the facts is "indeterminate": the caller refuses the use
 * (fail closed) but revokes nothing.
 */
import type { PrismaClient } from "@prisma/client";
import type { Permission } from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { evaluateAccess, loadMemberAccessSnapshot } from "../identity/access-policy.service.js";
import { revokeCreatorShareGrantsTx } from "./creator-share-grants.js";

/** The permission that let a member create each kind of standing credential. */
export const STANDING_CREDENTIAL_PERMISSION = {
  /** POST /v1/integrations/api-keys. */
  apiKey: "integration.api_key.manage",
  /** A link minted directly (POST /v1/workflow/intake-links). */
  intakeLink: "workflow.intake_link.create",
  /** A link minted by sending an evidence request (bound to the request). */
  requestIntakeLink: "evidence_request.create",
  /** Integration webhooks and automation webhook destinations. */
  webhook: "integration.webhook.manage",
  /** Lifecycle (packaging) webhook endpoints. */
  lifecycleWebhook: "integration.lifecycle_webhook.manage",
} as const satisfies Record<string, Permission>;

/** The reason recorded on a credential ended because its creator lost the authority. */
export const CREATOR_LOST_AUTHORITY_REASON = "creator_lost_authority";

export type CreatorAuthorityVerdict =
  | { verdict: "HOLDS" }
  | { verdict: "LOST"; reason: string }
  | { verdict: "WORKSPACE_BLOCKED"; reason: string }
  | { verdict: "INDETERMINATE" };

const WORKSPACE_REASONS = new Set(["workspace_kind_unresolved", "organization_not_active"]);

/**
 * Does the creator still hold `permission` in this workspace, by the canonical
 * decision, with their access window set aside (A2-26)?
 */
export async function evaluateCreatorAuthority(
  input: { teamId: string; userId: string; permission: Permission },
  client: PrismaClient = defaultPrisma,
): Promise<CreatorAuthorityVerdict> {
  let snapshot;
  try {
    snapshot = await loadMemberAccessSnapshot({ teamId: input.teamId, userId: input.userId }, client);
  } catch {
    return { verdict: "INDETERMINATE" };
  }
  if (!snapshot) return { verdict: "LOST", reason: "no_membership" };
  // A2-26 — expiry is not a loss of authority for a standing credential.
  const actor = { kind: "MEMBER" as const, member: { ...snapshot, accessExpiresAtUtc: null } };
  const decision = evaluateAccess(actor, { permission: input.permission });
  if (decision.allowed) return { verdict: "HOLDS" };
  if (WORKSPACE_REASONS.has(decision.reason)) {
    return { verdict: "WORKSPACE_BLOCKED", reason: decision.reason };
  }
  return { verdict: "LOST", reason: decision.reason };
}

/** The permission an intake link's creator must still hold: request-bound links answer to the request permission. */
export async function intakeLinkCreatorPermission(
  linkId: string,
  client: Pick<PrismaClient, "evidenceRequest"> = defaultPrisma,
): Promise<Permission> {
  const bound = await client.evidenceRequest.count({ where: { intakeLinkId: linkId } });
  return bound > 0 ? STANDING_CREDENTIAL_PERMISSION.requestIntakeLink : STANDING_CREDENTIAL_PERMISSION.intakeLink;
}

/** End one API key whose creator lost the authority (conditional: an already ended key is left as it is). */
export async function revokeApiKeyForLostAuthority(
  credentialId: string,
  client: Pick<PrismaClient, "apiCredential"> = defaultPrisma,
): Promise<boolean> {
  const r = await client.apiCredential.updateMany({
    where: { id: credentialId, status: "ACTIVE" },
    data: { status: "REVOKED", revokedAtUtc: new Date(), revokedByUserId: null, revokedReason: CREATOR_LOST_AUTHORITY_REASON },
  });
  return r.count === 1;
}

/** End one intake link whose creator lost the authority. */
export async function revokeIntakeLinkForLostAuthority(
  linkId: string,
  client: Pick<PrismaClient, "workflowIntakeLink"> = defaultPrisma,
): Promise<boolean> {
  const r = await client.workflowIntakeLink.updateMany({
    where: { id: linkId, status: "ACTIVE" },
    data: { status: "REVOKED", revokedAtUtc: new Date(), revokedByUserId: null, revokedReason: CREATOR_LOST_AUTHORITY_REASON },
  });
  return r.count === 1;
}

type RoleChangeTx = Parameters<typeof revokeCreatorShareGrantsTx>[0] & Pick<PrismaClient, "teamMember" | "evidenceRequest">;

/**
 * The permission that let a member create each kind of creator-scoped
 * OUTWARD grant (members audit SEC-08): an owner share link and an
 * external-review grant.
 */
export const CREATOR_GRANT_PERMISSION = {
  ownerShare: "evidence.publish_verify",
  externalReview: "governance.legal_hold.manage",
} as const satisfies Record<string, Permission>;

/**
 * PRO-R1-05 — THE role-change leg, shared by EVERY role writer (the
 * administrator's `changeMemberRole`, the directory's
 * `applyDirectoryRoleChange` and `demoteGroupMappedRoleOnArchive`). Inside the
 * writer's transaction and after the new role is written, it ends:
 *
 *   - the creator's owner share links and external-review grants when, by the
 *     canonical decision (`evaluateCreatorAuthority`, so a capability grant
 *     that still carries the permission keeps them, and the access window is
 *     set aside under A2-26), they no longer hold the permission that created
 *     them;
 *   - their standing credentials, through `endStandingCredentialsOnLostAuthorityTx`.
 *
 * An indeterminate read revokes nothing (the use-time checks fail closed).
 */
export async function endCreatorAuthorityOnRoleChangeTx(
  tx: RoleChangeTx,
  input: { teamId: string; userId: string; actorUserId: string | null },
): Promise<{ ownerShares: number; externalReview: number; apiKeys: number; intakeLinks: number; webhooks: number }> {
  const lost = async (permission: Permission) =>
    (await evaluateCreatorAuthority({ teamId: input.teamId, userId: input.userId, permission }, tx as unknown as PrismaClient))
      .verdict === "LOST";
  const losesShares = await lost(CREATOR_GRANT_PERMISSION.ownerShare);
  const losesExternal = await lost(CREATOR_GRANT_PERMISSION.externalReview);
  let ownerShares = 0;
  let externalReview = 0;
  if (losesShares || losesExternal) {
    const r = await revokeCreatorShareGrantsTx(tx, {
      creators: [{ teamId: input.teamId, userId: input.userId }],
      reason: "CREATOR_LOST_AUTHORITY",
      actorUserId: input.actorUserId,
      kinds: { ownerShares: losesShares, externalReview: losesExternal, intakeLinks: false, apiKeys: false, webhooks: false },
    });
    ownerShares = r.ownerShares;
    externalReview = r.externalReview;
  }
  const standing = await endStandingCredentialsOnLostAuthorityTx(tx, input);
  return { ownerShares, externalReview, ...standing };
}

/**
 * At a ROLE CHANGE, inside its transaction and after the new role is written:
 * end the standing credentials whose permission the member no longer holds
 * (API keys, intake links — direct and request-bound separately — and
 * webhooks). Asked through the same canonical evaluation as the use-time
 * check, so a capability grant that still carries the permission keeps them.
 * The use-time check (`requireApiKey`, `validateIntakeToken`) covers every
 * other path that lowers a role.
 */
export async function endStandingCredentialsOnLostAuthorityTx(
  tx: RoleChangeTx,
  input: { teamId: string; userId: string; actorUserId: string | null },
): Promise<{ apiKeys: number; intakeLinks: number; webhooks: number }> {
  const out = { apiKeys: 0, intakeLinks: 0, webhooks: 0 };
  const lost = async (permission: Permission) =>
    (await evaluateCreatorAuthority({ teamId: input.teamId, userId: input.userId, permission }, tx as unknown as PrismaClient))
      .verdict === "LOST";
  const creators = [{ teamId: input.teamId, userId: input.userId }];
  const losesKeys = await lost(STANDING_CREDENTIAL_PERMISSION.apiKey);
  const losesWebhooks = await lost(STANDING_CREDENTIAL_PERMISSION.webhook);
  const losesLifecycleWebhooks = await lost(STANDING_CREDENTIAL_PERMISSION.lifecycleWebhook);
  if (losesKeys || losesWebhooks || losesLifecycleWebhooks) {
    const r = await revokeCreatorShareGrantsTx(tx, {
      creators,
      reason: "CREATOR_LOST_AUTHORITY",
      actorUserId: input.actorUserId,
      kinds: {
        ownerShares: false,
        externalReview: false,
        intakeLinks: false,
        apiKeys: losesKeys,
        webhooks: losesWebhooks,
        lifecycleWebhooks: losesLifecycleWebhooks,
      },
    });
    out.apiKeys += r.apiKeys;
    out.webhooks += r.webhooks;
  }
  const now = new Date();
  const linkData = {
    status: "REVOKED" as const,
    revokedAtUtc: now,
    revokedByUserId: input.actorUserId,
    revokedReason: CREATOR_LOST_AUTHORITY_REASON,
  };
  if (await lost(STANDING_CREDENTIAL_PERMISSION.intakeLink)) {
    const r = await tx.workflowIntakeLink.updateMany({
      where: { teamId: input.teamId, createdByUserId: input.userId, status: "ACTIVE", evidenceRequests: { none: {} } },
      data: linkData,
    });
    out.intakeLinks += r.count;
  }
  if (await lost(STANDING_CREDENTIAL_PERMISSION.requestIntakeLink)) {
    const r = await tx.workflowIntakeLink.updateMany({
      where: { teamId: input.teamId, createdByUserId: input.userId, status: "ACTIVE", evidenceRequests: { some: {} } },
      data: linkData,
    });
    out.intakeLinks += r.count;
  }
  return out;
}
