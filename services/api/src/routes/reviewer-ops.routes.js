/**
 * Phase 25 — Reviewer Operations Intelligence + SLA Engine routes.
 *
 *   GET  /v1/reviewer-ops/queue?teamId&queue&limit
 *   GET  /v1/reviewer-ops/dashboard?teamId
 *   GET  /v1/reviewer-ops/workspace/:workflowId?teamId
 *   GET  /v1/reviewer-ops/workload?teamId&limit
 *
 *   POST /v1/reviewer-ops/reviews/:workflowId/assign
 *   POST /v1/reviewer-ops/reviews/:workflowId/reassign
 *   POST /v1/reviewer-ops/reviews/:workflowId/start
 *   POST /v1/reviewer-ops/reviews/:workflowId/pause
 *   POST /v1/reviewer-ops/reviews/:workflowId/request-info
 *   POST /v1/reviewer-ops/reviews/:workflowId/approve
 *   POST /v1/reviewer-ops/reviews/:workflowId/reject
 *
 *   GET  /v1/reviewer-ops/escalations?teamId&status&severity&reason
 *   POST /v1/reviewer-ops/escalations/:id/acknowledge
 *   POST /v1/reviewer-ops/escalations/:id/reassign
 *   POST /v1/reviewer-ops/escalations/:id/resolve
 *   POST /v1/reviewer-ops/escalations/:id/suppress
 *
 *   POST /v1/reviewer-ops/reconcile (cron-secret protected)
 *
 * Auth posture:
 *   - All routes (except reconcile) use `requireAuth` + a Phase 17
 *     workspace-membership gate (404 on non-member, anti-enumeration).
 *   - Reviewer actions gate on `evidence_request.review`.
 *   - Reconcile uses a shared-secret header (REVIEWER_OPS_CRON_SECRET
 *     or INTEGRATION_CRON_SECRET fallback).
 *   - Errors map to the Phase 25 ReviewerOpsErrorCode catalog.
 */
import { z } from "zod";
import { ReviewerOpsBulkInputSchema, ReviewerOpsSavedViewFilterSchema, ReviewerOpsSlaPolicySchema, REVIEWER_OPS_QUEUE_TYPES, REVIEW_ESCALATION_REASONS, REVIEW_ESCALATION_STATUSES, SAVED_VIEW_VISIBILITIES, } from "@proovra/shared";
import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { evaluateMemberAccess } from "../services/identity/access-policy.service.js";
import { ReviewerOpsError, approveReview, assignReviewerToWorkflow, buildDashboard, getReviewerOpsWorkspace, listReviewerOpsQueue, pauseReview, rejectReview, requestInformation, runReconcile, startReview, } from "../services/reviewer-ops/reviewer-operations-engine.service.js";
import { projectQueueIntelligence } from "../services/reviewer-ops/queue-intelligence.service.js";
import { EscalationEngineError, acknowledgeEscalation, createEscalation, findOpenEscalationForWorkflow, listEscalations, reassignEscalation, resolveEscalation, suppressEscalation, } from "../services/reviewer-ops/escalation-engine.service.js";
import { computeReviewerWorkload, listLatestWorkloadSnapshots, suggestReviewers, } from "../services/reviewer-ops/workload.service.js";
import { loadWorkspaceReviewerOpsFlags, resolveEffectiveSlaPolicy, upsertWorkspaceReviewerOpsFlags, upsertWorkspaceSlaPolicy, } from "../services/reviewer-ops/sla-policy.service.js";
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";
import { runtimeAdaptiveGate } from "../services/access-control/adaptive-runtime-gate.service.js";
import { executeBulkTriage } from "../services/reviewer-ops/bulk-triage.service.js";
import { createReviewerOpsSavedView, deleteReviewerOpsSavedView, listReviewerOpsSavedViews, } from "../services/reviewer-ops/saved-queue-views.service.js";
import { getEscalationAnalytics, getReviewerPerformance, } from "../services/reviewer-ops/analytics.service.js";
import { bump } from "../services/ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../services/security/security-event.service.js";
// -----------------------------------------------------------------------------
// Auth helpers — 404-on-non-member + reviewer-capability resolution
// -----------------------------------------------------------------------------
async function requireReviewerActor(req, reply, teamId) {
    const userId = getAuthUserId(req);
    const member = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId, userId } },
        select: { id: true, status: true },
    });
    if (!member) {
        reply.code(404).send({ error: { code: "not_found" } });
        return null;
    }
    if (member.status !== "ACTIVE") {
        reply.code(403).send({
            error: { code: "REVIEW_ACTOR_BLOCKED", reason: "member_inactive" },
        });
        return null;
    }
    // Reviewer permission gate. Service-account JWTs are detected via
    // the auth surface; we look up the user record to read the kind.
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true },
    });
    if (!user) {
        reply.code(404).send({ error: { code: "not_found" } });
        return null;
    }
    const reviewerCheck = await evaluateMemberAccess({
        teamId,
        userId,
        permission: "evidence_request.review",
    });
    // We treat anyone WITHOUT reviewer permission as still able to view
    // (so admins can dashboard), but write operations re-check.
    return {
        teamId,
        actorUserId: userId,
        isReviewerCapable: reviewerCheck.allowed,
        isServiceAccount: false,
    };
}
function requireReviewerCapable(ctx, reply) {
    if (!ctx.isReviewerCapable) {
        reply.code(403).send({
            error: {
                code: "REVIEW_PERMISSION_DENIED",
                reason: "reviewer_required",
            },
        });
        return false;
    }
    return true;
}
const STEP_UP_PURPOSE_BY_GATE = {
    approve: "REVIEW_APPROVAL_HIGH_RISK",
    reject: "REVIEWER_OPS_REJECT",
    escalationResolve: "REVIEWER_OPS_ESCALATION_RESOLVE",
    bulk: "REVIEWER_OPS_BULK_ACTION",
};
const STEP_UP_FLAG_BY_GATE = {
    approve: "requireStepUpForApprove",
    reject: "requireStepUpForReject",
    escalationResolve: "requireStepUpForEscalationResolve",
    bulk: "requireStepUpForBulk",
};
async function enforceStepUpIfFlagged(req, reply, ctx, gate, resource) {
    const flags = await loadWorkspaceReviewerOpsFlags(ctx.teamId);
    const flagKey = STEP_UP_FLAG_BY_GATE[gate];
    if (!flags[flagKey])
        return false; // not required → proceed
    const result = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: ctx.teamId,
        userId: ctx.actorUserId,
        purpose: STEP_UP_PURPOSE_BY_GATE[gate],
        resourceKind: resource.kind,
        resourceId: resource.id,
    });
    return result.sent; // true → middleware already replied
}
// -----------------------------------------------------------------------------
// Error mapping
// -----------------------------------------------------------------------------
function sendEngineError(reply, err) {
    if (err instanceof ReviewerOpsError) {
        const status = err.code === "REVIEW_WORKFLOW_NOT_FOUND"
            ? 404
            : err.code === "REVIEW_PERMISSION_DENIED" ||
                err.code === "REVIEW_ACTOR_BLOCKED" ||
                err.code === "REVIEW_GOVERNANCE_BLOCKED"
                ? 403
                : err.code === "REVIEW_STEP_UP_REQUIRED"
                    ? 401
                    : 409;
        reply
            .code(status)
            .send({ error: { code: err.code, details: err.details ?? null } });
        return true;
    }
    if (err instanceof EscalationEngineError) {
        const status = err.code === "REVIEW_ESCALATION_NOT_FOUND" ||
            err.code === "REVIEW_WORKFLOW_NOT_FOUND"
            ? 404
            : err.code === "REVIEW_PERMISSION_DENIED"
                ? 403
                : 409;
        reply
            .code(status)
            .send({ error: { code: err.code, details: err.details ?? null } });
        return true;
    }
    return false;
}
// -----------------------------------------------------------------------------
// Param + body schemas
// -----------------------------------------------------------------------------
const TeamIdQuery = z.object({ teamId: z.string().uuid() });
const ParamsWorkflowId = z.object({ workflowId: z.string().uuid() });
const ParamsId = z.object({ id: z.string().uuid() });
const BoundedNote = z.string().min(1).max(1000);
/**
 * Per-team wrapper around `runReconcile()` used by the all-teams
 * sweep. A failure for one team must NOT abort the rest of the
 * sweep — we capture the error into a structured result and let the
 * loop carry on. The route catch-block contract (every `catch (err)`
 * must call `sendEngineError` or `throw err`) is honored by isolating
 * the try/catch inside this helper, which lives outside any route
 * handler.
 */
