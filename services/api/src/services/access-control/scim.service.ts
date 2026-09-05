/**
 * Phase 26 — SCIM v2 service.
 *
 * Implements the operator-safe subset of RFC 7644 needed for IdP-driven
 * lifecycle management:
 *   - POST /Users               create + provision
 *   - GET  /Users/:id           read
 *   - GET  /Users?filter=...    list (by userName eq, by externalId eq)
 *   - PUT  /Users/:id           full replace (active + emails + name)
 *   - PATCH /Users/:id          patch op (active replace — IdP deactivation)
 *   - DELETE /Users/:id         deactivate (no hard delete)
 *
 * Hard rules:
 *   - Authentication via `ScimProvisioningToken` only; the API session
 *     JWT path is NEVER accepted here.
 *   - Idempotency: POST with an existing externalId returns the
 *     existing resource (200, not 201).
 *   - Deprovisioning is SOFT: TeamMember.status = SUSPENDED + the
 *     external mapping unlinked. The User row is preserved for audit.
 *   - Operator-safe fields only: userName, displayName, emails,
 *     active, externalId. Phone numbers / addresses ignored.
 *   - All operations audited via SecurityEvent + appendPlatformAuditLog.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type {
  PrismaClient,
  ScimProvisioningToken as DbToken,
} from "@prisma/client";
import {
  SCIM_SCOPES,
  SCIM_TOKEN_BYTES,
  SCIM_TOKEN_PREFIX,
  SCIM_TOKEN_PREFIX_LENGTH,
  SCIM_USER_SCHEMA_URI,
  SCIM_LIST_RESPONSE_SCHEMA_URI,
  ScimUserSchema,
  scimError,
  type ScimEmail,
  type ScimScope,
  type ScimUserInput,
  type ScimUserResource,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
// PHASE 10 §3 — atomic managed-identity binding (persistence-verified SCIM token).
import { resolveManagedIdentity } from "../identity/identity-mode.service.js";
import {
  organizationIdForPolicy,
  resolveOrganizationPolicy,
} from "../identity/org-security-policy.service.js";
// ARCH-004 — governance-membership transitions have ONE orchestrator.
import {
  restoreOrganizationMembership,
  suspendOrganizationMembership,
} from "../identity/org-membership-lifecycle.service.js";

/**
 * The marker a SCIM deactivation writes on the governance membership it
 * suspends, so reactivation restores EXACTLY that set. A membership a human
 * administrator suspended carries a different reason and is never reinstated
 * by a directory push.
 */
export const SCIM_DEACTIVATION_MEMBERSHIP_MARKER =
  "scim_deactivated:governance_membership_paused";
// P0 remediation (2026-07-21) — canonical guard for linking a directory-
// asserted email to a PRE-EXISTING User (cross-tenant takeover fix).
import { evaluateExistingAccountLink } from "../security/enterprise-account-linking.service.js";
// P0 remediation (2026-07-21) — SCIM deactivation revokes sessions
// immediately (same primitive as RBAC suspend).
import { revokeAllSessionsForUser } from "../identity-security/session-revocation.service.js";
// PHASE 3 (2026-07-21) — canonical membership orchestrator.
import {
  applyDirectoryRoleChange,
  provisionMembership,
  provisionManagedMembership,
  suspendWorkspaceMembership,
} from "../identity/membership-provisioning.service.js";
import { enforceScimManagedOwnership } from "./scim-managed-ownership.service.js";
import { resolveTeamEnterpriseFeatureGate } from "../enterprise-gate-resolvers.service.js";

// -----------------------------------------------------------------------------
// Token hashing
// -----------------------------------------------------------------------------

function hashToken(token: string): string {
  const key = process.env["AUTH_SECRET"] || process.env["JWT_SECRET"] || "";
  if (key) {
    return createHash("sha256")
      .update(key + ":" + token)
      .digest("hex");
  }
  return createHash("sha256").update(token).digest("hex");
}

function constantTimeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

// -----------------------------------------------------------------------------
// Token CRUD (admin path)
// -----------------------------------------------------------------------------

export type ScimTokenProjection = {
  id: string;
  teamId: string;
  name: string;
  tokenPrefix: string;
  scopes: ReadonlyArray<ScimScope>;
  status: "ACTIVE" | "REVOKED";
  ipAllowlist: ReadonlyArray<string>;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAtUtc: string | null;
  expiresAtUtc: string | null;
  revokedAtUtc: string | null;
  revokedByUserId: string | null;
};

function projectToken(row: DbToken): ScimTokenProjection {
  return {
    id: row.id,
    teamId: row.teamId,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    scopes: row.scopes as ScimScope[],
    status: row.status as ScimTokenProjection["status"],
    ipAllowlist: row.ipAllowlist,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastUsedAtUtc: row.lastUsedAtUtc?.toISOString() ?? null,
    expiresAtUtc: row.expiresAtUtc?.toISOString() ?? null,
    revokedAtUtc: row.revokedAtUtc?.toISOString() ?? null,
    revokedByUserId: row.revokedByUserId,
  };
}

export type CreateScimTokenInput = {
  teamId: string;
  actorUserId: string;
  name: string;
  scopes: ScimScope[];
  ipAllowlist?: string[];
  expiresAtUtc?: Date | null;
};

export type CreateScimTokenResult = {
  projection: ScimTokenProjection;
  /** The raw token. Returned ONCE; never persisted in plaintext. */
  tokenOnce: string;
};

