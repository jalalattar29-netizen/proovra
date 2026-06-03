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
import { classifyIntelligenceConfidence, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { getAdapter, } from "./providers/provider-adapter.js";
import { decideBudgetGate } from "./provider-budget.service.js";
import { recordProviderUsage } from "./provider-usage.service.js";
import { emitLifecycleEvent } from "./intelligence-activity.service.js";
import { evaluateIntelligencePolicy } from "../governance/policy-evaluation.service.js";
import { assertFeatureEntitlement, assertQuotaEntitlement, recordEntitlementUsage, } from "../packaging/entitlement.service.js";
// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------
export async function ingestProviderResult(input) {
    const prisma = input.prisma ?? defaultPrisma;
    if (!input.result.ok) {
        return { insertedRecords: 0, insertedEntities: 0, reusedRecords: 0 };
    }
    let insertedRecords = 0;
    let reusedRecords = 0;
    let insertedEntities = 0;
    for (const row of input.result.records) {
        const finalBand = classifyIntelligenceConfidence(row.providerConfidence);
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
                anchor: (row.anchor ?? null),
                payload: row.payload,
                providerRecordKey: row.providerRecordKey,
            },
            update: {
                providerConfidence: row.providerConfidence,
                providerConfidenceBand: row.providerConfidenceBand,
                finalConfidenceBand: finalBand,
                label: row.label,
                anchor: (row.anchor ?? null),
                payload: row.payload,
            },
            select: { id: true, createdAt: true },
        });
        // Detect insert vs update by comparing createdAt to "now within 1s".
        if (Date.now() - record.createdAt.getTime() < 5000) {
            insertedRecords += 1;
        }
        else {
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
                    anchor: (e.anchor ?? null),
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
export async function runProviderOperation(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const adapter = getAdapter(input.provider);
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
        }).catch(() => { });
        return { ok: false, decision: "BLOCK", reason };
    }
    // Phase 4B — entitlement perimeter. Enforced BEFORE the budget engine
    // because budget is a spend-decider; entitlements are the product-line
    // gate. Wrapped in try/catch so engine failure NEVER replaces existing
    // budget logic (advisory). When the perimeter denies, we record the
    // refusal as a budget BLOCK-shaped outcome so downstream UI behaves
    // identically to a budget block (single failure code path).
    try {
        const featureOk = await assertFeatureEntitlement({
            prisma,
            teamId: input.teamId,
            key: "FEATURE_INTELLIGENCE",
        });
        if (!featureOk.ok) {
            const reason = "entitlement_required:FEATURE_INTELLIGENCE";
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
            }).catch(() => { });
            return { ok: false, decision: "BLOCK", reason };
        }
        const quotaOk = await assertQuotaEntitlement({
            prisma,
            teamId: input.teamId,
            key: "QUOTA_AI_OPERATIONS_PER_MONTH",
            requested: 1,
        });
        if (!quotaOk.ok) {
            const reason = "quota_exceeded:QUOTA_AI_OPERATIONS_PER_MONTH";
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
            }).catch(() => { });
            return { ok: false, decision: "BLOCK", reason };
        }
    }
    catch {
        // Entitlement gate engine error is advisory — fall through to budget.
    }
    // Best-effort cost estimate before the call — based on the adapter's
    // known unit pricing. The adapter returns the real cost on success;
    // the gate prevents runaway spend even when the heuristic is loose.
    const gate = await decideBudgetGate({
        teamId: input.teamId,
        provider: input.provider,
        estimatedCostUsdMicros: estimatePreCallCostUsdMicros(input.provider),
        caseId: input.caseId ?? null,
        projectId: input.projectId ?? null,
    }, prisma);
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
    let result;
    if ("text" in input) {
        if (input.operation === "EXTRACT_ENTITIES") {
            result = await (adapter.extractEntities({ text: input.text }));
        }
        else if (input.operation === "SUMMARISE_DOCUMENT") {
            result = await (adapter.summariseDocument({ text: input.text }));
        }
        else {
            return {
                ok: false,
                decision: "ALLOW",
                reason: `operation_${input.operation}_requires_byte_source`,
            };
        }
    }
    else {
        const bs = input.byteSource;
        switch (input.operation) {
            case "OCR_DOCUMENT":
                result = await adapter.ocrDocument(bs);
                break;
            case "OCR_IMAGE":
                result = await adapter.ocrImage(bs);
                break;
            case "TRANSCRIBE_AUDIO":
            case "TRANSCRIBE_VIDEO_AUDIO_TRACK":
                result = await adapter.transcribeAudio(bs);
                break;
            case "DETECT_FACES":
                result = await adapter.detectFaces(bs);
                break;
            case "DETECT_OBJECTS":
                result = await adapter.detectObjects(bs);
                break;
            case "DETECT_TEXT_IN_IMAGE":
                result = await adapter.detectTextInImage(bs);
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
    // Phase 4B — fire-and-forget quota usage recording on successful op.
    void recordEntitlementUsage({
        prisma,
        teamId: input.teamId,
        key: "QUOTA_AI_OPERATIONS_PER_MONTH",
        amount: 1,
    }).catch(() => undefined);
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
export async function listRecordsForEvidence(input) {
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
    return rows.map((r) => ({
        id: r.id,
        evidenceId: r.evidenceId,
        modality: r.modality,
        kind: r.kind,
        provider: r.provider,
        state: r.state,
        providerConfidence: r.providerConfidence,
        providerConfidenceBand: r.providerConfidenceBand,
        reviewConfidenceBand: r.reviewConfidenceBand,
        finalConfidenceBand: r.finalConfidenceBand,
        label: r.label,
        anchor: r.anchor,
        createdAtUtc: r.createdAt.toISOString(),
        reviewedAtUtc: r.reviewedAt?.toISOString() ?? null,
        correctionCount: r._count.corrections,
    }));
}
export async function getRecordWithCorrections(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const r = await prisma.mediaIntelligenceRecord.findFirst({
        where: { id: input.recordId, teamId: input.teamId },
        include: {
            corrections: { orderBy: { createdAt: "asc" } },
            _count: { select: { corrections: true } },
        },
    });
    if (!r)
        return null;
    return {
        id: r.id,
        evidenceId: r.evidenceId,
        modality: r.modality,
        kind: r.kind,
        provider: r.provider,
        state: r.state,
        providerConfidence: r.providerConfidence,
        providerConfidenceBand: r.providerConfidenceBand,
        reviewConfidenceBand: r.reviewConfidenceBand,
        finalConfidenceBand: r.finalConfidenceBand,
        label: r.label,
        anchor: r.anchor,
        createdAtUtc: r.createdAt.toISOString(),
        reviewedAtUtc: r.reviewedAt?.toISOString() ?? null,
        correctionCount: r._count.corrections,
        payload: r.payload,
        corrections: r.corrections.map((c) => ({
            id: c.id,
            recordId: c.recordId,
            kind: c.kind,
            state: c.state,
            patch: c.patch,
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
function estimatePreCallCostUsdMicros(provider) {
    switch (provider) {
        case "AZURE_DOCUMENT_INTELLIGENCE":
            return 1500;
        case "DEEPGRAM_TRANSCRIPT":
            return 5000;
        case "AWS_REKOGNITION_FACES":
        case "AWS_REKOGNITION_TEXT":
        case "AWS_REKOGNITION_LABELS":
            return 1000;
        case "OPENAI_ENTITY_EXTRACTION":
        case "OPENAI_DOCUMENT_SUMMARY":
            return 3000;
        case "MANUAL_OPERATOR":
            return 0;
    }
}
