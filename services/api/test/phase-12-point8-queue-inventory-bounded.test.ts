/**
 * PHASE 12 — POINT 8: the queue inventory is BOUNDED when a probe never settles.
 *
 * WHAT THIS PROVES, AND WHY IT IS NOT A TEST-ONLY CONCERN
 * ---------------------------------------------------------------------------
 * `queue-inventory.service` documents itself as best-effort: a queue it cannot
 * read is projected as `outage`. That projection was UNREACHABLE. The shared
 * IORedis client is built with `maxRetriesPerRequest: null`, so a command
 * issued against an unreachable Redis is retried forever rather than rejected,
 * and a promise that never settles is not caught by `catch`.
 *
 * It surfaced as a unit-test timeout — `GET /v1/graph/diagnostics` awaits this
 * helper, and the authorization test for that route hung for 5000 ms with two
 * live sockets. But the route's own `try/catch` is just as powerless, so with
 * Redis down a real request would have hung until something upstream gave up.
 * The test was the symptom; the hang was the defect.
 *
 * WHY THIS SUITE MOCKS BULLMQ RATHER THAN POINTING AT A DEAD PORT
 * ---------------------------------------------------------------------------
 * The first version of this proof set `REDIS_URL` to a closed port. It passed
 * alone and failed when run after another file — because `REDIS_URL` is owned
 * by the harness (`safe-environment.ts` re-asserts it before EVERY test), so
 * the service connected to the harness port regardless, and on a machine where
 * a disposable Redis happened to be listening there every queue came back
 * `healthy`. The proof had quietly become a proof of nothing.
 *
 * The property under test is not "Redis is down". It is "a probe that never
 * settles must not hang the function". So the probe is made to never settle,
 * directly and deterministically. No socket is opened, nothing depends on what
 * is or is not running on the machine, and the result is the same in any file
 * order.
 *
 * Two bounds exist and both are asserted:
 *   * a per-probe deadline, so one queue cannot block forever;
 *   * a total budget, because fifteen queues are walked SEQUENTIALLY and
 *     fifteen per-probe deadlines is not a bound on the function.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Small budgets so the proof is fast; the shipped defaults are asserted below. */
const PROBE_MS = 120;
const BUDGET_MS = 400;

/** A probe that never settles — the exact shape of the defect. */
const NEVER = () => new Promise<never>(() => {});

vi.mock("bullmq", () => ({
  Queue: class {
    constructor(public name: string) {}
    getJobCounts = NEVER;
    getWaiting = NEVER;
  },
}));

// No socket, in this suite or anywhere it runs. The service only needs the
// client to exist and to carry an `on` for its error listener.
vi.mock("ioredis", () => ({
  default: class {
    on() {
      return this;
    }
    quit() {
      return Promise.resolve();
    }
  },
}));

type Row = {
  queueName: string;
  health: string;
  counts: Record<string, number>;
  stalledCount: number;
  oldestWaitingAgeMs: number | null;
  disabledReason: string | null;
};

let getQueueInventory: () => Promise<ReadonlyArray<Row>>;
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeAll(async () => {
  // The deadlines are module constants, which is what makes them configurable
  // per deployment rather than per call — so they must be set before the module
  // is evaluated.
  vi.stubEnv("QUEUE_PROBE_TIMEOUT_MS", String(PROBE_MS));
  vi.stubEnv("QUEUE_INVENTORY_BUDGET_MS", String(BUDGET_MS));
  process.on("unhandledRejection", onUnhandled);
  vi.resetModules();
  ({ getQueueInventory } = await import(
    "../src/services/operations/queue-inventory.service.js"
  ));
});

afterEach(() => {
  expect(unhandled, "a stalled probe must not produce an unhandled rejection").toEqual([]);
});

afterAll(() => {
  process.off("unhandledRejection", onUnhandled);
  vi.unstubAllEnvs();
});

describe("PHASE 12 — POINT 8: getQueueInventory when a probe never settles", () => {
  it("settles inside its budget instead of hanging forever", async () => {
    const started = Date.now();
    const inventory = await getQueueInventory();
    const elapsed = Date.now() - started;

    expect(Array.isArray(inventory)).toBe(true);
    expect(inventory.length).toBeGreaterThan(0);
    // Generous headroom for scheduling, but far below the 5000 ms that used to
    // elapse without settling at all.
    expect(elapsed).toBeLessThan(BUDGET_MS + 2500);
  });

  it("never reports a queue it could not read as healthy", async () => {
    const inventory = await getQueueInventory();
    for (const row of inventory) {
      expect(["outage", "unknown", "disabled", "unconfigured"], row.queueName).toContain(row.health);
      // A queue that answered nothing must not carry invented counts.
      expect(row.counts).toEqual({ waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 });
      expect(row.stalledCount).toBe(0);
      expect(row.oldestWaitingAgeMs).toBeNull();
    }
  });

  it("distinguishes a probe that failed from one it never had time to make", async () => {
    const inventory = await getQueueInventory();
    const timedOut = inventory.filter((r) => r.health === "outage");
    const unprobed = inventory.filter((r) => r.health === "unknown");
    // Fifteen queues share a 400 ms budget with a 120 ms probe deadline, so
    // some are probed and the rest are necessarily left unprobed — and they say
    // so rather than being folded in with the ones that actually failed.
    expect(timedOut.length).toBeGreaterThan(0);
    expect(unprobed.length).toBeGreaterThan(0);
    for (const row of unprobed) expect(String(row.disabledReason)).toContain("budget");
    for (const row of timedOut) expect(row.disabledReason).toBeNull();
  });

  it("leaks no Redis internals, credentials or tenant identifiers", async () => {
    const serialised = JSON.stringify(await getQueueInventory());
    // The service's standing rule: never return raw Redis errors or payloads.
    expect(serialised).not.toMatch(/ECONNREFUSED|ETIMEDOUT|ENOTFOUND/);
    expect(serialised).not.toMatch(/127\.0\.0\.1|redis:\/\//);
    // A queue projection is workspace-agnostic; no tenant id may appear.
    expect(serialised).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it("is deterministic — ten consecutive calls all settle bounded", async () => {
    for (let i = 0; i < 10; i += 1) {
      const started = Date.now();
      const inventory = await getQueueInventory();
      expect(Date.now() - started, `iteration ${i}`).toBeLessThan(BUDGET_MS + 2500);
      expect(inventory.every((r) => r.health !== "healthy"), `iteration ${i}`).toBe(true);
    }
  });

  it("ships production defaults that are bounded, not the test's small ones", () => {
    // The bound must not depend on a test having set an env var. Read the
    // source rather than the module constants, which this suite overrode.
    const source = readFileSync(
      resolve(import.meta.dirname, "../src/services/operations/queue-inventory.service.ts"),
      "utf8",
    );
    const probeDefault = Number(/QUEUE_PROBE_TIMEOUT_MS\s*\?\?\s*(\d+)/.exec(source)?.[1]);
    const budgetDefault = Number(/QUEUE_INVENTORY_BUDGET_MS\s*\?\?\s*(\d+)/.exec(source)?.[1]);
    expect(probeDefault).toBeGreaterThan(0);
    expect(budgetDefault).toBeGreaterThan(0);
    // A budget below the per-probe deadline would make the first queue the only
    // one ever probed; a budget far above it defeats the point.
    expect(budgetDefault).toBeGreaterThanOrEqual(probeDefault);
    expect(budgetDefault).toBeLessThanOrEqual(10_000);
    // And the shipped client must still bound its socket attempt.
    expect(source).toMatch(/connectTimeout:\s*\d+/);
  });
});