export async function createScimToken(
  input: CreateScimTokenInput,
  client: PrismaClient = defaultPrisma,
): Promise<CreateScimTokenResult> {
  // Validate scopes against the catalog.
  for (const s of input.scopes) {
    if (!SCIM_SCOPES.includes(s)) {
      throw new Error(`SCIM scope not in catalog: ${s}`);
    }
  }
  const raw = `${SCIM_TOKEN_PREFIX}${randomBytes(SCIM_TOKEN_BYTES).toString("hex")}`;
  const tokenPrefix = raw.slice(0, SCIM_TOKEN_PREFIX_LENGTH);
  const tokenHash = hashToken(raw);
  const row = await client.scimProvisioningToken.create({
    data: {
      teamId: input.teamId,
      name: input.name.slice(0, 180),
      tokenPrefix,
      tokenHash,
      scopes: input.scopes,
      ipAllowlist: input.ipAllowlist ?? [],
      expiresAtUtc: input.expiresAtUtc ?? null,
      createdByUserId: input.actorUserId,
    },
  });
  bump("scim_token_created_total");
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "scim_token_created",
    severity: "WARNING",
    details: {
      tokenId: row.id,
      tokenPrefix,
      scopes: input.scopes,
      actorUserId: input.actorUserId,
    },
  });
  // The credential's whole lifecycle reads the same way in the audit trail:
  // where it came from, where it went, and whether the entitlement that
  // permits SCIM was live at the time. The prefix identifies the token; the
  // secret and its hash are never recorded.
  const entitlement = await resolveTeamEnterpriseFeatureGate(input.teamId, "ssoScim");
  await emitTenantAudit({
    action: "scim.token.create",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.actorUserId,
    actorAuthority: "WORKSPACE_IDENTITY_ADMIN",
    workspaceId: input.teamId,
    resourceType: "scim_provisioning_token",
    resourceId: row.id,
    // PHASE 5 — the token is named by its PREFIX, which is the same redacted
    // identifier the list projection shows. The secret and its hash are never
    // recorded, here or anywhere.
    targetDisplay: `SCIM token ${tokenPrefix}`,
    previousState: null,
    requestedState: "ACTIVE",
    resultingState: row.status,
    // Whether the entitlement was live AT THE TIME is what lets an auditor
    // tell a routine creation from one made during a lapsed subscription.
    reasonCode: entitlement.ok ? "ENTITLED_AT_ISSUE" : "ISSUED_WITHOUT_LIVE_ENTITLEMENT",
    metadata: {
      scopes: input.scopes,
      tokenPrefix,
      previousStatus: null,
      nextStatus: "ACTIVE",
      entitlementActive: entitlement.ok,
    },
  }, client);
  return { projection: projectToken(row), tokenOnce: raw };
}

export async function listScimTokens(
  input: { teamId: string },
  client: PrismaClient = defaultPrisma,
): Promise<ReadonlyArray<ScimTokenProjection>> {
  const rows = await client.scimProvisioningToken.findMany({
    where: { teamId: input.teamId },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 100,
  });
  return rows.map(projectToken);
}

export async function revokeScimToken(
  input: {
    teamId: string;
    id: string;
    actorUserId: string;
    reason?: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<ScimTokenProjection | null> {
  const row = await client.scimProvisioningToken.findFirst({
    where: { id: input.id, teamId: input.teamId },
  });
  if (!row) return null;
  // Already revoked: return the same projection, write nothing, and emit
  // nothing. A second "first revocation" in the log would be a lie, and a
  // rewritten `revokedAtUtc` would move the moment the credential died.
  if (row.status === "REVOKED") return projectToken(row);

  /*
   * The status is re-checked IN the write, not just before it. Two
   * administrators clicking Revoke at the same moment both read ACTIVE, and a
   * plain `update` would let both through — two audit rows, two revocation
   * timestamps, for one credential that can only die once.
   */
  const claimed = await client.scimProvisioningToken.updateMany({
    where: { id: row.id, status: { not: "REVOKED" } },
    data: {
      status: "REVOKED",
      revokedAtUtc: new Date(),
      revokedByUserId: input.actorUserId,
      revokedReason: input.reason?.slice(0, 400) ?? null,
    },
  });
  const updated = await client.scimProvisioningToken.findUniqueOrThrow({
    where: { id: row.id },
  });
  if (claimed.count === 0) {
    // A concurrent caller won. They own the audit row for this transition.
    return projectToken(updated);
  }

  bump("scim_token_revoked_total");
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "scim_token_revoked",
    severity: "WARNING",
    details: {
      tokenId: row.id,
      tokenPrefix: row.tokenPrefix,
      actorUserId: input.actorUserId,
      previousStatus: row.status,
      nextStatus: "REVOKED",
    },
  });
  /*
   * Revocation had NO tenant audit row, while create and rotate both wrote
   * one — so the destructive leg of the credential lifecycle was the one leg
   * a customer could not see in their own audit trail.
   *
   * The entitlement state is recorded rather than enforced: revoke is
   * deliberately available without `ssoScim` (see the route), and reading it
   * here is what lets an auditor tell a routine revocation from one performed
   * after a downgrade. No secret and no hash is recorded — the prefix is the
   * same redacted identifier the list projection already exposes.
   */
  const entitlement = await resolveTeamEnterpriseFeatureGate(input.teamId, "ssoScim");
  await emitTenantAudit(
    {
      action: "scim.token.revoke",
      outcome: "success",
      sourceApp: "API",
      actorUserId: input.actorUserId,
      actorAuthority: "WORKSPACE_IDENTITY_ADMIN",
      workspaceId: input.teamId,
      resourceType: "scim_provisioning_token",
      resourceId: row.id,
      targetDisplay: `SCIM token ${row.tokenPrefix}`,
      previousState: row.status,
      requestedState: "REVOKED",
      resultingState: updated.status,
      // Revocation stays available after a downgrade by design: a customer
      // must always be able to destroy an existing credential. The reason
      // code is what distinguishes the two cases in the trail.
      reasonCode: entitlement.ok ? "OPERATOR_REVOKED" : "REVOKED_WITHOUT_LIVE_ENTITLEMENT",
      metadata: {
        tokenPrefix: row.tokenPrefix,
        previousStatus: row.status,
        nextStatus: "REVOKED",
        entitlementActive: entitlement.ok,
        reason: input.reason?.slice(0, 400) ?? null,
      },
    },
    client,
  );
  return projectToken(updated);
}

// -----------------------------------------------------------------------------
// PHASE 12B — ATOMIC token ROTATION.
//
// Rotation used to be "create a new token, then remember to revoke the old
// one" — two operator actions, so an abandoned rotation left TWO live
// credentials for the same directory. Revoke-old + issue-new is now ONE
// transaction: either the directory ends up with exactly one new credential,
// or nothing changed at all. The raw replacement token is returned ONCE and is
// never persisted in plaintext (hash-only, same contract as create).
// -----------------------------------------------------------------------------

export type RotateScimTokenResult =
  | { ok: true; revoked: ScimTokenProjection; projection: ScimTokenProjection; tokenOnce: string }
  | { ok: false; reason: "not_found" | "already_revoked" };

