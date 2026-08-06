/**
 * PHASE 12 — POINT 5: semantic-embedding producer.
 *
 * The old payload was `{ teamId, chunkIds[<=200], reason }` and the processor
 * believed both of the first two:
 *
 *   * `teamId` scoped the AI-policy lookup, the per-workspace SPEND gate, the
 *     chunk read and the vector write. A tampered value pointed all four at
 *     another workspace — and because the spend gate is a billing control, the
 *     tenant charged for the provider call was whichever one the message named.
 *
 *   * `chunkIds` was a snapshot taken at enqueue time. Chunks embedded between
 *     enqueue and execution got re-embedded, spending provider budget on work
 *     already done.
 *
 * The command now names ONE anchor chunk. The processor loads that row, derives
 * the workspace from its own `team_id` column, and selects the batch itself
 * from chunks in that workspace that still have no vector.
 *
 * Never throws to the calling flow: the worker-side safety-net backfill in
 * `search-indexing.processor.ts` exists precisely so a failed enqueue cannot
 * leave chunks permanently un-embedded.
 */

import { JOB_NAMES } from "@proovra/shared";

import { bump } from "../services/ops/metrics.service.js";
import { enqueueCanonicalWork } from "./canonical-queue-client.js";

export type EnqueueMiEmbedInput = {
  /**
   * Producer INPUT only, retained for the caller's own logging. It is NOT
   * serialised: the processor derives the workspace from the anchor chunk row.
   */
  teamId: string;
  /**
   * The chunks the caller believes need embedding. Only the FIRST is carried,
   * as the anchor; the processor re-derives the batch from current state, which
   * is what makes a replay cost nothing.
   */
  chunkIds: string[];
  /** Bounded catalog. e.g. "live_indexing", "backfill_script". */
  reason: string;
  delayMs?: number;
};

export async function enqueueEmbedChunks(
  input: EnqueueMiEmbedInput,
): Promise<
  { enqueued: true; jobId: string } | { enqueued: false; reason: string }
> {
  const anchorChunkId = input.chunkIds?.[0]?.trim();
  if (!input.teamId || !anchorChunkId) {
    return { enqueued: false, reason: "empty_payload" };
  }

  const outcome = await enqueueCanonicalWork({
    workName: JOB_NAMES.EMBED_SEMANTIC_CHUNKS,
    commandId: anchorChunkId,
    traceId: input.reason.slice(0, 64),
    delayMs: input.delayMs,
  });

  if (outcome.enqueued) {
    bump("semantic_embed_enqueued_total");
    return { enqueued: true, jobId: outcome.jobId };
  }
  bump("semantic_embed_enqueue_failed_total");
  return { enqueued: false, reason: outcome.reason };
}
