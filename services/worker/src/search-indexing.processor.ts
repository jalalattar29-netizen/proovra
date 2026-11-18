/**
 * Phase 24-J / Phase 25 — Search Discovery indexing worker.
 *
 * Async processor for `searchIndexingQueue` jobs. Phase 25 replaces
 * the previous lag-pointer-only stub with a REAL rebuild path that
 * shares the canonical projection engine with the API service
 * (`@proovra/shared`). Both processes call the same `buildEvidenceProjection`
 * / `buildWorkflowInstanceProjection` pure functions, so the indexing
 * logic NEVER diverges between API and worker.
 *
 * Hard rules:
 *   - The shared projection engine is the SINGLE source of truth for
 *     what a search row may contain. The worker fetches source data
 *     via Prisma, calls the shared builder, and upserts the result.
 *   - When the builder returns `deleteFromIndex: true` (deleted /
 *     DESTROYED / PENDING_DESTRUCTION lifecycle states), the worker
 *     removes the stale document.
 *   - The processor NEVER reads private fields. Cross-team rows are
 *     refused by the builder via the team-mismatch guard.
 *   - Errors emit structured `worker.search.indexing.failed` events
 *     and re-throw so BullMQ records the failure + applies exponential
 *     backoff.
 *   - On success, the OCR + transcript indexing-lag pointers are
 *     unwound for the source evidence — the operator-facing readiness
 *     probe sees "indexing has caught up".
 */

import type { Job } from "bullmq";
import {
  buildEvidenceProjection,
  buildWorkflowInstanceProjection,
  type SearchDocumentProjection,
  type SearchDocumentType,
  // PHASE 12 POINT 5 — canonical payload contract.
  JOB_NAMES,
  QueuePayloadRejected,
  decodeJobPayload,
  getWorkEntryOrThrow,
  parseSearchIndexCommandId,
  type SearchIndexDocumentKind,
} from "@proovra/shared";

// HOTFIX — Worker startup regression.
//
// This processor previously instantiated its own `new PrismaClient()`
// at module load. The schema.prisma datasource block has no `url`
// (Prisma reads the connection via the PrismaPg driver adapter
// wired up in ./db.ts), so a bare `new PrismaClient()` throws
// `PrismaClientInitializationError` at import time. Because this
// module is imported synchronously by ./index.ts (line ~24), that
// throw kills the entire worker runtime BEFORE any processor can
// register — taking down report generation, verification package
// generation, search indexing, and every other queue.
//
// The canonical pattern (used by ./db.ts and every other worker
// helper) is to import the shared `prisma` instance, which is
// constructed once with `new PrismaClient({ adapter })`. Doing
// the same here removes the bootstrap crash without changing
// the processor's behavior — every read/write below already uses
// the same prisma surface.
import { prisma } from "./db.js";
import { loadIntakeIdentityForIndex } from "@proovra/shared-runtime";
import { logger } from "./logger.js";
import { workspaceSemanticEgressAllowed } from "./embedding-egress-gate.js";

/**
 * PHASE 12 POINT 5 — the document-kind catalog has ONE definition
 * (`@proovra/shared`). This file previously declared its own nine-kind union
 * while both producers declared a different six, so three of the kinds a
 * producer could enqueue were silently discarded here as `unsupported_kind`.
 */
export type SearchIndexingDocumentKind = SearchIndexDocumentKind;

const REGISTRY_ENTRY = getWorkEntryOrThrow(JOB_NAMES.REBUILD_SEARCH_DOCUMENT);
const EXPECT = {
  jobName: REGISTRY_ENTRY.workName,
  schemaVersion: REGISTRY_ENTRY.schemaVersion,
};

// =============================================================================
// Per-kind builders. Each fetches the source row + calls the SHARED
// projection engine. Returns `null` when the builder asks for a delete
// (the caller then runs the canonical removeFromIndex path).
// =============================================================================

type BuildOutcome =
  | { kind: "upsert"; projection: SearchDocumentProjection }
  | { kind: "delete"; documentType: SearchDocumentType; sourceId: string }
  | { kind: "skip"; reason: string };

