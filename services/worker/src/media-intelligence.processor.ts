/**
 * Phase 31.6 — Async media intelligence processor.
 *
 * Dedicated BullMQ worker processor for `mediaIntelligenceQueue`.
 * Consumes `{ teamId, evidenceId, kind, runId? }` jobs and invokes
 * the appropriate deterministic analyzer / wire-up.
 *
 * Hard custody / stability rules:
 *
 *   * Imports the SHARED Prisma instance from `./db.js` — NEVER
 *     constructs its own. Bare `new PrismaClient()` at module load
 *     was the exact bug that caused the worker hotfix; the
 *     `worker-bootstrap-hotfix.test.ts` source-contract test
 *     enforces this for every worker file.
 *   * NEVER throws to BullMQ on an analyzer FAILURE. We mark the
 *     run FAILED with a bounded error summary + return success-from-
 *     queue-perspective so BullMQ doesn't infinitely retry a job
 *     whose underlying analyzer determined it can't proceed (e.g.
 *     evidence not found). We DO throw on transient `tracker_unavailable`
 *     so BullMQ applies exponential backoff per the queue config.
 *   * NEVER blocks evidence lifecycle. Every error path is
 *     non-fatal to the platform — at worst, a run row sits in
 *     FAILED until an operator inspects.
 *   * Job payload is bounded: `{ teamId, evidenceId, kind }` only.
 *     No raw evidence content, no storage internals, no GPS, no
 *     private notes.
 *
 * Job kinds supported this session:
 *   * `analyze_metadata` — runs the deterministic analyzer (all
 *     synchronous heuristics from Phase 31.5).
 *   * `wire_ocr_transcript` — same analyzer (the analyzer covers
 *     OCR/transcript availability detection too).
 *   * `reconcile` — invokes the analyzer + marks run COMPLETED.
 *
 * Job kinds RESERVED (job kind accepted, processor immediately
 * marks the run COMPLETED with "deferred" note so the queue
 * drains cleanly without retries):
 *   * `extract_assets` — derived asset generation (sharp/ffmpeg)
 *   * `compute_duplicates` / `compute_lineage` — already covered
 *     by the synchronous analyzer in Phase 31.5; reserved for
 *     future perceptual-hashing work
 *   * `reindex` — search projection rebuild (reserved)
 */

import type { Job } from "bullmq";
import { prisma } from "./db.js";
import { logger } from "./logger.js";
import type { MediaIntelligenceJobPayload } from "./queue.js";
import { getObjectRange } from "./storage.js";

// Phase 13 — text-similarity confidence bands (LOW < 0.30, MEDIUM
// 0.30-0.60, HIGH > 0.60). Mirrors the synthesis constraint. Only
// rows scoring >= MEDIUM_BAND get promoted to a SIMILAR_TO graph edge.
const TEXT_SIM_LOW_BAND = 0.30;
const TEXT_SIM_HIGH_BAND = 0.60;
// Bound how many promotions we do per job — keeps the queue handler
// short and predictable. Producer can re-enqueue if more land later.
const TEXT_SIM_PROMOTE_MAX = 50;

// EXIF data lives in the first few KB of a JPEG/TIFF. 256KB is a
// safe ceiling that covers HEIC/RAW thumbnails too without
// downloading whole multi-MB originals on every analyzer pass.
const EXIF_RANGE_BYTES = 256 * 1024;

// Lazy-imported metrics bump — kept in a tiny indirection so this
// module stays decoupled from the API's metrics registry shape at
// import time. The worker shares the metrics catalog name list with
// the API process; the in-memory registries are separate by design.
async function tryBump(
  name:
    | "media_intelligence_processor_started_total"
    | "media_intelligence_processor_completed_total"
    | "media_intelligence_processor_failed_total"
    | "media_intelligence_processor_deferred_total"
    | "media_intelligence_dlq_total",
): Promise<void> {
  try {
    const mod = await import(
      "@proovra/shared-runtime/ops"
    );
    mod.bump(name);
  } catch {
    // Metrics module unavailable — never block a job over a counter.
  }
}

// =============================================================================
// Public surface — registered via safeRegisterWorker in index.ts
// =============================================================================

