/**
 * Is a search rebuild for an outstanding record queued or running RIGHT NOW?
 *
 * WHY THIS EXISTS
 *
 * Search converges asynchronously: the finalize fan-out and the periodic
 * reconciler both ENQUEUE a rebuild and return. So between the enqueue and the
 * worker's write there is a real interval in which the index is empty, nothing
 * holds a reconciliation lease, and the workspace is nonetheless being worked
 * on. Readiness has to be able to tell that interval apart from an abandoned
 * one, and neither the run row nor `MAX(indexed_at_utc)` can do it.
 *
 * The first attempt was a five-minute credit window on the completed run: "a
 * run that finished recently counts as progressing". That was wrong in both
 * directions and provably so from the queue's own contract.
 * `RETRY_POLICIES.PROJECTION` gives a rebuild five attempts at a ten-minute
 * timeout each — a job on its final attempt outlives the whole window, so a
 * genuinely running rebuild reported STALLED, which is a second false state in
 * the opposite direction from the one being fixed. And an enqueue accepted by a
 * queue nobody consumes reported INITIALIZING for five minutes on no evidence.
 *
 * A clock cannot distinguish delayed work from abandoned work. The queue can.
 *
 * HOW
 *
 * Rebuild jobs carry a DETERMINISTIC id derived from `(kind, sourceId)` — the
 * same identity the producer uses to collapse duplicates. So an outstanding
 * record can be addressed directly and the queue asked what it holds for it.
 * `waiting`, `delayed` and `active` are proof that work is in flight at ANY
 * elapsed time; `failed` is proof the ladder was exhausted; absence is proof
 * nothing was scheduled or it already completed.
 *
 * BOUNDED. The question is "is anything in flight", not "how much", so the
 * probe stops at the first pending job and never inspects more than
 * `PROBE_CEILING` records. A readiness read must not become a queue scan.
 *
 * READ-ONLY. `getJobState` is a read. Nothing here enqueues, retries, removes,
 * promotes or drains — a diagnosis must not change the thing it is diagnosing.
 *
 * FAIL-CLOSED. An unreachable queue reports `queueReachable: false`, and
 * readiness treats that as no evidence rather than as an empty queue. Failing
 * closed lands on STALLED, which is the state the reconciler acts on, so the
 * safe answer is also the one that triggers recovery.
 */

import {
  JOB_NAMES,
  QUEUE_NAMES,
  buildCanonicalJobId,
  buildSearchIndexCommandId,
  getWorkEntryOrThrow,
  type SearchScheduledWorkFacts,
} from "@proovra/shared";

import { getReadOnlyQueueHandle } from "../../queue/canonical-queue-client.js";

const ENTRY = getWorkEntryOrThrow(JOB_NAMES.REBUILD_SEARCH_DOCUMENT);

/**
 * A registry entry with no job-id prefix is a database sweep, not a queue job,
 * and has no addressable job identity at all. `RebuildSearchDocument` has one;
 * asserting it here rather than defaulting to a string means a registry edit
 * that removed it would fail loudly at import instead of silently probing job
 * ids under an empty prefix and reporting "nothing scheduled" forever.
 */
const JOB_ID_ENTRY: { jobIdPrefix: string } = (() => {
  if (!ENTRY.jobIdPrefix) {
    throw new Error(
      "search-scheduled-work: RebuildSearchDocument has no jobIdPrefix; " +
        "its job identity is not addressable and readiness cannot probe it.",
    );
  }
  return { jobIdPrefix: ENTRY.jobIdPrefix };
})();

/**
 * The most outstanding records one probe will ask about.
 *
 * Sized for the question rather than the corpus: one pending job is a complete
 * answer, so a workspace with ten thousand outstanding records is settled by
 * the first reply in the overwhelming majority of cases. The ceiling only
 * matters in the pathological case where the first N records happen to have no
 * job — and there, stopping and reporting "no evidence" is correct, because
 * STALLED is what makes the reconciler pick the workspace up.
 */
export const SEARCH_SCHEDULED_WORK_PROBE_CEILING = 20;

/** Queue states that mean the rebuild has not been given up on. */
const PENDING_STATES = new Set(["waiting", "waiting-children", "delayed", "active", "prioritized"]);

/**
 * The queue surface this probe needs, and nothing more.
 *
 * Declared structurally so the module can be exercised against a stub without
 * a Redis connection, and so it is impossible to reach a mutating method from
 * here — the type does not have one.
 */
export type SearchJobStateReader = {
  getJobState: (jobId: string) => Promise<string>;
};

export type ProbeSearchScheduledWorkInput = {
  /**
   * Outstanding records, already bounded and tenant-scoped by the caller.
   *
   * The caller reads these from the database under the same eligibility
   * predicate readiness counts with, so the probe can never be pointed at a
   * record the workspace does not own.
   */
  sourceIds: readonly string[];
  /**
   * Injected by tests. Production OMITS it and the canonical read-only handle
   * is resolved instead.
   *
   * ABSENT and `null` mean different things, and conflating them hid a real
   * case: `null` is "there is no handle", which is the production
   * queue-unavailable path and must report unreachable; absent is "resolve one
   * yourself". A `??` fallback treated both as absent, so a caller that
   * explicitly said "no queue" silently got a live one.
   */
  reader?: SearchJobStateReader | null;
};

/**
 * Ask the queue what it currently holds for these records.
 *
 * Never throws: readiness is a read path, and a queue problem must degrade the
 * evidence rather than fail the request.
 */
export async function probeSearchScheduledWork(
  input: ProbeSearchScheduledWorkInput,
): Promise<SearchScheduledWorkFacts> {
  const none: SearchScheduledWorkFacts = {
    queueReachable: false,
    pending: 0,
    failed: 0,
  };

  if (input.sourceIds.length === 0) {
    // Nothing outstanding to ask about. Reported as reachable-with-nothing
    // rather than unreachable: the absence of pending work here is a fact,
    // not a failure to observe one.
    return { queueReachable: true, pending: 0, failed: 0 };
  }

  const reader = Object.prototype.hasOwnProperty.call(input, "reader")
    ? (input.reader ?? null)
    : (getReadOnlyQueueHandle(
        QUEUE_NAMES.SEARCH_INDEXING,
        JOB_NAMES.REBUILD_SEARCH_DOCUMENT,
      ) as SearchJobStateReader | null);
  if (!reader) return none;

  let pending = 0;
  let failed = 0;
  let answered = false;

  for (const sourceId of input.sourceIds.slice(
    0,
    SEARCH_SCHEDULED_WORK_PROBE_CEILING,
  )) {
    let jobId: string;
    try {
      jobId = buildCanonicalJobId(
        JOB_ID_ENTRY,
        buildSearchIndexCommandId("evidence", sourceId),
      );
    } catch {
      // An id this producer could never have created. Not evidence either way.
      continue;
    }
    try {
      const state = await reader.getJobState(jobId);
      answered = true;
      if (PENDING_STATES.has(state)) {
        pending += 1;
        // One is enough. The question is whether ANYTHING is in flight, and a
        // readiness read has no business walking the rest of the corpus to
        // refine an answer it already has.
        break;
      }
      if (state === "failed") failed += 1;
    } catch {
      // The queue stopped answering mid-probe. Whatever was counted so far is
      // still true, but "no pending found" would now be a conclusion drawn
      // from an incomplete read — so the whole probe reports unreachable.
      return none;
    }
  }

  return answered
    ? { queueReachable: true, pending, failed }
    : // Every id was unbuildable, so the queue was never actually asked.
      none;
}
