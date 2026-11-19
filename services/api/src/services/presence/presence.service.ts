/**
 * Phase G3 — In-process presence tracker.
 *
 * Polling-based, single-instance, best-effort presence for the
 * "currently viewing this resource" UX. Operators heartbeat every
 * 30 seconds while a tab is open; the service evicts heartbeats
 * older than 90 seconds (3 missed beats). No persistence — when the
 * process restarts, presence resets cleanly.
 *
 * Hard rules:
 *
 *   * Workspace-scoped. Every read narrows by `teamId` so a viewer
 *     in a different workspace can never appear on the wrong
 *     resource even when the resource ids happen to collide.
 *   * Bounded payload. Each entry is `{ userId, displayName,
 *     lastSeenAtUtc }` — no IP, no device, no precise location, no
 *     route history.
 *   * Best-effort only. Presence is operational awareness, not an
 *     authorization signal — every mutation still goes through the
 *     audited backend path.
 *   * No realtime channels. The frontend polls
 *     `GET /v1/me/presence/here?teamId&resourceKind&resourceId` on
 *     a slow cadence (30s).
 *   * No persistence. Restart = clean slate. Operators can refresh
 *     the page to re-establish their own heartbeat.
 *
 * The whole module is a deliberate ~120-line single-instance map.
 * If PROOVRA needs cross-instance presence later, the contract here
 * is the smallest surface to swap for a Redis-backed implementation.
 *
 * Phase O2.1 update: a real Redis-backed alternative now ships in
 * `redis-presence-backend.ts`, selectable via
 * `PROOVRA_PRESENCE_BACKEND=redis` (see
 * `docs/operations/phase-o2-1-redis-shared-presence.md`). The in-memory
 * implementation below remains the default and is unchanged from
 * Phase G3 — operators opt into the Redis backend when the api scales
 * past a single instance.
 */

const HEARTBEAT_TTL_MS = 90 * 1000;
const MAX_VIEWERS_PER_KEY = 25;

type Key = string;
type Entry = {
  userId: string;
  displayName: string;
  lastSeenAtUtc: Date;
};

/**
 * PRO-K2-03 — a bound ACROSS keys, not only per key. A bucket nobody reads
 * again was never evicted (eviction ran only inside listViewers for the same
 * key), so distinct keys accumulated for the life of the process. Expired
 * entries are swept at most once per TTL window on write, and the number of
 * live keys is capped: past the cap the least recently refreshed keys go.
 */
const MAX_KEYS = 20_000;
let lastSweepAtMs = 0;

const store: Map<Key, Map<string, Entry>> = new Map();

function bucketNewestMs(bucket: Map<string, Entry>): number {
  let newest = 0;
  for (const entry of bucket.values()) newest = Math.max(newest, entry.lastSeenAtUtc.getTime());
  return newest;
}

function sweepExpired(nowMs: number): void {
  lastSweepAtMs = nowMs;
  for (const [k, bucket] of store) {
    for (const [userId, entry] of bucket) {
      if (nowMs - entry.lastSeenAtUtc.getTime() > HEARTBEAT_TTL_MS) bucket.delete(userId);
    }
    if (bucket.size === 0) store.delete(k);
  }
}

function enforceKeyBound(nowMs: number): void {
  if (nowMs - lastSweepAtMs > HEARTBEAT_TTL_MS) sweepExpired(nowMs);
  if (store.size <= MAX_KEYS) return;
  sweepExpired(nowMs);
  if (store.size <= MAX_KEYS) return;
  const byAge = Array.from(store.entries())
    .map(([k, bucket]) => [k, bucketNewestMs(bucket)] as const)
    .sort((a, b) => a[1] - b[1]);
  // Trim to 90% so a sustained flood pays the sort once per 2,000 new keys.
  const target = Math.floor(MAX_KEYS * 0.9);
  for (let i = 0; i < byAge.length && store.size > target; i++) store.delete(byAge[i]![0]);
}

function key(teamId: string, resourceKind: string, resourceId: string): Key {
  return `${teamId}|${resourceKind}|${resourceId}`;
}

/**
 * Record (or refresh) the caller's heartbeat against a resource.
 * The TTL window starts at the call time.
 */
export function recordHeartbeat(input: {
  teamId: string;
  resourceKind: string;
  resourceId: string;
  userId: string;
  displayName: string;
}): void {
  const k = key(input.teamId, input.resourceKind, input.resourceId);
  let bucket = store.get(k);
  if (!bucket) {
    bucket = new Map();
    store.set(k, bucket);
    enforceKeyBound(Date.now());
    // The bound may have trimmed this new (empty, so "oldest") bucket.
    if (!store.has(k)) store.set(k, bucket);
  }
  bucket.set(input.userId, {
    userId: input.userId,
    displayName: input.displayName,
    lastSeenAtUtc: new Date(),
  });
  // Defensive eviction — if the bucket overflows the bound (which
  // would require >25 reviewers on one resource), drop the oldest.
  if (bucket.size > MAX_VIEWERS_PER_KEY) {
    const entries = Array.from(bucket.entries()).sort(
      (a, b) =>
        a[1].lastSeenAtUtc.getTime() - b[1].lastSeenAtUtc.getTime(),
    );
    const toRemove = bucket.size - MAX_VIEWERS_PER_KEY;
    for (let i = 0; i < toRemove; i++) {
      bucket.delete(entries[i]![0]);
    }
  }
}

/**
 * Return the active viewers for a resource, excluding the caller.
 * Entries older than HEARTBEAT_TTL_MS are evicted at read time so the
 * caller never sees a stale list.
 */
export function listViewers(input: {
  teamId: string;
  resourceKind: string;
  resourceId: string;
  excludeUserId: string;
}): ReadonlyArray<{
  userId: string;
  displayName: string;
  lastSeenAtUtc: string;
}> {
  const k = key(input.teamId, input.resourceKind, input.resourceId);
  const bucket = store.get(k);
  if (!bucket) return [];
  const now = Date.now();
  const out: Array<{
    userId: string;
    displayName: string;
    lastSeenAtUtc: string;
  }> = [];
  for (const [userId, entry] of bucket) {
    if (now - entry.lastSeenAtUtc.getTime() > HEARTBEAT_TTL_MS) {
      bucket.delete(userId);
      continue;
    }
    if (userId === input.excludeUserId) continue;
    out.push({
      userId: entry.userId,
      displayName: entry.displayName,
      lastSeenAtUtc: entry.lastSeenAtUtc.toISOString(),
    });
  }
  if (bucket.size === 0) store.delete(k);
  return out;
}

/**
 * Test-only: clear the in-process store. Wired in `vitest` setup so
 * each test starts with a clean slate without restarting the process.
 */
export function _resetPresenceStoreForTests(): void {
  store.clear();
  lastSweepAtMs = 0;
}

/** Test-only: the number of live presence keys (PRO-K2-03 bound). */
export function _presenceKeyCountForTests(): number {
  return store.size;
}
export const PRESENCE_MAX_KEYS = MAX_KEYS;

/** Test-only: surface internal bound for assertion. */
export const PRESENCE_HEARTBEAT_TTL_MS = HEARTBEAT_TTL_MS;
export const PRESENCE_MAX_VIEWERS_PER_KEY = MAX_VIEWERS_PER_KEY;
