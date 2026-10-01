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
import { type AddressInfo, connect, createServer, type Socket } from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { acquireIntegrationDatabase, type IntegrationDatabase } from "./integration-harness";

describe("rate limiter — cold-start concurrency on a global bound (live Redis)", () => {
  let rl: typeof import("../src/services/rate-limit.js");
  let database: IntegrationDatabase;

  beforeAll(async () => {
    // The limiter touches no database. Acquisition is the integration
    // project's ONE entry gate: without the live-integration environment it
    // REFUSES (never skips). The Redis is the disposable loopback one that
    // setup/safe-environment.ts always assigns to REDIS_URL
    // (P7_TEST_REDIS_URL, else the conventional local port) — never inherited.
    database = await acquireIntegrationDatabase();
    const redis = process.env.REDIS_URL ?? "";
    expect(redis, "REDIS_URL must be the disposable loopback Redis").toMatch(
      /^redis:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/\d+)?$/,
    );
    vi.resetModules();
    rl = await import("../src/services/rate-limit.js");
  });

  afterAll(async () => {
    await rl?.clearAllRateLimitBuckets().catch(() => undefined);
    await database?.release();
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

  it("a failed connection is not cached: refused while Redis is unreachable, served from Redis once it is back", async () => {
    // A TCP relay in front of the real disposable Redis that we can hold DOWN
    // (nothing listening) and then bring UP on the same port.
    const target = new URL(process.env.REDIS_URL ?? "");
    const port = await new Promise<number>((resolvePort, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const { port: p } = probe.address() as AddressInfo;
        probe.close(() => resolvePort(p));
      });
    });
    const sockets = new Set<Socket>();
    const relay = createServer((client) => {
      const upstream = connect(Number(target.port || 6379), target.hostname);
      for (const s of [client, upstream]) {
        sockets.add(s);
        s.on("close", () => sockets.delete(s));
        s.on("error", () => s.destroy());
      }
      client.pipe(upstream).pipe(client);
    });

    const saved = { url: process.env.REDIS_URL, cooldown: process.env.RATE_LIMIT_REDIS_COOLDOWN_MS };
    process.env.REDIS_URL = `redis://127.0.0.1:${port}${target.pathname}`;
    process.env.RATE_LIMIT_REDIS_COOLDOWN_MS = "200";
    vi.resetModules();
    const limiter: typeof import("../src/services/rate-limit.js") = await import("../src/services/rate-limit.js");
    const key = `recovery:${Date.now()}:${Math.random()}`;
    try {
      // DOWN — concurrent first callers share the one failing connection
      // attempt; a GLOBAL bound fails closed and nothing is counted anywhere.
      const down = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          limiter.enforceRateLimit({ key: `${key}:down:${i}`, max: 5, windowSec: 60, bound: "global" }),
        ),
      );
      expect(down.map((r) => r.store)).toEqual(Array(5).fill("unavailable"));
      expect(down.every((r) => !r.allowed)).toBe(true);
      expect(limiter.rateLimitStoreStats().refusedForUnavailableStore).toBe(5);

      // UP — the same address starts answering. No restart, no new module:
      // the next decisions must reach Redis (bounded wait for the client's
      // own reconnect and the 200 ms cooldown).
      await new Promise<void>((ok) => relay.listen(port, "127.0.0.1", () => ok()));
      let recovered: Awaited<ReturnType<typeof limiter.enforceRateLimit>> | null = null;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const r = await limiter.enforceRateLimit({ key: `${key}:probe`, max: 1_000, windowSec: 60, bound: "global" });
        if (r.store === "redis") {
          recovered = r;
          break;
        }
        expect(r.allowed, "while not recovered, a global bound still refuses").toBe(false);
        await new Promise((t) => setTimeout(t, 100));
      }
      expect(recovered?.store, "the limiter reconnected to Redis after the outage").toBe("redis");
      expect(recovered?.allowed).toBe(true);

      const after = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          limiter.enforceRateLimit({ key: `${key}:up:${i}`, max: 5, windowSec: 60, bound: "global" }),
        ),
      );
      expect(after.map((r) => r.store)).toEqual(Array(10).fill("redis"));
      expect(after.every((r) => r.allowed)).toBe(true);
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((ok) => relay.close(() => ok()));
      process.env.REDIS_URL = saved.url;
      if (saved.cooldown === undefined) delete process.env.RATE_LIMIT_REDIS_COOLDOWN_MS;
      else process.env.RATE_LIMIT_REDIS_COOLDOWN_MS = saved.cooldown;
    }
  });
});
