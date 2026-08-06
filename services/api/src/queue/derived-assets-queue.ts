/**
 * PHASE 12 — POINT 5: derived-asset generation producer.
 *
 * The old payload was `{ teamId, evidenceId, evidencePartId, assetKind }` and
 * the processor believed all four. `teamId` in particular scoped the SQL that
 * looked up the source bytes, so a tampered value pointed the read at another
 * workspace's evidence part — and the thumbnail it produced was written back
 * under that same asserted tenant.
 *
 * A durable authority for this work already existed; it just was not being used
 * as one. `EvidencePartDerivedAsset` carries the workspace, the evidence, the
 * part, the kind and the status, and its `(teamId, evidencePartId, assetKind)`
 * unique index is exactly the idempotency the job needed. The producer now
 * COMMITS that row and enqueues its id; the processor derives all four fields
 * from it.
 */

import { JOB_NAMES, type EnqueueOutcome } from "@proovra/shared";
import { bump } from "@proovra/shared-runtime/ops";

import { prisma } from "../db.js";
import {
  enqueueCanonicalWork,
  getReadOnlyQueueHandle,
} from "./canonical-queue-client.js";
import { QUEUE_NAMES } from "@proovra/shared";

/**
 * Bounded catalog. `image_thumbnail` runs sharp; video/audio kinds run ffmpeg;
 * `compact_review_preview` is reserved and the processor records it as
 * UNSUPPORTED rather than pretending to produce it.
 */
export const DERIVED_ASSET_KINDS = [
  "image_thumbnail",
  "video_frame",
  "audio_waveform",
  "low_res_proxy",
  "compact_review_preview",
] as const;

export type DerivedAssetKind = (typeof DERIVED_ASSET_KINDS)[number];

export type DerivedAssetRequestInput = {
  /**
   * Producer INPUT, used to SCOPE THE LOOKUP that proves the caller's evidence
   * part really is in this workspace. It is not serialised, and the processor
   * re-derives it from the committed row.
   */
  teamId: string;
  evidenceId: string;
  evidencePartId: string;
  assetKind: DerivedAssetKind;
};

export type DerivedAssetEnqueueResult =
  | { enqueued: true; jobId: string; derivedAssetId: string }
  | { enqueued: false; reason: string; derivedAssetId?: string };

/**
 * Persist the intent, then enqueue its id.
 *
 * Never throws to the calling route. A Redis outage leaves the row PENDING,
 * which is a recoverable and observable state rather than a lost request.
 */
export async function enqueueDerivedAssetGeneration(
  input: DerivedAssetRequestInput,
): Promise<DerivedAssetEnqueueResult> {
  if (!(DERIVED_ASSET_KINDS as ReadonlyArray<string>).includes(input.assetKind)) {
    return { enqueued: false, reason: "unknown_asset_kind" };
  }

  // The part must belong to the caller's workspace. Proving that HERE is what
  // lets the committed row be trusted later without re-deriving the caller's
  // scope — and it is a real check, not a restatement of the input, because it
  // joins through `evidence.team_id`.
  const part = await prisma.evidencePart.findFirst({
    where: {
      id: input.evidencePartId,
      evidenceId: input.evidenceId,
      evidence: { teamId: input.teamId, deletedAt: null },
    },
    select: { id: true },
  });
  if (!part) {
    return { enqueued: false, reason: "evidence_part_not_found" };
  }

  // The unique index on (teamId, evidencePartId, assetKind) IS the idempotency:
  // two concurrent requests for the same derived asset produce one row, and the
  // deterministic job id then collapses their two enqueues onto one job.
  let derivedAssetId: string;
  try {
    const row = await prisma.evidencePartDerivedAsset.upsert({
      where: {
        teamId_evidencePartId_assetKind: {
          teamId: input.teamId,
          evidencePartId: input.evidencePartId,
          assetKind: input.assetKind,
        },
      },
      create: {
        teamId: input.teamId,
        evidenceId: input.evidenceId,
        evidencePartId: input.evidencePartId,
        assetKind: input.assetKind,
        status: "PENDING",
      },
      // A re-request re-opens the row rather than creating a second one. It
      // deliberately does NOT clear `storageKey`: if a previous run produced an
      // artifact, that artifact stays readable until this run replaces it.
      update: { status: "PENDING", lastError: null },
      select: { id: true },
    });
    derivedAssetId = row.id;
  } catch {
    bump("derived_assets_enqueue_failed_total");
    return { enqueued: false, reason: "request_persist_failed" };
  }

  const outcome: EnqueueOutcome = await enqueueCanonicalWork({
    workName: JOB_NAMES.GENERATE_DERIVED_ASSET,
    commandId: derivedAssetId,
    traceId: input.assetKind,
  });

  if (outcome.enqueued) {
    bump("derived_assets_enqueue_total");
    return { enqueued: true, jobId: outcome.jobId, derivedAssetId };
  }
  bump("derived_assets_enqueue_failed_total");
  return { enqueued: false, reason: outcome.reason, derivedAssetId };
}

/**
 * Operator-triggered single-job retry, used by the /ops media-graph surface.
 *
 * It retries a FAILED job in place rather than enqueuing a new one, so the
 * operator's action cannot produce a second artifact for the same request.
 */
export async function retryDerivedAssetJob(
  jobId: string,
): Promise<{ ok: true; retried: true } | { ok: false; reason: string }> {
  const queue = getReadOnlyQueueHandle(
    QUEUE_NAMES.DERIVED_ASSETS,
    JOB_NAMES.GENERATE_DERIVED_ASSET,
  );
  if (!queue) return { ok: false, reason: "queue_unavailable" };
  try {
    const job = await queue.getJob(jobId);
    if (!job) return { ok: false, reason: "job_not_found" };
    const state = await job.getState();
    if (state !== "failed") {
      return { ok: false, reason: `job_not_failed:${state}` };
    }
    await job.retry();
    bump("derived_assets_enqueue_total");
    return { ok: true, retried: true };
  } catch (err) {
    return {
      ok: false,
      reason:
        err instanceof Error
          ? `retry_failed:${err.message.slice(0, 80)}`
          : "retry_failed",
    };
  }
}