export async function processMediaIntelligenceJob(
  job: Job<MediaIntelligenceJobPayload>,
): Promise<{ ok: true; signalsEmitted: number; deferred?: boolean }> {
  const { teamId, evidenceId, kind, runId, evidencePartId } =
    job.data ?? ({} as MediaIntelligenceJobPayload);
  if (!teamId || !evidenceId || !kind) {
    // Malformed payload — log + return success so BullMQ doesn't
    // ballast on a structurally-invalid job. The producer's
    // payload validation already prevents this on the happy path.
    logger.warn(
      { jobId: job.id, kind, missing: { teamId: !teamId, evidenceId: !evidenceId, kind: !kind } },
      "media_intelligence.malformed_payload",
    );
    return { ok: true, signalsEmitted: 0 };
  }

  await tryBump("media_intelligence_processor_started_total");

  // Phase 31.8 — `extract_exif` branch. Fetches a bounded byte range
  // (first 256KB), runs the EXIF extractor library, persists the
  // bounded summary. Never blocks the evidence lifecycle: every
  // error path marks the run failed (if a runId is provided) and
  // returns success-from-queue so BullMQ doesn't infinitely retry
  // structural problems (missing part, fetch denied, etc).
  if (kind === "extract_exif") {
    return processExtractExifJob({
      jobId: job.id,
      teamId,
      evidenceId,
      evidencePartId: evidencePartId ?? null,
      runId: runId ?? null,
      attemptsMade: job.attemptsMade ?? 0,
      attemptsAllowed: job.opts?.attempts ?? 1,
    });
  }

  // Phase 12 — `compute_perceptual_hashes` branch. Downloads each
  // image part's bytes, derives pHash + dHash via sharp (already a
  // worker dependency), and writes the 16-hex-char hashes back to
  // evidence_parts. Non-image parts are skipped silently. Failures
  // never block the evidence lifecycle.
  if (kind === "compute_perceptual_hashes") {
    return processComputePerceptualHashesJob({
      jobId: job.id,
      teamId,
      evidenceId,
      evidencePartId: evidencePartId ?? null,
    });
  }

  // Phase 13 — text-similarity sub-branch on the `reconcile` job
  // kind. When the producer supplies a `textKind` of OCR or
  // TRANSCRIPT, the worker:
  //   1. runs the existing Phase 15 text-similarity detector
  //      (services/api/.../similarity.service.ts via lazy import),
  //      which writes EvidenceSimilarity rows of kind OCR_SIMILAR /
  //      TRANSCRIPT_SIMILAR;
  //   2. promotes the MEDIUM / HIGH band rows into SIMILAR_TO
  //      graph edges via UPSERT against investigation_graph_edges,
  //      back-referencing the resulting edge id on the
  //      EvidenceSimilarity row (one-way promotion only).
  // Errors here NEVER throw to BullMQ — returns success so the
  // queue drains cleanly; the run row (if any) is left for the
  // bottom-of-handler analyzer dispatch to settle.
  if (kind === "reconcile" && job.data?.textKind) {
    return processTextSimilarityPromotion({
      jobId: job.id,
      teamId,
      evidenceId,
      textKind: job.data.textKind,
    });
  }

  // Reserved job kinds — drain cleanly without retries. Each
  // returns success so BullMQ doesn't accumulate failures. The
  // run row (if any) stays in PENDING until the future processor
  // ships; operations can dismiss it manually.
  if (
    kind === "extract_assets" ||
    kind === "compute_duplicates" ||
    kind === "compute_lineage" ||
    kind === "reindex"
  ) {
    await tryBump("media_intelligence_processor_deferred_total");
    logger.info(
      { jobId: job.id, kind, evidenceId, teamId },
      "media_intelligence.kind_reserved_for_future_phase",
    );
    return { ok: true, signalsEmitted: 0, deferred: true };
  }

  // Lazy-import the analyzer + run tracker from services/api so the
  // worker doesn't need its own copy. The shared prisma instance
  // from ./db.js is passed in explicitly so the API code's default
  // (services/api/src/db.ts) is bypassed — keeps the worker
  // single-prisma-instance.
  let runMediaIntelligenceAnalysis: typeof import("@proovra/shared-runtime/media-intelligence")["runMediaIntelligenceAnalysis"];
  let markRunProcessing: typeof import("@proovra/shared-runtime/media-intelligence")["markRunProcessing"];
  let markRunCompleted: typeof import("@proovra/shared-runtime/media-intelligence")["markRunCompleted"];
  let markRunFailed: typeof import("@proovra/shared-runtime/media-intelligence")["markRunFailed"];
  try {
    ({ runMediaIntelligenceAnalysis } = await import(
      "@proovra/shared-runtime/media-intelligence"
    ));
    ({ markRunProcessing, markRunCompleted, markRunFailed } = await import(
      "@proovra/shared-runtime/media-intelligence"
    ));
  } catch (err) {
    // Module import itself failed (e.g. analyzer file moved). This
    // IS transient from BullMQ's perspective — throw so the queue
    // retries with backoff. The DLQ catches it after exhaustion.
    logger.error(
      { jobId: job.id, kind, err: err instanceof Error ? err.message : "unknown" },
      "media_intelligence.import_failed",
    );
    throw err;
  }

  // Transition run → PROCESSING (if a runId was supplied).
  if (runId) {
    const proc = await markRunProcessing(runId, teamId, prisma);
    if (!proc.ok) {
      if (proc.reason === "max_retries_exceeded") {
        // Permanent failure for this run. Return success so the
        // queue stops retrying; the run row carries the failure
        // state for operators to inspect.
        logger.warn(
          { jobId: job.id, runId, evidenceId, teamId },
          "media_intelligence.run_max_retries_exceeded",
        );
        return { ok: true, signalsEmitted: 0 };
      }
      // tracker_unavailable → throw so BullMQ retries with backoff.
      throw new Error(`run_tracker_unavailable: ${proc.reason}`);
    }
  }

  // Run the analyzer. It NEVER throws — returns a bounded result.
  const result = await runMediaIntelligenceAnalysis(
    { teamId, evidenceId },
    prisma,
  );

  if (!result.ok) {
    // Analyzer determined it can't proceed (evidence not found,
    // team mismatch, service unavailable). Mark run FAILED + return
    // success so BullMQ doesn't retry a structural problem.
    if (runId) {
      await markRunFailed(
        runId,
        teamId,
        `analyzer_${result.reason}`,
        prisma,
      );
    }
    await tryBump("media_intelligence_processor_failed_total");
    // If this was the last permitted attempt, also bump the DLQ
    // counter so SRE dashboards can distinguish "job had one bad
    // attempt" from "job exhausted retries and parked permanently."
    const attemptsAllowed = job.opts?.attempts ?? 1;
    if ((job.attemptsMade ?? 0) >= attemptsAllowed - 1) {
      await tryBump("media_intelligence_dlq_total");
    }
    logger.warn(
      { jobId: job.id, runId, evidenceId, teamId, reason: result.reason },
      "media_intelligence.analyzer_refused",
    );
    return { ok: true, signalsEmitted: 0 };
  }

  if (runId) {
    await markRunCompleted(runId, teamId, prisma);
  }
  await tryBump("media_intelligence_processor_completed_total");
  logger.info(
    {
      jobId: job.id,
      runId,
      evidenceId,
      teamId,
      kind,
      signalsEmitted: result.signalsEmitted,
    },
    "media_intelligence.job_completed",
  );
  return { ok: true, signalsEmitted: result.signalsEmitted };
}

