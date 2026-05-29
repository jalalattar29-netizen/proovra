/**
 * Phase O2.1 — Redis-backed presence backend.
 *
 * Uses the same single-Redis instance that BullMQ + rate-limit already
 * depend on. NO Redis Cluster requirement. Works against any single-
 * node ioredis-compatible endpoint.
 *
 * Data model — one Redis HASH per (teamId, resourceKind, resourceId):
 *
 *   key:   `proovra:presence:{teamId}:{resourceKind}:{resourceId}`
 *   field: `userId`
 *   value: JSON {"displayName": "...", "tMs": 1700000000000}
 *
 * The hash key carries a Redis TTL = `HEARTBEAT_TTL_MS * 2` so an
 * abandoned resource auto-cleans even if no reader ever calls
 * `listViewers`. On each read we additionally evict any field whose
 * `tMs` is older than `now - HEARTBEAT_TTL_MS` (defensive — Redis TTL
 * is a coarser bound).
 *
 * Hard rules:
 *
 *   * Bounded payload: every value is `{displayName: string, tMs:
 *     number}` — NEVER IP / device / location / route.
 *   * Best-effort: every Redis error is caught and the call resolves
 *     to a no-op (recordHeartbeat) or empty list (listViewers). The
 *     `PROOVRA_PRESENCE_BACKEND` env stays `redis`, but a failed
 *     backend is operationally identical to "everyone is alone" —
 *     not a hard outage.
 *   * No PII in the key — `userId` and `teamId` are uuids; the
 *     `displayName` lives inside the value JSON, not the key.
 *   * Bounded fan-out: HLEN-checked before HSET; over-bound writes
 *     evict the oldest field (lowest `tMs`).
 */

import type IORedis from "ioredis";

import {
  buildPresenceKey,
  PRESENCE_HEARTBEAT_TTL_MS,
  PRESENCE_MAX_VIEWERS_PER_KEY,
  type HeartbeatInput,
  type ListViewersInput,
  type PresenceBackend,
  type ViewerEntry,
} from "./presence-backend.js";

const REDIS_KEY_PREFIX = "proovra:presence:";
// Hash key TTL — 2× heartbeat TTL so empty / abandoned resources
// drop out without requiring an explicit sweeper.
const HASH_KEY_TTL_SEC = Math.ceil((PRESENCE_HEARTBEAT_TTL_MS * 2) / 1000);

type FieldValue = {
  displayName: string;
  tMs: number;
};

function hashKey(
  teamId: string,
  resourceKind: string,
  resourceId: string,
): string {
  // We pipe-join via buildPresenceKey for parity with the in-memory
  // backend and then colon-join with the prefix.
  return REDIS_KEY_PREFIX + buildPresenceKey(teamId, resourceKind, resourceId);
}

function parseFieldValue(raw: string | undefined | null): FieldValue | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<FieldValue>;
    if (typeof parsed.displayName !== "string") return null;
    if (typeof parsed.tMs !== "number" || !Number.isFinite(parsed.tMs)) {
      return null;
    }
    return { displayName: parsed.displayName, tMs: parsed.tMs };
  } catch {
    return null;
  }
}

export class RedisPresenceBackend implements PresenceBackend {
  readonly kind = "redis" as const;
  constructor(private readonly redis: IORedis) {}

  async recordHeartbeat(input: HeartbeatInput): Promise<void> {
    const key = hashKey(input.teamId, input.resourceKind, input.resourceId);
    const value: FieldValue = {
      displayName: input.displayName,
      tMs: Date.now(),
    };
    try {
      // HSET upserts; EXPIRE refreshes the TTL window. We don't use a
      // MULTI/EXEC pipeline here because a partial failure (HSET but
      // not EXPIRE) is harmless — the next heartbeat refreshes EXPIRE,
      // and stale-eviction at read time still cleans field-level rot.
      await this.redis.hset(key, input.userId, JSON.stringify(value));
      await this.redis.expire(key, HASH_KEY_TTL_SEC);

      // Defensive over-bound eviction. HLEN is O(1); we only walk the
      // hash when over the bound so steady state stays fast.
      const len = await this.redis.hlen(key);
      if (len > PRESENCE_MAX_VIEWERS_PER_KEY) {
        const all = await this.redis.hgetall(key);
        const entries = Object.entries(all)
          .map(([userId, raw]) => [userId, parseFieldValue(raw)] as const)
          .filter((e): e is readonly [string, FieldValue] => e[1] !== null)
          .sort((a, b) => a[1].tMs - b[1].tMs);
        const toRemove = entries.length - PRESENCE_MAX_VIEWERS_PER_KEY;
        if (toRemove > 0) {
          const fields = entries.slice(0, toRemove).map(([userId]) => userId);
          await this.redis.hdel(key, ...fields);
        }
      }
    } catch {
      // Best-effort. Presence failure is acceptable; the page polls
      // again in 30 seconds.
    }
  }

  async listViewers(
    input: ListViewersInput,
  ): Promise<ReadonlyArray<ViewerEntry>> {
    const key = hashKey(input.teamId, input.resourceKind, input.resourceId);
    try {
      const all = await this.redis.hgetall(key);
      if (!all || Object.keys(all).length === 0) return [];
      const now = Date.now();
      const cutoff = now - PRESENCE_HEARTBEAT_TTL_MS;
      const out: ViewerEntry[] = [];
      const staleFields: string[] = [];
      for (const [userId, raw] of Object.entries(all)) {
        const parsed = parseFieldValue(raw);
        if (!parsed) {
          staleFields.push(userId);
          continue;
        }
        if (parsed.tMs < cutoff) {
          staleFields.push(userId);
          continue;
        }
        if (userId === input.excludeUserId) continue;
        out.push({
          userId,
          displayName: parsed.displayName,
          lastSeenAtUtc: new Date(parsed.tMs).toISOString(),
        });
      }
      // Fire-and-forget cleanup of expired fields. Failure here is
      // harmless — the next heartbeat triggers HSET and the field gets
      // refreshed (or remains stale and the next list filters it again).
      if (staleFields.length > 0) {
        this.redis.hdel(key, ...staleFields).catch(() => undefined);
      }
      return out;
    } catch {
      // Best-effort — when Redis is unreachable, callers see an empty
      // list rather than an error.
      return [];
    }
  }

  async __resetForTests(): Promise<void> {
    try {
      // Drop every PROOVRA presence key. Tests run against a dedicated
      // Redis db or an isolated prefix; the SCAN scope is bounded by
      // our `proovra:presence:*` prefix so we cannot interfere with
      // other workloads sharing the connection.
      const stream = this.redis.scanStream({
        match: `${REDIS_KEY_PREFIX}*`,
        count: 100,
      });
      for await (const keys of stream) {
        const list = keys as string[];
        if (list.length > 0) await this.redis.del(...list);
      }
    } catch {
      // Tests that exercise this path must not crash on a Redis
      // outage; this hook is best-effort like the rest of the backend.
    }
  }
}
