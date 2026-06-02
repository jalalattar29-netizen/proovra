/**
 * Phase 16 — Semantic embedding backfill.
 *
 * One-shot batch driver intended for two surfaces:
 *
 *   1. POST /v1/search/semantic/backfill — operator-triggered.
 *      Body { workspaceId?, batchSize?, maxBatches?, dryRun? }.
 *
 *   2. CLI / cron — `scripts/backfill-semantic-embeddings.ts` shells
 *      to `runSemanticBackfill` with the same argument shape so a
 *      large workspace can be drained at vendor pace from a side
 *      machine without monopolising the API queue.
 *
 * Hard rules (every iteration honoured):
 *   - Workspace-scoped: a missing `workspaceId` returns
 *     `{ skippedReason: "WORKSPACE_REQUIRED" }` rather than
 *     scanning across tenants.
 *   - Idempotent: only selects rows that need an embedding
 *     ("embedding_vector IS NULL OR provider/model/dim mismatch").
 *     Re-running the script after partial success is safe.
 *   - Resumable: caller can pass `cursor` (last evidence id) to
 *     continue where a previous run stopped — the returned
 *     `nextCursor` is the last chunk id processed in this run.
 *   - Bounded: `batchSize` clamps 1..200; `maxBatches` clamps
 *     1..1000 so a single invocation cannot run for hours.
 *   - Budget aware: consults `canEmbedMore` before each batch.
 *     Hitting the daily cap returns gracefully with
 *     `skippedReason="DAILY_CAP"|"MONTHLY_BUDGET"`.
 *   - NEVER logs raw chunk text. Bounded counts + ids only.
 *   - dryRun=true: simulates the selection + budget check but does
 *     NOT call the provider and does NOT write any vector. Useful
 *     for operators sizing a workspace before flipping the switch.
 */

import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import {
  resolveEmbeddingProviderFromEnv,
  logEmbeddingFailure,
  EmbeddingProviderError,
} from "./embedding-provider.js";
import {
  canEmbedMore,
  estimateEurFromTokens,
  estimateTokensFromChars,
  recordSemanticChunkEmbedded,
} from "./semantic-budget.service.js";

export type SemanticBackfillInput = {
  workspaceId: string;
  batchSize?: number;
  maxBatches?: number;
  /** Resume from this chunk id (exclusive). The next batch will
   *  start at the NEXT id in ascending order. */
  cursorChunkId?: string | null;
  dryRun?: boolean;
};

export type SemanticBackfillResult = {
  processed: number;
  succeeded: number;
  failed: number;
  skippedReason:
    | null
    | "WORKSPACE_REQUIRED"
    | "PROVIDER_UNAVAILABLE"
    | "DAILY_CAP"
    | "MONTHLY_BUDGET"
    | "OUTBOUND_NOT_ALLOWED"
    | "AUTH"
    | "DRY_RUN_COMPLETED";
  nextCursorChunkId: string | null;
  durationMs: number;
};

/**
 * Build a literal pgvector parameter `'[a,b,c]'`. We pass this as a
 * BOUND parameter cast to `::vector` so the SQL body never carries
 * user-supplied data.
 */
function vectorLiteral(vec: Float32Array): string {
  // Bounded — guard against absurd dimensions slipping through.
  if (vec.length === 0 || vec.length > 4096) return "[]";
  const parts = new Array<string>(vec.length);
  for (let i = 0; i < vec.length; i += 1) {
    const v = vec[i];
    parts[i] = Number.isFinite(v) ? v.toFixed(6) : "0";
  }
  return `[${parts.join(",")}]`;
}

