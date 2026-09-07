/**
 * PROOVRA Phase 3B — Media Intelligence ingest + projection.
 *
 * Single bounded write path for every provider record + entity row
 * produced via the adapter abstraction. Provides:
 *
 *   * `ingestProviderResult` — bounded persistence of records +
 *     entities + usage event (via `recordProviderUsage`).
 *   * `runProviderOperation` — bounded "call adapter + budget
 *     gate + ingest" orchestration. Returns the same shape the
 *     adapter returned plus the ingest counts.
 *   * Projection helpers — `listRecordsForEvidence`,
 *     `getRecordWithCorrections`.
 *
 * Hard rules:
 *   * Workspace-anchored at every entry point.
 *   * NEVER mutates the evidence row.
 *   * Refuses to run a paid provider call when `decideBudgetGate`
 *     returns BLOCK; records the bounded
 *     `PROVIDER_CALL_REFUSED_BUDGET` usage event instead.
 *   * Final confidence band is the bounded `classifyIntelligenceConfidence`
 *     of the provider raw confidence (the reviewer can later
 *     correct it via the corrections service).
 */

import type { PrismaClient } from "@prisma/client";
import {
  classifyIntelligenceConfidence,
  type IntelligenceConfidenceBand,
  type MediaIntelligenceModality,
  type MediaIntelligenceProvider,
  type MediaIntelligenceRecordKind,
  type MediaIntelligenceRecordProjection,
  type MediaIntelligenceRecordState,
  type ProviderAdapterOperation,
  type ProviderBudgetDecision,
  type ReviewerCorrectionProjection,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import {
  type AdapterByteSource,
  type AdapterEntityRow,
  type AdapterRecordRow,
  type IntelligenceProviderResult,
  type ProviderAdapter,
  getAdapter,
} from "./providers/provider-adapter.js";
import { decideBudgetGate } from "./provider-budget.service.js";
import { recordProviderUsage } from "./provider-usage.service.js";
import { emitLifecycleEvent } from "./intelligence-activity.service.js";
import { evaluateIntelligencePolicy } from "../governance/policy-evaluation.service.js";
import { resolveWorkspaceAiPolicy } from "../ai/workspace-ai-policy.service.js";
// PLATFORM COMMERCIAL AUTHORITY CLOSURE (2026-09-07) — the AI commercial
// allowance is resolved by THE canonical billing authority, not by the
// ProductLine packaging engine. This module no longer imports that engine at
// all, which is what makes the retirement structural rather than a comment.
import {
  evaluateWorkspaceAiOperation,
  recordWorkspaceAiOperation,
} from "../billing-enforcement.service.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IngestProviderResultInput = {
  prisma?: PrismaClient;
  teamId: string;
  evidenceId: string;
  provider: MediaIntelligenceProvider;
  result: IntelligenceProviderResult;
};

export type IngestProviderResultOutput = {
  insertedRecords: number;
  insertedEntities: number;
  reusedRecords: number;
};

export type RunProviderOperationInput = {
  prisma?: PrismaClient;
  teamId: string;
  evidenceId: string;
  provider: MediaIntelligenceProvider;
  operation: ProviderAdapterOperation;
  initiatedByUserId?: string | null;
  caseId?: string | null;
  projectId?: string | null;
} & (
  | { byteSource: AdapterByteSource }
  | { text: string }
);

export type RunProviderOperationResult =
  | {
      ok: true;
      decision: ProviderBudgetDecision;
      insertedRecords: number;
      insertedEntities: number;
      extractedText: string | null;
    }
  | {
      ok: false;
      decision: ProviderBudgetDecision;
      reason: string;
    };

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