// =============================================================================
// Phase 31.8 — extract_exif job branch
// =============================================================================

type ExtractExifInput = {
  jobId: string | undefined;
  teamId: string;
  evidenceId: string;
  evidencePartId: string | null;
  runId: string | null;
  attemptsMade: number;
  attemptsAllowed: number;
};

async function processExtractExifJob(
  input: ExtractExifInput,
): Promise<{ ok: true; signalsEmitted: number; deferred?: boolean }> {
  const { jobId, teamId, evidenceId, evidencePartId, runId } = input;

  // Lazy-import: keeps the worker free to start even if the API
  // package is being rebuilt. Failure to import is transient and
  // throws so BullMQ retries with backoff.
  let markRunProcessing: typeof import("@proovra/shared-runtime/media-intelligence")["markRunProcessing"];
  let markRunCompleted: typeof import("@proovra/shared-runtime/media-intelligence")["markRunCompleted"];
  let markRunFailed: typeof import("@proovra/shared-runtime/media-intelligence")["markRunFailed"];
  let extractExifSafe: typeof import("@proovra/shared-runtime/media-intelligence")["extractExifSafe"];
  let upsertExifSummary: typeof import("@proovra/shared-runtime/media-intelligence")["upsertExifSummary"];
  let recordExifSummaryFailure: typeof import("@proovra/shared-runtime/media-intelligence")["recordExifSummaryFailure"];
  try {
    ({ markRunProcessing, markRunCompleted, markRunFailed } = await import(
      "@proovra/shared-runtime/media-intelligence"
    ));
    ({ extractExifSafe } = await import(
      "@proovra/shared-runtime/media-intelligence"
    ));
    ({ upsertExifSummary, recordExifSummaryFailure } = await import(
      "@proovra/shared-runtime/media-intelligence"
    ));
  } catch (err) {
    logger.error(
      { jobId, err: err instanceof Error ? err.message : "unknown" },
      "media_intelligence.extract_exif.import_failed",
    );
    throw err;
  }

  // Move run to PROCESSING + bump attempt count. Same retry-bound
  // semantics as the analyze_metadata branch.
  if (runId) {
    const proc = await markRunProcessing(runId, teamId, prisma);
    if (!proc.ok) {
      if (proc.reason === "max_retries_exceeded") {
        await tryBump("media_intelligence_dlq_total");
        logger.warn(
          { jobId, runId, evidenceId, teamId },
          "media_intelligence.extract_exif.max_retries_exceeded",
        );
        return { ok: true, signalsEmitted: 0 };
      }
      throw new Error(`run_tracker_unavailable: ${proc.reason}`);
    }
  }

  // Look up the part(s) we need to extract. If a specific
  // evidencePartId was pinned, only that one. Otherwise enumerate
  // every part on the evidence (team-anchored so cross-tenant
  // enumeration is impossible).
  const parts = (await prisma.$queryRawUnsafe(
    `SELECT p."id", p."storage_bucket", p."storage_key",
            p."original_file_name", p."mime_type", p."sha256",
            p."size_bytes"
       FROM "evidence_parts" p
       JOIN "evidence" e ON e."id" = p."evidence_id"
       WHERE e."team_id" = $1
         AND e."id" = $2
         ${evidencePartId ? `AND p."id" = $3` : ""}`,
    ...(evidencePartId
      ? [teamId, evidenceId, evidencePartId]
      : [teamId, evidenceId]),
  )) as Array<{
    id: string;
    storage_bucket: string | null;
    storage_key: string | null;
    original_file_name: string | null;
    mime_type: string | null;
    sha256: string | null;
    size_bytes: bigint | number | null;
  }>;

  if (parts.length === 0) {
    if (runId) {
      await markRunFailed(runId, teamId, "no_parts_found", prisma);
    }
    await tryBump("media_intelligence_processor_failed_total");
    logger.warn(
      { jobId, teamId, evidenceId, evidencePartId },
      "media_intelligence.extract_exif.no_parts_found",
    );
    return { ok: true, signalsEmitted: 0 };
  }

  let succeeded = 0;
  let failed = 0;
  for (const part of parts) {
    // Skip non-image MIME types up-front so we don't waste an S3
    // fetch. The extractor will also refuse non-image MIME, but
    // checking here keeps the worker's S3 footprint minimal.
    if (
      !part.mime_type ||
      !part.mime_type.toLowerCase().startsWith("image/")
    ) {
      continue;
    }
    if (!part.storage_bucket || !part.storage_key) {
      await recordExifSummaryFailure(
        {
          teamId,
          evidenceId,
          evidencePartId: part.id,
          status: "FETCH_FAILED",
          lastError: "no_storage_reference",
        },
        prisma,
      );
      failed += 1;
      continue;
    }

    let bytes: Buffer | null = null;
    try {
      bytes = await getObjectRange({
        bucket: part.storage_bucket,
        key: part.storage_key,
        range: `bytes=0-${EXIF_RANGE_BYTES - 1}`,
      });
    } catch (err) {
      await recordExifSummaryFailure(
        {
          teamId,
          evidenceId,
          evidencePartId: part.id,
          status: "FETCH_FAILED",
          lastError: err instanceof Error ? err.message : "fetch_failed",
          extractedBytes: 0,
        },
        prisma,
      );
      failed += 1;
      continue;
    }

    const result = await extractExifSafe({
      bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      mimeType: part.mime_type,
      // Phase 31.8 — Default policy refuses raw GPS. The persistence
      // schema also lacks a column to store it; this is defence in
      // depth. A future RBAC-gated extraction job can re-run with
      // allow_raw_gps: true after a policy check.
      allowRawGps: false,
    });

    if (result.ok) {
      const persisted = await upsertExifSummary(
        {
          teamId,
          evidenceId,
          evidencePartId: part.id,
          summary: result.summary,
          extractedBytes: bytes.byteLength,
          status: "OK",
        },
        prisma,
      );
      if (persisted.ok) succeeded += 1;
      else failed += 1;
    } else {
      const statusMap = {
        empty_input: "EMPTY_INPUT",
        input_too_large: "INPUT_TOO_LARGE",
        unsupported_format: "UNSUPPORTED_FORMAT",
        parse_failed: "PARSE_FAILED",
      } as const;
      await recordExifSummaryFailure(
        {
          teamId,
          evidenceId,
          evidencePartId: part.id,
          status: statusMap[result.reason],
          extractedBytes: bytes.byteLength,
          lastError: result.reason,
        },
        prisma,
      );
      failed += 1;
    }
  }

  if (runId) {
    if (succeeded > 0 || failed === 0) {
      await markRunCompleted(runId, teamId, prisma);
    } else {
      await markRunFailed(
        runId,
        teamId,
        `all_parts_failed:${failed}`,
        prisma,
      );
    }
  }

  await tryBump(
    succeeded > 0
      ? "media_intelligence_processor_completed_total"
      : "media_intelligence_processor_failed_total",
  );
  logger.info(
    {
      jobId,
      runId,
      teamId,
      evidenceId,
      evidencePartId,
      partsProcessed: parts.length,
      succeeded,
      failed,
    },
    "media_intelligence.extract_exif.job_completed",
  );

  // The job emits no signals directly — the analyzer reads the
  // persisted summaries on its next pass and emits the bounded
  // signal set (EXIF_TIMESTAMP_MISMATCH, DEVICE_METADATA_OBSERVATION).
  return { ok: true, signalsEmitted: 0 };
}

