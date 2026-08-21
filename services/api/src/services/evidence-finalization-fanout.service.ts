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
import { prisma } from "../db.js";
import { emitTenantAudit } from "./audit/tenant-audit.service.js";
// Wave 4 — automatic extraction wiring. The fanout consults the
// producer-mode resolver gates + canonical probes BEFORE enqueueing so
// the queue does not accumulate jobs for credentials that aren't bound
// or modes the operator has not opted into. Same probe path the
// resolver uses — no duplicate logic.
import {
  getOcrProducerMode,
  getTranscriptProducerMode,
} from "@proovra/shared-runtime/media-intelligence";
import { probeAzureDocumentIntelligence } from "./redaction/providers/azure-document-intelligence-client.js";
import { probeDeepgram } from "./redaction/providers/deepgram-client.js";

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
  /**
   * Wave 2 — perceptual-hash producer wiring. True when the finalize
   * fanout successfully enqueued a `compute_perceptual_hashes` job for
   * this evidence record. Gated to image / video MIME families because
   * perceptual hashes are meaningless for documents / audio.
   * Failure to enqueue is non-blocking (matches the other three steps).
   */
  perceptualHashEnqueued: boolean;
  /**
   * Wave 4 — automatic OCR producer wiring. True when the finalize
   * fanout successfully enqueued an `extract_ocr_azure` job for this
   * evidence (or the existing queued job was already in flight).
   * Gated to DOCUMENT / PHOTO evidence + producer mode VENDOR_CLOUD +
   * a READY Azure DI probe. Failure to enqueue is non-blocking.
   */
  ocrExtractionEnqueued: boolean;
  /**
   * Wave 4 — automatic transcript producer wiring. True when the
   * finalize fanout successfully enqueued an `extract_transcript_deepgram`
   * job for this evidence. Gated to AUDIO / VIDEO evidence + producer
   * mode VENDOR_CLOUD + a READY Deepgram probe. Failure to enqueue is
   * non-blocking.
   */
  transcriptExtractionEnqueued: boolean;
  /**
   * Enterprise Technical Metadata layer — true when the finalize
   * fanout enqueued (or collapsed onto an in-flight)
   * `extract_technical_metadata` job. Fires for all evidence types.
   * Failure to enqueue is non-blocking.
   */
  technicalMetadataEnqueued: boolean;
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
    perceptualHashEnqueued: false,
    ocrExtractionEnqueued: false,
    transcriptExtractionEnqueued: false,
    technicalMetadataEnqueued: false,
    failureReasons: [],
  };

  const tag = {
    teamId: input.teamId,
    evidenceId: input.evidenceId,
    reason: input.reason,
    requestId: input.requestId ?? null,
  };

  // (1) Search re-index. Deterministic via the helper's own jobId.
  //
  // `enqueueSearchIndexingJob` NEVER THROWS — a missing `REDIS_URL`, a dead
  // connection or an unknown kind all come back as `{ enqueued: false,
  // reason }`. This step used to set `searchIndexingEnqueued = true` on the
  // strength of not having caught anything, so the one condition it exists to
  // report — the enqueue that silently did not happen — was recorded as a
  // success. That is the precise window the periodic reconciler exists to
  // close, and the fanout was telling everything downstream there was nothing
  // to close.
  //
  // The outcome is still NON-BLOCKING: evidence completion does not depend on
  // the queue being reachable. It is simply reported truthfully, so a
  // workspace whose first record never reached the index leaves a trace at the
  // moment it happened rather than only in the drift it causes 15 minutes
  // later.
  try {
    const searchOutcome = await enqueueSearchIndexingJob({
      teamId: input.teamId,
      kind: "evidence",
      sourceId: input.evidenceId,
      reason: input.reason,
    });
    result.searchIndexingEnqueued = searchOutcome.enqueued === true;
    if (!searchOutcome.enqueued) {
      result.failureReasons.push(`search_indexing:${searchOutcome.reason}`);
      logger?.warn?.(
        { ...tag, reason: searchOutcome.reason },
        "finalize_fanout.search_indexing_not_enqueued",
      );
    }
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

  // (4) Wave 2 — perceptual-hash producer.
  //
  // Drives the existing `compute_perceptual_hashes` branch in
  // services/worker/src/media-intelligence.processor.ts. The branch has
  // existed since Phase 12 but no producer ever enqueued it from the
  // finalize fanout, leaving perceptual_similarity structurally zero on
  // every workspace. Wave 2 closes that gap.
  //
  // Gating rules:
  //   * Only image (PHOTO) and video evidence — perceptual hashes are
  //     meaningless for DOCUMENT / AUDIO. The producer dedupes on
  //     (kind, evidenceId) so re-finalize triggers collapse to the
  //     existing queued job.
  //   * Best-effort + non-blocking. A producer outage or a missing
  //     evidence row MUST NOT poison the finalize fanout return value.
  //   * Audit emit goes through the canonical emitTenantAudit facade with
  //     action `PERCEPTUAL_HASH_QUEUED` (free-form action vocabulary,
  //     bounded to 128 chars; no AdminAuditLog direct write per dedup
  //     register).
  try {
    const ev = await prisma.evidence.findUnique({
      where: { id: input.evidenceId },
      select: { type: true, teamId: true },
    });
    const eligible =
      ev?.teamId === input.teamId &&
      (ev?.type === "PHOTO" || ev?.type === "VIDEO");
    if (eligible) {
      const enqueueResult = await enqueueMediaIntelligenceAnalysis({
        teamId: input.teamId,
        evidenceId: input.evidenceId,
        kind: "compute_perceptual_hashes",
      });
      // `enqueued: false, reason: job_*` counts as already-in-flight
      // (idempotent collapse) — treat as success for the audit emit.
      result.perceptualHashEnqueued =
        enqueueResult.enqueued === true ||
        (enqueueResult.enqueued === false &&
          typeof enqueueResult.reason === "string" &&
          enqueueResult.reason.startsWith("job_"));
      // Bounded audit emit. Non-blocking — never throw to caller.
      try {
        await emitTenantAudit({
          action: "PERCEPTUAL_HASH_QUEUED",
          outcome: "success",
          sourceApp: "API",
          actorUserId: input.userId ?? null,
          workspaceId: input.teamId,
          resourceType: "evidence",
          resourceId: input.evidenceId,
          correlationId: input.requestId ?? null,
          metadata: {
            reason: input.reason,
            mimeFamily: ev?.type ?? null,
            queued: result.perceptualHashEnqueued,
            enqueueOutcome:
              enqueueResult.enqueued === true
                ? "enqueued"
                : enqueueResult.reason ?? "unknown",
          },
        });
      } catch {
        /* best-effort audit; never block the producer */
      }
    }
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : "perceptual_hash_failed";
    result.failureReasons.push(`perceptual_hash:${msg.slice(0, 80)}`);
    logger?.warn?.(
      { ...tag, err: msg.slice(0, 200) },
      "finalize_fanout.perceptual_hash_failed",
    );
  }

  // (5) Wave 4 — automatic OCR (Azure Document Intelligence) producer.
  //
  // Three-gate enqueue. The fanout fires `extract_ocr_azure` only when
  // every gate passes; otherwise it silently skips so the queue stays
  // free of jobs that can never succeed:
  //   * Evidence type is DOCUMENT (PDF) or PHOTO (image). Anything else
  //     is structurally incompatible with Azure DI's prebuilt-layout
  //     model.
  //   * Operator-set producer mode is VENDOR_CLOUD. NOT_CONFIGURED /
  //     INDEX_EXISTING_ONLY / LOCAL_TESSERACT modes never opt into
  //     cloud extraction — sending bytes off-prem without the operator
  //     opting in is the exact failure mode the producer-mode resolver
  //     exists to prevent.
  //   * Azure DI probe is READY (credentials bound). If the probe is
  //     NOT_CONFIGURED we never enqueue — the worker would fail
  //     immediately and the operator would see noise.
  //
  // The worker (services/worker/src/media-intelligence.processor.ts
  // extract_ocr_azure branch) calls runProviderOperation, which
  // applies the same budget + entitlement + policy gate chain as the
  // manual route. We do not duplicate that here.
  //
  // Best-effort + non-blocking — same contract as steps 1-4.
  try {
    const ev = await prisma.evidence.findUnique({
      where: { id: input.evidenceId },
      select: { type: true, teamId: true },
    });
    const eligibleType =
      ev?.teamId === input.teamId &&
      (ev?.type === "DOCUMENT" || ev?.type === "PHOTO");
    const ocrMode = getOcrProducerMode();
    const modeReady = ocrMode === "VENDOR_CLOUD";
    const probeReady =
      modeReady ? probeAzureDocumentIntelligence().state === "READY" : false;
    if (eligibleType && modeReady && probeReady) {
      const enqueueResult = await enqueueMediaIntelligenceAnalysis({
        teamId: input.teamId,
        evidenceId: input.evidenceId,
        kind: "extract_ocr_azure",
      });
      result.ocrExtractionEnqueued =
        enqueueResult.enqueued === true ||
        (enqueueResult.enqueued === false &&
          typeof enqueueResult.reason === "string" &&
          enqueueResult.reason.startsWith("job_"));
      try {
        await emitTenantAudit({
          action: "OCR_EXTRACTION_QUEUED",
          outcome: "success",
          sourceApp: "API",
          actorUserId: input.userId ?? null,
          workspaceId: input.teamId,
          resourceType: "evidence",
          resourceId: input.evidenceId,
          correlationId: input.requestId ?? null,
          metadata: {
            evidenceType: ev?.type ?? null,
            provider: "azure",
            queued: result.ocrExtractionEnqueued,
            enqueueOutcome:
              enqueueResult.enqueued === true
                ? "enqueued"
                : enqueueResult.reason ?? "unknown",
          },
        });
      } catch {
        /* best-effort audit; never block the producer */
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "ocr_extract_failed";
    result.failureReasons.push(`ocr_extraction:${msg.slice(0, 80)}`);
    logger?.warn?.(
      { ...tag, err: msg.slice(0, 200) },
      "finalize_fanout.ocr_extraction_failed",
    );
  }

  // (6) Wave 4 — automatic transcript (Deepgram) producer.
  //
  // Mirror of step (5) for audio / video evidence. Same three-gate
  // structure; the worker's extract_transcript_deepgram branch calls
  // runProviderOperation so budget + entitlement + policy gates cover
  // the automatic path.
  try {
    const ev = await prisma.evidence.findUnique({
      where: { id: input.evidenceId },
      select: { type: true, teamId: true },
    });
    const eligibleType =
      ev?.teamId === input.teamId &&
      (ev?.type === "AUDIO" || ev?.type === "VIDEO");
    const transcriptMode = getTranscriptProducerMode();
    const modeReady = transcriptMode === "VENDOR_CLOUD";
    const probeReady = modeReady ? probeDeepgram().state === "READY" : false;
    if (eligibleType && modeReady && probeReady) {
      const enqueueResult = await enqueueMediaIntelligenceAnalysis({
        teamId: input.teamId,
        evidenceId: input.evidenceId,
        kind: "extract_transcript_deepgram",
      });
      result.transcriptExtractionEnqueued =
        enqueueResult.enqueued === true ||
        (enqueueResult.enqueued === false &&
          typeof enqueueResult.reason === "string" &&
          enqueueResult.reason.startsWith("job_"));
      try {
        await emitTenantAudit({
          action: "TRANSCRIPT_EXTRACTION_QUEUED",
          outcome: "success",
          sourceApp: "API",
          actorUserId: input.userId ?? null,
          workspaceId: input.teamId,
          resourceType: "evidence",
          resourceId: input.evidenceId,
          correlationId: input.requestId ?? null,
          metadata: {
            evidenceType: ev?.type ?? null,
            provider: "deepgram",
            queued: result.transcriptExtractionEnqueued,
            enqueueOutcome:
              enqueueResult.enqueued === true
                ? "enqueued"
                : enqueueResult.reason ?? "unknown",
          },
        });
      } catch {
        /* best-effort audit; never block the producer */
      }
    }
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : "transcript_extract_failed";
    result.failureReasons.push(`transcript_extraction:${msg.slice(0, 80)}`);
    logger?.warn?.(
      { ...tag, err: msg.slice(0, 200) },
      "finalize_fanout.transcript_extraction_failed",
    );
  }

  // (7) Enterprise Technical Metadata — deterministic Layer-1 file
  // metadata extraction. Fires for every evidence type (image / video /
  // audio / PDF all carry meaningful technical facts). The worker
  // graceful-degrades per part when tooling (ffprobe) or bytes are
  // unavailable, so there is no probe gate here — the dedupe key
  // (kind, evidenceId) collapses repeat finalizations. Best-effort +
  // non-blocking, identical to steps 1-6.
  try {
    const enqueueResult = await enqueueMediaIntelligenceAnalysis({
      teamId: input.teamId,
      evidenceId: input.evidenceId,
      kind: "extract_technical_metadata",
    });
    result.technicalMetadataEnqueued =
      enqueueResult.enqueued === true ||
      (enqueueResult.enqueued === false &&
        typeof enqueueResult.reason === "string" &&
        enqueueResult.reason.startsWith("job_"));
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : "technical_metadata_failed";
    result.failureReasons.push(`technical_metadata:${msg.slice(0, 80)}`);
    logger?.warn?.(
      { ...tag, err: msg.slice(0, 200) },
      "finalize_fanout.technical_metadata_failed",
    );
  }

  return result;
}