export async function ingestProviderResult(
  input: IngestProviderResultInput,
): Promise<IngestProviderResultOutput> {
  const prisma = input.prisma ?? defaultPrisma;
  if (!input.result.ok) {
    return { insertedRecords: 0, insertedEntities: 0, reusedRecords: 0 };
  }
  let insertedRecords = 0;
  let reusedRecords = 0;
  let insertedEntities = 0;
  for (const row of input.result.records) {
    const finalBand: IntelligenceConfidenceBand =
      classifyIntelligenceConfidence(row.providerConfidence);
    const record = await prisma.mediaIntelligenceRecord.upsert({
      where: {
        teamId_evidenceId_provider_providerRecordKey: {
          teamId: input.teamId,
          evidenceId: input.evidenceId,
          provider: input.provider,
          providerRecordKey: row.providerRecordKey,
        },
      },
      create: {
        teamId: input.teamId,
        evidenceId: input.evidenceId,
        modality: row.modality,
        kind: row.kind,
        provider: input.provider,
        providerConfidence: row.providerConfidence,
        providerConfidenceBand: row.providerConfidenceBand,
        finalConfidenceBand: finalBand,
        label: row.label,
        anchor: (row.anchor ?? null) as never,
        payload: row.payload as never,
        providerRecordKey: row.providerRecordKey,
      },
      update: {
        providerConfidence: row.providerConfidence,
        providerConfidenceBand: row.providerConfidenceBand,
        finalConfidenceBand: finalBand,
        label: row.label,
        anchor: (row.anchor ?? null) as never,
        payload: row.payload as never,
      },
      select: { id: true, createdAt: true },
    });
    // Detect insert vs update by comparing createdAt to "now within 1s".
    if (Date.now() - record.createdAt.getTime() < 5000) {
      insertedRecords += 1;
    } else {
      reusedRecords += 1;
    }
    // Persist the entity rows tied to this record.
    for (const e of input.result.entities) {
      await prisma.mediaIntelligenceEntity.create({
        data: {
          teamId: input.teamId,
          evidenceId: input.evidenceId,
          recordId: record.id,
          kind: e.kind,
          previewLabel: e.previewLabel,
          valueHash: e.valueHash,
          rawConfidence: e.rawConfidence,
          confidenceBand: e.confidenceBand,
          anchor: (e.anchor ?? null) as never,
        },
      });
      insertedEntities += 1;
    }
  }
  return { insertedRecords, insertedEntities, reusedRecords };
}

// ---------------------------------------------------------------------------
// Orchestrate
// ---------------------------------------------------------------------------

