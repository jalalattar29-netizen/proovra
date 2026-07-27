/**
 * Phase P7 — Operations Intelligence.
 *   POST /v1/ai/operations/summary
 *
 * Bounded operational summaries over a DETERMINISTIC snapshot (counts and
 * statuses computed server-side). No free-form general chat: the operation
 * type is a bounded enum; an optional question must classify into an
 * approved Evidence-Operations intent or the request is refused.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorizeOrFail } from "../middleware/authorize.js";
import { emitTenantAudit } from "../services/audit/tenant-audit.service.js";
import { evaluateWorkspaceAiPolicy } from "../services/ai/workspace-ai-policy.service.js";
import { enforceAiEndpointGuard } from "../services/ai/ai-rate-limit.service.js";
import { runGroundedCopilot } from "../services/ai/copilot-orchestrator.js";
import {
  buildCopilotJsonSchema,
  buildCopilotSystemPrompt,
  buildStructuredCopilotCall,
  CopilotProviderUnavailable,
} from "../services/ai/structured-copilot-provider.js";
import { buildCitationResolver, buildWorkspaceCitationLookups, type CitationPrisma } from "../services/ai/ai-citation-db-resolver.service.js";
import { persistCopilotRun } from "../services/ai/ai-copilot-run-store.service.js";
import {
  buildPrismaLedgerStore,
  reconcileAiUsage,
  releaseAiReservation,
  tryReserveAiBudget,
} from "../services/ai/ai-usage-ledger.service.js";
import { classifyChatScope } from "../services/ai/chat-scope-classifier.service.js";

const OPERATION_TYPES = [
  "WORKSPACE_HEALTH",
  "TSA_FAILURES",
  "OTS_PENDING",
  "REPORT_PACKAGE_FAILURES",
  "REVIEW_BACKLOG",
  "CONFIGURATION_GAPS",
] as const;

const Body = z.object({
  teamId: z.string().uuid(),
  operationType: z.enum(OPERATION_TYPES),
  question: z.string().max(300).optional(),
  idempotencyKey: z.string().max(80).optional(),
});

const OPS_SCHEMA = buildCopilotJsonSchema("proovra_operations_intelligence", "operationalSummary", [
  "affectedWorkflows", "failureGroups", "queueOrSlaObservations", "configurationGaps", "suggestedActions",
]);
const OPS_SYSTEM = buildCopilotSystemPrompt("Operations Intelligence assistant", [
  "You explain DETERMINISTIC operational counts and statuses provided in the snapshot: failed TSA jobs, pending OTS upgrades, report/package pipeline state, review backlog, and configuration gaps.",
  "The snapshot values are system facts — explain them and recommend supported operational next steps; never invent counts or statuses, and never draw legal or forensic conclusions.",
]);

/** Deterministic bounded snapshot — counts only, no raw evidence content. */
async function buildOperationsSnapshot(teamId: string) {
  const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);
  const [tsaFailed, otsPending, missingReports, backlog, usage] = await Promise.all([
    safe(prisma.evidence.count({ where: { teamId, tsaStatus: "FAILED", deletedAt: null } }), 0),
    safe(prisma.evidence.count({ where: { teamId, otsStatus: "PENDING", deletedAt: null } }), 0),
    safe(prisma.evidence.count({ where: { teamId, status: "SIGNED", latestReportVersion: null, deletedAt: null } }), 0),
    safe(prisma.evidenceReviewWorkflow.count({ where: { teamId, status: { in: ["NOT_STARTED", "IN_REVIEW"] } } }), 0),
    safe(prisma.aiUsageMonthly.findFirst({ where: { workspaceId: teamId }, orderBy: { monthUtc: "desc" } }), null),
  ]);
  return {
    tsaFailedCount: tsaFailed,
    otsPendingCount: otsPending,
    signedWithoutReportCount: missingReports,
    openReviewWorkflowCount: backlog,
    aiOperationsThisMonth: usage?.operations ?? 0,
    snapshotAtUtc: new Date().toISOString(),
  };
}