export async function runSemanticBackfill(
  input: SemanticBackfillInput,
  client: PrismaClient = defaultPrisma,
): Promise<SemanticBackfillResult> {
  const startedAt = Date.now();
  if (!input.workspaceId) {
    return {
      processed: 0,
      succeeded: 0,
      failed: 0,
      skippedReason: "WORKSPACE_REQUIRED",
      nextCursorChunkId: null,
      durationMs: 0,
    };
  }
  const batchSize = clamp(input.batchSize ?? 50, 1, 200);
  const maxBatches = clamp(input.maxBatches ?? 10, 1, 1000);
  const dryRun = input.dryRun === true;
  const provider = resolveEmbeddingProviderFromEnv();
  if (provider.name === "disabled") {
    return {
      processed: 0,
      succeeded: 0,
      failed: 0,
      skippedReason: "PROVIDER_UNAVAILABLE",
      nextCursorChunkId: input.cursorChunkId ?? null,
      durationMs: Date.now() - startedAt,
    };
  }

  let cursor = input.cursorChunkId ?? null;
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let skippedReason: SemanticBackfillResult["skippedReason"] = null;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    // Per-batch gate. Cheap — index-only lookup on
    // semantic_usage_daily.
    const gate = await canEmbedMore(client, {
      workspaceId: input.workspaceId,
      additionalChunks: batchSize,
    });
    if (!gate.allowed) {
      skippedReason = gate.reason;
      break;
    }

    // Load the next batch of chunks needing embeddings. We use raw
    // SQL because the `embedding_vector` column is Unsupported in
    // Prisma. Workspace id is passed as a bound parameter; the only
    // interpolation is into a tagged-template literal that Prisma
    // parameterises for us.
    let candidates: Array<{ id: string; chunkText: string }> = [];
    try {
      const rows = await client.$queryRaw<
        Array<{ id: string; chunk_text: string }>
      >`
        SELECT id, chunk_text
          FROM evidence_semantic_chunks
         WHERE team_id = ${input.workspaceId}::uuid
           AND (
             embedding_vector IS NULL
             OR embedding_provider IS DISTINCT FROM ${provider.name}
             OR embedding_model    IS DISTINCT FROM ${provider.model}
             OR embedding_dimensions IS DISTINCT FROM ${provider.dimensions}::int
           )
           ${cursor ? Prisma.sql`AND id > ${cursor}::uuid` : Prisma.empty}
         ORDER BY id ASC
         LIMIT ${batchSize}::int
      `;
      candidates = rows.map((r) => ({ id: r.id, chunkText: r.chunk_text }));
    } catch (err) {
      // Whole-batch failure — log + bail. Better to surface a
      // partial result than to silently swallow an indefinite hang.
      logEmbeddingFailure({
        status: "failed",
        errorCode:
          err instanceof Error ? `BACKFILL_SELECT:${err.name}` : "BACKFILL_SELECT",
        workspaceId: input.workspaceId,
      });
      break;
    }
    if (candidates.length === 0) break;

    if (dryRun) {
      processed += candidates.length;
      cursor = candidates[candidates.length - 1].id;
      continue;
    }

    // Real call.
    let vectors: Array<Float32Array | null>;
    try {
      vectors = await provider.embedBatch(
        candidates.map((c) => c.chunkText),
      );
    } catch (err) {
      // Configuration error — bail out so the operator can fix.
      if (err instanceof EmbeddingProviderError) {
        if (err.code === "OUTBOUND_NOT_ALLOWED") {
          skippedReason = "OUTBOUND_NOT_ALLOWED";
          break;
        }
        if (err.code === "AUTH" || err.code === "PROVIDER_NOT_CONFIGURED") {
          skippedReason = "AUTH";
          break;
        }
      }
      // Transient — count as failed batch and continue.
      failed += candidates.length;
      processed += candidates.length;
      cursor = candidates[candidates.length - 1].id;
      logEmbeddingFailure({
        status: "failed",
        errorCode:
          err instanceof Error
            ? `BACKFILL_EMBED:${err.name}`
            : "BACKFILL_EMBED",
        workspaceId: input.workspaceId,
      });
      continue;
    }

    // Per-chunk write back via $executeRaw.
    for (let i = 0; i < candidates.length; i += 1) {
      const c = candidates[i];
      const vec = vectors[i];
      processed += 1;
      cursor = c.id;
      if (!vec || vec.length === 0) {
        failed += 1;
        continue;
      }
      try {
        const lit = vectorLiteral(vec);
        await client.$executeRaw`
          UPDATE evidence_semantic_chunks
             SET embedding_vector     = ${lit}::vector,
                 embedding_provider   = ${provider.name},
                 embedding_model      = ${provider.model},
                 embedding_dimensions = ${provider.dimensions}::int
           WHERE id = ${c.id}::uuid
             AND team_id = ${input.workspaceId}::uuid
        `;
        const tokens = estimateTokensFromChars(c.chunkText.length);
        await recordSemanticChunkEmbedded(client, {
          workspaceId: input.workspaceId,
          chunkId: c.id,
          tokens,
          eur: estimateEurFromTokens(tokens),
        });
        succeeded += 1;
      } catch (err) {
        failed += 1;
        logEmbeddingFailure({
          status: "failed",
          errorCode:
            err instanceof Error
              ? `BACKFILL_WRITE:${err.name}`
              : "BACKFILL_WRITE",
          workspaceId: input.workspaceId,
          chunkId: c.id,
        });
      }
    }

    if (candidates.length < batchSize) break;
  }

  return {
    processed,
    succeeded,
    failed,
    skippedReason: dryRun && skippedReason === null
      ? "DRY_RUN_COMPLETED"
      : skippedReason,
    nextCursorChunkId: cursor,
    durationMs: Date.now() - startedAt,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  const v = Math.floor(Number.isFinite(n) ? n : lo);
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
