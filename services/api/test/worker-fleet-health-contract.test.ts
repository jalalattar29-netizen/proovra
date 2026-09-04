/**
 * THE WORKER FLEET PROJECTION — one authority, four states, no contradictions.
 *
 * `getWorkerFleetHealth` is what Overview, Platform Health, Observability,
 * Runtime and Operations all read. Before it existed those surfaces answered
 * "are the workers alive?" from three different inputs — queue depth, a
 * reviewer-reconcile audit row, and the heartbeat — and could therefore print
 * HEALTHY, DEGRADED and CRITICAL for one fleet at one instant.
 *
 * The lifecycle is proved for real elsewhere, with a child process running the
 * shipped sampler and a genuine SIGKILL. This file pins the classification and
 * the metric mapping, which is what those surfaces actually consume, and the
 * rule that one evaluation yields one state per subsystem.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const store: { rows: unknown[]; throws: boolean } = { rows: [], throws: false };

vi.mock("../src/db.js", () => ({
  prisma: {
    workerTelemetrySnapshot: {
      findMany: async () => {
        if (store.throws) throw new Error("simulated heartbeat store outage");
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

const beat = (workerId: string, ageSeconds: number, metadataJson: unknown = null) => ({
  workerId,
  workerKind: "WORKER",
  status: "HEALTHY",
  heartbeatAtUtc: new Date(Date.now() - ageSeconds * 1000),
  processedCount: 7,
  failedCount: 0,
  metadataJson,
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
    // Floor and ceiling: a proof may go fast, nobody may go absurd.
    expect(resolveStaleAfterSeconds(1)).toBe(5);
    expect(resolveStaleAfterSeconds(99_999)).toBe(3600);
    expect(resolveStaleAfterSeconds(0)).toBe(WORKER_HEARTBEAT_STALE_SECONDS);
    expect(resolveStaleAfterSeconds(Number.NaN)).toBe(WORKER_HEARTBEAT_STALE_SECONDS);
    expect(resolveStaleAfterSeconds()).toBe(WORKER_HEARTBEAT_STALE_SECONDS);
  });
});

describe("the four states a heartbeat can justify", () => {
  it("NOT_MEASURED when nothing has ever reported — never STALE", async () => {
    const f = await getWorkerFleetHealth();
    expect(f.state).toBe("NOT_MEASURED");
    expect(f.metric.state).toBe("NOT_MEASURED");
    expect(f.metric.value).toBeNull();
    expect(f.lastHeartbeatAtUtc).toBeNull();
    // There is no measurement, so there is nothing that could have gone stale.
    expect(f.state).not.toBe("STALE");
  });

  it("HEALTHY with a fresh heartbeat, and the metric carries the live count", async () => {
    store.rows = [beat("a", 5), beat("b", 9)];
    const f = await getWorkerFleetHealth();
    expect(f.state).toBe("HEALTHY");
    expect(f.metric.state).toBe("VALUE");
    expect(f.metric.value).toBe(2);
    expect(f.operatorAction).toBeNull();
  });

  it("STALE past the threshold, keeping the last real count, timestamp and age", async () => {
    const age = WORKER_HEARTBEAT_STALE_SECONDS + 120;
    store.rows = [beat("a", age)];
    const f = await getWorkerFleetHealth();

    expect(f.state).toBe("STALE");
    expect(f.metric.state).toBe("STALE");
    // The fleet WAS one instance. Reporting 0 would be a different claim.
    expect(f.metric.value).toBe(1);
    expect(f.liveInstances).toBe(0);
    expect(f.lastHeartbeatAtUtc).not.toBeNull();
    expect(f.lastHeartbeatAgeSeconds).toBeGreaterThanOrEqual(
      WORKER_HEARTBEAT_STALE_SECONDS,
    );
    expect(f.operatorAction).toBeTruthy();
    if (f.metric.state === "STALE") {
      expect(f.metric.freshness.measuredAtUtc).toBe(f.lastHeartbeatAtUtc);
      expect(f.metric.freshness.maxAgeSeconds).toBe(f.staleAfterSeconds);
    }
  });

  it("UNAVAILABLE when the store cannot be read — never STALE and never HEALTHY", async () => {
    store.throws = true;
    const f = await getWorkerFleetHealth();
    expect(f.state).toBe("UNAVAILABLE");
    expect(f.metric.state).toBe("ERROR");
    expect(f.metric.value).toBeNull();
    expect(["STALE", "HEALTHY"]).not.toContain(f.state);
  });

  it("stays HEALTHY on the surviving instance while counting the dead one", async () => {
    store.rows = [beat("a", 5), beat("b", WORKER_HEARTBEAT_STALE_SECONDS + 120)];
    const f = await getWorkerFleetHealth();
    expect(f.state).toBe("HEALTHY");
    expect(f.liveInstances).toBe(1);
    expect(f.staleInstances).toBe(1);
    expect(f.knownInstances).toBe(2);
  });

  it("surfaces build revision and queue subscriptions when the worker reported them", async () => {
    store.rows = [
      beat("a", 3, {
        buildRevision: "deadbee",
        queueSubscriptions: ["report", "exif"],
      }),
    ];
    const f = await getWorkerFleetHealth();
    expect(f.instances[0].buildRevision).toBe("deadbee");
    expect(f.instances[0].queueSubscriptions).toEqual(["report", "exif"]);
  });

  it("tolerates a heartbeat from a worker that reports no metadata at all", async () => {
    // The worker is a separate deployable on its own release cadence, so an
    // older one simply has no metadata. That must not break a liveness read.
    store.rows = [beat("a", 3, null), beat("b", 4, "not-an-object")];
    const f = await getWorkerFleetHealth();
    expect(f.state).toBe("HEALTHY");
    expect(f.instances.every((i) => i.buildRevision === null)).toBe(true);
    expect(f.instances.every((i) => i.queueSubscriptions.length === 0)).toBe(true);
  });
});

describe("the metric state and the fleet state cannot disagree", () => {
  it("maps one for one across every case", async () => {
    const cases: Array<[unknown[], boolean, string, string]> = [
      [[], false, "NOT_MEASURED", "NOT_MEASURED"],
      [[beat("a", 2)], false, "HEALTHY", "VALUE"],
      [[beat("a", WORKER_HEARTBEAT_STALE_SECONDS + 60)], false, "STALE", "STALE"],
      [[], true, "UNAVAILABLE", "ERROR"],
    ];
    for (const [rows, throws, fleetState, metricState] of cases) {
      store.rows = rows;
      store.throws = throws;
      const f = await getWorkerFleetHealth();
      expect(f.state, `fleet for ${fleetState}`).toBe(fleetState);
      expect(f.metric.state, `metric for ${fleetState}`).toBe(metricState);
      // Only a live measurement may ever be painted as an all-clear.
      const affirmative = f.metric.state === "VALUE";
      expect(affirmative).toBe(fleetState === "HEALTHY");
    }
  });
});