export async function runProviderOperation(
  input: RunProviderOperationInput,
): Promise<RunProviderOperationResult> {
  const prisma = input.prisma ?? defaultPrisma;
  const adapter: ProviderAdapter | null = getAdapter(input.provider);
  if (!adapter) {
    return {
      ok: false,
      decision: "ALLOW",
      reason: `provider_${input.provider}_not_registered`,
    };
  }
  if (!adapter.supportedOperations.includes(input.operation)) {
    return {
      ok: false,
      decision: "ALLOW",
      reason: `operation_${input.operation}_unsupported_by_${input.provider}`,
    };
  }
  // Phase P3 — canonical Workspace AI policy gate. The Settings toggles
  // (contentIntelligenceEnabled / ocrAllowed / transcriptionAllowed /
  // rawContentProcessingAllowed) are enforced HERE, before any provider
  // dispatch. On policy-table read failure (environment not yet migrated)
  // enforcement is skipped (legacy behavior); once the table exists, a
  // missing row means the safe defaults (content intelligence OFF).
  const wsPolicy = await resolveWorkspaceAiPolicy(input.teamId).catch(() => null);
  if (wsPolicy) {
    const isRawBytes = "byteSource" in input;
    const op = input.operation;
    const deny = (code: string): RunProviderOperationResult => ({
      ok: false,
      decision: "ALLOW",
      reason: `workspace_ai_policy_block:${code}`,
    });
    if (!wsPolicy.aiEnabled) return deny("WORKSPACE_DISABLED");
    if (!wsPolicy.contentIntelligenceEnabled) return deny("CONTENT_INTELLIGENCE_DISABLED");
    if (isRawBytes && !wsPolicy.rawContentProcessingAllowed) return deny("RAW_CONTENT_NOT_ALLOWED");
    if ((op === "OCR_IMAGE" || op === "OCR_DOCUMENT") && !wsPolicy.ocrAllowed) return deny("OCR_NOT_ALLOWED");
    if ((op === "TRANSCRIBE_AUDIO" || op === "TRANSCRIBE_VIDEO_AUDIO_TRACK") && !wsPolicy.transcriptionAllowed) {
      return deny("TRANSCRIPTION_NOT_ALLOWED");
    }
  }

  // Phase 4A Closure: evaluate intelligence policy before budget gate.
  const policyResult = await evaluateIntelligencePolicy({
    prisma,
    teamId: input.teamId,
    provider: input.provider,
    operation: input.operation,
    evidenceId: input.evidenceId,
  }).catch(() => null);
  if (policyResult?.decision === "BLOCK") {
    const reason = policyResult.reason ?? "intelligence_policy_block";
    await recordProviderUsage({
      prisma,
      teamId: input.teamId,
      provider: input.provider,
      operation: input.operation,
      unit: "CALL",
      units: 0,
      estimatedCostUsdMicros: 0,
      decision: "BLOCK",
      evidenceId: input.evidenceId,
      caseId: input.caseId ?? null,
      projectId: input.projectId ?? null,
      initiatedByUserId: input.initiatedByUserId ?? null,
      failureReason: reason,
    });
    await emitLifecycleEvent({
      prisma,
      teamId: input.teamId,
      code: "PROVIDER_CALL_REFUSED_POLICY",
      actorUserId: input.initiatedByUserId ?? null,
      evidenceId: input.evidenceId,
      caseId: input.caseId ?? null,
      projectId: input.projectId ?? null,
      provider: input.provider,
      operation: input.operation,
      reason,
    }).catch(() => {});
    return { ok: false, decision: "BLOCK" as const, reason };
  }

  /*
   * PLATFORM COMMERCIAL AUTHORITY CLOSURE (2026-09-07) — THE canonical AI
   * commercial gate, replacing this orchestrator's two packaging checks.
   *
   * What was here, and why it was wrong
   * ---------------------------------------------------------------------
   * `FEATURE_INTELLIGENCE` and `QUOTA_AI_OPERATIONS_PER_MONTH` were resolved
   * by the ProductLine packaging engine, which reads `entitlement_grants` and
   * falls back to hard-coded defaults. Its only writer is an operator-only
   * ProductLine route, so for every workspace that simply BOUGHT a plan both
   * answers were the unprovisioned defaults: the feature `false`, the quota
   * `25`. That made OCR and transcription commercially unreachable on every
   * self-serve plan, and capped a TEAM workspace sold 500 AI operations at 25
   * on the paths where the feature had been granted by hand.
   *
   * Neither key ever consulted the purchased plan, and each kept its own
   * usage counter — so the platform metered AI twice and agreed with itself
   * nowhere.
   *
   * What replaces it
   * ---------------------------------------------------------------------
   * ONE question, asked of ONE authority: `evaluateWorkspaceAiOperation`,
   * which resolves the WORKSPACE commercial subject through the canonical
   * envelope and applies contract-then-catalog precedence. `cap <= 0` is the
   * canonical statement of "this plan does not include AI", so the feature
   * boolean has no separate question left to answer.
   *
   * NOT REPLACED, AND DELIBERATELY LEFT ABOVE THIS: `evaluateWorkspaceAiPolicy`
   * (the workspace's own AI opt-out), `decideBudgetGate` (spend), and the
   * provider rate limits. A commercial allowance, a customer policy, a cost
   * ceiling and an abuse limit are four different questions; collapsing any of
   * them into this one is how the duplicate authority appeared in the first
   * place.
   */
  const aiAllowance = await evaluateWorkspaceAiOperation({
    teamId: input.teamId,
  });
  if (!aiAllowance.allowed) {
    const reason =
      aiAllowance.denial === "AI_NOT_INCLUDED"
        ? "entitlement_required:AI_NOT_INCLUDED"
        : aiAllowance.denial === "COMMERCIAL_LIFECYCLE_RESTRICTED"
          ? "entitlement_required:COMMERCIAL_LIFECYCLE_RESTRICTED"
          : "quota_exceeded:AI_MONTHLY_LIMIT_REACHED";
    await recordProviderUsage({
      prisma,
      teamId: input.teamId,
      provider: input.provider,
      operation: input.operation,
      unit: "CALL",
      units: 0,
      estimatedCostUsdMicros: 0,
      decision: "BLOCK",
      evidenceId: input.evidenceId,
      caseId: input.caseId ?? null,
      projectId: input.projectId ?? null,
      initiatedByUserId: input.initiatedByUserId ?? null,
      failureReason: reason,
    }).catch(() => {});
    return { ok: false, decision: "BLOCK" as const, reason };
  }

  // Best-effort cost estimate before the call — based on the adapter's
  // known unit pricing. The adapter returns the real cost on success;
  // the gate prevents runaway spend even when the heuristic is loose.
  const gate = await decideBudgetGate(
    {
      teamId: input.teamId,
      provider: input.provider,
      estimatedCostUsdMicros: estimatePreCallCostUsdMicros(input.provider),
      caseId: input.caseId ?? null,
      projectId: input.projectId ?? null,
    },
    prisma,
  );
  await emitLifecycleEvent({
    prisma,
    teamId: input.teamId,
    code: "PROVIDER_CALL_STARTED",
    actorUserId: input.initiatedByUserId ?? null,
    evidenceId: input.evidenceId,
    caseId: input.caseId ?? null,
    projectId: input.projectId ?? null,
    provider: input.provider,
    operation: input.operation,
  });
  if (gate.decision === "BLOCK") {
    await recordProviderUsage({
      prisma,
      teamId: input.teamId,
      provider: input.provider,
      operation: input.operation,
      unit: "CALL",
      units: 0,
      estimatedCostUsdMicros: 0,
      decision: "BLOCK",
      evidenceId: input.evidenceId,
      caseId: input.caseId ?? null,
      projectId: input.projectId ?? null,
      initiatedByUserId: input.initiatedByUserId ?? null,
      failureReason: gate.reason ?? "budget_block",
    });
    await emitLifecycleEvent({
      prisma,
      teamId: input.teamId,
      code: "PROVIDER_CALL_REFUSED_BUDGET",
      actorUserId: input.initiatedByUserId ?? null,
      evidenceId: input.evidenceId,
      caseId: input.caseId ?? null,
      projectId: input.projectId ?? null,
      provider: input.provider,
      operation: input.operation,
      budgetId: gate.budgetId ?? null,
      failureReason: gate.reason ?? "budget_block",
    });
    return {
      ok: false,
      decision: "BLOCK",
      reason: gate.reason ?? "budget_block",
    };
  }
  // Dispatch.
  let result: IntelligenceProviderResult;
  if ("text" in input) {
    if (input.operation === "EXTRACT_ENTITIES") {
      result = await (adapter.extractEntities!({ text: input.text }));
    } else if (input.operation === "SUMMARISE_DOCUMENT") {
      result = await (adapter.summariseDocument!({ text: input.text }));
    } else {
      return {
        ok: false,
        decision: "ALLOW",
        reason: `operation_${input.operation}_requires_byte_source`,
      };
    }
  } else {
    const bs = input.byteSource;
    switch (input.operation) {
      case "OCR_DOCUMENT":
        result = await adapter.ocrDocument!(bs);
        break;
      case "OCR_IMAGE":
        result = await adapter.ocrImage!(bs);
        break;
      case "TRANSCRIBE_AUDIO":
      case "TRANSCRIBE_VIDEO_AUDIO_TRACK":
        result = await adapter.transcribeAudio!(bs);
        break;
      case "DETECT_FACES":
        result = await adapter.detectFaces!(bs);
        break;
      case "DETECT_OBJECTS":
        result = await adapter.detectObjects!(bs);
        break;
      case "DETECT_TEXT_IN_IMAGE":
        result = await adapter.detectTextInImage!(bs);
        break;
      case "EXTRACT_ENTITIES":
      case "SUMMARISE_DOCUMENT":
        return {
          ok: false,
          decision: "ALLOW",
          reason: `operation_${input.operation}_requires_text`,
        };
    }
  }
  if (!result.ok) {
    await recordProviderUsage({
      prisma,
      teamId: input.teamId,
      provider: input.provider,
      operation: input.operation,
      unit: result.usage?.unit ?? "CALL",
      units: result.usage?.units ?? 0,
      estimatedCostUsdMicros: result.usage?.estimatedCostUsdMicros ?? 0,
      decision: gate.decision,
      evidenceId: input.evidenceId,
      caseId: input.caseId ?? null,
      projectId: input.projectId ?? null,
      initiatedByUserId: input.initiatedByUserId ?? null,
      failureReason: result.reason ?? null,
    });
    await emitLifecycleEvent({
      prisma,
      teamId: input.teamId,
      code: "PROVIDER_CALL_FAILED",
      actorUserId: input.initiatedByUserId ?? null,
      evidenceId: input.evidenceId,
      caseId: input.caseId ?? null,
      projectId: input.projectId ?? null,
      provider: input.provider,
      operation: input.operation,
      failureReason: result.reason ?? `provider_${input.provider}_failed`,
    });
    return {
      ok: false,
      decision: gate.decision,
      reason: result.reason ?? `provider_${input.provider}_failed`,
    };
  }
  // Ingest the records + entities.
  const ingest = await ingestProviderResult({
    prisma,
    teamId: input.teamId,
    evidenceId: input.evidenceId,
    provider: input.provider,
    result,
  });
  // Record the provider usage (real cost).
  await recordProviderUsage({
    prisma,
    teamId: input.teamId,
    provider: input.provider,
    operation: input.operation,
    unit: result.usage.unit,
    units: result.usage.units,
    estimatedCostUsdMicros: result.usage.estimatedCostUsdMicros,
    decision: gate.decision,
    evidenceId: input.evidenceId,
    caseId: input.caseId ?? null,
    projectId: input.projectId ?? null,
    initiatedByUserId: input.initiatedByUserId ?? null,
  });
  await emitLifecycleEvent({
    prisma,
    teamId: input.teamId,
    code: "PROVIDER_CALL_COMPLETED",
    actorUserId: input.initiatedByUserId ?? null,
    evidenceId: input.evidenceId,
    caseId: input.caseId ?? null,
    projectId: input.projectId ?? null,
    provider: input.provider,
    operation: input.operation,
    reason: `inserted=${ingest.insertedRecords}; reused=${ingest.reusedRecords}`,
  });
  // Emit a RECORD_INGESTED event per inserted record so the audit
  // centre + verification package can show every record's lifecycle.
  if (ingest.insertedRecords > 0) {
    await emitLifecycleEvent({
      prisma,
      teamId: input.teamId,
      code: "RECORD_INGESTED",
      actorUserId: input.initiatedByUserId ?? null,
      evidenceId: input.evidenceId,
      caseId: input.caseId ?? null,
      projectId: input.projectId ?? null,
      provider: input.provider,
      reason: `count=${ingest.insertedRecords}`,
    });
  }
  // PLATFORM COMMERCIAL AUTHORITY CLOSURE (2026-09-07) — record the spend on
  // THE canonical monthly counter (`ai_advisory_operations`), the same one the
  // gate above reads and the same one the AI routes increment. It used to
  // increment the packaging engine's private `QUOTA_AI_OPERATIONS_PER_MONTH`
  // counter, so a workspace's AI usage was split across two tallies and
  // neither was the month's real total. Fire-and-forget: a failed count must
  // never fail an operation the customer has already been given.
  if (aiAllowance.scope) {
    void recordWorkspaceAiOperation(aiAllowance.scope).catch(() => undefined);
  }
  return {
    ok: true,
    decision: gate.decision,
    insertedRecords: ingest.insertedRecords,
    insertedEntities: ingest.insertedEntities,
    extractedText: result.extractedText,
  };
}

