/**
 * Phase R10 (F12) — distributed cron lock.
 *
 * The worker's state-mutating reconcilers previously guarded only against
 * intra-process re-entrancy (a boolean flag), so two replicas double-ran
 * every reconciler on each tick. `withCronLock` adds a Redis `SET NX PX`
 * advisory lock so only one replica runs a given reconciler per tick, while
 * failing OPEN (still running) if Redis is unavailable.
 *
 * `./queue.js` opens a real Redis connection at import, so it is mocked.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

const redisSet = vi.fn();
const redisEval = vi.fn();

vi.mock("../src/queue.js", () => ({
  redisConnection: {
    set: (...args: unknown[]) => redisSet(...args),
    eval: (...args: unknown[]) => redisEval(...args),
  },
}));
vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { withCronLock } from "../src/cron-lock.js";

beforeEach(() => {
  redisSet.mockReset();
  redisEval.mockReset();
  redisEval.mockResolvedValue(1);
});

describe("Phase R10 — withCronLock (F12)", () => {
  it("acquires (SET NX PX) → runs fn and releases the lock", async () => {
    redisSet.mockResolvedValue("OK");
    const fn = vi.fn().mockResolvedValue("done");

    const outcome = await withCronLock("retention", fn);

    expect(outcome).toEqual({ ran: true, result: "done" });
    expect(fn).toHaveBeenCalledTimes(1);
    // Atomic acquire: SET key val PX <ttl> NX.
    const setArgs = redisSet.mock.calls[0];
    expect(setArgs[0]).toBe("cron:lock:retention");
    expect(setArgs).toContain("NX");
    expect(setArgs).toContain("PX");
    // Released via check-and-delete Lua eval.
    expect(redisEval).toHaveBeenCalledTimes(1);
  });

  it("does NOT run fn when another replica holds the lock (SET returns null)", async () => {
    redisSet.mockResolvedValue(null);
    const fn = vi.fn();

    const outcome = await withCronLock("destruction", fn);

    expect(outcome).toEqual({ ran: false, reason: "held" });
    expect(fn).not.toHaveBeenCalled();
    // No release — we never held it.
    expect(redisEval).not.toHaveBeenCalled();
  });

  it("fails OPEN — runs fn when Redis is unavailable (never worse than pre-R10)", async () => {
    redisSet.mockRejectedValue(new Error("redis down"));
    const fn = vi.fn().mockResolvedValue("ran-anyway");

    const outcome = await withCronLock("immutable", fn);

    expect(outcome).toEqual({ ran: true, result: "ran-anyway" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("releases only if this instance still holds the lock (check-and-delete)", async () => {
    redisSet.mockResolvedValue("OK");
    await withCronLock("archive", vi.fn().mockResolvedValue(null));
    // The release is a Lua script comparing the stored value to our token.
    const [script] = redisEval.mock.calls[0] as [string, ...unknown[]];
    expect(script).toMatch(/redis\.call\('get'/);
    expect(script).toMatch(/redis\.call\('del'/);
  });
});

describe("Phase R10 — reconcilers adopt the cron lock (source contract)", () => {
  const indexSrc = readFileSync(
    fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    "utf8",
  );

  it("the 5 state-mutating reconcilers wrap their run in withCronLock", () => {
    for (const name of [
      "retention-reconciliation",
      "destruction-orchestrator",
      "immutable-storage-reconciliation",
      "archive-tier-auto-transition",
      "reviewer-ops-reconciliation",
    ]) {
      expect(indexSrc).toContain(`withCronLock("${name}"`);
    }
  });
});
