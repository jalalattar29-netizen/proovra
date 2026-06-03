/**
 * Phase 27 — Destruction Review Service.
 *
 * Owns the operator-approval queue for evidence destruction. Every
 * destruction proposal lands here as a row; reviewers move it through
 * the state machine; only `EXECUTED` actually destroys the evidence,
 * and that step emits a destruction certificate.
 *
 * Hard rules:
 *   - Only ONE non-terminal review may exist per evidence. The
 *     service refuses a second create with `DESTRUCTION_REVIEW_ACTIVE`.
 *   - Transitions are validated against the shared
 *     `DESTRUCTION_REVIEW_TRANSITIONS` table. Anything outside is
 *     refused with `DESTRUCTION_REVIEW_INVALID_TRANSITION`.
 *   - Hold-aware: APPROVED + EXECUTED are refused while a legal hold
 *     is active. The hold check is delegated to the lifecycle
 *     orchestrator (single source of truth).
 *   - Immutable-aware: EXECUTED is refused when the bound retention
 *     policy version is `immutable=true`. Operators must supersede
 *     the policy before destruction.
 *   - Destruction certificate: the EXECUTED transition produces a
 *     canonical JSON certificate, hashes it (SHA-256), stores the hash
 *     on the review row, and writes the full certificate body into
 *     the lifecycle ledger event `metadata`. The Evidence row is then
 *     moved to `DESTROYED` via the orchestrator (single writer).
 *   - DENIED → RESTORED puts the evidence back to ACTIVE via the
 *     orchestrator. This is the explicit "false alarm" path.
 *
 * The service NEVER stores privileged legal text. Decision notes are
 * operator-readable but bounded to 2000 chars and clipped.
 */
