/**
 * Phase 17 — SSO / SCIM readiness.
 *
 * Stores the mapping between a workspace User and an external identity
 * provider (IdP) subject. Phase 17 does NOT implement an actual SAML /
 * OIDC / SCIM flow — rows are written out-of-band by an operator and
 * exposed in the /identity UI + audit log.
 *
 * Privacy: external subject identifiers are workspace-internal. They
 * are NEVER surfaced on public verify or in any contributor-visible
 * surface. Only operators with `identity.external_mapping.read` can see
 * mappings.
 *
 * Hard invariant: this module never makes an authentication decision.
 * Presence of a mapping does NOT bypass the existing auth path; it's a
 * record-keeping primitive that a later phase will wire into the JWT
 * issuer when the actual SSO flow lands.
 */

import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import type { ExternalIdentityProvider } from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
// PHASE 12 POINT 4 PASS C3 — the canonical managed-identity ownership read.
import { resolveManagedIdentity } from "./identity-mode.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";

export type ExternalIdentityErrorCode =
  | "user_not_in_workspace"
  | "mapping_already_active"
  | "mapping_not_found"
  // PHASE 12 POINT 4 PASS C3 — the subject belongs to an IdP-managed identity;
  // only the provider (SCIM/SAML/OIDC) may change its bindings.
  | "managed_identity_readonly"
  // PHASE 12 POINT 4 PASS C3 — that external subject already resolves to a
  // different user; re-pointing it would hand over their login.
  | "external_subject_already_mapped";

export class ExternalIdentityError extends Error {
  readonly code: ExternalIdentityErrorCode;
  constructor(code: ExternalIdentityErrorCode) {
    super(code);
    this.code = code;
  }
}

/**
 * PHASE 12 POINT 4 PASS C3 — the ONE predicate for "may a manual route touch
 * this identity's external bindings?".
 *
 * MANAGED_ENTERPRISE identities are owned by their provider: SCIM/SAML/OIDC
 * provisioning is the only authority over their bindings. `resolveManagedIdentity`
 * throws on schema-unavailable and never downgrades an unresolved state to
 * STANDARD, so this gate denies on ambiguity.
 */
async function assertIdentityIsManuallyBindable(
  userId: string,
  client: PrismaClient,
): Promise<void> {
  const managed = await resolveManagedIdentity(userId, client);
  if (managed.mode === "MANAGED_ENTERPRISE") {
    throw new ExternalIdentityError("managed_identity_readonly");
  }
}

