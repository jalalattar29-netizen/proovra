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

/** Sweep only once the map is big enough for the scan to be worth doing. */
const MEMORY_PRUNE_THRESHOLD = 1_000;
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

/**
 * One entry per (user, workspace scope).
 *
 * The bell counts the ACTIVE workspace, and the Operations Center counts every
 * workspace the caller belongs to. Those are different numbers over different
 * populations, so they cannot share a cache entry — keyed only by user, a
 * workspace-scoped read would be served an all-workspaces count and the badge
 * would disagree with the list behind it.
 *
 * `null` is the all-workspaces scope and gets its own stable key rather than
 * being folded into a workspace's.
 */
function key(userId: string, workspaceId: string | null = null): string {
  return `${KEY_PREFIX}${userId}:${workspaceId ?? "all"}`;
}

/** Every scope key this process has written for a user, so invalidation can
 *  reach all of them without scanning Redis. */
const scopesByUser = new Map<string, Set<string>>();

function rememberScope(userId: string, workspaceId: string | null): void {
  let scopes = scopesByUser.get(userId);
  if (!scopes) {
    scopes = new Set<string>();
    scopesByUser.set(userId, scopes);
  }
  scopes.add(workspaceId ?? "all");
}

export async function getCachedOperationsSummary(
  userId: string,
  workspaceId: string | null = null,
): Promise<string | null> {
  const client = getRedis();
  if (client) {
    try {
      if (client.status === "wait") await client.connect();
      return await client.get(key(userId, workspaceId));
    } catch {
      markRedisUnavailable();
    }
  }
  const entry = memoryStore.get(key(userId, workspaceId));
  if (!entry) return null;
  if (entry.expiresAtMs <= Date.now()) {
    memoryStore.delete(key(userId, workspaceId));
    return null;
  }
  return entry.value;
}

export async function setCachedOperationsSummary(
  userId: string,
  serialized: string,
  workspaceId: string | null = null,
  ttlSeconds: number = OPERATIONS_SUMMARY_TTL_SECONDS,
): Promise<void> {
  /**
   * WRITE THROUGH, always.
   *
   * This used to write to Redis and RETURN, touching memory only when Redis
   * was already known-bad. So the two backends could disagree about a key that
   * had just been written: `set` landed in Redis, an `error`/`close` event then
   * tripped the 15s cooldown, and the very next `get` consulted a memory store
   * the value had never been written to and reported the entry ABSENT.
   *
   * The docstring above promises "an in-process Map fallback", and a fallback
   * that is empty precisely when it is reached is not one. A Redis blip should
   * cost a stale-but-bounded read, never a phantom miss.
   *
   * Consequences are contained: the entry still expires on the same TTL, `get`
   * still prefers Redis and still honours a genuine Redis MISS without falling
   * through (only an unavailable backend falls through), and `invalidate`
   * already deleted from both.
   */
  const expiresAtMs = Date.now() + ttlSeconds * 1000;
  rememberScope(userId, workspaceId);
  memoryStore.set(key(userId, workspaceId), { value: serialized, expiresAtMs });
  pruneExpired();

  const client = getRedis();
  if (client) {
    try {
      if (client.status === "wait") await client.connect();
      await client.set(key(userId, workspaceId), serialized, "EX", ttlSeconds);
    } catch {
      markRedisUnavailable();
    }
  }
}

/**
 * Writing through means memory now holds an entry per active user even while
 * Redis is healthy, and nothing else would ever evict it: entries were only
 * dropped when a later READ found them expired, and with Redis serving reads
 * that read never comes. Sweeping on write keeps the map bounded by the set of
 * users active within one TTL rather than by every user seen since boot.
 *
 * Only past-TTL entries are removed, so this can never evict a live value.
 */
function pruneExpired(): void {
  if (memoryStore.size <= MEMORY_PRUNE_THRESHOLD) return;
  const now = Date.now();
  for (const [k, entry] of memoryStore) {
    if (entry.expiresAtMs <= now) memoryStore.delete(k);
  }
}

/** Invalidate on every per-user state mutation so the bell reconciles
 *  immediately after read/unread/dismiss/snooze/bulk actions. */
export async function invalidateOperationsSummary(
  userId: string,
): Promise<void> {
  /**
   * EVERY SCOPE, not just the default one.
   *
   * A read/dismiss changes what the caller can see in the workspace the item
   * belongs to AND in the all-workspaces view, so clearing one key would leave
   * the other serving a count the mutation already invalidated. Scopes are
   * tracked as they are written rather than discovered by scanning Redis —
   * a `KEYS`/`SCAN` on every mutation is a far worse trade than a small map.
   */
  const scopes = new Set(scopesByUser.get(userId) ?? []);
  // Always clear the default, even if this process never wrote it: another
  // replica may have, and the delete is cheap.
  scopes.add("all");

  const keys = [...scopes].map((scope) =>
    key(userId, scope === "all" ? null : scope),
  );
  for (const k of keys) memoryStore.delete(k);
  scopesByUser.delete(userId);

  const client = getRedis();
  if (client) {
    try {
      if (client.status === "wait") await client.connect();
      await client.del(...keys);
    } catch {
      markRedisUnavailable();
    }
  }
}
