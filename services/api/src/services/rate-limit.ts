import IORedis from "ioredis";

type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetAtMs: number;
};

const memoryStore = new Map<string, { count: number; resetAtMs: number }>();
let redis: IORedis | null = null;

function getRedis(): IORedis | null {
  if (redis) return redis;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  redis = new IORedis(url, { maxRetriesPerRequest: null });
  return redis;
}

export async function enforceRateLimit(params: {
  key: string;
  max: number;
  windowSec: number;
}): Promise<RateLimitResult> {
  const now = Date.now();
  const resetAtMs = now + params.windowSec * 1000;
  const redisClient = getRedis();
  if (!redisClient) {
    const existing = memoryStore.get(params.key);
    if (!existing || existing.resetAtMs <= now) {
      memoryStore.set(params.key, { count: 1, resetAtMs });
      return { allowed: true, remaining: params.max - 1, resetAtMs };
    }
    if (existing.count >= params.max) {
      return { allowed: false, remaining: 0, resetAtMs: existing.resetAtMs };
    }
    existing.count += 1;
    return {
      allowed: true,
      remaining: Math.max(0, params.max - existing.count),
      resetAtMs: existing.resetAtMs,
    };
  }

  const pipeline = redisClient.pipeline();
  pipeline.incr(params.key);
  pipeline.pttl(params.key);
  const [[, count], [, ttlMs]] = await pipeline.exec();
  const current = Number(count ?? 0);
  const ttl = Number(ttlMs ?? -1);
  if (current === 1 || ttl < 0) {
    await redisClient.pexpire(params.key, params.windowSec * 1000);
  }
  const allowed = current <= params.max;
  const resetMs = ttl > 0 ? now + ttl : resetAtMs;
  return {
    allowed,
    remaining: Math.max(0, params.max - current),
    resetAtMs: resetMs,
  };
}
