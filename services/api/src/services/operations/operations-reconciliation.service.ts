/**
 * WORKSPACE OPERATIONS RECONCILIATION — the API-side body, and the ensure path.
 *
 * The lock, the lease, the terminal states and the readiness projection are
 * NOT here. They live in `@proovra/shared-runtime`, shared with every other
 * reconciliation family, because a second run system would be a second lock
 * and two locks over one workspace exclude nothing. What lives here is the
 * WORK: the discovery sweep, which reads a dozen domain services that this
 * process owns.
 *
 * Two entry points, one lock:
 *
 *   * `reconcileWorkspaceOperations` — do the discovery now, under the lock.
 *     Used by the scheduler and by an explicit operator-triggered run.
 *   * `ensureWorkspaceOperationsFresh` — "if the picture is stale or has never
 *     been built, start building it". Used by GET handlers, which must NOT run
 *     an unbounded discovery inside a request.
 */

import { prisma } from "../../db.js";
import {
  latestWorkspaceOperationsRun,
  reconcileWorkspaceOperationalConditions,
  safeOperationsFailureCategory,
  type OperationsReconcileOutcome,
  type WorkspaceOperationsRunSnapshot,
} from "@proovra/shared-runtime";

import { generateIncidentsForWorkspace } from "../dashboard/incident-generator.service.js";
import { requiredSourceIds } from "./operations-source-registry.js";

/**
 * Run one workspace's discovery under the durable lock.
 *
 * Never throws. A failure becomes a FAILED run row with a bounded category —
 * which is the point: a discovery that blew up must leave a durable trace,
 * because the alternative is a workspace whose conditions silently stopped
 * being found while its page kept rendering the last complete answer.
 */
export async function reconcileWorkspaceOperations(input: {
  workspaceId: string;
  trigger: "scheduler" | "startup" | "api" | "ensure" | "cli";
  triggeredByUserId?: string | null;
}): Promise<OperationsReconcileOutcome> {
  return reconcileWorkspaceOperationalConditions(prisma, {
    workspaceId: input.workspaceId,
    trigger: input.trigger,
    triggeredByUserId: input.triggeredByUserId ?? null,
    body: async () => {
      const discovery = await generateIncidentsForWorkspace({
        teamId: input.workspaceId,
      });
      return {
        recorded: discovery.recorded,
        sources: {
          // The REQUIRED set comes from the registry, not from what this run
          // happened to attempt. That is what makes a forgotten source
          // detectable: if the sweep silently stops attempting one, it is
          // still required, still absent from `successful`, and the run is
          // therefore PARTIAL rather than quietly complete.
          requiredSources: requiredSourceIds(),
          attemptedSources: discovery.sources.attempted,
          successfulSources: discovery.sources.successful,
          failedSources: discovery.sources.failed,
          truncatedSources: discovery.sources.truncated,
          // Discovery is synchronous and self-contained: it does not hand
          // follow-on work to a queue, so there is never a continuation to
          // wait for. Stated rather than omitted so the field's meaning is
          // unambiguous when some future source does schedule one.
          continuationScheduled: false,
        },
      };
    },
  });
}

/** What a read surface learns when it asks for a fresh picture. */
export type EnsureFreshOutcome = {
  /** The run the surface should render from. Null means NEVER_RUN. */
  run: WorkspaceOperationsRunSnapshot | null;
  /** True when this call started (or found already running) a live run. */
  refreshing: boolean;
  /** Bounded reason a refresh could not be started. Null when it could. */
  refreshBlockedReason: string | null;
};

/**
 * "Make sure this workspace's operational picture is current."
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not run discovery inline and wait for it. A GET that performs an
 * unbounded multi-source scan before answering is how the previous design
 * turned page-load into the only reconciliation trigger — and it is why a
 * workspace nobody opened was never scanned at all. The request starts the
 * work and returns what is currently known, including the fact that a run is
 * in progress; the browser polls while that remains true.
 *
 * The discovery is still bounded and still under the same lock, so a hundred
 * simultaneous page loads produce ONE run.
 */
export async function ensureWorkspaceOperationsFresh(input: {
  workspaceId: string;
  now?: Date;
}): Promise<EnsureFreshOutcome> {
  const now = input.now ?? new Date();
  let run: WorkspaceOperationsRunSnapshot | null;
  try {
    run = await latestWorkspaceOperationsRun(prisma, input.workspaceId, now);
  } catch (err) {
    // The run table itself is unreadable. That is an UNKNOWN picture, not a
    // clear one; the caller renders unavailable.
    return {
      run: null,
      refreshing: false,
      refreshBlockedReason: safeOperationsFailureCategory(err),
    };
  }

  // A live run needs nothing started; it needs to be waited for.
  if (run && run.readiness === "RUNNING") {
    return { run, refreshing: true, refreshBlockedReason: null };
  }

  // READY and inside its window: the picture is current, do not churn.
  if (run && run.readiness === "READY") {
    return { run, refreshing: false, refreshBlockedReason: null };
  }

  // NEVER_RUN, STALE, PARTIAL, FAILED or STALLED. All five want a fresh run.
  // STALLED is included deliberately: the lease has expired, so the claim is
  // free, and the next caller is the one that recovers the workspace.
  try {
    const outcome = await reconcileWorkspaceOperations({
      workspaceId: input.workspaceId,
      trigger: "ensure",
    });
    const after = await latestWorkspaceOperationsRun(
      prisma,
      input.workspaceId,
      new Date(),
    );
    return {
      run: after ?? run,
      refreshing:
        outcome.kind === "already_running" ||
        after?.readiness === "RUNNING",
      refreshBlockedReason:
        outcome.kind === "failed" ? outcome.reason : null,
    };
  } catch (err) {
    // The claim could not even be recorded — a dead connection, or a database
    // whose enum predates this deploy. That is this workspace's failure and
    // nothing else's, and it is reported rather than swallowed into a
    // confident empty picture.
    return {
      run,
      refreshing: false,
      refreshBlockedReason: safeOperationsFailureCategory(err),
    };
  }
}

/** Re-export so consumers need one import for the read side. */
export async function readWorkspaceOperationsRun(
  workspaceId: string,
  now: Date = new Date(),
): Promise<WorkspaceOperationsRunSnapshot | null> {
  return latestWorkspaceOperationsRun(prisma, workspaceId, now);
}
