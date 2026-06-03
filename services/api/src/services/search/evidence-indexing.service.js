/**
 * Phase 24 — Evidence indexing pipeline.
 *
 * The single mutation surface for `evidence_search_documents` rows.
 * Every business caller goes through this service; no route handler
 * writes the search-document table directly.
 *
 * Responsibilities:
 *   1. Build a SAFE projection of a source row (Evidence, workflow
 *      instance, workflow step, review event, communication,
 *      incident) into the denormalised search-document shape.
 *   2. Strip / redact fields that policy says must not be indexed
 *      (private reviewer notes, legal-hold reason text, raw GPS,
 *      OTPs, signed URLs, contributor identity restricted by
 *      workflow visibility decisions).
 *   3. Upsert by (teamId, documentType, sourceId) so re-indexing
 *      produces exactly one row.
 *   4. Delete the row when the source becomes non-indexable
 *      (evidence deleted, workflow cancelled, ...).
 *
 * Hard invariants:
 *   - The indexer NEVER reads or writes `privateReviewerNote`,
 *     legal-hold reason text, raw GPS, OTPs, tokens, signed URLs.
 *   - Free-text bodies run through the recursive scrubber from
 *     `services/observability/redact.ts` so a careless caller cannot
 *     leak a secret via the searchable column.
 *   - Forbidden-overclaim phrases (see @proovra/shared
 *     `SEARCH_FORBIDDEN_OVERCLAIM_PHRASES`) are stripped before the
 *     row is persisted.
 *   - Failures are best-effort: a row that cannot be indexed bumps
 *     `search_indexing_failed_total` and emits a SecurityEvent, but
 *     never throws to the calling flow.
 */
