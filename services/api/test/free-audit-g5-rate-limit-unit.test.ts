/**
 * FREE-USER AUDIT 0ea0 — GROUP API-G5-NOTIFY-PLATFORM (unit, Redis failing).
 *
 * The configured Redis is replaced by a client that cannot connect, so the
 * limiter and the lease meet the failure their fallbacks exist for:
 *   B8-F-004 — a sweep lease REFUSES when its configured store cannot answer
 *              (AUD-50), while the default lease keeps the memory fallback;
 *   B8-F-304 — the in-memory store that takes over is bounded (expired
 *              distinct-key buckets are swept).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("ioredis", () => {
  class UnreachableRedis {
    status = "wait";
    on() {
      return this;
    }
    once() {
      return this;
    }
    off() {
      return this;
    }
    async connect() {
      throw new Error("connect ECONNREFUSED (test)");
    }
    async set() {
      throw new Error("not connected (test)");
    }
    async eval() {
      throw new Error("not connected (test)");
    }
    async del() {
      return 0;
    }
  }
  return { default: UnreachableRedis, Redis: UnreachableRedis };
});

import {
  __memoryRateLimitBucketCountForTests,
  acquireLease,
  clearAllRateLimitBuckets,
  enforceRateLimit,
  MEMORY_RATE_LIMIT_PRUNE_THRESHOLD,
} from "../src/services/rate-limit.js";

beforeAll(() => {
  process.env.REDIS_URL = "redis://127.0.0.1:1";
});

describe("B8-F-004 — lease failure mode", () => {
  it("Redis configured but unreachable: onStoreError 'refuse' → not acquired; the default keeps the memory fallback", async () => {
    const refused = await acquireLease(`g5-sweep-${Date.now()}`, 60_000, { onStoreError: "refuse" });
    expect(refused.acquired).toBe(false);
    // Still refused during the store's cooldown (no client is offered then).
    const again = await acquireLease(`g5-sweep-b-${Date.now()}`, 60_000, { onStoreError: "refuse" });
    expect(again.acquired).toBe(false);
    const memory = await acquireLease(`g5-button-${Date.now()}`, 60_000);
    expect(memory.acquired).toBe(true);
    await memory.release();
  });
});

describe("B8-F-304 — in-memory limiter eviction", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await clearAllRateLimitBuckets();
  });

  it("expired distinct-key buckets are swept once the map passes the threshold", async () => {
    await clearAllRateLimitBuckets();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-16T10:00:00Z"));
    const n = MEMORY_RATE_LIMIT_PRUNE_THRESHOLD + 500;
    for (let i = 0; i < n; i++) {
      await enforceRateLimit({ key: `g5-distinct:${i}`, max: 5, windowSec: 1 });
    }
    expect(__memoryRateLimitBucketCountForTests()).toBe(n);
    // Every window has ended; the next request sweeps the expired buckets.
    vi.setSystemTime(new Date("2026-11-16T10:01:00Z"));
    await enforceRateLimit({ key: "g5-distinct:fresh", max: 5, windowSec: 60 });
    expect(__memoryRateLimitBucketCountForTests()).toBe(1);
  });
});