export async function rotateScimToken(
  input: {
    teamId: string;
    id: string;
    actorUserId: string;
    /** Optional replacement name; defaults to the rotated token's name. */
    name?: string | null;
    reason?: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<RotateScimTokenResult> {
  const existing = await client.scimProvisioningToken.findFirst({
    where: { id: input.id, teamId: input.teamId },
  });
  if (!existing) return { ok: false, reason: "not_found" };
  if (existing.status !== "ACTIVE") return { ok: false, reason: "already_revoked" };

  const raw = `${SCIM_TOKEN_PREFIX}${randomBytes(SCIM_TOKEN_BYTES).toString("hex")}`;
  const tokenPrefix = raw.slice(0, SCIM_TOKEN_PREFIX_LENGTH);
  const tokenHash = hashToken(raw);

  const result = await client.$transaction(async (tx) => {
    // Read-compare-write: only rotate the row we still observe as ACTIVE, so a
    // concurrent revoke/rotate cannot produce two live credentials.
    const claimed = await tx.scimProvisioningToken.updateMany({
      where: { id: existing.id, teamId: input.teamId, status: "ACTIVE" },
      data: {
        status: "REVOKED",
        revokedAtUtc: new Date(),
        revokedByUserId: input.actorUserId,
        revokedReason: (input.reason ?? "Rotated").slice(0, 400),
      },
    });
    if (claimed.count !== 1) {
      throw new Error("SCIM_TOKEN_ROTATE_CONFLICT");
    }
    const revoked = await tx.scimProvisioningToken.findUniqueOrThrow({
      where: { id: existing.id },
    });
    const created = await tx.scimProvisioningToken.create({
      data: {
        teamId: input.teamId,
        name: (input.name?.trim() || existing.name).slice(0, 180),
        tokenPrefix,
        tokenHash,
        scopes: existing.scopes,
        ipAllowlist: existing.ipAllowlist,
        expiresAtUtc: existing.expiresAtUtc,
        createdByUserId: input.actorUserId,
      },
    });
    return { revoked, created };
  });

  bump("scim_token_created_total");
  bump("scim_token_revoked_total");
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "scim_token_created",
    severity: "WARNING",
    details: {
      tokenId: result.created.id,
      tokenPrefix,
      rotatedFromTokenId: result.revoked.id,
      scopes: result.created.scopes,
      actorUserId: input.actorUserId,
    },
  });
  await emitTenantAudit({
    action: "scim.token.rotate",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.actorUserId,
    actorAuthority: "WORKSPACE_IDENTITY_ADMIN",
    workspaceId: input.teamId,
    resourceType: "scim_provisioning_token",
    resourceId: result.created.id,
    targetDisplay: `SCIM token ${tokenPrefix}`,
    // A rotation is two transitions on one action: the old credential dies
    // and a new one is issued. The states describe the NEW token, and the
    // retired one is named in metadata so the pair is reconstructable.
    previousState: result.revoked.status,
    requestedState: "ACTIVE",
    resultingState: result.created.status,
    reasonCode: "OPERATOR_ROTATED",
    metadata: {
      rotatedFromTokenId: result.revoked.id,
      scopes: result.created.scopes as string[],
    },
  }, client);

  return {
    ok: true,
    revoked: projectToken(result.revoked),
    projection: projectToken(result.created),
    tokenOnce: raw,
  };
}

// -----------------------------------------------------------------------------
// PHASE 12B — managed-membership OWNERSHIP projection (admin read).
//
// The SCIM administration surface has to answer "who in this workspace does the
// directory actually own, and is any of it in conflict?" without ever exposing
// a token or a raw IdP payload. Every field here is derived server-side from
// the canonical authorities; the browser computes nothing.
// -----------------------------------------------------------------------------

export type ScimManagedMemberProjection = {
  userId: string;
  email: string | null;
  displayName: string | null;
  externalSubjectId: string | null;
  /** Directory link state — an unlinked mapping is a RELEASED identity. */
  directoryLink: "LINKED" | "RELEASED" | "NONE";
  membershipStatus: string | null;
  role: string | null;
  /** Managed-identity ownership as resolved by the canonical authority. */
  ownership:
    | "MANAGED_BY_THIS_ORGANIZATION"
    | "MANAGED_BY_ANOTHER_ORGANIZATION"
    | "STANDARD"
    | "UNRESOLVED";
  /** True when the org policy requires managed identity but this one is not. */
  conflict: boolean;
};

export type ScimManagedMembershipProjection = {
  teamId: string;
  organizationId: string | null;
  managedIdentityRequired: boolean;
  summary: {
    total: number;
    managedByThisOrganization: number;
    managedByAnotherOrganization: number;
    standard: number;
    unresolved: number;
    released: number;
    conflicts: number;
  };
  members: ReadonlyArray<ScimManagedMemberProjection>;
  /** Group → mapped-role effect, so the operator sees what a group grants. */
  groups: ReadonlyArray<{
    id: string;
    displayName: string;
    externalId: string | null;
    mappedRole: string;
    status: string;
    memberCount: number;
  }>;
  truncated: boolean;
};

