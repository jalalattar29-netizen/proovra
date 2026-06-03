/**
 * Phase 19 — MFA policy service.
 *
 * Thin layer on top of the Phase 17 OrganizationSecurityPolicy row.
 * Reads + writes the `mfaPolicyLevel` enum and answers the question
 * "does THIS user need MFA right now for THIS action?".
 *
 * Sources consulted, in order:
 *   1. Org security policy (`mfaPolicyLevel`) — the floor.
 *   2. Role of the actor — ADMINS_ONLY excludes MEMBER/VIEWER, etc.
 *   3. Risk level of the actor's current session — HIGH_RISK_ONLY
 *      flips on only when the risk evaluator returns HIGH/CRITICAL.
 *   4. Per-action override — sensitive actions in the
 *      `actionForcesMfa` allow-list always require step-up regardless
 *      of policy level.
 *
 * Hard invariants:
 *   - Service accounts NEVER get MFA. Their auth path is bearer key
 *     + IP allowlist + Phase 17 hardening.
 *   - Contributors NEVER get workspace MFA. Their verification path
 *     is contributor phone verification (Phase 18 verify +
 *     step-up purpose CONTRIBUTOR_PHONE_VERIFICATION).
 *   - Unknown policy / role combinations FAIL CLOSED (`true`).
 *   - Failing to load the policy FAILS CLOSED.
 */
