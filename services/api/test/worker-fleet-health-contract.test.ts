/**
 * THE WORKER FLEET PROJECTION — one authority, and a clean stop it can see.
 *
 * `getWorkerFleetHealth` is what Overview, Platform Health, Observability,
 * Runtime and Operations all read. It now reads the LEASE table: one current
 * row per instance, rather than a scan of append-only heartbeat history.
 *
 * The property this file exists for is the distinction the history could not
 * express. A drained worker and a killed worker both stop heartbeating; only
 * the drained one leaves a stop marker, and the reader must reach a different
 * conclusion in each case. A crash cannot forge that marker, which is exactly
 * what makes its absence evidence.
 *
 * The lifecycle is proved end to end elsewhere with real child processes, a
 * real SIGKILL and a real graceful stop. This file pins the classification
 * that those surfaces consume.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const store: { rows: unknown[]; throws: boolean } = { rows: [], throws: false };

vi.mock("../src/db.js", () => ({
  prisma: {
    workerLease: {
      findMany: async () => {
        if (store.throws) throw new Error("simulated lease store outage");
        return store.rows;
      },
    },
  },
}));

const {
  getWorkerFleetHealth,
  WORKER_HEARTBEAT_INTERVAL_SECONDS,
  WORKER_HEARTBEAT_MISSED_CYCLES,
  WORKER_HEARTBEAT_STALE_SECONDS,
  resolveStaleAfterSeconds,
} = await import("../src/services/operations/worker-liveness.service.js");

type LeaseOpts = {
  state?: "STARTING" | "LIVE" | "DRAINING" | "STOPPED";
  stoppedAtUtc?: Date | null;
  shutdownReason?: string | null;
  buildRevision?: string | null;
  queueSubscriptions?: string[];
};

const lease = (workerId: string, ageSeconds: number, opts: LeaseOpts = {}) => ({
  workerId,
  workerKind: "WORKER",
  state: opts.state ?? "LIVE",
  lastSeenAtUtc: new Date(Date.now() - ageSeconds * 1000),
  stoppedAtUtc: opts.stoppedAtUtc ?? null,
  shutdownReason: opts.shutdownReason ?? null,
  buildRevision: opts.buildRevision ?? null,
  queueSubscriptions: opts.queueSubscriptions ?? [],
  processedCount: 7,
  failedCount: 0,
});

beforeEach(() => {
  store.rows = [];
  store.throws = false;
  delete process.env.WORKER_HEARTBEAT_STALE_SECONDS;
});

describe("the freshness rule is derived, not picked", () => {
  it("is a whole number of heartbeat intervals", () => {
    expect(WORKER_HEARTBEAT_STALE_SECONDS).toBe(
      WORKER_HEARTBEAT_INTERVAL_SECONDS * WORKER_HEARTBEAT_MISSED_CYCLES,
    );
    // More than one interval, or ordinary scheduling jitter reads as a death.
    expect(WORKER_HEARTBEAT_MISSED_CYCLES).toBeGreaterThan(1);
  });

  it("accepts a bounded override and refuses an unusable one", () => {
    expect(resolveStaleAfterSeconds(20)).toBe(20);
    expect(resolveStaleAfterSeconds(1)).toBe(5);
    expect(resolveStaleAfterSeconds(99_999)).toBe(3600);
    expect(resolveStaleAfterSeconds(0)).toBe(WORKER_HEARTBEAT_STALE_SECONDS);
    expect(resolveStaleAfterSeconds(Number.NaN)).toBe(WORKER_HEARTBEAT_STALE_SECONDS);
    expect(resolveStaleAfterSeconds()).toBe(WORKER_HEARTBEAT_STALE_SECONDS);
  });
});

describe("graceful stop and crash are not the same fact", () => {
  const stale = WORKER_HEARTBEAT_STALE_SECONDS + 120;

  it("a crashed instance — LIVE lease, aged out, NO marker — is STALE", () => {
    store.rows = [lease("a", stale)];
    return getWorkerFleetHealth().then((f) => {
      expect(f.state).toBe("STALE");
      expect(f.metric.state).toBe("STALE");
      // The last real count survives; reporting 0 would be a different claim.
      expect(f.metric.value).toBe(1);
      expect(f.reason).toMatch(/none recorded a shutdown/i);
    });
  });

  it("a cleanly stopped instance is STOPPED IMMEDIATELY — no waiting out the threshold", async () => {
    // One second old: nowhere near stale, and already not live.
    store.rows = [
      lease("a", 1, {
        state: "STOPPED",
        stoppedAtUtc: new Date(),
        shutdownReason: "SIGTERM",
      }),
    ];
    const f = await getWorkerFleetHealth();
    expect(f.state).toBe("STOPPED");
    expect(f.liveInstances).toBe(0);
    expect(f.staleInstances).toBe(0);
  });

  it("a stopped instance never becomes STALE, however old it gets", async () => {
    store.rows = [
      lease("a", stale * 10, {
        state: "STOPPED",
        stoppedAtUtc: new Date(Date.now() - stale * 10_000),
        shutdownReason: "SIGTERM",
      }),
    ];
    const f = await getWorkerFleetHealth();
    // Age is not the question. A stop marker means nothing is unexplained.
    expect(f.state).toBe("STOPPED");
    expect(f.state).not.toBe("STALE");
    expect(f.staleInstances).toBe(0);
  });

  it("a DRAINING instance leaves the live set at once", async () => {
    store.rows = [lease("a", 1, { state: "DRAINING", shutdownReason: "SIGTERM" })];
    const f = await getWorkerFleetHealth();
    expect(f.liveInstances).toBe(0);
    expect(f.staleInstances).toBe(0);
  });

  it("keeps the fleet LIVE when one drains and another still reports", async () => {
    store.rows = [
      lease("a", 3),
      lease("b", 2, {
        state: "STOPPED",
        stoppedAtUtc: new Date(),
        shutdownReason: "SIGTERM",
      }),
    ];
    const f = await getWorkerFleetHealth();
    expect(f.state).toBe("HEALTHY");
    expect(f.liveInstances).toBe(1);
    expect(f.stoppedInstances).toBe(1);
    expect(f.staleInstances).toBe(0);
  });

  it("counts a crashed instance as stale while a live one keeps the fleet up", async () => {
    store.rows = [lease("a", 3), lease("b", stale)];
    const f = await getWorkerFleetHealth();
    expect(f.state).toBe("HEALTHY");
    expect(f.liveInstances).toBe(1);
    expect(f.staleInstances).toBe(1);
  });
});

describe("the states a lease can justify", () => {
  it("NOT_MEASURED when no lease has ever been written", async () => {
    const f = await getWorkerFleetHealth();
    expect(f.state).toBe("NOT_MEASURED");
    expect(f.metric.state).toBe("NOT_MEASURED");
    expect(f.metric.value).toBeNull();
  });

  it("STARTING is never counted live — a process beginning is not a heartbeat", async () => {
    store.rows = [lease("a", 1, { state: "STARTING" })];
    const f = await getWorkerFleetHealth();
    expect(f.liveInstances).toBe(0);
    expect(f.state).toBe("NOT_MEASURED");
    expect(f.metric.state).toBe("NOT_MEASURED");
    expect(f.state).not.toBe("STALE");
  });

  it("HEALTHY with a fresh LIVE lease, and the metric carries the live count", async () => {
    store.rows = [lease("a", 5), lease("b", 9)];
    const f = await getWorkerFleetHealth();
    expect(f.state).toBe("HEALTHY");
    expect(f.metric.state).toBe("VALUE");
    expect(f.metric.value).toBe(2);
    expect(f.operatorAction).toBeNull();
  });

  it("UNAVAILABLE when the lease store cannot be read — never STALE, never HEALTHY", async () => {
    store.throws = true;
    const f = await getWorkerFleetHealth();
    expect(f.state).toBe("UNAVAILABLE");
    expect(f.metric.state).toBe("ERROR");
    expect(f.metric.value).toBeNull();
  });

  it("carries build revision and queue subscriptions from real columns", async () => {
    store.rows = [
      lease("a", 3, {
        buildRevision: "deadbee",
        queueSubscriptions: ["report", "exif"],
      }),
    ];
    const f = await getWorkerFleetHealth();
    expect(f.instances[0].buildRevision).toBe("deadbee");
    expect(f.instances[0].queueSubscriptions).toEqual(["report", "exif"]);
  });

  it("reports an unknown revision as null, never as an empty string", async () => {
    store.rows = [lease("a", 3, { buildRevision: null })];
    const f = await getWorkerFleetHealth();
    expect(f.instances[0].buildRevision).toBeNull();
    expect(f.instances[0].buildRevision).not.toBe("");
  });
});

describe("the metric state and the fleet state cannot disagree", () => {
  it("maps one for one, and only a live fleet is affirmative", async () => {
    const stale = WORKER_HEARTBEAT_STALE_SECONDS + 60;
    const cases: Array<[unknown[], boolean, string, string]> = [
      [[], false, "NOT_MEASURED", "NOT_MEASURED"],
      [[lease("a", 2)], false, "HEALTHY", "VALUE"],
      [[lease("a", stale)], false, "STALE", "STALE"],
      [
        [lease("a", 2, { state: "STOPPED", stoppedAtUtc: new Date() })],
        false,
        "STOPPED",
        "NOT_APPLICABLE",
      ],
      [[], true, "UNAVAILABLE", "ERROR"],
    ];
    for (const [rows, throws, fleetState, metricState] of cases) {
      store.rows = rows;
      store.throws = throws;
      const f = await getWorkerFleetHealth();
      expect(f.state, `fleet for ${fleetState}`).toBe(fleetState);
      expect(f.metric.state, `metric for ${fleetState}`).toBe(metricState);
      expect(f.metric.state === "VALUE").toBe(fleetState === "HEALTHY");
    }
  });
});