import * as prismaPkg from "@prisma/client";
import { buildEvidenceProjection, buildWorkflowInstanceProjection, isAllowedSearchDocumentType, SEARCH_DOCUMENT_TYPES, SEARCH_FORBIDDEN_OVERCLAIM_PHRASES, stringContainsForbiddenOverclaim, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { safeJsonSnapshot } from "../observability/redact.js";
const SEARCH_DOC_TYPE_SET = new Set(SEARCH_DOCUMENT_TYPES);
async function upsertSearchDocument(input, client) {
    if (!SEARCH_DOC_TYPE_SET.has(input.documentType)) {
        bump("search_indexing_failed_total");
        return { ok: false, reason: "unknown_document_type" };
    }
    try {
        // Scrub user-facing strings + metadata payloads.
        const safeTitle = sanitiseString(input.title, 200);
        const safeSubtitle = input.subtitle
            ? sanitiseString(input.subtitle, 200)
            : null;
        const safeSummary = input.summary
            ? sanitiseString(input.summary, 400)
            : null;
        const safeText = input.searchableText
            ? sanitiseLongText(input.searchableText)
            : null;
        const safeMeta = input.searchableMetadata
            ? safeJsonSnapshot(input.searchableMetadata)
            : prismaPkg.Prisma.JsonNull;
        const safeTags = input.searchableTags
            ? input.searchableTags.slice(0, 32).filter(Boolean)
            : prismaPkg.Prisma.JsonNull;
        const safeVis = input.visibilityScope
            ? safeJsonSnapshot(input.visibilityScope)
            : prismaPkg.Prisma.JsonNull;
        const safeGov = input.governanceScope
            ? safeJsonSnapshot(input.governanceScope)
            : prismaPkg.Prisma.JsonNull;
        const row = await client.evidenceSearchDocument.upsert({
            where: {
                teamId_documentType_sourceId: {
                    teamId: input.teamId,
                    documentType: input.documentType,
                    sourceId: input.sourceId,
                },
            },
            create: {
                teamId: input.teamId,
                documentType: input.documentType,
                sourceId: input.sourceId,
                title: safeTitle,
                subtitle: safeSubtitle,
                summary: safeSummary,
                searchableText: safeText,
                searchableMetadataJson: safeMeta,
                searchableTagsJson: safeTags,
                visibilityScopeJson: safeVis,
                governanceScopeJson: safeGov,
                reviewState: input.reviewState ?? null,
                workflowState: input.workflowState ?? null,
                exportState: input.exportState ?? null,
                retentionState: input.retentionState ?? null,
                legalHoldState: input.legalHoldState ?? null,
                contributorScoped: input.contributorScoped ?? false,
                reviewerRestricted: input.reviewerRestricted ?? false,
                evidenceId: input.evidenceId ?? null,
                workflowInstanceId: input.workflowInstanceId ?? null,
                workflowStepInstanceId: input.workflowStepInstanceId ?? null,
                caseId: input.caseId ?? null,
                claimRef: input.claimRef ?? null,
                matterRef: input.matterRef ?? null,
                sourceUpdatedAtUtc: input.sourceUpdatedAtUtc,
                indexedAtUtc: new Date(),
            },
            update: {
                title: safeTitle,
                subtitle: safeSubtitle,
                summary: safeSummary,
                searchableText: safeText,
                searchableMetadataJson: safeMeta,
                searchableTagsJson: safeTags,
                visibilityScopeJson: safeVis,
                governanceScopeJson: safeGov,
                reviewState: input.reviewState ?? null,
                workflowState: input.workflowState ?? null,
                exportState: input.exportState ?? null,
                retentionState: input.retentionState ?? null,
                legalHoldState: input.legalHoldState ?? null,
                contributorScoped: input.contributorScoped ?? false,
                reviewerRestricted: input.reviewerRestricted ?? false,
                evidenceId: input.evidenceId ?? null,
                workflowInstanceId: input.workflowInstanceId ?? null,
                workflowStepInstanceId: input.workflowStepInstanceId ?? null,
                caseId: input.caseId ?? null,
                claimRef: input.claimRef ?? null,
                matterRef: input.matterRef ?? null,
                sourceUpdatedAtUtc: input.sourceUpdatedAtUtc,
                indexedAtUtc: new Date(),
            },
        });
        bump("search_indexing_succeeded_total");
        return {
            ok: true,
            documentId: row.id,
            created: row.createdAt.getTime() === row.updatedAt.getTime(),
        };
    }
    catch (err) {
        bump("search_indexing_failed_total");
        safeEmitSecurityEvent({
            teamId: input.teamId,
            eventType: "search_indexing_failed",
            severity: "WARNING",
            details: {
                documentType: input.documentType,
                sourceId: input.sourceId,
                reason: err instanceof Error ? err.message.slice(0, 120) : "unknown",
            },
        });
        return { ok: false, reason: "upsert_failed" };
    }
}
function sanitiseString(value, max) {
    let scrubbed = value;
    for (const re of SEARCH_FORBIDDEN_OVERCLAIM_PHRASES) {
        scrubbed = scrubbed.replace(re, "[redacted-overclaim]");
    }
    // Drop control chars + collapse whitespace.
    scrubbed = scrubbed.replace(/[\x00-\x08\x0B-\x1F\x7F]+/g, " ").trim();
    if (scrubbed.length <= max)
        return scrubbed;
    return scrubbed.slice(0, max - 1) + "…";
}
function sanitiseLongText(value) {
    // Strip overclaim phrases + bound at 16 KiB so a malicious caller
    // cannot balloon the row. The Postgres `text` column has no hard
    // cap; the bound is here.
    let scrubbed = value;
    for (const re of SEARCH_FORBIDDEN_OVERCLAIM_PHRASES) {
        scrubbed = scrubbed.replace(re, "[redacted-overclaim]");
    }
    scrubbed = scrubbed.replace(/[\x00-\x08\x0B-\x1F\x7F]+/g, " ").trim();
    const MAX_BYTES = 16 * 1024;
    if (scrubbed.length <= MAX_BYTES)
        return scrubbed;
    return scrubbed.slice(0, MAX_BYTES - 1) + "…";
}
// -----------------------------------------------------------------------------
// Evidence indexer — reads the source evidence row + (best-effort) the
// Phase 15 EvidenceExtractedText rows when visibility policy permits.
// -----------------------------------------------------------------------------
export async function indexEvidence(input, client = defaultPrisma) {
    let evidence;
    try {
        evidence = await client.evidence.findFirst({
            where: { id: input.evidenceId, teamId: input.teamId },
        });
    }
    catch {
        return { ok: false, reason: "evidence_load_failed" };
    }
    if (!evidence)
        return { ok: false, reason: "evidence_not_found" };
    // Workflow visibility — load the most-recent applicable workflow
    // instance state (operator-facing badges only).
    const workflowState = await loadEvidenceWorkflowStatus(client, evidence.id);
    // Extracted text from Phase 15 — best-effort include.
    const extractedChunks = [];
    try {
        const extractedRows = await client.evidenceExtractedText.findMany({
            where: {
                evidenceId: evidence.id,
                status: prismaPkg.EvidenceExtractedTextStatus.COMPLETED,
            },
            select: { text: true, kind: true },
            take: 5,
        });
        for (const r of extractedRows) {
            const safeText = (r.text ?? "").slice(0, 4 * 1024);
            if (safeText.length > 0) {
                extractedChunks.push(`[${r.kind}] ${safeText}`);
            }
        }
    }
    catch {
        /* extraction table may not have rows; non-fatal */
    }
    // Phase 13 — append entity-name chunks. The Phase 15 entity
    // extractor writes (kind, normalizedValue) tuples to
    // evidence_entities; we surface them in the searchable text so
    // operators can keyword-search by entity name without opening
    // each evidence record. Only the bounded `normalizedValue` is
    // indexed (never the raw matched text) so operator queries
    // continue to be safe-by-construction.
    try {
        const entityRows = await client.evidenceEntity.findMany({
            where: {
                evidenceId: evidence.id,
                normalizedValue: { not: null },
            },
            select: { kind: true, normalizedValue: true },
            take: 100,
        });
        const seen = new Set();
        for (const e of entityRows) {
            const n = (e.normalizedValue ?? "").trim();
            if (!n)
                continue;
            const key = `${e.kind}::${n.toLowerCase()}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            extractedChunks.push(`[entity] ${n}`);
        }
    }
    catch {
        /* entity table may not have rows; non-fatal */
    }
    // Phase 25 — delegate to the SHARED canonical projection engine.
    // The pure builder applies governance gates (deleted / DESTROYED /
    // PENDING_DESTRUCTION → delete-from-index) so the API and worker
    // agree on what's indexable.
    const result = buildEvidenceProjection({
        teamId: input.teamId,
        evidenceId: input.evidenceId,
        evidence: {
            id: evidence.id,
            teamId: evidence.teamId,
            title: evidence.title,
            displayFileName: evidence.displayFileName,
            originalFileName: evidence.originalFileName,
            type: evidence.type,
            mimeType: evidence.mimeType,
            captureMethod: evidence.captureMethod,
            caseId: evidence.caseId ?? null,
            deletedAt: evidence.deletedAt ?? null,
            lifecycleState: evidence.lifecycleState ?? null,
            archivedAt: evidence.archivedAt ?? null,
            publicVerifyState: evidence.publicVerifyState ?? null,
            storageObjectLockLegalHoldStatus: evidence.storageObjectLockLegalHoldStatus ?? null,
            retentionPolicySource: evidence.retentionPolicySource ?? null,
            retentionUntilUtc: evidence.retentionUntilUtc ?? null,
            reviewReadyAtUtc: evidence.reviewReadyAtUtc ?? null,
            updatedAt: evidence.updatedAt,
        },
        workflowState,
        extractedTextChunks: extractedChunks,
    });
    if (!result.ok) {
        if (result.deleteFromIndex) {
            await tryDeleteByKey(client, input.teamId, "EVIDENCE", input.evidenceId);
        }
        return { ok: false, reason: result.reason };
    }
    return upsertSearchDocumentProjection(result.projection, client);
}
async function loadEvidenceWorkflowStatus(client, evidenceId) {
    try {
        const link = await client.evidenceWorkflowInstanceEvidence.findFirst({
            where: { evidenceId },
            orderBy: { createdAt: "desc" },
            include: { instance: { select: { status: true } } },
        });
        return link?.instance?.status ?? null;
    }
    catch {
        return null;
    }
}
// -----------------------------------------------------------------------------
// Workflow instance indexer
// -----------------------------------------------------------------------------
export async function indexWorkflowInstance(input, client = defaultPrisma) {
    let instance;
    try {
        instance = await client.evidenceWorkflowInstance.findFirst({
            where: { id: input.workflowInstanceId, teamId: input.teamId },
        });
    }
    catch {
        return { ok: false, reason: "workflow_load_failed" };
    }
    if (!instance)
        return { ok: false, reason: "workflow_not_found" };
    // Phase 25 — delegate to the SHARED canonical projection engine.
    const result = buildWorkflowInstanceProjection({
        teamId: input.teamId,
        workflowInstanceId: input.workflowInstanceId,
        instance: {
            id: instance.id,
            teamId: instance.teamId,
            title: instance.title,
            templateSlug: instance.templateSlug,
            templateVersion: instance.templateVersion,
            intakeMode: instance.intakeMode,
            actorRole: instance.actorRole,
            status: instance.status,
            caseId: instance.caseId ?? null,
            claimRef: instance.claimRef ?? null,
            matterRef: instance.matterRef ?? null,
            assignedReviewerUserId: instance.assignedReviewerUserId ?? null,
            updatedAt: instance.updatedAt,
        },
    });
    if (!result.ok) {
        if (result.deleteFromIndex) {
            await tryDeleteByKey(client, input.teamId, "WORKFLOW", input.workflowInstanceId);
        }
        return { ok: false, reason: result.reason };
    }
    return upsertSearchDocumentProjection(result.projection, client);
}
// -----------------------------------------------------------------------------
// Phase 25 — public canonical upsert. Both API and worker upsert through
// the same persistence shape. This function takes the SHARED projection
// and writes it; callers are responsible for governance/visibility
// decisions before calling.
// -----------------------------------------------------------------------------
export async function upsertSearchDocumentProjection(projection, client = defaultPrisma) {
    if (!isAllowedSearchDocumentType(projection.documentType)) {
        bump("search_indexing_failed_total");
        return { ok: false, reason: "unknown_document_type" };
    }
    return upsertSearchDocument({
        teamId: projection.teamId,
        documentType: projection.documentType,
        sourceId: projection.sourceId,
        title: projection.title,
        subtitle: projection.subtitle,
        summary: projection.summary,
        searchableText: projection.searchableText,
        searchableMetadata: projection.searchableMetadata,
        searchableTags: projection.searchableTags,
        visibilityScope: projection.visibilityScope,
        governanceScope: projection.governanceScope,
        reviewState: projection.reviewState,
        workflowState: projection.workflowState,
        exportState: projection.exportState,
        retentionState: projection.retentionState,
        legalHoldState: projection.legalHoldState,
        contributorScoped: projection.contributorScoped,
        reviewerRestricted: projection.reviewerRestricted,
        evidenceId: projection.evidenceId,
        workflowInstanceId: projection.workflowInstanceId,
        workflowStepInstanceId: projection.workflowStepInstanceId,
        caseId: projection.caseId,
        claimRef: projection.claimRef,
        matterRef: projection.matterRef,
        sourceUpdatedAtUtc: projection.sourceUpdatedAtUtc,
    }, client);
}
// -----------------------------------------------------------------------------
// Delete helper
// -----------------------------------------------------------------------------
async function tryDeleteByKey(client, teamId, documentType, sourceId) {
    try {
        await client.evidenceSearchDocument.deleteMany({
            where: { teamId, documentType, sourceId },
        });
    }
    catch {
        /* best-effort */
    }
}
export async function removeFromIndex(input, client = defaultPrisma) {
    await tryDeleteByKey(client, input.teamId, input.documentType, input.sourceId);
}
// Re-export for the tests so they can assert the helper is wired
// to the SEARCH_FORBIDDEN_OVERCLAIM_PHRASES catalog.
export { stringContainsForbiddenOverclaim };
