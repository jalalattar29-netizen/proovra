/**
 * BD-1 — A PENDING JOB REPORTED CANCELLED AND THEN RAN.
 *
 * `cancelJob` acted only on PROCESSING. For a PENDING job it returned `true`
 * having changed nothing; the route read that as cancellation, told the
 * operator "Batch job cancelled", and wrote
 * `enterprise.batch_cancel outcome: success` into the audit log.
 *
 * Two things were wrong and only one of them is about batches. A pending job
 * is the EASIEST one to cancel — nothing has started, so there is nothing to
 * stop and everything to mark. And an audit record asserting an action that
 * did not happen is worse than the failed cancellation: the log is the part
 * that is supposed to be true.
 *
 * These drive the real service. `cancelJob` is pure in-memory state (BD-2 —
 * that is its own debt), so nothing here needs a database.
 */
import { describe, expect, it } from "vitest";

import {
  batchAnalysisService,
  BatchStatus,
  type BatchJobMetadata,
} from "../src/services/batch-analysis.service.js";

const OWNER = "user-1";
const STRANGER = "user-2";

/**
 * A job in a chosen state, put straight into the service's store.
 *
 * The creation path fetches evidence, which is not what is under test here;
 * what is under test is what cancellation does to a job in each state.
 */
function seed(
  service: typeof batchAnalysisService,
  status: BatchStatus,
  itemStatuses: Array<BatchJobMetadata["items"][number]["status"]>,
): string {
  const id = `job-${status}-${Math.random().toString(36).slice(2)}`;
  const store = (service as unknown as { jobs: Record<string, BatchJobMetadata> }).jobs;
  store[id] = {
    id,
    userId: OWNER,
    name: "batch",
    status,
    items: itemStatuses.map((s, i) => ({ evidenceId: `ev-${i}`, status: s })),
    createdAt: new Date(),
    totalItems: itemStatuses.length,
    processedItems: 0,
    failedItems: 0,
  } as BatchJobMetadata;
  return id;
}

describe("BD-1 — batch cancellation says what it did", () => {
  // The service is a module singleton (its store is process memory — BD-2).
  // Each job gets a unique id, so tests do not collide.
  const service = batchAnalysisService;

  it("cancels a PENDING job instead of reporting success for doing nothing", () => {
    // THE DEFECT. This returned true, left the status PENDING, and the job ran.
    const id = seed(service, BatchStatus.PENDING, ["pending", "pending"]);

    expect(service.cancelJob(OWNER, id)).toBe("CANCELLED");

    const job = service.getJob(OWNER, id);
    expect(job?.status).toBe(BatchStatus.CANCELLED);
    expect(job?.completedAt).toBeInstanceOf(Date);
    // Nothing is left claiming it is still waiting to run.
    expect(job?.items.every((i) => i.status === "failed")).toBe(true);
    expect(job?.items.every((i) => i.error === "Job cancelled by user")).toBe(true);
  });

  it("cancels a PROCESSING job, and says so about the items that were running", () => {
    const id = seed(service, BatchStatus.PROCESSING, ["completed", "processing", "pending"]);

    expect(service.cancelJob(OWNER, id)).toBe("CANCELLED");

    const job = service.getJob(OWNER, id);
    expect(job?.status).toBe(BatchStatus.CANCELLED);
    // An item that had already finished keeps its result. Only the ones that
    // were stopped are marked, and they are marked as STOPPED BY THE OPERATOR
    // rather than as a generic failure — "this could not be analysed" and
    // "somebody stopped this" are different things to say about evidence.
    expect(job?.items[0]?.status).toBe("completed");
    expect(job?.items[0]?.error).toBeUndefined();
    expect(job?.items[1]?.error).toBe("Job cancelled by user");
    expect(job?.items[2]?.error).toBe("Job cancelled by user");
  });

  it("refuses a job that has already finished, and does not call it missing", () => {
    // A terminal job is not a job that never existed. The boolean could not
    // tell the two apart, so the route reported one as the other.
    for (const terminal of [BatchStatus.COMPLETED, BatchStatus.FAILED, BatchStatus.CANCELLED]) {
      const id = seed(service, terminal, ["completed"]);
      expect(service.cancelJob(OWNER, id)).toBe("ALREADY_TERMINAL");
      expect(service.getJob(OWNER, id)?.status).toBe(terminal);
    }
  });

  it("a job belonging to someone else answers exactly as one that does not exist", () => {
    const id = seed(service, BatchStatus.PENDING, ["pending"]);

    expect(service.cancelJob(STRANGER, id)).toBe("NOT_FOUND");
    expect(service.cancelJob(OWNER, "no-such-job")).toBe("NOT_FOUND");
    // And the stranger's attempt changed nothing.
    expect(service.getJob(OWNER, id)?.status).toBe(BatchStatus.PENDING);
  });

  it("cancelling twice is refused the second time, not reported as success", () => {
    const id = seed(service, BatchStatus.PROCESSING, ["processing"]);

    expect(service.cancelJob(OWNER, id)).toBe("CANCELLED");
    expect(service.cancelJob(OWNER, id)).toBe("ALREADY_TERMINAL");
  });
});
