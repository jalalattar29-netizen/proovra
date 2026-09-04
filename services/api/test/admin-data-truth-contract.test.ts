/**
 * PHASE 2 — the data-truth contract, exercised rather than described.
 *
 * These run the shipped functions. Nothing here asserts on source text: the
 * defects this phase fixes would all have passed a "the file mentions
 * NOT_MEASURED" check while still rendering a fabricated zero.
 */

import { describe, expect, it, vi } from "vitest";

import {
  metricIsAffirmative,
  metricNotApplicable,
  metricNumber,
  metricOr,
  metricPartial,
  metricStale,
  metricValue,
  metricWithFreshness,
} from "../src/services/admin/metric-state.js";

describe("the truth vocabulary", () => {
  it("keeps a real zero distinguishable from every absence", () => {
    const measuredZero = metricValue(0);
    expect(measuredZero.state).toBe("VALUE");
    expect(metricNumber(measuredZero)).toBe(0);
    // A measured zero is the ONLY zero that may read as an all-clear.
    expect(metricIsAffirmative(measuredZero)).toBe(true);
  });

  it("never coerces an absent measurement to zero", () => {
    const notApplicable = metricNotApplicable<number>("no signing key is configured");
    expect(metricNumber(notApplicable)).toBeNull();
    // metricOr forces the caller to type any fallback, so a zero is visible
    // in review rather than arriving by default.
    expect(metricOr(notApplicable, -1)).toBe(-1);
  });

  it("refuses the all-clear to every state that is not a live measurement", () => {
    const freshness = { measuredAtUtc: new Date().toISOString(), maxAgeSeconds: 60 };
    const stale = metricStale(5, freshness, "older than its freshness rule");
    const partial = metricPartial(
      1000,
      { measured: 1000, population: null, limit: 1000 },
      "tail only",
    );
    const na = metricNotApplicable<number>("not configured");

    // They carry real numbers — and still must not be painted green.
    expect(stale.value).toBe(5);
    expect(partial.value).toBe(1000);
    expect(metricIsAffirmative(stale)).toBe(false);
    expect(metricIsAffirmative(partial)).toBe(false);
    expect(metricIsAffirmative(na)).toBe(false);
    expect(metricIsAffirmative(undefined)).toBe(false);
  });

  it("classifies a measurement against its freshness rule, not against the request", () => {
    const now = Date.parse("2026-01-01T12:00:00.000Z");
    const fresh = metricWithFreshness(
      7,
      { measuredAtUtc: "2026-01-01T11:59:30.000Z", maxAgeSeconds: 60 },
      now,
      "stale",
    );
    const old = metricWithFreshness(
      7,
      { measuredAtUtc: "2026-01-01T11:00:00.000Z", maxAgeSeconds: 60 },
      now,
      "the signal is older than its freshness rule",
    );
    expect(fresh.state).toBe("VALUE");
    expect(old.state).toBe("STALE");
    // Same value, same reader, different truth — which is the point.
    expect(old.value).toBe(7);
  });

  it("records coverage on a partial read so a cap cannot pose as a population", () => {
    const p = metricPartial(
      100,
      { measured: 100, population: null, limit: 100 },
      "capped read",
    );
    expect(p.state).toBe("PARTIAL");
    if (p.state === "PARTIAL") {
      expect(p.coverage.limit).toBe(100);
      // Population unknown is null, never silently equal to what was measured.
      expect(p.coverage.population).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Worker liveness — an empty queue is not a living worker.
// ---------------------------------------------------------------------------

const H: { rows: unknown[]; throws: boolean } = { rows: [], throws: false };

vi.mock("../src/db.js", () => ({
  prisma: {
    workerTelemetrySnapshot: {
      findMany: async () => {
        if (H.throws) throw new Error("simulated heartbeat store outage");
        return H.rows;
      },
    },
  },
}));

const { getWorkerFleetLiveness, WORKER_HEARTBEAT_STALE_SECONDS } = await import(
  "../src/services/operations/worker-liveness.service.js"
);

const beat = (workerId: string, ageSeconds: number) => ({
  workerId,
  workerKind: "WORKER",
  status: "HEALTHY",
  heartbeatAtUtc: new Date(Date.now() - ageSeconds * 1000),
  processedCount: 1,
  failedCount: 0,
});

describe("worker liveness", () => {
  it("reports NO_HEARTBEAT when nothing has ever reported — not healthy", async () => {
    H.rows = [];
    H.throws = false;
    const r = await getWorkerFleetLiveness();
    expect(r.state).toBe("NO_HEARTBEAT");
    expect(r.liveInstances).toBe(0);
    // The reason has to say why an empty queue proves nothing.
    expect(r.reason).toMatch(/empty queue/i);
  });

  it("reports LIVE for a fresh heartbeat and aggregates instances", async () => {
    H.rows = [beat("a", 1), beat("b", 2)];
    const r = await getWorkerFleetLiveness();
    expect(r.state).toBe("LIVE");
    expect(r.liveInstances).toBe(2);
  });

  it("goes STALE — never HEALTHY — once every instance is outside the window", async () => {
    H.rows = [beat("a", WORKER_HEARTBEAT_STALE_SECONDS + 60)];
    const r = await getWorkerFleetLiveness();
    expect(r.state).toBe("STALE");
    expect(r.liveInstances).toBe(0);
    expect(r.staleInstances).toBe(1);
  });

  it("keeps the fleet LIVE while one instance still reports, and counts the crashed one", async () => {
    H.rows = [beat("a", 2), beat("b", WORKER_HEARTBEAT_STALE_SECONDS + 60)];
    const r = await getWorkerFleetLiveness();
    expect(r.state).toBe("LIVE");
    expect(r.liveInstances).toBe(1);
    expect(r.staleInstances).toBe(1);
  });

  it("reports UNKNOWN when the heartbeat store cannot be read", async () => {
    H.rows = [];
    H.throws = true;
    const r = await getWorkerFleetLiveness();
    expect(r.state).toBe("UNKNOWN");
    // Explicitly NOT a claim of health, and explicitly not a zero.
    expect(r.reason).toMatch(/not a statement that workers are healthy/i);
    H.throws = false;
  });

  it("judges every instance against ONE injected instant", async () => {
    const rows = [beat("a", 300)];
    H.rows = rows;
    const late = await getWorkerFleetLiveness();
    const early = await getWorkerFleetLiveness({ nowMs: Date.now() - 250_000 });
    expect(late.state).toBe("STALE");
    expect(early.state).toBe("LIVE");
  });
});
