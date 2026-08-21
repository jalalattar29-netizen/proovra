/**
 * "Is the outstanding work in flight?" is answered by the QUEUE, not a clock.
 *
 * WHAT THIS SUITE EXISTS TO PROVE
 *
 * Search converges asynchronously, so between an enqueue and the worker's
 * write there is a real interval in which the index is empty, no
 * reconciliation lease is held, and the workspace is nonetheless being worked
 * on. The first attempt to describe that interval was a five-minute credit on
 * the completed run's finish time, and it was wrong in both directions:
 *
 *   * `RETRY_POLICIES.PROJECTION` allows FIVE attempts at a TEN-MINUTE timeout
 *     each. A rebuild on its final attempt is legitimately alive far beyond
 *     five minutes, so a healthy system reported STALLED — a second false
 *     state, in the opposite direction from the one being fixed.
 *   * An enqueue accepted by a queue nobody consumes reported INITIALIZING for
 *     five minutes on no evidence at all.
 *
 * The derivation below therefore takes `scheduledWork` — real job state — and
 * these cases pin what it does with it. The probe's own behaviour against a
 * queue is exercised here too, and end-to-end against real BullMQ and real
 * Redis in `search-automatic-recovery.integration.test.ts`.
 */

import { describe, expect, it } from "vitest";

import {
  RETRY_POLICIES,
  deriveSearchReadiness,
  type SearchReadinessInput,
  type SearchScheduledWorkFacts,
} from "@proovra/shared";

import {
  SEARCH_SCHEDULED_WORK_PROBE_CEILING,
  probeSearchScheduledWork,
} from "../src/services/search/search-scheduled-work.service.js";

const NOW = new Date("2026-08-21T12:00:00.000Z");

function readiness(
  over: Partial<SearchReadinessInput> = {},
): ReturnType<typeof deriveSearchReadiness> {
  return deriveSearchReadiness({
    eligibleCount: 2,
    indexedCount: 0,
    lastIndexedAtUtc: null,
    run: null,
    authorized: true,
    now: NOW,
    ...over,
  });
}

const inFlight: SearchScheduledWorkFacts = {
  queueReachable: true,
  pending: 1,
  failed: 0,
};
const nothingQueued: SearchScheduledWorkFacts = {
  queueReachable: true,
  pending: 0,
  failed: 0,
};
const unreachable: SearchScheduledWorkFacts = {
  queueReachable: false,
  pending: 0,
  failed: 0,
};

describe("the five-minute credit could not have been correct", () => {
  it("a single attempt may legitimately outlive any five-minute window", () => {
    // Not an opinion — the queue's own registered contract.
    const p = RETRY_POLICIES.PROJECTION;
    expect(p.timeoutMs).toBeGreaterThan(5 * 60 * 1000);
    // And the ladder as a whole runs an order of magnitude longer.
    let backoff = 0;
    for (let a = 1; a < p.attempts; a += 1) {
      backoff += p.backoffDelayMs * 2 ** (a - 1);
    }
    expect(backoff + p.attempts * p.timeoutMs).toBeGreaterThan(45 * 60 * 1000);
  });
});

describe("readiness reads job state, never elapsed time", () => {
  it("a completed run with drift and a job in flight is INITIALIZING", () => {
    const r = readiness({
      run: { status: "SUCCEEDED", leaseValid: false },
      scheduledWork: inFlight,
    });
    expect(r.state).toBe("INITIALIZING");
    expect(r.shouldPoll).toBe(true);
  });

  it("…and PARTIAL once some records are searchable", () => {
    const r = readiness({
      indexedCount: 1,
      eligibleCount: 3,
      run: { status: "SUCCEEDED", leaseValid: false },
      scheduledWork: inFlight,
    });
    expect(r.state).toBe("PARTIAL");
    expect(r.shouldPoll).toBe(true);
  });

  it("the SAME facts are unchanged by how long ago the run finished", () => {
    // There is no time input to change. That is the property: the derivation
    // is given no finish timestamp at all, so it cannot regress into using one.
    const a = readiness({
      run: { status: "SUCCEEDED", leaseValid: false },
      scheduledWork: inFlight,
      now: new Date("2026-08-21T12:00:00.000Z"),
    });
    const b = readiness({
      run: { status: "SUCCEEDED", leaseValid: false },
      scheduledWork: inFlight,
      now: new Date("2027-08-21T12:00:00.000Z"),
    });
    expect(a.state).toBe(b.state);
    expect(a.state).toBe("INITIALIZING");
  });

  it("a completed run with drift and NOTHING queued is STALLED", () => {
    const r = readiness({
      run: { status: "SUCCEEDED", leaseValid: false },
      scheduledWork: nothingQueued,
    });
    expect(r.state).toBe("STALLED");
    expect(r.shouldPoll).toBe(false);
  });

  it("an UNREACHABLE queue proves nothing and fails closed to STALLED", () => {
    const r = readiness({
      run: { status: "SUCCEEDED", leaseValid: false },
      scheduledWork: unreachable,
    });
    expect(r.state).toBe("STALLED");
  });

  it("a terminally failed job is not in flight", () => {
    const r = readiness({
      run: { status: "SUCCEEDED", leaseValid: false },
      scheduledWork: { queueReachable: true, pending: 0, failed: 3 },
    });
    expect(r.state).toBe("STALLED");
  });

  it("NO run at all plus a queued rebuild is INITIALIZING — the first-record case", () => {
    // The ordinary create path enqueues without any reconciliation run. This
    // used to short-circuit to STALLED before anything could look at the queue,
    // which is the shape of the reported production incident.
    expect(readiness({ run: null, scheduledWork: inFlight }).state).toBe(
      "INITIALIZING",
    );
    expect(readiness({ run: null, scheduledWork: nothingQueued }).state).toBe(
      "STALLED",
    );
    expect(readiness({ run: null }).state).toBe("STALLED");
  });

  it("a live run with a valid lease does not need the queue's permission", () => {
    const r = readiness({
      run: { status: "RUNNING", leaseValid: true },
      scheduledWork: unreachable,
    });
    expect(r.state).toBe("INITIALIZING");
  });

  it("an EXPIRED lease is STALLED even with a job queued", () => {
    // Deliberate. The expired lease is the signal that frees a crashed run's
    // slot; suppressing it would leave the workspace held by nothing.
    const r = readiness({
      run: { status: "RUNNING", leaseValid: false },
      scheduledWork: inFlight,
    });
    expect(r.state).toBe("STALLED");
  });

  it("a FAILED run stays FAILED regardless of what the queue holds", () => {
    expect(
      readiness({
        run: { status: "FAILED", leaseValid: false, failureCategory: "timeout" },
        scheduledWork: inFlight,
      }).state,
    ).toBe("FAILED");
  });

  it("convergence and emptiness are decided before the queue is consulted", () => {
    expect(
      readiness({ eligibleCount: 0, indexedCount: 0, scheduledWork: inFlight })
        .state,
    ).toBe("EMPTY_WORKSPACE");
    expect(
      readiness({ eligibleCount: 2, indexedCount: 2, scheduledWork: inFlight })
        .state,
    ).toBe("READY");
  });
});

