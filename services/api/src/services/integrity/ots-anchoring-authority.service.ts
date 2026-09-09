/**
 * THE ONE API-SIDE REQUEST AUTHORITY FOR OTS ANCHORING.
 *
 * ===========================================================================
 * WHY THIS MODULE EXISTS
 * ===========================================================================
 * The canonical work registry makes one central claim: ONE producer module per
 * work name. When evidence finalization began entering the OTS lifecycle, the
 * API had two modules calling `enqueueCanonicalWork(UPGRADE_OTS)` — the
 * completion path and the Operations remediation executor — and the audit
 * engine reported exactly that as `parallelAuthorities = 1`.
 *
 * It was right to. Two producers for one work name is two places to get the
 * semantics wrong, and they had already begun to diverge: one wanted to know
 * whether the request collapsed onto live work, the other did not care; one
 * must never fail a caller, the other reports the outcome to an operator.
 *
 * So the enqueue lives here once, and both callers state their intent instead.
 * This mirrors `requestReportGeneration`, which is the same shape for the same
 * reason on the commercial side.
 *
 * ===========================================================================
 * WHAT THIS IS NOT
 * ===========================================================================
 * It is not a second OTS state machine, and it writes no OTS column. The
 * worker owns the whole lifecycle — `ots-lifecycle.ts` initializes,
 * `ots-upgrade.processor.ts` upgrades, `ots-state.ts` decides what the columns
 * may say. This module only asks for that work to run.
 *
 * It also asks NOTHING commercial. There is no plan, entitlement, funding or
 * credit input, and no parameter through which one could be supplied:
 * OpenTimestamps is part of the base integrity layer and every finalized
 * record enters it on every plan. The commercial question — Report and
 * Verification Package — is asked elsewhere and decides only those.
 */

import { JOB_NAMES } from "@proovra/shared";

import { enqueueCanonicalWork } from "../../queue/canonical-queue-client.js";

/**
 * Why anchoring was requested. Carried as the trace id, so a job can be traced
 * back to the thing that asked for it.
 */
export type OtsAnchoringTrigger =
  /** A record just finalized. The normal path for every new record. */
  | "evidence.completed"
  /** An operator resolved an anchoring condition from Operations. */
  | "operations.remediation"
  /** The bounded reconciliation of records that predate the decoupling. */
  | "ots.reconciliation";

export type OtsAnchoringRequest = {
  requested: boolean;
  /** Set when the queue accepted a NEW unit of work. */
  jobId?: string;
  /**
   * Why not, when `requested` is false. `collapsed` means a job for this
   * record is already live and this request joined it — a success for the
   * completion path, and a distinct outcome an operator needs to see.
   */
  reason?: "collapsed" | "queue_unavailable" | "failed";
};

/**
 * Ask for ONE evidence record's OTS anchoring to run.
 *
 * IDEMPOTENT BY CONSTRUCTION, at two levels. The job id is derived from the
 * evidence id (`ots-upgrade-<id>`), so a second request while one is live
 * collapses onto it rather than creating a second unit of work; and the worker
 * declines a record that already holds a proof, so even a job that does run
 * twice stamps once.
 *
 * IT NEVER THROWS. Anchoring is not a precondition for anything the callers
 * do: a finalized record is finalized whether or not the calendar is
 * reachable, and refusing a completion because a queue was down would trade a
 * durable signature for a timestamp. Callers that need to report the outcome
 * read it from the return value.
 */
export async function requestEvidenceOtsAnchoring(input: {
  evidenceId: string;
  trigger: OtsAnchoringTrigger;
}): Promise<OtsAnchoringRequest> {
  try {
    const outcome = await enqueueCanonicalWork({
      workName: JOB_NAMES.UPGRADE_OTS,
      commandId: input.evidenceId,
      traceId: input.trigger,
    });

    if (outcome.enqueued) return { requested: true, jobId: outcome.jobId };

    const reason = String(outcome.reason ?? "");
    if (reason.includes("collapsed") || reason.includes("duplicate")) {
      return { requested: false, reason: "collapsed" };
    }
    if (reason.includes("queue_unavailable")) {
      return { requested: false, reason: "queue_unavailable" };
    }
    return { requested: false, reason: "failed" };
  } catch {
    return { requested: false, reason: "failed" };
  }
}
