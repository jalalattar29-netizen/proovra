/**
 * Phase 16 — mi-embed worker processor.
 *
 * Consumes `mi-embed` jobs and writes vectors into the pgvector
 * `embedding_vector` column on `evidence_semantic_chunks`. Each job
 * carries a bounded list of chunk ids + the owning workspace id +
 * a bounded `reason`.
 *
 * Hard contracts:
 *   - Workspace-scoped: every SQL operation includes the team_id
 *     parameter. A chunk belonging to a different workspace cannot
 *     be written by this processor.
 *   - Budget aware: `canEmbedMore` is consulted BEFORE issuing the
 *     provider call. Hitting the daily cap or monthly EUR budget
 *     completes the job gracefully (NOT a failure — chunks stay
 *     keyword-searchable and the next safety-net pass will retry
 *     when the cap resets).
 *   - NEVER logs raw chunk text. Bounded counts + ids + reasons.
 *   - On provider error: logs the bounded error code + chunk count
 *     and rethrows so BullMQ retries (attempts: 3, exp backoff).
 *     Last failure dies; the chunks remain unembedded but the
 *     keyword index is unaffected.
 *   - Reuses the SHARED prisma instance via ./db.js; never
 *     instantiates its own client.
 */

import type { Job } from "bullmq";

import { prisma } from "./db.js";
import { logger } from "./logger.js";
import type { MiEmbedJobPayload } from "./queue.js";

type ProviderHandle = {
  name: string;
  model: string;
  dimensions: number;
  embedBatch(texts: string[]): Promise<Array<Float32Array | null>>;
};

let cachedProvider: ProviderHandle | null | undefined;

/**
 * Worker-side embedding provider resolver. We CANNOT import the API
 * package directly (monorepo boundary), so we mirror the gate
 * semantics + dispatch to the openai SDK when configured.
 *
 * Mirrors the API factory rules exactly:
 *   - SEMANTIC_SEARCH_ENABLED !== "true" → null (no work happens)
 *   - provider=local-deterministic → in-process hash provider
 *   - provider=openai + outbound + api key → real OpenAI client
 *   - else → null
 */
async function resolveProvider(): Promise<ProviderHandle | null> {
  if (cachedProvider !== undefined) return cachedProvider;
  if (process.env.SEMANTIC_SEARCH_ENABLED !== "true") {
    cachedProvider = null;
    return null;
  }
  const raw = (process.env.SEMANTIC_EMBEDDINGS_PROVIDER ?? "disabled")
    .trim()
    .toLowerCase();
  const dimEnv = Number.parseInt(
    process.env.SEMANTIC_EMBEDDING_DIMENSIONS ?? "0",
    10,
  );
  const model =
    process.env.SEMANTIC_EMBEDDING_MODEL?.trim() || "text-embedding-3-small";
  if (raw === "local" || raw === "local-deterministic" || raw === "test") {
    const dim = Number.isFinite(dimEnv) && dimEnv > 0 ? Math.min(dimEnv, 1536) : 384;
    cachedProvider = makeLocalDeterministicProvider(dim);
    return cachedProvider;
  }
  if (raw === "openai") {
    if (process.env.SEMANTIC_EMBEDDINGS_SEND_CONTENT_OUTBOUND !== "true") {
      cachedProvider = null;
      return null;
    }
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      cachedProvider = null;
      return null;
    }
    try {
      const mod = (await import("openai")) as {
        default: new (config: { apiKey: string }) => unknown;
        OpenAI?: new (config: { apiKey: string }) => unknown;
      };
      const Ctor = mod.default ?? mod.OpenAI;
      if (!Ctor) {
        cachedProvider = null;
        return null;
      }
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
      const dim = Number.isFinite(dimEnv) && dimEnv > 0 ? dimEnv : 1536;
      cachedProvider = {
        name: "openai",
        model,
        dimensions: dim,
        async embedBatch(texts: string[]) {
          if (texts.length === 0) return [];
          const controller = new AbortController();
          const timer = setTimeout(
            () => controller.abort(),
            Math.max(
              1_000,
              Number.parseInt(
                process.env.SEMANTIC_EMBEDDINGS_TIMEOUT_MS ?? "30000",
                10,
              ),
            ),
          );
          try {
            const resp = await client.embeddings.create(
              { model, input: texts, dimensions: dim },
              { signal: controller.signal },
            );
            return texts.map((_t, i) => {
              const vec = resp.data[i]?.embedding;
              return Array.isArray(vec) && vec.length > 0
                ? Float32Array.from(vec)
                : null;
            });
          } finally {
            clearTimeout(timer);
          }
        },
      };
      return cachedProvider;
    } catch {
      cachedProvider = null;
      return null;
    }
  }
  cachedProvider = null;
  return null;
}