describe("the probe reports what it actually observed", () => {
  /** A reader that answers from a script. No Redis, no BullMQ. */
  function reader(states: Record<string, string>) {
    const asked: string[] = [];
    return {
      asked,
      handle: {
        getJobState: async (jobId: string) => {
          asked.push(jobId);
          const hit = Object.entries(states).find(([k]) => jobId.includes(k));
          return hit ? hit[1] : "unknown";
        },
      },
    };
  }

  it("waiting, delayed and active all count as in flight", async () => {
    for (const state of ["waiting", "delayed", "active", "prioritized"]) {
      const r = reader({ "aaa": state });
      const out = await probeSearchScheduledWork({
        sourceIds: ["aaa"],
        reader: r.handle,
      });
      expect(out, state).toEqual({
        queueReachable: true,
        pending: 1,
        failed: 0,
      });
    }
  });

  it("stops at the FIRST pending job — the question is whether anything is", async () => {
    const r = reader({ "aaa": "waiting", "bbb": "waiting" });
    await probeSearchScheduledWork({
      sourceIds: ["aaa", "bbb", "ccc"],
      reader: r.handle,
    });
    // A readiness read must not walk the corpus to refine an answer it has.
    expect(r.asked).toHaveLength(1);
  });

  it("never asks about more than the ceiling", async () => {
    const r = reader({});
    const many = Array.from({ length: 500 }, (_, i) => `id-${i}`);
    await probeSearchScheduledWork({ sourceIds: many, reader: r.handle });
    expect(r.asked).toHaveLength(SEARCH_SCHEDULED_WORK_PROBE_CEILING);
  });

  it("counts terminally failed jobs without calling them pending", async () => {
    const r = reader({ "aaa": "failed", "bbb": "failed" });
    const out = await probeSearchScheduledWork({
      sourceIds: ["aaa", "bbb"],
      reader: r.handle,
    });
    expect(out).toEqual({ queueReachable: true, pending: 0, failed: 2 });
  });

  it("a completed or absent job is neither pending nor failed", async () => {
    const out = await probeSearchScheduledWork({
      sourceIds: ["aaa"],
      reader: reader({ "aaa": "completed" }).handle,
    });
    expect(out).toEqual({ queueReachable: true, pending: 0, failed: 0 });
  });

  it("a queue that stops answering mid-probe reports UNREACHABLE, not empty", async () => {
    // The distinction matters: "asked and found nothing" grants STALLED on
    // evidence, "could not finish asking" grants it on the absence of any.
    // Reporting the second as the first would be a conclusion drawn from an
    // incomplete read.
    const out = await probeSearchScheduledWork({
      sourceIds: ["aaa", "bbb"],
      reader: {
        getJobState: async () => {
          throw new Error("ECONNRESET");
        },
      },
    });
    expect(out).toEqual({ queueReachable: false, pending: 0, failed: 0 });
  });

  it("no outstanding records is a fact, not a failure to observe one", async () => {
    const out = await probeSearchScheduledWork({ sourceIds: [] });
    expect(out).toEqual({ queueReachable: true, pending: 0, failed: 0 });
  });

  it("no queue handle at all is UNREACHABLE", async () => {
    const out = await probeSearchScheduledWork({
      sourceIds: ["aaa"],
      reader: null,
    });
    // `reader: null` with work outstanding means production could not resolve
    // a handle — REDIS_URL absent or the client refused to construct.
    expect(out.queueReachable).toBe(false);
  });

  it("addresses jobs by the id the PRODUCER builds, not one invented here", async () => {
    const r = reader({});
    await probeSearchScheduledWork({
      sourceIds: ["44444444-4444-4444-4444-444444444444"],
      reader: r.handle,
    });
    const [asked] = r.asked;
    expect(asked).toContain("44444444-4444-4444-4444-444444444444");
    // Legal for the transport: a job id BullMQ refuses could never match a job
    // that exists, so the probe would report "nothing scheduled" forever.
    expect(asked).not.toMatch(/:/);
  });
});