export async function projectScimManagedMembership(
  input: { teamId: string; limit?: number },
  client: PrismaClient = defaultPrisma,
): Promise<ScimManagedMembershipProjection> {
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
  const organizationId = await organizationIdForPolicy(input.teamId, client);
  let managedIdentityRequired = false;
  if (organizationId) {
    try {
      const policy = await resolveOrganizationPolicy(input.teamId, client);
      managedIdentityRequired =
        policy.applicability === "ORGANIZATION" &&
        policy.policy.managedIdentityRequired;
    } catch {
      // Policy unavailability must not fabricate "not required".
      managedIdentityRequired = true;
    }
  }

  const mappings = await client.externalIdentityMapping.findMany({
    where: { teamId: input.teamId },
    orderBy: [{ linkedAtUtc: "desc" }],
    take: limit + 1,
    select: {
      userId: true,
      externalSubjectId: true,
      displayName: true,
      externalEmail: true,
      unlinkedAtUtc: true,
    },
  });
  const truncated = mappings.length > limit;
  const rows = truncated ? mappings.slice(0, limit) : mappings;
  const userIds = Array.from(new Set(rows.map((r) => r.userId)));

  const [users, members] = await Promise.all([
    client.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true, displayName: true },
    }),
    client.teamMember.findMany({
      where: { teamId: input.teamId, userId: { in: userIds } },
      select: { userId: true, status: true, role: true },
    }),
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));
  const memberByUserId = new Map(members.map((m) => [m.userId, m]));

  const summary = {
    total: 0,
    managedByThisOrganization: 0,
    managedByAnotherOrganization: 0,
    standard: 0,
    unresolved: 0,
    released: 0,
    conflicts: 0,
  };
  const projected: ScimManagedMemberProjection[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.userId)) continue;
    seen.add(row.userId);
    let ownership: ScimManagedMemberProjection["ownership"];
    try {
      const managed = await resolveManagedIdentity(row.userId, client);
      if (managed.state === "MANAGED") {
        ownership =
          managed.managingOrganizationId === organizationId
            ? "MANAGED_BY_THIS_ORGANIZATION"
            : "MANAGED_BY_ANOTHER_ORGANIZATION";
      } else if (managed.state === "MANAGED_UNRESOLVED") {
        ownership = "UNRESOLVED";
      } else {
        ownership = "STANDARD";
      }
    } catch {
      // Fail closed in the projection too: never render an ambiguous
      // identity as clean STANDARD.
      ownership = "UNRESOLVED";
    }
    const user = userById.get(row.userId);
    const member = memberByUserId.get(row.userId);
    const directoryLink: ScimManagedMemberProjection["directoryLink"] =
      row.unlinkedAtUtc === null ? "LINKED" : "RELEASED";
    const conflict =
      ownership === "MANAGED_BY_ANOTHER_ORGANIZATION" ||
      ownership === "UNRESOLVED" ||
      (managedIdentityRequired && ownership === "STANDARD");

    summary.total += 1;
    if (ownership === "MANAGED_BY_THIS_ORGANIZATION") summary.managedByThisOrganization += 1;
    if (ownership === "MANAGED_BY_ANOTHER_ORGANIZATION") summary.managedByAnotherOrganization += 1;
    if (ownership === "STANDARD") summary.standard += 1;
    if (ownership === "UNRESOLVED") summary.unresolved += 1;
    if (directoryLink === "RELEASED") summary.released += 1;
    if (conflict) summary.conflicts += 1;

    projected.push({
      userId: row.userId,
      email: user?.email ?? row.externalEmail ?? null,
      displayName: row.displayName ?? user?.displayName ?? null,
      externalSubjectId: row.externalSubjectId,
      directoryLink,
      membershipStatus: member?.status ?? null,
      role: member?.role ?? null,
      ownership,
      conflict,
    });
  }

  const groupRows = await client.scimGroup.findMany({
    where: { teamId: input.teamId },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 100,
    select: {
      id: true,
      displayName: true,
      externalId: true,
      mappedRole: true,
      status: true,
    },
  });
  const groups = await Promise.all(
    groupRows.map(async (g) => ({
      ...g,
      memberCount: await client.teamMember.count({
        where: { teamId: input.teamId, status: "ACTIVE", role: g.mappedRole as never },
      }),
    })),
  );

  return {
    teamId: input.teamId,
    organizationId,
    managedIdentityRequired,
    summary,
    members: projected,
    groups,
    truncated,
  };
}

// -----------------------------------------------------------------------------
// Token authentication (called by the SCIM route middleware)
// -----------------------------------------------------------------------------

export type AuthenticatedScimToken = {
  id: string;
  teamId: string;
  scopes: ReadonlyArray<ScimScope>;
};

export type AuthenticateScimResult =
  | { ok: true; token: AuthenticatedScimToken }
  | {
      ok: false;
      reason:
        | "missing_token"
        | "invalid_token"
        | "revoked"
        | "expired"
        | "ip_not_allowed";
    };

export async function authenticateScimRequest(
  input: { authorizationHeader: string | undefined; remoteIp: string | null },
  client: PrismaClient = defaultPrisma,
): Promise<AuthenticateScimResult> {
  if (!input.authorizationHeader) {
    bump("scim_invalid_token_total");
    return { ok: false, reason: "missing_token" };
  }
  const m = /^Bearer\s+(.+)$/i.exec(input.authorizationHeader);
  if (!m) {
    bump("scim_invalid_token_total");
    return { ok: false, reason: "invalid_token" };
  }
  const raw = m[1].trim();
  if (!raw.startsWith(SCIM_TOKEN_PREFIX)) {
    bump("scim_invalid_token_total");
    return { ok: false, reason: "invalid_token" };
  }
  const hash = hashToken(raw);
  const row = await client.scimProvisioningToken.findUnique({
    where: { tokenHash: hash },
  });
  if (!row) {
    bump("scim_invalid_token_total");
    return { ok: false, reason: "invalid_token" };
  }
  // Constant-time hash check guards against timing oracle.
  if (!constantTimeEquals(row.tokenHash, hash)) {
    bump("scim_invalid_token_total");
    return { ok: false, reason: "invalid_token" };
  }
  if (row.status !== "ACTIVE") {
    return { ok: false, reason: "revoked" };
  }
  if (row.expiresAtUtc && row.expiresAtUtc.getTime() <= Date.now()) {
    return { ok: false, reason: "expired" };
  }
  if (row.ipAllowlist.length > 0 && input.remoteIp) {
    // Phase 26 keeps this as a simple equality / prefix check. CIDR
    // matching is a Phase 27 enhancement.
    const matched = row.ipAllowlist.some(
      (entry) =>
        input.remoteIp === entry || input.remoteIp?.startsWith(entry),
    );
    if (!matched) {
      return { ok: false, reason: "ip_not_allowed" };
    }
  }
  // Touch lastUsedAtUtc best-effort.
  client.scimProvisioningToken
    .update({
      where: { id: row.id },
      data: { lastUsedAtUtc: new Date() },
    })
    .catch(() => null);
  return {
    ok: true,
    token: {
      id: row.id,
      teamId: row.teamId,
      scopes: row.scopes as ScimScope[],
    },
  };
}

// -----------------------------------------------------------------------------
// SCIM User operations
// -----------------------------------------------------------------------------

function buildUserResource(input: {
  id: string;
  userName: string;
  displayName: string | null;
  active: boolean;
  emails: ReadonlyArray<ScimEmail>;
  externalId: string | null;
  created: Date;
  lastModified: Date;
  baseUrl: string;
}): ScimUserResource {
  return {
    schemas: [SCIM_USER_SCHEMA_URI],
    id: input.id,
    userName: input.userName,
    displayName: input.displayName,
    active: input.active,
    emails: input.emails,
    externalId: input.externalId,
    meta: {
      resourceType: "User",
      created: input.created.toISOString(),
      lastModified: input.lastModified.toISOString(),
      location: `${input.baseUrl}/Users/${input.id}`,
    },
  };
}

async function findUserBySubject(
  teamId: string,
  externalSubjectId: string,
  client: PrismaClient,
) {
  return client.externalIdentityMapping.findFirst({
    where: { teamId, externalSubjectId, unlinkedAtUtc: null },
  });
}

export type ScimCreateUserContext = {
  teamId: string;
  tokenId: string;
  baseUrl: string;
};

export type ScimCreateUserResult =
  | { ok: true; alreadyExisted: boolean; user: ScimUserResource }
  | { ok: false; status: number; detail: string };

