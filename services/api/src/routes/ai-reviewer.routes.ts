/**
 * Phase D3/D4/D6 — Live Reviewer Copilot route.
 *   POST /v1/ai/reviewer/:reviewId/copilot
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { appendPlatformAuditLog } from "../services/platform-audit-log.service.js";
import { buildBaseContext, buildEvidenceContext } from "../services/ai/ai-context-resolver.service.js";
import type { ReviewerContext } from "../services/ai/ai-context-resolver.service.js";
import { evaluateWorkspaceAiPolicy } from "../services/ai/workspace-ai-policy.service.js";
import { enforceAiEndpointGuard } from "../services/ai/ai-rate-limit.service.js";
import { runReviewerCopilot } from "../services/ai/reviewer-copilot.service.js";
import { buildReviewerCopilotProvider, ReviewerCopilotProviderUnavailable } from "../services/ai/reviewer-copilot-provider.js";
import { buildCitationResolver, buildWorkspaceCitationLookups, type CitationPrisma } from "../services/ai/ai-citation-db-resolver.service.js";
import { persistCopilotRun, recordObservationInteraction } from "../services/ai/ai-copilot-run-store.service.js";
import { buildPrismaLedgerStore, reconcileAiUsage, releaseAiReservation, tryReserveAiBudget } from "../services/ai/ai-usage-ledger.service.js";

const Body = z.object({
  selectedEvidenceIds: z.array(z.string().uuid()).max(50).optional(),
  criteriaVersion: z.string().max(40).default("v1"),
  idempotencyKey: z.string().max(80).optional(),
});

export async function aiReviewerRoutes(app: FastifyInstance) {
  app.post("/v1/ai/reviewer/:reviewId/copilot", { preHandler: requireAuth }, async (req, reply) => {
    const userId = getAuthUserId(req);
    const reviewId = z.string().uuid().parse((req.params as { reviewId: string }).reviewId);
    const body = Body.parse(req.body ?? {});

    const wf = await prisma.evidenceReviewWorkflow.findUnique({
      where: { id: reviewId },
      select: { id: true, teamId: true, evidenceId: true, status: true },
    });
    if (!wf?.teamId) return reply.code(404).send({ error: { code: "review_not_found" } });
    const membership = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: wf.teamId, userId } },
    });
    if (!membership) return reply.code(403).send({ error: { code: "not_a_member" } });
    const teamId = wf.teamId;

    // Selected evidence defaults to the review's own record; all tenant-scoped.
    const ids = [...new Set(body.selectedEvidenceIds && body.selectedEvidenceIds.length > 0 ? body.selectedEvidenceIds : [wf.evidenceId])];
    const rows = await prisma.evidence.findMany({
      where: { id: { in: ids }, teamId, deletedAt: null },
      select: {
        id: true, teamId: true, title: true, type: true, mimeType: true, status: true,
        verificationStatus: true, caseId: true, verificationPackageVersion: true, latestReportVersion: true,
      },
    });
    if (rows.length !== ids.length) return reply.code(403).send({ error: { code: "unauthorized_or_missing_evidence" } });

    const policyDecision = await evaluateWorkspaceAiPolicy({ teamId, feature: "REVIEWER_COPILOT", dataClass: "METADATA", userRole: membership.role });
    const guard = await enforceAiEndpointGuard({ feature: "reviewer-copilot", userId, ip: req.ip, dedupeKey: body.idempotencyKey ?? `${reviewId}:${ids.sort().join(",")}`, dedupeWindowSec: 20 });
    if (!guard.allowed) { reply.header("Retry-After", String(guard.retryAfterSec)); return reply.code(429).send({ code: guard.code, message: "Too many AI requests; please slow down." }); }

    const base = await buildBaseContext({ route: `/review/${reviewId}`, routeClass: "REVIEWER", role: membership.role, teamId });
    const reviewerContext: ReviewerContext = {
      ...base, routeClass: "REVIEWER", objectType: "REVIEW_WORKFLOW", objectId: wf.id, objectVersion: null,
      allowedActions: [], fields: { status: wf.status, evidenceId: wf.evidenceId },
    };
    const selectedEvidence = rows.map((r) => buildEvidenceContext({ ...base, routeClass: "EVIDENCE" }, {
      id: r.id, teamId: r.teamId, title: r.title, type: r.type, mimeType: r.mimeType, status: r.status,
      verificationStatus: r.verificationStatus, caseLinked: Boolean(r.caseId),
      verificationPackageVersion: r.verificationPackageVersion, latestReportVersion: r.latestReportVersion,
    }));
    const resolveCitation = buildCitationResolver(buildWorkspaceCitationLookups(prisma as unknown as CitationPrisma, teamId));

    const audit = (outcome: string, metadata: Record<string, unknown>) =>
      appendPlatformAuditLog({ userId, action: "ai.reviewer_copilot", category: "ai", source: "api_ai", outcome, resourceType: "review_workflow", resourceId: reviewId, metadata });

    // Phase A7 — durable budget reservation.
    const ledger = await tryReserveAiBudget({
      teamId, userId, feature: "REVIEWER_COPILOT",
      model: process.env.OPENAI_REVIEWER_COPILOT_MODEL?.trim() || "gpt-4.1-mini",
      requestId: `${body.idempotencyKey ?? `review:${reviewId}:${body.criteriaVersion}:${ids.sort().join(",")}`}:${Date.now()}`,
      estimatedCostUsdMicros: 250_000n,
    });
    if (ledger.decision && !ledger.decision.allowed && ledger.decision.code !== "DUPLICATE_REQUEST") {
      return reply.code(429).send({ code: `AI_BUDGET_${ledger.decision.code}`, message: "The workspace AI budget or operation limit has been reached." });
    }

    let result;
    try {
      result = await runReviewerCopilot({ teamId, reviewerContext, selectedEvidence, criteriaVersion: body.criteriaVersion, policyDecision, provider: buildReviewerCopilotProvider(), resolveCitation });
    } catch (err) {
      if (ledger.reservationId) await releaseAiReservation(buildPrismaLedgerStore(), ledger.reservationId).catch(() => undefined);
      if (err instanceof ReviewerCopilotProviderUnavailable) {
        await audit("failure", { status: "provider_unavailable" });
        return reply.code(200).send({ status: "provider_unavailable", advisoryBoundary: "AI assistance is advisory only." });
      }
      throw err;
    }
    if (ledger.reservationId) await reconcileAiUsage(buildPrismaLedgerStore(), ledger.reservationId, null).catch(() => undefined);
    await audit(result.status === "ok" ? "success" : result.status === "blocked_prohibited_claim" ? "blocked" : "failure", { status: result.status, criteriaVersion: body.criteriaVersion, droppedCitations: result.droppedCitations ?? 0, policyDecision: policyDecision.decision });

    // Phase D4 — bounded defensibility record (never blocks the response).
    const run = await persistCopilotRun({
      workspaceId: teamId, userId, feature: "REVIEWER_COPILOT", reviewId,
      requestId: body.idempotencyKey ?? `review:${reviewId}:${body.criteriaVersion}:${ids.sort().join(",")}`,
      model: process.env.OPENAI_REVIEWER_COPILOT_MODEL?.trim() || "gpt-4.1-mini",
      workspacePolicyVersion: policyDecision.policyVersion,
      criteriaVersion: body.criteriaVersion,
      processingMode: "METADATA_ONLY",
      selectedObjectVersions: result.versionMeta.contextObjectVersions,
      status: result.status,
      boundedResult: result.status === "ok" ? result.data : undefined,
      validatedCitations: result.status === "ok" ? (result.data as { citations?: unknown })?.citations : undefined,
    });
    return reply.code(200).send({ data: result, runId: run?.id ?? null });
  });

  // Phase D4 — record a human Accept/Edit/Reject on a Copilot observation.
  // Human interaction metadata only; never touches the review decision.
  app.post("/v1/ai/copilot-runs/:runId/observations", { preHandler: requireAuth }, async (req, reply) => {
    const userId = getAuthUserId(req);
    const runId = z.string().uuid().parse((req.params as { runId: string }).runId);
    const body = z.object({
      observationId: z.string().max(80),
      state: z.enum(["ACCEPTED", "EDITED", "REJECTED"]),
      originalText: z.string().max(1000),
      editedText: z.string().max(600).optional(),
    }).parse(req.body ?? {});

    const run = await prisma.aiCopilotRun.findUnique({ where: { id: runId }, select: { workspaceId: true } });
    if (!run) return reply.code(404).send({ error: { code: "run_not_found" } });
    const membership = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: run.workspaceId, userId } },
    });
    if (!membership) return reply.code(403).send({ error: { code: "not_a_member" } });

    const row = await recordObservationInteraction({
      copilotRunId: runId,
      observationId: body.observationId,
      state: body.state,
      originalText: body.originalText,
      editedText: body.editedText ?? null,
      actorId: userId,
    });
    await appendPlatformAuditLog({
      userId, action: "ai.copilot_observation_review", category: "ai", source: "api_ai",
      outcome: "success", resourceType: "ai_copilot_run", resourceId: runId,
      metadata: { observationId: body.observationId, state: body.state },
    });
    return reply.code(200).send({ id: row.id, state: row.state });
  });
}
