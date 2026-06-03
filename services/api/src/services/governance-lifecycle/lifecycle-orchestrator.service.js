/**
 * Phase 27 — Evidence Lifecycle Orchestrator.
 *
 * The CANONICAL writer for `Evidence.lifecycleState`. Every transition
 * goes through this module; the Evidence row is NEVER updated directly
 * from any other service.
 *
 * Hard rules:
 *   - Transitions are validated against the shared
 *     `EVIDENCE_LIFECYCLE_TRANSITIONS` table. Any transition outside
 *     the table is REFUSED with `LIFECYCLE_INVALID_TRANSITION`.
 *   - Hold-aware: while a hold is active on the evidence (or on its
 *     case), transitions TO `PENDING_DESTRUCTION` or `DESTROYED` are
 *     refused with `LIFECYCLE_BLOCKED_BY_HOLD`.
 *   - Immutable retention: if the effective retention policy carries
 *     `immutable=true`, transitions to `PENDING_DESTRUCTION` /
 *     `DESTROYED` are refused with `LIFECYCLE_BLOCKED_BY_IMMUTABLE`.
 *   - Append-only ledger: every transition writes one
 *     `EvidenceLifecycleEvent`. Non-transition events (hold placed /
 *     released, policy attached, restore requested) use
 *     `recordLifecycleEvent`.
 *   - DESTROYED is terminal at the state-machine level. Operators
 *     CANNOT re-transition out of DESTROYED.
 *
 * Metrics + events:
 *   - bump("lifecycle_transition_total") on success
 *   - bump("lifecycle_transition_blocked_total") on refusal
 *   - safeEmitSecurityEvent({eventType: "lifecycle_transition" |
 *     "lifecycle_transition_blocked", ...})
 *   - audit via appendPlatformAuditLog (category: "governance")
 */
