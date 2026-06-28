/**
 * Phase 15 — Text extraction provider abstraction.
 *
 * Pluggable foundation for OCR + transcript. Default providers are
 * no-ops — they mark the job SKIPPED with `no_provider_configured`.
 * Wiring a real provider is a runtime configuration choice; the
 * surface contract is stable.
 *
 * RULES (from Phase 15 brief):
 *   - originals NEVER mutated
 *   - failures NEVER block uploads / review / governance
 *   - results stored ALONGSIDE evidence, never inside the forensic row
 *   - results are ADVISORY ("confidence" is just an operator hint)
 *
 * Env (only consulted; no hardcoded defaults):
 *   OCR_PROVIDER          — "noop" (default) | "tesseract" | "cloud"
 *   TRANSCRIPT_PROVIDER   — "noop" (default) | "whisper" | "cloud"
 */

import type {
  EvidenceExtractedText as DbExtractedText,
  EvidenceIntelligenceJob as DbJob,
  EvidenceIntelligenceJobKind,
  PrismaClient,
} from "@prisma/client";
import {
  AI_ADVISORY_DISCLAIMER,
  type ExtractedTextKind,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
// Phase 14 — Stage 2 re-index triggers. After an OCR / transcript
// extraction reaches COMPLETED, or after the regex-based entity
// extractor persists new candidate rows, the keyword search index
// must be refreshed so the new text + entity names become discoverable
// from the canonical /search surface. The enqueue is best-effort and
// MUST NOT block the parent COMPLETED write — see Phase 14 ground
// rules (Stage 2 audit-log constraints).
import { enqueueSearchIndexingJob } from "../../queue/search-queue.js";

const MAX_TEXT_BYTES = 5 * 1024 * 1024; // 5 MiB per extraction row

// -----------------------------------------------------------------------------
// Provider abstraction
// -----------------------------------------------------------------------------

export type ExtractionInput = {
  evidenceId: string;
  teamId: string;
  /**
   * Caller supplies the file MIME and optional pre-fetched bytes. The
   * service NEVER reads the original evidence file directly — the
   * worker does that. This keeps the API process insulated from
   * storage / IO concerns.
   */
  mimeType: string | null;
  /** Optional bytes (small files). Larger files go through the worker. */
  bytes?: Uint8Array | null;
};

export type ExtractionResult = {
  text: string | null;
  language: string | null;
  confidence: number | null;
  durationMs: number | null;
  providerVersion: string | null;
};

export type ExtractionProvider = {
  name: string;
  /** Returns the result on success, throws on transient failure. */
  extract(input: ExtractionInput): Promise<ExtractionResult>;
};

/**
 * Default no-op provider. Used when the operator has not configured
 * a real extraction engine. Marks every job SKIPPED with a clear
 * `no_provider_configured` summary so the operations UI surfaces the
 * gap without any silent data fabrication.
 */
const noopProvider: ExtractionProvider = {
  name: "noop",
  async extract(): Promise<ExtractionResult> {
    return {
      text: null,
      language: null,
      confidence: null,
      durationMs: 0,
      providerVersion: null,
    };
  },
};

let activeOcrProvider: ExtractionProvider = noopProvider;
let activeTranscriptProvider: ExtractionProvider = noopProvider;

export function setOcrProvider(p: ExtractionProvider): () => void {
  const prev = activeOcrProvider;
  activeOcrProvider = p;
  return () => {
    activeOcrProvider = prev;
  };
}

export function setTranscriptProvider(p: ExtractionProvider): () => void {
  const prev = activeTranscriptProvider;
  activeTranscriptProvider = p;
  return () => {
    activeTranscriptProvider = prev;
  };
}

export function configuredOcrProviderName(): string {
  return (
    process.env.OCR_PROVIDER?.trim() ||
    (activeOcrProvider.name !== "noop" ? activeOcrProvider.name : "noop")
  );
}

export function configuredTranscriptProviderName(): string {
  return (
    process.env.TRANSCRIPT_PROVIDER?.trim() ||
    (activeTranscriptProvider.name !== "noop"
      ? activeTranscriptProvider.name
      : "noop")
  );
}

// -----------------------------------------------------------------------------
// Job lifecycle
// -----------------------------------------------------------------------------

export async function enqueueIntelligenceJob(
  input: {
    evidenceId: string;
    teamId: string;
    kind: EvidenceIntelligenceJobKind;
    provider?: string | null;
  },
  client: PrismaClient = defaultPrisma,
): Promise<DbJob | null> {
  try {
    // Idempotency: skip if there's an in-flight job of the same kind.
    const existing = await client.evidenceIntelligenceJob.findFirst({
      where: {
        evidenceId: input.evidenceId,
        kind: input.kind,
        status: { in: ["PENDING", "PROCESSING"] },
      },
      orderBy: { createdAt: "desc" },
    });
    if (existing) return existing;
    return await client.evidenceIntelligenceJob.create({
      data: {
        evidenceId: input.evidenceId,
        teamId: input.teamId,
        kind: input.kind,
        status: "PENDING",
        provider: input.provider ?? null,
        scheduledAtUtc: new Date(),
      },
    });
  } catch {
    return null;
  }
}

/**
 * Run extraction inline (for callers that already have bytes in
 * memory; e.g. small image / PDF previews). Idempotent: a row with
 * matching (evidenceId, kind, provider) is upserted.
 *
 * Failures NEVER throw — the job + extracted_text rows are written
 * with FAILED status so operators see the gap.
 */
export async function runExtractionInline(
  input: ExtractionInput & {
    kind: ExtractedTextKind;
    jobKind: EvidenceIntelligenceJobKind;
  },
  client: PrismaClient = defaultPrisma,
): Promise<DbExtractedText | null> {
  const provider =
    input.jobKind === "OCR" ? activeOcrProvider : activeTranscriptProvider;
  const startedAt = Date.now();
  let job: DbJob | null = null;
  try {
    job = await client.evidenceIntelligenceJob.create({
      data: {
        evidenceId: input.evidenceId,
        teamId: input.teamId,
        kind: input.jobKind,
        status: "PROCESSING",
        provider: provider.name,
        startedAtUtc: new Date(),
      },
    });
  } catch {
    /* best-effort */
  }

  // No-op provider → SKIPPED row.
  if (provider.name === "noop") {
    const row = await client.evidenceExtractedText.create({
      data: {
        evidenceId: input.evidenceId,
        teamId: input.teamId,
        kind: input.kind,
        status: "SKIPPED",
        provider: "noop",
        errorMessage: "no_provider_configured",
        extractedAtUtc: new Date(),
      },
    });
    if (job) {
      await client.evidenceIntelligenceJob.update({
        where: { id: job.id },
        data: {
          status: "SKIPPED",
          completedAtUtc: new Date(),
          lastError: "no_provider_configured",
        },
      });
    }
    return row;
  }

  let result: ExtractionResult;
  try {
    result = await provider.extract(input);
  } catch (err) {
    const msg =
      err instanceof Error ? err.message.slice(0, 200) : "extraction_failed";
    const failed = await client.evidenceExtractedText.create({
      data: {
        evidenceId: input.evidenceId,
        teamId: input.teamId,
        kind: input.kind,
        status: "FAILED",
        provider: provider.name,
        errorMessage: msg,
      },
    });
    if (job) {
      await client.evidenceIntelligenceJob.update({
        where: { id: job.id },
        data: {
          status: "FAILED",
          completedAtUtc: new Date(),
          attemptCount: { increment: 1 },
          lastError: msg,
        },
      });
    }
    return failed;
  }

  const truncated =
    typeof result.text === "string" && result.text.length > MAX_TEXT_BYTES
      ? result.text.slice(0, MAX_TEXT_BYTES)
      : result.text;
  const wordCount =
    truncated && truncated.length > 0
      ? truncated.split(/\s+/).filter(Boolean).length
      : 0;

  const completed = await client.evidenceExtractedText.create({
    data: {
      evidenceId: input.evidenceId,
      teamId: input.teamId,
      kind: input.kind,
      status: "COMPLETED",
      provider: provider.name,
      providerVersion: result.providerVersion ?? null,
      language: result.language ?? null,
      text: truncated ?? null,
      confidence: result.confidence ?? null,
      wordCount,
      durationMs: result.durationMs ?? Date.now() - startedAt,
      extractedAtUtc: new Date(),
    },
  });
  if (job) {
    await client.evidenceIntelligenceJob.update({
      where: { id: job.id },
      data: {
        status: "COMPLETED",
        completedAtUtc: new Date(),
      },
    });
  }

  // Phase 14 — Stage 2 trigger #1 / #2. The keyword search projection
  // pulls EvidenceExtractedText rows of status COMPLETED into the
  // indexed `searchableText` column (see evidence-indexing.service.ts
  // Phase 13 projection). Without an explicit re-index after a
  // COMPLETED upsert the new text would stay invisible to /search
  // until the next evidence_completed boundary fires (which may never
  // happen for OCR/transcript-only updates on an already-finalised
  // evidence record).
  //
  // Hard rules (Phase 14 ground rules):
  //   * Best-effort: failure MUST NOT block the parent COMPLETED write.
  //   * No raw OCR/transcript text in the catch arm — only the
  //     evidenceId + reason + bounded error code reach the logs.
  //   * Idempotent: enqueueSearchIndexingJob uses a deterministic
  //     jobId keyed on (kind, sourceId), so concurrent triggers
  //     collapse to a single job.
  //   * teamId may be null on legacy rows — only enqueue when present
  //     since the search projection is team-anchored.
  if (input.teamId) {
    try {
      const reason =
        input.jobKind === "OCR" ? "ocr_completed" : "transcript_completed";
      await enqueueSearchIndexingJob({
        teamId: input.teamId,
        kind: "evidence",
        sourceId: input.evidenceId,
        reason,
      });
    } catch {
      /* Phase 14 — best-effort; never block the COMPLETED write. */
    }
  }

  // Phase 11 — connect-only entity-extraction trigger (do-not-duplicate
  // audit, §3.3). When a text extraction succeeds, hand the text to the
  // existing regex-based extractor so entity rows materialise without
  // requiring a separate scan job. The extractor is idempotent
  // (de-dupes on (kind, normalizedValue) within the (evidence, source)
  // scope), so re-runs are safe. Wrapped in try/catch — entity
  // extraction is advisory and never blocks the extraction-text write.
  //
  // Phase 14 — Stage 2 trigger #3. After the entity-extraction call
  // returns persisted rows, we fire a second `enqueueSearchIndexingJob`
  // with reason "entities_extracted" so the indexer can pull the
  // newly-materialised EvidenceEntity rows into the searchable entity-
  // name chunks (Phase 13 search-indexer projection). Best-effort +
  // never blocks the parent write.
  if (truncated && truncated.length > 0) {
    try {
      const { extractAndPersistEntities } = await import(
        "./entity-extraction.service.js"
      );
      const source =
        input.jobKind === "OCR" ? "OCR" : "TRANSCRIPT";
      const persisted = await extractAndPersistEntities(
        {
          evidenceId: input.evidenceId,
          teamId: input.teamId,
          text: truncated,
          source,
        },
        client,
      );
      if (persisted.length > 0 && input.teamId) {
        try {
          await enqueueSearchIndexingJob({
            teamId: input.teamId,
            kind: "evidence",
            sourceId: input.evidenceId,
            reason: "entities_extracted",
          });
        } catch {
          /* Phase 14 — best-effort; never block the COMPLETED write. */
        }
      }
    } catch {
      /* entity extraction is best-effort; advisory only */
    }
  }

  return completed;
}

// -----------------------------------------------------------------------------
// Read helpers (governance-aware caller is responsible for any
// redaction; this layer just returns raw rows).
// -----------------------------------------------------------------------------

export async function listExtractedTexts(
  evidenceId: string,
  client: PrismaClient = defaultPrisma,
): Promise<DbExtractedText[]> {
  return client.evidenceExtractedText.findMany({
    where: { evidenceId },
    orderBy: { createdAt: "desc" },
  });
}

export async function listIntelligenceJobs(
  input: {
    teamId: string;
    status?: import("@prisma/client").EvidenceIntelligenceJobStatus;
    kind?: EvidenceIntelligenceJobKind;
    limit?: number;
  },
  client: PrismaClient = defaultPrisma,
): Promise<DbJob[]> {
  return client.evidenceIntelligenceJob.findMany({
    where: {
      teamId: input.teamId,
      ...(input.status ? { status: input.status } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(input.limit ?? 50, 1), 200),
  });
}

// -----------------------------------------------------------------------------
// Safe projection — strips raw text from list views; full text only
// surfaces via the per-evidence read endpoint.
// -----------------------------------------------------------------------------

export function projectExtractedTextSummary(row: DbExtractedText): {
  id: string;
  evidenceId: string;
  kind: string;
  status: string;
  provider: string;
  providerVersion: string | null;
  language: string | null;
  confidence: number | null;
  wordCount: number | null;
  extractedAtUtc: string | null;
  // Deliberately no `text` field; use the detail endpoint.
  disclaimer: string;
} {
  return {
    id: row.id,
    evidenceId: row.evidenceId,
    kind: row.kind,
    status: row.status,
    provider: row.provider,
    providerVersion: row.providerVersion,
    language: row.language,
    confidence: row.confidence,
    wordCount: row.wordCount,
    extractedAtUtc: row.extractedAtUtc?.toISOString() ?? null,
    disclaimer: AI_ADVISORY_DISCLAIMER,
  };
}

export function projectExtractedTextDetail(row: DbExtractedText): {
  id: string;
  evidenceId: string;
  kind: string;
  status: string;
  provider: string;
  text: string | null;
  wordCount: number | null;
  confidence: number | null;
  disclaimer: string;
} {
  return {
    id: row.id,
    evidenceId: row.evidenceId,
    kind: row.kind,
    status: row.status,
    provider: row.provider,
    text: row.text,
    wordCount: row.wordCount,
    confidence: row.confidence,
    disclaimer: AI_ADVISORY_DISCLAIMER,
  };
}

export function projectIntelligenceJob(row: DbJob): {
  id: string;
  evidenceId: string;
  teamId: string | null;
  kind: string;
  status: string;
  provider: string | null;
  attemptCount: number;
  lastError: string | null;
  scheduledAtUtc: string | null;
  startedAtUtc: string | null;
  completedAtUtc: string | null;
  createdAt: string;
} {
  return {
    id: row.id,
    evidenceId: row.evidenceId,
    teamId: row.teamId,
    kind: row.kind,
    status: row.status,
    provider: row.provider,
    attemptCount: row.attemptCount,
    lastError: row.lastError,
    scheduledAtUtc: row.scheduledAtUtc?.toISOString() ?? null,
    startedAtUtc: row.startedAtUtc?.toISOString() ?? null,
    completedAtUtc: row.completedAtUtc?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
