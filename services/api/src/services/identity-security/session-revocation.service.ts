/**
 * Phase 19 — Session revocation registry.
 *
 * PROOVRA uses stateless HS256 JWTs (Phase 0+). We cannot "delete" a
 * token from the server. Instead, this service maintains a deny list
 * that the auth middleware consults on every request:
 *
 *   - SINGLE_SESSION: revokes one session by its sessionIdHash. The
 *     hash is computed at sign-in time and persisted as a `sid` claim
 *     inside the JWT (see auth.routes wiring). If the inbound JWT
 *     carries the same sid, requireAuth rejects with 401.
 *
 *   - ALL_FOR_USER: revokes every session whose `iat` <=
 *     revokedBeforeIat. Used for "log out everywhere" and for
 *     automatic revocation on suspend/revoke.
 *
 * The middleware check is read-only (single-row lookup keyed by
 * userId), so the hot path remains O(1) per request.
 *
 * Hard invariants:
 *   - Raw session tokens are NEVER stored. We store HMAC-SHA256 of
 *     the sid claim only.
 *   - Suspended / revoked members trigger ALL_FOR_USER revocation
 *     automatically — see `auto-revocation-hooks.ts`.
 *   - Public verify NEVER reads this table.
 */

import { createHmac } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import type { SessionRevocationReason } from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { resolveSecret } from "../../config/index.js";
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";

const SID_HASH_SECRET_ENV = "IDENTITY_SECURITY_HASH_SECRET";

export function hashSessionId(sid: string): string {
  // Phase 20 — `resolveSecret` throws in production when the env var
  // is missing, so we can never silently fall back to a non-prod
  // fallback key in a prod deployment. In non-prod it returns a
  // deterministic namespaced fallback so local dev still works.
  const secret = resolveSecret(SID_HASH_SECRET_ENV);
  return createHmac("sha256", secret).update(sid, "utf8").digest("hex");
}

// -----------------------------------------------------------------------------
// Revocation
// -----------------------------------------------------------------------------

export type RevokeSessionInput = {
  teamId?: string | null;
  userId: string;
  sessionIdHash: string;
  reason: SessionRevocationReason;
  actorUserId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export async function revokeSession(
  input: RevokeSessionInput,
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.RevokedSession | null> {
  // Idempotent: if we've already revoked this sid, reuse the row.
  const existing = await client.revokedSession.findFirst({
    where: { userId: input.userId, sessionIdHash: input.sessionIdHash },
    select: { id: true },
  });
  if (existing) return null;
  const row = await client.revokedSession.create({
    data: {
      teamId: input.teamId ?? null,
      userId: input.userId,
      scope: prismaPkg.RevokedSessionScope.SINGLE_SESSION,
      sessionIdHash: input.sessionIdHash,
      reason: input.reason.slice(0, 64),
      revokedByUserId: input.actorUserId ?? null,
    },
  });
  safeEmitSecurityEvent(
    {
      teamId: input.teamId ?? null,
      eventType: "session_revoked",
      severity: "INFO",
      details: {
        actorUserId: input.actorUserId ?? null,
        subjectUserId: input.userId,
        reason: input.reason,
      },
    },
    client,
  );
  await emitTenantAudit({
    action: "identity_security.session.revoke",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.actorUserId ?? input.userId,
    workspaceId: input.teamId ?? null,
    resourceType: "revoked_session",
    resourceId: row.id,
    metadata: {
      subjectUserId: input.userId,
      reason: input.reason,
    },
  }, client);
  return row;
}

export type RevokeAllForUserInput = {
  teamId?: string | null;
  userId: string;
  reason: SessionRevocationReason;
  actorUserId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export async function revokeAllSessionsForUser(
  input: RevokeAllForUserInput,
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.RevokedSession> {
  const now = Math.floor(Date.now() / 1000);
  const row = await client.revokedSession.create({
    data: {
      teamId: input.teamId ?? null,
      userId: input.userId,
      scope: prismaPkg.RevokedSessionScope.ALL_FOR_USER,
      sessionIdHash: null,
      revokedBeforeIat: BigInt(now),
      reason: input.reason.slice(0, 64),
      revokedByUserId: input.actorUserId ?? null,
    },
  });
  safeEmitSecurityEvent(
    {
      teamId: input.teamId ?? null,
      eventType: "all_sessions_revoked",
      severity: "WARNING",
      details: {
        actorUserId: input.actorUserId ?? null,
        subjectUserId: input.userId,
        reason: input.reason,
      },
    },
    client,
  );
  await emitTenantAudit({
    action: "identity_security.session.revoke_all",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.actorUserId ?? input.userId,
    workspaceId: input.teamId ?? null,
    resourceType: "user",
    resourceId: input.userId,
    metadata: {
      reason: input.reason,
      revokedBeforeIat: now,
    },
  }, client);
  return row;
}

// -----------------------------------------------------------------------------
// Check — used by the auth middleware on every request.
//
// Returns true when the inbound session is revoked. The check is a
// single Prisma findFirst keyed by userId — fast enough for the hot
// path.
// -----------------------------------------------------------------------------

export type SessionRevocationCheckInput = {
  userId: string;
  sessionIdHash: string | null;
  iat: number | null;
};

export async function isSessionRevoked(
  input: SessionRevocationCheckInput,
  client: PrismaClient = defaultPrisma,
): Promise<boolean> {
  // Single-session deny.
  if (input.sessionIdHash) {
    const exact = await client.revokedSession.findFirst({
      where: {
        userId: input.userId,
        sessionIdHash: input.sessionIdHash,
        scope: prismaPkg.RevokedSessionScope.SINGLE_SESSION,
      },
      select: { id: true },
    });
    if (exact) return true;
  }
  // All-for-user deny.
  if (input.iat !== null) {
    const all = await client.revokedSession.findFirst({
      where: {
        userId: input.userId,
        scope: prismaPkg.RevokedSessionScope.ALL_FOR_USER,
        revokedBeforeIat: { gte: BigInt(input.iat) },
      },
      select: { id: true },
      orderBy: { revokedAtUtc: "desc" },
    });
    if (all) return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// Read projection (safe for /security-center)
// -----------------------------------------------------------------------------

export function projectRevokedSession(r: prismaPkg.RevokedSession): {
  id: string;
  userId: string;
  scope: string;
  reason: string;
  revokedAtUtc: string;
  revokedByUserId: string | null;
} {
  return {
    id: r.id,
    userId: r.userId,
    scope: r.scope,
    reason: r.reason,
    revokedAtUtc: r.revokedAtUtc.toISOString(),
    revokedByUserId: r.revokedByUserId,
    // Deliberately NOT returned: sessionIdHash (operators don't need
    // to see hashes; they need to see "X sessions revoked").
  };
}

export async function listRevocationsForTeam(
  input: { teamId: string; limit?: number },
  client: PrismaClient = defaultPrisma,
): Promise<prismaPkg.RevokedSession[]> {
  return client.revokedSession.findMany({
    where: { teamId: input.teamId },
    orderBy: { revokedAtUtc: "desc" },
    take: Math.min(Math.max(input.limit ?? 100, 1), 500),
  });
}