function makeLocalDeterministicProvider(dimensions: number): ProviderHandle {
  return {
    name: "local-deterministic",
    model: "sha256-bucket",
    dimensions,
    async embedBatch(texts: string[]) {
      const crypto = await import("node:crypto");
      return texts.map((t) => {
        const safe = (t ?? "").slice(0, 8 * 1024);
        const vec = new Float32Array(dimensions);
        const tokens = safe
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter(Boolean);
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
      });
    },
  };
}

// --------------------------------------------------------------------------
// Daily-cap helpers — kept inline in the worker (mirrors the API service
// without cross-package import). The DB schema is the source of truth.
// --------------------------------------------------------------------------

function dailyChunkCap(): number {
  const raw = process.env.SEMANTIC_MAX_CHUNKS_PER_WORKSPACE_PER_DAY;
  const v = raw ? Number.parseInt(raw, 10) : 5_000;
  return Number.isFinite(v) && v >= 0 ? v : 5_000;
}

function monthlyBudgetEur(): number {
  const raw = process.env.SEMANTIC_MONTHLY_BUDGET_EUR;
  const v = raw ? Number.parseFloat(raw) : 100;
  return Number.isFinite(v) && v >= 0 ? v : 100;
}

function dateUtcMidnight(): Date {
  const at = new Date();
  return new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()),
  );
}

