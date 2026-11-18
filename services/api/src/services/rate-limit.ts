import IORedis from "ioredis";

import { warn as logWarn } from "../utils/logger.js";
import { bump } from "./ops/metrics.service.js";

/**
 * WHO A LIMIT IS SHARED BY.
 *
 * `"global"` — the limit is only meaningful if every replica counts in the
 * same bucket: an unauthenticated write that creates a row or sends a
 * message, or an attempt at a credential. With Redis configured, such a limit
 * is decided by Redis or the request is REFUSED. It is never counted in one
 * replica's memory, because N replicas each counting from zero is N
 * allowances, and a store that comes and goes would split one window between
 * Redis and memory.
 *
 * `"process"` (the default) — a cost control on an authenticated caller. When
 * Redis cannot answer, the replica counts in its own memory until Redis
 * returns. That is a weaker bound during an outage, and the result says so
 * (`store: "memory"`).
 *
 * With NO Redis configured there is one process and its memory is the whole
 * deployment's store, so both behave the same.
 */
export type RateLimitBound = "global" | "process";

export type RateLimitStore = "redis" | "memory" | "unavailable";

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetAtMs: number;
  /**
   * Which store decided. `"unavailable"` = a global bound could not be
   * established, so the request was refused without being counted anywhere.
   */
  store: RateLimitStore;
};

type MemoryBucket = {
  count: number;
  resetAtMs: number;
};

const memoryStore = new Map<string, MemoryBucket>();
let redis: IORedis | null = null;
let redisUnavailableUntil = 0;

function clampPositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function normalizeKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) {
    throw new Error("Rate limit key is required");
  }
  if (trimmed.length > 512) {
    return trimmed.slice(0, 512);
  }
  return trimmed;
}

function buildWindowReset(now: number, windowSec: number): number {
  return now + windowSec * 1000;
}

function readRedisCooldownMs(): number {
  const raw = process.env.RATE_LIMIT_REDIS_COOLDOWN_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : 15_000;
  return clampPositiveInt(parsed, 15_000);
}

/**
 * PRO-S1-03 — how long one limiter round-trip to Redis may take. The error and
 * close handlers only fire when the socket errors or closes; a Redis that
 * accepts the connection and stops answering (paused, wedged, mid-failover)
 * left every rate-limited request awaiting forever. A command that does not
 * answer within this bound is a store failure like any other: the same
 * cooldown, the same "global" refusal / "process" memory fallback.
 */
export const DEFAULT_RATE_LIMIT_REDIS_COMMAND_TIMEOUT_MS = 1_000;
function readRedisCommandTimeoutMs(): number {
  const raw = process.env.RATE_LIMIT_REDIS_COMMAND_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_RATE_LIMIT_REDIS_COMMAND_TIMEOUT_MS;
  return Math.min(clampPositiveInt(parsed, DEFAULT_RATE_LIMIT_REDIS_COMMAND_TIMEOUT_MS), 30_000);
}

/** Bound one store step (connect or command) by the command timeout. */
async function storeDeadline<T>(work: Promise<T>): Promise<T> {
  const ms = readRedisCommandTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("rate_limit_store_timeout")), ms);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    // A late rejection of the abandoned step must not surface as unhandled.
    work.catch(() => undefined);
  }
}

function shouldUseRedis(): boolean {
  return Date.now() >= redisUnavailableUntil;
}

// ---------------------------------------------------------------------------
// Store availability, as an operator can see it.
//
// Bounded: two counters and one reason from a closed set. One warning per
// cooldown at most, carrying no key, no address and no identifier — only that
// the shared store could not answer, why, and how many decisions it affected.
// ---------------------------------------------------------------------------
export type RateLimitStoreFailure = "connect_failed" | "connection_error" | "connection_closed" | "command_failed";

const storeStats = {
  unavailableTransitions: 0,
  refusedForUnavailableStore: 0,
  decidedInProcessMemory: 0,
  lastFailure: null as RateLimitStoreFailure | null,
  lastFailureAtMs: null as number | null,
};
let lastStoreWarningAtMs = 0;

/** Read-only view for health surfaces and tests. */
export function rateLimitStoreStats(): Readonly<typeof storeStats> & { redisConfigured: boolean; inCooldown: boolean } {
  return { ...storeStats, redisConfigured: redisConfigured(), inCooldown: !shouldUseRedis() };
}