export async function scimCreateUser(
  ctx: ScimCreateUserContext,
  input: ScimUserInput,
  client: PrismaClient = defaultPrisma,
): Promise<ScimCreateUserResult> {
  const parsed = ScimUserSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      detail: "invalid_scim_user_payload",
    };
  }
  const email =
    parsed.data.emails.find((e) => e.primary)?.value ??
    parsed.data.emails[0]?.value;
  if (!email) {
    return { ok: false, status: 400, detail: "missing_email" };
  }
  const externalId = parsed.data.externalId ?? parsed.data.userName;

  // Idempotent: existing mapping → return current resource.
  const existing = await findUserBySubject(ctx.teamId, externalId, client);
  if (existing) {
    const user = await client.user.findUnique({
      where: { id: existing.userId },
      select: {
        id: true,
        email: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!user) {
      return { ok: false, status: 500, detail: "user_lookup_failed" };
    }
    const member = await client.teamMember.findUnique({
      where: { teamId_userId: { teamId: ctx.teamId, userId: user.id } },
      select: { status: true },
    });
    return {
      ok: true,
      alreadyExisted: true,
      user: buildUserResource({
        id: user.id,
        userName: parsed.data.userName,
        displayName:
          parsed.data.displayName ??
          parsed.data.name?.formatted ??
          null,
        active: member?.status === "ACTIVE",
        emails: parsed.data.emails,
        externalId,
        created: user.createdAt,
        lastModified: user.updatedAt,
        baseUrl: ctx.baseUrl,
      }),
    };
  }

  // ---------------------------------------------------------------------------
  // PHASE 12B — ONE ATOMIC CREATE INTENT (zero partial mutation).
  //
  // Previously the User row, the ExternalIdentityMapping row and the
  // membership/managed-binding intent were THREE separate top-level writes: a
  // seat-exhausted or cross-Organization managed conflict left a created User
  // + a linked directory mapping with NO membership — a half-provisioned
  // identity the IdP believed existed. Everything now shares ONE transaction:
  // a failure anywhere leaves ZERO rows behind.
  //
  // The pre-existing-account link gate (P0 remediation 2026-07-21) also moves
  // INSIDE the transaction so the account it validates is the account the
  // mapping binds — read-compare-write, not read-then-hope.
  // ---------------------------------------------------------------------------
  const UNSAFE_LINK = "__SCIM_UNSAFE_ACCOUNT_LINK__";
  let user: { id: string; createdAt: Date; updatedAt: Date };
  try {
    user = await client.$transaction(async (tx) => {
      const txc = tx as unknown as PrismaClient;
      let resolved = await txc.user.findFirst({
        where: { email: email.toLowerCase() },
        select: { id: true, createdAt: true, updatedAt: true },
      });
      if (resolved) {
        // P0 remediation (2026-07-21) — linking a directory-asserted email to a
        // PRE-EXISTING account requires the domain to be DNS-verified by exactly
        // this token's own organization (globally-unique claim). Without this
        // gate, a SCIM push could bind a mapping onto an arbitrary existing
        // user's account — and the SSO repeat-login path would then mint
        // sessions AS that user for the directory's subject. Fail closed.
        const link = await evaluateExistingAccountLink(
          { teamId: ctx.teamId, email },
          txc,
        );
        if (!link.ok) {
          throw new Error(`${UNSAFE_LINK}:${link.reason}`);
        }
      } else {
        resolved = await txc.user.create({
          data: {
            email: email.toLowerCase(),
            provider: "EMAIL",
            providerUserId: `scim-${externalId}`,
          },
          select: { id: true, createdAt: true, updatedAt: true },
        });
      }

      // Link external mapping.
      await txc.externalIdentityMapping.create({
        data: {
          teamId: ctx.teamId,
          userId: resolved.id,
          provider: "GENERIC_SCIM",
          externalSubjectId: externalId,
          displayName:
            parsed.data.displayName ?? parsed.data.name?.formatted ?? null,
          externalEmail: email,
        },
      });

      // PHASE 3 (2026-07-21) + PHASE 10 §3 (2026-07-23) — managed provisioning.
      // SCIM is the authoritative directory. Membership (Membership
      // Orchestrator) + grant provenance + MANAGED-IDENTITY binding are ONE
      // atomic outcome: if the managed binding fails (e.g. the identity is
      // already managed by ANOTHER Organization → conflict), the User row,
      // mapping row, membership and grant ALL roll back. The managed source is
      // the AUTHENTICATED SCIM token credential (`ctx.tokenId`),
      // persistence-verified inside setManagedIdentity (never
      // findFirst/caller-declared). SCIM only manages CUSTOMER-org workspaces.
      const workspaceRole =
        parsed.data.userType === "VIEWER" ? "VIEWER" : "MEMBER";
      const scimOrgId = await organizationIdForPolicy(ctx.teamId, txc);
      if (scimOrgId) {
        // PATH 1/9 — SCIM CREATE via the ONE atomic managed-provisioning
        // intent: managed binding (evidence = authenticated SCIM token) +
        // fail-closed seat enforcement + membership/grant provenance.
        await provisionManagedMembership(tx, {
          userId: resolved.id,
          managingTeamId: ctx.teamId,
          evidence: { source: "SCIM", scimTokenId: ctx.tokenId },
          membershipIntent: "SCIM_PROVISIONING",
          source: "SCIM",
          workspace: { teamId: ctx.teamId, role: workspaceRole },
          actorUserId: null, // the directory, not a member, is the actor
          externalRef: externalId ? `scim:${externalId}`.slice(0, 200) : null,
          accessReason: "SCIM provisioning",
          seatPolicy: "ENFORCE",
          seatTeamId: ctx.teamId,
        });
      } else {
        // Non-CUSTOMER SCIM target (no managing org to bind) — membership only.
        await provisionMembership(txc, {
          intent: "SCIM_PROVISIONING",
          source: "SCIM",
          userId: resolved.id,
          workspace: { teamId: ctx.teamId, role: workspaceRole },
          actorUserId: null,
          externalRef: externalId ? `scim:${externalId}`.slice(0, 200) : null,
          accessReason: "SCIM provisioning",
        });
      }

      return resolved;
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.startsWith(UNSAFE_LINK)) {
      bump("scim_account_link_denied_total");
      safeEmitSecurityEvent({
        teamId: ctx.teamId,
        eventType: "scim_account_link_denied",
        severity: "HIGH",
        details: {
          reason: `unsafe_account_link:${message.slice(UNSAFE_LINK.length + 1)}`,
          externalId,
        },
      });
      return { ok: false as const, status: 409, detail: "unsafe_account_link" };
    }
    const code = (err as { code?: string }).code;
    if (
      code === "SCIM_MANAGED_CROSS_ORG_CONFLICT" ||
      code === "MANAGED_IDENTITY_CROSS_ORG_CONFLICT"
    ) {
      safeEmitSecurityEvent({
        teamId: ctx.teamId,
        eventType: "scim_user_created",
        severity: "HIGH",
        details: {
          tokenId: ctx.tokenId,
          externalId,
          outcome: "denied",
          reason: "managed_cross_org_conflict",
        },
      });
      return {
        ok: false as const,
        status: 409,
        detail: "managed_cross_org_conflict",
      };
    }
    if (code === "MANAGED_SEAT_LIMIT_REACHED") {
      return { ok: false as const, status: 409, detail: "seat_limit_reached" };
    }
    throw err; // schema-unavailability / unknown — fail closed
  }

  bump("scim_user_created_total");
  bump("scim_sync_total");
  safeEmitSecurityEvent({
    teamId: ctx.teamId,
    eventType: "scim_user_created",
    severity: "INFO",
    details: { tokenId: ctx.tokenId, userId: user.id, externalId },
  });
  await emitTenantAudit({
    action: "scim.user.create",
    outcome: "success",
    sourceApp: "SCIM",
    actorUserId: null,
    serviceActor: "scim_service",
    workspaceId: ctx.teamId,
    resourceType: "user",
    resourceId: user.id,
    metadata: { externalId },
  }, client);

  return {
    ok: true,
    alreadyExisted: false,
    user: buildUserResource({
      id: user.id,
      userName: parsed.data.userName,
      displayName:
        parsed.data.displayName ?? parsed.data.name?.formatted ?? null,
      active: true,
      emails: parsed.data.emails,
      externalId,
      created: user.createdAt,
      lastModified: user.updatedAt,
      baseUrl: ctx.baseUrl,
    }),
  };
}

export async function scimReadUser(
  ctx: ScimCreateUserContext,
  userId: string,
  client: PrismaClient = defaultPrisma,
): Promise<ScimUserResource | null> {
  const user = await client.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, createdAt: true, updatedAt: true },
  });
  if (!user) return null;
  const mapping = await client.externalIdentityMapping.findFirst({
    where: { teamId: ctx.teamId, userId: user.id, unlinkedAtUtc: null },
  });
  if (!mapping) return null;
  const member = await client.teamMember.findUnique({
    where: { teamId_userId: { teamId: ctx.teamId, userId: user.id } },
    select: { status: true },
  });
  const email = user.email ?? "";
  return buildUserResource({
    id: user.id,
    userName: mapping.externalEmail ?? email,
    displayName: mapping.displayName,
    active: member?.status === "ACTIVE",
    emails: email ? [{ value: email, primary: true }] : [],
    externalId: mapping.externalSubjectId,
    created: user.createdAt,
    lastModified: user.updatedAt,
    baseUrl: ctx.baseUrl,
  });
}

