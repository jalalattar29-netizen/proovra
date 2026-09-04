/**
 * Phase P4 — Live Evidence Copilot route.
 *   POST /v1/ai/evidence/:evidenceId/copilot
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { getAuthUserId } from "../auth.js";
import { prisma } from "../db.js";
import {
  EVIDENCE_ANALYSIS_SELECT,
  findDriftedSnapshot,
  toSnapshot,
  type EvidenceAnalysisRow,
} from "../services/ai/evidence-analysis-snapshot.service.js";
import {
  buildCopilotIdempotencyKey,
  evaluateCopilotEvidenceEligibility,
  evidenceAnalysisRevisionsMatch,
  sha256Base64Url,
} from "@proovra/shared";
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
import {
  policyFeatureForOperation,
  type AiOperation,
} from "../services/ai/ai-operation-registry.js";
import { classifyChatScope } from "../services/ai/chat-scope-classifier.service.js";
import { buildSuggestedAction } from "../services/ai/ai-suggested-action.service.js";

const Body = z.object({
  /**
   * The OPAQUE analysis revision the operator's view was built from.
   *
   * This was `evidenceVersion: z.number().int().optional()`, compared against
   * `verificationPackageVersion ?? 0`. Both sides collapsed identically, so no
   * false rejection was reachable — but the guard answered a question about a
   * package counter while this route shows the model thirteen other fields,
   * and it silently did nothing when omitted.
   *
   * Required now, and compared against a server-recomputed revision.
   */
  evidenceRevision: z.string().max(64),
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

/**
 * This route's operation label — the value written to the usage ledger and the
 * copilot run row, and the key the registry maps to a policy switch. One
 * constant so the gate, the budget and the audit trail cannot name three
 * different things.
 */
const EVIDENCE_COPILOT_OPERATION = "EVIDENCE_COPILOT" satisfies AiOperation;

