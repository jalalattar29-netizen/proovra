/**
 * Evidence finalization fan-out service.
 *
 * Owns ALL post-finalize side-effect orchestration that runs after an
 * evidence record transitions to SIGNED. Lives in its own file so that
 * `evidence-complete.service.ts` stays focused on the completion state
 * machine and stays under its byte-pin cap as the fan-out grows.
 *
 * Architecture invariants:
 *
 *   1. Never throws to the caller. Every enqueue is best-effort. A
 *      producer outage or misconfiguration MUST NOT block evidence
 *      completion. The canonical catch-up paths remain:
 *        - operator-triggered POST /v1/evidence/:id/media-intelligence/run
 *        - periodic graph reconcile cron (POST /v1/ops/reconcile)
 *        - search re-indexing cron
 *
 *   2. Idempotent. Every helper called here uses deterministic jobIds
 *      so concurrent finalizations / replays collapse to a single
 *      queued job rather than piling up.
 *
 *   3. requestId propagation. The caller passes the inbound request id
 *      so queued jobs are observable across the API → worker boundary.
 *
 *   4. Bounded logging. Failures are logged under bounded codes (no
 *      raw stack traces, no PII). Codes:
 *        - finalize_fanout.search_indexing_failed
 *        - finalize_fanout.media_intelligence_failed
 *        - finalize_fanout.graph_reconcile_failed
 *
 *   5. Worker is the canonical reconcile path. Phase 14 design intent
 *      (services/worker/src/subsystem-queue-processors.ts:178-191) is
 *      that the WORKER calls reconcileTeamGraph with the onReconciled
 *      hook that fires enqueueSearchIndexingJob with reason
 *      "graph_reconciled". The API only enqueues the worker job; it
 *      does not run the reconciler inline. The "graph_reconciled"
 *      search-index reason is therefore enqueued by the worker, not
 *      by this fan-out — this file's comment block documents the
 *      contract so the wiring stays discoverable from API source.
 */

import { enqueueSearchIndexingJob } from "../queue/search-queue.js";
import { enqueueMediaIntelligenceAnalysis } from "../queue/media-intelligence-queue.js";
import { enqueueGraphReconcileJob } from "../queue/graph-reconcile-queue.js";

export type EvidenceFinalizationReason =
  | "evidence_completed"
  | "manual_refresh"
  | "scheduled_reconcile"
  | "admin_repair";

export interface EvidenceFinalizationFanoutInput {
  teamId: string;
  evidenceId: string;
  /** Acting user, if any. Forwarded to audit on downstream queued jobs. */
  userId?: string | null;
  /** Inbound request id for cross-boundary tracing. */
  requestId?: string | null;
  /** Why the fan-out is firing. */
  reason: EvidenceFinalizationReason;
  /**
   * Signing-key version of the finalized evidence (when reason is
   * "evidence_completed"). Carried only for operational dashboards;
   * the producer's own dedupe key remains (kind, evidenceId) so
   * concurrent finalizations don't pile up jobs.
   */
  signatureVersion?: string | number | null;
}

export interface EvidenceFinalizationFanoutResult {
  searchIndexingEnqueued: boolean;
  mediaIntelligenceEnqueued: boolean;
  graphReconcileEnqueued: boolean;
  failureReasons: string[];
}

interface FanoutLogger {
  warn?: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * Run the post-finalize fan-out. Never throws.
 *
 * Wiring contract (Phase 14 + Phase 11 EVENT_WIRE consumers):
 *
 *   - enqueueSearchIndexingJob({kind:"evidence", reason}) — primary
 *     search index refresh when evidence completes. The worker's graph
 *     reconcile processor will ALSO enqueue searchIndexing with reason
 *     "graph_reconciled" via the onReconciled hook on reconcileTeamGraph
 *     (subsystem-queue-processors.ts:178-191) once the queued reconcile
 *     completes; that path is the canonical "graph_reconciled" producer.
 *
 *   - enqueueMediaIntelligenceAnalysis({kind:"analyze_metadata"}) —
 *     drives media_intelligence_signals population so /investigation
 *     overview shows real counters.
 *
 *   - enqueueGraphReconcileJob({reason}) — worker-side reconcile job;
 *     consumer is processGraphReconcileJob in
 *     services/worker/src/subsystem-queue-processors.ts:142+. That
 *     processor calls reconcileTeamGraph with the onReconciled hook
 *     and runs the indexExistingOcrAndTranscript sidecar (which the
 *     historical in-process IIFE bypassed).
 */
export async function runEvidenceFinalizationFanout(
  input: EvidenceFinalizationFanoutInput,
  logger?: FanoutLogger,
): Promise<EvidenceFinalizationFanoutResult> {
  const result: EvidenceFinalizationFanoutResult = {
    searchIndexingEnqueued: false,
    mediaIntelligenceEnqueued: false,
    graphReconcileEnqueued: false,
    failureReasons: [],
  };

  const tag = {
    teamId: input.teamId,
    evidenceId: input.evidenceId,
    reason: input.reason,
    requestId: input.requestId ?? null,
  };

  // (1) Search re-index. Deterministic via the helper's own jobId.
  try {
    await enqueueSearchIndexingJob({
      teamId: input.teamId,
      kind: "evidence",
      sourceId: input.evidenceId,
      reason: input.reason,
    });
    result.searchIndexingEnqueued = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "search_indexing_failed";
    result.failureReasons.push(`search_indexing:${msg.slice(0, 80)}`);
    logger?.warn?.({ ...tag, err: msg.slice(0, 200) }, "finalize_fanout.search_indexing_failed");
  }

  // (2) Media intelligence analyze_metadata.
  // The producer dedupes on (kind, evidenceId); re-issuing for the
  // same signing-key version collapses to the existing queued job.
  try {
    await enqueueMediaIntelligenceAnalysis({
      teamId: input.teamId,
      evidenceId: input.evidenceId,
      kind: "analyze_metadata",
    });
    result.mediaIntelligenceEnqueued = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "media_intelligence_failed";
    result.failureReasons.push(`media_intelligence:${msg.slice(0, 80)}`);
    logger?.warn?.({ ...tag, err: msg.slice(0, 200) }, "finalize_fanout.media_intelligence_failed");
  }

  // (3) Worker-side graph reconcile. The worker's processor calls
  // reconcileTeamGraph with the onReconciled hook that fires
  // enqueueSearchIndexingJob({reason:"graph_reconciled"}); see
  // services/worker/src/subsystem-queue-processors.ts:178-191.
  try {
    await enqueueGraphReconcileJob({
      teamId: input.teamId,
      reason: input.reason,
      evidenceId: input.evidenceId,
    });
    result.graphReconcileEnqueued = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "graph_reconcile_failed";
    result.failureReasons.push(`graph_reconcile:${msg.slice(0, 80)}`);
    logger?.warn?.({ ...tag, err: msg.slice(0, 200) }, "finalize_fanout.graph_reconcile_failed");
  }

  return result;
}
