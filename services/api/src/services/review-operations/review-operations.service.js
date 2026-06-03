/**
 * Phase 13 — Enterprise review operations service.
 *
 * Centralized assignment / stage-transition / decision / SLA helpers
 * that wrap the existing `EvidenceReviewWorkflow` row. ALL stage
 * transitions go through this service so the canonical matrix in
 * `@proovra/shared/review-operations` is enforced in one place.
 *
 * Wording: never claim "authentic / legally admissible / proven". An
 * APPROVED_INTERNAL decision means an authorised operator marked the
 * record as internally approved for governance purposes — nothing
 * more.
 */
import { computeReviewSlaStatus, decisionRequiresNote, decisionTargetStage, isAllowedReviewStageTransition, mapDbStatusToReviewStage, reviewStageSatisfiesGovernanceGate, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { notifyReviewAssigned, notifyReviewEscalated, notifyReviewNeedsMoreInfo, notifyReviewSlaBreached, } from "./review-notifications.service.js";
// -----------------------------------------------------------------------------
// Error
// -----------------------------------------------------------------------------
export class ReviewOperationError extends Error {
    code;
    details;
    constructor(code, details) {
        super(code);
        this.code = code;
        this.details = details;
        this.name = "ReviewOperationError";
    }
}
// -----------------------------------------------------------------------------
// Internal: stage → DB status mapping
// -----------------------------------------------------------------------------
function stageToDbStatus(stage) {
    // All Phase 13 stages exist in the DB enum after the Phase 13
    // migration. The cast is safe because the enum unions both sets.
    return stage;
}
function slaStatusToDb(s) {
    return s;
}
// -----------------------------------------------------------------------------
// Ensure workflow row exists
// -----------------------------------------------------------------------------
export async function ensureReviewWorkflow(input, client = defaultPrisma) {
    const existing = await client.evidenceReviewWorkflow.findUnique({
        where: { evidenceId: input.evidenceId },
    });
    if (existing)
        return existing;
    // Phase 13.5 — apply workspace policy SLA defaults if configured.
    // Null defaults preserve pre-13.5 behavior exactly (no SLA applied).
    const defaults = await loadWorkspaceSlaDefaults(input.teamId, client);
    const now = new Date();
    const dueAt = defaults.defaultReviewDueHours
        ? new Date(now.getTime() + defaults.defaultReviewDueHours * 3_600_000)
        : null;
    const firstResponseDueAtUtc = defaults.defaultFirstResponseDueHours
        ? new Date(now.getTime() + defaults.defaultFirstResponseDueHours * 3_600_000)
        : null;
    const escalationDueAtUtc = defaults.defaultEscalationDueHours
        ? new Date(now.getTime() + defaults.defaultEscalationDueHours * 3_600_000)
        : null;
    const initialSla = computeReviewSlaStatus({
        dueAtUtc: dueAt,
        firstResponseDueAtUtc,
    });
    const created = await client.evidenceReviewWorkflow.create({
        data: {
            evidenceId: input.evidenceId,
            teamId: input.teamId,
            workspaceType: input.workspaceType ?? "TEAM",
            status: stageToDbStatus("QUEUED"),
            dueAt,
            firstResponseDueAtUtc,
            escalationDueAtUtc,
            slaStatus: initialSla ? slaStatusToDb(initialSla) : null,
        },
    });
    // Audit the default-application so operators can trace why the SLA
    // is set. No-op when no defaults configured.
    if (dueAt || firstResponseDueAtUtc || escalationDueAtUtc) {
        await recordEvent(created, "SLA_UPDATED", null, null, { source: "template_default", reason: "workspace_policy_defaults" }, {
            dueAt,
            firstResponseDueAtUtc,
            escalationDueAtUtc,
            slaStatus: initialSla,
        }, client);
    }
    return created;
}
/**
 * Read the workspace-level review SLA defaults. Returns all-null when
 * no policy row exists or no defaults are configured.
 */
export async function loadWorkspaceSlaDefaults(teamId, client = defaultPrisma) {
    const empty = {
        defaultReviewDueHours: null,
        defaultFirstResponseDueHours: null,
        defaultEscalationDueHours: null,
    };
    if (!teamId)
        return empty;
    try {
        const policy = await client.workspaceGovernancePolicy.findUnique({
            where: { teamId },
            select: {
                defaultReviewDueHours: true,
                defaultFirstResponseDueHours: true,
                defaultEscalationDueHours: true,
            },
        });
        if (!policy)
            return empty;
        return {
            defaultReviewDueHours: policy.defaultReviewDueHours,
            defaultFirstResponseDueHours: policy.defaultFirstResponseDueHours,
            defaultEscalationDueHours: policy.defaultEscalationDueHours,
        };
    }
    catch {
        return empty;
    }
}
async function applyTransition(workflow, toStage, patch, client) {
    const fromStage = mapDbStatusToReviewStage(workflow.status);
    if (!isAllowedReviewStageTransition(fromStage, toStage)) {
        throw new ReviewOperationError("invalid_stage_transition", {
            from: fromStage,
            to: toStage,
        });
    }
    const data = {
        status: stageToDbStatus(toStage),
    };
    if (patch.assignedToUserId !== undefined)
        data.assignedToUserId = patch.assignedToUserId;
    if (patch.assignedByUserId !== undefined)
        data.assignedByUserId = patch.assignedByUserId;
    if (patch.assignedAtUtc !== undefined)
        data.assignedAtUtc = patch.assignedAtUtc;
    if (patch.reassignedAtUtc !== undefined)
        data.reassignedAtUtc = patch.reassignedAtUtc;
    if (patch.dueAt !== undefined)
        data.dueAt = patch.dueAt;
    if (patch.firstResponseDueAtUtc !== undefined)
        data.firstResponseDueAtUtc = patch.firstResponseDueAtUtc;
    if (patch.escalationDueAtUtc !== undefined)
        data.escalationDueAtUtc = patch.escalationDueAtUtc;
    if (patch.completedAtUtc !== undefined)
        data.completedAtUtc = patch.completedAtUtc;
    if (patch.slaStatus !== undefined)
        data.slaStatus = patch.slaStatus ? slaStatusToDb(patch.slaStatus) : null;
    if (patch.slaPausedAtUtc !== undefined)
        data.slaPausedAtUtc = patch.slaPausedAtUtc;
    if (typeof patch.escalationLevel === "number")
        data.escalationLevel = patch.escalationLevel;
    if (patch.escalatedAtUtc !== undefined)
        data.escalatedAtUtc = patch.escalatedAtUtc;
    if (patch.escalatedByUserId !== undefined)
        data.escalatedByUserId = patch.escalatedByUserId;
    if (patch.escalationReason !== undefined)
        data.escalationReason = patch.escalationReason?.slice(0, 400) ?? null;
    if (patch.rejectionReason !== undefined)
        data.rejectionReason = patch.rejectionReason?.slice(0, 400) ?? null;
    if (typeof patch.reopenCount === "number")
        data.reopenCount = patch.reopenCount;
    if (patch.reopenedAtUtc !== undefined)
        data.reopenedAtUtc = patch.reopenedAtUtc;
    if (patch.reopenedByUserId !== undefined)
        data.reopenedByUserId = patch.reopenedByUserId;
    if (patch.lastReviewedAt !== undefined)
        data.lastReviewedAt = patch.lastReviewedAt;
    if (patch.closedAt !== undefined)
        data.closedAt = patch.closedAt;
    if (patch.priority !== undefined)
        data.priority = patch.priority;
    const claim = await client.evidenceReviewWorkflow.updateMany({
        where: { id: workflow.id, status: workflow.status },
        data,
    });
    if (claim.count !== 1) {
        // Lost the race; surface the canonical state to the caller.
        const fresh = await client.evidenceReviewWorkflow.findUniqueOrThrow({
            where: { id: workflow.id },
        });
        return fresh;
    }
    return client.evidenceReviewWorkflow.findUniqueOrThrow({
        where: { id: workflow.id },
    });
}
async function recordEvent(workflow, eventType, actorUserId, note, previousValue, nextValue, client) {
    try {
        await client.evidenceReviewWorkflowEvent.create({
            data: {
                workflowId: workflow.id,
                evidenceId: workflow.evidenceId,
                actorUserId: actorUserId ?? null,
                eventType,
                previousValue: (previousValue ?? null),
                nextValue: (nextValue ?? null),
                note: note?.slice(0, 1000) ?? null,
            },
        });
    }
    catch {
        /* never fail the caller on event-history write */
    }
}
/**
 * OWNER/ADMIN-driven assignment. If the workflow is already assigned
 * to a different user, the existing assignment is replaced and a
 * REASSIGNED event is emitted. Setting the same assignee is a no-op
 * heartbeat (no event, no timestamp bump).
 */
export async function assignReviewer(input, client = defaultPrisma) {
    const workflow = await client.evidenceReviewWorkflow.findUnique({
        where: { evidenceId: input.evidenceId },
    });
    if (!workflow)
        throw new ReviewOperationError("workflow_not_found");
    if (workflow.assignedToUserId === input.assignedToUserId) {
        return workflow; // no-op
    }
    const now = new Date();
    const isReassignment = !!workflow.assignedToUserId;
    const fromStage = mapDbStatusToReviewStage(workflow.status);
    // Assignment alone does not change stage unless we're still in QUEUED.
    const targetStage = fromStage === "QUEUED" ? "ASSIGNED" : fromStage;
    const updated = await applyTransition(workflow, targetStage, {
        assignedToUserId: input.assignedToUserId,
        assignedByUserId: input.actorUserId,
        assignedAtUtc: workflow.assignedAtUtc ?? now,
        reassignedAtUtc: isReassignment ? now : workflow.reassignedAtUtc,
    }, client);
    await recordEvent(workflow, isReassignment ? "REASSIGNED" : "ASSIGNED", input.actorUserId, input.note, { assignedToUserId: workflow.assignedToUserId, stage: fromStage }, { assignedToUserId: input.assignedToUserId, stage: targetStage }, client);
    // Phase 13.5 — notify the new assignee. Safe wrapper: failure of
    // notification dispatch MUST NOT undo the assignment.
    notifyReviewAssigned({ workflow: updated, actorUserId: input.actorUserId, isReassignment }, client).catch(() => null);
    return updated;
}
/**
 * REVIEWER-driven self-claim. Only succeeds when the workflow is
 * unassigned. Reassignment of an already-claimed workflow has to go
 * through `assignReviewer` (admin path).
 */
export async function claimReviewerWorkflow(input, client = defaultPrisma) {
    const workflow = await client.evidenceReviewWorkflow.findUnique({
        where: { evidenceId: input.evidenceId },
    });
    if (!workflow)
        throw new ReviewOperationError("workflow_not_found");
    if (workflow.assignedToUserId &&
        workflow.assignedToUserId !== input.actorUserId) {
        throw new ReviewOperationError("already_assigned_elsewhere");
    }
    const now = new Date();
    const fromStage = mapDbStatusToReviewStage(workflow.status);
    const targetStage = fromStage === "QUEUED" ? "ASSIGNED" : fromStage;
    const updated = await applyTransition(workflow, targetStage, {
        assignedToUserId: input.actorUserId,
        assignedByUserId: input.actorUserId,
        assignedAtUtc: workflow.assignedAtUtc ?? now,
    }, client);
    await recordEvent(workflow, "CLAIMED", input.actorUserId, null, { assignedToUserId: workflow.assignedToUserId, stage: fromStage }, { assignedToUserId: input.actorUserId, stage: targetStage }, client);
    return updated;
}
export async function recordReviewDecision(input, client = defaultPrisma) {
    const workflow = await client.evidenceReviewWorkflow.findUnique({
        where: { evidenceId: input.evidenceId },
    });
    if (!workflow)
        throw new ReviewOperationError("workflow_not_found");
    if (decisionRequiresNote(input.decision)) {
        const noteText = (input.note ?? input.escalationReason ?? "").trim();
        if (!noteText) {
            throw new ReviewOperationError("note_required", {
                decision: input.decision,
            });
        }
    }
    const fromStage = mapDbStatusToReviewStage(workflow.status);
    const toStage = decisionTargetStage(input.decision);
    const now = new Date();
    const patch = {};
    let eventType = "DECISION_LOGGED";
    switch (input.decision) {
        case "APPROVE_INTERNAL":
            patch.lastReviewedAt = now;
            patch.completedAtUtc = now;
            eventType = "APPROVED_INTERNAL";
            break;
        case "REQUEST_MORE_INFO":
            eventType = "NEEDS_MORE_INFO";
            break;
        case "REJECT_INSUFFICIENT":
            patch.rejectionReason = input.note ?? null;
            patch.lastReviewedAt = now;
            patch.completedAtUtc = now;
            eventType = "REJECTED_INSUFFICIENT";
            break;
        case "ESCALATE":
            patch.escalationLevel = workflow.escalationLevel + 1;
            patch.escalatedAtUtc = now;
            patch.escalatedByUserId = input.actorUserId;
            patch.escalationReason = input.escalationReason ?? input.note ?? null;
            eventType = "ESCALATED";
            break;
        case "REOPEN":
            patch.reopenCount = workflow.reopenCount + 1;
            patch.reopenedAtUtc = now;
            patch.reopenedByUserId = input.actorUserId;
            // Clear terminal markers so subsequent transitions are valid.
            patch.completedAtUtc = null;
            patch.closedAt = null;
            eventType = "REOPENED";
            break;
        case "CLOSE":
            patch.closedAt = input.closedAt ?? now;
            eventType = "CLOSED";
            break;
    }
    const updated = await applyTransition(workflow, toStage, patch, client);
    await recordEvent(workflow, eventType, input.actorUserId, input.note, { stage: fromStage }, { stage: toStage, decision: input.decision }, client);
    // Phase 13.5 — operational notification dispatch. Internal-only:
    // bodies never include the operator note, rejection reason, or
    // escalation reason. Safe wrappers — failure does not undo the
    // decision.
    switch (input.decision) {
        case "ESCALATE":
            notifyReviewEscalated({ workflow: updated, actorUserId: input.actorUserId }, client).catch(() => null);
            break;
        case "REQUEST_MORE_INFO":
            notifyReviewNeedsMoreInfo({ workflow: updated, actorUserId: input.actorUserId }, client).catch(() => null);
            break;
        default:
            break;
    }
    return updated;
}
export async function updateReviewSla(input, client = defaultPrisma) {
    const workflow = await client.evidenceReviewWorkflow.findUnique({
        where: { evidenceId: input.evidenceId },
    });
    if (!workflow)
        throw new ReviewOperationError("workflow_not_found");
    const patch = {};
    if (input.dueAt !== undefined)
        patch.dueAt = input.dueAt;
    if (input.firstResponseDueAtUtc !== undefined)
        patch.firstResponseDueAtUtc = input.firstResponseDueAtUtc;
    if (input.escalationDueAtUtc !== undefined)
        patch.escalationDueAtUtc = input.escalationDueAtUtc;
    if (typeof input.paused === "boolean") {
        patch.slaPausedAtUtc = input.paused ? new Date() : null;
    }
    // Recompute SLA status with the effective due dates.
    const effectiveDue = input.dueAt !== undefined ? input.dueAt : workflow.dueAt;
    const effectiveFirstResponse = input.firstResponseDueAtUtc !== undefined
        ? input.firstResponseDueAtUtc
        : workflow.firstResponseDueAtUtc;
    const computed = computeReviewSlaStatus({
        dueAtUtc: effectiveDue,
        firstResponseDueAtUtc: effectiveFirstResponse,
        completedAtUtc: workflow.completedAtUtc,
        paused: input.paused ?? !!workflow.slaPausedAtUtc,
    });
    patch.slaStatus = computed;
    const stage = mapDbStatusToReviewStage(workflow.status);
    const updated = await applyTransition(workflow, stage, patch, client);
    await recordEvent(workflow, "SLA_UPDATED", input.actorUserId, input.note, {
        dueAt: workflow.dueAt,
        firstResponseDueAtUtc: workflow.firstResponseDueAtUtc,
        slaStatus: workflow.slaStatus,
    }, {
        dueAt: patch.dueAt ?? workflow.dueAt,
        firstResponseDueAtUtc: patch.firstResponseDueAtUtc ?? workflow.firstResponseDueAtUtc,
        slaStatus: computed,
    }, client);
    return updated;
}
/**
 * Recompute SLA status for a list of workflows and flip BREACHED rows.
 * Best-effort; used by the reconciliation route. Emits SLA_BREACHED
 * events when a row crosses the threshold.
 *
 * Phase 13.5 guarantees:
 *   - completed workflows are skipped (completedAtUtc set)
 *   - paused workflows are skipped
 *   - SLA_BREACHED event + notification fire ONCE per workflow per
 *     transition into BREACHED. Subsequent sweeps see slaStatus =
 *     BREACHED already and emit nothing.
 */
export async function reconcileReviewSlas(input = {}, client = defaultPrisma) {
    const batchSize = Math.min(Math.max(input.batchSize ?? 200, 1), 2000);
    const candidates = await client.evidenceReviewWorkflow.findMany({
        where: {
            ...(input.teamId ? { teamId: input.teamId } : {}),
            dueAt: { not: null },
            // Skip completed + already-breached rows so the sweep is
            // idempotent. Already-BREACHED rows do NOT re-emit events.
            slaStatus: { in: ["ON_TRACK", "DUE_SOON", "OVERDUE"] },
            // Skip closed/terminal workflows; their review is over.
            status: { notIn: ["CLOSED", "REJECTED_INSUFFICIENT", "APPROVED_INTERNAL"] },
        },
        take: batchSize,
    });
    let flippedBreached = 0;
    let flippedOverdue = 0;
    let flippedDueSoon = 0;
    let skippedCompleted = 0;
    let skippedPaused = 0;
    for (const wf of candidates) {
        if (wf.completedAtUtc) {
            skippedCompleted += 1;
            continue;
        }
        if (wf.slaPausedAtUtc) {
            skippedPaused += 1;
            continue;
        }
        const computed = computeReviewSlaStatus({
            dueAtUtc: wf.dueAt,
            firstResponseDueAtUtc: wf.firstResponseDueAtUtc,
            completedAtUtc: wf.completedAtUtc,
            paused: false,
        });
        if (!computed || computed === wf.slaStatus)
            continue;
        const stage = mapDbStatusToReviewStage(wf.status);
        try {
            await applyTransition(wf, stage, { slaStatus: computed }, client);
            if (computed === "BREACHED" && wf.slaStatus !== "BREACHED") {
                flippedBreached += 1;
                await recordEvent(wf, "SLA_BREACHED", null, null, { slaStatus: wf.slaStatus }, { slaStatus: computed }, client);
                // One overdue-reminder email per BREACHED transition. Safe.
                notifyReviewSlaBreached({ workflow: wf }, client).catch(() => null);
            }
            else if (computed === "OVERDUE") {
                flippedOverdue += 1;
            }
            else if (computed === "DUE_SOON") {
                flippedDueSoon += 1;
            }
        }
        catch {
            /* ignore; sweeper is best-effort */
        }
    }
    return {
        scanned: candidates.length,
        flippedBreached,
        flippedOverdue,
        flippedDueSoon,
        skippedCompleted,
        skippedPaused,
    };
}
const SENSITIVE_BULK_ACTIONS = new Set([
    "ESCALATE",
    "REQUEST_MORE_INFO",
]);
export async function bulkReviewAction(input, client = defaultPrisma) {
    if (SENSITIVE_BULK_ACTIONS.has(input.action)) {
        const noteText = (input.note ?? "").trim();
        if (!noteText) {
            throw new ReviewOperationError("note_required", {
                action: input.action,
            });
        }
    }
    if (input.action === "ASSIGN" && !input.assignedToUserId) {
        throw new ReviewOperationError("permission_denied", {
            reason: "assignedToUserId_required",
        });
    }
    const items = [];
    let succeeded = 0;
    let failed = 0;
    const uniqueIds = Array.from(new Set(input.evidenceIds)).slice(0, 200);
    for (const evidenceId of uniqueIds) {
        try {
            // Verify the evidence is in the caller's workspace before doing
            // anything — bulk cannot leak workflows from another workspace.
            const workflow = await client.evidenceReviewWorkflow.findUnique({
                where: { evidenceId },
                select: { id: true, teamId: true, status: true },
            });
            if (!workflow || workflow.teamId !== input.teamId) {
                items.push({
                    evidenceId,
                    ok: false,
                    reason: "not_in_workspace",
                });
                failed += 1;
                continue;
            }
            let toStage = null;
            switch (input.action) {
                case "ASSIGN":
                    await assignReviewer({
                        evidenceId,
                        assignedToUserId: input.assignedToUserId,
                        actorUserId: input.actorUserId,
                        note: input.note ?? null,
                    }, client);
                    toStage = "ASSIGNED";
                    break;
                case "MARK_IN_REVIEW":
                    toStage = "IN_REVIEW";
                    await applyTransition((await client.evidenceReviewWorkflow.findUniqueOrThrow({
                        where: { id: workflow.id },
                    })), "IN_REVIEW", { lastReviewedAt: new Date() }, client);
                    await recordEvent((await client.evidenceReviewWorkflow.findUniqueOrThrow({
                        where: { id: workflow.id },
                    })), "STAGE_CHANGED", input.actorUserId, input.note, { stage: mapDbStatusToReviewStage(workflow.status) }, { stage: "IN_REVIEW" }, client);
                    break;
                case "ESCALATE":
                    await recordReviewDecision({
                        evidenceId,
                        decision: "ESCALATE",
                        actorUserId: input.actorUserId,
                        note: input.note,
                        escalationReason: input.note,
                    }, client);
                    toStage = "ESCALATED";
                    break;
                case "CLOSE":
                    await recordReviewDecision({
                        evidenceId,
                        decision: "CLOSE",
                        actorUserId: input.actorUserId,
                        note: input.note,
                    }, client);
                    toStage = "CLOSED";
                    break;
                case "REQUEST_MORE_INFO":
                    await recordReviewDecision({
                        evidenceId,
                        decision: "REQUEST_MORE_INFO",
                        actorUserId: input.actorUserId,
                        note: input.note,
                    }, client);
                    toStage = "NEEDS_MORE_INFO";
                    break;
            }
            items.push({ evidenceId, ok: true, toStage: toStage ?? undefined });
            succeeded += 1;
        }
        catch (err) {
            const reason = err instanceof ReviewOperationError
                ? err.code
                : "operation_failed";
            items.push({ evidenceId, ok: false, reason });
            failed += 1;
        }
    }
    // Record a single BULK_ACTION event on the first workflow (audit
    // breadcrumb only — individual events are recorded above per item).
    if (uniqueIds[0]) {
        const first = await client.evidenceReviewWorkflow.findUnique({
            where: { evidenceId: uniqueIds[0] },
        });
        if (first) {
            await recordEvent(first, "BULK_ACTION", input.actorUserId, input.note, null, { action: input.action, total: uniqueIds.length, succeeded, failed }, client);
        }
    }
    return { total: uniqueIds.length, succeeded, failed, items };
}
export async function listReviewQueue(input, client = defaultPrisma) {
    return client.evidenceReviewWorkflow.findMany({
        where: {
            teamId: input.teamId,
            ...(input.stage ? { status: stageToDbStatus(input.stage) } : {}),
            ...(input.slaStatus
                ? { slaStatus: slaStatusToDb(input.slaStatus) }
                : {}),
            ...(input.assignedToUserId
                ? { assignedToUserId: input.assignedToUserId }
                : {}),
            ...(input.unassigned ? { assignedToUserId: null } : {}),
            ...(input.priority ? { priority: input.priority } : {}),
            ...(input.escalated ? { escalationLevel: { gt: 0 } } : {}),
        },
        orderBy: [
            { priority: "desc" },
            { dueAt: "asc" },
            { updatedAt: "desc" },
        ],
        take: Math.min(Math.max(input.limit ?? 50, 1), 200),
    });
}
export async function getReviewQueueCounts(input, client = defaultPrisma) {
    const stageRows = await client.evidenceReviewWorkflow.groupBy({
        by: ["status"],
        where: { teamId: input.teamId },
        _count: { _all: true },
    });
    const byStage = {
        QUEUED: 0,
        ASSIGNED: 0,
        IN_REVIEW: 0,
        NEEDS_MORE_INFO: 0,
        RESPONSE_RECEIVED: 0,
        APPROVED_INTERNAL: 0,
        REJECTED_INSUFFICIENT: 0,
        ESCALATED: 0,
        REOPENED: 0,
        CLOSED: 0,
    };
    for (const r of stageRows) {
        const mapped = mapDbStatusToReviewStage(r.status);
        byStage[mapped] += r._count._all;
    }
    const [overdue, dueSoon, unassigned, mine] = await Promise.all([
        client.evidenceReviewWorkflow.count({
            where: {
                teamId: input.teamId,
                slaStatus: { in: ["OVERDUE", "BREACHED"] },
            },
        }),
        client.evidenceReviewWorkflow.count({
            where: { teamId: input.teamId, slaStatus: "DUE_SOON" },
        }),
        client.evidenceReviewWorkflow.count({
            where: {
                teamId: input.teamId,
                assignedToUserId: null,
                status: { notIn: ["CLOSED", "REJECTED_INSUFFICIENT"] },
            },
        }),
        input.meUserId
            ? client.evidenceReviewWorkflow.count({
                where: {
                    teamId: input.teamId,
                    assignedToUserId: input.meUserId,
                    status: { notIn: ["CLOSED", "REJECTED_INSUFFICIENT"] },
                },
            })
            : Promise.resolve(0),
    ]);
    return {
        byStage,
        overdue,
        dueSoon,
        unassigned,
        assignedToMe: mine,
    };
}
export function projectReviewWorkflow(row) {
    const stage = mapDbStatusToReviewStage(row.status);
    return {
        id: row.id,
        evidenceId: row.evidenceId,
        teamId: row.teamId,
        stage,
        approvedForGovernanceGate: reviewStageSatisfiesGovernanceGate(stage),
        priority: row.priority,
        assignedToUserId: row.assignedToUserId,
        assignedByUserId: row.assignedByUserId,
        assignedAtUtc: row.assignedAtUtc?.toISOString() ?? null,
        reassignedAtUtc: row.reassignedAtUtc?.toISOString() ?? null,
        dueAt: row.dueAt?.toISOString() ?? null,
        firstResponseDueAtUtc: row.firstResponseDueAtUtc?.toISOString() ?? null,
        escalationDueAtUtc: row.escalationDueAtUtc?.toISOString() ?? null,
        completedAtUtc: row.completedAtUtc?.toISOString() ?? null,
        closedAt: row.closedAt?.toISOString() ?? null,
        slaStatus: row.slaStatus,
        escalationLevel: row.escalationLevel,
        escalatedAtUtc: row.escalatedAtUtc?.toISOString() ?? null,
        escalatedByUserId: row.escalatedByUserId,
        escalationReason: row.escalationReason,
        reopenCount: row.reopenCount,
        reopenedAtUtc: row.reopenedAtUtc?.toISOString() ?? null,
        rejectionReason: row.rejectionReason,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        // Deliberately NOT projected: internal `workspaceType`, raw `status`
        // (use `stage` instead).
    };
}
