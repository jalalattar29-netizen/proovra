/**
 * Phase 17 — Organization Security Policy service.
 *
 * Reads + writes the 1:1 OrganizationSecurityPolicy row for a team.
 * The policy stores org-level posture (MFA readiness, allowed email
 * domains, IP restrictions, session timeouts, SSO/SCIM readiness flags).
 *
 * Phase 17 enforcement scope:
 *   - allowedEmailDomains: enforced when a member is invited or a new
 *     external identity mapping is linked (caller checks).
 *   - restrictedIpRanges: enforced by the integrations-auth middleware
 *     for service accounts (intersection of org list and per-credential
 *     list; both empty = no restriction).
 *   - reviewerSessionTimeoutSeconds / contributorSessionTimeoutSeconds:
 *     read by the JWT layer / intake-token issuer in later phases.
 *   - mfaRequiredFlag / ssoReadyFlag / scimReadyFlag: stored, surfaced
 *     in the /identity UI, NOT enforced in Phase 17.
 */

import type { PrismaClient } from "@prisma/client";

import { type OrgSecurityPolicy, ORG_SECURITY_POLICY_DEFAULTS } from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";

export type LoadedOrgSecurityPolicy = OrgSecurityPolicy & {
  teamId: string;
  updatedAt: Date | null;
  updatedByUserId: string | null;
};

export async function getOrgSecurityPolicy(
  teamId: string,
  client: PrismaClient = defaultPrisma,
): Promise<LoadedOrgSecurityPolicy> {
  const row = await client.organizationSecurityPolicy.findUnique({
    where: { teamId },
  });
  if (!row) {
    return {
      ...ORG_SECURITY_POLICY_DEFAULTS,
      teamId,
      updatedAt: null,
      updatedByUserId: null,
    };
  }
  return {
    mfaRequiredFlag: row.mfaRequiredFlag,
    allowedEmailDomains: row.allowedEmailDomains,
    restrictedIpRanges: row.restrictedIpRanges,
    reviewerSessionTimeoutSeconds: row.reviewerSessionTimeoutSeconds,
    contributorSessionTimeoutSeconds: row.contributorSessionTimeoutSeconds,
    ssoReadyFlag: row.ssoReadyFlag,
    scimReadyFlag: row.scimReadyFlag,
    notes: row.notes,
    teamId: row.teamId,
    updatedAt: row.updatedAt,
    updatedByUserId: row.updatedByUserId,
  };
}

export type UpdateOrgSecurityPolicyInput = {
  teamId: string;
  actorUserId: string;
  // All optional — only provided keys are updated.
  mfaRequiredFlag?: boolean;
  allowedEmailDomains?: ReadonlyArray<string>;
  restrictedIpRanges?: ReadonlyArray<string>;
  reviewerSessionTimeoutSeconds?: number | null;
  contributorSessionTimeoutSeconds?: number | null;
  ssoReadyFlag?: boolean;
  scimReadyFlag?: boolean;
  notes?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

function normaliseDomains(
  raw: ReadonlyArray<string>,
): string[] {
  const out: string[] = [];
  for (const entry of raw) {
    const trimmed = entry.trim().toLowerCase();
    if (trimmed.length === 0 || trimmed.length > 253) continue;
    // Basic sanity: must contain a dot. Reject anything else.
    if (!trimmed.includes(".")) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function normaliseCidrs(
  raw: ReadonlyArray<string>,
): string[] {
  const out: string[] = [];
  for (const entry of raw) {
    const trimmed = entry.trim();
    if (trimmed.length === 0 || trimmed.length > 64) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function clampTimeoutSeconds(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.min(86_400, Math.floor(value));
}

export async function upsertOrgSecurityPolicy(
  input: UpdateOrgSecurityPolicyInput,
  client: PrismaClient = defaultPrisma,
): Promise<LoadedOrgSecurityPolicy> {
  const current = await getOrgSecurityPolicy(input.teamId, client);
  const merged: OrgSecurityPolicy = {
    mfaRequiredFlag:
      input.mfaRequiredFlag !== undefined
        ? input.mfaRequiredFlag
        : current.mfaRequiredFlag,
    allowedEmailDomains:
      input.allowedEmailDomains !== undefined
        ? normaliseDomains(input.allowedEmailDomains)
        : current.allowedEmailDomains,
    restrictedIpRanges:
      input.restrictedIpRanges !== undefined
        ? normaliseCidrs(input.restrictedIpRanges)
        : current.restrictedIpRanges,
    reviewerSessionTimeoutSeconds:
      input.reviewerSessionTimeoutSeconds !== undefined
        ? clampTimeoutSeconds(input.reviewerSessionTimeoutSeconds)
        : current.reviewerSessionTimeoutSeconds,
    contributorSessionTimeoutSeconds:
      input.contributorSessionTimeoutSeconds !== undefined
        ? clampTimeoutSeconds(input.contributorSessionTimeoutSeconds)
        : current.contributorSessionTimeoutSeconds,
    ssoReadyFlag:
      input.ssoReadyFlag !== undefined
        ? input.ssoReadyFlag
        : current.ssoReadyFlag,
    scimReadyFlag:
      input.scimReadyFlag !== undefined
        ? input.scimReadyFlag
        : current.scimReadyFlag,
    notes:
      input.notes !== undefined
        ? (input.notes ?? null)?.slice(0, 2000) ?? null
        : current.notes,
  };

  const row = await client.organizationSecurityPolicy.upsert({
    where: { teamId: input.teamId },
    create: {
      teamId: input.teamId,
      ...merged,
      updatedByUserId: input.actorUserId,
    },
    update: {
      ...merged,
      updatedByUserId: input.actorUserId,
    },
  });

  safeEmitSecurityEvent(
    {
      teamId: input.teamId,
      eventType: "org_security_policy_updated",
      severity: "INFO",
      details: {
        actorUserId: input.actorUserId,
        // Audit ONLY the keys the caller passed in — don't echo back
        // the whole policy snapshot (avoids accidental drift signals).
        changes: Object.fromEntries(
          Object.entries(input).filter(
            ([k, v]) =>
              k !== "teamId" &&
              k !== "actorUserId" &&
              k !== "ipAddress" &&
              k !== "userAgent" &&
              v !== undefined,
          ),
        ),
      },
    },
    client,
  );
  await appendPlatformAuditLog({
    userId: input.actorUserId,
    action: "identity.org_policy.update",
    category: "identity.governance",
    severity: "info",
    source: "identity_service",
    outcome: "success",
    resourceType: "organization_security_policy",
    resourceId: input.teamId,
    metadata: {
      mfaRequiredFlag: merged.mfaRequiredFlag,
      ssoReadyFlag: merged.ssoReadyFlag,
      scimReadyFlag: merged.scimReadyFlag,
      reviewerSessionTimeoutSeconds: merged.reviewerSessionTimeoutSeconds,
      contributorSessionTimeoutSeconds: merged.contributorSessionTimeoutSeconds,
      allowedEmailDomainsCount: merged.allowedEmailDomains.length,
      restrictedIpRangesCount: merged.restrictedIpRanges.length,
    },
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    db: client,
  });

  return {
    ...merged,
    teamId: row.teamId,
    updatedAt: row.updatedAt,
    updatedByUserId: row.updatedByUserId,
  };
}