/**
 * PHASE 12 POINT 5 — the tenant is DERIVED, never supplied.
 *
 * The job payload names only the source row. This lookup is by primary key
 * alone; `teamId` below is read off the row that came back and is the value
 * every subsequent scoped read uses. The previous signature took the tenant
 * from the queue payload and passed it into the WHERE clause, which meant a
 * tampered or stale payload chose which workspace the worker operated in.
 */
async function buildForEvidence(evidenceId: string): Promise<BuildOutcome> {
  const evidence = await prisma.evidence.findUnique({
    where: { id: evidenceId },
    select: {
      id: true,
      teamId: true,
      title: true,
      displayFileName: true,
      originalFileName: true,
      type: true,
      mimeType: true,
      captureMethod: true,
      acquisitionMode: true,
      // PHASE 12B — index projects the primary linked case (earliest link).
      caseLinks: { select: { caseId: true }, orderBy: { linkedAtUtc: "asc" }, take: 1 },
      deletedAt: true,
      lifecycleState: true,
      archivedAt: true,
      verificationDisclosureMode: true,
      verificationAccessState: true,
      storageObjectLockLegalHoldStatus: true,
      retentionPolicySource: true,
      retentionUntilUtc: true,
      reviewReadyAtUtc: true,
      updatedAt: true,
    },
  });
  if (!evidence) {
    // Source disappeared — treat as a delete from index. Worker
    // converges the search corpus toward reality.
    return { kind: "delete", documentType: "EVIDENCE", sourceId: evidenceId };
  }
  // `Evidence.teamId` is nullable in the schema. Scope resolution that comes
  // back empty FAILS CLOSED — it must never be quietly resolved to a personal
  // workspace, and it must not fall back to whatever the job payload claimed.
  // A skip leaves the projection untouched and surfaces as indexing lag, which
  // is the recoverable outcome; guessing a tenant is not.
  const teamId = evidence.teamId;
  if (!teamId) {
    return { kind: "skip", reason: "tenant_unresolved" };
  }
  // Optional workflow status — same selection the API service uses.
  let workflowState: string | null = null;
  try {
    const link = await prisma.evidenceWorkflowInstanceEvidence.findFirst({
      where: { evidenceId },
      orderBy: { createdAt: "desc" },
      include: { instance: { select: { status: true } } },
    });
    workflowState = link?.instance?.status ?? null;
  } catch {
    workflowState = null;
  }
  // OCR + transcript safe-to-index chunks. These reads enforce the
  // governance scope inside the SQL (visibility_scope = 'TEAM' AND
  // redacted = FALSE). Failures are non-fatal.
  const extractedTextChunks: string[] = [];
  try {
    const ocrRows = (await prisma.$queryRawUnsafe(
      `SELECT "text"
         FROM "evidence_ocr_text"
         WHERE "team_id" = $1
           AND "evidence_id" = $2
           AND "visibility_scope" = 'TEAM'
           AND "redacted" = FALSE
         ORDER BY "part_id" NULLS FIRST, "chunk_index" ASC
         LIMIT 32`,
      teamId,
      evidenceId,
    )) as Array<{ text: string }>;
    for (const r of ocrRows) {
      const safe = (r.text ?? "").slice(0, 4 * 1024);
      if (safe.length > 0) extractedTextChunks.push(`[OCR] ${safe}`);
    }
  } catch {
    /* OCR table may not exist on this DB yet — non-fatal. */
  }
  try {
    const tRows = (await prisma.$queryRawUnsafe(
      `SELECT "text"
         FROM "evidence_transcript_segments"
         WHERE "team_id" = $1
           AND "evidence_id" = $2
           AND "visibility_scope" = 'TEAM'
           AND "redacted" = FALSE
         ORDER BY "part_id" NULLS FIRST, "segment_index" ASC
         LIMIT 64`,
      teamId,
      evidenceId,
    )) as Array<{ text: string }>;
    for (const r of tRows) {
      const safe = (r.text ?? "").slice(0, 2 * 1024);
      if (safe.length > 0) extractedTextChunks.push(`[TRANSCRIPT] ${safe}`);
    }
  } catch {
    /* transcript table may not exist on this DB yet — non-fatal. */
  }

  const intakeIdentityForIndex = await loadIntakeIdentityForIndex(
    evidenceId,
    prisma as never,
  );

  const result = buildEvidenceProjection({
    // Loaded through the 1:1 session relation rather than snapshotted onto
    // Evidence: these are contact details, and a second copy is a second
    // place a disclosure decision has to be got right.
    intakeIdentity: intakeIdentityForIndex,
    teamId,
    evidenceId,
    evidence: {
      id: evidence.id,
      teamId: evidence.teamId,
      title: evidence.title,
      displayFileName: evidence.displayFileName,
      originalFileName: evidence.originalFileName,
      type: evidence.type,
      mimeType: evidence.mimeType,
      captureMethod: evidence.captureMethod,
      acquisitionMode: evidence.acquisitionMode ?? null,
      caseId: evidence.caseLinks?.[0]?.caseId ?? null,
      deletedAt: evidence.deletedAt,
      lifecycleState: evidence.lifecycleState,
      archivedAt: evidence.archivedAt,
      verificationDisclosureMode: evidence.verificationDisclosureMode,
      verificationAccessState: evidence.verificationAccessState,
      storageObjectLockLegalHoldStatus:
        evidence.storageObjectLockLegalHoldStatus,
      retentionPolicySource: evidence.retentionPolicySource,
      retentionUntilUtc: evidence.retentionUntilUtc,
      reviewReadyAtUtc: evidence.reviewReadyAtUtc,
      updatedAt: evidence.updatedAt,
    },
    workflowState,
    extractedTextChunks,
  });
  if (!result.ok) {
    if (result.deleteFromIndex) {
      return { kind: "delete", documentType: "EVIDENCE", sourceId: evidenceId };
    }
    return { kind: "skip", reason: result.reason };
  }
  return { kind: "upsert", projection: result.projection };
}

