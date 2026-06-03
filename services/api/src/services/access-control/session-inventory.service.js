/**
 * Phase 26 — Session governance: active session inventory.
 *
 * Sits on top of the new `authenticated_sessions` table + the existing
 * Phase 17 / 19 `RevokedSession` registry. Every successful login in
 * the API layer calls `recordAuthenticatedSession()`; the admin
 * inventory query reads from this table for fast O(1) listing.
 *
 * Hard rules:
 *   - The hashed sid (HMAC of the JWT jti) is the lookup key — never
 *     the raw jti.
 *   - Revocation goes through the existing Phase 19 `revokeSession()`
 *     which writes RevokedSession; we then mirror the revoked_at_utc
 *     pointer into `authenticated_sessions` so the inventory UI does
 *     not have to join.
 *   - IP / UA previews are display-only; never persists raw values.
 *   - Auto-revocation of expired rows is the operator's responsibility
 *     via a cron sweep (Phase 27 follow-up).
 */
import { SESSION_HEARTBEAT_DEFAULT_SAMPLE_SECONDS, SESSION_STALE_DEFAULT_MINUTES, isSessionStale, shouldWriteHeartbeat, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { bump, setGauge } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";
import { hashSessionId, revokeAllSessionsForUser, revokeSession, } from "../identity-security/session-revocation.service.js";
function projectSession(row) {
    return {
        id: row.id,
        teamId: row.teamId,
        userId: row.userId,
        ssoConnectionId: row.ssoConnectionId,
        issuedAtUtc: row.issuedAtUtc.toISOString(),
        expiresAtUtc: row.expiresAtUtc.toISOString(),
        lastSeenAtUtc: row.lastSeenAtUtc.toISOString(),
        ipPreview: row.ipPreview,
        uaPreview: row.uaPreview,
        revoked: row.revokedAtUtc != null,
        revokedAtUtc: row.revokedAtUtc?.toISOString() ?? null,
        revokedReason: row.revokedReason,
    };
}
export async function recordAuthenticatedSession(input, client = defaultPrisma) {
    const sessionIdHash = hashSessionId(input.sid);
    const row = await client.authenticatedSession.upsert({
        where: {
            userId_sessionIdHash: {
                userId: input.userId,
                sessionIdHash,
            },
        },
        update: {
            lastSeenAtUtc: new Date(),
            expiresAtUtc: new Date(input.exp * 1000),
        },
        create: {
            userId: input.userId,
            teamId: input.teamId,
            sessionIdHash,
            ssoConnectionId: input.ssoConnectionId ?? null,
            issuedAtUtc: new Date(input.iat * 1000),
            expiresAtUtc: new Date(input.exp * 1000),
            ipPreview: input.ipPreview ?? null,
            uaPreview: input.uaPreview ?? null,
            deviceIdHash: input.deviceIdHash ?? null,
        },
    });
    return projectSession(row);
}
/**
 * Best-effort heartbeat — called by the auth middleware on permission
 * check to update lastSeenAtUtc. NEVER throws.
 */
export async function touchAuthenticatedSession(input, client = defaultPrisma) {
    try {
        const sessionIdHash = hashSessionId(input.sid);
        await client.authenticatedSession.updateMany({
            where: { userId: input.userId, sessionIdHash },
            data: { lastSeenAtUtc: new Date() },
        });
    }
    catch {
        /* best-effort */
    }
}
export async function listActiveSessions(input, client = defaultPrisma) {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const now = new Date();
    const rows = await client.authenticatedSession.findMany({
        where: {
            teamId: input.teamId,
            ...(input.userId ? { userId: input.userId } : {}),
            ...(input.includeRevoked ? {} : { revokedAtUtc: null }),
            ...(input.includeExpired ? {} : { expiresAtUtc: { gt: now } }),
        },
        orderBy: [{ lastSeenAtUtc: "desc" }],
        take: limit,
    });
    bump("session_inventory_viewed_total");
    setGauge("active_sessions_total", await client.authenticatedSession.count({
        where: {
            teamId: input.teamId,
            revokedAtUtc: null,
            expiresAtUtc: { gt: now },
        },
    }));
    return rows.map(projectSession);
}
// -----------------------------------------------------------------------------
// Revocation — single + bulk
// -----------------------------------------------------------------------------
export async function revokeActiveSession(input, client = defaultPrisma) {
    const row = await client.authenticatedSession.findFirst({
        where: { id: input.sessionId, teamId: input.teamId },
    });
    if (!row)
        return null;
    const now = new Date();
    // Write the canonical RevokedSession entry so the JWT middleware
    // rejects subsequent requests immediately.
    await revokeSession({
        teamId: row.teamId,
        userId: row.userId,
        sessionIdHash: row.sessionIdHash,
        reason: input.reason ?? "OPERATOR_REVOKED",
        actorUserId: input.actorUserId,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
    }, client);
    // Mirror into the active-session ledger for fast inventory.
    const updated = await client.authenticatedSession.update({
        where: { id: row.id },
        data: {
            revokedAtUtc: now,
            revokedByUserId: input.actorUserId,
            revokedReason: (input.reason ?? "OPERATOR_REVOKED").slice(0, 64),
        },
    });
    bump("session_revoked_admin_total");
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "session_revoked_admin",
        severity: "WARNING",
        details: {
            sessionId: row.id,
            subjectUserId: row.userId,
            actorUserId: input.actorUserId,
            reason: input.reason ?? "OPERATOR_REVOKED",
        },
    });
    await appendPlatformAuditLog({
        userId: input.actorUserId,
        action: "session.revoke.single",
        category: "identity",
        severity: "warning",
        source: "session_inventory",
        outcome: "success",
        resourceType: "authenticated_session",
        resourceId: row.id,
        metadata: {
            teamId: input.teamId,
            subjectUserId: row.userId,
            reason: input.reason ?? "OPERATOR_REVOKED",
        },
        db: client,
    });
    return projectSession(updated);
}
export async function revokeAllSessionsForUserAdmin(input, client = defaultPrisma) {
    const now = new Date();
    await revokeAllSessionsForUser({
        teamId: input.teamId,
        userId: input.userId,
        reason: input.reason ?? "OPERATOR_REVOKED",
        actorUserId: input.actorUserId,
    }, client);
    const result = await client.authenticatedSession.updateMany({
        where: { userId: input.userId, teamId: input.teamId, revokedAtUtc: null },
        data: {
            revokedAtUtc: now,
            revokedByUserId: input.actorUserId,
            revokedReason: (input.reason ?? "OPERATOR_REVOKED").slice(0, 64),
        },
    });
    bump("session_revoked_admin_total", result.count);
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "all_sessions_revoked_admin",
        severity: "WARNING",
        details: {
            subjectUserId: input.userId,
            actorUserId: input.actorUserId,
            revokedCount: result.count,
        },
    });
    await appendPlatformAuditLog({
        userId: input.actorUserId,
        action: "session.revoke.all",
        category: "identity",
        severity: "warning",
        source: "session_inventory",
        outcome: "success",
        resourceType: "user",
        resourceId: input.userId,
        metadata: {
            teamId: input.teamId,
            revokedCount: result.count,
            reason: input.reason ?? "OPERATOR_REVOKED",
        },
        db: client,
    });
    return { revokedCount: result.count };
}
// -----------------------------------------------------------------------------
// Phase 26.5 — Sampled heartbeat
//
// The auth middleware calls this on every authenticated request. The
// shared `shouldWriteHeartbeat` helper enforces the sample-window
// (default 60s per session) so we do not write the row on every hit.
// Hot-row contention is bounded to one write per session per window.
// -----------------------------------------------------------------------------
export async function recordHeartbeat(input, client = defaultPrisma) {
    try {
        const sessionIdHash = hashSessionId(input.sid);
        const row = await client.authenticatedSession.findFirst({
            where: { userId: input.userId, sessionIdHash },
            select: { id: true, lastHeartbeatAtUtc: true },
        });
        if (!row) {
            return { written: false };
        }
        const sample = input.sampleWindowSeconds ?? SESSION_HEARTBEAT_DEFAULT_SAMPLE_SECONDS;
        if (!shouldWriteHeartbeat({
            lastHeartbeatAtUtc: row.lastHeartbeatAtUtc,
            sampleWindowSeconds: sample,
        })) {
            bump("session_heartbeat_sampled_skip_total");
            return { written: false };
        }
        await client.authenticatedSession.update({
            where: { id: row.id },
            data: {
                lastHeartbeatAtUtc: new Date(),
                lastSeenAtUtc: new Date(),
            },
        });
        bump("session_heartbeat_total");
        return { written: true };
    }
    catch {
        /* best-effort; never throws */
        return { written: false };
    }
}
export async function sweepStaleSessions(input, client = defaultPrisma) {
    const staleMinutes = input.staleMinutes ?? SESSION_STALE_DEFAULT_MINUTES;
    const batch = Math.min(Math.max(input.batchSize ?? 200, 1), 1000);
    const now = new Date();
    const candidates = await client.authenticatedSession.findMany({
        where: {
            teamId: input.teamId,
            revokedAtUtc: null,
            expiresAtUtc: { gt: now },
        },
        take: batch,
        select: {
            id: true,
            userId: true,
            lastHeartbeatAtUtc: true,
            lastSeenAtUtc: true,
            sessionIdHash: true,
        },
    });
    let staleDetected = 0;
    let swept = 0;
    for (const c of candidates) {
        if (!isSessionStale({
            lastHeartbeatAtUtc: c.lastHeartbeatAtUtc,
            lastSeenAtUtc: c.lastSeenAtUtc,
            staleMinutes,
            nowUtc: now,
        })) {
            continue;
        }
        staleDetected += 1;
        bump("stale_session_total");
        if (input.revoke !== false) {
            try {
                await revokeSession({
                    teamId: input.teamId,
                    userId: c.userId,
                    sessionIdHash: c.sessionIdHash,
                    reason: "RECONCILIATION_SWEEP",
                    actorUserId: null,
                    ipAddress: null,
                    userAgent: null,
                }, client);
                await client.authenticatedSession.update({
                    where: { id: c.id },
                    data: {
                        revokedAtUtc: now,
                        revokedReason: "RECONCILIATION_SWEEP",
                    },
                });
                bump("stale_session_swept_total");
                safeEmitSecurityEvent({
                    teamId: input.teamId,
                    eventType: "stale_session_swept",
                    severity: "INFO",
                    details: {
                        sessionId: c.id,
                        subjectUserId: c.userId,
                        staleMinutes,
                    },
                });
                swept += 1;
            }
            catch {
                /* sweeper is best-effort */
            }
        }
    }
    setGauge("stale_session_backlog", Math.max(0, staleDetected - swept));
    return { scanned: candidates.length, staleDetected, swept };
}
// -----------------------------------------------------------------------------
// Phase 26.5 — High-risk session count gauge update.
//
// Periodically refresh the `high_risk_sessions` gauge so the operations
// dashboard reflects the current risk distribution.
// -----------------------------------------------------------------------------
export async function refreshHighRiskSessionGauge(input, client = defaultPrisma) {
    const threshold = input.threshold ?? 60;
    const count = await client.authenticatedSession.count({
        where: {
            teamId: input.teamId,
            revokedAtUtc: null,
            expiresAtUtc: { gt: new Date() },
            riskScore: { gte: threshold },
        },
    });
    setGauge("high_risk_sessions", count);
    return count;
}