// ---------------------------------------------------------------------------
// Projection helpers
// ---------------------------------------------------------------------------

export async function listRecordsForEvidence(input: {
  prisma?: PrismaClient;
  teamId: string;
  evidenceId: string;
  modality?: MediaIntelligenceModality;
  kind?: MediaIntelligenceRecordKind;
}): Promise<ReadonlyArray<MediaIntelligenceRecordProjection>> {
  const prisma = input.prisma ?? defaultPrisma;
  const rows = await prisma.mediaIntelligenceRecord.findMany({
    where: {
      teamId: input.teamId,
      evidenceId: input.evidenceId,
      ...(input.modality ? { modality: input.modality } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
    },
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { corrections: true } } },
  });
  return rows.map((r: (typeof rows)[number]) => ({
    id: r.id,
    evidenceId: r.evidenceId,
    modality: r.modality as MediaIntelligenceModality,
    kind: r.kind as MediaIntelligenceRecordKind,
    provider: r.provider as MediaIntelligenceProvider,
    state: r.state as MediaIntelligenceRecordState,
    providerConfidence: r.providerConfidence,
    providerConfidenceBand: r.providerConfidenceBand as IntelligenceConfidenceBand,
    reviewConfidenceBand: r.reviewConfidenceBand as IntelligenceConfidenceBand | null,
    finalConfidenceBand: r.finalConfidenceBand as IntelligenceConfidenceBand,
    label: r.label,
    anchor: r.anchor as Record<string, unknown> | null,
    createdAtUtc: r.createdAt.toISOString(),
    reviewedAtUtc: r.reviewedAt?.toISOString() ?? null,
    correctionCount: r._count.corrections,
  }));
}

