/**
 * Phase D1/D2 — Live Case Copilot route.
 *   POST /v1/ai/case/:caseId/copilot
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

// THE copilot selection authority — the same module the panel reads. Eligibility
// is derived from persisted fields once, so the client cannot offer a record the
// server will refuse, and the server cannot refuse one the client had no way to
// know about.
import {
  COPILOT_SELECTION_MAX,
  COPILOT_SELECTION_MIN,
  buildCopilotIdempotencyKey,
  evaluateCopilotEvidenceEligibility,
} from "@proovra/shared";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { authorizeOrFail } from "../middleware/authorize.js";
import { emitTenantAudit } from "../services/audit/tenant-audit.service.js";
import { buildBaseContext, buildCaseContext, buildEvidenceContext } from "../services/ai/ai-context-resolver.service.js";

function auditCase(
  req: FastifyRequest,
  userId: string,
  outcome: "success" | "failure" | "blocked",
  resourceId: string,
  teamId: string,
  metadata: Record<string, unknown>,
) {
  const mapped = outcome === "blocked" ? "denied" : outcome === "failure" ? "error" : "success";
  return emitTenantAudit({
    action: "ai.case_copilot",
    outcome: mapped,
    denialReason: mapped !== "success" ? (typeof metadata.status === "string" ? metadata.status : outcome) : null,
    sourceApp: "API",
    actorUserId: userId,
    workspaceId: teamId,
    resourceType: "case",
    resourceId,
    correlationId: req.id ?? null,
    metadata,
  });
}
import { evaluateWorkspaceAiPolicy } from "../services/ai/workspace-ai-policy.service.js";
import { enforceAiEndpointGuard } from "../services/ai/ai-rate-limit.service.js";
import { runCaseCopilot } from "../services/ai/case-copilot.service.js";
import { buildCaseCopilotProvider, CaseCopilotProviderUnavailable } from "../services/ai/case-copilot-provider.js";
import { buildCitationResolver, buildWorkspaceCitationLookups, type CitationPrisma } from "../services/ai/ai-citation-db-resolver.service.js";
import { persistCopilotRun } from "../services/ai/ai-copilot-run-store.service.js";
import { buildPrismaLedgerStore, reconcileAiUsage, releaseAiReservation, tryReserveAiBudget } from "../services/ai/ai-usage-ledger.service.js";
import { cleanupExpiredCopilotRuns } from "../services/ai/ai-retention.service.js";

const Body = z.object({
  selectedEvidenceIds: z
    .array(z.string().uuid())
    .min(COPILOT_SELECTION_MIN)
    .max(COPILOT_SELECTION_MAX),
  selectedEvidenceVersions: z.record(z.string(), z.number().int()).optional(),
  processingMode: z.enum(["METADATA_ONLY", "APPROVED_CONTENT"]).default("METADATA_ONLY"),
  question: z.string().max(500).optional(),
  idempotencyKey: z.string().max(80).optional(),
});

export async function aiCaseRoutes(app: FastifyInstance) {
  app.post("/v1/ai/case/:caseId/copilot", { preHandler: requireAuth }, async (req, reply) => {
    const userId = getAuthUserId(req);
    const caseId = z.string().uuid().parse((req.params as { caseId: string }).caseId);
    const body = Body.parse(req.body ?? {});

    // Authorize case via workspace membership.
    const caseRow = await prisma.case.findUnique({
      where: { id: caseId },
      select: { id: true, teamId: true, name: true, status: true },
    });
    if (!caseRow?.teamId) return reply.code(404).send({ error: { code: "case_not_found" } });
    // PHASE 1 AUTHORIZATION CLOSURE (2026-07-21) — canonical authorization
    // against the RESOURCE's team (ACTIVE membership + org lifecycle +
    // capability `intelligence.run` + fail-closed + anti-enumeration 404).
    const authz = await authorizeOrFail(req, reply, {
      teamId: caseRow.teamId,
      permission: "intelligence.run",
      resourceKind: "case",
      resourceId: caseRow.id,
      antiEnumeration: true,
    });
    if (!authz) return reply;
    // Role read for AI-policy + context only; authorization enforced above.
    const membership = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: caseRow.teamId, userId } },
    });
    if (!membership) return reply.code(404).send({ error: { code: "not_found" } });
    const teamId = caseRow.teamId;

    // D2 — authorize + load explicitly-selected evidence (tenant-scoped, live).
    const ids = [...new Set(body.selectedEvidenceIds)];
    if (ids.length !== body.selectedEvidenceIds.length) {
      return reply.code(400).send({ error: { code: "duplicate_evidence_ids" } });
    }
    const rows = await prisma.evidence.findMany({
      where: { id: { in: ids }, teamId, deletedAt: null },
      select: {
        id: true, teamId: true, title: true, type: true, mimeType: true, status: true,
        verificationStatus: true, verificationPackageVersion: true, latestReportVersion: true,
        // Eligibility is derived from PERSISTED state, so the fields it reads
        // are selected here rather than inferred from what the client sent.
        lifecycleState: true,
        caseLinks: { select: { caseId: true } },
      },
    });
    if (rows.length !== ids.length) {
      return reply.code(403).send({ error: { code: "unauthorized_or_missing_evidence" } });
    }
    // FINAL, SERVER-AUTHORITATIVE ELIGIBILITY.
    //
    // The panel runs the same function over the same fields, so this normally
    // agrees with what the operator saw. It runs anyway: the client's list is a
    // snapshot, and between rendering it and pressing Run a record can finish
    // uploading, be unlinked, fail its integrity check or be scheduled for
    // destruction. Checked BEFORE the budget reservation and the provider call,
    // so an ineligible selection costs nothing.
    //
    // The refusal names WHICH records and WHY, using the shared bounded reason
    // vocabulary — never a table, a column or a status code. The client
    // refreshes and re-derives; it does not parse prose.
    const ineligible = rows
      .map((r) => ({
        id: r.id,
        verdict: evaluateCopilotEvidenceEligibility({
          status: r.status,
          lifecycleState: r.lifecycleState,
          caseLinked: r.caseLinks.some((l) => l.caseId === caseRow.id),
        }),
      }))
      .filter((x) => !x.verdict.eligible);
    if (ineligible.length > 0) {
      await auditCase(req, userId, "blocked", caseId, teamId, {
        status: "ineligible_selection",
        selectedCount: ids.length,
        ineligibleCount: ineligible.length,
      });
      return reply.code(422).send({
        error: {
          code: "evidence_not_analyzable",
          records: ineligible.map((x) => ({
            evidenceId: x.id,
            reason: x.verdict.eligible ? null : x.verdict.reason,
          })),
        },
      });
    }

    // Stale-version rejection.
    if (body.selectedEvidenceVersions) {
      for (const r of rows) {
        const expected = body.selectedEvidenceVersions[r.id];
        if (expected != null && expected !== (r.verificationPackageVersion ?? 0)) {
          return reply.code(409).send({ error: { code: "stale_evidence_version", evidenceId: r.id } });
        }
      }
    }

    // Policy gate (CASE_COPILOT) + role + rate limit.
    const policyDecision = await evaluateWorkspaceAiPolicy({
      teamId, feature: "CASE_COPILOT", dataClass: body.processingMode === "APPROVED_CONTENT" ? "DERIVED_CONTENT" : "METADATA", userRole: membership.role,
    });
    const guard = await enforceAiEndpointGuard({
      feature: "case-copilot", userId, ip: req.ip,
      dedupeKey:
        body.idempotencyKey ??
        buildCopilotIdempotencyKey({ scope: "case", scopeId: caseId, selection: ids }),
      dedupeWindowSec: 20,
    });
    if (!guard.allowed) {
      reply.header("Retry-After", String(guard.retryAfterSec));
      return reply.code(429).send({ code: guard.code, message: "Too many AI requests; please slow down." });
    }

    // C3 context (authorized rows only; allowlisted/sanitized/versioned).
    const base = await buildBaseContext({ route: `/cases/${caseId}`, routeClass: "CASE", role: membership.role, teamId, dataMode: body.processingMode });
    const caseContext = buildCaseContext(base, { id: caseRow.id, title: caseRow.name, status: caseRow.status });
    const selectedEvidence = rows.map((r) =>
      buildEvidenceContext({ ...base, routeClass: "EVIDENCE" }, {
        id: r.id, teamId: r.teamId, title: r.title, type: r.type, mimeType: r.mimeType,
        status: r.status, verificationStatus: r.verificationStatus, caseLinked: r.caseLinks.length > 0,
        verificationPackageVersion: r.verificationPackageVersion, latestReportVersion: r.latestReportVersion,
      }),
    );

    const resolveCitation = buildCitationResolver(
      buildWorkspaceCitationLookups(prisma as unknown as CitationPrisma, teamId),
    );

    // Phase A7 — durable budget reservation (multi-replica-safe authority).
    // The request's identity, bounded. The fallback used to concatenate every
    // id, which is the same unbounded shape that made the CLIENT's key exceed
    // this route's own `max(80)` at two selections.
    const requestIdentity =
      body.idempotencyKey ??
      buildCopilotIdempotencyKey({ scope: "case", scopeId: caseId, selection: ids });
    const ledgerRequestId = `${requestIdentity}:${Date.now()}`;
    const ledger = await tryReserveAiBudget({
      teamId, userId, feature: "CASE_COPILOT",
      model: process.env.OPENAI_CASE_COPILOT_MODEL?.trim() || "gpt-4.1-mini",
      requestId: ledgerRequestId, estimatedCostUsdMicros: 250_000n,
    });
    if (ledger.decision && !ledger.decision.allowed && ledger.decision.code !== "DUPLICATE_REQUEST") {
      return reply.code(429).send({ code: `AI_BUDGET_${ledger.decision.code}`, message: "The workspace AI budget or operation limit has been reached." });
    }

    let result;
    try {
      result = await runCaseCopilot({
        teamId, caseContext, selectedEvidence, policyDecision,
        provider: buildCaseCopilotProvider(), resolveCitation,
      });
    } catch (err) {
      if (err instanceof CaseCopilotProviderUnavailable) {
        if (ledger.reservationId) await releaseAiReservation(buildPrismaLedgerStore(), ledger.reservationId).catch(() => undefined);
        await auditCase(req, userId, "failure", caseId, teamId, { status: "provider_unavailable", selectedCount: ids.length });
        return reply.code(200).send({ status: "provider_unavailable", advisoryBoundary: "AI assistance is advisory only." });
      }
      if (ledger.reservationId) await releaseAiReservation(buildPrismaLedgerStore(), ledger.reservationId).catch(() => undefined);
      throw err;
    }
    if (ledger.reservationId) await reconcileAiUsage(buildPrismaLedgerStore(), ledger.reservationId, null).catch(() => undefined);

    await auditCase(req, userId, result.status === "ok" ? "success" : result.status === "blocked_prohibited_claim" ? "blocked" : "failure", caseId, teamId, {
      status: result.status, selectedCount: ids.length, droppedCitations: result.droppedCitations ?? 0, policyDecision: policyDecision.decision,
    });

    // Phase D4 — bounded defensibility record (never blocks the response).
    const run = await persistCopilotRun({
      workspaceId: teamId, userId, feature: "CASE_COPILOT", caseId,
      requestId: requestIdentity,
      model: process.env.OPENAI_CASE_COPILOT_MODEL?.trim() || "gpt-4.1-mini",
      workspacePolicyVersion: policyDecision.policyVersion,
      processingMode: body.processingMode,
      selectedObjectVersions: result.versionMeta.contextObjectVersions,
      status: result.status,
      boundedResult: result.status === "ok" ? result.data : undefined,
      validatedCitations: result.status === "ok" ? (result.data as { citations?: unknown })?.citations : undefined,
    });
    // Phase E1 — opportunistic advisory-record retention (never blocks).
    void cleanupExpiredCopilotRuns(teamId).catch(() => undefined);
    return reply.code(200).send({ data: result, runId: run?.id ?? null });
  });
}
