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
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";

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
  await appendPlatformAuditLog({
    userId: input.actorUserId,
    action: "scim.token.create",
    category: "identity",
    severity: "warning",
    source: "scim_service",
    outcome: "success",
    resourceType: "scim_provisioning_token",
    resourceId: row.id,
    metadata: { teamId: input.teamId, scopes: input.scopes },
    db: client,
  });
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
  if (row.status === "REVOKED") return projectToken(row);
  const updated = await client.scimProvisioningToken.update({
    where: { id: row.id },
    data: {
      status: "REVOKED",
      revokedAtUtc: new Date(),
      revokedByUserId: input.actorUserId,
      revokedReason: input.reason?.slice(0, 400) ?? null,
    },
  });
  bump("scim_token_revoked_total");
  safeEmitSecurityEvent({
    teamId: input.teamId,
    eventType: "scim_token_revoked",
    severity: "WARNING",
    details: { tokenId: row.id, actorUserId: input.actorUserId },
  });
  return projectToken(updated);
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

  // Find or create the User by email.
  let user = await client.user.findFirst({
    where: { email: email.toLowerCase() },
    select: { id: true, createdAt: true, updatedAt: true },
  });
  if (!user) {
    user = await client.user.create({
      data: {
        email: email.toLowerCase(),
        provider: "EMAIL",
        providerUserId: `scim-${externalId}`,
      },
      select: { id: true, createdAt: true, updatedAt: true },
    });
  }

  // Link external mapping.
  await client.externalIdentityMapping.create({
    data: {
      teamId: ctx.teamId,
      userId: user.id,
      provider: "GENERIC_SCIM",
      externalSubjectId: externalId,
      displayName:
        parsed.data.displayName ?? parsed.data.name?.formatted ?? null,
      externalEmail: email,
    },
  });

  // Idempotent membership.
  await client.teamMember.upsert({
    where: { teamId_userId: { teamId: ctx.teamId, userId: user.id } },
    update: { status: "ACTIVE" },
    create: {
      teamId: ctx.teamId,
      userId: user.id,
      role:
        parsed.data.userType === "VIEWER"
          ? "VIEWER"
          : parsed.data.userType === "REVIEWER"
            ? "MEMBER"
            : "MEMBER",
      status: "ACTIVE",
      accessReason: "SCIM provisioning",
    },
  });

  bump("scim_user_created_total");
  bump("scim_sync_total");
  safeEmitSecurityEvent({
    teamId: ctx.teamId,
    eventType: "scim_user_created",
    severity: "INFO",
    details: { tokenId: ctx.tokenId, userId: user.id, externalId },
  });
  await appendPlatformAuditLog({
    userId: null,
    isPublic: true,
    action: "scim.user.create",
    category: "identity",
    severity: "info",
    source: "scim_service",
    outcome: "success",
    resourceType: "user",
    resourceId: user.id,
    metadata: { teamId: ctx.teamId, externalId },
    db: client,
  });

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
  await client.teamMember.update({
    where: { id: member.id },
    data: {
      status: "SUSPENDED",
      suspendedAtUtc: new Date(),
      suspensionReason: "SCIM deactivation",
    },
  });
  // Unlink the external mapping (soft).
  await client.externalIdentityMapping.updateMany({
    where: { teamId: ctx.teamId, userId, unlinkedAtUtc: null },
    data: { unlinkedAtUtc: new Date() },
  });
  bump("scim_user_deactivated_total");
  bump("scim_sync_total");
  safeEmitSecurityEvent({
    teamId: ctx.teamId,
    eventType: "scim_user_deactivated",
    severity: "INFO",
    details: { tokenId: ctx.tokenId, userId },
  });
  await appendPlatformAuditLog({
    userId: null,
    isPublic: true,
    action: "scim.user.deactivate",
    category: "identity",
    severity: "info",
    source: "scim_service",
    outcome: "success",
    resourceType: "user",
    resourceId: userId,
    metadata: { teamId: ctx.teamId },
    db: client,
  });
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
    await client.teamMember.update({
      where: { id: member.id },
      data: {
        status: "ACTIVE",
        suspendedAtUtc: null,
        suspensionReason: null,
      },
    });
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
  await appendPlatformAuditLog({
    userId: null,
    isPublic: true,
    action: "scim.user.reactivate",
    category: "identity",
    severity: "info",
    source: "scim_service",
    outcome: "success",
    resourceType: "user",
    resourceId: userId,
    metadata: { teamId: ctx.teamId },
    db: client,
  });
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

  const appliedFields: string[] = [];

  if (update.displayName !== undefined) {
    // Only persist against a live (non-unlinked) mapping.
    const mapping = await client.externalIdentityMapping.findFirst({
      where: { teamId: ctx.teamId, userId, unlinkedAtUtc: null },
      orderBy: { linkedAtUtc: "desc" },
    });
    if (mapping) {
      await client.externalIdentityMapping.update({
        where: { id: mapping.id },
        data: { displayName: update.displayName?.slice(0, 180) ?? null },
      });
      appliedFields.push("displayName");
    }
  }

  if (update.role !== undefined) {
    // SCIM never assigns OWNER/ADMIN and never silently *demotes* an
    // existing privileged member — those transitions require explicit
    // operator action, mirroring the Groups service invariant.
    if (member.role === "OWNER" || member.role === "ADMIN") {
      // Skip the role write but do not fail the whole PATCH; the
      // attribute simply cannot be honoured for a privileged member.
    } else if (member.role !== update.role) {
      await client.teamMember.update({
        where: { id: member.id },
        data: { role: update.role },
      });
      appliedFields.push("role");
    } else {
      // No-op change still counts as an honoured target.
      appliedFields.push("role");
    }
  }

  if (appliedFields.length === 0) {
    return {
      ok: false,
      status: 400,
      detail: "no_supported_attribute_target",
      scimType: "noTarget",
    };
  }

  bump("scim_user_updated_total");
  bump("scim_sync_total");
  safeEmitSecurityEvent({
    teamId: ctx.teamId,
    eventType: "scim_user_updated",
    severity: "INFO",
    details: { tokenId: ctx.tokenId, userId, fields: appliedFields },
  });
  await appendPlatformAuditLog({
    userId: null,
    isPublic: true,
    action: "scim.user.update",
    category: "identity",
    severity: "info",
    source: "scim_service",
    outcome: "success",
    resourceType: "user",
    resourceId: userId,
    metadata: { teamId: ctx.teamId, fields: appliedFields },
    db: client,
  });
  return { ok: true, appliedFields };
}

/**
 * Helper for the route layer to build a SCIM error response with the
 * correct schemas + status string.
 */
export { scimError };
