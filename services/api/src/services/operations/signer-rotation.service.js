/**
 * Phase P3.1 — Key rotation lifecycle.
 *
 * Operator-driven rotation: stage → preview → promote → retire/revoke.
 *
 * Lifecycle transitions are recorded as `SecurityEvent` rows so the
 * registry (read-model) can reconstruct state without a new Prisma
 * table. Transitions are deliberately one-way (no "un-stage" path —
 * a stale staged signer becomes operationally inert after preview
 * compares it to the current env).
 *
 * Hard rules:
 *   * Historical artifact rows (Report.pdfSignerKeyId,
 *     VerificationPackage.* signing fields) are NEVER mutated by
 *     this service. Promotion only writes the audit event; the env
 *     swap is the operational step.
 *   * Promote / retire / revoke are step-up gated at the route layer.
 *   * Preview is read-only and idempotent.
 *   * Compatibility check uses bounded outcomes; no free-form text
 *     reaches the operator.
 */
import { prisma as defaultPrisma } from "../../db.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { bump } from "../ops/metrics.service.js";
// Phase O1.5 — bounded signer rotation spans. Attributes carry only
// bounded fields (teamId, signerPurpose, compatibility outcome).
// NEVER the key material, KMS credentials, or actor PII.
import { PROOVRA_SPAN_NAMES, withProovraSpan, } from "../../observability/otel.js";
import { getCurrentActiveSigners, listStagedSigners, SIGNER_PROVIDERS, SIGNER_PURPOSES, } from "./signer-registry.service.js";
export async function stageSigner(input, client = defaultPrisma) {
    if (!SIGNER_PURPOSES.includes(input.signerPurpose)) {
        return {
            ok: false,
            code: "invalid_purpose",
            message: "Signer purpose not in bounded set.",
        };
    }
    if (!SIGNER_PROVIDERS.includes(input.provider)) {
        return {
            ok: false,
            code: "invalid_provider",
            message: "Signer provider not in bounded set.",
        };
    }
    const signerId = `${input.signerPurpose}:${input.provider}:${input.keyId ?? "_"}:${input.keyVersion ?? "_"}`;
    const existing = await listStagedSigners({ teamId: input.teamId }, client);
    if (existing.some((s) => s.signerId === signerId && s.status === "staged")) {
        return {
            ok: false,
            code: "duplicate_staged",
            message: "A staged signer with this id already exists.",
        };
    }
    const stagedAtUtc = new Date().toISOString();
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "signer_staged",
        severity: "INFO",
        details: {
            actorUserId: input.actorUserId,
            signerId,
            signerPurpose: input.signerPurpose,
            provider: input.provider,
            keyId: input.keyId,
            keyVersion: input.keyVersion,
            kmsKeyArn: input.kmsKeyArn,
            algorithm: input.algorithm,
            notes: input.notes,
        },
    });
    return { ok: true, signerId, stagedAtUtc };
}
export async function previewRotation(input, client = defaultPrisma) {
    return withProovraSpan(PROOVRA_SPAN_NAMES.SIGNER_ROTATION_PREVIEW, {
        "proovra.team_id": input.teamId,
        "proovra.operation": "signer_rotation_preview",
    }, () => previewRotationInner(input, client));
}
async function previewRotationInner(input, client) {
    const staged = await listStagedSigners({ teamId: input.teamId }, client);
    const target = staged.find((s) => s.signerId === input.signerId && s.status === "staged");
    if (!target) {
        return {
            ok: false,
            code: "staged_not_found",
            message: "Staged signer not found.",
        };
    }
    const active = getCurrentActiveSigners().find((a) => a.signerPurpose === target.signerPurpose && a.status === "active");
    const warnings = [];
    let compatibility = "compatible";
    if (active) {
        if (active.algorithm !== target.algorithm) {
            compatibility = "algorithm_change";
            warnings.push("ALGORITHM_CHANGE");
        }
        if (active.provider !== target.provider) {
            compatibility = "provider_change";
            warnings.push("PROVIDER_CHANGE");
        }
    }
    else {
        compatibility = "unverifiable";
    }
    // Historical immutability is ALWAYS a warning — operator must read it.
    warnings.push("HISTORICAL_ARTIFACTS_REMAIN_UNCHANGED");
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "signer_rotation_previewed",
        severity: "INFO",
        details: {
            actorUserId: input.actorUserId,
            signerId: input.signerId,
            compatibility,
        },
    });
    return {
        ok: true,
        preview: {
            signerPurpose: target.signerPurpose,
            currentActive: active
                ? {
                    signerId: active.signerId,
                    provider: active.provider,
                    keyId: active.keyId,
                    keyVersion: active.keyVersion,
                    algorithm: active.algorithm,
                }
                : null,
            staged: {
                signerId: target.signerId,
                provider: target.provider,
                keyId: target.keyId,
                keyVersion: target.keyVersion,
                algorithm: target.algorithm,
            },
            compatibility,
            warnings,
            rolloutPlan: "Promote the staged signer to active. Old artifacts retain their original signer metadata. Re-deploy the api + worker with the env variables matching the staged signer to make the rotation operationally effective.",
            generatedAtUtc: new Date().toISOString(),
        },
    };
}
// ---------------------------------------------------------------------------
// Promote / Retire / Revoke
// ---------------------------------------------------------------------------
export async function promoteStagedSigner(input, client = defaultPrisma) {
    return withProovraSpan(PROOVRA_SPAN_NAMES.SIGNER_ROTATION_PROMOTE, {
        "proovra.team_id": input.teamId,
        "proovra.operation": "signer_rotation_promote",
    }, () => promoteStagedSignerInner(input, client));
}
async function promoteStagedSignerInner(input, client) {
    if ((input.reason ?? "").trim().length === 0) {
        return {
            ok: false,
            code: "reason_required",
            message: "Operator reason required for signer promotion.",
        };
    }
    const staged = await listStagedSigners({ teamId: input.teamId }, client);
    const target = staged.find((s) => s.signerId === input.signerId && s.status === "staged");
    if (!target) {
        return {
            ok: false,
            code: "staged_not_found",
            message: "Staged signer not found.",
        };
    }
    bump("signer_rotation_total");
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "signer_promoted",
        severity: "WARNING",
        details: {
            actorUserId: input.actorUserId,
            signerId: input.signerId,
            signerPurpose: target.signerPurpose,
            provider: target.provider,
            keyId: target.keyId,
            keyVersion: target.keyVersion,
            reason: input.reason.trim().slice(0, 240),
        },
    });
    return { ok: true, promotedAtUtc: new Date().toISOString() };
}
export async function retireSigner(input, client = defaultPrisma) {
    if ((input.reason ?? "").trim().length === 0) {
        return {
            ok: false,
            code: "reason_required",
            message: "Operator reason required for signer retire.",
        };
    }
    bump("signer_rotation_total");
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "signer_retired",
        severity: "WARNING",
        details: {
            actorUserId: input.actorUserId,
            signerId: input.signerId,
            reason: input.reason.trim().slice(0, 240),
        },
    });
    return { ok: true, retiredAtUtc: new Date().toISOString() };
}
export async function revokeSigner(input, client = defaultPrisma) {
    if ((input.reason ?? "").trim().length === 0) {
        return {
            ok: false,
            code: "reason_required",
            message: "Operator reason required for signer revoke.",
        };
    }
    bump("signer_rotation_total");
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "signer_revoked",
        severity: "HIGH",
        details: {
            actorUserId: input.actorUserId,
            signerId: input.signerId,
            reason: input.reason.trim().slice(0, 240),
        },
    });
    return { ok: true, revokedAtUtc: new Date().toISOString() };
}
const SIGNER_AUDIT_EVENT_TYPES = [
    "signer_staged",
    "signer_health_checked",
    "signer_health_degraded",
    "signer_rotation_previewed",
    "signer_promoted",
    "signer_retired",
    "signer_revoked",
    "signer_signature_failure",
];
export async function listSignerAudit(input, client = defaultPrisma) {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const rows = await client.securityEvent.findMany({
        where: {
            teamId: input.teamId,
            eventType: { in: SIGNER_AUDIT_EVENT_TYPES },
        },
        orderBy: { createdAt: "desc" },
        take: limit * 2, // filter then cap
        select: {
            id: true,
            eventType: true,
            severity: true,
            createdAt: true,
            details: true,
        },
    });
    const out = [];
    for (const row of rows) {
        const d = (row.details ?? {});
        const sid = typeof d.signerId === "string" ? d.signerId : null;
        if (input.signerId && sid !== input.signerId)
            continue;
        out.push({
            id: row.id,
            occurredAtUtc: row.createdAt.toISOString(),
            eventType: row.eventType,
            severity: row.severity ?? "INFO",
            actorUserId: typeof d.actorUserId === "string" ? d.actorUserId : null,
            signerId: sid,
            summary: humaniseSignerEvent(row.eventType),
        });
        if (out.length >= limit)
            break;
    }
    return out;
}
function humaniseSignerEvent(eventType) {
    switch (eventType) {
        case "signer_staged":
            return "Operator staged a new signer";
        case "signer_health_checked":
            return "Signer health probe ran";
        case "signer_health_degraded":
            return "Signer health degraded";
        case "signer_rotation_previewed":
            return "Rotation preview generated";
        case "signer_promoted":
            return "Staged signer promoted to active (step-up confirmed)";
        case "signer_retired":
            return "Signer retired";
        case "signer_revoked":
            return "Signer revoked";
        case "signer_signature_failure":
            return "Signing operation failed";
        default:
            return "Signer event";
    }
}
