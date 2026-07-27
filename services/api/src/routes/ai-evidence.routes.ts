/**
 * Phase P4 — Live Evidence Copilot route.
 *   POST /v1/ai/evidence/:evidenceId/copilot
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorizeOrFail } from "../middleware/authorize.js";
import { emitTenantAudit } from "../services/audit/tenant-audit.service.js";
import { buildBaseContext, buildAllowlistedFields } from "../services/ai/ai-context-resolver.service.js";
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
import { buildPrismaLedgerStore, reconcileAiUsage, releaseAiReservation, tryReserveAiBudget } from "../services/ai/ai-usage-ledger.service.js";
import { sanitizeUntrustedField } from "../services/ai/prompt-context-sanitizer.service.js";
import { classifyChatScope } from "../services/ai/chat-scope-classifier.service.js";
import { buildSuggestedAction } from "../services/ai/ai-suggested-action.service.js";

const Body = z.object({
  evidenceVersion: z.number().int().optional(),
  processingMode: z.enum(["METADATA_ONLY", "APPROVED_CONTENT"]).default("METADATA_ONLY"),
  question: z.string().max(400).optional(),
  idempotencyKey: z.string().max(80).optional(),
});

const EVIDENCE_DETAIL_ALLOWLIST = [
  "title", "type", "mimeType", "status", "verificationStatus", "captureMethod",
  "caseLinked", "createdAtUtc", "reportVersion", "packageVersion",
  "tsaStatus", "otsStatus", "custodyEventCount",
] as const;

const EVIDENCE_SCHEMA = buildCopilotJsonSchema("proovra_evidence_copilot", "operationalSummary", [
  "missingContext", "integritySignalExplanations", "custodyObservations", "timestampingObservations",
  "reportReadiness", "packageReadiness", "reviewerPreparation", "workflowGaps",
  "suggestedNavigation", "suggestedActions",
]);
const EVIDENCE_SYSTEM = buildCopilotSystemPrompt("Evidence Copilot", [
  "You explain the operational state of ONE evidence record: what context is present or missing, what deterministic integrity/custody/timestamping signals exist, why a Report or Verification Package is pending, and what a reviewer should inspect.",
  "Integrity, custody, TSA, OTS, and package facts are DETERMINISTIC system state provided in the context — explain them; never contradict or invent them.",
]);

export async function aiEvidenceRoutes(app: FastifyInstance) {
  app.post("/v1/ai/evidence/:evidenceId/copilot", { preHandler: requireAuth }, async (req, reply) => {
    const userId = getAuthUserId(req);
    const evidenceId = z.string().uuid().parse((req.params as { evidenceId: string }).evidenceId);
    const body = Body.parse(req.body ?? {});

    // Canonical tenant-scoped load (deleted/inaccessible rejected).
    const ev = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      select: {
        id: true, teamId: true, deletedAt: true, title: true, type: true, mimeType: true,
        status: true, verificationStatus: true, captureMethod: true, caseId: true, createdAt: true,
        latestReportVersion: true, verificationPackageVersion: true,
        tsaStatus: true, otsStatus: true,
        _count: { select: { custodyEvents: true } },
      },
    });
    if (!ev?.teamId || ev.deletedAt) return reply.code(404).send({ error: { code: "evidence_not_found" } });
    // PHASE 1 AUTHORIZATION CLOSURE (2026-07-21) — canonical authorization
    // against the RESOURCE's team (ACTIVE membership + org lifecycle +
    // capability `intelligence.run` + fail-closed + anti-enumeration 404).
    const authz = await authorizeOrFail(req, reply, {
      teamId: ev.teamId,
      permission: "intelligence.run",
      resourceKind: "evidence",
      resourceId: ev.id,
      antiEnumeration: true,
    });
    if (!authz) return reply;
    // Role is read for AI-policy evaluation + context only; authorization is
    // already enforced above (an ACTIVE membership is guaranteed here).
    const membership = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: ev.teamId, userId } },
    });
    if (!membership) return reply.code(404).send({ error: { code: "not_found" } });
    const teamId = ev.teamId;
    const currentVersion = ev.verificationPackageVersion ?? 0;
    if (body.evidenceVersion != null && body.evidenceVersion !== currentVersion) {
      return reply.code(409).send({ error: { code: "stale_evidence_version" } });
    }
    // Optional question must itself be in the Evidence-Operations domain.
    if (body.question) {
      const scope = classifyChatScope(body.question);
      if (scope.refuse) {
        return reply.code(200).send({ data: { status: "question_out_of_scope", advisoryBoundary: scope.refusalMessage } });
      }
    }

    const policyDecision = await evaluateWorkspaceAiPolicy({
      teamId, feature: "EVIDENCE_CATEGORIZATION", dataClass: "METADATA", userRole: membership.role,
    });
    const guard = await enforceAiEndpointGuard({
      feature: "evidence-copilot", userId, ip: req.ip,
      dedupeKey: body.idempotencyKey ?? `${evidenceId}:${currentVersion}:${body.question ?? ""}`,
      dedupeWindowSec: 20,
    });
    if (!guard.allowed) {
      reply.header("Retry-After", String(guard.retryAfterSec));
      return reply.code(429).send({ code: guard.code, message: "Too many AI requests; please slow down." });
    }
    const ledger = await tryReserveAiBudget({
      teamId, userId, feature: "EVIDENCE_COPILOT",
      model: process.env.OPENAI_EVIDENCE_COPILOT_MODEL?.trim() || "gpt-4.1-mini",
      requestId: `${body.idempotencyKey ?? `evidence:${evidenceId}:${currentVersion}`}:${Date.now()}`,
      estimatedCostUsdMicros: 250_000n,
    });
    if (ledger.decision && !ledger.decision.allowed && ledger.decision.code !== "DUPLICATE_REQUEST") {
      return reply.code(429).send({ code: `AI_BUDGET_${ledger.decision.code}`, message: "The workspace AI budget or operation limit has been reached." });
    }

    // C3 — allowlisted sanitized context (deterministic signals included).
    const base = await buildBaseContext({ route: `/evidence/${evidenceId}`, routeClass: "EVIDENCE", role: membership.role, teamId, dataMode: body.processingMode });
    const fields = buildAllowlistedFields(
      {
        title: ev.title, type: ev.type, mimeType: ev.mimeType, status: ev.status,
        verificationStatus: ev.verificationStatus, captureMethod: ev.captureMethod,
        caseLinked: Boolean(ev.caseId), createdAtUtc: ev.createdAt?.toISOString?.() ?? null,
        reportVersion: ev.latestReportVersion ?? 0, packageVersion: ev.verificationPackageVersion ?? 0,
        tsaStatus: ev.tsaStatus ?? "NOT_REQUESTED", otsStatus: ev.otsStatus ?? "NOT_REQUESTED",
        custodyEventCount: ev._count.custodyEvents,
      },
      EVIDENCE_DETAIL_ALLOWLIST,
    );
    const evidenceContext = {
      ...base, objectType: "EVIDENCE_RECORD", objectId: ev.id, objectVersion: currentVersion,
      allowedActions: [], fields,
    };
    const resolveCitation = buildCitationResolver(buildWorkspaceCitationLookups(prisma as unknown as CitationPrisma, teamId));
    const callProvider = buildStructuredCopilotCall({
      modelEnvVar: "OPENAI_EVIDENCE_COPILOT_MODEL",
      jsonSchema: EVIDENCE_SCHEMA,
      system: EVIDENCE_SYSTEM,
    });

    const audit = (outcome: "success" | "failure" | "blocked", metadata: Record<string, unknown>) => {
      const mapped = outcome === "blocked" ? "denied" : outcome === "failure" ? "error" : "success";
      return emitTenantAudit({
        action: "ai.evidence_copilot",
        outcome: mapped,
        denialReason: mapped !== "success" ? (typeof metadata.status === "string" ? metadata.status : outcome) : null,
        sourceApp: "API",
        actorUserId: userId,
        workspaceId: teamId,
        resourceType: "evidence",
        resourceId: evidenceId,
        correlationId: req.id ?? null,
        metadata,
      });
    };

    let result;
    try {
      result = await runGroundedCopilot({
        surface: "EVIDENCE", teamId,
        selectionVersions: [{ id: ev.id, version: currentVersion }],
        requireSelection: true,
        policyDecision,
        callProvider: () => callProvider({
          evidence: evidenceContext,
          question: body.question ? sanitizeUntrustedField(body.question, 400) : null,
        }),
        resolveCitation,
        summaryField: "operationalSummary",
      });
    } catch (err) {
      if (ledger.reservationId) await releaseAiReservation(buildPrismaLedgerStore(), ledger.reservationId).catch(() => undefined);
      if (err instanceof CopilotProviderUnavailable) {
        await audit("failure", { status: "provider_unavailable" });
        return reply.code(200).send({ status: "provider_unavailable", advisoryBoundary: "AI assistance is advisory only." });
      }
      throw err;
    }
    if (ledger.reservationId) await reconcileAiUsage(buildPrismaLedgerStore(), ledger.reservationId, null).catch(() => undefined);

    await audit(result.status === "ok" ? "success" : result.status === "blocked_prohibited_claim" ? "blocked" : "failure", {
      status: result.status, droppedCitations: result.droppedCitations ?? 0, policyDecision: policyDecision.decision,
    });
    const run = await persistCopilotRun({
      workspaceId: teamId, userId, feature: "EVIDENCE_COPILOT",
      requestId: `${body.idempotencyKey ?? `evidence:${evidenceId}:${currentVersion}`}`,
      model: process.env.OPENAI_EVIDENCE_COPILOT_MODEL?.trim() || "gpt-4.1-mini",
      workspacePolicyVersion: policyDecision.policyVersion,
      processingMode: body.processingMode,
      selectedObjectVersions: result.versionMeta.contextObjectVersions,
      status: result.status,
      boundedResult: result.status === "ok" ? result.data : undefined,
      validatedCitations: result.status === "ok" ? (result.data as { citations?: unknown })?.citations : undefined,
    });
    // Phase P3(actions) — SERVER-derived executable actions. Deterministic
    // eligibility from real record state; the model never invents these.
    const serverActions = [];
    try {
      if ((ev.latestReportVersion ?? 0) > 0) {
        serverActions.push(buildSuggestedAction({
          actionType: "RETRY_ELIGIBLE_REPORT",
          displayLabel: "Regenerate Report",
          reason: "A newer report version can be generated for this record.",
          affectedObject: { type: "EVIDENCE_RECORD", id: ev.id, version: currentVersion },
          proposedChange: { reportVersion: (ev.latestReportVersion ?? 0) + 1 },
          requiredPermission: "evidence.report.generate",
          citations: [], versionMeta: {
            promptVersion: "1.0.0", modelVersion: "structured-copilot",
            contextSchemaVersion: "1.0.0", outputSchemaVersion: "1.0.0",
          },
        }));
      }
      if ((ev.latestReportVersion ?? 0) === 0 && ev.status === "SIGNED") {
        serverActions.push(buildSuggestedAction({
          actionType: "GENERATE_REPORT",
          displayLabel: "Generate Report",
          reason: "This signed record has no report yet.",
          affectedObject: { type: "EVIDENCE_RECORD", id: ev.id, version: currentVersion },
          proposedChange: { reportVersion: 1 },
          requiredPermission: "evidence.report.generate",
          citations: [], versionMeta: {
            promptVersion: "1.0.0", modelVersion: "structured-copilot",
            contextSchemaVersion: "1.0.0", outputSchemaVersion: "1.0.0",
          },
        }));
      }
      serverActions.push(buildSuggestedAction({
        actionType: "OPEN_MISSING_METADATA",
        displayLabel: "Open metadata section",
        reason: "Review and complete this record's metadata.",
        affectedObject: { type: "EVIDENCE_RECORD", id: ev.id, version: currentVersion },
        proposedChange: {},
        requiredPermission: "evidence.read",
        citations: [], versionMeta: {
          promptVersion: "1.0.0", modelVersion: "structured-copilot",
          contextSchemaVersion: "1.0.0", outputSchemaVersion: "1.0.0",
        },
      }));
      // Phase F-3 — a SIGNED record with no review workflow yet can be
      // routed to reviewer assignment (navigation only; assignment itself
      // happens through the normal governed review surface).
      if (ev.status === "SIGNED") {
        const existingReview = await prisma.evidenceReviewWorkflow
          .findFirst({ where: { evidenceId: ev.id, teamId }, select: { id: true } })
          .catch(() => null);
        if (!existingReview) {
          serverActions.push(buildSuggestedAction({
            actionType: "OPEN_REVIEWER_ASSIGNMENT",
            displayLabel: "Open reviewer assignment",
            reason: "This signed record has no review workflow yet.",
            affectedObject: { type: "EVIDENCE_RECORD", id: ev.id, version: currentVersion },
            proposedChange: {},
            requiredPermission: "review.assign",
            citations: [], versionMeta: {
              promptVersion: "1.0.0", modelVersion: "structured-copilot",
              contextSchemaVersion: "1.0.0", outputSchemaVersion: "1.0.0",
            },
          }));
        }
      }
    } catch { /* action derivation is optional */ }

    return reply.code(200).send({ data: result, runId: run?.id ?? null, serverActions });
  });
}
