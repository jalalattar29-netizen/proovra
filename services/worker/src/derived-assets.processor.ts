/**
 * Phase 31.13 — Derived assets BullMQ processor.
 *
 * Dedicated to the new `mi-derived-assets` queue (first of 9 isolated
 * media-intelligence subsystem queues). Fetches the source bytes
 * from S3 (range-bounded), runs sharp to produce a small thumbnail,
 * stores the derived bytes in a separate S3 prefix, then persists
 * a bounded row via the derived-assets persistence service.
 *
 * Hard custody / safety rules:
 *
 *   * Imports the canonical shared `prisma` from `./db.js`. NEVER
 *     constructs its own — the worker-bootstrap regression test
 *     enforces this for every processor.
 *   * NEVER throws to BullMQ on a structural problem (no part,
 *     non-image MIME, no storage reference, generation failure).
 *     Marks the run FAILED / UNSUPPORTED in DB + returns success-
 *     from-queue so BullMQ doesn't infinite-retry.
 *   * Only transient errors (capability probe failure, S3 5xx)
 *     throw — BullMQ retries with exponential backoff per the
 *     queue config.
 *   * NEVER mutates the original `evidence_parts` row. The derived
 *     bytes get their own SHA-256 + own S3 key + own DB row.
 *   * Source linkage captures `source_sha256_at_generation` so
 *     downstream consumers can verify the source has not been
 *     mutated since.
 *   * Bounded range fetch — max 4MB source pulled. Non-image MIME
 *     types refused at the start.
 *   * Bounded thumbnail output — 256px max edge, format normalized
 *     to webp (small + universally supported in modern browsers).
 *
 * Capability detection:
 *   The sharp native binary is probed once at process startup via
 *   `detectDerivedAssetCapability()`. If sharp fails to load on the
 *   runtime, every job is marked UNSUPPORTED (not FAILED) — operators
 *   see the explicit "this runtime cannot generate derived assets"
 *   state and the queue drains cleanly.
 */

import type { Job } from "bullmq";
import { createHash } from "node:crypto";

import { prisma } from "./db.js";
import { logger } from "./logger.js";
import { getObjectRange, putObjectBuffer } from "./storage.js";
import { detectDerivedAssetCapability } from "./derived-assets-capability.js";
// Phase 31.20 — ffmpeg-derived asset producers.
import {
  produceAudioWaveform,
  produceLowResProxy,
  produceVideoFrame,
  SOURCE_READ_BUDGET,
  type FfmpegProducerResult,
} from "./ffmpeg-derived-assets.js";

// =============================================================================
// Constants
// =============================================================================

const SOURCE_RANGE_BYTES = 4 * 1024 * 1024;
const THUMBNAIL_MAX_EDGE_PX = 256;
const DERIVED_ASSET_S3_PREFIX = "derived-assets";
const DERIVED_ASSET_ENGINE_VERSION = "sharp-v0-phase31-v1";
// Phase 31.20 — separate engine identifier so the provenance trail
// can distinguish sharp-produced thumbnails from ffmpeg-produced
// video frames / waveforms / low-res proxies.
const FFMPEG_ENGINE_VERSION = "ffmpeg-v0-phase31-20";

// =============================================================================
// Public surface — registered via safeRegisterWorker in index.ts
// =============================================================================

export type DerivedAssetJobData = {
  teamId: string;
  evidenceId: string;
  evidencePartId: string;
  assetKind:
    | "image_thumbnail"
    | "video_frame"
    | "audio_waveform"
    | "low_res_proxy"
    | "compact_review_preview";
};