function redisConfigured(): boolean {
  return Boolean(process.env.REDIS_URL?.trim());
}

function markRedisUnavailable(reason: RateLimitStoreFailure) {
  const now = Date.now();
  if (shouldUseRedis()) {
    storeStats.unavailableTransitions += 1;
    bump("rate_limit_store_unavailable_total");
  }
  storeStats.lastFailure = reason;
  storeStats.lastFailureAtMs = now;
  redisUnavailableUntil = now + readRedisCooldownMs();
  if (now - lastStoreWarningAtMs >= readRedisCooldownMs()) {
    lastStoreWarningAtMs = now;
    logWarn("rate_limit.store_unavailable", {
      reason,
      cooldownMs: readRedisCooldownMs(),
      unavailableTransitions: storeStats.unavailableTransitions,
      refusedForUnavailableStore: storeStats.refusedForUnavailableStore,
      decidedInProcessMemory: storeStats.decidedInProcessMemory,
    });
  }
}

/** A global bound with no trustworthy count: refused, counted nowhere. */
function refuseForUnavailableStore(): RateLimitResult {
  storeStats.refusedForUnavailableStore += 1;
  bump("rate_limit_refused_store_unavailable_total");
  const now = Date.now();
  return {
    allowed: false,
    remaining: 0,
    // When to come back: the end of the cooldown, not a full window.
    resetAtMs: Math.max(redisUnavailableUntil, now + 1_000),
    store: "unavailable",
  };
}

/**
 * The Redis client, or null when Redis is not configured or is cooling down.
 *
 * A GLOBAL bound asks for `ignoreCooldown`: a replica whose connection is
 * already back must not keep refusing public writes for the rest of a cooldown
 * that exists only to stop a dead connection being hammered.
 */
function getRedis(options: { ignoreCooldown?: boolean } = {}): IORedis | null {
  if (!shouldUseRedis() && !(options.ignoreCooldown && redis?.status === "ready")) return null;
  if (redis) return redis;

  const url = process.env.REDIS_URL?.trim();
  if (!url) return null;

  try {
    redis = new IORedis(url, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
      enableOfflineQueue: false,
      // PRO-S1-03 — ioredis itself also gives up on a silent server.
      commandTimeout: readRedisCommandTimeoutMs(),
      connectTimeout: Math.max(readRedisCommandTimeoutMs() * 2, 1_000),
    });

    redis.on("error", () => {
      markRedisUnavailable("connection_error");
    });

    redis.on("close", () => {
      markRedisUnavailable("connection_closed");
    });

    return redis;
  } catch {
    markRedisUnavailable("connect_failed");
    return null;
  }
}

/**
 * ONE in-flight connection for every caller. The client is lazy, and only the
 * caller that saw status "wait" used to connect it: every concurrent caller that
 * arrived while it was "connecting" sent its command to a socket that was not
 * ready (offline queue disabled), failed, and put the store into cooldown — so a
 * `global` bound refused a cold process's first concurrent visitors (429).
 */
let connecting: Promise<void> | null = null;
async function ensureConnected(client: IORedis): Promise<void> {
  if (client.status === "ready") return;
  if (client.status === "wait") {
    connecting ??= client.connect().finally(() => {
      connecting = null;
    });
  }
  if (connecting) {
    await connecting;
    return;
  }
  if (client.status === "connecting" || client.status === "connect") {
    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        client.off("error", onError);
        resolve();
      };
      const onError = (err: unknown) => {
        client.off("ready", onReady);
        reject(err);
      };
      client.once("ready", onReady);
      client.once("error", onError);
    });
  }
}

/**
 * B8-F-304 — the memory store is bounded. Entries were only ever overwritten
 * when the same key returned, so a burst of distinct keys (IPs, accounts)
 * lived until restart. Once the map passes the threshold, expired buckets are
 * swept — at most once per interval, so a large live map is not rescanned on
 * every request. Only past-window entries are removed, so no live count is
 * ever lost (the limit stays exact).
 */
export const MEMORY_RATE_LIMIT_PRUNE_THRESHOLD = 5_000;
const MEMORY_RATE_LIMIT_PRUNE_INTERVAL_MS = 5_000;
let lastMemoryPruneAtMs = 0;

