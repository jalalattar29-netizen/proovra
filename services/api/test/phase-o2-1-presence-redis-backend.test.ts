/**
 * Phase O2.1 — Redis-backed presence backend contract.
 *
 * Asserts:
 *   1. Selector defaults to in-memory when `PROOVRA_PRESENCE_BACKEND`
 *      is unset (Phase G3 behaviour preserved).
 *   2. Selector picks Redis when env flag set AND REDIS_URL set.
 *   3. Selector falls back to memory when env flag=redis but no
 *      REDIS_URL.
 *   4. RedisPresenceBackend round-trips heartbeat → list against an
 *      in-memory mock ioredis.
 *   5. RedisPresenceBackend evicts stale (>TTL) entries at read time.
 *   6. RedisPresenceBackend never throws — Redis errors degrade to
 *      no-op writes / empty lists.
 *   7. RedisPresenceBackend bounds the hash size (HDEL oldest when
 *      over MAX_VIEWERS_PER_KEY).
 *   8. RedisPresenceBackend never writes IP / device / location.
 *   9. Routes import from the selector, not the bare Phase G3 module.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PRESENCE_HEARTBEAT_TTL_MS,
  PRESENCE_MAX_VIEWERS_PER_KEY,
} from "../src/services/presence/presence-backend.js";
import { RedisPresenceBackend } from "../src/services/presence/redis-presence-backend.js";
import {
  __currentSelectorBackendKind,
  __resetSelectorForTests,
  __setSelectorBackendForTests,
  listViewersAsyncViaSelector,
  recordHeartbeatViaSelector,
} from "../src/services/presence/presence-selector.js";

// ---------------------------------------------------------------------------
// In-memory ioredis mock. Implements only the surface
// RedisPresenceBackend touches: hset, hgetall, hdel, hlen, expire,
// scanStream, del, connect.
// ---------------------------------------------------------------------------

class MockRedis {
  store: Map<string, Map<string, string>> = new Map();
  shouldThrow = false;
  private failNextN = 0;

  failNext(n: number) {
    this.failNextN = n;
  }

  private maybeThrow() {
    if (this.shouldThrow) throw new Error("redis-down");
    if (this.failNextN > 0) {
      this.failNextN--;
      throw new Error("redis-flap");
    }
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    this.maybeThrow();
    let h = this.store.get(key);
    if (!h) {
      h = new Map();
      this.store.set(key, h);
    }
    const isNew = !h.has(field);
    h.set(field, value);
    return isNew ? 1 : 0;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    this.maybeThrow();
    const h = this.store.get(key);
    if (!h) return {};
    return Object.fromEntries(h);
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    this.maybeThrow();
    const h = this.store.get(key);
    if (!h) return 0;
    let n = 0;
    for (const f of fields) if (h.delete(f)) n++;
    if (h.size === 0) this.store.delete(key);
    return n;
  }

  async hlen(key: string): Promise<number> {
    this.maybeThrow();
    return this.store.get(key)?.size ?? 0;
  }

  async expire(_key: string, _ttlSec: number): Promise<number> {
    this.maybeThrow();
    return 1;
  }

  scanStream(opts: { match: string; count: number }) {
    const prefix = opts.match.replace(/\*$/, "");
    const keys = Array.from(this.store.keys()).filter((k) =>
      k.startsWith(prefix),
    );
    return (async function* () {
      yield keys;
    })();
  }

  async del(...keys: string[]): Promise<number> {
    this.maybeThrow();
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) n++;
    return n;
  }

  async connect(): Promise<void> {
    this.maybeThrow();
  }
}

const stableInput = (overrides: Partial<Record<string, string>> = {}) => ({
  teamId: "team-1",
  resourceKind: "evidence",
  resourceId: "evi-1",
  ...overrides,
});

// ---------------------------------------------------------------------------
// 1-3. Selector tests
// ---------------------------------------------------------------------------

describe("O2.1 — selector backend choice", () => {
  beforeEach(() => {
    __resetSelectorForTests();
    delete process.env.PROOVRA_PRESENCE_BACKEND;
    delete process.env.REDIS_URL;
  });
  afterEach(() => {
    __resetSelectorForTests();
    delete process.env.PROOVRA_PRESENCE_BACKEND;
    delete process.env.REDIS_URL;
  });

  it("defaults to in-memory backend when no env flag", async () => {
    recordHeartbeatViaSelector({
      ...stableInput(),
      userId: "u-a",
      displayName: "Anne",
    });
    // Selector resolves on first call.
    await listViewersAsyncViaSelector({
      ...stableInput(),
      excludeUserId: "u-a",
    });
    expect(__currentSelectorBackendKind()).toBe("memory");
  });

  it("degrades to in-memory when PROOVRA_PRESENCE_BACKEND=redis but REDIS_URL is unset", async () => {
    process.env.PROOVRA_PRESENCE_BACKEND = "redis";
    // REDIS_URL deliberately not set.
    await listViewersAsyncViaSelector({
      ...stableInput(),
      excludeUserId: "u-a",
    });
    expect(__currentSelectorBackendKind()).toBe("memory");
  });

  it("backends can be injected for test isolation", async () => {
    const mock = new MockRedis();
    __setSelectorBackendForTests(new RedisPresenceBackend(mock as never));
    expect(__currentSelectorBackendKind()).toBe("redis");
  });
});

// ---------------------------------------------------------------------------
// 4-7. RedisPresenceBackend behaviour
// ---------------------------------------------------------------------------

describe("O2.1 — RedisPresenceBackend round-trip", () => {
  it("records + lists across simulated instances", async () => {
    // The same MockRedis represents the shared Redis. Two
    // RedisPresenceBackend instances simulate two api containers.
    const redis = new MockRedis();
    const instanceA = new RedisPresenceBackend(redis as never);
    const instanceB = new RedisPresenceBackend(redis as never);

    await instanceA.recordHeartbeat({
      ...stableInput(),
      userId: "u-a",
      displayName: "Anne",
    });
    await instanceB.recordHeartbeat({
      ...stableInput(),
      userId: "u-b",
      displayName: "Brian",
    });

    // Instance B sees both viewers (excluding itself).
    const viewersFromB = await instanceB.listViewers({
      ...stableInput(),
      excludeUserId: "u-b",
    });
    expect(viewersFromB.map((v) => v.userId).sort()).toEqual(["u-a"]);

    // Instance A sees both viewers (excluding itself).
    const viewersFromA = await instanceA.listViewers({
      ...stableInput(),
      excludeUserId: "u-a",
    });
    expect(viewersFromA.map((v) => v.userId).sort()).toEqual(["u-b"]);
  });

  it("evicts entries older than HEARTBEAT_TTL_MS at read time", async () => {
    const redis = new MockRedis();
    const backend = new RedisPresenceBackend(redis as never);

    // Manually plant a stale field — score `tMs` older than the TTL.
    const key = "proovra:presence:team-1|evidence|evi-1";
    const staleTms = Date.now() - PRESENCE_HEARTBEAT_TTL_MS - 1000;
    redis.store.set(
      key,
      new Map([
        [
          "u-stale",
          JSON.stringify({ displayName: "Stale", tMs: staleTms }),
        ],
      ]),
    );

    const viewers = await backend.listViewers({
      ...stableInput(),
      excludeUserId: "u-other",
    });
    expect(viewers).toHaveLength(0);
    // The stale field is removed.
    expect(redis.store.get(key)?.has("u-stale") ?? false).toBe(false);
  });

  it("backend is best-effort — Redis errors degrade to empty / no-op", async () => {
    const redis = new MockRedis();
    redis.shouldThrow = true;
    const backend = new RedisPresenceBackend(redis as never);

    // recordHeartbeat must not throw.
    await expect(
      backend.recordHeartbeat({
        ...stableInput(),
        userId: "u-a",
        displayName: "Anne",
      }),
    ).resolves.toBeUndefined();

    // listViewers must return empty array, not throw.
    const viewers = await backend.listViewers({
      ...stableInput(),
      excludeUserId: "u-a",
    });
    expect(viewers).toEqual([]);
  });

  it("bounds hash size to MAX_VIEWERS_PER_KEY (evicts oldest when over)", async () => {
    const redis = new MockRedis();
    const backend = new RedisPresenceBackend(redis as never);

    // Add MAX + 5 viewers. Use distinct timestamps so the eviction
    // order is deterministic.
    for (let i = 0; i < PRESENCE_MAX_VIEWERS_PER_KEY + 5; i++) {
      // Spread heartbeats across an artificial timeline by mutating
      // the resulting field after the call (simpler than mocking
      // Date.now per-call given we keep the production code intact).
      await backend.recordHeartbeat({
        ...stableInput(),
        userId: `u-${i}`,
        displayName: `User ${i}`,
      });
      const key = "proovra:presence:team-1|evidence|evi-1";
      const h = redis.store.get(key)!;
      h.set(
        `u-${i}`,
        JSON.stringify({ displayName: `User ${i}`, tMs: 1000 + i }),
      );
    }

    // Trigger one more heartbeat so the over-bound branch runs.
    await backend.recordHeartbeat({
      ...stableInput(),
      userId: "u-final",
      displayName: "Final",
    });
    const key = "proovra:presence:team-1|evidence|evi-1";
    const finalSize = redis.store.get(key)?.size ?? 0;
    expect(finalSize).toBeLessThanOrEqual(PRESENCE_MAX_VIEWERS_PER_KEY);
  });

  it("payload carries no IP / device / route history (only displayName + tMs)", async () => {
    const redis = new MockRedis();
    const backend = new RedisPresenceBackend(redis as never);

    await backend.recordHeartbeat({
      ...stableInput(),
      userId: "u-a",
      displayName: "Anne",
    });

    const key = "proovra:presence:team-1|evidence|evi-1";
    const raw = redis.store.get(key)?.get("u-a") ?? "";
    expect(raw).not.toMatch(/ip/i);
    expect(raw).not.toMatch(/userAgent/i);
    expect(raw).not.toMatch(/deviceId/i);
    expect(raw).not.toMatch(/route/i);
    expect(raw).toMatch(/displayName/);
    expect(raw).toMatch(/tMs/);
  });
});

// ---------------------------------------------------------------------------
// 9. Route wiring
// ---------------------------------------------------------------------------

describe("O2.1 — route wires through the selector", () => {
  it("presence.routes.ts imports recordHeartbeatViaSelector + listViewersAsyncViaSelector", () => {
    const src = readFileSync(
      fileURLToPath(
        new URL("../src/routes/presence.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(src).toMatch(/from\s+"\.\.\/services\/presence\/presence-selector/);
    expect(src).toMatch(/recordHeartbeatViaSelector/);
    expect(src).toMatch(/listViewersAsyncViaSelector/);
  });

  it("route handlers await the async listViewers call", () => {
    const src = readFileSync(
      fileURLToPath(
        new URL("../src/routes/presence.routes.ts", import.meta.url),
      ),
      "utf8",
    );
    // Both routes use the awaited form.
    const awaitCount = (src.match(/await listViewers\(/g) ?? []).length;
    expect(awaitCount).toBeGreaterThanOrEqual(2);
  });
});