// =============================================================================
// Phase 12 — compute_perceptual_hashes job branch
// =============================================================================
//
// For each image part of an evidence record:
//   1. Fetch up to PERCEPTUAL_HASH_RANGE_BYTES of bytes (enough for
//      sharp to decode a full-frame thumbnail without dragging multi-
//      MB originals through the worker for every job).
//   2. Resize to 8×8 grayscale via sharp's `resize().grayscale().raw()`.
//   3. Derive pHash (sign-vs-mean per pixel → 64 bits → 16-hex string)
//      and dHash (sign-vs-prev-pixel per row → 64 bits → 16-hex
//      string). Both are deterministic and operator-safe.
//   4. UPDATE evidence_parts.{perceptual_phash,perceptual_dhash}.
//
// Idempotent: re-running for the same part overwrites with the same
// values (sharp's resize is deterministic for the same input).
//
// Hard rules:
//   * NEVER throws to BullMQ on a structural failure — return success
//     so the queue doesn't infinitely retry a missing column or a
//     non-image part.
//   * NEVER writes to any column other than the two perceptual_* ones.
//   * Skips parts whose mime_type isn't image/*.
//   * Skips parts whose storage_bucket/storage_key are missing.

type ComputePerceptualHashesInput = {
  jobId: string | undefined;
  teamId: string;
  evidenceId: string;
  evidencePartId: string | null;
};