function pruneExpiredMemoryBuckets(now: number): void {
  if (memoryStore.size <= MEMORY_RATE_LIMIT_PRUNE_THRESHOLD) return;
  if (now - lastMemoryPruneAtMs < MEMORY_RATE_LIMIT_PRUNE_INTERVAL_MS) return;
  lastMemoryPruneAtMs = now;
  for (const [k, bucket] of memoryStore) {
    if (bucket.resetAtMs <= now) memoryStore.delete(k);
  }
  for (const [k, lease] of memoryLeases) {
    if (lease.expiresAtMs <= now) memoryLeases.delete(k);
  }
}

/** Test-only: the number of buckets this process holds in memory. */
export function __memoryRateLimitBucketCountForTests(): number {
  return memoryStore.size;
}

async function enforceMemoryRateLimit(params: {
  key: string;
  max: number;
  windowSec: number;
}): Promise<RateLimitResult> {
  const now = Date.now();
  pruneExpiredMemoryBuckets(now);
  const resetAtMs = buildWindowReset(now, params.windowSec);

  const existing = memoryStore.get(params.key);

  if (!existing || existing.resetAtMs <= now) {
    memoryStore.set(params.key, { count: 1, resetAtMs });
    return {
      allowed: true,
      remaining: Math.max(0, params.max - 1),
      resetAtMs,
      store: "memory",
    };
  }

  if (existing.count >= params.max) {
    return {
      allowed: false,
      remaining: 0,
      resetAtMs: existing.resetAtMs,
      store: "memory",
    };
  }

  existing.count += 1;

  return {
    allowed: true,
    remaining: Math.max(0, params.max - existing.count),
    resetAtMs: existing.resetAtMs,
    store: "memory",
  };
}

/**
 * PHASE 12 — POINT 7 (2026-08-05): the limiter's Redis KEYSPACE.
 *
 * Callers pass domain-shaped keys (`auth:email-register:ip:…`,
 * `verify:ip:…`), and this module used to write them to Redis VERBATIM —
 * while `clearAllRateLimitBuckets` scan-deleted `ratelimit:*`. The two never
 * intersected, so the reset endpoint's Redis half was a no-op from the day it
 * shipped: it always reported `redisCleared: 0` and the buckets it was built
 * to clear survived untouched. The in-memory half worked, which is why it went
 * unnoticed — the failure only appears once Redis is actually configured.
 *
 * Prefixing here, at the ONE place keys enter Redis, makes the writer and the
 * cleaner agree by construction. It is internal: no caller passes or reads a
 * Redis key, and the in-memory store keeps the unprefixed key because it is
 * cleared wholesale.
 */
const REDIS_KEY_PREFIX = "ratelimit:";

async function enforceRedisRateLimit(params: {
  key: string;
  max: number;
  windowSec: number;
  redisClient: IORedis;
  bound: RateLimitBound;
}): Promise<RateLimitResult> {
  const now = Date.now();
  const fallbackResetAtMs = buildWindowReset(now, params.windowSec);
  const redisKey = `${REDIS_KEY_PREFIX}${params.key}`;

  try {
    await storeDeadline(ensureConnected(params.redisClient));

    const pipeline = params.redisClient.pipeline();
    pipeline.incr(redisKey);
    pipeline.pttl(redisKey);

    const result = await storeDeadline(pipeline.exec());

    const countRaw = result?.[0]?.[1];
    const ttlRaw = result?.[1]?.[1];

    const current = Number(countRaw ?? 0);
    const ttl = Number(ttlRaw ?? -1);

    if (!Number.isFinite(current) || current <= 0) {
      throw new Error("Invalid Redis INCR result");
    }

    if (current === 1 || ttl < 0) {
      await storeDeadline(params.redisClient.pexpire(redisKey, params.windowSec * 1000));
    }

    const allowed = current <= params.max;
    const resetAtMs = ttl > 0 ? now + ttl : fallbackResetAtMs;

    return {
      allowed,
      remaining: Math.max(0, params.max - current),
      resetAtMs,
      store: "redis",
    };
  } catch {
    markRedisUnavailable("command_failed");
    // A global bound is never continued in this replica's memory.
    if (params.bound === "global") return refuseForUnavailableStore();
    storeStats.decidedInProcessMemory += 1;
    return enforceMemoryRateLimit({
      key: params.key,
      max: params.max,
      windowSec: params.windowSec,
    });
  }
}