export type LinkExternalIdentityInput = {
  teamId: string;
  userId: string;
  provider: ExternalIdentityProvider;
  externalSubjectId: string;
  displayName?: string | null;
  externalEmail?: string | null;
  actorUserId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export async function linkExternalIdentity(
  input: LinkExternalIdentityInput,
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.ExternalIdentityMapping> {
  // Verify the user actually belongs to the workspace — prevents an
  // operator from creating an SSO mapping for an arbitrary userId.
  const member = await client.teamMember.findFirst({
    where: { teamId: input.teamId, userId: input.userId },
    select: { id: true },
  });
  if (!member) throw new ExternalIdentityError("user_not_in_workspace");

  // PHASE 12 POINT 4 PASS C3 — a MANAGED identity's bindings belong to its
  // provider, not to this manual route.
  //
  // The SSO login flow resolves the user by (provider, externalSubjectId)
  // through exactly the row this function writes. Without this gate, an
  // operator holding `identity.external_mapping.write` — a strictly weaker
  // capability than IdP administration — could bind an external subject they
  // control to an enterprise-managed account and then log in as that user.
  // `resolveManagedIdentity` fails closed on unresolved/schema-unavailable, so
  // ambiguity denies rather than permits.
  await assertIdentityIsManuallyBindable(input.userId, client);

  // The external subject may not be taken from another user. The DB unique on
  // (provider, externalSubjectId) would reject this anyway; refusing here
  // makes it a bounded denial instead of an opaque constraint failure — and
  // states the reason plainly: that subject is somebody's login.
  const subjectOwner = await client.externalIdentityMapping.findFirst({
    where: {
      provider: input.provider,
      externalSubjectId: input.externalSubjectId.slice(0, 320),
    },
    select: { id: true, userId: true },
  });
  if (subjectOwner && subjectOwner.userId !== input.userId) {
    throw new ExternalIdentityError("external_subject_already_mapped");
  }

  // Re-issue path: if an active mapping already exists for this (team,
  // user, provider), refuse so operators must explicitly unlink first.
  const existing = await client.externalIdentityMapping.findFirst({
    where: {
      teamId: input.teamId,
      userId: input.userId,
      provider: input.provider,
      unlinkedAtUtc: null,
    },
    select: { id: true },
  });
  if (existing) throw new ExternalIdentityError("mapping_already_active");

  const created = await client.externalIdentityMapping.create({
    data: {
      teamId: input.teamId,
      userId: input.userId,
      provider: input.provider,
      externalSubjectId: input.externalSubjectId.slice(0, 320),
      displayName: input.displayName?.slice(0, 180) ?? null,
      externalEmail: input.externalEmail?.slice(0, 320) ?? null,
    },
  });
  safeEmitSecurityEvent(
    {
      teamId: input.teamId,
      eventType: "external_identity_linked",
      severity: "INFO",
      details: {
        actorUserId: input.actorUserId,
        subjectUserId: input.userId,
        provider: input.provider,
      },
    },
    client,
  );
  await emitTenantAudit({
    action: "identity.external_mapping.link",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.actorUserId,
    workspaceId: input.teamId,
    resourceType: "external_identity_mapping",
    resourceId: created.id,
    metadata: {
      subjectUserId: input.userId,
      provider: input.provider,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
  }, client);
  return created;
}

export type UnlinkExternalIdentityInput = {
  teamId: string;
  mappingId: string;
  actorUserId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export async function unlinkExternalIdentity(
  input: UnlinkExternalIdentityInput,
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.ExternalIdentityMapping> {
  const mapping = await client.externalIdentityMapping.findFirst({
    where: { id: input.mappingId, teamId: input.teamId, unlinkedAtUtc: null },
  });
  if (!mapping) throw new ExternalIdentityError("mapping_not_found");
  // PHASE 12 POINT 4 PASS C3 — unlinking an IdP-managed subject would sever a
  // managed account from its provider outside the provisioning system, leaving
  // SCIM/SAML and the platform disagreeing about who that user is.
  // Deprovisioning happens through the provider.
  await assertIdentityIsManuallyBindable(mapping.userId, client);
  const updated = await client.externalIdentityMapping.update({
    where: { id: mapping.id },
    data: { unlinkedAtUtc: new Date() },
  });
  safeEmitSecurityEvent(
    {
      teamId: input.teamId,
      eventType: "external_identity_unlinked",
      severity: "INFO",
      details: {
        actorUserId: input.actorUserId,
        mappingId: mapping.id,
        provider: mapping.provider,
        subjectUserId: mapping.userId,
      },
    },
    client,
  );
  await emitTenantAudit({
    action: "identity.external_mapping.unlink",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.actorUserId,
    workspaceId: input.teamId,
    resourceType: "external_identity_mapping",
    resourceId: mapping.id,
    metadata: {
      subjectUserId: mapping.userId,
      provider: mapping.provider,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
  }, client);
  return updated;
}

export async function listExternalIdentityMappings(
  input: { teamId: string; activeOnly?: boolean; limit?: number },
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.ExternalIdentityMapping[]> {
  return client.externalIdentityMapping.findMany({
    where: {
      teamId: input.teamId,
      ...(input.activeOnly ? { unlinkedAtUtc: null } : {}),
    },
    orderBy: { linkedAtUtc: "desc" },
    take: Math.min(Math.max(input.limit ?? 100, 1), 500),
  });
}
