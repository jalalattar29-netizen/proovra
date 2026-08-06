/**
 * Phase D3/D4/D6 — Live Reviewer Copilot route.
 *   POST /v1/ai/reviewer/:reviewId/copilot
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorizeOrFail } from "../middleware/authorize.js";
import { emitTenantAudit } from "../services/audit/tenant-audit.service.js";
import { buildBaseContext, buildEvidenceContext } from "../services/ai/ai-context-resolver.service.js";
import type { ReviewerContext } from "../services/ai/ai-context-resolver.service.js";
import { evaluateWorkspaceAiPolicy } from "../services/ai/workspace-ai-policy.service.js";
// PHASE 12 — VERTICAL B. The ONE disclosure authority. Observation
// surfaces read from it; they never author their own AI claims.
import { resolveAiCapabilityDisclosure } from "../services/ai/ai-capability-disclosure.service.js";
import { enforceAiEndpointGuard } from "../services/ai/ai-rate-limit.service.js";
import { runReviewerCopilot } from "../services/ai/reviewer-copilot.service.js";
import { buildReviewerCopilotProvider, ReviewerCopilotProviderUnavailable } from "../services/ai/reviewer-copilot-provider.js";
import { buildCitationResolver, buildWorkspaceCitationLookups, type CitationPrisma } from "../services/ai/ai-citation-db-resolver.service.js";
import { persistCopilotRun, recordObservationInteraction } from "../services/ai/ai-copilot-run-store.service.js";
import { buildPrismaLedgerStore, reconcileAiUsage, releaseAiReservation, tryReserveAiBudget } from "../services/ai/ai-usage-ledger.service.js";
import { loadPublishedCriteria } from "./reviewer-criteria.routes.js";
import { selectQcSample } from "../services/ai/ai-qc-sampling.service.js";

const Body = z.object({
  selectedEvidenceIds: z.array(z.string().uuid()).max(50).optional(),
  // Phase P6 — criteria are resolved SERVER-SIDE from the published catalog.
  // The freeform string remains only as a fallback label for workspaces that
  // have not authored a criteria set yet.
  criteriaSetId: z.string().uuid().optional(),
  criteriaVersionId: z.string().uuid().optional(),
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
    // PHASE 1 AUTHORIZATION CLOSURE (2026-07-21) — canonical authorization
    // against the RESOURCE's team (ACTIVE membership + org lifecycle +
    // capability `intelligence.run` + fail-closed + anti-enumeration 404).
    const authz = await authorizeOrFail(req, reply, {
      teamId: wf.teamId,
      permission: "intelligence.run",
      resourceKind: "evidence_review_workflow",
      resourceId: wf.id,
      antiEnumeration: true,
    });
    if (!authz) return reply;
    // Role read for AI-policy + context only; authorization enforced above.
    const membership = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: wf.teamId, userId } },
    });
    if (!membership) return reply.code(404).send({ error: { code: "not_found" } });
    const teamId = wf.teamId;

    // Selected evidence defaults to the review's own record; all tenant-scoped.
    const ids = [...new Set(body.selectedEvidenceIds && body.selectedEvidenceIds.length > 0 ? body.selectedEvidenceIds : [wf.evidenceId])];
    const rows = await prisma.evidence.findMany({
      where: { id: { in: ids }, teamId, deletedAt: null },
      select: {
        id: true, teamId: true, title: true, type: true, mimeType: true, status: true,
        verificationStatus: true, verificationPackageVersion: true, latestReportVersion: true,
        caseLinks: { select: { caseId: true }, take: 1 },
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
      verificationStatus: r.verificationStatus, caseLinked: r.caseLinks.length > 0,
      verificationPackageVersion: r.verificationPackageVersion, latestReportVersion: r.latestReportVersion,
    }));
    const resolveCitation = buildCitationResolver(buildWorkspaceCitationLookups(prisma as unknown as CitationPrisma, teamId));

    const audit = (outcome: "success" | "failure" | "blocked", metadata: Record<string, unknown>) => {
      const mapped = outcome === "blocked" ? "denied" : outcome === "failure" ? "error" : "success";
      return emitTenantAudit({
        action: "ai.reviewer_copilot",
        outcome: mapped,
        denialReason: mapped !== "success" ? (typeof metadata.status === "string" ? metadata.status : outcome) : null,
        sourceApp: "API",
        actorUserId: userId,
        workspaceId: teamId,
        resourceType: "review_workflow",
        resourceId: reviewId,
        correlationId: req.id ?? null,
        metadata,
      });
    };

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

    // Phase P6 — SERVER-side criteria resolution. Client-supplied version
    // strings are never trusted when a catalog set is referenced: forged /
    // unpublished / cross-tenant versions are rejected here.
    let criteriaVersionLabel = body.criteriaVersion;
    let criteriaList: Array<{ key: string; title: string; required: boolean; reviewGuidance: string | null }> = [];
    if (body.criteriaSetId) {
      const loaded = await loadPublishedCriteria({
        teamId, criteriaSetId: body.criteriaSetId, criteriaVersionId: body.criteriaVersionId ?? null,
      });
      if (loaded && !loaded.ok) {
        return reply.code(loaded.code === "CROSS_TENANT" ? 403 : 409).send({ error: { code: `criteria_${loaded.code.toLowerCase()}` } });
      }
      if (loaded?.ok) {
        criteriaVersionLabel = loaded.versionLabel;
        criteriaList = loaded.criteria;
      }
    }

    let result;
    try {
      result = await runReviewerCopilot({ teamId, reviewerContext: { ...reviewerContext, fields: { ...reviewerContext.fields, criteria: JSON.stringify(criteriaList).slice(0, 4000) } }, selectedEvidence, criteriaVersion: criteriaVersionLabel, policyDecision, provider: buildReviewerCopilotProvider(), resolveCitation });
    } catch (err) {
      if (ledger.reservationId) await releaseAiReservation(buildPrismaLedgerStore(), ledger.reservationId).catch(() => undefined);
      if (err instanceof ReviewerCopilotProviderUnavailable) {
        await audit("failure", { status: "provider_unavailable" });
        return reply.code(200).send({ status: "provider_unavailable", advisoryBoundary: "AI assistance is advisory only." });
      }
      throw err;
    }
    if (ledger.reservationId) await reconcileAiUsage(buildPrismaLedgerStore(), ledger.reservationId, null).catch(() => undefined);
    await audit(result.status === "ok" ? "success" : result.status === "blocked_prohibited_claim" ? "blocked" : "failure", { status: result.status, criteriaVersion: criteriaVersionLabel, droppedCitations: result.droppedCitations ?? 0, policyDecision: policyDecision.decision });

    // Phase D4 — bounded defensibility record (never blocks the response).
    const run = await persistCopilotRun({
      workspaceId: teamId, userId, feature: "REVIEWER_COPILOT", reviewId,
      requestId: body.idempotencyKey ?? `review:${reviewId}:${body.criteriaVersion}:${ids.sort().join(",")}`,
      model: process.env.OPENAI_REVIEWER_COPILOT_MODEL?.trim() || "gpt-4.1-mini",
      workspacePolicyVersion: policyDecision.policyVersion,
      criteriaVersion: criteriaVersionLabel,
      processingMode: "METADATA_ONLY",
      selectedObjectVersions: result.versionMeta.contextObjectVersions,
      status: result.status,
      boundedResult: result.status === "ok" ? result.data : undefined,
      validatedCitations: result.status === "ok" ? (result.data as { citations?: unknown })?.citations : undefined,
    });
    return reply.code(200).send({ data: result, runId: run?.id ?? null });
  });

  // Phase P3(QC) — QC sampling over persisted Copilot runs.
  app.get("/v1/ai/qc/samples", { preHandler: requireAuth }, async (req, reply) => {
    const userId = getAuthUserId(req);
    const q = z.object({
      teamId: z.string().uuid(),
      strategy: z.enum(["RANDOM", "RISK_BASED", "HIGH_EDIT_RATE", "LOW_CITATION", "DISAGREEMENT", "POLICY_BLOCK", "PROVIDER_FAILURE"]).default("RISK_BASED"),
    }).parse(req.query ?? {});
    // PHASE 1 AUTHORIZATION CLOSURE (2026-07-21) — canonical authorization
    // for the claimed workspace (ACTIVE membership + org lifecycle +
    // capability `intelligence.read` + fail-closed + anti-enumeration 404).
    const authz = await authorizeOrFail(req, reply, {
      teamId: q.teamId,
      permission: "intelligence.read",
      antiEnumeration: true,
    });
    if (!authz) return reply;
    try {
      const runs = await prisma.aiCopilotRun.findMany({
        where: { workspaceId: q.teamId },
        orderBy: { generatedAt: "desc" },
        take: 200,
        include: { observationReviews: { select: { state: true, observationId: true, actorId: true, updatedAt: true } } },
      });
      const rows = runs.map((r) => {
        const obs = r.observationReviews.filter((o) => !o.observationId.startsWith("qc"));
        // Phase F-5 — DETERMINISTIC QC state: the caller's own verdict wins;
        // otherwise the most recent verdict across QC reviewers. Never an
        // arbitrary first row.
        const qcRows = r.observationReviews
          .filter((o) => o.observationId === "qc")
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        const myQc = qcRows.find((o) => o.actorId === userId) ?? null;
        return {
          id: r.id, workspaceId: r.workspaceId, feature: r.feature, status: r.status,
          generatedAt: r.generatedAt,
          droppedCitations: 0,
          observationCount: Math.max(obs.length, 1),
          editedCount: obs.filter((o) => o.state === "EDITED").length,
          rejectedCount: obs.filter((o) => o.state === "REJECTED").length,
          qcState: myQc?.state ?? qcRows[0]?.state ?? null,
          myQcState: myQc?.state ?? null,
          latestQcState: qcRows[0]?.state ?? null,
          qcReviewerCount: new Set(qcRows.map((o) => o.actorId)).size,
          // Phase QC-UI — deep-link targets + versions for the QC panel.
          caseId: r.caseId,
          reviewId: r.reviewId,
          criteriaVersion: r.criteriaVersion,
          interactionCount: obs.length,
        };
      });
      const sample = selectQcSample(rows, q.strategy, 10);
      return reply.code(200).send({
        strategy: q.strategy,
        samples: sample.map((s) => {
          const row = rows.find((r) => r.id === s.id);
          return {
            ...s,
            qcState: row?.qcState ?? null,
            myQcState: row?.myQcState ?? null,
            latestQcState: row?.latestQcState ?? null,
            qcReviewerCount: row?.qcReviewerCount ?? 0,
          };
        }),
      });
    } catch (err) {
      // Phase F-5 — only MIGRATION-shaped failures (table/column not yet
      // deployed: Prisma P2021/P2022) map to the friendly catalog-unavailable
      // response. Every other error propagates to the central handler as a
      // structured error instead of being silently swallowed.
      const code = (err as { code?: string })?.code;
      if (code === "P2021" || code === "P2022") {
        return reply.code(200).send({ strategy: q.strategy, samples: [], catalogAvailable: false });
      }
      throw err;
    }
  });

  // Phase P3(QC) — record a QC verdict on a sampled run (reuses the canonical
  // observation-interaction model; observationId "qc").
  app.post("/v1/ai/qc/samples/:runId/decision", { preHandler: requireAuth }, async (req, reply) => {
    const userId = getAuthUserId(req);
    const runId = z.string().uuid().parse((req.params as { runId: string }).runId);
    const body = z.object({ decision: z.enum(["QC_ACCEPTED", "QC_SKIPPED", "QC_REVIEWED"]) }).parse(req.body ?? {});
    const run = await prisma.aiCopilotRun.findUnique({ where: { id: runId }, select: { workspaceId: true } });
    if (!run) return reply.code(404).send({ error: { code: "run_not_found" } });
    // PHASE 1 AUTHORIZATION CLOSURE (2026-07-21) — canonical authorization
    // against the run's workspace (ACTIVE membership + org lifecycle +
    // capability `intelligence.run` + fail-closed + anti-enumeration 404).
    const authz = await authorizeOrFail(req, reply, {
      teamId: run.workspaceId,
      permission: "intelligence.run",
      antiEnumeration: true,
    });
    if (!authz) return reply;
    const row = await recordObservationInteraction({
      copilotRunId: runId, observationId: "qc",
      state: body.decision === "QC_ACCEPTED" ? "ACCEPTED" : body.decision === "QC_SKIPPED" ? "REJECTED" : "EDITED",
      originalText: `qc:${body.decision}`, editedText: body.decision, actorId: userId,
    });
    await emitTenantAudit({
      action: "ai.qc_decision",
      outcome: "success",
      sourceApp: "API",
      actorUserId: userId,
      workspaceId: run.workspaceId,
      resourceType: "ai_copilot_run",
      resourceId: runId,
      correlationId: req.id ?? null,
      metadata: { decision: body.decision },
    });
    return reply.code(200).send({ id: row.id, decision: body.decision });
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

    // PHASE 12 — VERTICAL B. The workspace is derived from the PERSISTED
    // run row, never from the request.
    const run = await prisma.aiCopilotRun.findUnique({
      where: { id: runId },
      select: {
        workspaceId: true,
        feature: true,
        workspacePolicyVersion: true,
        status: true,
      },
    });
    if (!run) return reply.code(404).send({ error: { code: "run_not_found" } });
    // PHASE 1 AUTHORIZATION CLOSURE (2026-07-21) — canonical authorization
    // against the run's workspace (ACTIVE membership + org lifecycle +
    // capability `intelligence.run` + fail-closed + anti-enumeration 404).
    const authz = await authorizeOrFail(req, reply, {
      teamId: run.workspaceId,
      permission: "intelligence.run",
      antiEnumeration: true,
    });
    if (!authz) return reply;

    // PHASE 12 — VERTICAL B. Observation review runs through the ONE
    // canonical AI policy + disclosure authority. There is deliberately
    // NO second policy engine here.
    //
    // The decision is RECORDED, not used to block: accepting, editing,
    // or rejecting an observation is a HUMAN act of control over an
    // already-generated run. Blocking it because the workspace later
    // disabled AI would strand the human in the loop, which inverts the
    // platform's human-control guarantee. What the authority governs is
    // GENERATION (`/copilot`, already gated above at run time); what it
    // contributes here is the defensibility stamp + the disclosure the
    // operator sees alongside their own verdict.
    const membership = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: run.workspaceId, userId } },
      select: { role: true },
    });
    const policyDecision = await evaluateWorkspaceAiPolicy({
      teamId: run.workspaceId,
      feature: "REVIEWER_COPILOT",
      dataClass: "METADATA",
      userRole: membership?.role ?? null,
    });

    const row = await recordObservationInteraction({
      copilotRunId: runId,
      observationId: body.observationId,
      state: body.state,
      originalText: body.originalText,
      editedText: body.editedText ?? null,
      actorId: userId,
    });
    await emitTenantAudit({
      action: "ai.copilot_observation_review",
      outcome: "success",
      sourceApp: "API",
      actorUserId: userId,
      workspaceId: run.workspaceId,
      resourceType: "ai_copilot_run",
      resourceId: runId,
      correlationId: req.id ?? null,
      metadata: {
        observationId: body.observationId,
        state: body.state,
        // Defensibility: which policy version governed the run the human
        // acted on, and what the canonical authority says right now.
        runPolicyVersion: run.workspacePolicyVersion,
        currentPolicyDecision: policyDecision.decision,
        currentPolicyVersion: policyDecision.policyVersion,
      },
    });

    // Bounded disclosure for the reviewer surface. Sourced from the
    // canonical `resolveAiCapabilityDisclosure` authority — the UI never
    // composes its own AI claims.
    const disclosure = await resolveAiCapabilityDisclosure(run.workspaceId)
      .then((rows) =>
        rows
          .filter((d) => d.capability.toLowerCase().includes("reviewer"))
          .map((d) => ({
            capability: d.capability,
            provider: d.provider,
            dataCategory: d.dataCategory,
            rawContent: d.rawContent,
            operationalStatus: d.operationalStatus,
            trainingMode: d.trainingMode,
            retentionMode: d.retentionMode,
          })),
      )
      .catch(() => []);

    return reply.code(200).send({
      id: row.id,
      state: row.state,
      aiPolicy: {
        decision: policyDecision.decision,
        allowed: policyDecision.allowed,
        policyVersion: policyDecision.policyVersion,
        runPolicyVersion: run.workspacePolicyVersion,
      },
      disclosure,
      advisoryBoundary:
        "AI assistance is advisory only. The recorded verdict is the reviewer's, not the model's.",
    });
  });
}