const PERCEPTUAL_HASH_RANGE_BYTES = 5 * 1024 * 1024;

async function processComputePerceptualHashesJob(
  input: ComputePerceptualHashesInput,
): Promise<{ ok: true; signalsEmitted: number; deferred?: boolean }> {
  const { jobId, teamId, evidenceId, evidencePartId } = input;

  // Look up image parts. The `mime_type LIKE 'image/%'` filter is
  // applied at the DB so we don't bounce S3 requests for video / audio
  // / PDF parts.
  type ImagePart = {
    id: string;
    storage_bucket: string | null;
    storage_key: string | null;
    mime_type: string | null;
  };
  let parts: ImagePart[] = [];
  try {
    parts = (await prisma.$queryRawUnsafe(
      `SELECT p."id", p."storage_bucket", p."storage_key", p."mime_type"
         FROM "evidence_parts" p
         JOIN "evidence" e ON e."id" = p."evidence_id"
         WHERE e."team_id" = $1
           AND e."id" = $2
           AND p."mime_type" ILIKE 'image/%'
           ${evidencePartId ? `AND p."id" = $3` : ""}`,
      ...(evidencePartId
        ? [teamId, evidenceId, evidencePartId]
        : [teamId, evidenceId]),
    )) as ImagePart[];
  } catch (err) {
    logger.warn(
      { jobId, teamId, evidenceId, err: err instanceof Error ? err.message : "unknown" },
      "media_intelligence.compute_perceptual_hashes.lookup_failed",
    );
    await tryBump("media_intelligence_processor_failed_total");
    return { ok: true, signalsEmitted: 0 };
  }

  if (parts.length === 0) {
    logger.info(
      { jobId, teamId, evidenceId, evidencePartId },
      "media_intelligence.compute_perceptual_hashes.no_image_parts",
    );
    await tryBump("media_intelligence_processor_completed_total");
    return { ok: true, signalsEmitted: 0 };
  }

  // Lazy-import sharp so the processor can still start if the native
  // binding is unavailable for the host. A throwing import here marks
  // the job as deferred (returns success) and lets ops install sharp.
  let sharp: typeof import("sharp");
  try {
    sharp = (await import("sharp")).default as unknown as typeof import("sharp");
  } catch (err) {
    logger.warn(
      { jobId, err: err instanceof Error ? err.message : "unknown" },
      "media_intelligence.compute_perceptual_hashes.sharp_unavailable",
    );
    await tryBump("media_intelligence_processor_deferred_total");
    return { ok: true, signalsEmitted: 0, deferred: true };
  }

  let succeeded = 0;
  for (const part of parts) {
    if (!part.storage_bucket || !part.storage_key) {
      continue;
    }
    let bytes: Buffer | null = null;
    try {
      bytes = await getObjectRange({
        bucket: part.storage_bucket,
        key: part.storage_key,
        range: `bytes=0-${PERCEPTUAL_HASH_RANGE_BYTES - 1}`,
      });
    } catch (err) {
      logger.warn(
        {
          jobId,
          partId: part.id,
          err: err instanceof Error ? err.message : "unknown",
        },
        "media_intelligence.compute_perceptual_hashes.fetch_failed",
      );
      continue;
    }
    if (!bytes || bytes.byteLength === 0) continue;

    let pHash: string | null = null;
    let dHash: string | null = null;
    try {
      const { data } = await sharp(bytes)
        .resize(8, 8, { fit: "fill" })
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true });
      // data is a 64-byte Uint8Array of luminance values 0..255.
      pHash = computePHashFromLuminance(data);
      dHash = computeDHashFromLuminance(data);
    } catch (err) {
      logger.warn(
        {
          jobId,
          partId: part.id,
          err: err instanceof Error ? err.message : "unknown",
        },
        "media_intelligence.compute_perceptual_hashes.derive_failed",
      );
      continue;
    }
    if (!pHash || !dHash) continue;

    try {
      await prisma.$executeRawUnsafe(
        `UPDATE "evidence_parts"
            SET "perceptual_phash" = $1,
                "perceptual_dhash" = $2
          WHERE "id" = $3`,
        pHash,
        dHash,
        part.id,
      );
      succeeded += 1;
    } catch (err) {
      // Most likely the column doesn't exist yet (migration not
      // applied). Log once + skip — the job is idempotent.
      logger.warn(
        {
          jobId,
          partId: part.id,
          err: err instanceof Error ? err.message : "unknown",
        },
        "media_intelligence.compute_perceptual_hashes.persist_failed",
      );
    }
  }

  await tryBump(
    succeeded > 0
      ? "media_intelligence_processor_completed_total"
      : "media_intelligence_processor_failed_total",
  );
  logger.info(
    {
      jobId,
      teamId,
      evidenceId,
      evidencePartId,
      partsProcessed: parts.length,
      succeeded,
    },
    "media_intelligence.compute_perceptual_hashes.job_completed",
  );
  return { ok: true, signalsEmitted: 0 };
}

