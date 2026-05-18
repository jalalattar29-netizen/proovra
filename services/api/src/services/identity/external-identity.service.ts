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
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";

export type ExternalIdentityErrorCode =
  | "user_not_in_workspace"
  | "mapping_already_active"
  | "mapping_not_found";

export class ExternalIdentityError extends Error {
  readonly code: ExternalIdentityErrorCode;
  constructor(code: ExternalIdentityErrorCode) {
    super(code);
    this.code = code;
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
  await appendPlatformAuditLog({
    userId: input.actorUserId,
    action: "identity.external_mapping.link",
    category: "identity.federation",
    severity: "info",
    source: "identity_service",
    outcome: "success",
    resourceType: "external_identity_mapping",
    resourceId: created.id,
    metadata: {
      teamId: input.teamId,
      subjectUserId: input.userId,
      provider: input.provider,
    },
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    db: client,
  });
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
  await appendPlatformAuditLog({
    userId: input.actorUserId,
    action: "identity.external_mapping.unlink",
    category: "identity.federation",
    severity: "info",
    source: "identity_service",
    outcome: "success",
    resourceType: "external_identity_mapping",
    resourceId: mapping.id,
    metadata: {
      teamId: input.teamId,
      subjectUserId: mapping.userId,
      provider: mapping.provider,
    },
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    db: client,
  });
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
