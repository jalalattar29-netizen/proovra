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
 *   * Reads teamId/evidenceId/kind from the run row (never the wire).
 *   * Claims with a fence; every terminal write carries it, so a superseded
 *     worker cannot overwrite the run that replaced it.
 *   * NEVER mutates ORIGINAL bytes. Keyframes + the reconstruction descriptor
 *     are DERIVED assets that own their digest + object key + row.
 *   * OCR is LOCAL and gated on the workspace policy (fail-closed). OCR text is
 *     UNTRUSTED and is never executed.
 *   * Transient (storage/DB/import) failures throw so BullMQ retries; structural
 *     failures mark the run FAILED and return success-from-queue.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { OcrExtractResult } from "@proovra/shared";

import { prisma } from "./db.js";
import { logger } from "./logger.js";
import { getObjectRange, putObjectBuffer, deleteObject } from "./storage.js";
import { evaluateEffectiveLegalHold } from "./governance/effective-legal-hold.js";
import { produceVideoKeyframes } from "./ffmpeg-derived-assets.js";
import { createTesseractOcrProvider } from "./tesseract-ocr-provider.js";
import { detectTesseractCapability } from "./tesseract-capability.js";

/** Bilingual by default — the worker image installs eng + ara language packs. */
const OCR_LANG = process.env.UC4_OCR_LANG?.trim() || "eng+ara";

type ScreenJobInput = {
  jobId: string | undefined;
  teamId: string;
  evidenceId: string;
  runId: string;
};