function firstOfMonthUtc(): Date {
  const at = new Date();
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

async function canEmbedMore(
  workspaceId: string,
  additional: number,
): Promise<{
  allowed: boolean;
  reason: "DAILY_CAP" | "MONTHLY_BUDGET" | null;
}> {
  const dailyCap = dailyChunkCap();
  const monthlyCap = monthlyBudgetEur();
  if (dailyCap <= 0 && monthlyCap <= 0) return { allowed: true, reason: null };
  try {
    const today = dateUtcMidnight();
    const monthStart = firstOfMonthUtc();
    const [todayRow, monthRows] = await Promise.all([
      prisma.semanticUsageDaily.findUnique({
        where: {
          workspaceId_dateUtc: { workspaceId, dateUtc: today },
        },
        select: { chunksEmbedded: true, eurSpentMicros: true },
      }),
      prisma.semanticUsageDaily.findMany({
        where: { workspaceId, dateUtc: { gte: monthStart } },
        select: { chunksEmbedded: true, eurSpentMicros: true },
      }),
    ]);
    const todayChunks = todayRow?.chunksEmbedded ?? 0;
    const monthMicros = monthRows.reduce(
      (acc, r) => acc + (r.eurSpentMicros ?? 0n),
      0n,
    );
    const monthEur = Number(monthMicros) / 1_000_000;
    if (dailyCap > 0 && todayChunks + additional > dailyCap) {
      return { allowed: false, reason: "DAILY_CAP" };
    }
    if (monthlyCap > 0 && monthEur >= monthlyCap) {
      return { allowed: false, reason: "MONTHLY_BUDGET" };
    }
    return { allowed: true, reason: null };
  } catch {
    return { allowed: true, reason: null };
  }
}

function estimateTokens(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 1;
  return Math.max(1, Math.ceil(chars / 4));
}

function estimateEurMicros(tokens: number): bigint {
  const usdPerToken = Number.parseFloat(
    process.env.SEMANTIC_USD_PER_TOKEN ?? "0.00000002",
  );
  const eurPerUsd = Number.parseFloat(
    process.env.SEMANTIC_EUR_PER_USD ?? "0.92",
  );
  if (
    !Number.isFinite(usdPerToken) ||
    !Number.isFinite(eurPerUsd) ||
    tokens <= 0
  ) {
    return 0n;
  }
  return BigInt(Math.round(tokens * usdPerToken * eurPerUsd * 1_000_000));
}

async function recordUsage(
  workspaceId: string,
  tokens: number,
): Promise<void> {
  try {
    const today = dateUtcMidnight();
    const eurMicros = estimateEurMicros(tokens);
    await prisma.semanticUsageDaily.upsert({
      where: { workspaceId_dateUtc: { workspaceId, dateUtc: today } },
      update: {
        chunksEmbedded: { increment: 1 },
        tokensConsumed: { increment: BigInt(tokens) },
        eurSpentMicros: { increment: eurMicros },
      },
      create: {
        workspaceId,
        dateUtc: today,
        chunksEmbedded: 1,
        tokensConsumed: BigInt(tokens),
        eurSpentMicros: eurMicros,
      },
    });
  } catch {
    // Bounded log; never fail the job for a counter write.
  }
}

function vectorLiteral(vec: Float32Array): string {
  if (vec.length === 0 || vec.length > 4096) return "[]";
  const parts = new Array<string>(vec.length);
  for (let i = 0; i < vec.length; i += 1) {
    const v = vec[i];
    parts[i] = Number.isFinite(v) ? v.toFixed(6) : "0";
  }
  return `[${parts.join(",")}]`;
}

// --------------------------------------------------------------------------
// Processor
// --------------------------------------------------------------------------

export async function processMiEmbedJob(
  job: Job<MiEmbedJobPayload, void, string>,
): Promise<void> {
  const { teamId, chunkIds, reason } = job.data;
  if (!teamId || !chunkIds || chunkIds.length === 0) {
    logger.warn(
      { jobId: job.id ?? null, kind: "mi-embed" },
      "mi_embed.empty_payload_completed",
    );
    return;
  }
  const provider = await resolveProvider();
  if (!provider) {
    // Provider not configured — chunks remain keyword-only. Drain
    // the queue cleanly rather than failing.
    logger.info(
      {
        jobId: job.id ?? null,
        teamId,
        chunkCount: chunkIds.length,
        reason: reason ?? null,
      },
      "mi_embed.provider_disabled_completed",
    );
    return;
  }

  const gate = await canEmbedMore(teamId, chunkIds.length);
  if (!gate.allowed) {
    logger.warn(
      {
        jobId: job.id ?? null,
        teamId,
        chunkCount: chunkIds.length,
        reason: reason ?? null,
        blockedBy: gate.reason,
      },
      "mi_embed.budget_blocked_completed",
    );
    return;
  }

  // Load chunk text — workspace-scoped.
  const chunks = await prisma.evidenceSemanticChunk.findMany({
    where: {
      id: { in: chunkIds.slice(0, 200) },
      teamId,
    },
    select: { id: true, chunkText: true },
  });
  if (chunks.length === 0) {
    logger.info(
      { jobId: job.id ?? null, teamId, chunkCount: 0 },
      "mi_embed.no_chunks_completed",
    );
    return;
  }

  let succeeded = 0;
  let failed = 0;
  let vectors: Array<Float32Array | null>;
  try {
    vectors = await provider.embedBatch(chunks.map((c) => c.chunkText));
  } catch (err) {
    // Provider configuration / fatal error — let BullMQ retry.
    logger.error(
      {
        jobId: job.id ?? null,
        teamId,
        chunkCount: chunks.length,
        errorCode:
          err instanceof Error
            ? (err as Error & { code?: string }).code ?? "EMBED_BATCH_FAILED"
            : "EMBED_BATCH_FAILED",
      },
      "mi_embed.batch_failed",
    );
    throw err;
  }

  for (let i = 0; i < chunks.length; i += 1) {
    const c = chunks[i];
    const vec = vectors[i];
    if (!vec || vec.length === 0) {
      failed += 1;
      continue;
    }
    try {
      const lit = vectorLiteral(vec);
      await prisma.$executeRaw`
        UPDATE evidence_semantic_chunks
           SET embedding_vector     = ${lit}::vector,
               embedding_provider   = ${provider.name},
               embedding_model      = ${provider.model},
               embedding_dimensions = ${provider.dimensions}::int
         WHERE id = ${c.id}::uuid
           AND team_id = ${teamId}::uuid
      `;
      await recordUsage(teamId, estimateTokens(c.chunkText.length));
      succeeded += 1;
    } catch (err) {
      failed += 1;
      logger.warn(
        {
          jobId: job.id ?? null,
          teamId,
          chunkId: c.id,
          errorCode:
            err instanceof Error
              ? err.name
              : "EMBED_WRITE_FAILED",
        },
        "mi_embed.write_failed",
      );
    }
  }

  logger.info(
    {
      jobId: job.id ?? null,
      teamId,
      reason: reason ?? null,
      processed: chunks.length,
      succeeded,
      failed,
    },
    "mi_embed.completed",
  );
}