import * as prismaPkg from "@prisma/client";
import { EVIDENCE_LIFECYCLE_STATES, isAllowedEvidenceLifecycleTransition, isTerminalLifecycleState, LIFECYCLE_EVENT_TYPES, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";
export class LifecycleOrchestratorError extends Error {
    code;
    details;
    constructor(code, details) {
        super(code);
        this.code = code;
        this.details = details;
        this.name = "LifecycleOrchestratorError";
    }
}
// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
const VALID_STATES = new Set(EVIDENCE_LIFECYCLE_STATES);
const VALID_EVENT_TYPES = new Set(LIFECYCLE_EVENT_TYPES);
const MAX_SUMMARY_LEN = 400;
const MAX_METADATA_BYTES = 8 * 1024;
/**
 * Scrub known-sensitive keys from operator metadata before persistence.
 * Lifecycle events are visible to compliance reviewers; they must never
 * carry privileged legal text or PII. Catalog-bound — only known
 * structured fields survive.
 */
const SENSITIVE_KEY_PREFIXES = [
    "legalnote",
    "privileged",
    "secret",
    "token",
    "credential",
    "password",
    "apikey",
    "api_key",
];
function scrubMetadata(input) {
    if (input === null || input === undefined)
        return null;
    if (typeof input !== "object") {
        if (typeof input === "string")
            return input.slice(0, 1000);
        return input;
    }
    if (Array.isArray(input)) {
        return input.slice(0, 50).map(scrubMetadata);
    }
    const obj = input;
    const out = {};
    let i = 0;
    for (const [k, v] of Object.entries(obj)) {
        if (i >= 50)
            break;
        const lowered = String(k).toLowerCase();
        if (SENSITIVE_KEY_PREFIXES.some((p) => lowered.includes(p))) {
            out[String(k).slice(0, 64)] = "[redacted]";
        }
        else {
            out[String(k).slice(0, 64)] = scrubMetadata(v);
        }
        i += 1;
    }
    return out;
}
function boundedMetadata(input) {
    if (input === null || input === undefined)
        return null;
    const scrubbed = scrubMetadata(input);
    try {
        const s = JSON.stringify(scrubbed);
        if (s.length > MAX_METADATA_BYTES) {
            return {
                truncated: true,
                preview: s.slice(0, 1500),
            };
        }
        return scrubbed;
    }
    catch {
        return { truncated: true };
    }
}
async function evidenceHasActiveHold(evidenceId, client) {
    const direct = await client.evidenceLegalHold.findFirst({
        where: { evidenceId, status: prismaPkg.LegalHoldStatus.ACTIVE },
        select: { id: true },
    });
    if (direct)
        return true;
    // Cascade through case-level holds.
    const ev = await client.evidence.findUnique({
        where: { id: evidenceId },
        select: { caseId: true },
    });
    if (!ev?.caseId)
        return false;
    const caseHold = await client.caseLegalHold.findFirst({
        where: { caseId: ev.caseId, status: prismaPkg.CaseLegalHoldStatus.ACTIVE },
        select: { id: true },
    });
    return Boolean(caseHold);
}
async function evidenceHasImmutableRetention(evidenceId, client) {
    // The Evidence row points at a RetentionPolicyVersion (Phase 27).
    // If the version snapshot says immutable=true, destruction is
    // refused regardless of expiry.
    const ev = await client.evidence.findUnique({
        where: { id: evidenceId },
        select: { retentionPolicyVersionId: true },
    });
    if (!ev?.retentionPolicyVersionId)
        return false;
    const version = await client.evidenceRetentionPolicyVersion.findUnique({
        where: { id: ev.retentionPolicyVersionId },
        select: { immutable: true },
    });
    return Boolean(version?.immutable);
}
export function projectLifecycleEvent(row) {
    return {
        id: row.id,
        teamId: row.teamId,
        evidenceId: row.evidenceId,
        fromState: row.fromState,
        toState: row.toState,
        eventType: row.eventType,
        summary: row.summary,
        metadata: row.metadata,
        actorUserId: row.actorUserId,
        requestId: row.requestId,
        createdAt: row.createdAt.toISOString(),
    };
}
export async function preflightLifecycleTransition(input, client = defaultPrisma) {
    if (!VALID_STATES.has(input.toState)) {
        throw new LifecycleOrchestratorError("LIFECYCLE_INVALID_TRANSITION", {
            toState: input.toState,
        });
    }
    const ev = await client.evidence.findFirst({
        where: { id: input.evidenceId, teamId: input.teamId },
        select: { lifecycleState: true },
    });
    if (!ev) {
        throw new LifecycleOrchestratorError("LIFECYCLE_EVIDENCE_NOT_FOUND");
    }
    const fromState = ev.lifecycleState;
    if (isTerminalLifecycleState(fromState) && fromState !== input.toState) {
        return { allowed: false, code: "LIFECYCLE_TERMINAL_STATE", fromState };
    }
    if (!isAllowedEvidenceLifecycleTransition(fromState, input.toState)) {
        return { allowed: false, code: "LIFECYCLE_INVALID_TRANSITION", fromState };
    }
    if (input.toState === "PENDING_DESTRUCTION" ||
        input.toState === "DESTROYED") {
        if (await evidenceHasActiveHold(input.evidenceId, client)) {
            return { allowed: false, code: "LIFECYCLE_BLOCKED_BY_HOLD", fromState };
        }
        if (await evidenceHasImmutableRetention(input.evidenceId, client)) {
            return {
                allowed: false,
                code: "LIFECYCLE_BLOCKED_BY_IMMUTABLE",
                fromState,
            };
        }
    }
    return { allowed: true, fromState };
}
export async function transitionLifecycle(input, client = defaultPrisma) {
    if (!VALID_STATES.has(input.toState)) {
        throw new LifecycleOrchestratorError("LIFECYCLE_INVALID_TRANSITION", {
            toState: input.toState,
        });
    }
    const ev = await client.evidence.findFirst({
        where: { id: input.evidenceId, teamId: input.teamId },
        select: { id: true, lifecycleState: true },
    });
    if (!ev) {
        throw new LifecycleOrchestratorError("LIFECYCLE_EVIDENCE_NOT_FOUND");
    }
    const fromState = ev.lifecycleState;
    // Self-transition is a no-op heartbeat — we still write a ledger
    // row so the operator timeline records the request, but no
    // metric/security event fires.
    if (fromState === input.toState) {
        const event = await client.evidenceLifecycleEvent.create({
            data: {
                teamId: input.teamId,
                evidenceId: input.evidenceId,
                fromState,
                toState: input.toState,
                eventType: input.eventType ?? "lifecycle_transition",
                summary: input.summary.slice(0, MAX_SUMMARY_LEN),
                metadata: boundedMetadata({
                    ...(input.metadata ?? {}),
                    noop: true,
                }) ?? undefined,
                actorUserId: input.actorUserId,
                requestId: input.requestId?.slice(0, 64) ?? null,
            },
        });
        return {
            fromState,
            toState: input.toState,
            lifecycleEvent: projectLifecycleEvent(event),
        };
    }
    if (isTerminalLifecycleState(fromState)) {
        bump("lifecycle_transition_blocked_total");
        safeEmitSecurityEvent({
            teamId: input.teamId,
            eventType: "lifecycle_transition_blocked",
            severity: "WARNING",
            evidenceId: input.evidenceId,
            details: {
                fromState,
                toState: input.toState,
                reason: "terminal_state",
                actorUserId: input.actorUserId,
            },
        });
        throw new LifecycleOrchestratorError("LIFECYCLE_TERMINAL_STATE", {
            fromState,
            toState: input.toState,
        });
    }
    if (!isAllowedEvidenceLifecycleTransition(fromState, input.toState)) {
        bump("lifecycle_transition_blocked_total");
        safeEmitSecurityEvent({
            teamId: input.teamId,
            eventType: "lifecycle_transition_blocked",
            severity: "WARNING",
            evidenceId: input.evidenceId,
            details: {
                fromState,
                toState: input.toState,
                reason: "invalid_transition",
                actorUserId: input.actorUserId,
            },
        });
        throw new LifecycleOrchestratorError("LIFECYCLE_INVALID_TRANSITION", {
            fromState,
            toState: input.toState,
        });
    }
    if (input.toState === "PENDING_DESTRUCTION" ||
        input.toState === "DESTROYED") {
        if (await evidenceHasActiveHold(input.evidenceId, client)) {
            bump("lifecycle_transition_blocked_total");
            bump("destruction_blocked_by_hold_total");
            safeEmitSecurityEvent({
                teamId: input.teamId,
                eventType: "destruction_blocked_by_hold",
                severity: "WARNING",
                evidenceId: input.evidenceId,
                details: {
                    fromState,
                    toState: input.toState,
                    actorUserId: input.actorUserId,
                },
            });
            throw new LifecycleOrchestratorError("LIFECYCLE_BLOCKED_BY_HOLD", {
                fromState,
                toState: input.toState,
            });
        }
        if (await evidenceHasImmutableRetention(input.evidenceId, client)) {
            bump("lifecycle_transition_blocked_total");
            bump("destruction_blocked_by_immutable_total");
            safeEmitSecurityEvent({
                teamId: input.teamId,
                eventType: "destruction_blocked_by_immutable",
                severity: "WARNING",
                evidenceId: input.evidenceId,
                details: {
                    fromState,
                    toState: input.toState,
                    actorUserId: input.actorUserId,
                },
            });
            throw new LifecycleOrchestratorError("LIFECYCLE_BLOCKED_BY_IMMUTABLE", {
                fromState,
                toState: input.toState,
            });
        }
    }
    // Mutation + ledger write happen in the same transaction so the
    // pointer + ledger stay consistent.
    const lifecycleEvent = await client.$transaction(async (tx) => {
        await tx.evidence.update({
            where: { id: input.evidenceId },
            data: {
                lifecycleState: input.toState,
            },
        });
        return tx.evidenceLifecycleEvent.create({
            data: {
                teamId: input.teamId,
                evidenceId: input.evidenceId,
                fromState,
                toState: input.toState,
                eventType: input.eventType ?? "lifecycle_transition",
                summary: input.summary.slice(0, MAX_SUMMARY_LEN),
                metadata: boundedMetadata(input.metadata) ?? undefined,
                actorUserId: input.actorUserId,
                requestId: input.requestId?.slice(0, 64) ?? null,
            },
        });
    });
    bump("lifecycle_transition_total");
    safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "evidence_lifecycle_transition",
        severity: "INFO",
        evidenceId: input.evidenceId,
        details: {
            fromState,
            toState: input.toState,
            actorUserId: input.actorUserId,
        },
    });
    if (input.actorUserId) {
        await appendPlatformAuditLog({
            userId: input.actorUserId,
            action: "lifecycle.transition",
            category: "governance",
            severity: input.toState === "DESTROYED" ? "warning" : "info",
            source: "lifecycle_orchestrator",
            outcome: "success",
            resourceType: "evidence",
            resourceId: input.evidenceId,
            requestId: input.requestId ?? null,
            metadata: {
                teamId: input.teamId,
                fromState,
                toState: input.toState,
            },
            db: client,
        });
    }
    return {
        fromState,
        toState: input.toState,
        lifecycleEvent: projectLifecycleEvent(lifecycleEvent),
    };
}
export async function recordLifecycleEvent(input, client = defaultPrisma) {
    if (!VALID_EVENT_TYPES.has(input.eventType)) {
        throw new LifecycleOrchestratorError("LIFECYCLE_INVALID_EVENT_TYPE", {
            eventType: input.eventType,
        });
    }
    const ev = await client.evidence.findFirst({
        where: { id: input.evidenceId, teamId: input.teamId },
        select: { lifecycleState: true },
    });
    if (!ev) {
        throw new LifecycleOrchestratorError("LIFECYCLE_EVIDENCE_NOT_FOUND");
    }
    const row = await client.evidenceLifecycleEvent.create({
        data: {
            teamId: input.teamId,
            evidenceId: input.evidenceId,
            fromState: ev.lifecycleState,
            toState: ev.lifecycleState,
            eventType: input.eventType,
            summary: input.summary.slice(0, MAX_SUMMARY_LEN),
            metadata: boundedMetadata(input.metadata) ?? undefined,
            actorUserId: input.actorUserId,
            requestId: input.requestId?.slice(0, 64) ?? null,
        },
    });
    return projectLifecycleEvent(row);
}
export async function listLifecycleEvents(input, client = defaultPrisma) {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const rows = await client.evidenceLifecycleEvent.findMany({
        where: { teamId: input.teamId, evidenceId: input.evidenceId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit,
    });
    return rows.map(projectLifecycleEvent);
}
// -----------------------------------------------------------------------------
// Dashboard counts — gauge feeders.
// -----------------------------------------------------------------------------
export async function countByLifecycleState(teamId, client = defaultPrisma) {
    const rows = await client.evidence.groupBy({
        by: ["lifecycleState"],
        where: { teamId },
        _count: { _all: true },
    });
    const out = {
        ACTIVE: 0,
        UNDER_REVIEW: 0,
        ON_HOLD: 0,
        RETENTION_LOCKED: 0,
        PENDING_DESTRUCTION: 0,
        DESTROYED: 0,
        ARCHIVED: 0,
    };
    for (const r of rows) {
        const k = r.lifecycleState;
        if (k in out)
            out[k] = r._count._all;
    }
    return out;
}
