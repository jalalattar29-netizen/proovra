/**
 * Phase R10 (F12) — distributed cron lock.
 *
 * The worker's state-mutating reconcilers previously guarded only against
 * intra-process re-entrancy (a boolean flag), so two replicas double-ran
 * every reconciler on each tick. `withCronLock` adds a Redis `SET NX PX`
 * advisory lock so only one replica runs a given reconciler per tick. Since
 * AUD-50 (2026-10-20) it fails CLOSED (the tick is skipped) when the lock
 * cannot be read, and renews its lease while the holder runs.
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

  it("AUD-50: fails CLOSED — an unreadable lock skips the tick, it never runs unlocked", async () => {
    redisSet.mockRejectedValue(new Error("redis down"));
    const fn = vi.fn().mockResolvedValue("ran-anyway");

    const outcome = await withCronLock("immutable", fn);

    expect(outcome).toEqual({ ran: false, reason: "lock_unavailable" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("AUD-50: renews the lease while the holder runs, and stops renewing after", async () => {
    vi.useFakeTimers();
    try {
      redisSet.mockResolvedValue("OK");
      let finish!: () => void;
      const running = new Promise<void>((r) => (finish = r));
      const outcome = withCronLock("destruction", () => running, 3_000);
      await vi.advanceTimersByTimeAsync(3_500);
      const renewals = () =>
        redisEval.mock.calls.filter(([script]) => /pexpire/.test(String(script))).length;
      expect(renewals()).toBeGreaterThanOrEqual(3);
      const renewCall = redisEval.mock.calls.find(([script]) => /pexpire/.test(String(script)))!;
      expect(renewCall.slice(1)).toEqual([1, "cron:lock:destruction", expect.any(String), "3000"]);
      finish();
      await outcome;
      const after = renewals();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(renewals()).toBe(after);
    } finally {
      vi.useRealTimers();
    }
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
