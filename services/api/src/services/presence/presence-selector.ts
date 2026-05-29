/**
 * Phase O2.1 — Presence backend selector.
 *
 * Routes import `recordHeartbeatViaSelector` and
 * `listViewersAsyncViaSelector`. The selector dispatches to either
 * the in-memory implementation (`presence.service.ts`, Phase G3) or
 * the Redis-backed implementation (`redis-presence-backend.ts`).
 *
 * Selection rule:
 *
 *   * `PROOVRA_PRESENCE_BACKEND` unset OR `=memory` → in-memory.
 *   * `PROOVRA_PRESENCE_BACKEND=redis` AND `REDIS_URL` set → Redis.
 *   * `PROOVRA_PRESENCE_BACKEND=redis` AND `REDIS_URL` UNSET → log
 *     a warning at first call and degrade to in-memory.
 *
 * The Redis backend is constructed lazily on first call so test
 * harnesses that never exercise Redis paths don't pay the import
 * cost or the connect attempt.
 *
 * Best-effort: every backend method already handles its own errors.
 * The selector only swallows the construction failure path.
 */

import type IORedis from "ioredis";

import * as memoryService from "./presence.service.js";
import {
  type HeartbeatInput,
  type ListViewersInput,
  type PresenceBackend,
  type ViewerEntry,
} from "./presence-backend.js";
import { RedisPresenceBackend } from "./redis-presence-backend.js";

let cachedBackend: PresenceBackend | null = null;
let warnedAboutMissingRedisUrl = false;

function isRedisSelected(): boolean {
  return process.env.PROOVRA_PRESENCE_BACKEND?.trim().toLowerCase() === "redis";
}

async function buildRedisBackend(): Promise<PresenceBackend | null> {
  const url = process.env.REDIS_URL?.trim();
  if (!url) {
    if (!warnedAboutMissingRedisUrl) {
      warnedAboutMissingRedisUrl = true;
      // Bounded stdout warning — no PII, no URL leak.
      // eslint-disable-next-line no-console
      console.warn(
        "[presence] PROOVRA_PRESENCE_BACKEND=redis but REDIS_URL unset — degrading to in-memory",
      );
    }
    return null;
  }
  try {
    const { default: IORedisCtor } = await import("ioredis");
    const client = new IORedisCtor(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: null,
    });
    client.connect().catch(() => undefined);
    return new RedisPresenceBackend(client as IORedis);
  } catch {
    return null;
  }
}

// In-memory backend adapter — wraps the Phase G3 synchronous module so
// it satisfies the `PresenceBackend` async interface. Behaviour is
// 1:1 with `presence.service.ts`; only the signature changes.
const memoryBackend: PresenceBackend = {
  kind: "memory",
  async recordHeartbeat(input: HeartbeatInput): Promise<void> {
    memoryService.recordHeartbeat(input);
  },
  async listViewers(
    input: ListViewersInput,
  ): Promise<ReadonlyArray<ViewerEntry>> {
    return memoryService.listViewers(input);
  },
  async __resetForTests(): Promise<void> {
    memoryService._resetPresenceStoreForTests();
  },
};

async function getBackend(): Promise<PresenceBackend> {
  if (cachedBackend) return cachedBackend;
  if (isRedisSelected()) {
    const redis = await buildRedisBackend();
    if (redis) {
      cachedBackend = redis;
      return redis;
    }
  }
  cachedBackend = memoryBackend;
  return memoryBackend;
}

/** Fire-and-forget heartbeat write. Best-effort. */
export function recordHeartbeatViaSelector(input: HeartbeatInput): void {
  void getBackend()
    .then((b) => b.recordHeartbeat(input))
    .catch(() => undefined);
}

/** Async viewer listing — works with either backend. */
export async function listViewersAsyncViaSelector(
  input: ListViewersInput,
): Promise<ReadonlyArray<ViewerEntry>> {
  try {
    const b = await getBackend();
    return b.listViewers(input);
  } catch {
    return [];
  }
}

/** Test-only: which backend is currently cached. */
export function __currentSelectorBackendKind():
  | "memory"
  | "redis"
  | "uninitialized" {
  return cachedBackend?.kind ?? "uninitialized";
}

/** Test-only: clear the cached backend (re-selects on next call). */
export function __resetSelectorForTests(): void {
  cachedBackend = null;
  warnedAboutMissingRedisUrl = false;
}

/** Test-only: inject a backend (e.g., a mocked Redis backend). */
export function __setSelectorBackendForTests(backend: PresenceBackend): void {
  cachedBackend = backend;
}