async function runReconcileSafely(input) {
    try {
        const result = await runReconcile({
            teamId: input.teamId,
            batchSize: input.batchSize,
        });
        return { ok: true, result };
    }
    catch (e) {
        return {
            ok: false,
            error: e instanceof Error ? e.message : "unknown_error",
        };
    }
}
// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------
export async function reviewerOpsRoutes(app) {
    // ===========================================================================
    // GET /v1/reviewer-ops/queue
    // ===========================================================================
    app.get("/v1/reviewer-ops/queue", { preHandler: requireAuth }, async (req, reply) => {
        // Phase O Stage 3 (Sentry NODE-1G repair):
        //   - Operators previously hit a ZodError when calling without
        //     `teamId` OR with `limit > 100`. The ZodError leaked through
        //     the central error handler as a 500 (captured by Sentry).
        //   - Resolve teamId from the canonical workspace context
        //     (`user.currentWorkspaceId`) when the query omits it. Then
        //     run Zod (safeParse) against the resolved object. The
        //     limit cap is preserved (≤100) but now surfaces as a
        //     bounded INVALID_QUERY 400 instead of a 500.
        const rawQuery = (req.query ?? {});
        let resolvedTeamId = rawQuery.teamId;
        if (!resolvedTeamId) {
            const userId = getAuthUserId(req);
            const user = await prisma.user.findUnique({
                where: { id: userId },
                select: { currentWorkspaceId: true },
            });
            if (!user?.currentWorkspaceId) {
                return reply.code(400).send({
                    error: {
                        code: "WORKSPACE_CONTEXT_REQUIRED",
                        message: "Select a workspace to view the reviewer queue.",
                        requestId: req.id,
                    },
                });
            }
            resolvedTeamId = user.currentWorkspaceId;
        }
        const QueueQuery = z.object({
            teamId: z.string().uuid(),
            queue: z.enum(REVIEWER_OPS_QUEUE_TYPES).default("UNASSIGNED"),
            // `.max(100).optional().default(50)` matches the audit
            // direction. The cap is preserved; the default makes the
            // limit explicitly bounded rather than implicitly so.
            limit: z.coerce.number().int().min(1).max(100).optional().default(50),
        });
        const parsed = QueueQuery.safeParse({
            ...rawQuery,
            teamId: resolvedTeamId,
        });
        if (!parsed.success) {
            const fieldSummary = parsed.error.issues
                .map((issue) => issue.path.join("."))
                .filter((p) => p.length > 0)
                .slice(0, 4)
                .join(", ");
            return reply.code(400).send({
                error: {
                    code: "INVALID_QUERY",
                    message: fieldSummary.length > 0
                        ? `Query parameters invalid: ${fieldSummary}`
                        : "Query parameters invalid.",
                    requestId: req.id,
                },
            });
        }
        const q = parsed.data;
        const ctx = await requireReviewerActor(req, reply, q.teamId);
        if (!ctx)
            return;
        const result = await listReviewerOpsQueue({
            teamId: q.teamId,
            meUserId: ctx.actorUserId,
            queue: q.queue,
            limit: q.limit,
        });
        return reply.code(200).send(result);
    });
    // ===========================================================================
    // POST /v1/reviewer-ops/queue-intelligence
    // Phase 25.7 — single projection endpoint that hydrates queue rows
    // with priority + stuck + assignment-suggestion + workload pressure
    // + governance blockers. Bounded to 100 workflowIds per call.
    // ===========================================================================
    app.post("/v1/reviewer-ops/queue-intelligence", { preHandler: requireAuth }, async (req, reply) => {
        const body = z
            .object({
            teamId: z.string().uuid(),
            workflowIds: z.array(z.string().uuid()).min(1).max(100),
        })
            .parse(req.body ?? {});
        const ctx = await requireReviewerActor(req, reply, body.teamId);
        if (!ctx)
            return;
        const result = await projectQueueIntelligence({
            teamId: body.teamId,
            workflowIds: body.workflowIds,
            actorUserId: ctx.actorUserId,
            isReviewerCapable: ctx.isReviewerCapable,
        });
        return reply.code(200).send(result);
    });
    // ===========================================================================
    // GET /v1/reviewer-ops/dashboard
    // ===========================================================================
    app.get("/v1/reviewer-ops/dashboard", { preHandler: requireAuth }, async (req, reply) => {
        const q = TeamIdQuery.parse(req.query ?? {});
        const ctx = await requireReviewerActor(req, reply, q.teamId);
        if (!ctx)
            return;
        const dashboard = await buildDashboard({
            teamId: q.teamId,
            meUserId: ctx.actorUserId,
        });
        return reply.code(200).send(dashboard);
    });
    // ===========================================================================
    // GET /v1/reviewer-ops/workspace/:workflowId
    // ===========================================================================
    app.get("/v1/reviewer-ops/workspace/:workflowId", { preHandler: requireAuth }, async (req, reply) => {
        const { workflowId } = ParamsWorkflowId.parse(req.params);
        const q = TeamIdQuery.parse(req.query ?? {});
        const ctx = await requireReviewerActor(req, reply, q.teamId);
        if (!ctx)
            return;
        try {
            const ws = await getReviewerOpsWorkspace({
                teamId: q.teamId,
                workflowId,
            });
            // Phase B-2 — surface real governance signals the engine
            // projection doesn't carry: ACTIVE legal holds on the
            // underlying evidence, and the `requiresRedaction` flag on
            // the workflow event itself. Both are workspace-scoped reads
            // gated by the same `requireReviewerActor` check above; they
            // never leak cross-workspace data because we filter on
            // `teamId = q.teamId`.
            //
            // legalHolds is intentionally surfaced as a COUNT + a single
            // most-recent ACTIVE hold for in-page operational density.
            // The full list lives on the existing governance surfaces
            // (/governance/lifecycle, /governance/retention) and is
            // gated by a separate capability there. ORG_MEMBER reviewers
            // see the SIGNAL (hold present) but not necessarily the full
            // metadata, which preserves the existing governance gating.
            const evidenceId = ws.projection.evidenceId;
            const [activeHoldsCount, mostRecentHold, redactionRequiredFieldCount] = evidenceId
                ? await Promise.all([
                    prisma.evidenceLegalHold.count({
                        where: {
                            teamId: q.teamId,
                            evidenceId,
                            status: "ACTIVE",
                        },
                    }),
                    prisma.evidenceLegalHold.findFirst({
                        where: {
                            teamId: q.teamId,
                            evidenceId,
                            status: "ACTIVE",
                        },
                        orderBy: { placedAtUtc: "desc" },
                        select: {
                            id: true,
                            title: true,
                            placedAtUtc: true,
                        },
                    }),
                    // Phase B-2 — `requiresRedaction` lives on the
                    // per-field `EvidenceWorkflowVisibilityDecision`
                    // table, not on the workflow event. A single TRUE
                    // row on this evidence means at least one field's
                    // visibility policy decided redaction is required
                    // before export — a real governance signal.
                    prisma.evidenceWorkflowVisibilityDecision.count({
                        where: {
                            evidenceId,
                            requiresRedaction: true,
                        },
                    }),
                ])
                : [0, null, null];
            return reply.code(200).send({
                ...ws,
                // Phase B-2 — additive governance block. Existing consumers
                // ignore this; new consumers (the reviewer detail page UI)
                // render it as a small read-only badge strip.
                governance: {
                    legalHold: {
                        activeCount: activeHoldsCount,
                        mostRecent: mostRecentHold
                            ? {
                                id: mostRecentHold.id,
                                title: mostRecentHold.title,
                                placedAtUtc: mostRecentHold.placedAtUtc.toISOString(),
                            }
                            : null,
                    },
                    requiresRedaction: (redactionRequiredFieldCount ?? 0) > 0,
                    requiresRedactionFieldCount: redactionRequiredFieldCount ?? 0,
                },
            });
        }
        catch (err) {
            if (sendEngineError(reply, err))
                return;
            throw err;
        }
    });
    // ===========================================================================
    // GET /v1/reviewer-ops/workload
    // ===========================================================================
    app.get("/v1/reviewer-ops/workload", { preHandler: requireAuth }, async (req, reply) => {
        const q = z
            .object({
            teamId: z.string().uuid(),
            limit: z.coerce.number().int().min(1).max(200).optional(),
            reviewerUserId: z.string().uuid().optional(),
            suggest: z.coerce.boolean().optional(),
        })
            .parse(req.query ?? {});
        const ctx = await requireReviewerActor(req, reply, q.teamId);
        if (!ctx)
            return;
        if (q.reviewerUserId) {
            const counts = await computeReviewerWorkload({
                teamId: q.teamId,
                reviewerUserId: q.reviewerUserId,
            });
            return reply.code(200).send({ counts });
        }
        const [snapshots, suggestions] = await Promise.all([
            listLatestWorkloadSnapshots({ teamId: q.teamId, limit: q.limit }),
            q.suggest
                ? suggestReviewers({ teamId: q.teamId, topN: 5 })
                : Promise.resolve([]),
        ]);
        return reply.code(200).send({ snapshots, suggestions });
    });
    // ===========================================================================
    // POST /v1/reviewer-ops/reviews/:workflowId/assign + reassign
    // ===========================================================================
    app.post("/v1/reviewer-ops/reviews/:workflowId/assign", { preHandler: requireAuth }, async (req, reply) => {
        const { workflowId } = ParamsWorkflowId.parse(req.params);
        const body = z
            .object({
            teamId: z.string().uuid(),
            assignedToUserId: z.string().uuid(),
            note: BoundedNote.nullable().optional(),
        })
            .parse(req.body ?? {});
        const ctx = await requireReviewerActor(req, reply, body.teamId);
        if (!ctx)
            return;
        if (!requireReviewerCapable(ctx, reply))
            return;
        // 4B-I1: QUOTA_REVIEWER_SEATS — gate before reviewer assignment.
        // Denial: 403 { denial: "QUOTA_EXCEEDED", entitlement: "QUOTA_REVIEWER_SEATS" }.
        // recordEntitlementUsage is fire-and-forget. Engine errors are swallowed.
        try {
            const { assertQuotaEntitlement, recordEntitlementUsage } = await import("../services/packaging/entitlement.service.js");
            const qSeats = await assertQuotaEntitlement({
                teamId: body.teamId,
                key: "QUOTA_REVIEWER_SEATS",
                requested: 1,
                actorUserId: getAuthUserId(req),
            });
            if (!qSeats.ok) {
                return reply.code(403).send({
                    denial: "QUOTA_EXCEEDED",
                    entitlement: "QUOTA_REVIEWER_SEATS",
                });
            }
            recordEntitlementUsage({
                teamId: body.teamId,
                key: "QUOTA_REVIEWER_SEATS",
                amount: 1,
            }).catch(() => null);
        }
        catch {
            /* entitlement engine error — do not block reviewer assignment */
        }
        try {
            const result = await assignReviewerToWorkflow(ctx, {
                workflowId,
                assignedToUserId: body.assignedToUserId,
                note: body.note ?? null,
            });
            return reply.code(200).send({ projection: result });
        }
        catch (err) {
            if (sendEngineError(reply, err))
                return;
            throw err;
        }
    });
    app.post("/v1/reviewer-ops/reviews/:workflowId/reassign", { preHandler: requireAuth }, async (req, reply) => {
        const { workflowId } = ParamsWorkflowId.parse(req.params);
        const body = z
            .object({
            teamId: z.string().uuid(),
            newAssigneeUserId: z.string().uuid(),
            note: BoundedNote.nullable().optional(),
        })
            .parse(req.body ?? {});
        const ctx = await requireReviewerActor(req, reply, body.teamId);
        if (!ctx)
            return;
        if (!requireReviewerCapable(ctx, reply))
            return;
        try {
            const result = await assignReviewerToWorkflow(ctx, {
                workflowId,
                assignedToUserId: body.newAssigneeUserId,
                note: body.note ?? null,
            });
            return reply.code(200).send({ projection: result });
        }
        catch (err) {
            if (sendEngineError(reply, err))
                return;
            throw err;
        }
    });
    // ===========================================================================
    // POST /v1/reviewer-ops/reviews/:workflowId/start
    // ===========================================================================
    app.post("/v1/reviewer-ops/reviews/:workflowId/start", { preHandler: requireAuth }, async (req, reply) => {
        const { workflowId } = ParamsWorkflowId.parse(req.params);
        const body = z.object({ teamId: z.string().uuid() }).parse(req.body ?? {});
        const ctx = await requireReviewerActor(req, reply, body.teamId);
        if (!ctx)
            return;
        if (!requireReviewerCapable(ctx, reply))
            return;
        try {
            const result = await startReview(ctx, { workflowId });
            return reply.code(200).send({ projection: result });
        }
        catch (err) {
            if (sendEngineError(reply, err))
                return;
            throw err;
        }
    });
    // ===========================================================================
    // POST /v1/reviewer-ops/reviews/:workflowId/pause
    // ===========================================================================
    app.post("/v1/reviewer-ops/reviews/:workflowId/pause", { preHandler: requireAuth }, async (req, reply) => {
        const { workflowId } = ParamsWorkflowId.parse(req.params);
        const body = z
            .object({
            teamId: z.string().uuid(),
            pausedReason: BoundedNote.max(400),
        })
            .parse(req.body ?? {});
        const ctx = await requireReviewerActor(req, reply, body.teamId);
        if (!ctx)
            return;
        if (!requireReviewerCapable(ctx, reply))
            return;
        try {
            const result = await pauseReview(ctx, {
                workflowId,
                pausedReason: body.pausedReason,
            });
            return reply.code(200).send({ projection: result });
        }
        catch (err) {
            if (sendEngineError(reply, err))
                return;
            throw err;
        }
    });
    // ===========================================================================
    // POST /v1/reviewer-ops/reviews/:workflowId/request-info
    // ===========================================================================
    app.post("/v1/reviewer-ops/reviews/:workflowId/request-info", { preHandler: requireAuth }, async (req, reply) => {
        const { workflowId } = ParamsWorkflowId.parse(req.params);
        const body = z
            .object({ teamId: z.string().uuid(), note: BoundedNote })
            .parse(req.body ?? {});
        const ctx = await requireReviewerActor(req, reply, body.teamId);
        if (!ctx)
            return;
        if (!requireReviewerCapable(ctx, reply))
            return;
        try {
            const result = await requestInformation(ctx, {
                workflowId,
                note: body.note,
            });
            return reply.code(200).send({ projection: result });
        }
        catch (err) {
            if (sendEngineError(reply, err))
                return;
            throw err;
        }
    });
    // ===========================================================================
    // POST /v1/reviewer-ops/reviews/:workflowId/approve
    // ===========================================================================
    app.post("/v1/reviewer-ops/reviews/:workflowId/approve", { preHandler: requireAuth }, async (req, reply) => {
        const { workflowId } = ParamsWorkflowId.parse(req.params);
        const body = z
            .object({
            teamId: z.string().uuid(),
            note: BoundedNote.nullable().optional(),
        })
            .parse(req.body ?? {});
        const ctx = await requireReviewerActor(req, reply, body.teamId);
        if (!ctx)
            return;
        if (!requireReviewerCapable(ctx, reply))
            return;
        // Phase 26.75 — adaptive runtime gate (quarantine + age + risk).
        const gateApprove = await runtimeAdaptiveGate({
            req,
            reply,
            teamId: body.teamId,
            userId: ctx.actorUserId,
            action: "REVIEWER_APPROVE",
        });
        if (!gateApprove.allow)
            return;
        if (await enforceStepUpIfFlagged(req, reply, ctx, "approve", {
            kind: "review_workflow",
            id: workflowId,
        })) {
            return;
        }
        try {
            const result = await approveReview(ctx, {
                workflowId,
                note: body.note ?? null,
            });
            return reply.code(200).send({ projection: result });
        }
        catch (err) {
            if (sendEngineError(reply, err))
                return;
            throw err;
        }
    });
    // ===========================================================================
    // POST /v1/reviewer-ops/reviews/:workflowId/reject
    // ===========================================================================
    app.post("/v1/reviewer-ops/reviews/:workflowId/reject", { preHandler: requireAuth }, async (req, reply) => {
        const { workflowId } = ParamsWorkflowId.parse(req.params);
        const body = z
            .object({ teamId: z.string().uuid(), note: BoundedNote })
            .parse(req.body ?? {});
        const ctx = await requireReviewerActor(req, reply, body.teamId);
        if (!ctx)
            return;
        if (!requireReviewerCapable(ctx, reply))
            return;
        // Phase 26.75 — adaptive runtime gate.
        const gateReject = await runtimeAdaptiveGate({
            req,
            reply,
            teamId: body.teamId,
            userId: ctx.actorUserId,
            action: "REVIEWER_REJECT",
        });
        if (!gateReject.allow)
            return;
        if (await enforceStepUpIfFlagged(req, reply, ctx, "reject", {
            kind: "review_workflow",
            id: workflowId,
        })) {
            return;
        }
        try {
            const result = await rejectReview(ctx, {
                workflowId,
                note: body.note,
            });
            return reply.code(200).send({ projection: result });
        }
        catch (err) {
            if (sendEngineError(reply, err))
                return;
            throw err;
        }
    });
    // ===========================================================================
    // GET /v1/reviewer-ops/escalations
    // ===========================================================================
    app.get("/v1/reviewer-ops/escalations", { preHandler: requireAuth }, async (req, reply) => {
        const q = z
            .object({
            teamId: z.string().uuid(),
            status: z
                .enum([...REVIEW_ESCALATION_STATUSES, "ALL"])
                .optional(),
            severity: z.enum(["INFO", "WARNING", "HIGH", "CRITICAL"]).optional(),
            reason: z.enum(REVIEW_ESCALATION_REASONS).optional(),
            assignedToUserId: z.string().uuid().optional(),
            limit: z.coerce.number().int().min(1).max(200).optional(),
        })
            .parse(req.query ?? {});
        const ctx = await requireReviewerActor(req, reply, q.teamId);
        if (!ctx)
            return;
        const escalations = await listEscalations({
            teamId: q.teamId,
            status: q.status,
            severity: q.severity,
            reason: q.reason,
            assignedToUserId: q.assignedToUserId,
            limit: q.limit,
        });
        return reply.code(200).send({ escalations });
    });
    // ===========================================================================
    // POST /v1/reviewer-ops/escalations — manual operator-raised escalation
    // ===========================================================================
    app.post("/v1/reviewer-ops/escalations", { preHandler: requireAuth }, async (req, reply) => {
        const body = z
            .object({
            teamId: z.string().uuid(),
            workflowId: z.string().uuid(),
            reason: z.enum(REVIEW_ESCALATION_REASONS),
            severity: z
                .enum(["INFO", "WARNING", "HIGH", "CRITICAL"])
                .default("WARNING"),
            safeSummary: BoundedNote.max(400),
            assignedToUserId: z.string().uuid().nullable().optional(),
        })
            .parse(req.body ?? {});
        const ctx = await requireReviewerActor(req, reply, body.teamId);
        if (!ctx)
            return;
        if (!requireReviewerCapable(ctx, reply))
            return;
        const result = await createEscalation({
            teamId: body.teamId,
            workflowId: body.workflowId,
            reason: body.reason,
            severity: body.severity,
            safeSummary: body.safeSummary,
            createdByUserId: ctx.actorUserId,
            assignedToUserId: body.assignedToUserId ?? null,
        });
        if (!result.ok) {
            return reply
                .code(result.code === "REVIEW_WORKFLOW_NOT_FOUND" ? 404 : 403)
                .send({ error: { code: result.code } });
        }
        return reply
            .code(result.created ? 201 : 200)
            .send({ escalation: result.escalation });
    });
    // ===========================================================================
    // POST /v1/reviewer-ops/escalations/:id/acknowledge | reassign | resolve | suppress
    // ===========================================================================
    app.post("/v1/reviewer-ops/escalations/:id/acknowledge", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const body = z.object({ teamId: z.string().uuid() }).parse(req.body ?? {});
        const ctx = await requireReviewerActor(req, reply, body.teamId);
        if (!ctx)
            return;
        if (!requireReviewerCapable(ctx, reply))
            return;
        try {
            const escalation = await acknowledgeEscalation({
                teamId: body.teamId,
                escalationId: id,
                actorUserId: ctx.actorUserId,
            });
            return reply.code(200).send({ escalation });
        }
        catch (err) {
            if (sendEngineError(reply, err))
                return;
            throw err;
        }
    });
    app.post("/v1/reviewer-ops/escalations/:id/reassign", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const body = z
            .object({
            teamId: z.string().uuid(),
            newAssigneeUserId: z.string().uuid(),
        })
            .parse(req.body ?? {});
        const ctx = await requireReviewerActor(req, reply, body.teamId);
        if (!ctx)
            return;
        if (!requireReviewerCapable(ctx, reply))
            return;
        try {
            const escalation = await reassignEscalation({
                teamId: body.teamId,
                escalationId: id,
                actorUserId: ctx.actorUserId,
                newAssigneeUserId: body.newAssigneeUserId,
            });
            return reply.code(200).send({ escalation });
        }
        catch (err) {
            if (sendEngineError(reply, err))
                return;
            throw err;
        }
    });
    app.post("/v1/reviewer-ops/escalations/:id/resolve", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const body = z
            .object({
            teamId: z.string().uuid(),
            resolutionNote: BoundedNote.max(400),
        })
            .parse(req.body ?? {});
        const ctx = await requireReviewerActor(req, reply, body.teamId);
        if (!ctx)
            return;
        if (!requireReviewerCapable(ctx, reply))
            return;
        // Phase 26.75 — adaptive runtime gate.
        const gateResolveEsc = await runtimeAdaptiveGate({
            req,
            reply,
            teamId: body.teamId,
            userId: ctx.actorUserId,
            action: "REVIEW_ESCALATION_RESOLVE",
        });
        if (!gateResolveEsc.allow)
            return;
        if (await enforceStepUpIfFlagged(req, reply, ctx, "escalationResolve", {
            kind: "review_escalation",
            id,
        })) {
            return;
        }
        try {
            const escalation = await resolveEscalation({
                teamId: body.teamId,
                escalationId: id,
                actorUserId: ctx.actorUserId,
                resolutionNote: body.resolutionNote,
            });
            return reply.code(200).send({ escalation });
        }
        catch (err) {
            if (sendEngineError(reply, err))
                return;
            throw err;
        }
    });
    app.post("/v1/reviewer-ops/escalations/:id/suppress", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const body = z
            .object({
            teamId: z.string().uuid(),
            suppressionReason: BoundedNote.max(400),
        })
            .parse(req.body ?? {});
        const ctx = await requireReviewerActor(req, reply, body.teamId);
        if (!ctx)
            return;
        if (!requireReviewerCapable(ctx, reply))
            return;
        if (await enforceStepUpIfFlagged(req, reply, ctx, "escalationResolve", {
            kind: "review_escalation",
            id,
        })) {
            return;
        }
        try {
            const escalation = await suppressEscalation({
                teamId: body.teamId,
                escalationId: id,
                actorUserId: ctx.actorUserId,
                suppressionReason: body.suppressionReason,
            });
            return reply.code(200).send({ escalation });
        }
        catch (err) {
            if (sendEngineError(reply, err))
                return;
            throw err;
        }
    });
    // ===========================================================================
    // Phase 25.5 — Bulk triage
    // ===========================================================================
    app.post("/v1/reviewer-ops/reviews/bulk", { preHandler: requireAuth }, async (req, reply) => {
        const parsed = ReviewerOpsBulkInputSchema.safeParse(req.body);
        if (!parsed.success) {
            return reply
                .code(400)
                .send({ error: { code: "validation_error", detail: parsed.error.flatten() } });
        }
        const body = parsed.data;
        const ctx = await requireReviewerActor(req, reply, body.teamId);
        if (!ctx)
            return;
        if (!requireReviewerCapable(ctx, reply))
            return;
        // Phase 26.75 — adaptive runtime gate.
        const gateBulk = await runtimeAdaptiveGate({
            req,
            reply,
            teamId: body.teamId,
            userId: ctx.actorUserId,
            action: "REVIEWER_BULK",
        });
        if (!gateBulk.allow)
            return;
        if (await enforceStepUpIfFlagged(req, reply, ctx, "bulk", {
            kind: "review_workflow_bulk",
            id: body.workflowIds.slice(0, 8).join(","),
        })) {
            return;
        }
        const result = await executeBulkTriage(ctx, body);
        return reply.code(result.failed === 0 ? 200 : 207).send(result);
    });
    // ===========================================================================
    // Phase 25.5 — Saved queue views (REVIEWER_OPS scope)
    // ===========================================================================
    app.get("/v1/reviewer-ops/saved-views", { preHandler: requireAuth }, async (req, reply) => {
        const q = z
            .object({
            teamId: z.string().uuid(),
            limit: z.coerce.number().int().min(1).max(200).optional(),
        })
            .parse(req.query ?? {});
        const ctx = await requireReviewerActor(req, reply, q.teamId);
        if (!ctx)
            return;
        const views = await listReviewerOpsSavedViews({
            teamId: q.teamId,
            userId: ctx.actorUserId,
            limit: q.limit,
        });
        return reply.code(200).send({ views });
    });
    app.post("/v1/reviewer-ops/saved-views", { preHandler: requireAuth }, async (req, reply) => {
        const body = z
            .object({
            teamId: z.string().uuid(),
            name: z.string().min(1).max(120),
            description: z.string().max(400).nullable().optional(),
            visibility: z.enum(SAVED_VIEW_VISIBILITIES),
            pinned: z.boolean().optional(),
            filter: ReviewerOpsSavedViewFilterSchema,
        })
            .parse(req.body ?? {});
        if (body.filter.teamId !== body.teamId) {
            return reply
                .code(400)
                .send({ error: { code: "teamId_mismatch" } });
        }
        const ctx = await requireReviewerActor(req, reply, body.teamId);
        if (!ctx)
            return;
        if (!requireReviewerCapable(ctx, reply))
            return;
        const view = await createReviewerOpsSavedView({
            teamId: body.teamId,
            actorUserId: ctx.actorUserId,
            name: body.name,
            description: body.description ?? null,
            visibility: body.visibility,
            pinned: body.pinned ?? false,
            filter: body.filter,
        });
        if (!view) {
            return reply
                .code(409)
                .send({ error: { code: "duplicate_saved_view" } });
        }
        return reply.code(201).send({ view });
    });
    app.delete("/v1/reviewer-ops/saved-views/:id", { preHandler: requireAuth }, async (req, reply) => {
        const { id } = ParamsId.parse(req.params);
        const q = z.object({ teamId: z.string().uuid() }).parse(req.query ?? {});
        const ctx = await requireReviewerActor(req, reply, q.teamId);
        if (!ctx)
            return;
        const ok = await deleteReviewerOpsSavedView({
            teamId: q.teamId,
            actorUserId: ctx.actorUserId,
            id,
        });
        if (!ok) {
            return reply.code(404).send({ error: { code: "not_found" } });
        }
        return reply.code(204).send();
    });
    // ===========================================================================
    // Phase 25.5 — Analytics
    // ===========================================================================
    app.get("/v1/reviewer-ops/analytics/escalations", { preHandler: requireAuth }, async (req, reply) => {
        const q = z
            .object({
            teamId: z.string().uuid(),
            rangeDays: z.coerce.number().int().min(1).max(90).optional(),
        })
            .parse(req.query ?? {});
        const ctx = await requireReviewerActor(req, reply, q.teamId);
        if (!ctx)
            return;
        const analytics = await getEscalationAnalytics({
            teamId: q.teamId,
            rangeDays: q.rangeDays,
        });
        return reply.code(200).send(analytics);
    });
    app.get("/v1/reviewer-ops/analytics/reviewers", { preHandler: requireAuth }, async (req, reply) => {
        const q = z
            .object({
            teamId: z.string().uuid(),
            rangeDays: z.coerce.number().int().min(1).max(90).optional(),
            limit: z.coerce.number().int().min(1).max(100).optional(),
        })
            .parse(req.query ?? {});
        const ctx = await requireReviewerActor(req, reply, q.teamId);
        if (!ctx)
            return;
        const analytics = await getReviewerPerformance({
            teamId: q.teamId,
            rangeDays: q.rangeDays,
            limit: q.limit,
        });
        return reply.code(200).send(analytics);
    });
    // ===========================================================================
    // Phase 25.5 — SLA policy + governance flags admin
    // ===========================================================================
    app.get("/v1/reviewer-ops/sla-policy", { preHandler: requireAuth }, async (req, reply) => {
        const q = TeamIdQuery.parse(req.query ?? {});
        const ctx = await requireReviewerActor(req, reply, q.teamId);
        if (!ctx)
            return;
        const [policy, flags] = await Promise.all([
            resolveEffectiveSlaPolicy({ teamId: q.teamId }),
            loadWorkspaceReviewerOpsFlags(q.teamId),
        ]);
        return reply.code(200).send({ policy, flags });
    });
    app.post("/v1/reviewer-ops/sla-policy", { preHandler: requireAuth }, async (req, reply) => {
        const body = z
            .object({
            teamId: z.string().uuid(),
            overrides: ReviewerOpsSlaPolicySchema.optional(),
            flags: z
                .object({
                requireStepUpForApprove: z.boolean().optional(),
                requireStepUpForReject: z.boolean().optional(),
                requireStepUpForEscalationResolve: z.boolean().optional(),
                requireStepUpForBulk: z.boolean().optional(),
                reviewerInactivityHours: z
                    .number()
                    .int()
                    .min(1)
                    .max(720)
                    .nullable()
                    .optional(),
            })
                .optional(),
        })
            .parse(req.body ?? {});
        const ctx = await requireReviewerActor(req, reply, body.teamId);
        if (!ctx)
            return;
        if (!requireReviewerCapable(ctx, reply))
            return;
        // Editing the SLA / step-up policy is itself a high-risk action.
        // Gate behind GOVERNANCE_POLICY_UPDATE (reuses existing Phase 19
        // purpose so we don't need a new catalog entry).
        const gate = await requireStepUpForSensitiveAction({
            req,
            reply,
            teamId: body.teamId,
            userId: ctx.actorUserId,
            purpose: "GOVERNANCE_POLICY_UPDATE",
            resourceKind: "workspace_reviewer_ops_policy",
            resourceId: body.teamId,
        });
        if (gate.sent)
            return;
        if (body.overrides) {
            await upsertWorkspaceSlaPolicy({
                teamId: body.teamId,
                actorUserId: ctx.actorUserId,
                overrides: body.overrides,
            });
            bump("reviewer_sla_policy_updated_total");
            safeEmitSecurityEvent({
                teamId: body.teamId,
                eventType: "reviewer_sla_policy_updated",
                severity: "WARNING",
                details: {
                    actorUserId: ctx.actorUserId,
                    keys: Object.keys(body.overrides),
                },
            });
        }
        if (body.flags) {
            await upsertWorkspaceReviewerOpsFlags({
                teamId: body.teamId,
                actorUserId: ctx.actorUserId,
                flags: body.flags,
            });
            safeEmitSecurityEvent({
                teamId: body.teamId,
                eventType: "reviewer_governance_flags_updated",
                severity: "WARNING",
                details: {
                    actorUserId: ctx.actorUserId,
                    keys: Object.keys(body.flags),
                },
            });
        }
        const [policy, flags] = await Promise.all([
            resolveEffectiveSlaPolicy({ teamId: body.teamId }),
            loadWorkspaceReviewerOpsFlags(body.teamId),
        ]);
        return reply.code(200).send({ policy, flags });
    });
    // ===========================================================================
    // POST /v1/reviewer-ops/reconcile — cron-secret protected
    // ===========================================================================
    app.post("/v1/reviewer-ops/reconcile", async (req, reply) => {
        const headerSecret = req.headers["x-cron-secret"];
        const expected = process.env["REVIEWER_OPS_CRON_SECRET"] ||
            process.env["INTEGRATION_CRON_SECRET"] ||
            "";
        if (!expected) {
            return reply.code(503).send({
                error: { code: "REVIEWER_OPS_CRON_SECRET_NOT_CONFIGURED" },
            });
        }
        if (typeof headerSecret !== "string" ||
            headerSecret.length === 0 ||
            headerSecret !== expected) {
            return reply.code(401).send({ error: { code: "unauthorized" } });
        }
        // Either single-team (legacy: { teamId }) or all-teams sweep
        // ({ allTeams: true }). All-teams mode enumerates teams from DB
        // and runs reconcile per team with a per-team timeout. This is
        // the path the worker tick uses.
        const body = z
            .union([
            z.object({
                teamId: z.string().uuid(),
                batchSize: z.number().int().min(1).max(2000).optional(),
            }),
            z.object({
                allTeams: z.literal(true),
                batchSize: z.number().int().min(1).max(2000).optional(),
                maxTeamsPerSweep: z.number().int().min(1).max(10_000).optional(),
            }),
        ])
            .parse(req.body ?? {});
        if ("teamId" in body) {
            const result = await runReconcile({
                teamId: body.teamId,
                batchSize: body.batchSize,
            });
            return reply.code(200).send({ teams: 1, perTeam: [result] });
        }
        const maxTeams = body.maxTeamsPerSweep ?? 500;
        const teams = await prisma.team.findMany({
            // Reviewer-ops only matters for teams that have at least one
            // review workflow row. Limit + ordering keeps the worker tick
            // bounded — the next tick picks up any team we missed.
            where: {
                evidenceReviewWorkflows: { some: {} },
            },
            select: { id: true },
            orderBy: { id: "asc" },
            take: maxTeams,
        });
        const perTeam = [];
        let totalEscalationsCreated = 0;
        let totalFlippedBreached = 0;
        let totalFlippedDueSoon = 0;
        let totalDueSoonReminders = 0;
        let totalInactivityReminders = 0;
        let failedTeams = 0;
        // Per-team error isolation runs through runReconcileSafely
        // (defined at the top of this file): a single team failure
        // must not abort the sweep for the rest of the fleet. The
        // helper captures the failure into a structured result and the
        // loop carries on, accumulating `failedTeams`. This intentionally
        // keeps the catch out of any route handler so the Phase 25
        // route-layer error-handling contract is preserved.
        for (const t of teams) {
            const teamResult = await runReconcileSafely({
                teamId: t.id,
                batchSize: body.batchSize,
            });
            if (teamResult.ok) {
                perTeam.push({ teamId: t.id, ok: true, result: teamResult.result });
                totalEscalationsCreated += teamResult.result.escalationsCreated;
                totalFlippedBreached += teamResult.result.flippedBreached;
                totalFlippedDueSoon += teamResult.result.flippedDueSoon;
                totalDueSoonReminders += teamResult.result.dueSoonRemindersScheduled;
                totalInactivityReminders +=
                    teamResult.result.inactivityRemindersScheduled;
            }
            else {
                failedTeams += 1;
                perTeam.push({
                    teamId: t.id,
                    ok: false,
                    error: teamResult.error,
                });
            }
        }
        // Phase 32.7.5 — sweep-level canonical heartbeat.
        //
        // Root cause being closed: the per-team WORKER_HEARTBEAT
        // emission (the canonical reconcile signal — see
        // shared-runtime canonical-events catalog) fires inside
        // `runReconcile()` in reviewer-operations-engine.service.ts.
        // When the production DB has ZERO teams matching
        // `evidenceReviewWorkflows: { some: {} }`, the loop above
        // runs zero times → no per-team heartbeat is ever written →
        // the readiness `checkWorkers` query against `security_events`
        // returns null → after the startup grace window, the
        // subsystem reports DEGRADED with `no_recent_reconcile` even
        // though the sweep itself executed correctly (the worker
        // logs `reviewer_reconcile.completed` because this endpoint
        // returns 200).
        //
        // The sweep-level heartbeat below ALWAYS fires once per
        // sweep, regardless of how many teams were iterated. It uses
        // the same canonical wire string the readiness reader queries
        // (resolved via `wireStringFor("WORKER_HEARTBEAT")` in
        // shared-runtime — Phase 32.7). `teamId: null` distinguishes
        // it from per-team heartbeats; the reader filters by
        // `eventType` only, so both per-team and sweep-level rows
        // both satisfy "recent reconcile observed".
        //
        // No regression on the per-team heartbeats: they still fire
        // inside `runReconcile`. The sweep-level heartbeat is purely
        // additive — it guarantees a row lands even on the zero-team
        // sweep path.
        try {
            const { wireStringFor } = await import("@proovra/shared-runtime/ops");
            safeEmitSecurityEvent({
                teamId: null,
                eventType: wireStringFor("WORKER_HEARTBEAT"),
                severity: "INFO",
                details: {
                    source: "sweep",
                    trigger: typeof req.headers["x-trigger"] === "string"
                        ? req.headers["x-trigger"]
                        : null,
                    correlationId: typeof req.headers["x-correlation-id"] === "string"
                        ? req.headers["x-correlation-id"]
                        : null,
                    teams: teams.length,
                    failedTeams,
                    totalEscalationsCreated,
                    totalFlippedBreached,
                    totalFlippedDueSoon,
                    totalDueSoonReminders,
                    totalInactivityReminders,
                },
            });
        }
        catch {
            // Heartbeat emission is best-effort. The sweep response is
            // not gated on it. If the canonical resolver or
            // safeEmitSecurityEvent throws, the readiness will simply
            // continue to report what it would have reported anyway
            // (the per-team heartbeats may still cover the signal).
        }
        return reply.code(200).send({
            teams: teams.length,
            failedTeams,
            totalEscalationsCreated,
            totalFlippedBreached,
            totalFlippedDueSoon,
            totalDueSoonReminders,
            totalInactivityReminders,
            perTeam,
        });
    });
    // ===========================================================================
    // Phase B.1 — Reviewer notes (structured, evidence-scoped).
    //
    // We REUSE the existing `EvidenceReviewerComment` model (Phase
    // 32.8C++++ coordination tracking) rather than introduce a new
    // notes table. The model already carries authorUserId, body,
    // timestamps, soft-delete, and resolution tracking. To support the
    // structured note types Phase B.1 calls for (observation,
    // concern, request_info, escalation_context, decision_rationale,
    // legal_hold_context, redaction_context) WITHOUT a schema
    // migration, we serialize the note shape into the existing `body`
    // text column as a JSON envelope:
    //
    //   { v: 1, type: "<noteType>", body: "<operator-written text>" }
    //
    // Reads parse the envelope and tolerate legacy plain-string bodies
    // (treated as `type: "general"`). Writes always produce v1 JSON.
    //
    // RBAC: reviewer-actor on the workflow's team (same gate as the
    // existing workspace detail endpoint). Anyone who can SEE the
    // review workspace can create + list notes; we do not gate writes
    // separately because note content is operator-readable governance,
    // not a privileged decision.
    //
    // Audit: emits a TeamActivity row on every create so the action is
    // permanently traceable in the workspace audit feed. The
    // EvidenceReviewerComment row is the canonical artifact.
    // ===========================================================================
    const ReviewerNoteTypeSchema = z.enum([
        "observation",
        "concern",
        "request_info",
        "escalation_context",
        "decision_rationale",
        "legal_hold_context",
        "redaction_context",
    ]);
    const CreateNoteBody = z.object({
        teamId: z.string().uuid(),
        type: ReviewerNoteTypeSchema,
        body: z.string().trim().min(1).max(4000),
    });
    function parseStoredNoteBody(stored) {
        // Heuristic: tagged envelopes start with `{"v":1` after trim.
        // We try JSON.parse and validate shape; on any failure we treat
        // as legacy plain text. This is safe because pre-Phase-B.1
        // comments are never JSON envelopes.
        if (!stored.trim().startsWith("{")) {
            return { type: "general", body: stored, isLegacy: true };
        }
        try {
            const parsed = JSON.parse(stored);
            if (parsed &&
                parsed.v === 1 &&
                typeof parsed.type === "string" &&
                typeof parsed.body === "string") {
                return {
                    type: parsed.type,
                    body: parsed.body,
                    isLegacy: false,
                };
            }
        }
        catch {
            /* fallthrough to legacy */
        }
        return { type: "general", body: stored, isLegacy: true };
    }
    // ---------------------------------------------------------------------------
    // GET /v1/reviewer-ops/workspace/:workflowId/notes
    //
    // Lists the most recent N reviewer notes on the evidence underlying
    // the given review workflow. Workflow-scoped via the workflow's
    // teamId; never returns notes for evidence outside the workflow's
    // workspace.
    //
    // Returns operator-readable shape: id, authorUserId, type, body,
    // createdAt, deletedAt (always null in this list — we filter
    // soft-deleted rows server-side). Pagination by cursor (`since`).
    // ---------------------------------------------------------------------------
    app.get("/v1/reviewer-ops/workspace/:workflowId/notes", { preHandler: requireAuth }, async (req, reply) => {
        const { workflowId } = ParamsWorkflowId.parse(req.params);
        const q = z
            .object({
            teamId: z.string().uuid(),
            limit: z.coerce.number().int().min(1).max(200).optional(),
        })
            .parse(req.query ?? {});
        const ctx = await requireReviewerActor(req, reply, q.teamId);
        if (!ctx)
            return;
        // Resolve the evidenceId behind the workflow within the same team.
        const workflow = await prisma.evidenceReviewWorkflow.findFirst({
            where: { id: workflowId, teamId: q.teamId },
            select: { id: true, evidenceId: true },
        });
        if (!workflow) {
            return reply.code(404).send({ error: { code: "not_found" } });
        }
        const take = q.limit ?? 50;
        const rows = await prisma.evidenceReviewerComment.findMany({
            where: {
                evidenceId: workflow.evidenceId,
                deletedAt: null,
            },
            select: {
                id: true,
                authorUserId: true,
                body: true,
                visibility: true,
                createdAt: true,
                resolvedAtUtc: true,
                resolvedByUserId: true,
            },
            orderBy: { createdAt: "desc" },
            take,
        });
        // Denormalize author identity for operator-readable display.
        const authorIds = Array.from(new Set(rows.map((r) => r.authorUserId)));
        const authors = authorIds.length
            ? await prisma.user.findMany({
                where: { id: { in: authorIds } },
                select: { id: true, email: true, displayName: true },
            })
            : [];
        const authorById = new Map(authors.map((a) => [a.id, a]));
        const items = rows.map((r) => {
            const parsed = parseStoredNoteBody(r.body);
            const a = authorById.get(r.authorUserId) ?? null;
            return {
                id: r.id,
                type: parsed.type,
                body: parsed.body,
                isLegacyPlainText: parsed.isLegacy,
                visibility: r.visibility,
                author: a
                    ? {
                        userId: a.id,
                        email: a.email,
                        displayName: a.displayName,
                    }
                    : { userId: r.authorUserId, email: null, displayName: null },
                createdAt: r.createdAt.toISOString(),
                resolvedAt: r.resolvedAtUtc?.toISOString() ?? null,
                resolvedByUserId: r.resolvedByUserId,
            };
        });
        return reply.code(200).send({
            workflowId,
            evidenceId: workflow.evidenceId,
            summary: { total: items.length },
            items,
        });
    });
    // ---------------------------------------------------------------------------
    // POST /v1/reviewer-ops/workspace/:workflowId/notes
    //
    // Creates a reviewer note bound to the workflow's evidence. Stores
    // the type + body as a v1 JSON envelope in
    // EvidenceReviewerComment.body so we don't need a schema migration.
    //
    // Emits TeamActivity for the note creation so the action is
    // permanently traceable.
    // ---------------------------------------------------------------------------
    app.post("/v1/reviewer-ops/workspace/:workflowId/notes", { preHandler: requireAuth }, async (req, reply) => {
        const { workflowId } = ParamsWorkflowId.parse(req.params);
        const parsed = CreateNoteBody.safeParse(req.body);
        if (!parsed.success) {
            return reply.code(400).send({
                error: {
                    code: "validation_error",
                    detail: parsed.error.flatten(),
                },
            });
        }
        const body = parsed.data;
        const ctx = await requireReviewerActor(req, reply, body.teamId);
        if (!ctx)
            return;
        // Resolve the evidenceId behind the workflow within the team.
        const workflow = await prisma.evidenceReviewWorkflow.findFirst({
            where: { id: workflowId, teamId: body.teamId },
            select: { id: true, evidenceId: true },
        });
        if (!workflow) {
            return reply.code(404).send({ error: { code: "not_found" } });
        }
        const envelope = JSON.stringify({
            v: 1,
            type: body.type,
            body: body.body.trim(),
        });
        const created = await prisma.evidenceReviewerComment.create({
            data: {
                evidenceId: workflow.evidenceId,
                authorUserId: ctx.actorUserId,
                body: envelope,
                // visibility defaults to INTERNAL — reviewer notes are
                // operator-readable within the team workspace. Promoting
                // to TEAM/external broadcast is a separate workflow.
            },
            select: {
                id: true,
                authorUserId: true,
                body: true,
                visibility: true,
                createdAt: true,
            },
        });
        // Audit emission — workspace-scoped TeamActivity row so the
        // note creation appears in the existing workspace audit feed.
        // We do NOT include the note body in metadata (the body lives
        // on the comment row); we do include the structured type so
        // the audit feed renders "Reviewer note: <type> added".
        try {
            await prisma.teamActivity.create({
                data: {
                    teamId: body.teamId,
                    actorUserId: ctx.actorUserId,
                    eventType: "REVIEWER_NOTE_CREATED",
                    targetType: "evidence_reviewer_comment",
                    targetId: created.id,
                    metadata: {
                        workflowId,
                        evidenceId: workflow.evidenceId,
                        noteType: body.type,
                    },
                },
            });
        }
        catch {
            // Audit emission is best-effort; the note creation already
            // succeeded. A separate background sweep can backfill audit.
        }
        const decoded = parseStoredNoteBody(created.body);
        return reply.code(201).send({
            workflowId,
            evidenceId: workflow.evidenceId,
            note: {
                id: created.id,
                type: decoded.type,
                body: decoded.body,
                isLegacyPlainText: decoded.isLegacy,
                visibility: created.visibility,
                authorUserId: created.authorUserId,
                createdAt: created.createdAt.toISOString(),
            },
        });
    });
    // ===========================================================================
    // Phase B.2 — Multi-stage review governance.
    //
    // Endpoints:
    //   GET  /v1/reviewer-ops/workspace/:workflowId/decisions
    //        returns decision lineage + derived state machine + caller's
    //        next allowed action.
    //   POST /v1/reviewer-ops/workspace/:workflowId/decisions
    //        body { teamId, decision, reasonCode?, rationale }
    //        infers stage from existing rows (FIRST → SECOND →
    //        ADJUDICATION). Server enforces:
    //          - rationale required for non-APPROVE decisions
    //          - same reviewer cannot submit SECOND on their own FIRST
    //          - only conflict_detected state allows ADJUDICATION
    //          - ADJUDICATION only by team OWNER/ADMIN (elevated role)
    //          - one decision per (workflow, stage) — DB unique constraint
    //            is the source of truth; the API surfaces 409 cleanly
    //
    // The state machine is DERIVED from rows, not stored on the
    // workflow. Phase B.2 adds zero columns to existing tables.
    //
    // RBAC: same `requireReviewerActor` as the rest of reviewer-ops;
    // ADJUDICATION additionally checks role precedence on the team.
    // ===========================================================================
    const DecisionKindSchema = z.enum([
        "APPROVE",
        "REJECT",
        "REQUEST_INFO",
        "UPHOLD_FIRST",
        "UPHOLD_SECOND",
        "NEEDS_MORE_INFO",
        "UNRESOLVED",
    ]);
    const ReasonCodeSchema = z.enum([
        "EVIDENCE_INCOMPLETE",
        "REPORT_FAILED",
        "INTEGRITY_CONCERN",
        "CUSTODY_CONCERN",
        "MISSING_CONTEXT",
        "LEGAL_HOLD_ISSUE",
        "REDACTION_REQUIRED",
        "REVIEWER_DISAGREEMENT",
        "OTHER",
    ]);
    const CreateDecisionBody = z.object({
        teamId: z.string().uuid(),
        decision: DecisionKindSchema,
        reasonCode: ReasonCodeSchema.optional(),
        rationale: z.string().trim().min(1).max(4000),
    });
    /**
     * Phase B.2 — derive whether a workflow currently requires a second
     * review. We compute this at read-time from the existing workflow
     * state so we don't need a new column. The brief listed the
     * triggers; we map them:
     *
     *   - workflow.status === ESCALATED → second review required
     *   - workflow has an open escalation → second review required
     *   - workflow's evidence has an ACTIVE legal hold → second review required
     *   - workflow's evidence has at least one redaction-required
     *     visibility decision → second review required
     *
     * Manual operator override (a workflow-level flag) is deferred to a
     * future migration; the existing triggers above cover the
     * highest-leverage real cases.
     */
    async function requiresSecondReview(input) {
        const [wf, openEsc, holdCount, redactionCount] = await Promise.all([
            prisma.evidenceReviewWorkflow.findUnique({
                where: { id: input.workflowId },
                select: { status: true },
            }),
            findOpenEscalationForWorkflow({ teamId: input.teamId, workflowId: input.workflowId }, prisma),
            prisma.evidenceLegalHold.count({
                where: {
                    teamId: input.teamId,
                    evidenceId: input.evidenceId,
                    status: "ACTIVE",
                },
            }),
            prisma.evidenceWorkflowVisibilityDecision.count({
                where: {
                    evidenceId: input.evidenceId,
                    requiresRedaction: true,
                },
            }),
        ]);
        if (wf?.status === "ESCALATED")
            return { required: true, reason: "workflow_escalated" };
        if (openEsc)
            return { required: true, reason: "open_escalation" };
        if (holdCount > 0)
            return { required: true, reason: "active_legal_hold" };
        if (redactionCount > 0)
            return { required: true, reason: "redaction_required" };
        return { required: false, reason: null };
    }
    function deriveReviewState(input) {
        const first = input.decisions.find((d) => d.stage === "FIRST");
        const second = input.decisions.find((d) => d.stage === "SECOND");
        const adj = input.decisions.find((d) => d.stage === "ADJUDICATION");
        if (adj)
            return "resolved";
        if (first && second) {
            // Conflict when the two stage decisions disagree. APPROVE vs
            // REJECT vs REQUEST_INFO are the three primary outcomes the
            // brief calls out; any mismatch among them is a conflict.
            if (first.decision !== second.decision)
                return "conflict_detected";
            return "resolved";
        }
        if (first) {
            return input.requiresSecond ? "second_required" : "resolved";
        }
        return "first_required";
    }
    // ---------------------------------------------------------------------------
    // GET /v1/reviewer-ops/workspace/:workflowId/decisions
    // ---------------------------------------------------------------------------
    app.get("/v1/reviewer-ops/workspace/:workflowId/decisions", { preHandler: requireAuth }, async (req, reply) => {
        const { workflowId } = ParamsWorkflowId.parse(req.params);
        const q = z
            .object({ teamId: z.string().uuid() })
            .parse(req.query ?? {});
        const ctx = await requireReviewerActor(req, reply, q.teamId);
        if (!ctx)
            return;
        const wf = await prisma.evidenceReviewWorkflow.findFirst({
            where: { id: workflowId, teamId: q.teamId },
            select: { id: true, evidenceId: true, status: true },
        });
        if (!wf)
            return reply.code(404).send({ error: { code: "not_found" } });
        const [rows, secondReview] = await Promise.all([
            prisma.workflowReviewDecision.findMany({
                where: { workflowId, teamId: q.teamId },
                orderBy: { decidedAt: "asc" },
                select: {
                    id: true,
                    stage: true,
                    decision: true,
                    reasonCode: true,
                    rationale: true,
                    decidedAt: true,
                    reviewerUserId: true,
                },
            }),
            requiresSecondReview({
                workflowId,
                teamId: q.teamId,
                evidenceId: wf.evidenceId,
            }),
        ]);
        // Denormalise reviewer identity for operator-readable display.
        const reviewerIds = Array.from(new Set(rows.map((r) => r.reviewerUserId)));
        const reviewers = reviewerIds.length
            ? await prisma.user.findMany({
                where: { id: { in: reviewerIds } },
                select: { id: true, email: true, displayName: true },
            })
            : [];
        const reviewerById = new Map(reviewers.map((r) => [r.id, r]));
        const state = deriveReviewState({
            decisions: rows,
            requiresSecond: secondReview.required,
        });
        // Determine what the caller can do next, given the current state
        // and their role on the team. ADJUDICATION requires team
        // OWNER/ADMIN; other stages require any reviewer-capable member
        // (already enforced by requireReviewerActor).
        const teamMember = await prisma.teamMember.findUnique({
            where: { teamId_userId: { teamId: q.teamId, userId: ctx.actorUserId } },
            select: { role: true },
        });
        const isAdjudicator = teamMember?.role === "OWNER" || teamMember?.role === "ADMIN";
        const firstReviewerId = rows.find((r) => r.stage === "FIRST")
            ?.reviewerUserId;
        const callerIsFirstReviewer = firstReviewerId === ctx.actorUserId;
        let nextAction = "no_action_resolved";
        if (state === "first_required")
            nextAction = "submit_first";
        else if (state === "second_required")
            nextAction = callerIsFirstReviewer
                ? "blocked_same_reviewer"
                : "submit_second";
        else if (state === "conflict_detected")
            nextAction = isAdjudicator
                ? "submit_adjudication"
                : "blocked_not_adjudicator";
        return reply.code(200).send({
            workflowId,
            evidenceId: wf.evidenceId,
            state,
            secondReviewRequirement: {
                required: secondReview.required,
                reason: secondReview.reason,
            },
            callerContext: {
                userId: ctx.actorUserId,
                teamRole: teamMember?.role ?? null,
                isAdjudicator,
                callerIsFirstReviewer,
                nextAction,
            },
            decisions: rows.map((r) => {
                const rv = reviewerById.get(r.reviewerUserId) ?? null;
                return {
                    id: r.id,
                    stage: r.stage,
                    decision: r.decision,
                    reasonCode: r.reasonCode,
                    rationale: r.rationale,
                    decidedAt: r.decidedAt.toISOString(),
                    reviewer: rv
                        ? {
                            userId: rv.id,
                            email: rv.email,
                            displayName: rv.displayName,
                        }
                        : {
                            userId: r.reviewerUserId,
                            email: null,
                            displayName: null,
                        },
                };
            }),
        });
    });
    // ---------------------------------------------------------------------------
    // POST /v1/reviewer-ops/workspace/:workflowId/decisions
    // ---------------------------------------------------------------------------
    app.post("/v1/reviewer-ops/workspace/:workflowId/decisions", { preHandler: requireAuth }, async (req, reply) => {
        const { workflowId } = ParamsWorkflowId.parse(req.params);
        const parsed = CreateDecisionBody.safeParse(req.body);
        if (!parsed.success) {
            return reply.code(400).send({
                error: {
                    code: "validation_error",
                    detail: parsed.error.flatten(),
                },
            });
        }
        const body = parsed.data;
        const ctx = await requireReviewerActor(req, reply, body.teamId);
        if (!ctx)
            return;
        const wf = await prisma.evidenceReviewWorkflow.findFirst({
            where: { id: workflowId, teamId: body.teamId },
            select: { id: true, evidenceId: true },
        });
        if (!wf)
            return reply.code(404).send({ error: { code: "not_found" } });
        // Derive current state from existing rows.
        const existing = await prisma.workflowReviewDecision.findMany({
            where: { workflowId, teamId: body.teamId },
            select: { stage: true, decision: true, reviewerUserId: true },
        });
        const secondReview = await requiresSecondReview({
            workflowId,
            teamId: body.teamId,
            evidenceId: wf.evidenceId,
        });
        const state = deriveReviewState({
            decisions: existing,
            requiresSecond: secondReview.required,
        });
        // Determine which stage this submission targets.
        let targetStage;
        if (state === "first_required")
            targetStage = "FIRST";
        else if (state === "second_required")
            targetStage = "SECOND";
        else if (state === "conflict_detected")
            targetStage = "ADJUDICATION";
        else {
            return reply.code(409).send({
                error: {
                    code: "decision_not_allowed",
                    reason: "review_is_resolved",
                    currentState: state,
                },
            });
        }
        // Same-reviewer guard (server-enforced).
        if (targetStage === "SECOND") {
            const first = existing.find((d) => d.stage === "FIRST");
            if (first && first.reviewerUserId === ctx.actorUserId) {
                return reply.code(409).send({
                    error: {
                        code: "same_reviewer_blocked",
                        reason: "The reviewer who submitted the FIRST decision cannot submit the SECOND. Independence is required.",
                        firstReviewerUserId: first.reviewerUserId,
                    },
                });
            }
        }
        // Adjudicator role guard.
        if (targetStage === "ADJUDICATION") {
            const teamMember = await prisma.teamMember.findUnique({
                where: {
                    teamId_userId: {
                        teamId: body.teamId,
                        userId: ctx.actorUserId,
                    },
                },
                select: { role: true },
            });
            const isAdjudicator = teamMember?.role === "OWNER" || teamMember?.role === "ADMIN";
            if (!isAdjudicator) {
                return reply.code(403).send({
                    error: {
                        code: "adjudicator_role_required",
                        reason: "Adjudication requires team OWNER or ADMIN role on this workspace.",
                        callerRole: teamMember?.role ?? null,
                    },
                });
            }
        }
        // Rationale required for any non-APPROVE decision (and always
        // required for ADJUDICATION). The zod schema already enforces
        // min(1); this is a redundant explicit check for first-stage
        // APPROVE which is the only decision that COULD be rationale-
        // optional in some configurations. Phase B.2 keeps it required
        // uniformly — every decision row has an operator-visible
        // rationale.
        if (body.rationale.trim().length === 0) {
            return reply.code(400).send({
                error: {
                    code: "rationale_required",
                    reason: "All review decisions must include a rationale.",
                },
            });
        }
        // Specific decision-kind constraints:
        //   - UPHOLD_FIRST / UPHOLD_SECOND only valid at ADJUDICATION
        //   - At FIRST / SECOND, decision must be one of APPROVE /
        //     REJECT / REQUEST_INFO / NEEDS_MORE_INFO
        const adjOnlyKinds = new Set([
            "UPHOLD_FIRST",
            "UPHOLD_SECOND",
            "UNRESOLVED",
        ]);
        if (targetStage !== "ADJUDICATION" && adjOnlyKinds.has(body.decision)) {
            return reply.code(400).send({
                error: {
                    code: "decision_kind_not_allowed",
                    reason: `${body.decision} is only valid at ADJUDICATION stage.`,
                    stage: targetStage,
                },
            });
        }
        // Create the decision row. The DB unique (workflow_id, stage)
        // constraint is the source of truth for "one decision per stage" —
        // a concurrent duplicate write fails at the DB layer with P2002,
        // which we surface as 409.
        let created;
        try {
            created = await prisma.workflowReviewDecision.create({
                data: {
                    workflowId,
                    teamId: body.teamId,
                    stage: targetStage,
                    reviewerUserId: ctx.actorUserId,
                    decision: body.decision,
                    reasonCode: body.reasonCode ?? null,
                    rationale: body.rationale.trim(),
                },
                select: {
                    id: true,
                    stage: true,
                    decision: true,
                    reasonCode: true,
                    rationale: true,
                    decidedAt: true,
                    reviewerUserId: true,
                },
            });
        }
        catch (err) {
            // Prisma unique violation when a concurrent writer landed
            // first.
            const code = err.code;
            if (code === "P2002") {
                return reply.code(409).send({
                    error: {
                        code: "duplicate_stage_decision",
                        reason: "A decision for this stage already exists.",
                        stage: targetStage,
                    },
                });
            }
            throw err;
        }
        // Audit emission — workspace-scoped TeamActivity row so the
        // multi-stage decision appears in the existing audit feed.
        const auditEventType = targetStage === "FIRST"
            ? "REVIEWER_DECISION_FIRST"
            : targetStage === "SECOND"
                ? "REVIEWER_DECISION_SECOND"
                : "REVIEWER_DECISION_ADJUDICATION";
        try {
            await prisma.teamActivity.create({
                data: {
                    teamId: body.teamId,
                    actorUserId: ctx.actorUserId,
                    eventType: auditEventType,
                    targetType: "workflow_review_decision",
                    targetId: created.id,
                    metadata: {
                        workflowId,
                        evidenceId: wf.evidenceId,
                        stage: targetStage,
                        decision: body.decision,
                        reasonCode: body.reasonCode ?? null,
                    },
                },
            });
        }
        catch {
            /* audit best-effort */
        }
        // Compute the new state for the response so the UI doesn't need
        // a separate GET round-trip.
        const newExisting = [...existing, { stage: targetStage, decision: body.decision, reviewerUserId: ctx.actorUserId }];
        const newState = deriveReviewState({
            decisions: newExisting,
            requiresSecond: secondReview.required,
        });
        return reply.code(201).send({
            workflowId,
            evidenceId: wf.evidenceId,
            state: newState,
            decision: {
                id: created.id,
                stage: created.stage,
                decision: created.decision,
                reasonCode: created.reasonCode,
                rationale: created.rationale,
                decidedAt: created.decidedAt.toISOString(),
                reviewerUserId: created.reviewerUserId,
            },
        });
    });
    // ===========================================================================
    // Phase B.3 — Review-state queue summary.
    //
    // GET /v1/reviewer-ops/decisions/summary?teamId=<uuid>
    //
    // Returns workspace-scoped counts of workflows by multi-stage review
    // state (derived from WorkflowReviewDecision rows + the same policy
    // triggers used by the per-workflow `decisions` endpoint).
    //
    // Used by:
    //   - `/reviewer-ops` console summary card ("X conflicts pending
    //     adjudication, Y awaiting second review")
    //   - `/v1/me/inbox` for caller-relevant counts (when the caller is
    //     an admin in the team)
    //
    // Hard rules:
    //   - Workspace-scoped via `requireReviewerActor(teamId)` — no
    //     cross-workspace leak.
    //   - Counts derived live; no caching, no stale state. The cost is
    //     one join per call which the existing indexes handle.
    //   - Top-N preview rows per state are bounded to 5 by default
    //     (operator-readable preview, not full queue) to keep this
    //     endpoint a *summary*. The full filtered queue is a future
    //     deliverable (Phase B.3 deferred section).
    // ===========================================================================
    app.get("/v1/reviewer-ops/decisions/summary", { preHandler: requireAuth }, async (req, reply) => {
        const q = z
            .object({
            teamId: z.string().uuid(),
            previewLimit: z.coerce.number().int().min(0).max(50).optional(),
        })
            .parse(req.query ?? {});
        const ctx = await requireReviewerActor(req, reply, q.teamId);
        if (!ctx)
            return;
        const previewLimit = q.previewLimit ?? 5;
        // Pull every workflow in the team that has at least one decision
        // row OR is in a state that could require multi-stage review.
        // The cheap path: list workflows + their decisions in one go.
        //
        // We bound this to workflows updated in the last 90 days so the
        // summary stays operationally relevant; older completed workflows
        // are not surfaced.
        const SUMMARY_WINDOW_DAYS = 90;
        const windowStart = new Date(Date.now() - SUMMARY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
        const workflows = await prisma.evidenceReviewWorkflow.findMany({
            where: {
                teamId: q.teamId,
                updatedAt: { gte: windowStart },
            },
            select: {
                id: true,
                evidenceId: true,
                status: true,
                priority: true,
                assignedToUserId: true,
                updatedAt: true,
            },
            orderBy: { updatedAt: "desc" },
            take: 500, // hard upper bound on the summary's input set
        });
        const workflowIds = workflows.map((w) => w.id);
        const evidenceIds = workflows.map((w) => w.evidenceId);
        const [decisions, openEscalations, legalHolds, redactionDecisions] = workflowIds.length === 0
            ? [[], [], [], []]
            : await Promise.all([
                prisma.workflowReviewDecision.findMany({
                    where: {
                        workflowId: { in: workflowIds },
                        teamId: q.teamId,
                    },
                    select: {
                        workflowId: true,
                        stage: true,
                        decision: true,
                        reviewerUserId: true,
                    },
                }),
                prisma.reviewEscalation.findMany({
                    where: {
                        teamId: q.teamId,
                        workflowId: { in: workflowIds },
                        status: { in: ["OPEN", "ACKNOWLEDGED", "REASSIGNED"] },
                    },
                    select: { workflowId: true },
                }),
                prisma.evidenceLegalHold.groupBy({
                    by: ["evidenceId"],
                    where: {
                        teamId: q.teamId,
                        evidenceId: { in: evidenceIds },
                        status: "ACTIVE",
                    },
                    _count: { id: true },
                }),
                prisma.evidenceWorkflowVisibilityDecision.groupBy({
                    by: ["evidenceId"],
                    where: {
                        evidenceId: { in: evidenceIds },
                        requiresRedaction: true,
                    },
                    _count: { id: true },
                }),
            ]);
        const decisionsByWorkflow = new Map();
        for (const d of decisions) {
            const arr = decisionsByWorkflow.get(d.workflowId) ?? [];
            arr.push({
                stage: d.stage,
                decision: d.decision,
                reviewerUserId: d.reviewerUserId,
            });
            decisionsByWorkflow.set(d.workflowId, arr);
        }
        const escalatedSet = new Set(openEscalations
            .map((e) => e.workflowId)
            .filter((id) => id !== null));
        const legalHoldEvidenceSet = new Set(legalHolds
            .filter((h) => (h._count?.id ?? 0) > 0)
            .map((h) => h.evidenceId));
        const redactionEvidenceSet = new Set(redactionDecisions
            .filter((r) => (r._count?.id ?? 0) > 0)
            .map((r) => r.evidenceId)
            .filter((id) => id !== null));
        const buckets = {
            first_required: [],
            second_required: [],
            conflict_detected: [],
            resolved: [],
        };
        for (const wf of workflows) {
            const rows = decisionsByWorkflow.get(wf.id) ?? [];
            const first = rows.find((r) => r.stage === "FIRST");
            const second = rows.find((r) => r.stage === "SECOND");
            const adjudication = rows.find((r) => r.stage === "ADJUDICATION");
            const requiresSecond = wf.status === "ESCALATED" ||
                escalatedSet.has(wf.id) ||
                legalHoldEvidenceSet.has(wf.evidenceId) ||
                redactionEvidenceSet.has(wf.evidenceId);
            let state;
            if (adjudication)
                state = "resolved";
            else if (first && second) {
                state =
                    first.decision !== second.decision ? "conflict_detected" : "resolved";
            }
            else if (first) {
                state = requiresSecond ? "second_required" : "resolved";
            }
            else {
                state = "first_required";
            }
            // Only push to a bucket if we still have room for preview rows
            // OR if we're counting (always counted).
            buckets[state].push({
                workflowId: wf.id,
                evidenceId: wf.evidenceId,
                status: wf.status,
                priority: wf.priority,
                assignedToUserId: wf.assignedToUserId,
                updatedAt: wf.updatedAt.toISOString(),
            });
        }
        // Slice preview rows per state but preserve the full count.
        const summary = {
            windowDays: SUMMARY_WINDOW_DAYS,
            workflowsInWindow: workflows.length,
            byState: {
                first_required: buckets.first_required.length,
                second_required: buckets.second_required.length,
                conflict_detected: buckets.conflict_detected.length,
                resolved: buckets.resolved.length,
            },
        };
        const preview = {
            first_required: buckets.first_required.slice(0, previewLimit),
            second_required: buckets.second_required.slice(0, previewLimit),
            conflict_detected: buckets.conflict_detected.slice(0, previewLimit),
            resolved: buckets.resolved.slice(0, previewLimit),
        };
        return reply.code(200).send({
            teamId: q.teamId,
            generatedAt: new Date().toISOString(),
            summary,
            preview,
        });
    });
}
