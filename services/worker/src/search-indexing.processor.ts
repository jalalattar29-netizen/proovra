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
import { logger } from "./logger.js";

export type SearchIndexingDocumentKind =
  | "evidence"
  | "workflow_instance"
  | "workflow_step"
  | "review_event"
  | "operational_incident"
  | "case"
  | "ocr_text"
  | "transcript"
  | "relationship";

export type SearchIndexingJobPayload = {
  teamId: string;
  kind: SearchIndexingDocumentKind;
  sourceId: string;
  reason: string;
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

async function buildForEvidence(
  teamId: string,
  evidenceId: string,
): Promise<BuildOutcome> {
  const evidence = await prisma.evidence.findFirst({
    where: { id: evidenceId, teamId },
    select: {
      id: true,
      teamId: true,
      title: true,
      displayFileName: true,
      originalFileName: true,
      type: true,
      mimeType: true,
      captureMethod: true,
      caseId: true,
      deletedAt: true,
      lifecycleState: true,
      archivedAt: true,
      publicVerifyState: true,
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

  const result = buildEvidenceProjection({
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
      caseId: evidence.caseId,
      deletedAt: evidence.deletedAt,
      lifecycleState: evidence.lifecycleState,
      archivedAt: evidence.archivedAt,
      publicVerifyState: evidence.publicVerifyState,
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
  teamId: string,
  instanceId: string,
): Promise<BuildOutcome> {
  const instance = await prisma.evidenceWorkflowInstance.findFirst({
    where: { id: instanceId, teamId },
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
  teamId: string,
  sourceId: string,
  kind: "ocr_text" | "transcript" | "relationship",
): Promise<BuildOutcome> {
  let parentEvidenceId: string | null = null;
  try {
    if (kind === "ocr_text") {
      const r = (await prisma.$queryRawUnsafe(
        `SELECT "evidence_id" FROM "evidence_ocr_text"
           WHERE "team_id" = $1 AND "id" = $2 LIMIT 1`,
        teamId,
        sourceId,
      )) as Array<{ evidence_id: string }>;
      parentEvidenceId = r[0]?.evidence_id ?? null;
    } else if (kind === "transcript") {
      const r = (await prisma.$queryRawUnsafe(
        `SELECT "evidence_id" FROM "evidence_transcript_segments"
           WHERE "team_id" = $1 AND "id" = $2 LIMIT 1`,
        teamId,
        sourceId,
      )) as Array<{ evidence_id: string }>;
      parentEvidenceId = r[0]?.evidence_id ?? null;
    } else {
      const rel = await prisma.evidenceRelationship.findFirst({
        where: { id: sourceId, teamId },
        select: { sourceEvidenceId: true },
      });
      parentEvidenceId = rel?.sourceEvidenceId ?? null;
    }
  } catch {
    parentEvidenceId = null;
  }
  if (!parentEvidenceId) {
    return { kind: "skip", reason: "parent_evidence_not_found" };
  }
  return buildForEvidence(teamId, parentEvidenceId);
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
      indexedAtUtc: now,
    },
  });
}

async function deleteIndexRow(
  teamId: string,
  documentType: SearchDocumentType,
  sourceId: string,
): Promise<void> {
  try {
    await prisma.evidenceSearchDocument.deleteMany({
      where: { teamId, documentType, sourceId },
    });
  } catch {
    /* best-effort */
  }
}

// =============================================================================
// Public processor
// =============================================================================

export async function processSearchIndexingJob(
  job: Job<SearchIndexingJobPayload>,
): Promise<void> {
  const startedAt = Date.now();
  const { teamId, kind, sourceId, reason } = job.data;
  logger.info(
    {
      searchIndexing: true,
      jobId: job.id,
      teamId,
      kind,
      sourceId,
      reason: reason?.slice(0, 64) ?? "",
      attempt: job.attemptsMade + 1,
    },
    "worker.search.indexing.started",
  );
  if (!teamId || !kind || !sourceId) {
    logger.warn(
      { searchIndexing: true, jobId: job.id, reason: "invalid_payload" },
      "worker.search.indexing.failed",
    );
    throw new Error("invalid_payload");
  }

  let outcome: BuildOutcome;
  try {
    if (kind === "evidence") {
      outcome = await buildForEvidence(teamId, sourceId);
    } else if (kind === "workflow_instance" || kind === "workflow_step") {
      outcome = await buildForWorkflowInstance(teamId, sourceId);
    } else if (
      kind === "ocr_text" ||
      kind === "transcript" ||
      kind === "relationship"
    ) {
      outcome = await buildForOcrOrTranscriptOrRelationship(
        teamId,
        sourceId,
        kind,
      );
    } else {
      outcome = { kind: "skip", reason: `unsupported_kind:${kind}` };
    }
  } catch (err) {
    logger.error(
      {
        searchIndexing: true,
        jobId: job.id,
        teamId,
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
  try {
    if (outcome.kind === "upsert") {
      await persistProjection(outcome.projection);
      upserted = true;
      projectedEvidenceId = outcome.projection.evidenceId;
    } else if (outcome.kind === "delete") {
      await deleteIndexRow(teamId, outcome.documentType, outcome.sourceId);
      deleted = true;
    }
  } catch (err) {
    logger.error(
      {
        searchIndexing: true,
        jobId: job.id,
        teamId,
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
  if (upserted && projectedEvidenceId) {
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
    // Phase 15 — opportunistic semantic embedding backfill.
    //
    // Runs AFTER the keyword index write so a failure here NEVER
    // blocks the canonical search-document upsert. Gated on:
    //   - SEMANTIC_SEARCH_ENABLED=true
    //   - A configured provider that is not the disabled stub
    //
    // Reads chunks that have a `chunkText` but no `embedding` yet,
    // computes a vector via the provider, and writes back. NEVER
    // logs raw chunk text — only chunk id, evidence id, workspace
    // id, and embed count.
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
      teamId,
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
// Phase 15 — semantic embedding backfill helper.
//
// Loads the embedding provider on first use via a dynamic import so
// the worker bundle doesn't pull the abstraction unconditionally
// (keeps the cold-start path small for SEMANTIC_SEARCH_ENABLED=false
// deployments, which is the default).
// =============================================================================

type ProviderHandle = {
  name: string;
  model: string;
  dimensions: number;
  embedText(text: string): Promise<Float32Array | null>;
};

let cachedProviderHandle: { handle: ProviderHandle | null } | null = null;

/**
 * Phase 15 — worker-side mirror of the API's embedding-provider
 * factory. Reads the same env contract:
 *
 *   SEMANTIC_SEARCH_ENABLED               (gate; default false)
 *   SEMANTIC_EMBEDDINGS_PROVIDER          (disabled | local | openai)
 *   SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND  (openai gate; default false)
 *   SEMANTIC_EMBEDDING_DIMENSIONS         (default 384 local / 1536 openai)
 *
 * The worker does NOT import from `services/api/...` (cross-package
 * import is blocked by the monorepo boundary). We inline the minimal
 * factory + local deterministic provider here so the abstraction
 * remains self-contained.
 */
async function resolveProvider(): Promise<ProviderHandle | null> {
  if (process.env.SEMANTIC_SEARCH_ENABLED !== "true") return null;
  if (cachedProviderHandle) return cachedProviderHandle.handle;
  const raw = (process.env.SEMANTIC_EMBEDDINGS_PROVIDER ?? "disabled")
    .trim()
    .toLowerCase();
  const dimEnv = Number.parseInt(
    process.env.SEMANTIC_EMBEDDING_DIMENSIONS ?? "0",
    10,
  );
  let handle: ProviderHandle | null = null;
  if (raw === "local" || raw === "local-deterministic" || raw === "test") {
    const dim = Number.isFinite(dimEnv) && dimEnv > 0 ? Math.min(dimEnv, 1536) : 384;
    handle = makeLocalDeterministicProvider(dim);
  } else if (raw === "openai") {
    // Phase 16 — real OpenAI binding behind the dual gate. This
    // safety-net path mirrors the dedicated `mi-embed.processor`
    // provider exactly: dual gate (outbound + api key), lazy SDK
    // import, AbortController timeout. Anything other than the
    // explicit opt-in degrades to keyword-only (handle=null).
    if (process.env.SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND !== "true") {
      logger.warn(
        {
          searchIndexing: true,
          providerCandidate: "openai",
          reason: "OUTBOUND_DISABLED",
        },
        "worker.search.indexing.semantic_provider_skipped",
      );
      handle = null;
    } else {
      const apiKey = process.env.OPENAI_API_KEY?.trim();
      if (!apiKey) {
        logger.warn(
          {
            searchIndexing: true,
            providerCandidate: "openai",
            reason: "OPENAI_API_KEY_MISSING",
          },
          "worker.search.indexing.semantic_provider_skipped",
        );
        handle = null;
      } else {
        try {
          const mod = (await import("openai")) as {
            default: new (config: { apiKey: string }) => unknown;
            OpenAI?: new (config: { apiKey: string }) => unknown;
          };
          const Ctor = mod.default ?? mod.OpenAI;
          if (!Ctor) {
            handle = null;
          } else {
            const dimOpenai = Number.isFinite(dimEnv) && dimEnv > 0 ? dimEnv : 1536;
            const client = new Ctor({ apiKey }) as {
              embeddings: {
                create: (req: {
                  model: string;
                  input: string[];
                  dimensions?: number;
                }, options?: { signal?: AbortSignal }) => Promise<{
                  data: Array<{ embedding: number[] }>;
                }>;
              };
            };
            const modelOpenai =
              process.env.SEMANTIC_EMBEDDING_MODEL?.trim() ||
              "text-embedding-3-small";
            handle = {
              name: "openai",
              model: modelOpenai,
              dimensions: dimOpenai,
              async embedText(text: string) {
                const controller = new AbortController();
                const timeoutMs = Math.max(
                  1_000,
                  Number.parseInt(
                    process.env.SEMANTIC_EMBEDDINGS_TIMEOUT_MS ?? "30000",
                    10,
                  ),
                );
                const timer = setTimeout(() => controller.abort(), timeoutMs);
                try {
                  const resp = await client.embeddings.create(
                    {
                      model: modelOpenai,
                      input: [text],
                      dimensions: dimOpenai,
                    },
                    { signal: controller.signal },
                  );
                  const vec = resp.data[0]?.embedding;
                  return Array.isArray(vec) && vec.length > 0
                    ? Float32Array.from(vec)
                    : null;
                } finally {
                  clearTimeout(timer);
                }
              },
            };
          }
        } catch {
          handle = null;
        }
      }
    }
  }
  cachedProviderHandle = { handle };
  return handle;
}

function makeLocalDeterministicProvider(dimensions: number): ProviderHandle {
  return {
    name: "local-deterministic",
    model: "sha256-bucket",
    dimensions,
    async embedText(text: string): Promise<Float32Array | null> {
      const safe = text.slice(0, 8 * 1024);
      const vec = new Float32Array(dimensions);
      const tokens = safe
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
      const crypto = await import("node:crypto");
      for (const tok of tokens) {
        const h = crypto.createHash("sha256").update(tok).digest();
        const bucket =
          ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
        const idx = bucket % dimensions;
        vec[idx] += Math.min(8, tok.length);
      }
      let norm = 0;
      for (let i = 0; i < vec.length; i += 1) norm += vec[i] * vec[i];
      const denom = Math.sqrt(norm);
      if (denom > 0) {
        for (let i = 0; i < vec.length; i += 1) vec[i] /= denom;
      }
      return vec;
    },
  };
}

async function backfillSemanticEmbeddings(
  teamId: string,
  evidenceId: string,
): Promise<number> {
  const provider = await resolveProvider();
  if (!provider) return 0;
  // Bound the per-job work — the producer is the search-indexing
  // queue, which fires per evidence rebuild. Backfilling all chunks
  // on every fire keeps the embedding table eventually-consistent
  // without needing a separate queue.
  // Phase 16 — bulk embedding work now flows through the dedicated
  // `mi-embed` queue. This inline backfill is the safety net for any
  // drift between the live-indexing enqueue and the dedicated worker.
  // Reduced from 200 → 25 so it stays a backstop, not the primary path.
  const chunks = await prisma.evidenceSemanticChunk.findMany({
    where: {
      teamId,
      evidenceId,
      OR: [
        { embedding: null },
        { embeddingProvider: { not: provider.name } },
        { embeddingModel: { not: provider.model } },
        { embeddingDimensions: { not: provider.dimensions } },
      ],
    },
    select: { id: true, chunkText: true },
    take: 25,
  });
  if (chunks.length === 0) return 0;

  let written = 0;
  for (const c of chunks) {
    let vec: Float32Array | null = null;
    try {
      vec = await provider.embedText(c.chunkText);
    } catch (err) {
      // Bounded structured log — no chunk text. We log the chunk id
      // so an operator can pivot to that row to investigate.
      logger.warn(
        {
          searchIndexing: true,
          teamId,
          evidenceId,
          chunkId: c.id,
          errorCode:
            err instanceof Error
              ? (err as Error & { code?: string }).code ?? "EMBED_FAILED"
              : "EMBED_FAILED",
        },
        "worker.search.indexing.semantic_embed_skipped",
      );
      continue;
    }
    if (!vec || vec.length === 0) continue;
    try {
      const buf = new Uint8Array(vec.byteLength);
      buf.set(new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength));
      await prisma.evidenceSemanticChunk.update({
        where: { id: c.id },
        data: {
          embedding: buf,
          embeddingProvider: provider.name,
          embeddingModel: provider.model,
          embeddingDimensions: provider.dimensions,
        },
      });
      written += 1;
    } catch (err) {
      logger.warn(
        {
          searchIndexing: true,
          teamId,
          evidenceId,
          chunkId: c.id,
          errorCode:
            err instanceof Error ? err.message.slice(0, 64) : "WRITE_FAILED",
        },
        "worker.search.indexing.semantic_write_skipped",
      );
    }
  }
  return written;
}
