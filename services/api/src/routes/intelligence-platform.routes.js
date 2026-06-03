/**
 * PROOVRA Phase 3B — Enterprise Intelligence Platform routes.
 *
 * Bounded HTTP surface for media intelligence records,
 * corrections, provider usage + budgets, executive metrics,
 * and the audit & transparency centre.
 *
 * Every route:
 *   * Requires `requireAuth`.
 *   * Resolves the operator's workspace.
 *   * Bounded denial codes.
 *   * NEVER exposes raw payloads in the projection routes —
 *     payloads are clipped at the projection layer.
 *
 * The adapter REGISTRATION imports below are intentional —
 * importing them ensures `registerAdapter` runs at module load
 * so the adapter registry has entries when the routes resolve.
 */
import { z } from "zod";
import { AUDIT_TRANSPARENCY_CATEGORIES, EXECUTIVE_METRICS_RANGES, INTELLIGENCE_CONFIDENCE_BANDS, MEDIA_INTELLIGENCE_MODALITIES, MEDIA_INTELLIGENCE_PROVIDERS, MEDIA_INTELLIGENCE_RECORD_KINDS, PROVIDER_ADAPTER_OPERATIONS, PROVIDER_BUDGET_PERIODS, PROVIDER_BUDGET_SCOPES, REVIEWER_CORRECTION_KINDS, } from "@proovra/shared";
import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { extractPrismaDiagnostic, isPrismaTableOrColumnMissing, } from "./_governance-error-bound.js";
import { listAdapterProbes } from "../services/intelligence/providers/provider-adapter.js";
// Side-effect imports — each registers its adapter on the bounded registry.
import "../services/intelligence/providers/azure-document-intelligence-adapter.js";
import "../services/intelligence/providers/deepgram-adapter.js";
import "../services/intelligence/providers/rekognition-adapter.js";
import "../services/intelligence/providers/openai-adapter.js";
import { getRecordWithCorrections, listRecordsForEvidence, runProviderOperation, } from "../services/intelligence/media-intelligence.service.js";
import { acceptCorrection, createCorrection, getCorrectionVersionChain, listCorrectionsForEvidence, listCorrectionsForRecord, revertCorrection, } from "../services/intelligence/reviewer-correction.service.js";
import { createBudget, listBudgetBreaches, listBudgetSpend, listBudgets, } from "../services/intelligence/provider-budget.service.js";
import { listRecentUsage, summariseProviderUsage, } from "../services/intelligence/provider-usage.service.js";
import { projectExecutiveMetrics, projectExecutiveTrends, } from "../services/intelligence/executive-metrics.service.js";
import { listAuditTransparency } from "../services/intelligence/audit-transparency.service.js";
import { projectProviderQuality, projectReviewerQuality, projectTeamQuality, } from "../services/intelligence/intelligence-quality.service.js";
// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const RunProviderByteSchema = z.object({
    provider: z.enum(MEDIA_INTELLIGENCE_PROVIDERS),
    operation: z.enum(PROVIDER_ADAPTER_OPERATIONS),
    bytesBase64: z.string().min(1).optional(),
    url: z.string().url().optional(),
    contentType: z.string().max(120).optional(),
    caseId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
});
const RunProviderTextSchema = z.object({
    provider: z.enum(MEDIA_INTELLIGENCE_PROVIDERS),
    operation: z.enum(PROVIDER_ADAPTER_OPERATIONS),
    text: z.string().min(1).max(200_000),
    caseId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
});
const CorrectionCreateBody = z.object({
    recordId: z.string().uuid(),
    kind: z.enum(REVIEWER_CORRECTION_KINDS),
    patch: z.record(z.string(), z.unknown()),
    rationale: z.string().max(600).optional(),
    reviewConfidenceBand: z.enum(INTELLIGENCE_CONFIDENCE_BANDS).optional(),
});
const BudgetCreateBody = z.object({
    scope: z.enum(PROVIDER_BUDGET_SCOPES),
    scopeTargetId: z.string().uuid().nullable().optional(),
    provider: z.enum(MEDIA_INTELLIGENCE_PROVIDERS).nullable().optional(),
    period: z.enum(PROVIDER_BUDGET_PERIODS),
    softLimitUsdMicros: z.number().int().positive(),
    hardLimitUsdMicros: z.number().int().positive(),
});
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function resolveWorkspace(req, reply) {
    const userId = getAuthUserId(req);
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { currentWorkspaceId: true },
    });
    if (!user?.currentWorkspaceId) {
        reply.code(403).send({ denial: "WORKSPACE_NOT_FOUND" });
        return null;
    }
    return { teamId: user.currentWorkspaceId, userId };
}
function decodeBase64(payload) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const B = globalThis.Buffer;
    if (B)
        return B.from(payload, "base64");
    return new Uint8Array(0);
}
// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------
export async function intelligencePlatformRoutes(app) {
    // ---- Records ----
    app.get("/v1/intelligence/evidence/:evidenceId/records", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const { evidenceId } = z
            .object({ evidenceId: z.string().uuid() })
            .parse(req.params);
        const q = z
            .object({
            modality: z.enum(MEDIA_INTELLIGENCE_MODALITIES).optional(),
            kind: z.enum(MEDIA_INTELLIGENCE_RECORD_KINDS).optional(),
        })
            .parse(req.query ?? {});
        const records = await listRecordsForEvidence({
            teamId: ctx.teamId,
            evidenceId,
            modality: q.modality,
            kind: q.kind,
        });
        return reply.code(200).send({ records });
    });
    app.get("/v1/intelligence/records/:id", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
        const row = await getRecordWithCorrections({
            teamId: ctx.teamId,
            recordId: id,
        });
        if (!row)
            return reply.code(404).send({ denial: "RECORD_NOT_FOUND" });
        return reply.code(200).send({ record: row });
    });
    // ---- Provider operations ----
    app.post("/v1/intelligence/evidence/:evidenceId/run/bytes", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const { evidenceId } = z
            .object({ evidenceId: z.string().uuid() })
            .parse(req.params);
        const body = RunProviderByteSchema.parse(req.body);
        const bytes = body.bytesBase64 ? decodeBase64(body.bytesBase64) : null;
        const res = await runProviderOperation({
            teamId: ctx.teamId,
            evidenceId,
            provider: body.provider,
            operation: body.operation,
            initiatedByUserId: ctx.userId,
            caseId: body.caseId ?? null,
            projectId: body.projectId ?? null,
            byteSource: { bytes, url: body.url, contentType: body.contentType },
        });
        if (!res.ok) {
            return reply
                .code(res.decision === "BLOCK" ? 402 : 409)
                .send({ decision: res.decision, reason: res.reason });
        }
        return reply.code(200).send({
            decision: res.decision,
            insertedRecords: res.insertedRecords,
            insertedEntities: res.insertedEntities,
        });
    });
    app.post("/v1/intelligence/evidence/:evidenceId/run/text", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const { evidenceId } = z
            .object({ evidenceId: z.string().uuid() })
            .parse(req.params);
        const body = RunProviderTextSchema.parse(req.body);
        const res = await runProviderOperation({
            teamId: ctx.teamId,
            evidenceId,
            provider: body.provider,
            operation: body.operation,
            initiatedByUserId: ctx.userId,
            caseId: body.caseId ?? null,
            projectId: body.projectId ?? null,
            text: body.text,
        });
        if (!res.ok) {
            return reply
                .code(res.decision === "BLOCK" ? 402 : 409)
                .send({ decision: res.decision, reason: res.reason });
        }
        return reply.code(200).send({
            decision: res.decision,
            insertedRecords: res.insertedRecords,
            insertedEntities: res.insertedEntities,
            extractedText: res.extractedText,
        });
    });
    // ---- Corrections ----
    app.post("/v1/intelligence/corrections", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const body = CorrectionCreateBody.parse(req.body);
        const res = await createCorrection({
            teamId: ctx.teamId,
            recordId: body.recordId,
            kind: body.kind,
            patch: body.patch,
            rationale: body.rationale ?? null,
            reviewConfidenceBand: body.reviewConfidenceBand ?? null,
            authoredByUserId: ctx.userId,
        });
        if (!res.ok)
            return reply.code(409).send({ denial: res.denial });
        return reply.code(201).send({ correctionId: res.correctionId });
    });
    app.post("/v1/intelligence/corrections/:id/accept", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
        const res = await acceptCorrection({
            teamId: ctx.teamId,
            correctionId: id,
            acceptedByUserId: ctx.userId,
        });
        if (!res.ok)
            return reply.code(409).send({ denial: res.denial });
        return reply.code(200).send({ recordId: res.recordId });
    });
    app.post("/v1/intelligence/corrections/:id/revert", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
        const res = await revertCorrection({
            teamId: ctx.teamId,
            correctionId: id,
            actorUserId: ctx.userId,
        });
        if (!res.ok)
            return reply.code(409).send({ denial: res.denial });
        return reply.code(200).send({
            revertedCorrectionId: res.revertedCorrectionId,
        });
    });
    app.get("/v1/intelligence/records/:id/corrections", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
        const rows = await listCorrectionsForRecord({
            teamId: ctx.teamId,
            recordId: id,
        });
        return reply.code(200).send({ corrections: rows });
    });
    app.get("/v1/intelligence/evidence/:evidenceId/corrections", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const { evidenceId } = z
            .object({ evidenceId: z.string().uuid() })
            .parse(req.params);
        const rows = await listCorrectionsForEvidence({
            teamId: ctx.teamId,
            evidenceId,
        });
        return reply.code(200).send({ corrections: rows });
    });
    // ---- Cost controls ----
    app.get("/v1/intelligence/providers/usage", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const summary = await summariseProviderUsage({ teamId: ctx.teamId });
        const recent = await listRecentUsage({ teamId: ctx.teamId, limit: 50 });
        return reply.code(200).send({
            summary,
            recent: recent.map((r) => ({
                id: r.id,
                provider: r.provider,
                operation: r.operation,
                unit: r.unit,
                units: r.units,
                estimatedCostUsdMicros: Number(r.estimatedCostUsdMicros),
                decision: r.decision,
                evidenceId: r.evidenceId,
                caseId: r.caseId,
                projectId: r.projectId,
                initiatedByUserId: r.initiatedByUserId,
                failureReason: r.failureReason,
                occurredAtUtc: r.occurredAtUtc.toISOString(),
            })),
        });
    });
    app.get("/v1/intelligence/providers/budgets", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        // Phase O Stream B — schema-drift safety net for NODE-1H
        // (provider_budgets.archived_at missing on production until the
        // repair migration is applied). On Prisma P2021/P2022 return a
        // bounded empty payload with `degraded: true`; other errors
        // propagate to the central handler so real bugs are NOT
        // swallowed.
        try {
            const budgets = await listBudgets({ teamId: ctx.teamId });
            return reply.code(200).send({ budgets });
        }
        catch (err) {
            if (isPrismaTableOrColumnMissing(err)) {
                const diag = extractPrismaDiagnostic(err);
                reply.log.warn({
                    event: "intelligence.provider_budgets.schema_not_ready",
                    requestId: reply.request?.id ?? null,
                    teamId: ctx.teamId,
                    prismaName: diag.name,
                    prismaCode: diag.code,
                    missingColumn: diag.missingColumn,
                    missingTable: diag.missingTable,
                    modelName: diag.modelName,
                    message: diag.message,
                }, "GET /v1/intelligence/providers/budgets degraded: schema not ready");
                return reply.code(200).send({
                    budgets: [],
                    degraded: true,
                    reason: "SCHEMA_NOT_READY",
                });
            }
            throw err;
        }
    });
    app.post("/v1/intelligence/providers/budgets", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const body = BudgetCreateBody.parse(req.body);
        const res = await createBudget({
            teamId: ctx.teamId,
            scope: body.scope,
            scopeTargetId: body.scopeTargetId ?? null,
            provider: body.provider ?? null,
            period: body.period,
            softLimitUsdMicros: body.softLimitUsdMicros,
            hardLimitUsdMicros: body.hardLimitUsdMicros,
            createdByUserId: ctx.userId,
        });
        if (!res.ok)
            return reply.code(409).send({ denial: res.denial });
        return reply.code(201).send({ budgetId: res.budgetId });
    });
    // ---- Provider health ----
    app.get("/v1/intelligence/providers/health", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        void ctx;
        const probes = listAdapterProbes();
        return reply.code(200).send({ providers: probes });
    });
    // ---- Executive metrics (snapshot — kept for backward compat) ----
    app.get("/v1/executive/metrics", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const metrics = await projectExecutiveMetrics({ teamId: ctx.teamId });
        return reply.code(200).send({ metrics });
    });
    // ---- Executive trends (Phase 3B Closure — selectable range) ----
    app.get("/v1/executive/trends", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const q = z
            .object({ range: z.enum(EXECUTIVE_METRICS_RANGES).optional() })
            .parse(req.query ?? {});
        const trends = await projectExecutiveTrends({
            teamId: ctx.teamId,
            range: q.range ?? "7d",
        });
        return reply.code(200).send({ trends });
    });
    // ---- Intelligence quality — provider / reviewer / team ----
    app.get("/v1/intelligence/quality/providers", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const q = z
            .object({ range: z.enum(EXECUTIVE_METRICS_RANGES).optional() })
            .parse(req.query ?? {});
        const projection = await projectProviderQuality({
            teamId: ctx.teamId,
            range: q.range ?? "7d",
        });
        return reply.code(200).send({ projection });
    });
    app.get("/v1/intelligence/quality/reviewers", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const q = z
            .object({ range: z.enum(EXECUTIVE_METRICS_RANGES).optional() })
            .parse(req.query ?? {});
        const projection = await projectReviewerQuality({
            teamId: ctx.teamId,
            range: q.range ?? "7d",
        });
        return reply.code(200).send({ projection });
    });
    app.get("/v1/intelligence/quality/teams", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const q = z
            .object({ range: z.enum(EXECUTIVE_METRICS_RANGES).optional() })
            .parse(req.query ?? {});
        const projection = await projectTeamQuality({
            teamId: ctx.teamId,
            range: q.range ?? "7d",
        });
        return reply.code(200).send({ projection });
    });
    // ---- Correction version chain ----
    app.get("/v1/intelligence/records/:id/version-chain", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
        const chain = await getCorrectionVersionChain({
            teamId: ctx.teamId,
            recordId: id,
        });
        if (!chain)
            return reply.code(404).send({ denial: "RECORD_NOT_FOUND" });
        return reply.code(200).send({ chain });
    });
    // ---- Budget breach + spend dashboards ----
    app.get("/v1/intelligence/budgets/breaches", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const q = z
            .object({ range: z.enum(EXECUTIVE_METRICS_RANGES).optional() })
            .parse(req.query ?? {});
        const projection = await listBudgetBreaches({
            teamId: ctx.teamId,
            range: q.range ?? "30d",
        });
        return reply.code(200).send({ projection });
    });
    app.get("/v1/intelligence/budgets/spend", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const projection = await listBudgetSpend({ teamId: ctx.teamId });
        return reply.code(200).send({ projection });
    });
    // ---- Audit & Transparency Centre ----
    app.get("/v1/audit-transparency", { preHandler: requireAuth }, async (req, reply) => {
        const ctx = await resolveWorkspace(req, reply);
        if (!ctx)
            return reply;
        const q = z
            .object({
            category: z.enum(AUDIT_TRANSPARENCY_CATEGORIES).optional(),
            limit: z.coerce.number().int().min(1).max(500).optional(),
        })
            .parse(req.query ?? {});
        const entries = await listAuditTransparency({
            teamId: ctx.teamId,
            category: q.category,
            limit: q.limit,
        });
        return reply.code(200).send({ entries });
    });
}
