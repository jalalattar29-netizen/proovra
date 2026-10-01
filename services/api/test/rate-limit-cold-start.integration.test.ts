/**
 * A cold process must not refuse its first CONCURRENT requests (real Redis).
 *
 * Found by feature CI (schema-reproducibility): five concurrent first views of a
 * Public Verify page answered 429 RATE_LIMITED. The limiter's Redis client is
 * lazy; only a caller that saw status "wait" connected it, and every concurrent
 * caller that arrived while it was "connecting" sent its command to a socket
 * that was not ready (offline queue disabled), failed, and put the store into
 * cooldown. A `global` bound (UC-SEC-006) fails closed while the store is in
 * cooldown, so legitimate first visitors were refused. Every caller now awaits
 * the ONE in-flight connection.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const REDIS = process.env.P7_TEST_REDIS_URL;
const runIf = REDIS && /^redis:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(REDIS) ? describe : describe.skip;

runIf("rate limiter — cold-start concurrency on a global bound (live Redis)", () => {
  let rl: typeof import("../src/services/rate-limit.js");

  beforeAll(async () => {
    process.env.REDIS_URL = REDIS;
    vi.resetModules();
    rl = await import("../src/services/rate-limit.js");
  });

  afterAll(async () => {
    await rl?.clearAllRateLimitBuckets().catch(() => undefined);
  });

  it("twenty concurrent first decisions on a fresh client are all answered from Redis, none refused", async () => {
    const key = `cold-start:${Date.now()}:${Math.random()}`;
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        rl.enforceRateLimit({ key: `${key}:${i}`, max: 5, windowSec: 60, bound: "global" }),
      ),
    );
    expect(results.map((r) => r.store)).toEqual(Array(20).fill("redis"));
    expect(results.every((r) => r.allowed)).toBe(true);
    expect(rl.rateLimitStoreStats().refusedForUnavailableStore).toBe(0);
  });

  it("the distinct-client limit is equally safe on its first concurrent calls", async () => {
    vi.resetModules();
    rl = await import("../src/services/rate-limit.js");
    const key = `cold-start-distinct:${Date.now()}`;
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        rl.enforceDistinctClientLimit({ key, member: `client-${i}`, max: 50, windowSec: 60, bound: "global" }),
      ),
    );
    expect(results.every((r) => r.allowed && r.store === "redis")).toBe(true);
    expect(rl.rateLimitStoreStats().refusedForUnavailableStore).toBe(0);
  });
});
