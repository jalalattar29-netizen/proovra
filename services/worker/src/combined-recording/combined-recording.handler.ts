/**
 * 2026-10-29 — the `combine_screen_recording` run: ONE DERIVED combined MP4
 * for a legacy SEGMENTED continuous screen recording.
 *
 * Rides the media-intelligence queue as a run kind (like `reconstruct_screen`):
 * the durable MediaIntelligenceRun gives it the claim / lease / fence and the
 * stranded-run reconciler. Its own bounds (MEDIA_INTELLIGENCE_KIND_BOUNDS) are
 * ENFORCED here: every subprocess gets the remainder of a 15-minute budget
 * (below the 20-minute run lease, so a live attempt is never taken over), and a
 * run that already used its attempts is terminally FAILED.
 *
 * HARD RULES
 *   * Reads teamId / evidenceId from the run row, never the wire.
 *   * NEVER mutates an ORIGINAL: segments and the manifest are read at their
 *     RECORDED object versions, streamed to private temp files while hashed,
 *     and must equal their sealed digests (and the manifest's) — fail closed.
 *   * The output is uploaded with the record's ARTIFACT lock, recorded with its
 *     VersionId, digest, size and full lineage, and the previous generation is
 *     SUPERSEDED (kept), never overwritten or deleted.
 *   * Bounded disk (free space checked first), time (deadline) and memory
 *     (streams + one upload part); the temp dir is removed in `finally`.
 *   * A record that left service gets nothing new (eligibility re-checked
 *     before the write).
 *   * Structural outcomes (not applicable, digest mismatch, ffmpeg refusal) mark
 *     the run FAILED with a bounded reason (`unsupported:` / `combine:` prefix)
 *     and drain; transient storage / DB failures throw so BullMQ retries.
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, statfs } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  MEDIA_INTELLIGENCE_KIND_BOUNDS,
  SCREEN_RECORDING_COMBINE_BOUNDS,
  SCREEN_RECORDING_COMBINE_ENGINE_VERSION,
  SCREEN_RECORDING_COMBINE_TRANSFORMATION,
  SCREEN_RECORDING_COMBINED_ASSET_KIND,
  parseScreenRecordingCombineGeneration,
  screenRecordingCombinedVariantKey,
  selectCaptureManifestFacts,
} from "@proovra/shared";
import { evaluateEffectiveLegalHold } from "@proovra/shared-runtime";

import { prisma } from "../db.js";
import { detectFfmpegCapability } from "../ffmpeg-capability.js";
import { getFfmpegVersion } from "../ffmpeg-derived-assets.js";
import { logger } from "../logger.js";
import { artifactLockFor } from "../object-retention.js";
import { deleteObjectVersions, getObjectStream, isObjectLockEnabled, s3 } from "../storage.js";
import { combineSegmentFiles } from "./combine-recording.js";
import { decideCombineInputs, locateCombineManifest, type CombinePartRow } from "./combine-inputs.js";
import { uploadFileMultipart } from "./multipart-upload.js";

type JobInput = { jobId: string | undefined; teamId: string; evidenceId: string; runId: string };
type MediaIntelligenceModule = typeof import("@proovra/shared-runtime/media-intelligence");

const BOUNDS = MEDIA_INTELLIGENCE_KIND_BOUNDS.combine_screen_recording;
const MAX_MANIFEST_BYTES = 1024 * 1024;

/** A structural outcome: recorded on the run, never retried. */
class CombineStructural extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export async function processCombineScreenRecordingJob(
  input: JobInput,
): Promise<{ ok: true; signalsEmitted: number }> {
  const { jobId, teamId, evidenceId, runId } = input;
  const requestId = randomUUID();
  const startedAt = Date.now();
  const deadlineAt = startedAt + BOUNDS.attemptTimeoutMs;

  const mi: MediaIntelligenceModule = await import("@proovra/shared-runtime/media-intelligence");
  const run = await mi.getMediaIntelligenceRun(runId, teamId, prisma);
  const generation = parseScreenRecordingCombineGeneration(run?.idempotencyKey ?? null) ?? 1;
  const attemptsBefore = run?.attemptCount ?? 0;

  const proc = await mi.markRunProcessing(runId, teamId, prisma);
  if (!proc.ok) {
    if (proc.reason === "max_retries_exceeded") return { ok: true, signalsEmitted: 0 };
    throw new Error(`run_tracker_unavailable: ${proc.reason}`);
  }
  const fence = proc.fence;
  const fail = async (reason: string) => {
    await mi.markRunFailed(runId, teamId, reason.slice(0, 200), prisma, fence);
    logger.warn({ requestId, jobId, runId, evidenceId, generation, reason }, "combined_recording.failed");
    return { ok: true as const, signalsEmitted: 0 };
  };
  // The kind's own attempt ceiling (below the tracker's generic one).
  if (attemptsBefore >= BOUNDS.maxAttempts) return fail("combine:attempts_exhausted");

  const eligibility = await mi.evaluateDerivedProductionEligibility(evidenceId, prisma);
  if (!eligibility.eligible) return fail(`evidence_ineligible:${eligibility.reason}`);

  let workDir: string | null = null;
  let uploaded: { bucket: string; key: string; versionId: string | null } | null = null;
  try {
    // ---- the record ------------------------------------------------------
    const evidence = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      select: { acquisitionMode: true },
    });
    const parts = await loadParts(mi, teamId, evidenceId);
    const facts = await loadManifestFacts(evidenceId);
    const located = locateCombineManifest({ acquisitionMode: evidence?.acquisitionMode ?? null, facts, parts });
    if (!located.ok) return fail(`${located.outcome === "unsupported" ? "unsupported" : "combine"}:${located.reason}`);

    const manifestBytes = await readVerified(
      {
        bucket: located.manifestPart.storageBucket!,
        key: located.manifestPart.storageKey!,
        versionId: located.manifestPart.storageVersionId,
        maxBytes: MAX_MANIFEST_BYTES,
      },
      located.manifestSha256,
    );
    let manifestJson: unknown;
    try {
      manifestJson = JSON.parse(manifestBytes.toString("utf8"));
    } catch {
      return fail("combine:manifest_unreadable");
    }
    const decided = decideCombineInputs({
      manifestJson,
      manifestPartIndex: located.manifestPart.partIndex,
      manifestSha256: located.manifestSha256,
      parts,
    });
    if (!decided.ok) return fail(`${decided.outcome === "unsupported" ? "unsupported" : "combine"}:${decided.reason}`);

    // ---- bounds ----------------------------------------------------------
    const sourceBytes = decided.sources.reduce((n, s) => n + s.sizeBytes, 0);
    if (sourceBytes > SCREEN_RECORDING_COMBINE_BOUNDS.maxSourceBytes) return fail("unsupported:sources_exceed_session_bound");
    const cap = await detectFfmpegCapability();
    if (!cap.ok) return fail(`unsupported:${cap.reason}`);
    try {
      const fsStat = await statfs(os.tmpdir());
      const free = Number(fsStat.bavail) * Number(fsStat.bsize);
      if (free < sourceBytes * SCREEN_RECORDING_COMBINE_BOUNDS.tempSpaceFactor) {
        throw new Error("combine_temp_space_insufficient"); // transient: another worker may free it
      }
    } catch (err) {
      if (err instanceof Error && err.message === "combine_temp_space_insufficient") throw err;
      /* statfs unavailable: the -fs output cap and the source bound still bound the run */
    }

    // ---- stream every ORIGINAL to disk, hashing while streaming ------------
    workDir = await mkdtemp(path.join(os.tmpdir(), "proovra-combine-"));
    const files = [];
    for (const s of decided.sources) {
      const file = path.join(workDir, `segment-${String(s.sequence).padStart(4, "0")}.mp4`);
      const read = await streamToFile({
        bucket: s.storageBucket,
        key: s.storageKey,
        versionId: s.storageVersionId,
        file,
        maxBytes: s.sizeBytes,
      });
      if (read.sha256 !== s.sha256 || read.bytes !== s.sizeBytes) {
        throw new CombineStructural(`source_read_mismatch:${s.sequence}`);
      }
      files.push({
        partIndex: s.partIndex,
        sequence: s.sequence,
        sha256: s.sha256,
        sizeBytes: s.sizeBytes,
        versionId: s.storageVersionId,
        startedAtOffsetMs: s.startedAtOffsetMs,
        durationMs: s.durationMs,
        file,
      });
    }

    // ---- combine ---------------------------------------------------------
    const ffmpegVersion = await getFfmpegVersion();
    const combined = await combineSegmentFiles({
      ffmpegPath: cap.ffmpegPath,
      ffmpegVersion,
      workDir,
      deadlineAt,
      manifest: decided.manifest,
      segments: files,
      missingInRecord: decided.missingInRecord,
      generation,
    });
    if (combined.status !== "ok") {
      return fail(`${combined.status === "unsupported" ? "unsupported" : "combine"}:${combined.reason}`);
    }

    // ---- upload (the digest names the object) ------------------------------
    const outputSha256 = await hashFile(combined.outputFile);
    const anchor = decided.sources[0]!;
    const key = `derived-assets/${evidenceId}/${SCREEN_RECORDING_COMBINED_ASSET_KIND}/${screenRecordingCombinedVariantKey(generation)}-${outputSha256.slice(0, 16)}.mp4`;
    const recheck = await mi.evaluateDerivedProductionEligibility(evidenceId, prisma);
    if (!recheck.eligible) return fail(`evidence_ineligible:${recheck.reason}`);
    const put = await uploadFileMultipart({
      client: s3,
      bucket: anchor.storageBucket,
      key,
      file: combined.outputFile,
      contentType: "video/mp4",
      partBytes: SCREEN_RECORDING_COMBINE_BOUNDS.uploadPartBytes,
      lock: await artifactLockFor(evidenceId),
      objectLockEnabled: isObjectLockEnabled(),
      metadata: { "proovra-artifact-class": "DERIVED", "proovra-transformation": SCREEN_RECORDING_COMBINE_TRANSFORMATION },
      maxBytes: SCREEN_RECORDING_COMBINE_BOUNDS.maxOutputBytes,
    });
    uploaded = { bucket: anchor.storageBucket, key, versionId: put.versionId };
    if (put.sha256 !== outputSha256 || put.sizeBytes !== combined.sizeBytes) {
      throw new CombineStructural("upload_digest_mismatch");
    }

    // ---- record (multi-source lineage) + supersede the previous generation --
    const variantKey = screenRecordingCombinedVariantKey(generation);
    const recorded = await mi.recordDerivedAsset(
      {
        teamId,
        evidenceId,
        evidencePartId: anchor.id,
        assetKind: SCREEN_RECORDING_COMBINED_ASSET_KIND,
        status: "COMPLETED",
        derivedSha256: put.sha256,
        sizeBytes: put.sizeBytes,
        contentType: "video/mp4",
        widthPx: combined.widthPx,
        heightPx: combined.heightPx,
        sourceSha256AtGeneration: anchor.sha256,
        storageBucket: anchor.storageBucket,
        storageKey: key,
        storageVersionId: put.versionId,
        engineVersion: SCREEN_RECORDING_COMBINE_ENGINE_VERSION,
        variantKey,
        transformation: SCREEN_RECORDING_COMBINE_TRANSFORMATION,
        generationParameters: combined.lineage as unknown as Record<string, unknown>,
        sourceOffsetMs: null,
      },
      prisma,
    );
    if (!recorded.ok) throw new Error(`combined_persist_failed:${recorded.reason}`);
    uploaded = null; // referenced by its row from here on
    const previous = await prisma.evidencePartDerivedAsset.findMany({
      where: { evidenceId, assetKind: SCREEN_RECORDING_COMBINED_ASSET_KIND, status: "COMPLETED", NOT: { id: recorded.id } },
      select: { id: true },
    });
    const superseded = await mi.supersedeDerivedAssets(
      { teamId, evidenceId, ids: previous.map((p) => p.id) },
      prisma,
    );

    await mi.markRunCompleted(runId, teamId, prisma, fence);
    logger.info(
      {
        requestId,
        jobId,
        runId,
        evidenceId,
        generation,
        mode: combined.lineage.mode,
        completeness: combined.lineage.completeness,
        gaps: combined.lineage.gaps.length,
        sources: combined.lineage.sources.length,
        sizeBytes: put.sizeBytes,
        parts: put.partCount,
        superseded,
        elapsedMs: Date.now() - startedAt,
      },
      "combined_recording.completed",
    );
    return { ok: true, signalsEmitted: 0 };
  } catch (err) {
    if (err instanceof CombineStructural) return fail(`combine:${err.reason}`);
    await mi.markRunFailed(runId, teamId, err instanceof Error ? err.message : "transient_failure", prisma, fence);
    logger.error(
      { requestId, jobId, runId, evidenceId, err: err instanceof Error ? err.message : "unknown" },
      "combined_recording.transient_failure",
    );
    throw err;
  } finally {
    // An object written but never referenced by a row is removed — unless a
    // hold is in force (fail closed: unknown hold state keeps it).
    if (uploaded) {
      let held = true;
      try {
        held = (await evaluateEffectiveLegalHold(prisma, { teamId, evidenceId })).held;
      } catch {
        held = true;
      }
      if (!held) await deleteObjectVersions(uploaded).catch(() => undefined);
    }
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function loadParts(mi: MediaIntelligenceModule, teamId: string, evidenceId: string): Promise<CombinePartRow[]> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT p."id", p."part_index", p."storage_bucket", p."storage_key", p."storage_version_id",
            p."size_bytes", p."mime_type", p."sha256", p."artifact_class"
       FROM "evidence_parts" p
       JOIN "evidence" e ON e."id" = p."evidence_id"
      WHERE ${mi.evidenceInWorkspaceSql("e", "$1")} AND e."id" = $2::uuid
      ORDER BY p."part_index" ASC`,
    teamId,
    evidenceId,
  )) as Array<{
    id: string;
    part_index: number;
    storage_bucket: string | null;
    storage_key: string | null;
    storage_version_id: string | null;
    size_bytes: bigint | number | null;
    mime_type: string | null;
    sha256: string | null;
    artifact_class: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    partIndex: r.part_index,
    storageBucket: r.storage_bucket,
    storageKey: r.storage_key,
    storageVersionId: r.storage_version_id,
    sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes),
    mimeType: r.mime_type,
    sha256: r.sha256,
    artifactClass: r.artifact_class,
  }));
}

/** The seal's manifest facts (CAPTURE_ARTIFACT_RECEIVED, stage manifest_facts). */
async function loadManifestFacts(evidenceId: string) {
  const session = await prisma.captureSession.findFirst({
    where: { finalizedEvidenceId: evidenceId },
    select: { id: true },
  });
  if (!session) return null;
  const events = await prisma.captureTrustEventRecord.findMany({
    where: { captureSessionId: session.id, code: "CAPTURE_ARTIFACT_RECEIVED" },
    orderBy: { sequence: "asc" },
    select: { code: true, payload: true },
    take: 1000,
  });
  return selectCaptureManifestFacts(events);
}

/** Read a small object at its recorded version; its bytes must hash to `sha256`. */
async function readVerified(
  src: { bucket: string; key: string; versionId: string | null; maxBytes: number },
  sha256: string,
): Promise<Buffer> {
  const stream = (await getObjectStream(src)) as unknown as AsyncIterable<Buffer | string> & { destroy?: () => void };
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of stream) {
    const b = typeof c === "string" ? Buffer.from(c) : c;
    total += b.length;
    if (total > src.maxBytes) {
      stream.destroy?.();
      throw new CombineStructural("manifest_oversize");
    }
    chunks.push(b);
  }
  const bytes = Buffer.concat(chunks, total);
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new CombineStructural("manifest_read_mismatch");
  return bytes;
}

/** Stream one ORIGINAL at its recorded version to a file, hashing while streaming (bounded). */
async function streamToFile(src: {
  bucket: string;
  key: string;
  versionId: string | null;
  file: string;
  maxBytes: number;
}): Promise<{ sha256: string; bytes: number }> {
  const body = (await getObjectStream({ bucket: src.bucket, key: src.key, versionId: src.versionId })) as unknown as NodeJS.ReadableStream;
  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > src.maxBytes) {
        cb(new CombineStructural("source_longer_than_recorded"));
        return;
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  await pipeline(body, meter, createWriteStream(src.file, { flags: "wx", mode: 0o600 }));
  return { sha256: hash.digest("hex"), bytes };
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}