import { MFA_POLICY_LEVELS, mfaRequiredForRole, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
// Sensitive actions that ALWAYS require step-up regardless of policy
// level. This is the source of truth for "what counts as a sensitive
// action" — the step-up middleware reads from here so the catalog
// cannot drift.
const ACTIONS_FORCING_MFA = [
    "MEMBER_SUSPEND",
    "MEMBER_REVOKE",
    "MEMBER_ROLE_CHANGE",
    "MEMBER_RESTORE",
    "CAPABILITY_GRANT",
    "CAPABILITY_REVOKE",
    "DELEGATED_ADMIN_GRANT",
    "DELEGATED_ADMIN_REVOKE",
    "SERVICE_ACCOUNT_CREATE",
    "SERVICE_ACCOUNT_DISABLE",
    "SERVICE_ACCOUNT_ENABLE",
    "SERVICE_ACCOUNT_REVOKE",
    "SERVICE_ACCOUNT_HARDENING_UPDATE",
    "CONTRIBUTOR_SESSION_REVOKE",
    "ORG_SECURITY_POLICY_UPDATE",
    "EXTERNAL_IDENTITY_LINK",
    "EXTERNAL_IDENTITY_UNLINK",
    "LEGAL_HOLD_PLACE",
    "LEGAL_HOLD_RELEASE",
    "PUBLIC_VERIFY_PUBLISH",
    "PUBLIC_VERIFY_UNPUBLISH",
    "PUBLIC_VERIFY_SUSPEND",
    "PUBLIC_VERIFY_RESTORE",
    "GOVERNANCE_POLICY_UPDATE",
    "RETENTION_POLICY_UPDATE",
    "MFA_POLICY_UPDATE",
];
export function actionForcesStepUp(action) {
    return ACTIONS_FORCING_MFA.includes(action);
}
const DEFAULT_STEP_UP_TTL_SECONDS = (() => {
    const raw = process.env.STEP_UP_SESSION_TTL_MINUTES;
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    if (!Number.isFinite(n) || n < 1)
        return 15 * 60;
    return Math.min(60 * 60, n * 60);
})();
const DEFAULT_TRUSTED_DEVICE_TTL_DAYS = (() => {
    const raw = process.env.TRUSTED_DEVICE_TTL_DAYS;
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    if (!Number.isFinite(n) || n < 1)
        return 30;
    return Math.min(180, n);
})();
function normaliseLevel(raw) {
    if (!raw)
        return "OFF";
    return MFA_POLICY_LEVELS.includes(raw)
        ? raw
        : "OFF";
}
export async function getMfaPolicy(teamId, client = defaultPrisma) {
    const row = await client.organizationSecurityPolicy.findUnique({
        where: { teamId },
        select: {
            mfaPolicyLevel: true,
            mfaRequiredFlag: true,
            ssoReadyFlag: true,
            scimReadyFlag: true,
            stepUpTtlSeconds: true,
            trustedDeviceTtlDays: true,
            mfaEnforcementFailMode: true,
        },
    });
    const baseLevel = normaliseLevel(row?.mfaPolicyLevel ?? null);
    // If the legacy mfaRequiredFlag is on but the new level was never
    // set, default to ADMINS_ONLY. Operators can override later via
    // /security-center.
    const level = baseLevel === "OFF" && row?.mfaRequiredFlag ? "ADMINS_ONLY" : baseLevel;
    // R8.1.5 — normalise fail-mode for the API surface (case-insensitive,
    // bounded values only).
    const rawFm = row?.mfaEnforcementFailMode ?? null;
    let mfaEnforcementFailMode = null;
    if (rawFm) {
        const upper = rawFm.toUpperCase();
        if (upper === "SMART" || upper === "FAIL_OPEN" || upper === "FAIL_CLOSED") {
            mfaEnforcementFailMode = upper;
        }
    }
    return {
        teamId,
        level,
        stepUpTtlSeconds: row?.stepUpTtlSeconds ?? DEFAULT_STEP_UP_TTL_SECONDS,
        trustedDeviceTtlDays: row?.trustedDeviceTtlDays ?? DEFAULT_TRUSTED_DEVICE_TTL_DAYS,
        mfaRequiredFlag: row?.mfaRequiredFlag ?? false,
        ssoReadyFlag: row?.ssoReadyFlag ?? false,
        scimReadyFlag: row?.scimReadyFlag ?? false,
        mfaEnforcementFailMode,
    };
}
export async function evaluateMfaRequirement(input, client = defaultPrisma) {
    let policy;
    try {
        policy = await getMfaPolicy(input.teamId, client);
    }
    catch {
        // Fail closed.
        return {
            required: true,
            reason: "fail_closed",
            policyLevel: "OFF",
        };
    }
    if (input.action && actionForcesStepUp(input.action)) {
        return {
            required: true,
            reason: "action_force",
            policyLevel: policy.level,
        };
    }
    if (policy.level === "HIGH_RISK_ONLY" &&
        (input.currentRiskLevel === "HIGH" ||
            input.currentRiskLevel === "CRITICAL")) {
        return {
            required: true,
            reason: "risk_high",
            policyLevel: policy.level,
        };
    }
    if (mfaRequiredForRole(policy.level, input.role)) {
        return {
            required: true,
            reason: "role_in_policy",
            policyLevel: policy.level,
        };
    }
    return { required: false, reason: "off", policyLevel: policy.level };
}
export async function updateMfaPolicy(input, client = defaultPrisma) {
    const stepUpTtl = input.stepUpTtlSeconds === undefined
        ? undefined
        : clampStepUpTtl(input.stepUpTtlSeconds);
    const deviceTtl = input.trustedDeviceTtlDays === undefined
        ? undefined
        : clampTrustedDeviceTtl(input.trustedDeviceTtlDays);
    // PHASE R8.1.5 — validate per-org fail-mode if supplied. Bounded
    // values only; anything else is rejected at the route layer
    // before this function runs (we re-validate here for defence-
    // in-depth).
    let failModeForWrite = undefined;
    if (input.mfaEnforcementFailMode !== undefined) {
        if (input.mfaEnforcementFailMode === null) {
            failModeForWrite = null;
        }
        else if (["SMART", "FAIL_OPEN", "FAIL_CLOSED"].includes(input.mfaEnforcementFailMode)) {
            failModeForWrite = input.mfaEnforcementFailMode;
        }
        else {
            throw new Error("invalid_fail_mode");
        }
    }
    // Read prior fail mode so we can emit the change event only when
    // it actually changed (avoids noisy SIEM rows).
    const prior = await client.organizationSecurityPolicy.findUnique({
        where: { teamId: input.teamId },
        select: { mfaEnforcementFailMode: true },
    });
    const priorFailMode = prior?.mfaEnforcementFailMode ?? null;
    const updated = await client.organizationSecurityPolicy.upsert({
        where: { teamId: input.teamId },
        create: {
            teamId: input.teamId,
            mfaPolicyLevel: input.level,
            stepUpTtlSeconds: stepUpTtl ?? null,
            trustedDeviceTtlDays: deviceTtl ?? null,
            mfaEnforcementFailMode: failModeForWrite === undefined ? null : failModeForWrite,
            updatedByUserId: input.actorUserId,
        },
        update: {
            mfaPolicyLevel: input.level,
            ...(stepUpTtl !== undefined ? { stepUpTtlSeconds: stepUpTtl } : {}),
            ...(deviceTtl !== undefined ? { trustedDeviceTtlDays: deviceTtl } : {}),
            ...(failModeForWrite !== undefined
                ? { mfaEnforcementFailMode: failModeForWrite }
                : {}),
            updatedByUserId: input.actorUserId,
        },
        select: {
            teamId: true,
            mfaPolicyLevel: true,
            mfaRequiredFlag: true,
            ssoReadyFlag: true,
            scimReadyFlag: true,
            stepUpTtlSeconds: true,
            trustedDeviceTtlDays: true,
            mfaEnforcementFailMode: true,
        },
    });
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "mfa_policy_updated",
        severity: "INFO",
        details: {
            actorUserId: input.actorUserId,
            level: input.level,
            stepUpTtlSeconds: stepUpTtl ?? null,
            trustedDeviceTtlDays: deviceTtl ?? null,
        },
    }, client);
    // PHASE R8.1.5 — fail-mode change event (only when it changed).
    if (failModeForWrite !== undefined &&
        (failModeForWrite ?? null) !== priorFailMode) {
        safeEmitSecurityEvent({
            teamId: input.teamId,
            eventType: "org_mfa_fail_mode_updated",
            severity: "INFO",
            details: {
                actorUserId: input.actorUserId,
                previousFailMode: priorFailMode,
                newFailMode: failModeForWrite ?? null,
            },
        }, client);
    }
    await appendPlatformAuditLog({
        userId: input.actorUserId,
        action: "identity_security.mfa_policy.update",
        category: "identity_security.policy",
        severity: "info",
        source: "identity_security_service",
        outcome: "success",
        resourceType: "organization_security_policy",
        resourceId: input.teamId,
        metadata: {
            level: input.level,
            stepUpTtlSeconds: stepUpTtl ?? null,
            trustedDeviceTtlDays: deviceTtl ?? null,
            mfaEnforcementFailMode: failModeForWrite === undefined ? priorFailMode : (failModeForWrite ?? null),
        },
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        db: client,
    });
    // R8.1.5 — return the persisted fail-mode in the post-update view.
    const persistedFm = updated.mfaEnforcementFailMode ?? null;
    let normalisedFm = null;
    if (persistedFm) {
        const upper = persistedFm.toUpperCase();
        if (upper === "SMART" || upper === "FAIL_OPEN" || upper === "FAIL_CLOSED") {
            normalisedFm = upper;
        }
    }
    return {
        teamId: updated.teamId,
        level: normaliseLevel(updated.mfaPolicyLevel),
        stepUpTtlSeconds: updated.stepUpTtlSeconds ?? DEFAULT_STEP_UP_TTL_SECONDS,
        trustedDeviceTtlDays: updated.trustedDeviceTtlDays ?? DEFAULT_TRUSTED_DEVICE_TTL_DAYS,
        mfaRequiredFlag: updated.mfaRequiredFlag,
        ssoReadyFlag: updated.ssoReadyFlag,
        scimReadyFlag: updated.scimReadyFlag,
        mfaEnforcementFailMode: normalisedFm,
    };
}
function clampStepUpTtl(value) {
    if (value === null)
        return null;
    if (!Number.isFinite(value) || value < 60)
        return 60;
    return Math.min(60 * 60, Math.floor(value));
}
function clampTrustedDeviceTtl(value) {
    if (value === null)
        return null;
    if (!Number.isFinite(value) || value < 1)
        return 1;
    return Math.min(180, Math.floor(value));
}
