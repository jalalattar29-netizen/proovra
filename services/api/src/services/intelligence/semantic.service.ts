/**
 * Phase 15 — Semantic search foundation.
 *
 * Architecture-only this phase. When `SEMANTIC_SEARCH_ENABLED=true`
 * and a provider is wired, the service stores chunks + embeddings
 * and performs nearest-neighbour search. Without a provider, every
 * call returns an empty result + a stable `enabled: false` signal so
 * the UI can render a clear "not configured" state.
 *
 * The brief is explicit: DO NOT fake semantic search. This file
 * ships the contract + safe fallback only.
 */

import type {
  EvidenceSemanticChunk as DbChunk,
  PrismaClient,
} from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
// Phase 16 — after chunk persistence the live indexing path enqueues
// an `mi-embed` job so the dedicated worker fills the pgvector
// `embedding_vector` column. The legacy in-process `embed()` call
// below still writes the Bytes column for back-compat with the
// keyword-fallback ranker; the queue handles the pgvector side.
import { enqueueEmbedChunks } from "../../queue/mi-embed-queue.js";
import { evaluateWorkspaceAiPolicy } from "../ai/workspace-ai-policy.service.js";

export function isSemanticSearchEnabled(): boolean {
  return process.env.SEMANTIC_SEARCH_ENABLED === "true";
}

// Phase P7 — the legacy in-process EmbeddingProvider seam
// (setEmbeddingProvider/activeProvider) was REMOVED. The canonical embedding
// path is the mi-embed worker + services/search/embedding-provider.ts; this
// service only chunks + enqueues (policy-gated).

// -----------------------------------------------------------------------------
// Indexing — store chunks. Embeddings are populated only when both
// the feature flag is on AND a provider is configured. Otherwise the
// chunks are persisted without vectors so a future provider can
// backfill.
// -----------------------------------------------------------------------------

const DEFAULT_CHUNK_BYTES = 1500;

function chunkText(text: string, chunkBytes = DEFAULT_CHUNK_BYTES): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkBytes) {
    chunks.push(text.slice(i, i + chunkBytes));
  }
  return chunks;
}

export type IndexInput = {
  evidenceId: string;
  teamId: string;
  text: string;
};

/**
 * Persist chunks for the given evidence + replace any prior chunks
 * (delete-then-create) so re-indexing is deterministic. Skipped
 * silently when text is empty.
 */
export async function indexEvidenceText(
  input: IndexInput,
  client: PrismaClient = defaultPrisma,
): Promise<{ chunks: number; embedded: number }> {
  if (!input.text || input.text.trim().length === 0) {
    return { chunks: 0, embedded: 0 };
  }
  const chunks = chunkText(input.text);
  const newChunkIds: string[] = [];
  try {
    await client.evidenceSemanticChunk.deleteMany({
      where: { evidenceId: input.evidenceId },
    });
    let embedded = 0;
    for (let i = 0; i < chunks.length; i += 1) {
      let embedding: Uint8Array<ArrayBuffer> | null = null;
      // Phase P7 — inline embedding removed; the mi-embed worker (canonical,
      // policy-gated) fills vectors asynchronously after enqueue below.
      const providerName: string | null = null;
      const modelName: string | null = null;
      const dimensions: number | null = null;
      const row = await client.evidenceSemanticChunk.create({
        data: {
          evidenceId: input.evidenceId,
          teamId: input.teamId,
          chunkIndex: i,
          chunkText: chunks[i],
          embeddingProvider: providerName,
          embeddingModel: modelName,
          embeddingDimensions: dimensions,
          embedding,
        },
        select: { id: true },
      });
      newChunkIds.push(row.id);
    }
    // Phase 16 — enqueue the dedicated mi-embed job so the worker
    // fills the pgvector `embedding_vector` column. Best-effort:
    // a failed enqueue MUST NOT bubble out of indexEvidenceText
    // (the safety-net backfill in search-indexing.processor catches
    // any drift on the next reindex pass).
    if (input.teamId && newChunkIds.length > 0) {
      try {
        // Phase A2 — workspace AI policy gate: a workspace that disabled
        // semantic search must not have its chunks embedded/sent outbound.
        const semPolicy = await evaluateWorkspaceAiPolicy({
          teamId: input.teamId,
          feature: "SEMANTIC_SEARCH",
          dataClass: "DERIVED_CONTENT",
        });
        if (!semPolicy.allowed) {
          return { chunks: chunks.length, embedded };
        }
        await enqueueEmbedChunks({
          teamId: input.teamId,
          chunkIds: newChunkIds,
          reason: "live_indexing",
        });
      } catch (err) {
        try {
          // eslint-disable-next-line no-console
          console.warn(
            JSON.stringify({
              kind: "semantic.embedding.enqueue_failed",
              evidenceId: input.evidenceId.slice(0, 64),
              workspaceId: input.teamId.slice(0, 64),
              chunkCount: newChunkIds.length,
              errorCode:
                err instanceof Error
                  ? err.name.slice(0, 64)
                  : "ENQUEUE_FAILED",
            }),
          );
        } catch {
          /* logging best-effort */
        }
      }
    }
    return { chunks: chunks.length, embedded };
  } catch {
    return { chunks: 0, embedded: 0 };
  }
}

// -----------------------------------------------------------------------------
// Search — returns matching chunks. When semantic is disabled OR no
// provider is configured, returns a stable empty result with the
// `enabled` flag so the UI can render "not configured" instead of a
// misleading empty hit list.
// -----------------------------------------------------------------------------

// Phase P7 — legacy in-process searchSemantic REMOVED. The canonical
// semantic retrieval is the hybrid ranker in
// services/search/evidence-search.service.ts (pgvector, tenant-scoped).

export async function listChunksForEvidence(
  evidenceId: string,
  client: PrismaClient = defaultPrisma,
): Promise<DbChunk[]> {
  return client.evidenceSemanticChunk.findMany({
    where: { evidenceId },
    orderBy: { chunkIndex: "asc" },
  });
}
