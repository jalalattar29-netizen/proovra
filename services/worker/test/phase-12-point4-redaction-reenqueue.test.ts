/**
 * PHASE 12 POINT 4 PASS C2 — the stranded-QUEUED reconciler can actually
 * recover a stranded row.
 *
 * `enqueueRedactionDerivativeRenderWorker` was a bare
 * `queue.add(name, payload, { jobId })`. BullMQ IGNORES an add whose jobId is
 * already occupied — including by a RETAINED completed or failed job, and this
 * queue keeps 100 completed jobs and EVERY failed job. So the one case the
 * reconciler exists for (a row left QUEUED because its render job died or
 * failed) could never be recovered, and the reconciler logged `enqueued: true`
 * while scheduling nothing.
 *
 * The policy under proof (shared with the API request path, one definition in
 * @proovra/shared): a LIVE job collapses; a SPENT job's id is released and a
 * fresh job is scheduled; an unusable queue reports honestly.
 *
 * Only the BullMQ Queue is faked — the enqueue logic and the shared policy run
 * for real.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildRedactionDerivativeJobId,
  CANONICAL_PAYLOAD_SCHEMA_VERSION,
  FORBIDDEN_PAYLOAD_AUTHORITY_FIELDS,
  REDACTION_DERIVATIVE_JOB_NAME,
} from "@proovra/shared";

const H = vi.hoisted(() => ({
  /** State of the job already occupying the id, or null when there is none. */
  existingState: null as string | null,
  removed: [] as string[],
  added: [] as Array<{ name: string; payload: unknown; jobId?: string }>,
  removeThrows: false,
  addThrows: false,
}));

vi.mock("bullmq", () => ({
  Queue: class {
    async getJob(jobId: string) {
      if (H.existingState === null) return null;
      return {
        id: jobId,
        getState: async () => H.existingState,
        remove: async () => {
          if (H.removeThrows) throw new Error("race");
          H.removed.push(jobId);
          H.existingState = null;
        },
      };
    }
    async add(name: string, payload: unknown, opts?: { jobId?: string }) {
      if (H.addThrows) throw new Error("redis down");
      H.added.push({ name, payload, jobId: opts?.jobId });
      return { id: opts?.jobId };
    }
    async close() {}
  },
  Worker: class {},
  QueueEvents: class {},
}));

vi.mock("ioredis", () => ({
  default: class {
    on() {}
    async quit() {}
  },
}));

// Process configuration is an environment boundary, not behavior under test.
vi.mock("../src/config.js", () => ({
  env: { REDIS_URL: "redis://localhost:6379" },
}));

const { enqueueRedactionDerivativeRenderWorker } = await import(
  "../src/queue.js"
);

const DERIVATIVE_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = buildRedactionDerivativeJobId(DERIVATIVE_ID);

const reenqueue = () =>
  enqueueRedactionDerivativeRenderWorker({ derivativeId: DERIVATIVE_ID });

beforeEach(() => {
  H.existingState = null;
  H.removed = [];
  H.added = [];
  H.removeThrows = false;
  H.addThrows = false;
});

describe("Phase 12 Point 4 — reconciler re-enqueue", () => {
  it("schedules a render when no job holds the id", async () => {
    await expect(reenqueue()).resolves.toEqual({ enqueued: true });
    expect(H.added).toHaveLength(1);
    expect(H.added[0]).toMatchObject({
      name: REDACTION_DERIVATIVE_JOB_NAME,
      jobId: JOB_ID,
      // Point 5: the derivative id is now the canonical `commandId`, and the
      // payload is versioned so an unknown schema fails before any mutation.
      payload: {
        commandId: DERIVATIVE_ID,
        schemaVersion: CANONICAL_PAYLOAD_SCHEMA_VERSION,
      },
    });
  });

  for (const state of ["waiting", "delayed", "active", "prioritized"]) {
    it(`COLLAPSES onto a live '${state}' job — no duplicate render`, async () => {
      H.existingState = state;
      await expect(reenqueue()).resolves.toEqual({ enqueued: true });
      expect(H.added).toEqual([]);
      expect(H.removed).toEqual([]);
    });
  }

  for (const state of ["completed", "failed"]) {
    it(`RECOVERS a row whose job is spent ('${state}') — the id is released and re-added`, async () => {
      // The regression: this used to silently no-op and report success.
      H.existingState = state;
      await expect(reenqueue()).resolves.toEqual({ enqueued: true });
      expect(H.removed).toEqual([JOB_ID]);
      expect(H.added).toHaveLength(1);
      expect(H.added[0]).toMatchObject({ jobId: JOB_ID });
    });
  }

  it("reports FALSE when the spent job cannot be released — never a false success", async () => {
    H.existingState = "failed";
    H.removeThrows = true;
    await expect(reenqueue()).resolves.toEqual({ enqueued: false });
    expect(H.added).toEqual([]);
  });

  it("reports FALSE when the queue is unreachable", async () => {
    H.addThrows = true;
    await expect(reenqueue()).resolves.toEqual({ enqueued: false });
  });

  it("carries ONLY the canonical reference triple — no tenant, policy or storage truth", async () => {
    await reenqueue();
    const payload = H.added[0]!.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      "commandId",
      "schemaVersion",
      "traceId",
    ]);
    // Stronger than an equality check on the key list: assert against the
    // platform-wide forbidden-field catalog, so a future field added to the
    // payload is caught by this test even if nobody updates the list above.
    for (const forbidden of FORBIDDEN_PAYLOAD_AUTHORITY_FIELDS) {
      expect(payload).not.toHaveProperty(forbidden);
    }
    expect(payload).not.toHaveProperty("teamId");
  });
});