export async function getRecordWithCorrections(input: {
  prisma?: PrismaClient;
  teamId: string;
  recordId: string;
}): Promise<
  | (MediaIntelligenceRecordProjection & {
      payload: Record<string, unknown>;
      corrections: ReadonlyArray<ReviewerCorrectionProjection>;
    })
  | null
> {
  const prisma = input.prisma ?? defaultPrisma;
  const r = await prisma.mediaIntelligenceRecord.findFirst({
    where: { id: input.recordId, teamId: input.teamId },
    include: {
      corrections: { orderBy: { createdAt: "asc" } },
      _count: { select: { corrections: true } },
    },
  });
  if (!r) return null;
  return {
    id: r.id,
    evidenceId: r.evidenceId,
    modality: r.modality as MediaIntelligenceModality,
    kind: r.kind as MediaIntelligenceRecordKind,
    provider: r.provider as MediaIntelligenceProvider,
    state: r.state as MediaIntelligenceRecordState,
    providerConfidence: r.providerConfidence,
    providerConfidenceBand: r.providerConfidenceBand as IntelligenceConfidenceBand,
    reviewConfidenceBand: r.reviewConfidenceBand as IntelligenceConfidenceBand | null,
    finalConfidenceBand: r.finalConfidenceBand as IntelligenceConfidenceBand,
    label: r.label,
    anchor: r.anchor as Record<string, unknown> | null,
    createdAtUtc: r.createdAt.toISOString(),
    reviewedAtUtc: r.reviewedAt?.toISOString() ?? null,
    correctionCount: r._count.corrections,
    payload: r.payload as Record<string, unknown>,
    corrections: r.corrections.map((c: (typeof r.corrections)[number]) => ({
      id: c.id,
      recordId: c.recordId,
      kind: c.kind as never,
      state: c.state as never,
      patch: c.patch as Record<string, unknown>,
      rationale: c.rationale,
      authoredByUserId: c.authoredByUserId,
      acceptedByUserId: c.acceptedByUserId,
      createdAtUtc: c.createdAt.toISOString(),
      acceptedAtUtc: c.acceptedAt?.toISOString() ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Bounded pre-call cost heuristic — adapter returns the real cost on success.
// ---------------------------------------------------------------------------

function estimatePreCallCostUsdMicros(provider: MediaIntelligenceProvider): number {
  switch (provider) {
    case "AZURE_DOCUMENT_INTELLIGENCE":
      return 1500;
    case "DEEPGRAM_TRANSCRIPT":
      return 5000;
    case "AWS_REKOGNITION_FACES":
    case "AWS_REKOGNITION_TEXT":
    case "AWS_REKOGNITION_LABELS":
      return 1000;
    // Phase F-8 — LOCAL_* are the values written going forward; the legacy
    // OPENAI_* labels stay readable until the value-rename migration runs.
    case "LOCAL_ENTITY_EXTRACTION":
    case "LOCAL_DOCUMENT_SUMMARY":
    case "OPENAI_ENTITY_EXTRACTION":
    case "OPENAI_DOCUMENT_SUMMARY":
      return 3000;
    case "MANUAL_OPERATOR":
      return 0;
  }
}

// Re-export the adapter result rows used by tests + bridge code.
export type { AdapterRecordRow, AdapterEntityRow };