export async function aiEvidenceRoutes(app: FastifyInstance) {
  app.post("/v1/ai/evidence/:evidenceId/copilot", { preHandler: requireAuth }, async (req, reply) => {
    const userId = getAuthUserId(req);
    const evidenceId = z.string().uuid().parse((req.params as { evidenceId: string }).evidenceId);
    const body = Body.parse(req.body ?? {});

    // Canonical tenant-scoped load (deleted/inaccessible rejected).
    //
    // Read through the SAME select every Copilot surface uses, so the fields
    // the revision covers and the fields this route shows the model cannot
    // drift apart. Tenancy is applied after authorization below, because this
    // route resolves the record before it knows the team.
    const ev = (await prisma.evidence.findUnique({
      where: { id: evidenceId },
      select: EVIDENCE_ANALYSIS_SELECT,
    })) as unknown as EvidenceAnalysisRow | null;
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
    // THE frozen snapshot. Eligibility, the revision comparison, the request
    // identity and the model's prompt all read this one object.
    const analysisScope = { scope: "evidence" as const, scopeId: null };
    const snapshot = toSnapshot(ev, analysisScope);

    // SERVER-AUTHORITATIVE ELIGIBILITY. This route had none: a record still
    // uploading, one whose integrity check had failed, or one scheduled for
    // destruction was analyzed and paid for like any other.
    const verdict = evaluateCopilotEvidenceEligibility({
      status: snapshot.row.status,
      lifecycleState: snapshot.row.lifecycleState,
    });
    if (!verdict.eligible) {
      return reply.code(422).send({
        error: {
          code: "evidence_not_analyzable",
          records: [{ evidenceId: ev.id, reason: verdict.reason }],
        },
      });
    }

    // STALE-REVISION REJECTION, against the same authority the Case surface
    // uses. A revision from the CASE surface can never satisfy this one: the
    // scope is part of the digest, so a snapshot cannot be replayed across
    // surfaces.
    if (!evidenceAnalysisRevisionsMatch(body.evidenceRevision, snapshot.revision)) {
      return reply.code(409).send({ error: { code: "stale_evidence_revision" } });
    }
    // Optional question must itself be in the Evidence-Operations domain.
    if (body.question) {
      const scope = classifyChatScope(body.question);
      if (scope.refuse) {
        return reply.code(200).send({ data: { status: "question_out_of_scope", advisoryBoundary: scope.refusalMessage } });
      }
    }

    /*
     * The switch comes from the registry, not from a name written here.
     *
     * This route records its usage as `EVIDENCE_COPILOT` but is governed by
     * `EVIDENCE_CATEGORIZATION` — the one operation in the product whose label
     * and switch differ. Spelled out at the gate, that coupling was invisible
     * from the usage ledger and impossible to test; derived from the registry,
     * it is stated once and asserted.
     */
    const policyDecision = await evaluateWorkspaceAiPolicy({
      teamId,
      feature: policyFeatureForOperation(EVIDENCE_COPILOT_OPERATION),
      dataClass: "METADATA",
      userRole: membership.role,
    });
    // The server builds the identity from the revision it just recomputed, so
    // a client cannot buy a cache hit by sending a key from a previous state.
    const requestIdentity = buildCopilotIdempotencyKey({
      scope: "evidence",
      scopeId: evidenceId,
      selection: [evidenceId],
      revisions: { [evidenceId]: snapshot.revision },
      mode: body.processingMode,
      qualifier: body.question ? sha256Base64Url(body.question).slice(0, 16) : null,
    });
    const guard = await enforceAiEndpointGuard({
      feature: "evidence-copilot", userId, ip: req.ip,
      // ONE bounded builder, as on every other surface. This concatenated the
      // id and a package version, so a retry after a genuine metadata change
      // produced the SAME key and could be de-duplicated into the old answer.
      dedupeKey: requestIdentity,
      dedupeWindowSec: 20,
    });
    if (!guard.allowed) {
      reply.header("Retry-After", String(guard.retryAfterSec));
      return reply.code(429).send({ code: guard.code, message: "Too many AI requests; please slow down." });
    }
    const ledger = await tryReserveAiBudget({
      teamId, userId, feature: EVIDENCE_COPILOT_OPERATION,
      model: process.env.OPENAI_EVIDENCE_COPILOT_MODEL?.trim() || "gpt-4.1-mini",
      requestId: `${requestIdentity}:${Date.now()}`,
      estimatedCostUsdMicros: 250_000n,
    });
    if (ledger.decision && !ledger.decision.allowed && ledger.decision.code !== "DUPLICATE_REQUEST") {
      return reply.code(429).send({ code: `AI_BUDGET_${ledger.decision.code}`, message: "The workspace AI budget or operation limit has been reached." });
    }

    // C3 — allowlisted sanitized context (deterministic signals included).
    const base = await buildBaseContext({ route: `/evidence/${evidenceId}`, routeClass: "EVIDENCE", role: membership.role, teamId, dataMode: body.processingMode });
    // From the FROZEN snapshot. `reportVersion` and `packageVersion` were
    // `?? 0`, which told the model a record with no package had package
    // version zero — a package that does not exist is not a package at
    // version 0, and the model was being asked to explain the difference.
    const fields = buildAllowlistedFields(
      {
        title: snapshot.row.title,
        type: snapshot.row.type,
        mimeType: snapshot.row.mimeType,
        status: snapshot.row.status,
        verificationStatus: snapshot.row.verificationStatus,
        captureMethod: snapshot.row.captureMethod,
        caseLinked: snapshot.row._count.caseLinks > 0,
        createdAtUtc: snapshot.row.createdAt?.toISOString() ?? null,
        reportVersion: snapshot.row.latestReportVersion,
        packageVersion: snapshot.row.verificationPackageVersion,
        tsaStatus: snapshot.row.tsaStatus ?? "NOT_REQUESTED",
        otsStatus: snapshot.row.otsStatus ?? "NOT_REQUESTED",
        custodyEventCount: snapshot.row._count.custodyEvents,
      },
      EVIDENCE_DETAIL_ALLOWLIST,
    );
    const evidenceContext = {
      ...base,
      objectType: "EVIDENCE_RECORD",
      objectId: ev.id,
      objectVersion: snapshot.row.verificationPackageVersion,
      allowedActions: [],
      fields,
    };    const resolveCitation = buildCitationResolver(buildWorkspaceCitationLookups(prisma as unknown as CitationPrisma, teamId));
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

    // TOCTOU CLOSE — reserving budget is a round trip, and another writer can
    // commit inside it. Re-read and recompute before anything is spent.
    const drifted = await findDriftedSnapshot({ snapshots: [snapshot], teamId, scope: analysisScope });
    if (drifted) {
      if (ledger.reservationId) {
        await releaseAiReservation(buildPrismaLedgerStore(), ledger.reservationId).catch(
          () => undefined,
        );
      }
      return reply.code(409).send({ error: { code: "stale_evidence_revision" } });
    }

    let result;
    try {
      result = await runGroundedCopilot({
        surface: "EVIDENCE", teamId,
        selectionRevisions: [{ id: ev.id, revision: snapshot.revision }],
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
      workspaceId: teamId, userId, feature: EVIDENCE_COPILOT_OPERATION,
      requestId: requestIdentity,
      model: process.env.OPENAI_EVIDENCE_COPILOT_MODEL?.trim() || "gpt-4.1-mini",
      workspacePolicyVersion: policyDecision.policyVersion,
      processingMode: body.processingMode,
      selectedObjectRevisions: result.versionMeta.contextObjectRevisions,
      status: result.status,
      boundedResult: result.status === "ok" ? result.data : undefined,
      validatedCitations: result.status === "ok" ? (result.data as { citations?: unknown })?.citations : undefined,
    });
    // Phase P3(actions) — SERVER-derived executable actions. Deterministic
    // eligibility from real record state; the model never invents these.
    const serverActions = [];
    //
    // A REPORT EXISTS or it does not, and the artifact answers that — not a
    // version column read through `?? 0`, which cannot tell "no report" from
    // "report version 0" and is the derivation the lifecycle contract forbids.
    const hasReport = snapshot.row._count.reports > 0;
    try {
      if (hasReport) {
        serverActions.push(buildSuggestedAction({
          actionType: "RETRY_ELIGIBLE_REPORT",
          displayLabel: "Regenerate Report",
          reason: "A newer report version can be generated for this record.",
          affectedObject: { type: "EVIDENCE_RECORD", id: ev.id, version: snapshot.row.verificationPackageVersion },
          // The NEXT version, from the recorded one. A record with a report
          // always has a version, so there is nothing to default here.
          proposedChange: { reportVersion: (snapshot.row.latestReportVersion ?? 1) + 1 },
          requiredPermission: "evidence.report.generate",
          citations: [], versionMeta: {
            promptVersion: "1.0.0", modelVersion: "structured-copilot",
            contextSchemaVersion: "1.0.0", outputSchemaVersion: "1.0.0",
          },
        }));
      }
      if (!hasReport && snapshot.row.status === "SIGNED") {
        serverActions.push(buildSuggestedAction({
          actionType: "GENERATE_REPORT",
          displayLabel: "Generate Report",
          reason: "This signed record has no report yet.",
          affectedObject: { type: "EVIDENCE_RECORD", id: ev.id, version: snapshot.row.verificationPackageVersion },
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
        affectedObject: { type: "EVIDENCE_RECORD", id: ev.id, version: snapshot.row.verificationPackageVersion },
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
            affectedObject: { type: "EVIDENCE_RECORD", id: ev.id, version: snapshot.row.verificationPackageVersion },
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
