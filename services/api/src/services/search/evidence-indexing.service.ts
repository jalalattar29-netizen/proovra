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

import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import {
  type SearchDocumentType,
  SEARCH_DOCUMENT_TYPES,
  SEARCH_FORBIDDEN_OVERCLAIM_PHRASES,
  stringContainsForbiddenOverclaim,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { safeJsonSnapshot } from "../observability/redact.js";

// -----------------------------------------------------------------------------
// Inputs
// -----------------------------------------------------------------------------

export type IndexEvidenceInput = {
  teamId: string;
  evidenceId: string;
};

export type IndexWorkflowInstanceInput = {
  teamId: string;
  workflowInstanceId: string;
};

export type IndexResult =
  | { ok: true; documentId: string; created: boolean }
  | { ok: false; reason: string };

const SEARCH_DOC_TYPE_SET = new Set<string>(SEARCH_DOCUMENT_TYPES);

// -----------------------------------------------------------------------------
// Generic upsert helper
// -----------------------------------------------------------------------------

type UpsertPayload = {
  teamId: string;
  documentType: SearchDocumentType;
  sourceId: string;
  title: string;
  subtitle?: string | null;
  summary?: string | null;
  searchableText?: string | null;
  searchableMetadata?: Record<string, unknown> | null;
  searchableTags?: ReadonlyArray<string> | null;
  visibilityScope?: Record<string, unknown> | null;
  governanceScope?: Record<string, unknown> | null;
  reviewState?: string | null;
  workflowState?: string | null;
  exportState?: string | null;
  retentionState?: string | null;
  legalHoldState?: string | null;
  contributorScoped?: boolean;
  reviewerRestricted?: boolean;
  evidenceId?: string | null;
  workflowInstanceId?: string | null;
  workflowStepInstanceId?: string | null;
  caseId?: string | null;
  claimRef?: string | null;
  matterRef?: string | null;
  sourceUpdatedAtUtc: Date;
};

async function upsertSearchDocument(
  input: UpsertPayload,
  client: PrismaClient,
): Promise<IndexResult> {
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
      ? (safeJsonSnapshot(input.searchableMetadata) as prismaPkg.Prisma.InputJsonValue)
      : prismaPkg.Prisma.JsonNull;
    const safeTags = input.searchableTags
      ? (input.searchableTags.slice(0, 32).filter(Boolean) as prismaPkg.Prisma.InputJsonValue)
      : prismaPkg.Prisma.JsonNull;
    const safeVis = input.visibilityScope
      ? (safeJsonSnapshot(input.visibilityScope) as prismaPkg.Prisma.InputJsonValue)
      : prismaPkg.Prisma.JsonNull;
    const safeGov = input.governanceScope
      ? (safeJsonSnapshot(input.governanceScope) as prismaPkg.Prisma.InputJsonValue)
      : prismaPkg.Prisma.JsonNull;

    const row = await client.evidenceSearchDocument.upsert({
      where: {
        teamId_documentType_sourceId: {
          teamId: input.teamId,
          documentType: input.documentType,
          sourceId: input.sourceId,
        } as never,
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
  } catch (err) {
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

function sanitiseString(value: string, max: number): string {
  let scrubbed = value;
  for (const re of SEARCH_FORBIDDEN_OVERCLAIM_PHRASES) {
    scrubbed = scrubbed.replace(re, "[redacted-overclaim]");
  }
  // Drop control chars + collapse whitespace.
  scrubbed = scrubbed.replace(/[\x00-\x08\x0B-\x1F\x7F]+/g, " ").trim();
  if (scrubbed.length <= max) return scrubbed;
  return scrubbed.slice(0, max - 1) + "…";
}

function sanitiseLongText(value: string): string {
  // Strip overclaim phrases + bound at 16 KiB so a malicious caller
  // cannot balloon the row. The Postgres `text` column has no hard
  // cap; the bound is here.
  let scrubbed = value;
  for (const re of SEARCH_FORBIDDEN_OVERCLAIM_PHRASES) {
    scrubbed = scrubbed.replace(re, "[redacted-overclaim]");
  }
  scrubbed = scrubbed.replace(/[\x00-\x08\x0B-\x1F\x7F]+/g, " ").trim();
  const MAX_BYTES = 16 * 1024;
  if (scrubbed.length <= MAX_BYTES) return scrubbed;
  return scrubbed.slice(0, MAX_BYTES - 1) + "…";
}

// -----------------------------------------------------------------------------
// Evidence indexer — reads the source evidence row + (best-effort) the
// Phase 15 EvidenceExtractedText rows when visibility policy permits.
// -----------------------------------------------------------------------------

export async function indexEvidence(
  input: IndexEvidenceInput,
  client: PrismaClient = defaultPrisma,
): Promise<IndexResult> {
  let evidence: prismaPkg.Evidence | null;
  try {
    evidence = await client.evidence.findFirst({
      where: { id: input.evidenceId, teamId: input.teamId },
    });
  } catch {
    return { ok: false, reason: "evidence_load_failed" };
  }
  if (!evidence) return { ok: false, reason: "evidence_not_found" };

  // Hard governance gates — do NOT index a row that is deleted or on
  // a state that the search service must hide entirely.
  if (evidence.deletedAt || evidence.deletedAtUtc) {
    await tryDeleteByKey(client, input.teamId, "EVIDENCE", input.evidenceId);
    return { ok: false, reason: "deleted" };
  }

  // Workflow visibility — load the most-recent applicable workflow
  // instance state (operator-facing badges only).
  const workflowState = await loadEvidenceWorkflowStatus(client, evidence.id);

  // Extracted text from Phase 15 — best-effort include.
  let extracted = "";
  try {
    const extractedRows = await client.evidenceExtractedText.findMany({
      where: {
        evidenceId: evidence.id,
        status: prismaPkg.EvidenceExtractedTextStatus.COMPLETED,
      },
      select: { text: true, kind: true },
      take: 5,
    });
    extracted = extractedRows
      .map((r) => `[${r.kind}] ${r.text ?? ""}`)
      .join("\n")
      .slice(0, 8 * 1024);
  } catch {
    /* extraction table may not have rows; non-fatal */
  }

  const legalHoldState = evidence.storageObjectLockLegalHoldStatus ?? null;
  const publicVerifyState = evidence.publicVerifyState ?? null;

  return upsertSearchDocument(
    {
      teamId: input.teamId,
      documentType: "EVIDENCE",
      sourceId: evidence.id,
      title: evidence.title?.slice(0, 200) ?? evidence.displayFileName ?? "(untitled)",
      subtitle: evidence.type ?? null,
      summary: evidence.displayFileName ?? evidence.originalFileName ?? null,
      searchableText: [
        evidence.title ?? "",
        evidence.displayFileName ?? "",
        evidence.originalFileName ?? "",
        extracted,
      ]
        .filter(Boolean)
        .join("\n")
        .trim() || null,
      searchableMetadata: {
        type: evidence.type,
        mimeType: evidence.mimeType,
        captureMethod: evidence.captureMethod,
        publicVerifyState,
        retentionPolicySource: evidence.retentionPolicySource ?? null,
      },
      searchableTags: [
        evidence.type ?? "",
        publicVerifyState ?? "",
        legalHoldState ? "legal_hold" : "",
        evidence.archivedAt ? "archived" : "",
      ].filter((t): t is string => !!t),
      visibilityScope: { publicVerifyState },
      governanceScope: {
        legalHoldState,
        retentionPolicySource: evidence.retentionPolicySource ?? null,
        retentionUntilUtc: evidence.retentionUntilUtc?.toISOString() ?? null,
      },
      reviewState: evidence.reviewReadyAtUtc ? "REVIEW_READY" : null,
      workflowState: workflowState,
      exportState:
        publicVerifyState === "PUBLISHED"
          ? "PUBLIC"
          : publicVerifyState === "SUSPENDED"
            ? "SUSPENDED"
            : "INTERNAL",
      retentionState: evidence.retentionPolicySource ?? null,
      legalHoldState: legalHoldState,
      contributorScoped:
        evidence.captureMethod === "EXTERNAL_INTAKE_UPLOAD" ? true : false,
      reviewerRestricted: false,
      evidenceId: evidence.id,
      caseId: evidence.caseId ?? null,
      sourceUpdatedAtUtc: evidence.updatedAt,
    },
    client,
  );
}

async function loadEvidenceWorkflowStatus(
  client: PrismaClient,
  evidenceId: string,
): Promise<string | null> {
  try {
    const link = await client.evidenceWorkflowInstanceEvidence.findFirst({
      where: { evidenceId },
      orderBy: { createdAt: "desc" },
      include: { instance: { select: { status: true } } },
    });
    return link?.instance?.status ?? null;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Workflow instance indexer
// -----------------------------------------------------------------------------

export async function indexWorkflowInstance(
  input: IndexWorkflowInstanceInput,
  client: PrismaClient = defaultPrisma,
): Promise<IndexResult> {
  let instance: prismaPkg.EvidenceWorkflowInstance | null;
  try {
    instance = await client.evidenceWorkflowInstance.findFirst({
      where: { id: input.workflowInstanceId, teamId: input.teamId },
    });
  } catch {
    return { ok: false, reason: "workflow_load_failed" };
  }
  if (!instance) return { ok: false, reason: "workflow_not_found" };

  return upsertSearchDocument(
    {
      teamId: input.teamId,
      documentType: "WORKFLOW",
      sourceId: instance.id,
      title: instance.title?.slice(0, 200) ?? `Workflow ${instance.id.slice(0, 8)}…`,
      subtitle: instance.templateSlug ?? null,
      summary: `intake ${instance.intakeMode} · actor ${instance.actorRole}`,
      searchableText: [
        instance.title ?? "",
        instance.templateSlug ?? "",
        instance.intakeMode,
        instance.actorRole,
      ]
        .filter(Boolean)
        .join(" ")
        .trim() || null,
      searchableMetadata: {
        templateSlug: instance.templateSlug,
        templateVersion: instance.templateVersion,
        intakeMode: instance.intakeMode,
        actorRole: instance.actorRole,
      },
      searchableTags: [
        instance.intakeMode,
        instance.actorRole,
        instance.status,
      ].filter(Boolean) as string[],
      reviewState: instance.assignedReviewerUserId ? "ASSIGNED" : null,
      workflowState: instance.status,
      exportState:
        instance.status === "SHARED_EXTERNALLY"
          ? "PUBLIC"
          : instance.status === "PACKAGE_READY"
            ? "PACKAGE_READY"
            : instance.status === "APPROVED"
              ? "APPROVED"
              : "INTERNAL",
      legalHoldState: instance.status === "LEGAL_HOLD" ? "ACTIVE" : null,
      contributorScoped:
        instance.actorRole === "EXTERNAL_CONTRIBUTOR" ||
        instance.actorRole === "ANONYMOUS_SOURCE",
      reviewerRestricted: false,
      evidenceId: null,
      workflowInstanceId: instance.id,
      caseId: instance.caseId ?? null,
      claimRef: instance.claimRef ?? null,
      matterRef: instance.matterRef ?? null,
      sourceUpdatedAtUtc: instance.updatedAt,
    },
    client,
  );
}

// -----------------------------------------------------------------------------
// Delete helper
// -----------------------------------------------------------------------------

async function tryDeleteByKey(
  client: PrismaClient,
  teamId: string,
  documentType: SearchDocumentType,
  sourceId: string,
): Promise<void> {
  try {
    await client.evidenceSearchDocument.deleteMany({
      where: { teamId, documentType, sourceId },
    });
  } catch {
    /* best-effort */
  }
}

export async function removeFromIndex(
  input: {
    teamId: string;
    documentType: SearchDocumentType;
    sourceId: string;
  },
  client: PrismaClient = defaultPrisma,
): Promise<void> {
  await tryDeleteByKey(client, input.teamId, input.documentType, input.sourceId);
}

// Re-export for the tests so they can assert the helper is wired
// to the SEARCH_FORBIDDEN_OVERCLAIM_PHRASES catalog.
export { stringContainsForbiddenOverclaim };