export async function enforceRateLimit(params: {
  key: string;
  max: number;
  windowSec: number;
  /** See {@link RateLimitBound}. Default `"process"`. */
  bound?: RateLimitBound;
}): Promise<RateLimitResult> {
  const key = normalizeKey(params.key);
  const max = clampPositiveInt(params.max, 60);
  const windowSec = clampPositiveInt(params.windowSec, 60);
  const bound: RateLimitBound = params.bound ?? "process";

  const redisClient = getRedis({ ignoreCooldown: bound === "global" });
  if (!redisClient) {
    // No Redis configured: this process is the deployment, and its memory is
    // the one store there is — for either kind of bound.
    if (!redisConfigured()) return enforceMemoryRateLimit({ key, max, windowSec });
    // Redis is configured and cannot answer.
    if (bound === "global") return refuseForUnavailableStore();
    storeStats.decidedInProcessMemory += 1;
    return enforceMemoryRateLimit({ key, max, windowSec });
  }

  return enforceRedisRateLimit({
    key,
    max,
    windowSec,
    redisClient,
    bound,
  });
}

// =============================================================================
// ET-PKG-17 — a DISTINCT-CLIENT limit.
//
// A request-count bucket shared by everyone who opens one resource is a
// denial-of-service lever: two clients at their own per-client allowance
// exhaust it and every legitimate viewer gets 429 for the window. This limit
// counts DISTINCT clients per window instead. A client admitted in the window
// stays admitted (its request volume is the per-client bucket's business); a
// few clients can never exhaust it; only many distinct clients (the rotating-
// address enumeration the resource bucket exists to stop) reach the cap.
// =============================================================================

const DISTINCT_CLIENT_LIMIT_SCRIPT = [
  "if redis.call('sismember', KEYS[1], ARGV[1]) == 1 then",
  "  return {1, redis.call('scard', KEYS[1]), redis.call('pttl', KEYS[1])}",
  "end",
  "local n = redis.call('scard', KEYS[1])",
  "if n >= tonumber(ARGV[2]) then return {0, n, redis.call('pttl', KEYS[1])} end",
  "redis.call('sadd', KEYS[1], ARGV[1])",
  "if redis.call('pttl', KEYS[1]) < 0 then redis.call('pexpire', KEYS[1], ARGV[3]) end",
  "return {1, n + 1, redis.call('pttl', KEYS[1])}",
].join("\n");

type MemoryMemberSet = { members: Set<string>; resetAtMs: number };
const memoryMemberSets = new Map<string, MemoryMemberSet>();
let lastMemberSetPruneAtMs = 0;

/**
 * PRO-S1-12 — the distinct-client sets are bounded like the buckets above: an
 * expired set was only replaced when the same key returned, so probing random
 * resource keys (Verify package ids) grew this map until restart. Same rule:
 * only past-window sets are removed, at most once per interval, so no live
 * admission is ever forgotten.
 */
function pruneExpiredMemberSets(now: number): void {
  if (memoryMemberSets.size <= MEMORY_RATE_LIMIT_PRUNE_THRESHOLD) return;
  if (now - lastMemberSetPruneAtMs < MEMORY_RATE_LIMIT_PRUNE_INTERVAL_MS) return;
  lastMemberSetPruneAtMs = now;
  for (const [k, set] of memoryMemberSets) {
    if (set.resetAtMs <= now) memoryMemberSets.delete(k);
  }
}

/** Test-only: the number of distinct-client sets this process holds in memory. */
export function __memoryDistinctClientSetCountForTests(): number {
  return memoryMemberSets.size;
}

function enforceMemoryDistinctClientLimit(params: {
  key: string;
  member: string;
  max: number;
  windowSec: number;
}): RateLimitResult {
  const now = Date.now();
  pruneExpiredMemberSets(now);
  let set = memoryMemberSets.get(params.key);
  if (!set || set.resetAtMs <= now) {
    set = { members: new Set(), resetAtMs: buildWindowReset(now, params.windowSec) };
    memoryMemberSets.set(params.key, set);
  }
  if (set.members.has(params.member)) {
    return { allowed: true, remaining: Math.max(0, params.max - set.members.size), resetAtMs: set.resetAtMs, store: "memory" };
  }
  if (set.members.size >= params.max) {
    return { allowed: false, remaining: 0, resetAtMs: set.resetAtMs, store: "memory" };
  }
  set.members.add(params.member);
  return { allowed: true, remaining: Math.max(0, params.max - set.members.size), resetAtMs: set.resetAtMs, store: "memory" };
}