export async function processReconstructScreenJob(
  input: ScreenJobInput,
): Promise<{ ok: true; signalsEmitted: number; deferred?: boolean }> {
  const { jobId, teamId, evidenceId, runId } = input;
  const requestId = randomUUID();

  // Lazy-import the run tracker + orchestrator from shared-runtime. Import
  // failure is transient and throws so BullMQ retries with backoff.
  let markRunProcessing: typeof import("@proovra/shared-runtime/media-intelligence")["markRunProcessing"];
  let markRunCompleted: typeof import("@proovra/shared-runtime/media-intelligence")["markRunCompleted"];
  let markRunFailed: typeof import("@proovra/shared-runtime/media-intelligence")["markRunFailed"];
  let runAndPersistScreenIntelligence: typeof import("@proovra/shared-runtime/media-intelligence")["runAndPersistScreenIntelligence"];
  let resolveWorkspaceOcrAllowed: typeof import("@proovra/shared-runtime/media-intelligence")["resolveWorkspaceOcrAllowed"];
  try {
    ({
      markRunProcessing,
      markRunCompleted,
      markRunFailed,
      runAndPersistScreenIntelligence,
      resolveWorkspaceOcrAllowed,
    } = await import("@proovra/shared-runtime/media-intelligence"));
  } catch (err) {
    logger.error(
      { requestId, jobId, err: err instanceof Error ? err.message : "unknown" },
      "screen_intelligence.import_failed",
    );
    throw err;
  }

  // Claim (PENDING/FAILED → PROCESSING, or takeover of an expired lease). The
  // returned fence gates every terminal write below.
  const proc = await markRunProcessing(runId, teamId, prisma);
  if (!proc.ok) {
    if (proc.reason === "max_retries_exceeded") {
      await bumpSafe("media_intelligence_dlq_total");
      logger.warn(
        { requestId, jobId, runId },
        "screen_intelligence.max_retries_exceeded",
      );
      return { ok: true, signalsEmitted: 0 };
    }
    throw new Error(`run_tracker_unavailable: ${proc.reason}`);
  }
  const runFence = proc.fence;

  // Source discovery — ORIGINAL screen frames (UC-2) / segments (UC-3), team-
  // anchored so cross-tenant enumeration is impossible. Ordered by part index
  // (temporal order for continuous capture).
  const parts = (await prisma.$queryRawUnsafe(
    `SELECT p."id", p."storage_bucket", p."storage_key",
            p."mime_type", p."sha256", p."part_index"
       FROM "evidence_parts" p
       JOIN "evidence" e ON e."id" = p."evidence_id"
      WHERE e."team_id" = $1 AND e."id" = $2
      ORDER BY p."part_index" ASC`,
    teamId,
    evidenceId,
  )) as Array<{
    id: string;
    storage_bucket: string | null;
    storage_key: string | null;
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
      mimeType: p.mime_type,
      sha256: p.sha256,
      acquisitionRole: null as string | null,
    }));

  if (screenParts.length === 0) {
    // No screen material — the run is truthfully done with nothing to derive.
    await markRunCompleted(runId, teamId, prisma, runFence);
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
      select: { status: true },
    });
    if (session && session.status === "INTERRUPTED") acquisitionComplete = false;
  } catch {
    /* absence ⇒ treat as complete (non-direct-capture evidence) */
  }

  // Workspace OCR gate (LOCAL OCR). Fail-closed; deterministic keyframe work
  // proceeds regardless and the DERIVED result is truthfully PARTIAL.
  const ocrAllowed = await resolveWorkspaceOcrAllowed(teamId, prisma);
  const tesseractCap = ocrAllowed ? await detectTesseractCapability() : { ok: false as const, reason: "policy_disabled" };
  const ocrProvider = ocrAllowed && tesseractCap.ok
    ? await createTesseractOcrProvider(OCR_LANG)
    : null;

  // Effective legal hold — blocks superseded-object cleanup during regeneration.
  let holdActive = false;
  try {
    const hold = await evaluateEffectiveLegalHold(prisma, { teamId, evidenceId });
    holdActive = hold.held;
  } catch {
    holdActive = true; // fail-closed: never delete under an unknown hold state
  }

  try {
    const result = await runAndPersistScreenIntelligence(
      {
        teamId,
        evidenceId,
        parts: screenParts,
        acquisitionComplete,
      },
      {
        prisma,
        holdActive,
        getSourceBytes: async ({ bucket, key, maxBytes }) =>
          getObjectRange({ bucket, key, range: `bytes=0-${maxBytes - 1}` }),
        produceKeyframes: (kfInput) => produceVideoKeyframes(kfInput),
        putKeyframeObject: async ({ bucket, key, body, contentType }) => {
          await putObjectBuffer({ bucket, key, body, contentType });
        },
        deleteObject: async ({ bucket, key }) => {
          await deleteObject({ bucket, key });
        },
        ocr: {
          name: ocrProvider?.name ?? "tesseract",
          version: ocrProvider?.version ?? (ocrAllowed ? "unavailable" : "policy-disabled"),
          local: true,
          enabled: Boolean(ocrProvider),
          extractFromBytes: async (bytes: Buffer): Promise<OcrExtractResult> => {
            if (!ocrProvider) return { regions: [] };
            return runOcrOnBytes(ocrProvider, bytes);
          },
        },
      },
    );

    if (!result.ok) {
      // Structural (no parts, descriptor too large) — record FAILED, drain.
      await markRunFailed(runId, teamId, `screen_reconstruction:${result.reason}`, prisma, runFence);
      await bumpSafe("media_intelligence_processor_failed_total");
      logger.warn(
        { requestId, jobId, runId, evidenceId, reason: result.reason },
        "screen_intelligence.failed_structural",
      );
      return { ok: true, signalsEmitted: 0 };
    }

    await markRunCompleted(runId, teamId, prisma, runFence);
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
        coverage: result.coverage,
        ocrEnabled: result.ocrEnabled,
        keyframeCount: result.keyframeCount,
        blockCount: result.blockCount,
        observationCount: result.observationCount,
        derivedBytes: result.derivedBytes,
      },
      "screen_intelligence.completed",
    );
    return { ok: true, signalsEmitted: result.blockCount };
  } catch (err) {
    // Transient (storage/DB) — mark FAILED for operator visibility and rethrow
    // so BullMQ retries with backoff. The fence protects the terminal write.
    await markRunFailed(
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
 * Run the LOCAL Tesseract provider over image bytes: write to a private,
 * uniquely-named temp file, OCR by path (argv spawn — no shell), and unlink in
 * a finally so a crash leaves at most one bounded, OS-swept temp file.
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
    return await provider.extract({ imageRef: file });
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
