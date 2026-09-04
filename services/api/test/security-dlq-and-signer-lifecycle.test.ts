/**
 * The two behaviours that had to become real, exercised as behaviour.
 *
 * 1. Media-intelligence DLQ replay — bounded, race-safe, truthful counts, and
 *    a response that carries no job identifiers or payload.
 * 2. The signer control-state transition table and its compare-and-set.
 *
 * These run the SHIPPED functions. Nothing here asserts on source text: the
 * previous signer implementation would have passed any number of "the file
 * contains the word revoke" checks while doing nothing at all.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// A queue handle we control, so the limit and the state re-check are provable.
// ---------------------------------------------------------------------------
type FakeJob = {
  id: string;
  data: { teamId: string; evidenceId: string };
  _state: string;
  retried: number;
  getState(): Promise<string>;
  retry(): Promise<void>;
};

const H: { jobs: FakeJob[] } = { jobs: [] };

function makeJob(id: string, teamId: string, state: string): FakeJob {
  return {
    id,
    data: { teamId, evidenceId: `e-${id}` },
    _state: state,
    retried: 0,
    async getState() {
      return this._state;
    },
    async retry() {
      if (this._state !== "failed") throw new Error("not failed");
      this._state = "waiting";
      this.retried += 1;
    },
  };
}

vi.mock("../src/queue/canonical-queue-client.js", () => ({
  getReadOnlyQueueHandle: () => ({
    async getFailed(from: number, to: number) {
      return H.jobs.slice(from, to + 1);
    },
  }),
  enqueueCanonicalWork: async () => ({ enqueued: true }),
}));

vi.mock("../src/services/ops/metrics.service.js", () => ({
  bump: () => undefined,
  setGauge: () => undefined,
}));

const { replayMediaIntelligenceDlq } = await import(
  "../src/queue/media-intelligence-queue.js"
);

const A = "0adf0000-0000-4000-8000-0000000000b1";
const B = "0adf0000-0000-4000-8000-0000000000b3";

describe("media-intelligence DLQ replay", () => {
  beforeEach(() => {
    H.jobs = [];
  });

  it("honours the requested limit rather than draining the queue", async () => {
    H.jobs = [
      makeJob("a1", A, "failed"),
      makeJob("a2", A, "failed"),
      makeJob("a3", A, "failed"),
      makeJob("b1", B, "failed"),
      makeJob("b2", B, "failed"),
    ];
    const res = await replayMediaIntelligenceDlq({ maxJobs: 2 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.discovered).toBe(2);
    expect(res.retried).toBe(2);
    expect(res.limit).toBe(2);
    // The jobs beyond the limit were never touched.
    expect(H.jobs.slice(2).every((j) => j.retried === 0)).toBe(true);
  });

  it("clamps an absurd limit instead of accepting it", async () => {
    H.jobs = Array.from({ length: 400 }, (_, i) => makeJob(`x${i}`, A, "failed"));
    const res = await replayMediaIntelligenceDlq({ maxJobs: 100_000 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.discovered).toBeLessThanOrEqual(200);
  });

  it("does not retry a job that stopped being failed after the snapshot", async () => {
    // This is the duplicate-work case: two operators replay at once, or the
    // worker picks the job up between the read and the retry.
    const moved = makeJob("m1", A, "completed");
    const stillFailed = makeJob("m2", A, "failed");
    H.jobs = [moved, stillFailed];

    const res = await replayMediaIntelligenceDlq({ maxJobs: 50 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.discovered).toBe(2);
    expect(res.eligible).toBe(1);
    expect(res.retried).toBe(1);
    expect(res.skipped).toBe(1);
    expect(moved.retried).toBe(0);
  });

  it("counts always reconcile, so a skipped job is never reported as replayed", async () => {
    H.jobs = [
      makeJob("k1", A, "failed"),
      makeJob("k2", A, "active"),
      makeJob("k3", B, "completed"),
      makeJob("k4", B, "failed"),
    ];
    const res = await replayMediaIntelligenceDlq({ maxJobs: 50 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.retried + res.skipped).toBe(res.discovered);
    expect(res.retried).toBe(2);
  });

  it("reports an empty queue as an explicit zero", async () => {
    const res = await replayMediaIntelligenceDlq({ maxJobs: 50 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.discovered).toBe(0);
    expect(res.retried).toBe(0);
  });

  it("returns no job identifier, workspace id or payload field", async () => {
    H.jobs = [makeJob("secret-job-id", A, "failed")];
    const res = await replayMediaIntelligenceDlq({ maxJobs: 50 });
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain("secret-job-id");
    expect(serialized).not.toContain(A);
    expect(serialized).not.toContain("evidenceId");
  });
});

// ---------------------------------------------------------------------------
// The signer transition table. The DB-backed half (persistence across restart,
// compare-and-set, the signing boundary) is proven against real PostgreSQL.
// ---------------------------------------------------------------------------
const { isTransitionAllowed, statusPermitsSigning } = await import(
  "../src/services/operations/signer-control-state.service.js"
);

describe("signer lifecycle transition table", () => {
  it("permits the two forward moves from ACTIVE", () => {
    expect(isTransitionAllowed("ACTIVE", "RETIRED")).toBe(true);
    expect(isTransitionAllowed("ACTIVE", "REVOKED")).toBe(true);
  });

  it("lets a retired signer still be revoked", () => {
    expect(isTransitionAllowed("RETIRED", "REVOKED")).toBe(true);
  });

  it("makes REVOKED terminal in both directions", () => {
    // Revocation is the word this product uses for a suspected compromise.
    // A compromise is not undone by a button.
    expect(isTransitionAllowed("REVOKED", "ACTIVE")).toBe(false);
    expect(isTransitionAllowed("REVOKED", "RETIRED")).toBe(false);
  });

  it("never lets a retired signer walk back to active", () => {
    expect(isTransitionAllowed("RETIRED", "ACTIVE")).toBe(false);
  });

  it("only ACTIVE may sign — which is the whole point of the table", () => {
    expect(statusPermitsSigning("ACTIVE")).toBe(true);
    expect(statusPermitsSigning("RETIRED")).toBe(false);
    expect(statusPermitsSigning("REVOKED")).toBe(false);
  });
});
