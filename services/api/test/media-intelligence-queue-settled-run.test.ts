/**
 * UC-DER-001 — the media-intelligence enqueue never answers "queued" for a run
 * the worker's exclusive claim can never take.
 *
 * `enqueueMediaIntelligenceAnalysis` collapses repeat intent on the run's
 * idempotency key, and the tracker's reuse path returns the existing row
 * WHATEVER its status. Before this fix a settled row (COMPLETED, DISMISSED, or
 * FAILED at the attempt ceiling) was put back on the queue anyway: the job ran,
 * the claim refused it, the handler drained it as success — and the caller had
 * been told `enqueued: true`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  reused: { status: "COMPLETED", attemptCount: 1 } as { status: string; attemptCount: number },
  isReuse: true,
  canonicalCalls: 0,
}));

vi.mock("@proovra/shared-runtime/media-intelligence", async (orig) => ({
  ...(await orig<typeof import("@proovra/shared-runtime/media-intelligence")>()),
  enqueueMediaIntelligenceRun: vi.fn(async () => ({
    ok: true,
    reused: state.isReuse,
    run: {
      id: "33333333-3333-4333-8333-333333333333",
      teamId: "t",
      evidenceId: "e",
      kind: "extract_exif",
      idempotencyKey: "extract_exif:e",
      lastError: null,
      startedAtUtc: null,
      completedAtUtc: null,
      createdAtUtc: new Date().toISOString(),
      updatedAtUtc: new Date().toISOString(),
      ...state.reused,
    },
  })),
}));

vi.mock("../src/queue/canonical-queue-client.js", () => ({
  enqueueCanonicalWork: vi.fn(async () => {
    state.canonicalCalls += 1;
    return { enqueued: true, jobId: "mi-run-x", collapsed: false };
  }),
  getReadOnlyQueueHandle: vi.fn(() => null),
}));

import { enqueueMediaIntelligenceAnalysis } from "../src/queue/media-intelligence-queue.js";

const payload = {
  teamId: "22222222-2222-4222-8222-222222222222",
  evidenceId: "11111111-1111-4111-8111-111111111111",
  kind: "extract_exif" as const,
};

beforeEach(() => {
  state.canonicalCalls = 0;
  state.isReuse = true;
});

describe("enqueueMediaIntelligenceAnalysis × a settled run (UC-DER-001)", () => {
  for (const settled of [
    { status: "COMPLETED", attemptCount: 1 },
    { status: "DISMISSED", attemptCount: 2 },
    { status: "FAILED", attemptCount: 5 },
  ]) {
    it(`a reused ${settled.status} run (attempts ${settled.attemptCount}) is NOT reported queued and no job is created`, async () => {
      state.reused = settled;
      const res = await enqueueMediaIntelligenceAnalysis(payload);
      expect(res.enqueued).toBe(false);
      expect(res).toMatchObject({ reason: expect.stringMatching(/^job_run_settled:/) });
      expect(state.canonicalCalls).toBe(0);
    });
  }

  it("a reused FAILED run below the ceiling is still claimable and IS enqueued (retry)", async () => {
    state.reused = { status: "FAILED", attemptCount: 2 };
    const res = await enqueueMediaIntelligenceAnalysis(payload);
    expect(res.enqueued).toBe(true);
    expect(state.canonicalCalls).toBe(1);
  });

  it("a new PENDING run is enqueued", async () => {
    state.isReuse = false;
    state.reused = { status: "PENDING", attemptCount: 0 };
    expect((await enqueueMediaIntelligenceAnalysis(payload)).enqueued).toBe(true);
  });
});