export async function enforceDistinctClientLimit(params: {
  key: string;
  /** The client identity (e.g. the trusted client-address key). */
  member: string;
  max: number;
  windowSec: number;
  /** See {@link RateLimitBound}. Default `"process"`. */
  bound?: RateLimitBound;
}): Promise<RateLimitResult> {
  const key = normalizeKey(params.key);
  const member = normalizeKey(params.member);
  const max = clampPositiveInt(params.max, 60);
  const windowSec = clampPositiveInt(params.windowSec, 60);
  const bound: RateLimitBound = params.bound ?? "process";
  const redisClient = getRedis({ ignoreCooldown: bound === "global" });
  if (!redisClient) {
    if (!redisConfigured()) return enforceMemoryDistinctClientLimit({ key, member, max, windowSec });
    if (bound === "global") return refuseForUnavailableStore();
    storeStats.decidedInProcessMemory += 1;
    return enforceMemoryDistinctClientLimit({ key, member, max, windowSec });
  }
  const now = Date.now();
  const redisKey = `${REDIS_KEY_PREFIX}${key}`;
  try {
    await storeDeadline(ensureConnected(redisClient));
    // One atomic decision. Membership first: an admitted client never consumes
    // another slot and is never refused inside its window.
    const [allowed, size, ttl] = (await storeDeadline(
      redisClient.eval(
        DISTINCT_CLIENT_LIMIT_SCRIPT,
        1,
        redisKey,
        member,
        String(max),
        String(windowSec * 1000),
      ),
    )) as [number, number, number];
    const resetAtMs = Number(ttl) > 0 ? now + Number(ttl) : buildWindowReset(now, windowSec);
    return { allowed: Number(allowed) === 1, remaining: Math.max(0, max - Number(size)), resetAtMs, store: "redis" };
  } catch {
    markRedisUnavailable("command_failed");
    if (bound === "global") return refuseForUnavailableStore();
    storeStats.decidedInProcessMemory += 1;
    return enforceMemoryDistinctClientLimit({ key, member, max, windowSec });
  }
}

/**
 * Phase 2.7Z+ — Test-only helper: wipe ALL rate-limit state.
 *
 * Clears the in-memory map AND scan-deletes every `ratelimit:*`
 * Redis key, so callers don't need to know which store is active.
 *
 * Hard rules:
 *
 *   - This module exports the helper UNCONDITIONALLY. Gating is the
 *     route layer's job — see `services/api/src/routes/_test-rate-limit.routes.ts`
 *     for the three-layer defense (NODE_ENV != production +
 *     E2E_AUTH_BYPASS_SECRET set + matching header). Without that
 *     gating the helper has no business being callable.
 *
 *   - The function is read-only with respect to limiter SEMANTICS:
 *     it doesn't change limits, windows, or store selection. It
 *     ONLY drops the count state. New requests after the reset
 *     start counting from zero, exactly as on a fresh process.
 *
 *   - SCAN+DEL avoids the O(N) KEYS-blocking pitfall. Cursor-based
 *     iteration is safe to call concurrently with normal limiter
 *     traffic (limiter races just count from the new zero baseline).
 */