async function buildForWorkflowInstance(
  instanceId: string,
): Promise<BuildOutcome> {
  const instance = await prisma.evidenceWorkflowInstance.findUnique({
    where: { id: instanceId },
    select: {
      id: true,
      teamId: true,
      title: true,
      templateSlug: true,
      templateVersion: true,
      intakeMode: true,
      actorRole: true,
      status: true,
      caseId: true,
      claimRef: true,
      matterRef: true,
      assignedReviewerUserId: true,
      updatedAt: true,
    },
  });
  if (!instance) {
    return { kind: "delete", documentType: "WORKFLOW", sourceId: instanceId };
  }
  const teamId = instance.teamId;
  const result = buildWorkflowInstanceProjection({
    teamId,
    workflowInstanceId: instanceId,
    instance: {
      id: instance.id,
      teamId: instance.teamId,
      title: instance.title,
      templateSlug: instance.templateSlug,
      templateVersion: instance.templateVersion,
      intakeMode: instance.intakeMode,
      actorRole: instance.actorRole,
      status: instance.status,
      caseId: instance.caseId,
      claimRef: instance.claimRef,
      matterRef: instance.matterRef,
      assignedReviewerUserId: instance.assignedReviewerUserId,
      updatedAt: instance.updatedAt,
    },
  });
  if (!result.ok) {
    if (result.deleteFromIndex) {
      return { kind: "delete", documentType: "WORKFLOW", sourceId: instanceId };
    }
    return { kind: "skip", reason: result.reason };
  }
  return { kind: "upsert", projection: result.projection };
}

