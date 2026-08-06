/**
 * PHASE 12 — POINT 5: workspace graph-reconcile producer.
 *
 * Why this file exists at all: the reconcile used to run IN-PROCESS in the api
 * during evidence completion, which bypassed the worker entirely — and so the
 * worker-side `indexExistingOcrAndTranscript` step never executed, leaving OCR
 * and transcript text out of the search index and the graph projection. Moving
 * it onto the queue fixed that.
 *
 * What Point 5 changes here is the JOB IDENTITY.
 *
 * The old deterministic id was
 *
 *     graph-reconcile:<teamId>:<reason>:<evidenceId ?? "workspace">
 *
 * which reads as a dedupe key but is not one. The job it schedules is a FULL
 * per-workspace reconcile: it does not read `reason` and it does not read
 * `evidenceId`. So completing three evidence records in a workspace produced
 * three ids, three jobs and three identical full rebuilds — and a manual
 * refresh during that window produced a fourth. The id was discriminating on
 * fields the work does not depend on.
 *
 * The canonical id is `graph-reconcile-<workspaceId>`: one live reconcile per
 * workspace, which is what "one job per durable authority row" means. `reason`
 * survives as bounded trace metadata; `evidenceId`, `requestedByUserId` and
 * `requestId` are dropped, because the job never read them.
 *
 * Never throws — a Redis outage returns `{ queued: false, ... }` so the
 * completion path is not broken by a projection refresh.
 */

import {
  JOB_NAMES,
  buildCanonicalJobId,
  getWorkEntryOrThrow,
} from "@proovra/shared";

import { enqueueCanonicalWork } from "./canonical-queue-client.js";

export interface GraphReconcileJobPayload {
  teamId: string;
  reason:
    | "evidence_completed"
    | "manual_refresh"
    | "scheduled_reconcile"
    | "admin_repair";
  /**
   * Retained on the INPUT for the caller's own logging. None of these three
   * reach the queue: the reconcile is per-workspace and never read them.
   */
  evidenceId?: string;
  requestedByUserId?: string;
  requestId?: string;
}

export interface GraphReconcileEnqueueResult {
  queued: boolean;
  jobId: string;
  reason: string;
}

const ENTRY = getWorkEntryOrThrow(JOB_NAMES.RECONCILE_TEAM_GRAPH);

/**
 * Best-effort async enqueue of a workspace-graph reconcile. Fire-and-forget:
 * the worker is the source of truth for actually running `reconcileTeamGraph()`
 * and its OCR/transcript indexer step.
 */
export async function enqueueGraphReconcileJob(
  payload: GraphReconcileJobPayload,
): Promise<GraphReconcileEnqueueResult> {
  // Derivable without touching Redis, so a caller's failure log can still name
  // the job that was not scheduled.
  const jobId = buildCanonicalJobId(
    { jobIdPrefix: ENTRY.jobIdPrefix! },
    payload.teamId,
  );

  const outcome = await enqueueCanonicalWork({
    workName: JOB_NAMES.RECONCILE_TEAM_GRAPH,
    commandId: payload.teamId,
    traceId: payload.reason,
  });

  if (!outcome.enqueued) {
    return { queued: false, jobId, reason: outcome.reason };
  }
  // A collapsed enqueue reports `queued: false` with a bounded reason,
  // preserving the shape callers already branch on: the intent is satisfied by
  // the live job, and that is not a new schedule.
  return outcome.collapsed
    ? { queued: false, jobId: outcome.jobId, reason: "job_already_live" }
    : { queued: true, jobId: outcome.jobId, reason: "enqueued" };
}
