/**
 * Operations Center — per-user summary cache for the header bell.
 *
 * The bell polls GET /v1/me/inbox/summary; running the full ~19-source
 * aggregation for every poll would be wasteful, so the computed summary
 * is cached per USER for a short TTL and explicitly invalidated on every
 * state mutation (read / unread / dismiss / snooze / bulk read).
 *
 * Storage follows the platform's canonical runtime-cache posture
 * (services/api/src/services/rate-limit.ts): Redis when REDIS_URL is
 * configured, with an in-process Map fallback and a cooldown when Redis
 * misbehaves. Keys are namespaced per user id — a cached value can never
 * be served to a different user, and since the summary is computed from
 * the caller's own tenant-scoped aggregation, no cross-workspace or
 * cross-organization data can enter another tenant's cache entry.
 *
 * Source-side changes (a new mention, a fresh incident) are bounded by
 * the TTL rather than per-writer hooks — the ~19 producing subsystems do
 * not call into this module; staleness is capped at TTL seconds, which
 * is within notification-appropriate freshness. Mutations the user makes
 * are reflected IMMEDIATELY via invalidation.
 */
import IORedis from "ioredis";

export const OPERATIONS_SUMMARY_TTL_SECONDS = 45;

const KEY_PREFIX = "opscenter:summary:";

type MemoryEntry = { value: string; expiresAtMs: number };

const memoryStore = new Map<string, MemoryEntry>();
let redis: IORedis | null = null;
let redisUnavailableUntil = 0;

function shouldUseRedis(): boolean {
  return Date.now() >= redisUnavailableUntil;
}

function markRedisUnavailable(): void {
  redisUnavailableUntil = Date.now() + 15_000;
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
    redis.on("error", () => markRedisUnavailable());
    redis.on("close", () => markRedisUnavailable());
    return redis;
  } catch {
    markRedisUnavailable();
    return null;
  }
}

function key(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

export async function getCachedOperationsSummary(
  userId: string,
): Promise<string | null> {
  const client = getRedis();
  if (client) {
    try {
      if (client.status === "wait") await client.connect();
      return await client.get(key(userId));
    } catch {
      markRedisUnavailable();
    }
  }
  const entry = memoryStore.get(key(userId));
  if (!entry) return null;
  if (entry.expiresAtMs <= Date.now()) {
    memoryStore.delete(key(userId));
    return null;
  }
  return entry.value;
}

export async function setCachedOperationsSummary(
  userId: string,
  serialized: string,
  ttlSeconds: number = OPERATIONS_SUMMARY_TTL_SECONDS,
): Promise<void> {
  const client = getRedis();
  if (client) {
    try {
      if (client.status === "wait") await client.connect();
      await client.set(key(userId), serialized, "EX", ttlSeconds);
      return;
    } catch {
      markRedisUnavailable();
    }
  }
  memoryStore.set(key(userId), {
    value: serialized,
    expiresAtMs: Date.now() + ttlSeconds * 1000,
  });
}

/** Invalidate on every per-user state mutation so the bell reconciles
 *  immediately after read/unread/dismiss/snooze/bulk actions. */
export async function invalidateOperationsSummary(
  userId: string,
): Promise<void> {
  memoryStore.delete(key(userId));
  const client = getRedis();
  if (client) {
    try {
      if (client.status === "wait") await client.connect();
      await client.del(key(userId));
    } catch {
      markRedisUnavailable();
    }
  }
}
