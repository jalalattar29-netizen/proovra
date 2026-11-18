/**
 * WS-REL / PRO-S1-03 — a Redis that accepts the connection and then never
 * answers must not stall every rate-limited request.
 *
 * At base the limiter's client had no command or connect deadline; the error
 * and close handlers only fire when the socket errors or closes. Against a
 * silent server every enforceRateLimit call awaited forever, so sign-in,
 * Verify, presign and step-up held an in-flight slot until the edge cut it.
 *
 * Harness: a real TCP server that accepts and never writes a byte, and the
 * real ioredis client. PRO-S1-12 (distinct-client sets pruned) rides along.
 */
import net from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __memoryDistinctClientSetCountForTests,
  enforceDistinctClientLimit,
  enforceRateLimit,
  rateLimitStoreStats,
} from "../src/services/rate-limit.js";

let server: net.Server;
let stalledUrl = "";
const sockets = new Set<net.Socket>();

beforeAll(async () => {
  server = net.createServer((socket) => {
    // Accept, read and discard, never answer: a paused / wedged Redis.
    sockets.add(socket);
    socket.on("data", () => undefined);
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  stalledUrl = `redis://127.0.0.1:${port}`;
  process.env.RATE_LIMIT_REDIS_COMMAND_TIMEOUT_MS = "300";
  process.env.RATE_LIMIT_REDIS_COOLDOWN_MS = "60000";
});

// The harness re-asserts REDIS_URL (local disposable Redis) before each test;
// point it at the silent server after that.
beforeEach(() => {
  process.env.REDIS_URL = stalledUrl;
  process.env.RATE_LIMIT_REDIS_COMMAND_TIMEOUT_MS = "300";
  process.env.RATE_LIMIT_REDIS_COOLDOWN_MS = "60000";
});

afterAll(async () => {
  for (const s of sockets) s.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.REDIS_URL;
  delete process.env.RATE_LIMIT_REDIS_COMMAND_TIMEOUT_MS;
  delete process.env.RATE_LIMIT_REDIS_COOLDOWN_MS;
});

const STALL = Symbol("stalled");
function within<T>(p: Promise<T>, ms: number): Promise<T | typeof STALL> {
  return Promise.race([p, new Promise<typeof STALL>((r) => setTimeout(() => r(STALL), ms).unref())]);
}

describe("PRO-S1-03 limiter against a silent Redis", () => {
  it("a global bound is refused promptly (store unavailable), not left hanging", async () => {
    const started = Date.now();
    const result = await within(
      enforceRateLimit({ key: "ws-rel:stall:global", max: 5, windowSec: 60, bound: "global" }),
      2_500,
    );
    expect(result).not.toBe(STALL);
    if (result === STALL) return;
    expect(result.allowed).toBe(false);
    expect(result.store).toBe("unavailable");
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(rateLimitStoreStats().inCooldown).toBe(true);
  });

  it("a process bound then decides from memory without touching the stalled store", async () => {
    const result = await within(
      enforceRateLimit({ key: "ws-rel:stall:process", max: 5, windowSec: 60 }),
      1_000,
    );
    expect(result).not.toBe(STALL);
    if (result === STALL) return;
    expect(result.allowed).toBe(true);
    expect(result.store).toBe("memory");
  });
});

describe("PRO-S1-12 distinct-client memory sets are pruned once their window ends", () => {
  it("expired per-resource sets are dropped on the next prune", async () => {
    const before = __memoryDistinctClientSetCountForTests();
    for (let i = 0; i < 5_100; i += 1) {
      await enforceDistinctClientLimit({ key: `ws-rel:probe:${i}`, member: "c1", max: 3, windowSec: 1 });
    }
    expect(__memoryDistinctClientSetCountForTests()).toBeGreaterThanOrEqual(before + 5_100);
    // Past every 1 s window and past the prune interval (clock only).
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 6_000);
      // Any limiter decision triggers the bounded prune.
      await enforceDistinctClientLimit({ key: "ws-rel:probe:trigger", member: "c1", max: 3, windowSec: 60 });
    } finally {
      vi.useRealTimers();
    }
    expect(__memoryDistinctClientSetCountForTests()).toBeLessThan(50);
  });
});
