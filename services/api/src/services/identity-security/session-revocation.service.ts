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

/**
 * The `all_sessions_revoked` security event. Best-effort and fire-and-forget,
 * so it never runs on a transaction client: a caller revoking inside its own
 * transaction emits it after that transaction commits (re-audit 4, R4-2) —
 * an un-awaited write on a transaction client is either lost after commit or,
 * failing while the transaction is open, aborts it.
 */
export function emitAllSessionsRevokedEvent(
  input: RevokeAllForUserInput,
  client: PrismaClient = defaultPrisma,
): void {
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
}

export async function revokeAllSessionsForUser(
  input: RevokeAllForUserInput,
  client: PrismaClient = defaultPrisma,
  options: {
    /** False inside a caller's transaction: it emits the event after commit. */
    securityEvent?: boolean;
  } = {},
): Promise<prismaPkg.RevokedSession> {
  const now = Math.floor(Date.now() / 1000);
  /*
   * PRO-019 (AUTH-13) — A REVOCATION ENDS WHAT EXISTED, NOT WHAT COMES NEXT.
   *
   * The ALL_FOR_USER row ends every token whose `iat` (whole seconds) is at or
   * before this second, so a sign-in completed in the SAME second after the
   * revocation (the normal sequence after a password reset) minted a session
   * that was dead on arrival. Every session that exists NOW is therefore also
   * ended by its own id, and a token that carries a session id is held to the
   * strict `iat < revokedBeforeIat` boundary (see `isSessionRevoked`). A token
   * without a session id cannot be told apart, and keeps the inclusive
   * boundary: it fails closed.
   */
  const live = await client.authenticatedSession.findMany({
    where: { userId: input.userId, expiresAtUtc: { gt: new Date() } },
    select: { sessionIdHash: true, teamId: true },
  });
  if (live.length > 0) {
    await client.revokedSession.createMany({
      data: live.map((session) => ({
        teamId: session.teamId ?? null,
        userId: input.userId,
        scope: prismaPkg.RevokedSessionScope.SINGLE_SESSION,
        sessionIdHash: session.sessionIdHash,
        reason: input.reason.slice(0, 64),
        revokedByUserId: input.actorUserId ?? null,
      })),
      skipDuplicates: true,
    });
    await client.authenticatedSession.updateMany({
      where: { userId: input.userId, revokedAtUtc: null, sessionIdHash: { in: live.map((s) => s.sessionIdHash) } },
      data: {
        revokedAtUtc: new Date(),
        revokedByUserId: input.actorUserId ?? null,
        revokedReason: input.reason.slice(0, 64),
      },
    });
  }
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
  if (options.securityEvent !== false) emitAllSessionsRevokedEvent(input, client);
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

/**
 * End every session of one person except the one acting, inside the caller's
 * transaction, so a privilege never commits while an older session can use it.
 *
 * Each session is revoked by its own hash, because ALL_FOR_USER ends every token
 * issued before it, the caller's included. Reads the session inventory, the same
 * source `revoke-others` uses. No event is emitted on the transaction client.
 */
export async function revokeOtherSessionsForUserTx(
  tx: PrismaClient,
  input: {
    userId: string;
    currentSessionIdHash: string | null;
    reason: SessionRevocationReason;
  },
): Promise<{ revoked: number }> {
  const where = {
    userId: input.userId,
    revokedAtUtc: null,
    ...(input.currentSessionIdHash ? { NOT: { sessionIdHash: input.currentSessionIdHash } } : {}),
  };
  const others = await tx.authenticatedSession.findMany({
    where,
    select: { sessionIdHash: true, teamId: true },
  });
  if (others.length === 0) return { revoked: 0 };
  await tx.revokedSession.createMany({
    data: others.map((session) => ({
      teamId: session.teamId ?? null,
      userId: input.userId,
      scope: prismaPkg.RevokedSessionScope.SINGLE_SESSION,
      sessionIdHash: session.sessionIdHash,
      reason: input.reason.slice(0, 64),
      revokedByUserId: input.userId,
    })),
  });
  await tx.authenticatedSession.updateMany({
    where,
    data: {
      revokedAtUtc: new Date(),
      revokedByUserId: input.userId,
      revokedReason: input.reason.slice(0, 64),
    },
  });
  return { revoked: others.length };
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
  // All-for-user deny. PRO-019 — a token with a session id that existed when
  // the revocation was written was ended above by its own id; the second the
  // revocation was taken in no longer kills one minted after it.
  if (input.iat !== null) {
    const all = await client.revokedSession.findFirst({
      where: {
        userId: input.userId,
        scope: prismaPkg.RevokedSessionScope.ALL_FOR_USER,
        revokedBeforeIat: input.sessionIdHash
          ? { gt: BigInt(input.iat) }
          : { gte: BigInt(input.iat) },
      },
      select: { id: true },
      orderBy: { revokedAtUtc: "desc" },
    });
    if (all) return true;
    if (input.sessionIdHash) {
      // The revocation's own second: only a session that has an inventory row
      // can have been ended by id above, and one that does not cannot be
      // proven newer than the revocation, so it stays ended.
      const sameSecond = await client.revokedSession.findFirst({
        where: {
          userId: input.userId,
          scope: prismaPkg.RevokedSessionScope.ALL_FOR_USER,
          revokedBeforeIat: BigInt(input.iat),
        },
        select: { id: true },
      });
      if (sameSecond) {
        const recorded = await client.authenticatedSession.findFirst({
          where: { userId: input.userId, sessionIdHash: input.sessionIdHash },
          select: { id: true },
        });
        if (!recorded) return true;
      }
    }
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