export async function aiOperationsRoutes(app: FastifyInstance) {
  app.post("/v1/ai/operations/summary", { preHandler: requireAuth }, async (req, reply) => {
    const userId = getAuthUserId(req);
    const body = Body.parse(req.body ?? {});
    // PHASE 1 AUTHORIZATION CLOSURE (2026-07-21) — canonical authorization
    // for the claimed workspace (ACTIVE membership + org lifecycle +
    // capability `intelligence.run` + fail-closed + anti-enumeration 404).
    const authz = await authorizeOrFail(req, reply, {
      teamId: body.teamId,
      permission: "intelligence.run",
      antiEnumeration: true,
    });
    if (!authz) return reply;
    // Role read for the additional operations/admin restriction below;
    // authorization (incl. ACTIVE status) already enforced above.
    const membership = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: body.teamId, userId } },
    });
    if (!membership) return reply.code(404).send({ error: { code: "not_found" } });
    // Operations Intelligence remains restricted to OWNER/ADMIN — a stricter
    // constraint than intelligence.run alone (which REVIEWER also holds).
    if (membership.role !== "OWNER" && membership.role !== "ADMIN") {
      return reply.code(403).send({ error: { code: "permission_denied", reason: "Operations Intelligence requires an operations/admin role." } });
    }
    const teamId = body.teamId;

    // Bounded optional question — must classify into an approved intent.
    if (body.question) {
      const scope = classifyChatScope(body.question);
      if (scope.refuse) {
        return reply.code(200).send({ data: { status: "question_out_of_scope", advisoryBoundary: scope.refusalMessage } });
      }
    }

    const policyDecision = await evaluateWorkspaceAiPolicy({
      teamId, feature: "CONTENT_INTELLIGENCE", dataClass: "METADATA", userRole: membership.role,
    });
    // Operations summaries are metadata-only; gate on master switch even when
    // content-intelligence toggle differs.
    const opsDecision = policyDecision.allowed
      ? policyDecision
      : await evaluateWorkspaceAiPolicy({ teamId, feature: "SUPPORT_CHAT", dataClass: "METADATA", userRole: membership.role });

    const guard = await enforceAiEndpointGuard({
      feature: "operations-intelligence", userId, ip: req.ip,
      dedupeKey: body.idempotencyKey ?? `${teamId}:${body.operationType}`,
      dedupeWindowSec: 30,
    });
    if (!guard.allowed) {
      reply.header("Retry-After", String(guard.retryAfterSec));
      return reply.code(429).send({ code: guard.code, message: "Too many AI requests; please slow down." });
    }

    // Phase F-2 — canonical durable ledger (reserve → provider → reconcile;
    // release on failure). Same flow as the other Copilots; no custom logic.
    // Reserved only after the deterministic short-circuits above (membership,
    // role, out-of-scope question, rate limit) so refusals cost nothing.
    const ledger = await tryReserveAiBudget({
      teamId,
      userId,
      feature: "OPERATIONS_INTELLIGENCE",
      model: process.env.OPENAI_OPERATIONS_MODEL?.trim() || "gpt-4.1-mini",
      requestId: `${body.idempotencyKey ?? `ops:${teamId}:${body.operationType}`}:${Date.now()}`,
      estimatedCostUsdMicros: 250_000n,
    });
    if (ledger.decision && !ledger.decision.allowed && ledger.decision.code !== "DUPLICATE_REQUEST") {
      return reply.code(429).send({
        code: `AI_BUDGET_${ledger.decision.code}`,
        message: "The workspace AI budget or operation limit has been reached.",
      });
    }

    const snapshot = await buildOperationsSnapshot(teamId);
    const resolveCitation = buildCitationResolver(buildWorkspaceCitationLookups(prisma as unknown as CitationPrisma, teamId));
    const callProvider = buildStructuredCopilotCall({
      modelEnvVar: "OPENAI_OPERATIONS_MODEL",
      jsonSchema: OPS_SCHEMA,
      system: OPS_SYSTEM,
    });
    const audit = (outcome: "success" | "failure" | "blocked", metadata: Record<string, unknown>) => {
      const mapped = outcome === "blocked" ? "denied" : outcome === "failure" ? "error" : "success";
      return emitTenantAudit({
        action: "ai.operations_intelligence",
        outcome: mapped,
        denialReason: mapped !== "success" ? (typeof metadata.status === "string" ? metadata.status : outcome) : null,
        sourceApp: "API",
        actorUserId: userId,
        workspaceId: teamId,
        resourceType: "workspace",
        resourceId: teamId,
        correlationId: req.id ?? null,
        metadata,
      });
    };

    let result;
    try {
      result = await runGroundedCopilot({
        surface: "OPERATIONS", teamId,
        selectionVersions: [], requireSelection: false,
        policyDecision: opsDecision,
        callProvider: () => callProvider({ operationType: body.operationType, snapshot }),
        resolveCitation,
        summaryField: "operationalSummary",
      });
    } catch (err) {
      if (ledger.reservationId) {
        await releaseAiReservation(buildPrismaLedgerStore(), ledger.reservationId).catch(() => undefined);
      }
      if (err instanceof CopilotProviderUnavailable) {
        await audit("failure", { status: "provider_unavailable", operationType: body.operationType });
        return reply.code(200).send({ status: "provider_unavailable", snapshot, advisoryBoundary: "AI assistance is advisory only." });
      }
      throw err;
    }
    if (ledger.reservationId) {
      // policy_denied never reached the provider — release; everything else
      // consumed a provider call and reconciles.
      if (result.status === "policy_denied") {
        await releaseAiReservation(buildPrismaLedgerStore(), ledger.reservationId).catch(() => undefined);
      } else {
        await reconcileAiUsage(buildPrismaLedgerStore(), ledger.reservationId, null).catch(() => undefined);
      }
    }

    await audit(result.status === "ok" ? "success" : "failure", { status: result.status, operationType: body.operationType });
    const run = await persistCopilotRun({
      workspaceId: teamId, userId, feature: "OPERATIONS_INTELLIGENCE",
      requestId: `${body.idempotencyKey ?? `ops:${teamId}:${body.operationType}`}:${Date.now()}`,
      model: process.env.OPENAI_OPERATIONS_MODEL?.trim() || "gpt-4.1-mini",
      workspacePolicyVersion: opsDecision.policyVersion,
      processingMode: "METADATA_ONLY",
      selectedObjectVersions: [],
      status: result.status,
      boundedResult: result.status === "ok" ? result.data : undefined,
    });
    return reply.code(200).send({ data: result, snapshot, runId: run?.id ?? null });
  });
}
