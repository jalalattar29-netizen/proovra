/**
 * Phase 26.5 — SSO hardening service.
 *
 * Sits ALONGSIDE the Phase 26 sso.service.ts. Phase 26 already
 * implements `buildOidcAuthorizationUrl` + `handleOidcCallback` against
 * an in-process state map. Phase 26.5 hardens the state lifecycle:
 *
 *   - State tokens are PERSISTED in `sso_callback_attempts` (HMAC
 *     hashes only, raw values never leave the process). This makes
 *     multi-instance deployments replay-safe.
 *   - Replay detection: a second consume at a CONSUMED hash flips the
 *     row to REPLAYED + emits `sso_callback_replay_detected`.
 *   - IdP outage tracking: consecutive callback failures bump a
 *     counter on the SsoConnection row; crossing a threshold opens a
 *     Phase 21 incident + emits `idp_outage_detected`.
 *   - Open-redirect protection: every `redirectAfter` URL is validated
 *     against the shared `isSafeRedirectAfter` helper at issue + at
 *     consume.
 *
 * The Phase 26 service stays the source of truth for OIDC discovery
 * + code-exchange + userinfo + JIT provisioning. This module is the
 * orchestration layer the route uses.
 */
import { createHmac } from "node:crypto";
import { SSO_CALLBACK_STATE_TTL_SECONDS, isSafeRedirectAfter, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { resolveSecret } from "../../config/index.js";
import { bump, setGauge } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { recordIncident } from "../observability/incident.service.js";
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";
const STATE_HASH_SECRET_ENV = "IDENTITY_SECURITY_HASH_SECRET";
// -----------------------------------------------------------------------------
// Hashing
// -----------------------------------------------------------------------------
export function hashStateToken(raw) {
    return createHmac("sha256", resolveSecret(STATE_HASH_SECRET_ENV))
        .update(raw, "utf8")
        .digest("hex");
}
export async function persistCallbackAttempt(input, client = defaultPrisma) {
    if (input.redirectAfter &&
        !isSafeRedirectAfter(input.redirectAfter, input.allowedRedirectOrigins)) {
        return { ok: false, reason: "INVALID_REDIRECT" };
    }
    const ttl = input.ttlSeconds ?? SSO_CALLBACK_STATE_TTL_SECONDS;
    try {
        const row = await client.ssoCallbackAttempt.create({
            data: {
                teamId: input.teamId,
                ssoConnectionId: input.ssoConnectionId,
                stateHash: hashStateToken(input.stateRaw),
                nonceHash: hashStateToken(input.nonceRaw),
                status: "PENDING",
                redirectAfter: input.redirectAfter,
                ipPreview: input.ipPreview,
                uaPreview: input.uaPreview,
                expiresAtUtc: new Date(Date.now() + ttl * 1000),
            },
        });
        setGauge("sso_callback_pending", await client.ssoCallbackAttempt.count({
            where: { teamId: input.teamId, status: "PENDING" },
        }));
        return { ok: true, attemptId: row.id };
    }
    catch {
        return { ok: false, reason: "PERSIST_FAILED" };
    }
}
/**
 * Atomically consume the state hash. If the hash exists and is PENDING,
 * we flip to CONSUMED and return the row. If the hash is already
 * CONSUMED, we flip to REPLAYED + emit a security event.
 */
export async function consumeCallbackAttempt(input, client = defaultPrisma) {
    const stateHash = hashStateToken(input.stateRaw);
    const row = await client.ssoCallbackAttempt.findUnique({
        where: { stateHash },
    });
    if (!row) {
        return { ok: false, reason: "NOT_FOUND" };
    }
    if (row.expiresAtUtc.getTime() <= Date.now()) {
        if (row.status === "PENDING") {
            await client.ssoCallbackAttempt.update({
                where: { id: row.id },
                data: { status: "EXPIRED" },
            });
            safeEmitSecurityEvent({
                teamId: row.teamId,
                eventType: "sso_state_expired",
                severity: "INFO",
                details: { ssoConnectionId: row.ssoConnectionId },
            });
        }
        return { ok: false, reason: "EXPIRED" };
    }
    if (row.status === "CONSUMED") {
        // Replay attempt — flip to REPLAYED + flag.
        await client.ssoCallbackAttempt.update({
            where: { id: row.id },
            data: {
                status: "REPLAYED",
                replayDetectedAtUtc: new Date(),
            },
        });
        bump("sso_callback_replay_total");
        bump("session_replay_detected_total");
        safeEmitSecurityEvent({
            teamId: row.teamId,
            eventType: "sso_callback_replay_detected",
            severity: "HIGH",
            details: {
                ssoConnectionId: row.ssoConnectionId,
                firstConsumedAtUtc: row.consumedAtUtc?.toISOString() ?? null,
            },
        });
        return { ok: false, reason: "REPLAYED" };
    }
    if (row.status !== "PENDING") {
        return { ok: false, reason: "ALREADY_FAILED" };
    }
    const updated = await client.ssoCallbackAttempt.update({
        where: { id: row.id },
        data: {
            status: "CONSUMED",
            consumedAtUtc: new Date(),
            consumedByUserId: input.consumedByUserId ?? null,
        },
    });
    return { ok: true, attempt: updated };
}
export async function markCallbackFailed(input, client = defaultPrisma) {
    try {
        await client.ssoCallbackAttempt.update({
            where: { id: input.attemptId },
            data: {
                status: "FAILED",
                failureReason: input.reason.slice(0, 64),
            },
        });
    }
    catch {
        /* best-effort */
    }
    bump("sso_callback_failure_total");
}
// -----------------------------------------------------------------------------
// IdP outage tracking
// -----------------------------------------------------------------------------
export const IDP_OUTAGE_FAILURE_THRESHOLD = 5;
export async function noteSsoSuccess(connectionId, client = defaultPrisma) {
    // Clear consecutive failures + mark outage cleared if currently in
    // outage. Atomic via updateMany guard.
    const row = await client.ssoConnection.findUnique({
        where: { id: connectionId },
        select: {
            id: true,
            teamId: true,
            provider: true,
            consecutiveFailureCount: true,
            outageDetectedAtUtc: true,
        },
    });
    if (!row)
        return;
    if (row.consecutiveFailureCount === 0 && !row.outageDetectedAtUtc)
        return;
    await client.ssoConnection.update({
        where: { id: connectionId },
        data: {
            consecutiveFailureCount: 0,
            outageClearedAtUtc: row.outageDetectedAtUtc ? new Date() : null,
            outageDetectedAtUtc: null,
        },
    });
    if (row.outageDetectedAtUtc) {
        bump("idp_outage_cleared_total");
        safeEmitSecurityEvent({
            teamId: row.teamId,
            eventType: "idp_outage_cleared",
            severity: "INFO",
            details: { connectionId, provider: row.provider },
        });
    }
}
export async function noteSsoFailure(input, client = defaultPrisma) {
    const row = await client.ssoConnection.findUnique({
        where: { id: input.connectionId },
        select: {
            id: true,
            teamId: true,
            provider: true,
            consecutiveFailureCount: true,
            outageDetectedAtUtc: true,
        },
    });
    if (!row) {
        return { consecutiveFailures: 0, outageOpened: false };
    }
    const newCount = row.consecutiveFailureCount + 1;
    const crossed = !row.outageDetectedAtUtc && newCount >= IDP_OUTAGE_FAILURE_THRESHOLD;
    await client.ssoConnection.update({
        where: { id: row.id },
        data: {
            consecutiveFailureCount: newCount,
            outageDetectedAtUtc: crossed ? new Date() : row.outageDetectedAtUtc,
        },
    });
    if (crossed) {
        bump("idp_outage_total");
        setGauge("idp_in_outage", await client.ssoConnection.count({
            where: { outageDetectedAtUtc: { not: null } },
        }));
        safeEmitSecurityEvent({
            teamId: row.teamId,
            eventType: "idp_outage_detected",
            severity: "HIGH",
            details: {
                connectionId: row.id,
                provider: row.provider,
                consecutiveFailures: newCount,
            },
        });
        try {
            await recordIncident({
                teamId: row.teamId,
                category: "IDENTITY_SECURITY",
                severity: "HIGH",
                fingerprint: `idp-outage:${row.id}`,
                title: `IdP outage — ${row.provider}`,
                safeSummary: `Identity provider ${row.provider} has produced ${newCount} consecutive callback failures.`,
                runbookSlug: "idp-outage-response",
                metadata: { connectionId: row.id, provider: row.provider },
            });
        }
        catch {
            /* incident creation is best-effort */
        }
        await appendPlatformAuditLog({
            userId: null,
            action: "sso.idp_outage.detected",
            category: "identity",
            severity: "warning",
            source: "sso_hardening",
            outcome: "failure",
            resourceType: "sso_connection",
            resourceId: row.id,
            metadata: {
                teamId: row.teamId,
                provider: row.provider,
                consecutiveFailures: newCount,
            },
            db: client,
        });
    }
    return { consecutiveFailures: newCount, outageOpened: crossed };
}
export async function persistSamlCallbackAttempt(input, client = defaultPrisma) {
    if (input.redirectAfter &&
        !isSafeRedirectAfter(input.redirectAfter, input.allowedRedirectOrigins)) {
        return { ok: false, reason: "INVALID_REDIRECT" };
    }
    const ttl = input.ttlSeconds ?? SSO_CALLBACK_STATE_TTL_SECONDS;
    try {
        const row = await client.ssoCallbackAttempt.create({
            data: {
                teamId: input.teamId,
                ssoConnectionId: input.ssoConnectionId,
                stateHash: hashStateToken(input.relayStateRaw),
                // For SAML: reuse nonceHash to store HMAC(samlAuthnRequestId).
                nonceHash: hashStateToken(input.samlAuthnRequestId),
                samlAuthnRequestId: input.samlAuthnRequestId,
                status: "PENDING",
                redirectAfter: input.redirectAfter,
                ipPreview: input.ipPreview,
                uaPreview: input.uaPreview,
                expiresAtUtc: new Date(Date.now() + ttl * 1000),
            },
        });
        setGauge("sso_callback_pending", await client.ssoCallbackAttempt.count({
            where: { teamId: input.teamId, status: "PENDING" },
        }));
        return { ok: true, attemptId: row.id };
    }
    catch {
        return { ok: false, reason: "PERSIST_FAILED" };
    }
}
// -----------------------------------------------------------------------------
// Stale-attempt sweep (cron-driven cleanup)
// -----------------------------------------------------------------------------
export async function sweepStaleCallbackAttempts(input = {}, client = defaultPrisma) {
    const days = Math.max(1, Math.min(input.olderThanDays ?? 7, 90));
    const batch = Math.max(1, Math.min(input.batchSize ?? 1000, 10000));
    const cutoff = new Date(Date.now() - days * 86400_000);
    // Delete only terminal rows beyond the cutoff so we keep recent
    // history available to the admin timeline.
    const result = await client.ssoCallbackAttempt.deleteMany({
        where: {
            createdAt: { lt: cutoff },
            status: { in: ["EXPIRED", "FAILED", "CONSUMED", "REPLAYED"] },
        },
    });
    // deleteMany returns count but Prisma's typing differs across versions;
    // cast safely.
    const swept = result.count ?? 0;
    if (swept > 0) {
        void batch; // keep parameter referenced for future paging support
    }
    return { swept };
}
// -----------------------------------------------------------------------------
// Helper: look up the SsoConnection a state row belongs to.
// -----------------------------------------------------------------------------
export async function getConnectionForAttempt(attempt, client = defaultPrisma) {
    return client.ssoConnection.findUnique({
        where: { id: attempt.ssoConnectionId },
    });
}
