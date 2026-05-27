import IORedis from "ioredis";

type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetAtMs: number;
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

function shouldUseRedis(): boolean {
  return Date.now() >= redisUnavailableUntil;
}

function markRedisUnavailable() {
  redisUnavailableUntil = Date.now() + readRedisCooldownMs();
}

function getRedis(): IORedis | null {
  if (!shouldUseRedis()) return null;
  if (redis) return redis;

  const url = process.env.REDIS_URL?.trim();
  if (!url) return null;

  try {
    redis = new IORedis(url, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
      enableOfflineQueue: false,
    });

    redis.on("error", () => {
      markRedisUnavailable();
    });

    redis.on("close", () => {
      markRedisUnavailable();
    });

    return redis;
  } catch {
    markRedisUnavailable();
    return null;
  }
}

async function enforceMemoryRateLimit(params: {
  key: string;
  max: number;
  windowSec: number;
}): Promise<RateLimitResult> {
  const now = Date.now();
  const resetAtMs = buildWindowReset(now, params.windowSec);

  const existing = memoryStore.get(params.key);

  if (!existing || existing.resetAtMs <= now) {
    memoryStore.set(params.key, { count: 1, resetAtMs });
    return {
      allowed: true,
      remaining: Math.max(0, params.max - 1),
      resetAtMs,
    };
  }

  if (existing.count >= params.max) {
    return {
      allowed: false,
      remaining: 0,
      resetAtMs: existing.resetAtMs,
    };
  }

  existing.count += 1;

  return {
    allowed: true,
    remaining: Math.max(0, params.max - existing.count),
    resetAtMs: existing.resetAtMs,
  };
}

async function enforceRedisRateLimit(params: {
  key: string;
  max: number;
  windowSec: number;
  redisClient: IORedis;
}): Promise<RateLimitResult> {
  const now = Date.now();
  const fallbackResetAtMs = buildWindowReset(now, params.windowSec);

  try {
    if (params.redisClient.status === "wait") {
      await params.redisClient.connect();
    }

    const pipeline = params.redisClient.pipeline();
    pipeline.incr(params.key);
    pipeline.pttl(params.key);

    const result = await pipeline.exec();

    const countRaw = result?.[0]?.[1];
    const ttlRaw = result?.[1]?.[1];

    const current = Number(countRaw ?? 0);
    const ttl = Number(ttlRaw ?? -1);

    if (!Number.isFinite(current) || current <= 0) {
      throw new Error("Invalid Redis INCR result");
    }

    if (current === 1 || ttl < 0) {
      await params.redisClient.pexpire(params.key, params.windowSec * 1000);
    }

    const allowed = current <= params.max;
    const resetAtMs = ttl > 0 ? now + ttl : fallbackResetAtMs;

    return {
      allowed,
      remaining: Math.max(0, params.max - current),
      resetAtMs,
    };
  } catch {
    markRedisUnavailable();
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
}): Promise<RateLimitResult> {
  const key = normalizeKey(params.key);
  const max = clampPositiveInt(params.max, 60);
  const windowSec = clampPositiveInt(params.windowSec, 60);

  const redisClient = getRedis();
  if (!redisClient) {
    return enforceMemoryRateLimit({ key, max, windowSec });
  }

  return enforceRedisRateLimit({
    key,
    max,
    windowSec,
    redisClient,
  });
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

  let redisCleared = 0;
  const client = getRedis();
  if (client) {
    try {
      if (client.status === "wait") {
        await client.connect();
      }
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
      markRedisUnavailable();
    }
  }

  return { memoryCleared, redisCleared };
}