export async function scimListUsers(
  ctx: ScimCreateUserContext,
  input: { filter?: string; startIndex?: number; count?: number },
  client: PrismaClient = defaultPrisma,
): Promise<{
  schemas: [typeof SCIM_LIST_RESPONSE_SCHEMA_URI];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: ReadonlyArray<ScimUserResource>;
}> {
  const startIndex = Math.max(1, Math.floor(input.startIndex ?? 1));
  const count = Math.min(Math.max(Math.floor(input.count ?? 50), 1), 200);

  // Parse a tiny SCIM filter subset: `userName eq "x"` or `externalId eq "x"`.
  let externalSubjectIdEq: string | undefined;
  if (input.filter) {
    const m =
      /^(userName|externalId)\s+eq\s+"([^"]+)"$/i.exec(input.filter.trim());
    if (m) externalSubjectIdEq = m[2];
  }

  const where = {
    teamId: ctx.teamId,
    unlinkedAtUtc: null,
    ...(externalSubjectIdEq
      ? { externalSubjectId: externalSubjectIdEq }
      : {}),
  };
  const totalResults = await client.externalIdentityMapping.count({ where });
  const mappings = await client.externalIdentityMapping.findMany({
    where,
    skip: startIndex - 1,
    take: count,
    orderBy: { createdAt: "desc" },
  });

  const userIds = mappings.map((m) => m.userId);
  const users = await client.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, email: true, createdAt: true, updatedAt: true },
  });
  const userById = new Map(users.map((u) => [u.id, u]));
  const members = await client.teamMember.findMany({
    where: { teamId: ctx.teamId, userId: { in: userIds } },
    select: { userId: true, status: true },
  });
  const memberByUserId = new Map(members.map((m) => [m.userId, m]));

  const resources: ScimUserResource[] = [];
  for (const m of mappings) {
    const u = userById.get(m.userId);
    if (!u) continue;
    const member = memberByUserId.get(m.userId);
    const email = u.email ?? "";
    resources.push(
      buildUserResource({
        id: u.id,
        userName: m.externalEmail ?? email,
        displayName: m.displayName,
        active: member?.status === "ACTIVE",
        emails: email ? [{ value: email, primary: true }] : [],
        externalId: m.externalSubjectId,
        created: u.createdAt,
        lastModified: u.updatedAt,
        baseUrl: ctx.baseUrl,
      }),
    );
  }

  return {
    schemas: [SCIM_LIST_RESPONSE_SCHEMA_URI],
    totalResults,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

export async function scimDeactivateUser(
  ctx: ScimCreateUserContext,
  userId: string,
  client: PrismaClient = defaultPrisma,
): Promise<{ ok: boolean }> {
  const member = await client.teamMember.findUnique({
    where: { teamId_userId: { teamId: ctx.teamId, userId } },
  });
  if (!member) return { ok: false };
  // PHASE 12B — the membership suspension and the directory-mapping unlink are
  // ONE atomic deprovisioning outcome. Previously they were two top-level
  // writes, so a failure between them left a SUSPENDED member still linked (or
  // an unlinked mapping on an ACTIVE member) — the exact drift the
  // reconciliation surface then had to clean up.
  //
  // NOTE: managed identity is deliberately NOT cleared. Deactivation is a
  // SOFT release of *access*; a managed identity is never silently converted
  // back to unmanaged by a directory push.
  await client.$transaction(async (tx) => {
    const txc = tx as unknown as PrismaClient;
    // PHASE 3 (2026-07-21) — canonical orchestrator: MEMBER_SUSPENSION.
    await suspendWorkspaceMembership(txc, {
      teamMemberId: member.id,
      actorUserId: null, // directory-driven
      reason: "SCIM deactivation",
    });
    // Unlink the external mapping (soft).
    await txc.externalIdentityMapping.updateMany({
      where: { teamId: ctx.teamId, userId, unlinkedAtUtc: null },
      data: { unlinkedAtUtc: new Date() },
    });

    /**
     * PHASE 12 CORRECTIVE PASS §2 (ARCH-004, 2026-08-07) — THE GOVERNANCE
     * MEMBERSHIP IS SUSPENDED TOO, IN THE SAME TRANSACTION.
     *
     * SCIM deactivation suspended the WORKSPACE membership and left the
     * ORGANIZATION membership ACTIVE. That was invisible while governance
     * membership had no lifecycle — there was nothing to set — and it becomes
     * a real gap the moment there is: a directory that has deprovisioned
     * somebody would still have shown them as a live governance member, in the
     * roster, in the seat count, and in their own context envelope.
     *
     * SUSPENDED, not REVOKED, deliberately: a directory push is reversible by
     * the next directory push, and `scimReactivateUser` restores it. Terminal
     * removal stays a human decision.
     */
    // The SCIM context is workspace-scoped, so the Organization is derived
    // from the workspace rather than trusted from the caller.
    const team = await txc.team.findUnique({
      where: { id: ctx.teamId },
      select: { organizationId: true },
    });
    const orgMembership = team
      ? await txc.organizationMembership.findFirst({
          where: {
            organizationId: team.organizationId,
            userId,
            status: "ACTIVE",
          },
          select: { id: true },
        })
      : null;
    if (team && orgMembership) {
      await suspendOrganizationMembership({
        prisma: txc as never,
        organizationId: team.organizationId,
        membershipId: orgMembership.id,
        actorUserId: null, // directory-driven
        source: "SCIM",
        reason: SCIM_DEACTIVATION_MEMBERSHIP_MARKER,
      });
    }
  });

  // -------------------------------------------------------------------------
  // P0 remediation (2026-07-21) — IdP-driven deprovisioning must stop access
  // RAPIDLY, not at 30-day JWT expiry:
  //
  //   1. Revoke every active session for the user (deny-list, ALL_FOR_USER —
  //      same primitive the RBAC suspend path already uses). Sessions are
  //      account-global JWTs, so this forces a re-login; the user can log
  //      back into their untouched Personal Space immediately.
  //   2. Heal the active-context pointer when it points at the team the
  //      directory just deactivated them from, so the next login lands in
  //      their Personal Space instead of a 403 loop.
  //
  // Both are best-effort-ordered AFTER the membership suspension so access
  // is already denied server-side even if a later step fails.
  // -------------------------------------------------------------------------
  try {
    await revokeAllSessionsForUser(
      { teamId: ctx.teamId, userId, reason: "SCIM_DEACTIVATED" },
      client,
    );
  } catch {
    bump("security_event_emit_failed");
  }
  try {
    await client.user.updateMany({
      where: { id: userId, currentWorkspaceId: ctx.teamId },
      data: { currentWorkspaceId: null },
    });
  } catch {
    /* pointer healing is best-effort; buildPlatformContext also heals */
  }

  bump("scim_user_deactivated_total");
  bump("scim_sync_total");
  safeEmitSecurityEvent({
    teamId: ctx.teamId,
    eventType: "scim_user_deactivated",
    severity: "INFO",
    details: { tokenId: ctx.tokenId, userId },
  });
  await emitTenantAudit({
    action: "scim.user.deactivate",
    outcome: "success",
    sourceApp: "SCIM",
    actorUserId: null,
    serviceActor: "scim_service",
    workspaceId: ctx.teamId,
    resourceType: "user",
    resourceId: userId,
    metadata: {},
  }, client);
  return { ok: true };
}

/**
 * SCIM User reactivation.
 *
 * Flips the TeamMember from SUSPENDED back to ACTIVE and re-links the
 * external identity mapping that `scimDeactivateUser` soft-unlinked, so
 * `scimReadUser` (which filters on `unlinkedAtUtc: null`) resolves the
 * user again. Evidence/case/custody ownership is untouched — this only
 * restores the *access* record, never re-creates or moves owned data.
 *
 * Returns `{ ok:false, notFound:true }` when there is no member row at
 * all (nothing to reactivate).
 */
export async function scimReactivateUser(
  ctx: ScimCreateUserContext,
  userId: string,
  client: PrismaClient = defaultPrisma,
): Promise<{ ok: boolean; notFound?: boolean }> {
  const member = await client.teamMember.findUnique({
    where: { teamId_userId: { teamId: ctx.teamId, userId } },
  });
  if (!member) return { ok: false, notFound: true };

  if (member.status !== "ACTIVE") {
    // PATH 5/9 — SCIM REACTIVATE. Directory-driven re-activation is an explicit
    // SCIM re-grant (covers SUSPENDED + legacy REVOKED). §1.5: revalidate token
    // (ctx is the authenticated token), RECHECK seat (fail-closed), re-affirm
    // managed binding (idempotent — same org is a no-op), provision through the
    // orchestrator. All atomic: seat exhaustion rolls back the reactivation.
    const scimOrgId = await organizationIdForPolicy(ctx.teamId, client);
    await client.$transaction(async (tx) => {
      if (scimOrgId) {
        await provisionManagedMembership(tx, {
          userId,
          managingTeamId: ctx.teamId,
          evidence: { source: "SCIM", scimTokenId: ctx.tokenId },
          membershipIntent: "SCIM_PROVISIONING",
          source: "SCIM",
          workspace: { teamId: ctx.teamId, role: member.role as never },
          actorUserId: null,
          accessReason: "SCIM reactivation",
          seatPolicy: "ENFORCE",
          seatTeamId: ctx.teamId,
        });
      } else {
        await provisionMembership(tx as unknown as typeof client, {
          intent: "SCIM_PROVISIONING",
          source: "SCIM",
          userId,
          workspace: { teamId: ctx.teamId, role: member.role as never },
          actorUserId: null,
          accessReason: "SCIM reactivation",
        });
      }
    });
  }

  /**
   * ARCH-004 — restore EXACTLY the governance membership SCIM deactivation
   * suspended, matched on the marker reason.
   *
   * Marker-matched for the same reason the Organization resume leg is: a
   * membership a human administrator suspended must NOT be reinstated by a
   * directory push. A directory can undo its own action and nothing else.
   */
  const reactivateOrg = await organizationIdForPolicy(ctx.teamId, client);
  if (reactivateOrg) {
    const suspendedByScim = await client.organizationMembership.findFirst({
      where: {
        organizationId: reactivateOrg,
        userId,
        status: "SUSPENDED",
        suspensionReason: SCIM_DEACTIVATION_MEMBERSHIP_MARKER,
      },
      select: { id: true },
    });
    if (suspendedByScim) {
      await restoreOrganizationMembership({
        organizationId: reactivateOrg,
        membershipId: suspendedByScim.id,
        actorUserId: null, // directory-driven
        source: "SCIM",
        reason: "SCIM reactivation",
      });
    }
  }

  // Re-link the most recent external mapping so the resource is
  // resolvable again. We only re-link, never create a duplicate.
  const mapping = await client.externalIdentityMapping.findFirst({
    where: { teamId: ctx.teamId, userId },
    orderBy: { linkedAtUtc: "desc" },
  });
  if (mapping && mapping.unlinkedAtUtc !== null) {
    await client.externalIdentityMapping.update({
      where: { id: mapping.id },
      data: { unlinkedAtUtc: null },
    });
  }

  bump("scim_user_reactivated_total");
  bump("scim_sync_total");
  safeEmitSecurityEvent({
    teamId: ctx.teamId,
    eventType: "scim_user_reactivated",
    severity: "INFO",
    details: { tokenId: ctx.tokenId, userId },
  });
  await emitTenantAudit({
    action: "scim.user.reactivate",
    outcome: "success",
    sourceApp: "SCIM",
    actorUserId: null,
    serviceActor: "scim_service",
    workspaceId: ctx.teamId,
    resourceType: "user",
    resourceId: userId,
    metadata: {},
  }, client);
  return { ok: true };
}

// -----------------------------------------------------------------------------
// SCIM User attribute update (PATCH replace, non-`active` attributes).
//
// The data model can honestly persist exactly two attribute families:
//   - displayName / name.formatted → ExternalIdentityMapping.displayName
//   - userType / role              → TeamMember.role  (VIEWER→VIEWER,
//                                     MEMBER/REVIEWER→MEMBER; OWNER/ADMIN
//                                     never assigned via SCIM — privileged
//                                     roles require explicit operator action)
//
// Anything else (phoneNumbers, addresses, emails rewrite, title, …) is
// NOT persisted; the route returns a spec-correct error rather than
// pretending success. This helper reports which attributes it applied so
// the route can decide between 200 (something applied) and a clear
// "no supported target" response.
// -----------------------------------------------------------------------------

export type ScimUserAttributeUpdate = {
  displayName?: string | null;
  role?: "VIEWER" | "MEMBER";
};

export type ScimUpdateUserResult =
  | { ok: true; appliedFields: ReadonlyArray<string> }
  | { ok: false; status: number; detail: string; scimType?: string };

export async function scimUpdateUserAttributes(
  ctx: ScimCreateUserContext,
  userId: string,
  update: ScimUserAttributeUpdate,
  client: PrismaClient = defaultPrisma,
): Promise<ScimUpdateUserResult> {
  const member = await client.teamMember.findUnique({
    where: { teamId_userId: { teamId: ctx.teamId, userId } },
    select: { id: true, role: true },
  });
  if (!member) {
    return { ok: false, status: 404, detail: "user_not_found" };
  }

  // No supported attribute target at all → 400 BEFORE any work (zero mutation,
  // no reconciliation for a no-op PATCH).
  if (update.displayName === undefined && update.role === undefined) {
    return { ok: false, status: 400, detail: "no_supported_attribute_target", scimType: "noTarget" };
  }

  // PATH 2/9 — ATOMIC: managed-ownership reconciliation + attribute/role
  // transition share ONE transaction. Ownership is ENFORCED (never assumed):
  // cross-org / unresolved / schema-unavailable throw with ZERO mutation; a
  // STANDARD user in a managed-required org is reconciled first — and if the
  // later role transition fails, that reconciliation ROLLS BACK too (no partial
  // ownership→role state). An unsupported-target outcome also rolls back.
  const NO_TARGET = "__SCIM_UPDATE_NO_TARGET__";
  const appliedFields: string[] = [];
  try {
    await client.$transaction(async (tx) => {
      appliedFields.length = 0;
      await enforceScimManagedOwnership(
        ctx,
        { userId, workspaceRole: update.role ?? (member.role === "VIEWER" ? "VIEWER" : "MEMBER") },
        tx,
      );

      if (update.displayName !== undefined) {
        const mapping = await tx.externalIdentityMapping.findFirst({
          where: { teamId: ctx.teamId, userId, unlinkedAtUtc: null },
          orderBy: { linkedAtUtc: "desc" },
        });
        if (mapping) {
          await tx.externalIdentityMapping.update({
            where: { id: mapping.id },
            data: { displayName: update.displayName?.slice(0, 180) ?? null },
          });
          appliedFields.push("displayName");
        }
      }

      if (update.role !== undefined) {
        // SCIM never assigns/demotes OWNER/ADMIN — explicit operator action only.
        if (member.role === "OWNER" || member.role === "ADMIN") {
          // cannot honour a privileged role change; not an applied field.
        } else if (member.role !== update.role) {
          await applyDirectoryRoleChange(tx as unknown as typeof client, {
            teamMemberId: member.id,
            currentRole: member.role,
            desiredRole: update.role,
            source: "SCIM",
            externalRef: "scim-patch",
            allowPrivilegedChange: false,
          });
          appliedFields.push("role");
        } else {
          appliedFields.push("role"); // no-op change still an honoured target
        }
      }

      // Nothing applied → roll back the reconciliation too (zero mutation).
      if (appliedFields.length === 0) throw new Error(NO_TARGET);
    });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.message === NO_TARGET) {
      return { ok: false, status: 400, detail: "no_supported_attribute_target", scimType: "noTarget" };
    }
    if (e.code === "SCIM_MANAGED_CROSS_ORG_CONFLICT") {
      return { ok: false, status: 409, detail: "managed_cross_org_conflict", scimType: "mutability" };
    }
    if (e.code === "SCIM_MANAGED_UNRESOLVED") {
      return { ok: false, status: 409, detail: "managed_identity_unresolved", scimType: "mutability" };
    }
    throw err; // schema-unavailability / seat exhaustion — fail closed
  }

  bump("scim_user_updated_total");
  bump("scim_sync_total");
  safeEmitSecurityEvent({
    teamId: ctx.teamId,
    eventType: "scim_user_updated",
    severity: "INFO",
    details: { tokenId: ctx.tokenId, userId, fields: appliedFields },
  });
  await emitTenantAudit({
    action: "scim.user.update",
    outcome: "success",
    sourceApp: "SCIM",
    actorUserId: null,
    serviceActor: "scim_service",
    workspaceId: ctx.teamId,
    resourceType: "user",
    resourceId: userId,
    metadata: { fields: appliedFields },
  }, client);
  return { ok: true, appliedFields };
}

/**
 * Helper for the route layer to build a SCIM error response with the
 * correct schemas + status string.
 */
export { scimError };