// OCR / transcript / relationship kinds: rebuild the parent evidence
// row so its searchable_text body picks up the new chunk. Cleanest
// idempotent mapping — re-derive parent from sourceId.
async function buildForOcrOrTranscriptOrRelationship(
  sourceId: string,
  kind: "ocr_text" | "transcript" | "relationship",
): Promise<BuildOutcome> {
  let parentEvidenceId: string | null = null;
  // The chunk row is looked up by its own primary key; the parent evidence id
  // comes off that row, and `buildForEvidence` then derives the tenant from the
  // evidence row. No step consults a payload-supplied workspace.
  //
  // A DB error here must NOT be swallowed into "parent not found": that would
  // turn an outage into a silent skip and leave the corpus stale while the job
  // reports success. It propagates so BullMQ retries.
  if (kind === "ocr_text") {
    const r = (await prisma.$queryRawUnsafe(
      `SELECT "evidence_id" FROM "evidence_ocr_text" WHERE "id" = $1 LIMIT 1`,
      sourceId,
    )) as Array<{ evidence_id: string }>;
    parentEvidenceId = r[0]?.evidence_id ?? null;
  } else if (kind === "transcript") {
    const r = (await prisma.$queryRawUnsafe(
      `SELECT "evidence_id" FROM "evidence_transcript_segments" WHERE "id" = $1 LIMIT 1`,
      sourceId,
    )) as Array<{ evidence_id: string }>;
    parentEvidenceId = r[0]?.evidence_id ?? null;
  } else {
    const rel = await prisma.evidenceRelationship.findUnique({
      where: { id: sourceId },
      select: { sourceEvidenceId: true },
    });
    parentEvidenceId = rel?.sourceEvidenceId ?? null;
  }
  if (!parentEvidenceId) {
    return { kind: "skip", reason: "parent_evidence_not_found" };
  }
  return buildForEvidence(parentEvidenceId);
}

// =============================================================================
// Persistence — the worker writes the SearchDocumentProjection via raw
// upsert. Mirrors the API's `upsertSearchDocumentProjection` shape.
// =============================================================================

async function persistProjection(
  projection: SearchDocumentProjection,
): Promise<void> {
  const now = new Date();
  await prisma.evidenceSearchDocument.upsert({
    where: {
      teamId_documentType_sourceId: {
        teamId: projection.teamId,
        documentType: projection.documentType,
        sourceId: projection.sourceId,
      } as never,
    },
    create: {
      teamId: projection.teamId,
      documentType: projection.documentType,
      sourceId: projection.sourceId,
      title: projection.title,
      subtitle: projection.subtitle,
      summary: projection.summary,
      searchableText: projection.searchableText,
      searchableMetadataJson:
        (projection.searchableMetadata as never) ?? undefined,
      searchableTagsJson:
        (projection.searchableTags as never) ?? undefined,
      visibilityScopeJson:
        (projection.visibilityScope as never) ?? undefined,
      governanceScopeJson:
        (projection.governanceScope as never) ?? undefined,
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
      // WORKERS-09: the build that produced this body, exactly as the API
      // writer stamps it. Without it every worker-written row reads as
      // version 1 and the reindex treats it as stale forever.
      projectionVersion: projection.projectionVersion,
      indexedAtUtc: now,
    },
    update: {
      title: projection.title,
      subtitle: projection.subtitle,
      summary: projection.summary,
      searchableText: projection.searchableText,
      searchableMetadataJson:
        (projection.searchableMetadata as never) ?? undefined,
      searchableTagsJson:
        (projection.searchableTags as never) ?? undefined,
      visibilityScopeJson:
        (projection.visibilityScope as never) ?? undefined,
      governanceScopeJson:
        (projection.governanceScope as never) ?? undefined,
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
      // WORKERS-09: the build that produced this body, exactly as the API
      // writer stamps it. Without it every worker-written row reads as
      // version 1 and the reindex treats it as stale forever.
      projectionVersion: projection.projectionVersion,
      indexedAtUtc: now,
    },
  });
}

/**
 * Remove a stale projection whose source row no longer exists.
 *
 * Scoped by `(documentType, sourceId)` and NOT by workspace, because there is
 * no longer a workspace to scope by: the source row is gone, so no tenant can
 * be derived from it, and the payload's workspace is exactly the thing this
 * pass stopped trusting. That is the safe direction — source ids are UUIDs, so
 * the pair identifies at most one row, and removing a projection whose source
 * has been deleted can never leak across tenants, whereas leaving it can.
 */
async function deleteIndexRow(
  documentType: SearchDocumentType,
  sourceId: string,
): Promise<void> {
  await prisma.evidenceSearchDocument.deleteMany({
    where: { documentType, sourceId },
  });
}

