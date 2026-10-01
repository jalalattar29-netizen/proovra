/**
 * UC-4 — DERIVED screen-intelligence worker handler.
 *
 * Wires the REAL runtime (bounded ffmpeg keyframe extraction + LOCAL Tesseract
 * OCR + object storage + the shared prisma) into the media-free persistence
 * orchestrator `runAndPersistScreenIntelligence` (@proovra/shared-runtime). It
 * runs as the `reconstruct_screen` kind on the existing media-intelligence
 * queue, so it inherits the durable MediaIntelligenceRun claim / lease / fence
 * lifecycle and the stranded-run reconciler — no second queue.
 *
 * HARD RULES:
 *   * Reads teamId/evidenceId/kind from the run row (never the wire), and the
 *     GENERATION it produces from the run's own idempotency key (UC-DER-001):
 *     every Generate / Retry / Regenerate is a new run of a new generation.
 *   * Claims with a fence; every terminal write carries it, so a superseded
 *     worker cannot overwrite the run that replaced it.
 *   * NEVER mutates ORIGINAL bytes. Keyframes + the reconstruction descriptor
 *     are DERIVED assets that own their digest + object key + row, and a new
 *     generation never deletes or overwrites an earlier one (UC-DER-006).
 *   * Refuses (and drains) a record that is trashed / destruction-bound /
 *     destroyed, and the orchestrator re-checks before every write (UC-DER-013).
 *   * Reads each ORIGINAL at its RECORDED object version, bounded, and hashes
 *     what it read (UC-DER-014).
 *   * OCR is LOCAL and gated on the workspace policy (fail-closed). Policy-off
 *     and engine-missing are different facts and are recorded differently
 *     (UC-DER-008). OCR text is UNTRUSTED and is never executed.
 *   * Transient (storage/DB/import) failures throw so BullMQ retries; structural
 *     failures mark the run FAILED and return success-from-queue.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { OcrExtractResult, ScreenOcrStatus } from "@proovra/shared";
import {
  captureSessionAcquisitionComplete,
  parseScreenReconstructionGeneration,
} from "@proovra/shared";

import { prisma } from "./db.js";
import { logger } from "./logger.js";
import { getObjectStream, putObjectBuffer, deleteObject } from "./storage.js";
import { evaluateEffectiveLegalHold } from "@proovra/shared-runtime";
import { getFfmpegVersion, pngDimensions, produceVideoKeyframes } from "./ffmpeg-derived-assets.js";
import {
  createTesseractOcrProvider,
  TESSERACT_PAGE_SEGMENTATION_MODE,
} from "./tesseract-ocr-provider.js";
import { detectTesseractCapability } from "./tesseract-capability.js";

/** Bilingual by default — the worker image installs eng + ara language packs. */
const OCR_LANG = process.env.UC4_OCR_LANG?.trim() || "eng+ara";

type ScreenJobInput = {
  jobId: string | undefined;
  teamId: string;
  evidenceId: string;
  runId: string;
};

type MediaIntelligenceModule = typeof import("@proovra/shared-runtime/media-intelligence");

