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