// Compute a 64-bit pHash from an 8×8 luminance buffer. Each output
// bit is 1 iff the pixel's luminance is greater than the mean of the
// 64 pixels. Deterministic + locale-free + dependency-free.
function computePHashFromLuminance(data: Buffer | Uint8Array): string {
  if (data.length < 64) return "";
  let sum = 0;
  for (let i = 0; i < 64; i += 1) sum += data[i] ?? 0;
  const mean = sum / 64;
  return bitsToHex16(
    Array.from({ length: 64 }, (_, i) => ((data[i] ?? 0) > mean ? 1 : 0)),
  );
}

// Compute a 64-bit dHash by comparing each pixel to its neighbour on
// the row (8 comparisons × 8 rows = 64 bits). Operates on the same
// 8×8 luminance buffer; the last column of each row is dropped, and a
// final "wrap" bit per row compares to the row's first pixel so the
// hash is exactly 64 bits.
function computeDHashFromLuminance(data: Buffer | Uint8Array): string {
  if (data.length < 64) return "";
  const bits: number[] = [];
  for (let row = 0; row < 8; row += 1) {
    for (let col = 0; col < 8; col += 1) {
      const cur = data[row * 8 + col] ?? 0;
      const next = data[row * 8 + ((col + 1) % 8)] ?? 0;
      bits.push(cur > next ? 1 : 0);
    }
  }
  return bitsToHex16(bits);
}

function bitsToHex16(bits: number[]): string {
  if (bits.length !== 64) return "";
  let hex = "";
  for (let nibble = 0; nibble < 16; nibble += 1) {
    let value = 0;
    for (let bit = 0; bit < 4; bit += 1) {
      value = (value << 1) | (bits[nibble * 4 + bit] ?? 0);
    }
    hex += value.toString(16);
  }
  return hex;
}

// =============================================================================
// Phase 13 — Text-similarity (OCR/TRANSCRIPT) → SIMILAR_TO promotion
// =============================================================================
//
// Bounded handler that:
//   1. Reads this evidence's COMPLETED extracted-text body for the
//      requested `textKind` (OCR_PDF + OCR_IMAGE for OCR; TRANSCRIPT_AUDIO
//      + TRANSCRIPT_VIDEO for TRANSCRIPT).
//   2. Pulls peer evidence in the same team that has the same kind of
//      extracted text, computes Jaccard similarity over 3-token shingles
//      (operator-readable, locale-aware-enough for ASCII text;
//      non-Latin scripts collapse to one shingle per token).
//   3. UPSERTs an EvidenceSimilarity row for matches at or above the
//      LOW_BAND (>= 0.30 → MEDIUM, > 0.60 → HIGH; rows below MEDIUM
//      are stored for operator audit but never promoted to an edge).
//   4. Promotes MEDIUM / HIGH rows into investigation_graph_edges
//      via UPSERT with the bounded edge_type 'SIMILAR_TO' + back-
//      references the resulting edge id on the EvidenceSimilarity row.
//
// Hard rules satisfied:
//   * Never throws to BullMQ.
//   * Workspace-scoped at every read.
//   * Idempotent — re-runs upsert the same rows with refreshed score.
//   * Never logs raw extracted text — only counts + scores + ids.
//   * Skips when text body is shorter than 64 chars (would be noisy).

type TextSimilarityInput = {
  jobId: string | undefined;
  teamId: string;
  evidenceId: string;
  textKind: "OCR" | "TRANSCRIPT";
};