// =============================================================================
// Public processor
// =============================================================================

export async function processSearchIndexingJob(
  job: Job<unknown>,
): Promise<void> {
  const startedAt = Date.now();

  // PHASE 12 POINT 5 — job name, then payload schema, then the bounded document
  // kind. All three are checked before a single row is read or written, so a
  // malformed, misrouted or unknown-version job causes zero mutation.
  if (job.name && job.name !== REGISTRY_ENTRY.workName) {
    logger.warn(
      { searchIndexing: true, jobId: job.id, jobName: job.name },
      "worker.search.indexing.job_name_mismatch",
    );
    return;
  }

  let kind: SearchIndexDocumentKind;
  let sourceId: string;
  let reason: string;
  try {
    const decoded = decodeJobPayload(EXPECT, job.data);
    const parsed = parseSearchIndexCommandId(decoded.commandId);
    kind = parsed.kind;
    sourceId = parsed.sourceId;
    reason = decoded.traceId;
    if (decoded.discardedAuthorityFields.length > 0) {
      logger.warn(
        {
          searchIndexing: true,
          jobId: job.id,
          discarded: decoded.discardedAuthorityFields,
        },
        "worker.search.indexing.payload_authority_fields_discarded",
      );
    }
  } catch (err) {
    logger.warn(
      {
        searchIndexing: true,
        jobId: job.id,
        code: err instanceof QueuePayloadRejected ? err.code : "malformed",
      },
      "worker.search.indexing.payload_rejected",
    );
    // A structurally invalid payload is not retryable — retrying it produces
    // the identical rejection. Return instead of throwing so it does not churn
    // through the backoff ladder on its way to the same conclusion.
    return;
  }

  logger.info(
    {
      searchIndexing: true,
      jobId: job.id,
      kind,
      sourceId,
      reason: reason.slice(0, 64),
      attempt: job.attemptsMade + 1,
    },
    "worker.search.indexing.started",
  );

  let outcome: BuildOutcome;
  try {
    if (kind === "evidence") {
      outcome = await buildForEvidence(sourceId);
    } else if (kind === "workflow_instance" || kind === "workflow_step") {
      outcome = await buildForWorkflowInstance(sourceId);
    } else {
      outcome = await buildForOcrOrTranscriptOrRelationship(sourceId, kind);
    }
  } catch (err) {
    logger.error(
      {
        searchIndexing: true,
        jobId: job.id,
        kind,
        sourceId,
        error: err instanceof Error ? err.message.slice(0, 200) : "unknown",
      },
      "worker.search.indexing.failed",
    );
    throw err;
  }

  let upserted = false;
  let deleted = false;
  let projectedEvidenceId: string | null = null;
  // The authoritative workspace, derived from the row the builder loaded. Null
  // when nothing was projected (skip / delete), and every use below is guarded
  // on `upserted`, so there is no path where an un-derived tenant scopes a
  // write. Failing closed here is the point: no projection, no tenant, no
  // follow-on mutation.
  let derivedTeamId: string | null = null;
  try {
    if (outcome.kind === "upsert") {
      await persistProjection(outcome.projection);
      upserted = true;
      projectedEvidenceId = outcome.projection.evidenceId;
      derivedTeamId = outcome.projection.teamId;
    } else if (outcome.kind === "delete") {
      await deleteIndexRow(outcome.documentType, outcome.sourceId);
      deleted = true;
    }
  } catch (err) {
    logger.error(
      {
        searchIndexing: true,
        jobId: job.id,
        teamId: derivedTeamId,
        kind,
        sourceId,
        outcome: outcome.kind,
        error: err instanceof Error ? err.message.slice(0, 200) : "unknown",
      },
      "worker.search.indexing.failed",
    );
    throw err;
  }

  // ONLY after a successful rebuild do we unwind the OCR + transcript
  // indexing-lag pointers. If the projection was skipped or deleted,
  // the lag stays — the operator-facing readiness probe sees that
  // search-document rebuild has not caught up.
  let ocrIndexed = 0;
  let transcriptIndexed = 0;
  let semanticEmbedded = 0;
  if (upserted && projectedEvidenceId && derivedTeamId) {
    const teamId = derivedTeamId;
    const now = new Date();
    try {
      ocrIndexed = await prisma.$executeRawUnsafe(
        `UPDATE "evidence_ocr_text"
           SET "indexed_at_utc" = $1
           WHERE "team_id" = $2
             AND "evidence_id" = $3
             AND "indexed_at_utc" IS NULL`,
        now,
        teamId,
        projectedEvidenceId,
      );
      transcriptIndexed = await prisma.$executeRawUnsafe(
        `UPDATE "evidence_transcript_segments"
           SET "indexed_at_utc" = $1
           WHERE "team_id" = $2
             AND "evidence_id" = $3
             AND "indexed_at_utc" IS NULL`,
        now,
        teamId,
        projectedEvidenceId,
      );
    } catch (err) {
      logger.warn(
        {
          searchIndexing: true,
          jobId: job.id,
          teamId,
          kind,
          sourceId,
          error:
            err instanceof Error ? err.message.slice(0, 200) : "unknown",
        },
        "worker.search.indexing.lag_pointer_failed",
      );
    }

    // -------------------------------------------------------------------
    // RG-04 - semantic safety net. Runs AFTER the keyword index write so a
    // failure here NEVER blocks the canonical search-document upsert. It no
    // longer calls a provider: it asks the worker's semantic-egress gate and
    // hands an owed chunk to mi-embed, the one gated, metered producer.
    // -------------------------------------------------------------------
    try {
      semanticEmbedded = await backfillSemanticEmbeddings(
        teamId,
        projectedEvidenceId,
      );
    } catch (err) {
      logger.warn(
        {
          searchIndexing: true,
          jobId: job.id,
          teamId,
          evidenceId: projectedEvidenceId,
          error: err instanceof Error ? err.message.slice(0, 200) : "unknown",
        },
        "worker.search.indexing.semantic_backfill_failed_non_fatal",
      );
    }
  }

  logger.info(
    {
      searchIndexing: true,
      jobId: job.id,
      teamId: derivedTeamId,
      kind,
      sourceId,
      outcome: outcome.kind,
      reason: outcome.kind === "skip" ? outcome.reason : null,
      upserted,
      deleted,
      ocrIndexed,
      transcriptIndexed,
      semanticEmbedded,
      durationMs: Date.now() - startedAt,
    },
    upserted || deleted
      ? "worker.search.indexing.succeeded"
      : "worker.search.indexing.skipped",
  );
}

