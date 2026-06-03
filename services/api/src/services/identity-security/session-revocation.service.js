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
import * as prismaPkg from "@prisma/client";
import { prisma as defaultPrisma } from "../../db.js";
import { resolveSecret } from "../../config/index.js";
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
const SID_HASH_SECRET_ENV = "IDENTITY_SECURITY_HASH_SECRET";
export function hashSessionId(sid) {
    // Phase 20 — `resolveSecret` throws in production when the env var
    // is missing, so we can never silently fall back to a non-prod
    // fallback key in a prod deployment. In non-prod it returns a
    // deterministic namespaced fallback so local dev still works.
    const secret = resolveSecret(SID_HASH_SECRET_ENV);
    return createHmac("sha256", secret).update(sid, "utf8").digest("hex");
}
export async function revokeSession(input, client = defaultPrisma) {
    // Idempotent: if we've already revoked this sid, reuse the row.
    const existing = await client.revokedSession.findFirst({
        where: { userId: input.userId, sessionIdHash: input.sessionIdHash },
        select: { id: true },
    });
    if (existing)
        return null;
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
    safeEmitSecurityEvent({
        teamId: input.teamId ?? null,
        eventType: "session_revoked",
        severity: "INFO",
        details: {
            actorUserId: input.actorUserId ?? null,
            subjectUserId: input.userId,
            reason: input.reason,
        },
    }, client);
    await appendPlatformAuditLog({
        userId: input.actorUserId ?? input.userId,
        action: "identity_security.session.revoke",
        category: "identity_security.sessions",
        severity: "info",
        source: "identity_security_service",
        outcome: "success",
        resourceType: "revoked_session",
        resourceId: row.id,
        metadata: {
            teamId: input.teamId ?? null,
            subjectUserId: input.userId,
            reason: input.reason,
        },
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        db: client,
    });
    return row;
}
export async function revokeAllSessionsForUser(input, client = defaultPrisma) {
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
    safeEmitSecurityEvent({
        teamId: input.teamId ?? null,
        eventType: "all_sessions_revoked",
        severity: "WARNING",
        details: {
            actorUserId: input.actorUserId ?? null,
            subjectUserId: input.userId,
            reason: input.reason,
        },
    }, client);
    await appendPlatformAuditLog({
        userId: input.actorUserId ?? input.userId,
        action: "identity_security.session.revoke_all",
        category: "identity_security.sessions",
        severity: "warning",
        source: "identity_security_service",
        outcome: "success",
        resourceType: "user",
        resourceId: input.userId,
        metadata: {
            teamId: input.teamId ?? null,
            reason: input.reason,
            revokedBeforeIat: now,
        },
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        db: client,
    });
    return row;
}
export async function isSessionRevoked(input, client = defaultPrisma) {
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
        if (exact)
            return true;
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
        if (all)
            return true;
    }
    return false;
}
// -----------------------------------------------------------------------------
// Read projection (safe for /security-center)
// -----------------------------------------------------------------------------
export function projectRevokedSession(r) {
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
export async function listRevocationsForTeam(input, client = defaultPrisma) {
    return client.revokedSession.findMany({
        where: { teamId: input.teamId },
        orderBy: { revokedAtUtc: "desc" },
        take: Math.min(Math.max(input.limit ?? 100, 1), 500),
    });
}
