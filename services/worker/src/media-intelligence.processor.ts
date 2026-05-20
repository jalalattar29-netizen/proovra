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
      "../../api/src/services/ops/metrics.service.js"
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
  let runMediaIntelligenceAnalysis: typeof import("../../api/src/services/media-intelligence/analyzer.service.js")["runMediaIntelligenceAnalysis"];
  let markRunProcessing: typeof import("../../api/src/services/media-intelligence/run-tracker.service.js")["markRunProcessing"];
  let markRunCompleted: typeof import("../../api/src/services/media-intelligence/run-tracker.service.js")["markRunCompleted"];
  let markRunFailed: typeof import("../../api/src/services/media-intelligence/run-tracker.service.js")["markRunFailed"];
  try {
    ({ runMediaIntelligenceAnalysis } = await import(
      "../../api/src/services/media-intelligence/analyzer.service.js"
    ));
    ({ markRunProcessing, markRunCompleted, markRunFailed } = await import(
      "../../api/src/services/media-intelligence/run-tracker.service.js"
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
  let markRunProcessing: typeof import("../../api/src/services/media-intelligence/run-tracker.service.js")["markRunProcessing"];
  let markRunCompleted: typeof import("../../api/src/services/media-intelligence/run-tracker.service.js")["markRunCompleted"];
  let markRunFailed: typeof import("../../api/src/services/media-intelligence/run-tracker.service.js")["markRunFailed"];
  let extractExifSafe: typeof import("../../api/src/services/media-intelligence/exif-extractor.service.js")["extractExifSafe"];
  let upsertExifSummary: typeof import("../../api/src/services/media-intelligence/exif-summary.service.js")["upsertExifSummary"];
  let recordExifSummaryFailure: typeof import("../../api/src/services/media-intelligence/exif-summary.service.js")["recordExifSummaryFailure"];
  try {
    ({ markRunProcessing, markRunCompleted, markRunFailed } = await import(
      "../../api/src/services/media-intelligence/run-tracker.service.js"
    ));
    ({ extractExifSafe } = await import(
      "../../api/src/services/media-intelligence/exif-extractor.service.js"
    ));
    ({ upsertExifSummary, recordExifSummaryFailure } = await import(
      "../../api/src/services/media-intelligence/exif-summary.service.js"
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