async function processTextSimilarityPromotion(
  input: TextSimilarityInput,
): Promise<{ ok: true; signalsEmitted: number; deferred?: boolean }> {
  const { jobId, teamId, evidenceId, textKind } = input;
  await tryBump("media_intelligence_processor_started_total");

  const sourceKinds =
    textKind === "OCR"
      ? ["OCR_PDF", "OCR_IMAGE"]
      : ["TRANSCRIPT_AUDIO", "TRANSCRIPT_VIDEO"];
  const similarityKind =
    textKind === "OCR" ? "OCR_SIMILAR" : "TRANSCRIPT_SIMILAR";

  // 1. Self text body.
  type TextRow = { text: string | null };
  let myText = "";
  try {
    const myRows = (await prisma.$queryRawUnsafe(
      `SELECT "text" FROM "evidence_extracted_texts"
        WHERE "evidence_id" = $1
          AND "team_id" = $2
          AND "status" = 'COMPLETED'
          AND "kind" = ANY($3::text[])`,
      evidenceId,
      teamId,
      sourceKinds,
    )) as TextRow[];
    myText = myRows
      .map((r) => r.text ?? "")
      .filter(Boolean)
      .join("\n")
      .trim();
  } catch (err) {
    logger.warn(
      { jobId, evidenceId, teamId, err: err instanceof Error ? err.message : "unknown" },
      "media_intelligence.text_similarity.self_load_failed",
    );
    await tryBump("media_intelligence_processor_failed_total");
    return { ok: true, signalsEmitted: 0 };
  }
  if (myText.length < 64) {
    logger.info(
      { jobId, evidenceId, teamId, textKind, length: myText.length },
      "media_intelligence.text_similarity.body_too_short",
    );
    await tryBump("media_intelligence_processor_completed_total");
    return { ok: true, signalsEmitted: 0 };
  }
  const myShingles = computeShingleSet(myText);
  if (myShingles.size === 0) {
    await tryBump("media_intelligence_processor_completed_total");
    return { ok: true, signalsEmitted: 0 };
  }

  // 2. Peer extracted-text rows in the same team. Bounded to 200 —
  // matches the Phase 15 detector's bound; keeps the worker
  // predictable. Larger workspaces will need MinHash/LSH (Phase 14).
  type PeerRow = { evidence_id: string; text: string | null };
  let peers: PeerRow[] = [];
  try {
    peers = (await prisma.$queryRawUnsafe(
      `SELECT "evidence_id", "text"
         FROM "evidence_extracted_texts"
        WHERE "team_id" = $1
          AND "status" = 'COMPLETED'
          AND "kind" = ANY($2::text[])
          AND "evidence_id" <> $3
        ORDER BY "extracted_at_utc" DESC NULLS LAST
        LIMIT 200`,
      teamId,
      sourceKinds,
      evidenceId,
    )) as PeerRow[];
  } catch (err) {
    logger.warn(
      { jobId, evidenceId, teamId, err: err instanceof Error ? err.message : "unknown" },
      "media_intelligence.text_similarity.peer_load_failed",
    );
    await tryBump("media_intelligence_processor_failed_total");
    return { ok: true, signalsEmitted: 0 };
  }

  // Group peer text by evidence (each peer may have multiple parts).
  const grouped = new Map<string, string>();
  for (const p of peers) {
    const prev = grouped.get(p.evidence_id) ?? "";
    grouped.set(p.evidence_id, `${prev}\n${p.text ?? ""}`.trim());
  }

  let upserted = 0;
  let promoted = 0;
  for (const [peerId, peerText] of grouped.entries()) {
    if (peerText.length < 64) continue;
    const peerShingles = computeShingleSet(peerText);
    if (peerShingles.size === 0) continue;
    const score = jaccard(myShingles, peerShingles);
    if (score < TEXT_SIM_LOW_BAND) continue;

    const advisory =
      textKind === "OCR"
        ? "Similar OCR text observed; operator review recommended."
        : "Similar transcript text observed; operator review recommended.";

    // Normalise the pair so (A,B,kind) and (B,A,kind) collapse.
    const [a, b] =
      evidenceId < peerId ? [evidenceId, peerId] : [peerId, evidenceId];
    let similarityId: string | null = null;
    try {
      const upsertRows = (await prisma.$queryRawUnsafe(
        `INSERT INTO "evidence_similarities"
           ("team_id", "source_evidence_id", "target_evidence_id",
            "kind", "score", "advisory_summary")
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT ("source_evidence_id", "target_evidence_id", "kind")
         DO UPDATE SET
           "score" = EXCLUDED."score",
           "advisory_summary" = EXCLUDED."advisory_summary"
         RETURNING "id"`,
        teamId,
        a,
        b,
        similarityKind,
        Math.max(0, Math.min(1, score)),
        advisory,
      )) as Array<{ id: string }>;
      similarityId = upsertRows[0]?.id ?? null;
      if (similarityId) upserted += 1;
    } catch (err) {
      // Best-effort: column / constraint shape may be partial-state.
      logger.warn(
        { jobId, evidenceId, peerId, err: err instanceof Error ? err.message : "unknown" },
        "media_intelligence.text_similarity.upsert_failed",
      );
      continue;
    }

    // Only promote rows in the MEDIUM/HIGH band, and only up to the
    // per-job promotion cap.
    if (score < TEXT_SIM_LOW_BAND) continue;
    const confidence: "LOW" | "MEDIUM" | "HIGH" =
      score > TEXT_SIM_HIGH_BAND
        ? "HIGH"
        : score >= TEXT_SIM_LOW_BAND
          ? "MEDIUM"
          : "LOW";
    if (confidence === "LOW") continue;
    if (promoted >= TEXT_SIM_PROMOTE_MAX) continue;

    // Resolve the two EVIDENCE node ids in the graph. Skip silently
    // if either node is missing — the reconcile cron will re-attempt
    // on its next pass.
    try {
      const aNode = await findEvidenceNodeId(teamId, a);
      const bNode = await findEvidenceNodeId(teamId, b);
      if (!aNode || !bNode) continue;
      const edgeRows = (await prisma.$queryRawUnsafe(
        `INSERT INTO "investigation_graph_edges"
           ("team_id", "source_node_id", "target_node_id", "edge_type",
            "source_kind", "confidence", "safe_summary")
         VALUES ($1, $2, $3, 'SIMILAR_TO', 'SYSTEM', $4, $5)
         ON CONFLICT ("team_id", "source_node_id", "target_node_id", "edge_type")
         DO UPDATE SET
           "confidence" = EXCLUDED."confidence",
           "safe_summary" = EXCLUDED."safe_summary",
           "stale_at_utc" = NULL,
           "updated_at_utc" = NOW()
         RETURNING "id"`,
        teamId,
        aNode,
        bNode,
        confidence,
        advisory,
      )) as Array<{ id: string }>;
      const edgeId = edgeRows[0]?.id ?? null;
      if (edgeId && similarityId) {
        // Back-reference: one-way promotion EvidenceSimilarity →
        // SIMILAR_TO edge. Best-effort; partial-state DBs without
        // the Phase 13 column are tolerated.
        try {
          await prisma.$executeRawUnsafe(
            `UPDATE "evidence_similarities"
                SET "graph_edge_id" = $1
              WHERE "id" = $2`,
            edgeId,
            similarityId,
          );
        } catch {
          /* column may not exist on partial-state DB */
        }
        promoted += 1;
      }
    } catch (err) {
      logger.warn(
        { jobId, evidenceId, peerId, err: err instanceof Error ? err.message : "unknown" },
        "media_intelligence.text_similarity.edge_promote_failed",
      );
      continue;
    }
  }

  // Phase 14 — Stage 2 trigger #5. After the similarity handler
  // upserts SIMILAR_TO edges, enqueue a Discovery search re-index so
  // the newly-materialised relationships propagate into the keyword
  // search projection (which carries relationship counts via the
  // Phase 13 indexer). Wrapped in try/catch — a failed enqueue MUST
  // NOT block the queue handler. Idempotent: enqueueSearchIndexingJob
  // collapses concurrent calls via deterministic jobId. We only fire
  // when at least one promotion actually landed (otherwise the
  // search projection is unchanged).
  if (promoted > 0 || upserted > 0) {
    try {
      const { enqueueSearchIndexingJob } = await import("./queue.js");
      await enqueueSearchIndexingJob({
        teamId,
        kind: "evidence",
        sourceId: evidenceId,
        reason: "similarity_completed",
      });
    } catch (err) {
      logger.warn(
        {
          jobId,
          evidenceId,
          teamId,
          err: err instanceof Error ? err.message.slice(0, 200) : "unknown",
        },
        "media_intelligence.text_similarity.search_reindex_enqueue_failed",
      );
    }
  }

  await tryBump("media_intelligence_processor_completed_total");
  logger.info(
    {
      jobId,
      teamId,
      evidenceId,
      textKind,
      peersConsidered: grouped.size,
      similaritiesUpserted: upserted,
      edgesPromoted: promoted,
    },
    "media_intelligence.text_similarity.job_completed",
  );
  return { ok: true, signalsEmitted: 0 };
}

// Compute a normalised shingle set (3-token rolling window). The
// normaliser lowercases + strips non-word characters, keeping the
// shingle stable across whitespace + punctuation. Bounded to the
// first 32 KiB of input so a malicious payload cannot blow up the
// worker; the original detector already bounds extracted_text at
// the API layer.
function computeShingleSet(text: string): Set<string> {
  const bounded = text.slice(0, 32 * 1024).toLowerCase();
  const tokens = bounded
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const set = new Set<string>();
  if (tokens.length === 0) return set;
  if (tokens.length < 3) {
    // Fall back to single-token shingles for very short bodies so
    // the score is still defined.
    for (const t of tokens) set.add(t);
    return set;
  }
  for (let i = 0; i + 2 < tokens.length; i += 1) {
    set.add(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
  }
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const s of small) if (big.has(s)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

async function findEvidenceNodeId(
  teamId: string,
  evidenceId: string,
): Promise<string | null> {
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT "id" FROM "investigation_graph_nodes"
        WHERE "team_id" = $1
          AND "node_kind" = 'EVIDENCE'
          AND "external_id" = $2
          AND "stale_at_utc" IS NULL
        LIMIT 1`,
      teamId,
      evidenceId,
    )) as Array<{ id: string }>;
    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
}
