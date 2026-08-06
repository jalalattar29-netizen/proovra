/**
 * PHASE 10 closure Fix 2 — SCIM managed-ownership INVARIANT enforcement.
 *
 * Every SCIM mutation path (update, group add/remove) must ENFORCE the managed
 * identity invariant BEFORE mutating — never assume "already managed". This is
 * a pure COMPOSITION of the canonical authorities (it writes nothing itself
 * except through the ONE atomic provisioning intent):
 *   - `organizationIdForPolicy`  — the exact Customer Organization for the token,
 *   - `resolveOrganizationPolicy` — the live OrganizationSecurityPolicy,
 *   - `resolveManagedIdentity`    — the user's current managed state,
 *   - `provisionManagedMembership` — the ONE atomic bind+seat+membership intent.
 *
 * Enforcement (fail closed on ambiguity):
 *   MANAGED by THIS org       → continue idempotently.
 *   STANDARD + policy requires → bind managed identity + seat + membership via
 *                                the atomic intent, THEN the caller applies the
 *                                update/role.
 *   STANDARD + not required    → continue (the org does not require managed).
 *   MANAGED by ANOTHER org     → cross-org conflict → throw, ZERO mutation.
 *   MANAGED_UNRESOLVED         → fail closed → throw, ZERO mutation.
 * (resolveManagedIdentity itself throws SECURITY_SCHEMA_UNAVAILABLE on schema
 *  absence — never downgrades to STANDARD — so that also fails closed here.)
 */

import type { PrismaClient } from "@prisma/client";

import { resolveManagedIdentity } from "../identity/identity-mode.service.js";
import {
  organizationIdForPolicy,
  resolveOrganizationPolicy,
} from "../identity/org-security-policy.service.js";
import {
  provisionManagedMembership,
  type TxClient,
} from "../identity/membership-provisioning.service.js";

export class ScimManagedOwnershipError extends Error {
  readonly statusCode = 409;
  constructor(
    readonly code:
      | "SCIM_MANAGED_CROSS_ORG_CONFLICT"
      | "SCIM_MANAGED_UNRESOLVED",
  ) {
    super(code);
    this.name = "ScimManagedOwnershipError";
  }
}

export type ScimOwnershipContext = { teamId: string; tokenId: string };

/**
 * Enforce the managed-ownership invariant for a SCIM mutation on `userId`.
 * Returns the resulting disposition (for audit/metrics); throws on conflict /
 * unresolved / schema-unavailable so the caller performs ZERO mutation.
 */
/**
 * MUST run inside the caller's transaction (`tx`). It performs NO nested
 * transaction of its own, so the caller can wrap ownership reconciliation +
 * the subsequent role/attribute mutation in ONE atomic unit — if the later
 * role transition throws, the managed/membership reconciliation rolls back too
 * (zero partial ownership→role state). Reads run on the same `tx` for a
 * consistent snapshot.
 */
export async function enforceScimManagedOwnership(
  ctx: ScimOwnershipContext,
  input: { userId: string; workspaceRole?: "VIEWER" | "MEMBER" },
  tx: TxClient,
): Promise<"NOT_APPLICABLE" | "IDEMPOTENT" | "RECONCILED" | "STANDARD_ALLOWED"> {
  const client = tx as unknown as PrismaClient;
  const orgId = await organizationIdForPolicy(ctx.teamId, client);
  // Non-CUSTOMER SCIM target — there is no managing Organization to enforce.
  if (!orgId) return "NOT_APPLICABLE";

  const policy = await resolveOrganizationPolicy(ctx.teamId, client);
  const managedRequired =
    policy.applicability === "ORGANIZATION" &&
    policy.policy.managedIdentityRequired;

  // resolveManagedIdentity fails closed on schema absence (never STANDARD).
  const managed = await resolveManagedIdentity(input.userId, client);

  if (managed.state === "MANAGED") {
    if (managed.managingOrganizationId === orgId) return "IDEMPOTENT";
    throw new ScimManagedOwnershipError("SCIM_MANAGED_CROSS_ORG_CONFLICT");
  }
  if (managed.state === "MANAGED_UNRESOLVED") {
    throw new ScimManagedOwnershipError("SCIM_MANAGED_UNRESOLVED");
  }

  // STANDARD.
  if (!managedRequired) return "STANDARD_ALLOWED";

  // The org requires managed identity but the user is STANDARD — reconcile
  // through the ONE atomic intent (bind + seat + membership) ON THE CALLER'S TX,
  // BEFORE the caller applies the update/group role. A conflict/seat failure —
  // or a later role failure in the same tx — rolls the reconciliation back.
  await provisionManagedMembership(tx, {
    userId: input.userId,
    managingTeamId: ctx.teamId,
    evidence: { source: "SCIM", scimTokenId: ctx.tokenId },
    membershipIntent: "SCIM_PROVISIONING",
    source: "SCIM",
    workspace: { teamId: ctx.teamId, role: input.workspaceRole ?? "MEMBER" },
    actorUserId: null, // the directory, not a member, is the actor
    accessReason: "SCIM managed-ownership reconciliation",
    seatPolicy: "ENFORCE",
    seatTeamId: ctx.teamId,
  });
  return "RECONCILED";
}
