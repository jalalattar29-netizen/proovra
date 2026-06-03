/**
 * Phase 19 — Adaptive risk scoring service.
 *
 * Deterministic, explainable. The score for an actor at a moment is
 * the SUM of the (capped) weights of all unexpired RiskSignal rows
 * for that subject. Adding a signal kind requires a code change so
 * weights cannot drift.
 *
 * Public surface:
 *
 *   - recordRiskSignal(input) — write a signal + emit a SecurityEvent
 *     using one of the Phase 19 event names.
 *   - getRiskSnapshot({ teamId, subjectKind, subjectId }) — load all
 *     unexpired signals and compute the level.
 *   - observeSessionContext({ teamId, userId, ip, ua, deviceIdHash })
 *     — utility that fires NEW_DEVICE / NEW_IP / NEW_USER_AGENT
 *     signals when the context diverges from the user's trusted-device
 *     baseline. Best-effort; never throws to the caller.
 *
 * Hard invariants:
 *   - Risk reasons stored INTERNALLY (in RiskSignal.reason + audit).
 *     User-facing responses receive only a generic message.
 *   - IPs and user agents are masked via the shared helpers before
 *     storage. The raw values are NEVER persisted.
 *   - CRITICAL risk blocks the action; HIGH risk demands step-up.
 *     Both decisions are made by the consuming caller — the risk
 *     service only computes the level.
 */