import { DESTRUCTION_REVIEW_REASONS, DESTRUCTION_REVIEW_STATUSES, isAllowedDestructionReviewTransition, isTerminalDestructionReviewStatus, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { canonicalJson, sha256Hex } from "../../crypto.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";
import { recordIncident } from "../observability/incident.service.js";
import { preflightLifecycleTransition, recordLifecycleEvent, transitionLifecycle, LifecycleOrchestratorError, } from "./lifecycle-orchestrator.service.js";
export class DestructionReviewError extends Error {
    code;
    details;
    constructor(code, details) {
        super(code);
        this.code = code;
        this.details = details;
        this.name = "DestructionReviewError";
    }
}
export function projectReview(row) {
    return {
        id: row.id,
        teamId: row.teamId,
        evidenceId: row.evidenceId,
        retentionPolicyId: row.retentionPolicyId,
        retentionPolicyVersion: row.retentionPolicyVersion,
        status: row.status,
        reason: row.reason,
        decisionNote: row.decisionNote,
        deferredUntilUtc: row.deferredUntilUtc?.toISOString() ?? null,
        initiatedByUserId: row.initiatedByUserId,
        decidedByUserId: row.decidedByUserId,
        decidedAtUtc: row.decidedAtUtc?.toISOString() ?? null,
        executedAtUtc: row.executedAtUtc?.toISOString() ?? null,
        certificateHash: row.certificateHash,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}
const VALID_STATUSES = new Set(DESTRUCTION_REVIEW_STATUSES);
const VALID_REASONS = new Set(DESTRUCTION_REVIEW_REASONS);
const NON_TERMINAL_STATUSES = [
    "PENDING",
    "UNDER_REVIEW",
    "DEFERRED",
    "APPROVED",
];
export async function createDestructionReview(input, client = defaultPrisma) {
    if (!VALID_REASONS.has(input.reason)) {
        throw new DestructionReviewError("DESTRUCTION_REVIEW_INVALID", {
            reason: input.reason,
        });
    }
    // Ensure the evidence exists in this team.
    const ev = await client.evidence.findFirst({
        where: { id: input.evidenceId, teamId: input.teamId },
        select: { id: true, lifecycleState: true, activeDestructionReviewId: true },
    });
    if (!ev) {
        throw new DestructionReviewError("DESTRUCTION_REVIEW_NOT_FOUND", {
            evidenceId: input.evidenceId,
        });
    }
    if (ev.activeDestructionReviewId) {
        throw new DestructionReviewError("DESTRUCTION_REVIEW_ACTIVE", {
            activeReviewId: ev.activeDestructionReviewId,
        });
    }
    // The orchestrator owns the hold + immutable + transition rules.
    // Pre-flight so we surface the exact reason before touching DB.
    const preflight = await preflightLifecycleTransition({
        teamId: input.teamId,
        evidenceId: input.evidenceId,
        toState: "PENDING_DESTRUCTION",
    }, client);
    if (!preflight.allowed) {
        if (preflight.code === "LIFECYCLE_BLOCKED_BY_HOLD") {
            bump("destruction_blocked_by_hold_total");
            safeEmitSecurityEvent({
                teamId: input.teamId,
                eventType: "destruction_blocked_by_hold",
                severity: "WARNING",
                evidenceId: input.evidenceId,
                details: {
                    stage: "review_create",
                    fromState: preflight.fromState,
                    actorUserId: input.actorUserId,
                },
            });
            throw new DestructionReviewError("DESTRUCTION_REVIEW_BLOCKED_BY_HOLD");
        }
        if (preflight.code === "LIFECYCLE_BLOCKED_BY_IMMUTABLE") {
            bump("destruction_blocked_by_immutable_total");
            safeEmitSecurityEvent({
                teamId: input.teamId,
                eventType: "destruction_blocked_by_immutable",
                severity: "WARNING",
                evidenceId: input.evidenceId,
                details: {
                    stage: "review_create",
                    fromState: preflight.fromState,
                    actorUserId: input.actorUserId,
                },
            });
            throw new DestructionReviewError("DESTRUCTION_REVIEW_BLOCKED_BY_IMMUTABLE");
        }
        throw new DestructionReviewError("DESTRUCTION_REVIEW_BLOCKED_BY_LIFECYCLE", {
            code: preflight.code,
            fromState: preflight.fromState,
        });
    }
    // Atomic: create the review + flip the Evidence pointer + write the
    // ledger event. If anything fails, the whole thing rolls back.
    const created = await client.$transaction(async (tx) => {
        const review = await tx.destructionReview.create({
            data: {
                teamId: input.teamId,
                evidenceId: input.evidenceId,
                retentionPolicyId: input.retentionPolicyId ?? null,
                retentionPolicyVersion: input.retentionPolicyVersion ?? null,
                status: "PENDING",
                reason: input.reason,
                initiatedByUserId: input.actorUserId,
            },
        });
        await tx.evidence.update({
            where: { id: input.evidenceId },
            data: { activeDestructionReviewId: review.id },
        });
        await tx.evidenceLifecycleEvent.create({
            data: {
                teamId: input.teamId,
                evidenceId: input.evidenceId,
                fromState: ev.lifecycleState,
                toState: ev.lifecycleState,
                eventType: "destruction_review_created",
                summary: `Destruction review opened (reason=${input.reason})`,
                metadata: {
                    destructionReviewId: review.id,
                    reason: input.reason,
                    retentionPolicyId: input.retentionPolicyId ?? null,
                    retentionPolicyVersion: input.retentionPolicyVersion ?? null,
                },
                actorUserId: input.actorUserId,
                requestId: input.requestId?.slice(0, 64) ?? null,
            },
        });
        return review;
    });
    bump("destruction_review_created_total");
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "destruction_review_created",
        severity: "WARNING",
        evidenceId: input.evidenceId,
        details: {
            destructionReviewId: created.id,
            reason: input.reason,
            actorUserId: input.actorUserId,
        },
    });
    await appendPlatformAuditLog({
        userId: input.actorUserId,
        action: "destruction.review.create",
        category: "governance",
        severity: "warning",
        source: "destruction_review",
        outcome: "success",
        resourceType: "destruction_review",
        resourceId: created.id,
        requestId: input.requestId ?? null,
        metadata: {
            teamId: input.teamId,
            evidenceId: input.evidenceId,
            reason: input.reason,
        },
        db: client,
    });
    return projectReview(created);
}
export async function transitionDestructionReview(input, client = defaultPrisma) {
    if (!VALID_STATUSES.has(input.nextStatus)) {
        throw new DestructionReviewError("DESTRUCTION_REVIEW_INVALID");
    }
    const existing = await client.destructionReview.findFirst({
        where: { id: input.id, teamId: input.teamId },
    });
    if (!existing) {
        throw new DestructionReviewError("DESTRUCTION_REVIEW_NOT_FOUND");
    }
    const from = existing.status;
    if (isTerminalDestructionReviewStatus(from) && from !== input.nextStatus) {
        throw new DestructionReviewError("DESTRUCTION_REVIEW_TERMINAL", {
            status: from,
        });
    }
    if (!isAllowedDestructionReviewTransition(from, input.nextStatus)) {
        throw new DestructionReviewError("DESTRUCTION_REVIEW_INVALID_TRANSITION", { from, to: input.nextStatus });
    }
    // Decision notes required on APPROVED / DENIED / RESTORED.
    if ((input.nextStatus === "APPROVED" ||
        input.nextStatus === "DENIED" ||
        input.nextStatus === "RESTORED") &&
        !input.decisionNote?.trim()) {
        throw new DestructionReviewError("DESTRUCTION_REVIEW_DECISION_NOTE_REQUIRED");
    }
    // Hold re-check on APPROVED (operators may have placed a hold between
    // create + approve — the hold MUST win).
    if (input.nextStatus === "APPROVED") {
        const preflight = await preflightLifecycleTransition({
            teamId: input.teamId,
            evidenceId: existing.evidenceId,
            toState: "PENDING_DESTRUCTION",
        }, client);
        if (!preflight.allowed) {
            if (preflight.code === "LIFECYCLE_BLOCKED_BY_HOLD") {
                bump("destruction_blocked_by_hold_total");
                safeEmitSecurityEvent({
                    teamId: input.teamId,
                    eventType: "destruction_blocked_by_hold",
                    severity: "WARNING",
                    evidenceId: existing.evidenceId,
                    details: {
                        stage: "review_approve",
                        destructionReviewId: existing.id,
                        actorUserId: input.actorUserId,
                    },
                });
                throw new DestructionReviewError("DESTRUCTION_REVIEW_BLOCKED_BY_HOLD");
            }
            if (preflight.code === "LIFECYCLE_BLOCKED_BY_IMMUTABLE") {
                bump("destruction_blocked_by_immutable_total");
                safeEmitSecurityEvent({
                    teamId: input.teamId,
                    eventType: "destruction_blocked_by_immutable",
                    severity: "WARNING",
                    evidenceId: existing.evidenceId,
                    details: {
                        stage: "review_approve",
                        destructionReviewId: existing.id,
                        actorUserId: input.actorUserId,
                    },
                });
                throw new DestructionReviewError("DESTRUCTION_REVIEW_BLOCKED_BY_IMMUTABLE");
            }
            throw new DestructionReviewError("DESTRUCTION_REVIEW_BLOCKED_BY_LIFECYCLE", { code: preflight.code });
        }
    }
    // EXECUTED has its own dedicated branch — see executeApprovedReview.
    if (input.nextStatus === "EXECUTED") {
        return executeApprovedReview({
            teamId: input.teamId,
            id: input.id,
            actorUserId: input.actorUserId,
            requestId: input.requestId ?? null,
        }, client);
    }
    const now = new Date();
    const decisionNote = input.decisionNote?.trim().slice(0, 2000) ?? null;
    const updated = await client.$transaction(async (tx) => {
        const row = await tx.destructionReview.update({
            where: { id: existing.id },
            data: {
                status: input.nextStatus,
                decisionNote: input.nextStatus === "APPROVED" ||
                    input.nextStatus === "DENIED" ||
                    input.nextStatus === "RESTORED"
                    ? decisionNote
                    : existing.decisionNote,
                deferredUntilUtc: input.nextStatus === "DEFERRED"
                    ? input.deferredUntilUtc ?? null
                    : existing.deferredUntilUtc,
                decidedByUserId: input.nextStatus === "APPROVED" ||
                    input.nextStatus === "DENIED" ||
                    input.nextStatus === "RESTORED" ||
                    input.nextStatus === "CANCELLED"
                    ? input.actorUserId
                    : existing.decidedByUserId,
                decidedAtUtc: input.nextStatus === "APPROVED" ||
                    input.nextStatus === "DENIED" ||
                    input.nextStatus === "RESTORED" ||
                    input.nextStatus === "CANCELLED"
                    ? now
                    : existing.decidedAtUtc,
            },
        });
        // Clear the active review pointer on terminal statuses (or RESTORED
        // / DENIED, both of which mean "evidence is no longer queued for
        // destruction"). On non-terminal moves (PENDING ↔ UNDER_REVIEW /
        // DEFERRED) we keep the pointer set.
        if (isTerminalDestructionReviewStatus(input.nextStatus) ||
            input.nextStatus === "DENIED") {
            await tx.evidence.update({
                where: { id: existing.evidenceId },
                data: { activeDestructionReviewId: null },
            });
        }
        return row;
    });
    // Ledger event (separate write — orchestrator owns no state change here).
    await recordLifecycleEvent({
        teamId: input.teamId,
        evidenceId: existing.evidenceId,
        eventType: input.nextStatus === "APPROVED"
            ? "destruction_review_approved"
            : input.nextStatus === "DENIED"
                ? "destruction_review_denied"
                : input.nextStatus === "DEFERRED"
                    ? "destruction_review_deferred"
                    : input.nextStatus === "RESTORED"
                        ? "destruction_review_restored"
                        : "lifecycle_transition",
        summary: `Destruction review ${input.nextStatus.toLowerCase()}`,
        actorUserId: input.actorUserId,
        metadata: {
            destructionReviewId: existing.id,
            from,
            to: input.nextStatus,
        },
        requestId: input.requestId ?? null,
    }, client).catch(() => null);
    // If RESTORED, snap the Evidence back to ACTIVE via the orchestrator
    // (only valid path out of a destruction queue).
    if (input.nextStatus === "RESTORED") {
        await transitionLifecycle({
            teamId: input.teamId,
            evidenceId: existing.evidenceId,
            toState: "ACTIVE",
            actorUserId: input.actorUserId,
            summary: "Destruction review restored — evidence returned to ACTIVE",
            eventType: "destruction_review_restored",
            metadata: { destructionReviewId: existing.id },
            requestId: input.requestId ?? null,
        }, client).catch(() => null);
    }
    // Metrics + events.
    if (input.nextStatus === "APPROVED")
        bump("destruction_review_approved_total");
    if (input.nextStatus === "DENIED")
        bump("destruction_review_denied_total");
    if (input.nextStatus === "DEFERRED")
        bump("destruction_review_deferred_total");
    if (input.nextStatus === "RESTORED")
        bump("destruction_review_restored_total");
    if (input.nextStatus === "APPROVED" ||
        input.nextStatus === "DENIED" ||
        input.nextStatus === "DEFERRED" ||
        input.nextStatus === "RESTORED") {
        safeEmitSecurityEvent({
            teamId: input.teamId,
            eventType: input.nextStatus === "APPROVED"
                ? "destruction_review_approved"
                : input.nextStatus === "DENIED"
                    ? "destruction_review_denied"
                    : input.nextStatus === "DEFERRED"
                        ? "destruction_review_deferred"
                        : "destruction_review_restored",
            severity: "WARNING",
            evidenceId: existing.evidenceId,
            details: {
                destructionReviewId: existing.id,
                from,
                to: input.nextStatus,
                actorUserId: input.actorUserId,
            },
        });
        await appendPlatformAuditLog({
            userId: input.actorUserId,
            action: `destruction.review.${input.nextStatus.toLowerCase()}`,
            category: "governance",
            severity: "warning",
            source: "destruction_review",
            outcome: "success",
            resourceType: "destruction_review",
            resourceId: existing.id,
            requestId: input.requestId ?? null,
            metadata: {
                teamId: input.teamId,
                evidenceId: existing.evidenceId,
                from,
                to: input.nextStatus,
            },
            db: client,
        });
    }
    return projectReview(updated);
}
async function executeApprovedReview(input, client) {
    const existing = await client.destructionReview.findFirst({
        where: { id: input.id, teamId: input.teamId },
    });
    if (!existing) {
        throw new DestructionReviewError("DESTRUCTION_REVIEW_NOT_FOUND");
    }
    const from = existing.status;
    if (from !== "APPROVED") {
        throw new DestructionReviewError("DESTRUCTION_REVIEW_INVALID_TRANSITION", { from, to: "EXECUTED" });
    }
    // Final hold + immutable check at execution time (defense in depth —
    // the orchestrator will also refuse if a hold landed in flight).
    const preflight = await preflightLifecycleTransition({
        teamId: input.teamId,
        evidenceId: existing.evidenceId,
        toState: "DESTROYED",
    }, client);
    if (!preflight.allowed) {
        if (preflight.code === "LIFECYCLE_BLOCKED_BY_HOLD") {
            bump("destruction_blocked_by_hold_total");
            throw new DestructionReviewError("DESTRUCTION_REVIEW_BLOCKED_BY_HOLD");
        }
        if (preflight.code === "LIFECYCLE_BLOCKED_BY_IMMUTABLE") {
            bump("destruction_blocked_by_immutable_total");
            throw new DestructionReviewError("DESTRUCTION_REVIEW_BLOCKED_BY_IMMUTABLE");
        }
        throw new DestructionReviewError("DESTRUCTION_REVIEW_BLOCKED_BY_LIFECYCLE", { code: preflight.code });
    }
    // Build the canonical destruction certificate body. The hash is
    // anchored in the DestructionReview row; the full body is written
    // into the lifecycle ledger event metadata for forensic recall.
    const executedAt = new Date();
    const certificateBody = {
        kind: "evidence_destruction_certificate",
        version: 1,
        teamId: existing.teamId,
        evidenceId: existing.evidenceId,
        destructionReviewId: existing.id,
        retentionPolicyId: existing.retentionPolicyId,
        retentionPolicyVersion: existing.retentionPolicyVersion,
        reason: existing.reason,
        initiatedByUserId: existing.initiatedByUserId,
        approvedByUserId: existing.decidedByUserId,
        executedByUserId: input.actorUserId,
        executedAtUtc: executedAt.toISOString(),
    };
    const certificateHash = sha256Hex(canonicalJson(certificateBody));
    // The orchestrator owns the lifecycleState write. We do it FIRST so
    // an orchestrator refusal (e.g. concurrent hold landed) leaves the
    // DestructionReview in APPROVED state — recoverable.
    try {
        await transitionLifecycle({
            teamId: input.teamId,
            evidenceId: existing.evidenceId,
            toState: "DESTROYED",
            actorUserId: input.actorUserId,
            summary: "Evidence destroyed by approved destruction review",
            eventType: "destruction_executed",
            metadata: {
                destructionReviewId: existing.id,
                certificateHash,
                certificate: certificateBody,
                reason: existing.reason,
            },
            requestId: input.requestId ?? null,
        }, client);
    }
    catch (err) {
        if (err instanceof LifecycleOrchestratorError) {
            if (err.code === "LIFECYCLE_BLOCKED_BY_HOLD") {
                bump("destruction_blocked_by_hold_total");
                throw new DestructionReviewError("DESTRUCTION_REVIEW_BLOCKED_BY_HOLD");
            }
            if (err.code === "LIFECYCLE_BLOCKED_BY_IMMUTABLE") {
                bump("destruction_blocked_by_immutable_total");
                throw new DestructionReviewError("DESTRUCTION_REVIEW_BLOCKED_BY_IMMUTABLE");
            }
            throw new DestructionReviewError("DESTRUCTION_REVIEW_BLOCKED_BY_LIFECYCLE", { code: err.code });
        }
        throw err;
    }
    // Flip the review to EXECUTED + clear the active pointer.
    const updated = await client.$transaction(async (tx) => {
        const row = await tx.destructionReview.update({
            where: { id: existing.id },
            data: {
                status: "EXECUTED",
                executedAtUtc: executedAt,
                certificateHash,
                decidedByUserId: existing.decidedByUserId ?? input.actorUserId,
                decidedAtUtc: existing.decidedAtUtc ?? executedAt,
            },
        });
        await tx.evidence.update({
            where: { id: existing.evidenceId },
            data: { activeDestructionReviewId: null },
        });
        return row;
    });
    bump("destruction_executed_total");
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "destruction_executed",
        severity: "HIGH",
        evidenceId: existing.evidenceId,
        details: {
            destructionReviewId: existing.id,
            certificateHash,
            reason: existing.reason,
            actorUserId: input.actorUserId,
        },
    });
    await appendPlatformAuditLog({
        userId: input.actorUserId,
        action: "destruction.review.execute",
        category: "governance",
        severity: "critical",
        source: "destruction_review",
        outcome: "success",
        resourceType: "destruction_review",
        resourceId: existing.id,
        requestId: input.requestId ?? null,
        metadata: {
            teamId: input.teamId,
            evidenceId: existing.evidenceId,
            certificateHash,
        },
        db: client,
    });
    // Governance incident at the moment of destruction so the /ops
    // dashboard records it alongside other operator-visible events.
    // Best-effort; never blocks the destruction.
    try {
        await recordIncident({
            teamId: input.teamId,
            category: "GOVERNANCE",
            severity: "HIGH",
            fingerprint: `destruction_executed:${existing.id}`,
            title: "Evidence destroyed",
            safeSummary: `Destruction review ${existing.id} executed for evidence ${existing.evidenceId}`,
            relatedEvidenceId: existing.evidenceId,
            metadata: {
                destructionReviewId: existing.id,
                certificateHash,
            },
        }, client);
    }
    catch {
        /* best-effort */
    }
    return projectReview(updated);
}
export async function listDestructionReviews(input, client = defaultPrisma) {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const where = {
        teamId: input.teamId,
    };
    if (input.status && input.status !== "ALL") {
        if (input.status === "ACTIVE") {
            where.status = { in: NON_TERMINAL_STATUSES };
        }
        else {
            where.status = input.status;
        }
    }
    const rows = await client.destructionReview.findMany({
        where,
        orderBy: [{ status: "asc" }, { createdAt: "desc" }],
        take: limit,
    });
    return rows.map(projectReview);
}
export async function getDestructionReview(input, client = defaultPrisma) {
    const row = await client.destructionReview.findFirst({
        where: { id: input.id, teamId: input.teamId },
    });
    if (!row) {
        throw new DestructionReviewError("DESTRUCTION_REVIEW_NOT_FOUND");
    }
    return projectReview(row);
}
// -----------------------------------------------------------------------------
// Dashboard signals — queue depth, blocked counts (gauge feeders).
// -----------------------------------------------------------------------------
export async function countActiveDestructionReviews(teamId, client = defaultPrisma) {
    return client.destructionReview.count({
        where: {
            teamId,
            status: { in: NON_TERMINAL_STATUSES },
        },
    });
}
export async function countPendingDestructionByEvidence(teamId, client = defaultPrisma) {
    return client.evidence.count({
        where: { teamId, lifecycleState: "PENDING_DESTRUCTION" },
    });
}
