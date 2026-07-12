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

export type EmbeddingProvider = {
  name: string;
  model: string;
  dimensions: number;
  embed(input: string): Promise<Float32Array>;
};

let activeProvider: EmbeddingProvider | null = null;

export function setEmbeddingProvider(
  p: EmbeddingProvider | null,
): () => void {
  const prev = activeProvider;
  activeProvider = p;
  return () => {
    activeProvider = prev;
  };
}

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
      let providerName: string | null = null;
      let modelName: string | null = null;
      let dimensions: number | null = null;
      if (isSemanticSearchEnabled() && activeProvider) {
        try {
          const v = await activeProvider.embed(chunks[i]);
          // Copy into a fresh ArrayBuffer-backed Uint8Array; Prisma's
          // Bytes column types reject ArrayBufferLike (covers
          // SharedArrayBuffer) outright.
          const copy = new Uint8Array(v.byteLength);
          copy.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
          embedding = copy;
          providerName = activeProvider.name;
          modelName = activeProvider.model;
          dimensions = activeProvider.dimensions;
          embedded += 1;
        } catch {
          /* embedding optional; chunk still persists */
        }
      }
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

export type SemanticSearchInput = {
  teamId: string;
  q: string;
  limit?: number;
};

export type SemanticSearchResult = {
  enabled: boolean;
  hits: Array<{
    evidenceId: string;
    chunkIndex: number;
    score: number;
    snippet: string;
  }>;
};

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export async function searchSemantic(
  input: SemanticSearchInput,
  client: PrismaClient = defaultPrisma,
): Promise<SemanticSearchResult> {
  if (!isSemanticSearchEnabled() || !activeProvider) {
    return { enabled: false, hits: [] };
  }
  let queryVec: Float32Array;
  try {
    queryVec = await activeProvider.embed(input.q);
  } catch {
    return { enabled: true, hits: [] };
  }
  const candidates = await client.evidenceSemanticChunk.findMany({
    where: {
      teamId: input.teamId,
      embeddingProvider: activeProvider.name,
      embeddingModel: activeProvider.model,
      embeddingDimensions: activeProvider.dimensions,
      embedding: { not: null },
    },
    select: {
      evidenceId: true,
      chunkIndex: true,
      chunkText: true,
      embedding: true,
    },
    take: 2000,
  });

  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
  const scored = candidates
    .map((c) => {
      if (!c.embedding) return null;
      const peer = new Float32Array(
        c.embedding.buffer,
        c.embedding.byteOffset,
        c.embedding.byteLength / Float32Array.BYTES_PER_ELEMENT,
      );
      const score = cosine(queryVec, peer);
      return {
        evidenceId: c.evidenceId,
        chunkIndex: c.chunkIndex,
        score,
        snippet: c.chunkText.slice(0, 300),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return { enabled: true, hits: scored };
}

export async function listChunksForEvidence(
  evidenceId: string,
  client: PrismaClient = defaultPrisma,
): Promise<DbChunk[]> {
  return client.evidenceSemanticChunk.findMany({
    where: { evidenceId },
    orderBy: { chunkIndex: "asc" },
  });
}