import { createHmac } from "node:crypto";
import * as prismaPkg from "@prisma/client";
import { RISK_SIGNAL_KINDS, computeRiskScore, maskIpPreview, summariseUserAgent, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { resolveSecret } from "../../config/index.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
const HASH_SECRET_ENV = "IDENTITY_SECURITY_HASH_SECRET";
function hashOpaqueValue(value) {
    // Phase 20 — fail closed in production when the env var is missing.
    // `resolveSecret` throws a ProductionConfigError that the API
    // surfaces as a 503; in non-prod it returns a deterministic
    // namespaced fallback so local dev still works.
    const secret = resolveSecret(HASH_SECRET_ENV);
    return createHmac("sha256", secret).update(value, "utf8").digest("hex");
}
export function hashIpAddress(ip) {
    return hashOpaqueValue(ip.trim().toLowerCase());
}
export function hashDeviceCookieValue(value) {
    return hashOpaqueValue(value.trim());
}
const SIGNAL_KIND_SET = new Set(RISK_SIGNAL_KINDS);
// Per-signal default TTL — how long a signal contributes to the score
// before it stops being relevant. CRITICAL-weight signals never
// auto-expire; an operator must explicitly clear them via access
// review / session revocation.
const SIGNAL_TTL_HOURS = {
    NEW_DEVICE: 24 * 7,
    NEW_IP: 24 * 7,
    NEW_USER_AGENT: 24 * 3,
    NEW_COUNTRY: 24 * 14,
    IMPOSSIBLE_TRAVEL: null,
    FAILED_AUTH_BURST: 24,
    FAILED_OTP_BURST: 24,
    SERVICE_ACCOUNT_NEW_IP: 24 * 14,
    SERVICE_ACCOUNT_IP_ALLOWLIST_VIOLATION: 24 * 30,
    CONTRIBUTOR_TOKEN_FAILURE_BURST: 24,
    CONTRIBUTOR_REVOKED_ATTEMPT: 24 * 30,
    SUSPENDED_MEMBER_ACTIVITY: 24 * 30,
    REVOKED_MEMBER_ACTIVITY: null,
    EXCESSIVE_COMMUNICATION_SENDS: 24,
    PERMISSION_DENIED_BURST: 24,
    WEBHOOK_INVALID_SIGNATURE_BURST: 24 * 7,
};
export async function recordRiskSignal(input, client = defaultPrisma) {
    if (!SIGNAL_KIND_SET.has(input.signalKind))
        return null;
    const ttlHours = SIGNAL_TTL_HOURS[input.signalKind];
    const expiresAt = ttlHours === null ? null : new Date(Date.now() + ttlHours * 3600 * 1000);
    const ipPreview = input.ip ? maskIpPreview(input.ip) : null;
    const uaPreview = input.userAgent ? summariseUserAgent(input.userAgent) : null;
    let row = null;
    try {
        row = await client.riskSignal.create({
            data: {
                teamId: input.teamId,
                signalKind: input.signalKind,
                reason: input.reason.slice(0, 400),
                subjectKind: input.subjectKind,
                subjectUserId: input.subjectUserId ?? null,
                subjectApiCredentialId: input.subjectApiCredentialId ?? null,
                subjectIntakeSessionId: input.subjectIntakeSessionId ?? null,
                ipPreview,
                uaPreview,
                expiresAtUtc: expiresAt,
            },
        });
    }
    catch {
        // Best-effort. Risk recording must never break the request path.
        return null;
    }
    // Map signal kind -> SecurityEvent for the operator dashboard.
    const event = signalKindToSecurityEvent(input.signalKind);
    if (event) {
        safeEmitSecurityEvent({
            teamId: input.teamId,
            eventType: event,
            severity: signalKindToSeverity(input.signalKind),
            apiCredentialId: input.subjectApiCredentialId ?? null,
            details: {
                signalKind: input.signalKind,
                reason: input.reason,
                subjectKind: input.subjectKind,
                ipPreview,
                uaPreview,
            },
        }, client);
    }
    return row;
}
function signalKindToSecurityEvent(kind) {
    switch (kind) {
        case "SERVICE_ACCOUNT_NEW_IP":
        case "SERVICE_ACCOUNT_IP_ALLOWLIST_VIOLATION":
            return "service_account_risk_detected";
        case "CONTRIBUTOR_TOKEN_FAILURE_BURST":
        case "CONTRIBUTOR_REVOKED_ATTEMPT":
            return "contributor_risk_detected";
        case "IMPOSSIBLE_TRAVEL":
            return "impossible_travel_signal";
        case "NEW_DEVICE":
        case "NEW_IP":
        case "NEW_COUNTRY":
        case "FAILED_AUTH_BURST":
        case "FAILED_OTP_BURST":
        case "SUSPENDED_MEMBER_ACTIVITY":
        case "REVOKED_MEMBER_ACTIVITY":
        case "PERMISSION_DENIED_BURST":
        case "WEBHOOK_INVALID_SIGNATURE_BURST":
            return "suspicious_login_detected";
        default:
            return null;
    }
}
function signalKindToSeverity(kind) {
    switch (kind) {
        case "IMPOSSIBLE_TRAVEL":
        case "REVOKED_MEMBER_ACTIVITY":
        case "SERVICE_ACCOUNT_IP_ALLOWLIST_VIOLATION":
            return "HIGH";
        case "FAILED_AUTH_BURST":
        case "FAILED_OTP_BURST":
        case "SUSPENDED_MEMBER_ACTIVITY":
        case "CONTRIBUTOR_REVOKED_ATTEMPT":
        case "PERMISSION_DENIED_BURST":
            return "WARNING";
        default:
            return "INFO";
    }
}
const HIGH_THRESHOLD = (() => {
    const raw = process.env.SESSION_RISK_HIGH_THRESHOLD;
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    if (!Number.isFinite(n) || n < 1 || n > 100)
        return 75;
    return n;
})();
const MEDIUM_THRESHOLD = (() => {
    const raw = process.env.SESSION_RISK_MEDIUM_THRESHOLD;
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    if (!Number.isFinite(n) || n < 1 || n > 100)
        return 40;
    return n;
})();
export async function getRiskSnapshotForUser(input, client = defaultPrisma) {
    const now = new Date();
    const rows = await client.riskSignal.findMany({
        where: {
            teamId: input.teamId,
            subjectKind: prismaPkg.RiskSubjectKind.USER,
            subjectUserId: input.userId,
            OR: [{ expiresAtUtc: null }, { expiresAtUtc: { gt: now } }],
        },
        orderBy: { observedAtUtc: "desc" },
        take: 200,
    });
    return computeSnapshot(rows);
}
export async function getRiskSnapshotForServiceAccount(input, client = defaultPrisma) {
    const now = new Date();
    const rows = await client.riskSignal.findMany({
        where: {
            teamId: input.teamId,
            subjectKind: prismaPkg.RiskSubjectKind.SERVICE_ACCOUNT,
            subjectApiCredentialId: input.apiCredentialId,
            OR: [{ expiresAtUtc: null }, { expiresAtUtc: { gt: now } }],
        },
        orderBy: { observedAtUtc: "desc" },
        take: 200,
    });
    return computeSnapshot(rows);
}
export async function getRiskSnapshotForContributorSession(input, client = defaultPrisma) {
    const now = new Date();
    const rows = await client.riskSignal.findMany({
        where: {
            teamId: input.teamId,
            subjectKind: prismaPkg.RiskSubjectKind.CONTRIBUTOR_SESSION,
            subjectIntakeSessionId: input.intakeSessionId,
            OR: [{ expiresAtUtc: null }, { expiresAtUtc: { gt: now } }],
        },
        orderBy: { observedAtUtc: "desc" },
        take: 200,
    });
    return computeSnapshot(rows);
}
function computeSnapshot(rows) {
    const signals = rows
        .filter((r) => SIGNAL_KIND_SET.has(r.signalKind))
        .map((r) => ({
        kind: r.signalKind,
        reason: r.reason,
        observedAtUtc: r.observedAtUtc,
        expiresAtUtc: r.expiresAtUtc,
    }));
    const { score, level } = computeRiskScore({
        signals: signals.map((s) => s.kind),
        highThreshold: HIGH_THRESHOLD,
        mediumThreshold: MEDIUM_THRESHOLD,
    });
    return { level, score, signals };
}
export async function observeSessionContext(input, client = defaultPrisma) {
    try {
        const devices = await client.trustedDevice.findMany({
            where: {
                teamId: input.teamId,
                userId: input.userId,
                status: prismaPkg.TrustedDeviceStatus.ACTIVE,
            },
            select: { deviceIdHash: true, ipHash: true, uaPreview: true },
            take: 50,
        });
        if (devices.length === 0) {
            // First time we observe this user; nothing to compare against.
            // We DO NOT fire NEW_DEVICE on the very first observation —
            // that would punish first-time logins. The trusted-device
            // service writes the baseline on the first explicit "trust"
            // action.
            return;
        }
        if (input.deviceIdHash &&
            !devices.some((d) => d.deviceIdHash === input.deviceIdHash)) {
            await recordRiskSignal({
                teamId: input.teamId,
                subjectKind: "USER",
                subjectUserId: input.userId,
                signalKind: "NEW_DEVICE",
                reason: "Session originated from a device hash not seen before.",
                ip: input.ip ?? null,
                userAgent: input.userAgent ?? null,
            }, client);
        }
        if (input.ip) {
            const ipHash = hashIpAddress(input.ip);
            if (!devices.some((d) => d.ipHash === ipHash)) {
                await recordRiskSignal({
                    teamId: input.teamId,
                    subjectKind: "USER",
                    subjectUserId: input.userId,
                    signalKind: "NEW_IP",
                    reason: "Session originated from an IP not seen on a trusted device.",
                    ip: input.ip,
                    userAgent: input.userAgent ?? null,
                }, client);
            }
        }
        if (input.userAgent) {
            const uaPreview = summariseUserAgent(input.userAgent);
            if (!devices.some((d) => d.uaPreview === uaPreview)) {
                await recordRiskSignal({
                    teamId: input.teamId,
                    subjectKind: "USER",
                    subjectUserId: input.userId,
                    signalKind: "NEW_USER_AGENT",
                    reason: "User-agent family changed from previously trusted devices.",
                    ip: input.ip ?? null,
                    userAgent: input.userAgent,
                }, client);
            }
        }
    }
    catch {
        // Best-effort.
    }
}
// -----------------------------------------------------------------------------
// Burst detectors — count recent rows, fire signal when over threshold.
// -----------------------------------------------------------------------------
export async function maybeFireFailedOtpBurst(input, client = defaultPrisma) {
    try {
        const since = new Date(Date.now() - 60 * 60 * 1000); // 1 hour
        const failed = await client.verificationAttempt.count({
            where: {
                teamId: input.teamId,
                initiatedByUserId: input.userId,
                status: prismaPkg.VerificationAttemptStatus.DENIED,
                createdAt: { gte: since },
            },
        });
        if (failed >= 3) {
            await recordRiskSignal({
                teamId: input.teamId,
                subjectKind: "USER",
                subjectUserId: input.userId,
                signalKind: "FAILED_OTP_BURST",
                reason: `${failed} OTP check failures in the past hour.`,
            }, client);
        }
    }
    catch {
        // best-effort
    }
}