export async function processReconstructScreenJob(
  input: ScreenJobInput,
): Promise<{ ok: true; signalsEmitted: number; deferred?: boolean }> {
  const { jobId, teamId, evidenceId, runId } = input;
  const requestId = randomUUID();

  // Lazy-import the run tracker + orchestrator from shared-runtime. Import
  // failure is transient and throws so BullMQ retries with backoff.
  let mi: MediaIntelligenceModule;
  try {
    mi = await import("@proovra/shared-runtime/media-intelligence");
  } catch (err) {
    logger.error(
      { requestId, jobId, err: err instanceof Error ? err.message : "unknown" },
      "screen_intelligence.import_failed",
    );
    throw err;
  }

  // UC-DER-001 — the generation this run produces is named by the run itself.
  const run = await mi.getMediaIntelligenceRun(runId, teamId, prisma);
  const generation = parseScreenReconstructionGeneration(run?.idempotencyKey ?? null) ?? 1;

  // Claim (PENDING/FAILED → PROCESSING, or takeover of an expired lease). The
  // returned fence gates every terminal write below.
  const proc = await mi.markRunProcessing(runId, teamId, prisma);
  if (!proc.ok) {
    if (proc.reason === "max_retries_exceeded") {
      await bumpSafe("media_intelligence_dlq_total");
      logger.warn(
        { requestId, jobId, runId, generation, runStatus: run?.status ?? null },
        "screen_intelligence.claim_refused",
      );
      return { ok: true, signalsEmitted: 0 };
    }
    throw new Error(`run_tracker_unavailable: ${proc.reason}`);
  }
  const runFence = proc.fence;

  // UC-DER-013 — a record that left service gets no new derived material.
  const eligibility = await mi.evaluateDerivedProductionEligibility(evidenceId, prisma);
  if (!eligibility.eligible) {
    await mi.markRunFailed(runId, teamId, `evidence_ineligible:${eligibility.reason}`, prisma, runFence);
    await bumpSafe("media_intelligence_processor_failed_total");
    logger.warn(
      { requestId, jobId, runId, evidenceId, reason: eligibility.reason },
      "screen_intelligence.evidence_ineligible",
    );
    return { ok: true, signalsEmitted: 0 };
  }

  // Source discovery — ORIGINAL screen frames (UC-2) / segments (UC-3),
  // workspace-anchored so cross-tenant enumeration is impossible. A Personal
  // record stored with team_id NULL belongs to its owner's personal workspace
  // (UC-DER-010) — the same rule the API authorised the request with. Ordered
  // by part index (temporal order for continuous capture).
  const parts = (await prisma.$queryRawUnsafe(
    `SELECT p."id", p."storage_bucket", p."storage_key", p."storage_version_id",
            p."size_bytes", p."mime_type", p."sha256", p."part_index"
       FROM "evidence_parts" p
       JOIN "evidence" e ON e."id" = p."evidence_id"
      WHERE ${mi.evidenceInWorkspaceSql("e", "$1")} AND e."id" = $2::uuid
      ORDER BY p."part_index" ASC`,
    teamId,
    evidenceId,
  )) as Array<{
    id: string;
    storage_bucket: string | null;
    storage_key: string | null;
    storage_version_id: string | null;
    size_bytes: bigint | number | null;
    mime_type: string | null;
    sha256: string | null;
    part_index: number | null;
  }>;

  const screenParts = parts
    .filter((p) => {
      const mt = (p.mime_type ?? "").toLowerCase();
      return (
        !!p.storage_bucket &&
        !!p.storage_key &&
        (mt.startsWith("image/") || mt.startsWith("video/"))
      );
    })
    .map((p, i) => ({
      partIndex: p.part_index ?? i,
      evidencePartId: p.id,
      storageBucket: p.storage_bucket as string,
      storageKey: p.storage_key as string,
      storageVersionId: p.storage_version_id,
      sizeBytes: p.size_bytes == null ? null : Number(p.size_bytes),
      mimeType: p.mime_type,
      sha256: p.sha256,
      acquisitionRole: null as string | null,
    }));

  if (screenParts.length === 0) {
    // No screen material — the run is truthfully done with nothing to derive.
    await mi.markRunCompleted(runId, teamId, prisma, runFence);
    await bumpSafe("media_intelligence_processor_completed_total");
    logger.info(
      { requestId, jobId, runId, evidenceId },
      "screen_intelligence.no_screen_parts",
    );
    return { ok: true, signalsEmitted: 0 };
  }

  // ORIGINAL acquisition completeness — an INTERRUPTED capture session must
  // never let the DERIVED reconstruction claim a COMPLETE conversation.
  let acquisitionComplete = true;
  try {
    const session = await prisma.captureSession.findFirst({
      where: { finalizedEvidenceId: evidenceId },
      select: { status: true, endReason: true },
    });
    // ET-DC-09 — a SEALED continuous session is BOUND whatever its manifest
    // said; its completeness is recorded on the end reason at seal.
    acquisitionComplete = captureSessionAcquisitionComplete(session);
  } catch {
    /* absence ⇒ treat as complete (non-direct-capture evidence) */
  }

  // Workspace OCR gate (LOCAL OCR). Fail-closed; deterministic keyframe work
  // proceeds regardless and the DERIVED result is truthfully PARTIAL.
  // UC-DER-008 — the engine is only probed when policy allows OCR, and a
  // missing engine is RUNTIME_UNAVAILABLE, never "disabled by policy".
  const ocrAllowed = await mi.resolveWorkspaceOcrAllowed(teamId, prisma);
  const tesseractCap = ocrAllowed ? await detectTesseractCapability() : null;
  const ocrStatus: ScreenOcrStatus = !ocrAllowed
    ? "DISABLED_BY_POLICY"
    : tesseractCap?.ok
      ? "ENABLED"
      : "RUNTIME_UNAVAILABLE";
  const ocrProvider = ocrStatus === "ENABLED" ? await createTesseractOcrProvider(OCR_LANG) : null;
  const tesseractVersion = tesseractCap?.ok ? tesseractCap.version ?? null : null;
  const ffmpegVersion = await getFfmpegVersion();

  // Effective legal hold — blocks removal of anything derived from the record.
  let holdActive = false;
  try {
    const hold = await evaluateEffectiveLegalHold(prisma, { teamId, evidenceId });
    holdActive = hold.held;
  } catch {
    holdActive = true; // fail-closed: never delete under an unknown hold state
  }

  try {
    const result = await mi.runAndPersistScreenIntelligence(
      {
        teamId,
        evidenceId,
        parts: screenParts,
        acquisitionComplete,
        generation,
        runId,
      },
      {
        prisma,
        holdActive,
        toolVersions: { ffmpeg: ffmpegVersion, tesseract: tesseractVersion },
        getSourceBytes: ({ bucket, key, maxBytes, versionId }) =>
          readObjectBounded({ bucket, key, maxBytes, versionId: versionId ?? null }),
        produceKeyframes: (kfInput) => produceVideoKeyframes(kfInput),
        // UC-DER-006 — the store's VersionId travels back to the row.
        putKeyframeObject: async ({ bucket, key, body, contentType }) => {
          const put = await putObjectBuffer({ bucket, key, body, contentType });
          return { versionId: put?.versionId ?? null };
        },
        deleteObject: async ({ bucket, key }) => {
          await deleteObject({ bucket, key });
        },
        ocr: {
          name: ocrProvider?.name ?? "tesseract",
          version:
            ocrProvider?.version ??
            (ocrStatus === "DISABLED_BY_POLICY" ? "policy-disabled" : "unavailable"),
          local: true,
          enabled: ocrStatus === "ENABLED",
          status: ocrStatus,
          language: ocrStatus === "ENABLED" ? OCR_LANG : null,
          parameters: ocrStatus === "ENABLED" ? { psm: TESSERACT_PAGE_SEGMENTATION_MODE } : undefined,
          extractFromBytes: async (bytes: Buffer): Promise<OcrExtractResult> => {
            if (!ocrProvider) return { regions: [] };
            return runOcrOnBytes(ocrProvider, bytes);
          },
        },
      },
    );

    if (!result.ok) {
      // Structural (no parts, descriptor too large, ineligible record, source
      // digest mismatch) — record FAILED with the reason, drain.
      const reason = result.reason.startsWith("evidence_ineligible:")
        ? result.reason
        : `screen_reconstruction:${result.reason}`;
      await mi.markRunFailed(runId, teamId, reason, prisma, runFence);
      await bumpSafe("media_intelligence_processor_failed_total");
      logger.warn(
        { requestId, jobId, runId, evidenceId, generation, reason: result.reason },
        "screen_intelligence.failed_structural",
      );
      return { ok: true, signalsEmitted: 0 };
    }

    await mi.markRunCompleted(runId, teamId, prisma, runFence);
    await bumpSafe("media_intelligence_processor_completed_total");

    // Best-effort search reindex so DERIVED text becomes findable. Idempotent.
    try {
      const { enqueueSearchIndexingJob } = await import("./queue.js");
      await enqueueSearchIndexingJob({
        teamId,
        kind: "evidence",
        sourceId: evidenceId,
        reason: "screen_reconstruction_completed",
      });
    } catch {
      /* reconciler backfills a missed enqueue */
    }

    logger.info(
      {
        requestId,
        jobId,
        runId,
        evidenceId,
        generation,
        coverage: result.coverage,
        ocrStatus,
        keyframeCount: result.keyframeCount,
        blockCount: result.blockCount,
        observationCount: result.observationCount,
        derivedBytes: result.derivedBytes,
        supersededAssetCount: result.supersededAssetCount,
      },
      "screen_intelligence.completed",
    );
    return { ok: true, signalsEmitted: result.blockCount };
  } catch (err) {
    // Transient (storage/DB) — mark FAILED for operator visibility and rethrow
    // so BullMQ retries with backoff. The fence protects the terminal write.
    await mi.markRunFailed(
      runId,
      teamId,
      err instanceof Error ? err.message : "transient_failure",
      prisma,
      runFence,
    );
    await bumpSafe("media_intelligence_processor_failed_total");
    logger.error(
      { requestId, jobId, runId, evidenceId, err: err instanceof Error ? err.message : "unknown" },
      "screen_intelligence.transient_failure",
    );
    throw err;
  }
}

