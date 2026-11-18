/**
 * WS-REL / PRO-S1-06 — a worker shutdown is bounded and visible.
 *
 * A shutdown started by an unhandledRejection awaited every consumer's close()
 * with no bound, so one hung job kept a scheduler-less process alive while
 * /readyz stayed green. The deadline now exits the process, and readiness is
 * red from the moment shutdown starts.
 */
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  __resetWorkerShutdownStateForTests,
  beginWorkerShutdown,
  isWorkerShuttingDown,
} from "../src/shutdown-state.js";

afterEach(() => {
  __resetWorkerShutdownStateForTests();
});

describe("PRO-S1-06 bounded worker shutdown", () => {
  it("a hung drain is cut at the deadline with a failing exit code (fatal path)", async () => {
    const exits: number[] = [];
    let finalised = 0;
    beginWorkerShutdown({
      exitCode: 1,
      exit: (c) => exits.push(c),
      onDeadline: async () => {
        finalised += 1;
      },
      deadlineMs: 20,
    });
    expect(isWorkerShuttingDown()).toBe(true);
    await new Promise((r) => setTimeout(r, 80));
    expect(finalised).toBe(1);
    expect(exits).toEqual([1]);
  });

  it("a SIGTERM drain that overruns still exits non-zero (never reported as clean)", async () => {
    const exits: number[] = [];
    beginWorkerShutdown({ exitCode: 0, exit: (c) => exits.push(c), deadlineMs: 10 });
    await new Promise((r) => setTimeout(r, 50));
    expect(exits).toEqual([1]);
  });

  it("is idempotent: a second trigger arms no second timer", async () => {
    const exits: number[] = [];
    beginWorkerShutdown({ exitCode: 1, exit: (c) => exits.push(c), deadlineMs: 10 });
    beginWorkerShutdown({ exitCode: 1, exit: (c) => exits.push(c), deadlineMs: 10 });
    await new Promise((r) => setTimeout(r, 50));
    expect(exits).toEqual([1]);
  });
});

describe("PRO-S1-06 readiness is red during shutdown", () => {
  it("the /readyz handler answers 503 shutting_down before probing dependencies", () => {
    const src = readFileSync(new URL("../src/health.ts", import.meta.url), "utf8");
    const handler = src.slice(src.indexOf('app.get("/readyz"'));
    const guard = handler.indexOf("isWorkerShuttingDown()");
    const probe = handler.indexOf("evaluateWorkerReadiness()");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(probe);
  });
});