export async function processDerivedAssetJob(
  job: Job<DerivedAssetJobData>,
): Promise<{ ok: true; status: string }> {
  const { teamId, evidenceId, evidencePartId, assetKind } =
    job.data ?? ({} as DerivedAssetJobData);
  if (!teamId || !evidenceId || !evidencePartId || !assetKind) {
    logger.warn(
      {
        jobId: job.id,
        missing: {
          teamId: !teamId,
          evidenceId: !evidenceId,
          evidencePartId: !evidencePartId,
          assetKind: !assetKind,
        },
      },
      "derived_assets.malformed_payload",
    );
    return { ok: true, status: "MALFORMED" };
  }

  await tryBump("derived_assets_processor_started_total");

  // Phase 31.20 — dispatch by asset_kind.
  //   * image_thumbnail → sharp pipeline (image bytes; below in this fn).
  //   * video_frame / audio_waveform / low_res_proxy → ffmpeg pipeline
  //     (delegated to handleFfmpegAssetKind).
  //   * compact_review_preview → reserved; UNSUPPORTED for now.
  if (
    assetKind === "video_frame" ||
    assetKind === "audio_waveform" ||
    assetKind === "low_res_proxy"
  ) {
    return await handleFfmpegAssetKind({
      job,
      teamId,
      evidenceId,
      evidencePartId,
      assetKind,
    });
  }
  if (assetKind === "compact_review_preview") {
    await persistUnsupported({
      teamId,
      evidenceId,
      evidencePartId,
      assetKind,
      reason: "kind_reserved_for_future_phase",
    });
    await tryBump("derived_assets_processor_unsupported_total");
    return { ok: true, status: "UNSUPPORTED" };
  }

  const capability = await detectDerivedAssetCapability();
  if (!capability.ok) {
    await persistUnsupported({
      teamId,
      evidenceId,
      evidencePartId,
      assetKind,
      reason: capability.reason,
    });
    await tryBump("derived_assets_processor_unsupported_total");
    logger.warn(
      { jobId: job.id, reason: capability.reason },
      "derived_assets.capability_unavailable",
    );
    return { ok: true, status: "UNSUPPORTED" };
  }

  // Look up the source part (team-anchored — anti-enumeration).
  const parts = (await prisma.$queryRawUnsafe(
    `SELECT p."id", p."storage_bucket", p."storage_key",
            p."mime_type", p."sha256"
       FROM "evidence_parts" p
       JOIN "evidence" e ON e."id" = p."evidence_id"
      WHERE e."team_id" = $1
        AND e."id" = $2
        AND p."id" = $3
      LIMIT 1`,
    teamId,
    evidenceId,
    evidencePartId,
  )) as Array<{
    id: string;
    storage_bucket: string | null;
    storage_key: string | null;
    mime_type: string | null;
    sha256: string | null;
  }>;

  const part = parts[0];
  if (!part) {
    await persistFailed({
      teamId,
      evidenceId,
      evidencePartId,
      assetKind,
      reason: "part_not_found",
    });
    await tryBump("derived_assets_processor_failed_total");
    return { ok: true, status: "FAILED" };
  }

  if (!part.mime_type || !part.mime_type.toLowerCase().startsWith("image/")) {
    await persistUnsupported({
      teamId,
      evidenceId,
      evidencePartId,
      assetKind,
      reason: "non_image_mime",
    });
    await tryBump("derived_assets_processor_unsupported_total");
    return { ok: true, status: "UNSUPPORTED" };
  }
  if (!part.storage_bucket || !part.storage_key) {
    await persistFailed({
      teamId,
      evidenceId,
      evidencePartId,
      assetKind,
      reason: "no_storage_reference",
    });
    await tryBump("derived_assets_processor_failed_total");
    return { ok: true, status: "FAILED" };
  }

  let sourceBytes: Buffer;
  try {
    sourceBytes = await getObjectRange({
      bucket: part.storage_bucket,
      key: part.storage_key,
      range: `bytes=0-${SOURCE_RANGE_BYTES - 1}`,
    });
  } catch (err) {
    await persistFailed({
      teamId,
      evidenceId,
      evidencePartId,
      assetKind,
      reason:
        err instanceof Error
          ? `source_fetch_failed:${err.message.slice(0, 80)}`
          : "source_fetch_failed",
    });
    await tryBump("derived_assets_processor_failed_total");
    // S3 fetch errors are typically transient — throw so BullMQ
    // retries with backoff. After max attempts the DLQ catches.
    throw err;
  }

  let derivedBuffer: Buffer;
  let derivedWidth: number | null = null;
  let derivedHeight: number | null = null;
  try {
    const result = await capability.sharp(sourceBytes)
      .resize({
        width: THUMBNAIL_MAX_EDGE_PX,
        height: THUMBNAIL_MAX_EDGE_PX,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    derivedBuffer = result.data;
    derivedWidth = result.info.width;
    derivedHeight = result.info.height;
  } catch (err) {
    await persistFailed({
      teamId,
      evidenceId,
      evidencePartId,
      assetKind,
      reason:
        err instanceof Error
          ? `sharp_failed:${err.message.slice(0, 80)}`
          : "sharp_failed",
    });
    await tryBump("derived_assets_processor_failed_total");
    const attemptsAllowed = job.opts?.attempts ?? 1;
    if ((job.attemptsMade ?? 0) >= attemptsAllowed - 1) {
      await tryBump("derived_assets_dlq_total");
    }
    // Parse failures (e.g. truncated source range, unrecognized
    // format) are structural — return success-from-queue so BullMQ
    // doesn't retry an unrecognized input.
    return { ok: true, status: "FAILED" };
  }

  const derivedSha256 = createHash("sha256").update(derivedBuffer).digest("hex");
  const derivedKey = `${DERIVED_ASSET_S3_PREFIX}/${evidenceId}/${evidencePartId}/${assetKind}-${derivedSha256.slice(0, 16)}.webp`;
  const derivedContentType = "image/webp";

  try {
    await putObjectBuffer({
      bucket: part.storage_bucket,
      key: derivedKey,
      body: derivedBuffer,
      contentType: derivedContentType,
    });
  } catch (err) {
    await persistFailed({
      teamId,
      evidenceId,
      evidencePartId,
      assetKind,
      reason:
        err instanceof Error
          ? `derived_put_failed:${err.message.slice(0, 80)}`
          : "derived_put_failed",
    });
    await tryBump("derived_assets_processor_failed_total");
    throw err;
  }

  // Persist row (idempotent upsert).
  const persistence = await persistCompleted({
    teamId,
    evidenceId,
    evidencePartId,
    assetKind,
    derivedSha256,
    sizeBytes: derivedBuffer.byteLength,
    contentType: derivedContentType,
    widthPx: derivedWidth,
    heightPx: derivedHeight,
    sourceSha256AtGeneration: part.sha256,
    storageBucket: part.storage_bucket,
    storageKey: derivedKey,
  });

  if (!persistence.ok) {
    logger.warn(
      {
        jobId: job.id,
        evidenceId,
        evidencePartId,
        reason: persistence.reason,
      },
      "derived_assets.persistence_failed",
    );
    await tryBump("derived_assets_processor_failed_total");
    return { ok: true, status: "FAILED" };
  }

  await tryBump("derived_assets_processor_completed_total");
  logger.info(
    {
      jobId: job.id,
      evidenceId,
      evidencePartId,
      assetKind,
      derivedSha256,
      widthPx: derivedWidth,
      heightPx: derivedHeight,
      sizeBytes: derivedBuffer.byteLength,
    },
    "derived_assets.job_completed",
  );

  return { ok: true, status: "COMPLETED" };
}

// =============================================================================
// Phase 31.20 — ffmpeg-backed asset kinds
// =============================================================================

async function handleFfmpegAssetKind(params: {
  job: Job<DerivedAssetJobData>;
  teamId: string;
  evidenceId: string;
  evidencePartId: string;
  assetKind: "video_frame" | "audio_waveform" | "low_res_proxy";
}): Promise<{ ok: true; status: string }> {
  const { job, teamId, evidenceId, evidencePartId, assetKind } = params;

  // Look up the source part (team-anchored — anti-enumeration).
  const parts = (await prisma.$queryRawUnsafe(
    `SELECT p."id", p."storage_bucket", p."storage_key",
            p."mime_type", p."sha256"
       FROM "evidence_parts" p
       JOIN "evidence" e ON e."id" = p."evidence_id"
      WHERE e."team_id" = $1
        AND e."id" = $2
        AND p."id" = $3
      LIMIT 1`,
    teamId,
    evidenceId,
    evidencePartId,
  )) as Array<{
    id: string;
    storage_bucket: string | null;
    storage_key: string | null;
    mime_type: string | null;
    sha256: string | null;
  }>;
  const part = parts[0];
  if (!part) {
    await persistFailed({
      teamId,
      evidenceId,
      evidencePartId,
      assetKind,
      reason: "part_not_found",
    });
    await tryBump("derived_assets_processor_failed_total");
    return { ok: true, status: "FAILED" };
  }
  if (!part.storage_bucket || !part.storage_key) {
    await persistFailed({
      teamId,
      evidenceId,
      evidencePartId,
      assetKind,
      reason: "no_storage_reference",
    });
    await tryBump("derived_assets_processor_failed_total");
    return { ok: true, status: "FAILED" };
  }

  // Bounded source fetch. Each ffmpeg-backed asset kind has its own
  // budget (see SOURCE_READ_BUDGET in ffmpeg-derived-assets.ts).
  const readBudget = SOURCE_READ_BUDGET[assetKind];
  let sourceBytes: Buffer;
  try {
    sourceBytes = await getObjectRange({
      bucket: part.storage_bucket,
      key: part.storage_key,
      range: `bytes=0-${readBudget - 1}`,
    });
  } catch (err) {
    await persistFailed({
      teamId,
      evidenceId,
      evidencePartId,
      assetKind,
      reason:
        err instanceof Error
          ? `source_fetch_failed:${err.message.slice(0, 60)}`
          : "source_fetch_failed",
    });
    await tryBump("derived_assets_processor_failed_total");
    // S3 errors are typically transient — throw so BullMQ retries.
    throw err;
  }

  // Dispatch to the right ffmpeg producer.
  let result: FfmpegProducerResult;
  if (assetKind === "video_frame") {
    result = await produceVideoFrame({
      sourceBytes,
      sourceMimeType: part.mime_type ?? "",
    });
  } else if (assetKind === "audio_waveform") {
    result = await produceAudioWaveform({
      sourceBytes,
      sourceMimeType: part.mime_type ?? "",
    });
  } else {
    result = await produceLowResProxy({
      sourceBytes,
      sourceMimeType: part.mime_type ?? "",
    });
  }

  if (result.status === "ok") {
    // Persist + upload bytes.
    const derivedKey = derivedKeyFor({
      evidenceId,
      evidencePartId,
      assetKind,
      derivedSha256: result.derivedSha256,
      contentType: result.contentType,
    });
    try {
      await putObjectBuffer({
        bucket: part.storage_bucket,
        key: derivedKey,
        body: result.bytes,
        contentType: result.contentType,
      });
    } catch (err) {
      await persistFailed({
        teamId,
        evidenceId,
        evidencePartId,
        assetKind,
        reason:
          err instanceof Error
            ? `derived_put_failed:${err.message.slice(0, 60)}`
            : "derived_put_failed",
      });
      await tryBump("derived_assets_processor_failed_total");
      throw err;
    }
    const persistence = await persistCompleted({
      teamId,
      evidenceId,
      evidencePartId,
      assetKind,
      derivedSha256: result.derivedSha256,
      sizeBytes: result.bytes.byteLength,
      contentType: result.contentType,
      widthPx: result.widthPx,
      heightPx: result.heightPx,
      sourceSha256AtGeneration: part.sha256,
      storageBucket: part.storage_bucket,
      storageKey: derivedKey,
      engineVersion: FFMPEG_ENGINE_VERSION,
    });
    if (!persistence.ok) {
      await tryBump("derived_assets_processor_failed_total");
      return { ok: true, status: "FAILED" };
    }
    await tryBump("derived_assets_processor_completed_total");
    logger.info(
      {
        jobId: job.id,
        evidenceId,
        evidencePartId,
        assetKind,
        derivedSha256: result.derivedSha256,
        sizeBytes: result.bytes.byteLength,
      },
      "derived_assets.ffmpeg_job_completed",
    );
    return { ok: true, status: "COMPLETED" };
  }

  // From here the producer returned a non-ok discriminated value:
  // either { status: "unsupported", reason } or { status: "failed", reason }.
  if (result.status === "unsupported") {
    await persistUnsupported({
      teamId,
      evidenceId,
      evidencePartId,
      assetKind,
      reason: result.reason,
    });
    await tryBump("derived_assets_processor_unsupported_total");
    return { ok: true, status: "UNSUPPORTED" };
  }

  // result.status === "failed"
  await persistFailed({
    teamId,
    evidenceId,
    evidencePartId,
    assetKind,
    reason: result.reason,
  });
  await tryBump("derived_assets_processor_failed_total");
  const attemptsAllowed = job.opts?.attempts ?? 1;
  if ((job.attemptsMade ?? 0) >= attemptsAllowed - 1) {
    await tryBump("derived_assets_dlq_total");
  }
  // Structural ffmpeg failures (bad input, oversize) are not
  // retryable — return success-from-queue to drop the job cleanly.
  return { ok: true, status: "FAILED" };
}

function derivedKeyFor(input: {
  evidenceId: string;
  evidencePartId: string;
  assetKind: string;
  derivedSha256: string;
  contentType: string;
}): string {
  // Pick an extension matching contentType so a casual S3 list
  // doesn't show a key without a recognisable suffix.
  const ext =
    input.contentType === "image/png"
      ? "png"
      : input.contentType === "image/webp"
        ? "webp"
        : input.contentType === "video/webm"
          ? "webm"
          : "bin";
  return `${DERIVED_ASSET_S3_PREFIX}/${input.evidenceId}/${input.evidencePartId}/${input.assetKind}-${input.derivedSha256.slice(0, 16)}.${ext}`;
}

// =============================================================================
// Persistence helpers (lazy-import the API-side service)
// =============================================================================

type PersistBaseInput = {
  teamId: string;
  evidenceId: string;
  evidencePartId: string;
  assetKind: DerivedAssetJobData["assetKind"];
};

async function persistCompleted(
  input: PersistBaseInput & {
    derivedSha256: string;
    sizeBytes: number;
    contentType: string;
    widthPx: number | null;
    heightPx: number | null;
    sourceSha256AtGeneration: string | null;
    storageBucket: string;
    storageKey: string;
    /** Optional override — ffmpeg-derived assets pass their own
     *  engine version so the provenance trail can distinguish
     *  sharp- vs. ffmpeg-produced bytes. */
    engineVersion?: string;
  },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const { recordDerivedAsset } = await import(
      "../../api/src/services/media-intelligence/derived-assets.service.js"
    );
    const r = await recordDerivedAsset(
      {
        ...input,
        status: "COMPLETED",
        engineVersion: input.engineVersion ?? DERIVED_ASSET_ENGINE_VERSION,
      },
      prisma,
    );
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  } catch (err) {
    return {
      ok: false,
      reason:
        err instanceof Error
          ? `import_failed:${err.message.slice(0, 80)}`
          : "import_failed",
    };
  }
}

async function persistFailed(
  input: PersistBaseInput & { reason: string },
): Promise<void> {
  try {
    const { recordDerivedAsset } = await import(
      "../../api/src/services/media-intelligence/derived-assets.service.js"
    );
    await recordDerivedAsset(
      {
        teamId: input.teamId,
        evidenceId: input.evidenceId,
        evidencePartId: input.evidencePartId,
        assetKind: input.assetKind,
        status: "FAILED",
        lastError: input.reason,
        engineVersion: DERIVED_ASSET_ENGINE_VERSION,
      },
      prisma,
    );
  } catch {
    // Persistence failure is non-fatal — the job already failed.
  }
}

async function persistUnsupported(
  input: PersistBaseInput & { reason: string },
): Promise<void> {
  try {
    const { recordDerivedAsset } = await import(
      "../../api/src/services/media-intelligence/derived-assets.service.js"
    );
    await recordDerivedAsset(
      {
        teamId: input.teamId,
        evidenceId: input.evidenceId,
        evidencePartId: input.evidencePartId,
        assetKind: input.assetKind,
        status: "UNSUPPORTED",
        lastError: input.reason,
        engineVersion: DERIVED_ASSET_ENGINE_VERSION,
      },
      prisma,
    );
  } catch {
    // Persistence failure is non-fatal.
  }
}

async function tryBump(
  name:
    | "derived_assets_processor_started_total"
    | "derived_assets_processor_completed_total"
    | "derived_assets_processor_failed_total"
    | "derived_assets_processor_unsupported_total"
    | "derived_assets_dlq_total",
): Promise<void> {
  try {
    const mod = await import(
      "../../api/src/services/ops/metrics.service.js"
    );
    mod.bump(name);
  } catch {
    /* never block on a metric */
  }
}