/**
 * UC-DER-014 — read ONE recorded ORIGINAL object: exactly the recorded version
 * when there is one, and at most `maxBytes` (the stream is abandoned at the
 * bound). The caller hashes what came back and compares its length with the
 * recorded size, so a capped read is never mistaken for the whole part.
 */
async function readObjectBounded(input: {
  bucket: string;
  key: string;
  maxBytes: number;
  versionId: string | null;
}): Promise<Buffer> {
  const stream = (await getObjectStream({
    bucket: input.bucket,
    key: input.key,
    versionId: input.versionId,
  })) as unknown as AsyncIterable<Buffer | string> & { destroy?: () => void };
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    const room = input.maxBytes - total;
    if (buf.byteLength >= room) {
      chunks.push(buf.subarray(0, room));
      total += room;
      break;
    }
    chunks.push(buf);
    total += buf.byteLength;
  }
  try {
    stream.destroy?.();
  } catch {
    /* already ended */
  }
  return Buffer.concat(chunks, total);
}

/**
 * Run the LOCAL Tesseract provider over image bytes: write to a private,
 * uniquely-named temp file, OCR by path (argv spawn — no shell), and unlink in
 * a finally so a crash leaves at most one bounded, OS-swept temp file. The
 * pixel size of the image OCR read is returned with the regions so their boxes
 * can be normalised (UC-DER-003/005).
 */