export async function clearAllRateLimitBuckets(): Promise<{
  memoryCleared: number;
  redisCleared: number;
}> {
  const memoryCleared = memoryStore.size;
  memoryStore.clear();
  memoryMemberSets.clear();
  memoryLeases.clear();

  let redisCleared = 0;
  const client = getRedis();
  if (client) {
    try {
      await ensureConnected(client);
      let cursor = "0";
      do {
        const result = (await client.scan(
          cursor,
          "MATCH",
          "ratelimit:*",
          "COUNT",
          200,
        )) as [string, string[]];
        cursor = result[0];
        const keys = result[1];
        if (keys.length > 0) {
          redisCleared += keys.length;
          await client.del(...keys);
        }
      } while (cursor !== "0");
    } catch {
      // Redis unavailable mid-clear → mark unhealthy + fall through.
      // The memory store has already been cleared above.
      markRedisUnavailable("command_failed");
    }
  }

  return { memoryCleared, redisCleared };
}
// ===========================================================================
// BILLING PAYPAL INTEGRITY (2026-09-28) — a real LEASE, not a rate limit.
// ===========================================================================
//
// The billing "lease" used to be `enforceRateLimit({ max: 1, windowSec: 60 })`:
// a fixed window that was never released, so a second request made after the
// first had FINISHED was still refused for the rest of the minute — and the
// route then answered as though a check had run. A lease is held while work
// runs and released when it ends; its TTL only bounds a crashed holder.
//
// Redis `SET NX PX` with a per-holder token (release deletes only its own
// token), in the same keyspace as the limiter so the test reset clears both.
// Without Redis it falls back to this process's memory, exactly as the limiter
// does — the writers behind every lease are idempotent and compare-and-set, so
// the lease prevents wasted provider calls, not double effects.

type MemoryLease = { token: string; expiresAtMs: number };
const memoryLeases = new Map<string, MemoryLease>();

export type Lease = { acquired: boolean; release: () => Promise<void> };

function leaseToken(): string {
  return `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function acquireMemoryLease(key: string, ttlMs: number): Lease {
  const now = Date.now();
  const held = memoryLeases.get(key);
  if (held && held.expiresAtMs > now) {
    return { acquired: false, release: async () => undefined };
  }
  const token = leaseToken();
  memoryLeases.set(key, { token, expiresAtMs: now + ttlMs });
  return {
    acquired: true,
    release: async () => {
      if (memoryLeases.get(key)?.token === token) memoryLeases.delete(key);
    },
  };
}

const RELEASE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/**
 * B8-F-004 — WHAT A LEASE DOES WHEN ITS STORE CANNOT ANSWER.
 *
 * `"memory"` (default) keeps the historical behaviour for interactive paths
 * whose writers are compare-and-set (a Redis blip must not turn a button into
 * "busy"). `"refuse"` is for SWEEPS and other work that every API process
 * starts on its own timer: with Redis configured, an unreadable lock is not a
 * licence to run (AUD-50, the worker cron lock's rule) — each process holding
 * its own memory lease meant N concurrent sweeps during an outage. Without
 * Redis configured there is one process and memory is the whole store, so
 * both behave the same.
 */
export type LeaseOptions = { onStoreError?: "memory" | "refuse" };

const REFUSED_LEASE: Lease = { acquired: false, release: async () => undefined };

export async function acquireLease(
  rawKey: string,
  ttlMs: number,
  options: LeaseOptions = {},
): Promise<Lease> {
  const key = normalizeKey(rawKey);
  const ttl = clampPositiveInt(ttlMs, 60_000);
  const refuseOnStoreError =
    options.onStoreError === "refuse" && redisConfigured();
  const client = getRedis();
  if (!client) {
    if (refuseOnStoreError) {
      logWarn("lease.refused_store_unavailable", { key });
      return REFUSED_LEASE;
    }
    return acquireMemoryLease(key, ttl);
  }
  const redisKey = `${REDIS_KEY_PREFIX}lease:${key}`;
  const token = leaseToken();
  try {
    await storeDeadline(ensureConnected(client));
    const ok = await storeDeadline(client.set(redisKey, token, "PX", ttl, "NX"));
    if (ok !== "OK") return { acquired: false, release: async () => undefined };
    return {
      acquired: true,
      release: async () => {
        await client.eval(RELEASE_LUA, 1, redisKey, token).catch(() => undefined);
      },
    };
  } catch {
    markRedisUnavailable("command_failed");
    if (refuseOnStoreError) {
      logWarn("lease.refused_store_unavailable", { key });
      return REFUSED_LEASE;
    }
    return acquireMemoryLease(key, ttl);
  }
}

/** Run `fn` holding the lease; `onBusy` answers when another holder has it. */
export async function withLease<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
  onBusy: () => T | Promise<T>,
  options: LeaseOptions = {},
): Promise<T> {
  const lease = await acquireLease(key, ttlMs, options);
  if (!lease.acquired) return onBusy();
  try {
    return await fn();
  } finally {
    await lease.release();
  }
}