// =============================================================================
// RG-04 (PRO-AI1-01 / PRO-W2-01) - the search-index safety net no longer
// embeds anything itself.
//
// It used to resolve its own provider from the environment and send up to 25
// chunks of evidence-derived text per re-index to the embedding vendor with no
// workspace AI policy, plan, contract, budget or usage record. The one gated
// producer is mi-embed: this helper only asks the worker's semantic-egress gate
// whether the workspace may embed at all (to avoid enqueue churn for a workspace
// that may not) and, if so, hands ONE owed chunk of this record to mi-embed as
// the anchor. mi-embed re-decides the gate, the caps and the batch itself, and
// records usage for every vector it writes.
// =============================================================================

export async function backfillSemanticEmbeddings(
  teamId: string,
  evidenceId: string,
): Promise<number> {
  if (process.env.SEMANTIC_SEARCH_ENABLED !== "true") return 0;
  const egress = await workspaceSemanticEgressAllowed(teamId);
  if (!egress.allowed) return 0;
  const owed = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id::text AS id
      FROM evidence_semantic_chunks
     WHERE team_id = ${teamId}::uuid
       AND evidence_id = ${evidenceId}::uuid
       AND embedding_vector IS NULL
     ORDER BY chunk_index ASC
     LIMIT 1
  `;
  const anchor = owed[0]?.id;
  if (!anchor) return 0;
  const { enqueueMiEmbedJob } = await import("./queue.js");
  const outcome = await enqueueMiEmbedJob(anchor, { reason: "search_index" });
  return outcome.enqueued ? 1 : 0;
}