async function runOcrOnBytes(
  provider: Awaited<ReturnType<typeof createTesseractOcrProvider>>,
  bytes: Buffer,
): Promise<OcrExtractResult> {
  let dir: string | null = null;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), "proovra-uc4ocr-"));
    const file = path.join(dir, `kf-${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.img`);
    await writeFile(file, bytes);
    const res = await provider.extract({ imageRef: file });
    const dims = await imageDimensions(bytes);
    return { ...res, imageWidthPx: dims?.widthPx ?? null, imageHeightPx: dims?.heightPx ?? null };
  } finally {
    if (dir) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        /* OS tmp sweep */
      }
    }
  }
}

/** Pixel size of an image: PNG header directly, anything else via sharp when present. */
async function imageDimensions(bytes: Buffer): Promise<{ widthPx: number; heightPx: number } | null> {
  const png = pngDimensions(bytes);
  if (png) return png;
  try {
    const { detectDerivedAssetCapability } = await import("./derived-assets-capability.js");
    const cap = await detectDerivedAssetCapability();
    if (!cap.ok) return null;
    const meta = await cap.sharp(bytes).metadata();
    return meta.width && meta.height ? { widthPx: meta.width, heightPx: meta.height } : null;
  } catch {
    return null;
  }
}

async function bumpSafe(
  name:
    | "media_intelligence_processor_completed_total"
    | "media_intelligence_processor_failed_total"
    | "media_intelligence_dlq_total",
): Promise<void> {
  try {
    const mod = await import("@proovra/shared-runtime/ops");
    mod.bump(name);
  } catch {
    /* never block on a metric */
  }
}
