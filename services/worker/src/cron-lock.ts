/**
 * Phase R10 (F12) — distributed cron lock.
 *
 * The worker's scheduled reconcilers guard against overlapping ticks with a
 * per-process boolean flag (`xRunning`). That prevents re-entrancy WITHIN a
 * single process but NOT across replicas: if two worker instances run, both
 * fire the same reconciler on every tick — double-scheduling destruction,
 * double-flipping SLA timers, double-sending notifications, etc.
 *
 * This adds a Redis-backed advisory lock (`SET key val NX PX ttl`) so only
 * ONE replica runs a given reconciler per tick. The boolean flag stays (it's
 * a cheap intra-process guard); this is the cross-process layer.
 *
 * Safety properties:
 *   - Atomic acquire via `SET ... NX PX` (no check-then-set race).
 *   - Fail-OPEN: if Redis is unavailable the reconciler still runs, degrading
 *     to the pre-R10 single-process behaviour — never worse than today.
 *   - Safe release: a Lua check-and-delete only releases the lock if THIS
 *     instance still holds it (never frees a lock a later tick re-acquired
 *     after TTL expiry).
 *   - TTL bounds a crashed holder: a replica that dies mid-run releases the
 *     lock automatically when the TTL lapses.
 */
import { randomUUID } from "node:crypto";

import { logger } from "./logger.js";
import { redisConnection } from "./queue.js";

/** Unique per worker-process lifetime — the lock's ownership token. */
const INSTANCE_ID = randomUUID();

/** Default lock TTL — longer than any reconciler tick, short enough that a
 *  crashed holder frees the lock promptly. */
export const DEFAULT_CRON_LOCK_TTL_MS = 10 * 60 * 1000;

const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export type CronLockOutcome<T> =
  | { ran: true; result: T }
  | { ran: false; reason: "held" };

/**
 * Run `fn` iff this replica can acquire the named cron lock. Returns
 * `{ ran: false, reason: "held" }` when another replica holds it this tick.
 */
export async function withCronLock<T>(
  name: string,
  fn: () => Promise<T>,
  ttlMs: number = DEFAULT_CRON_LOCK_TTL_MS,
): Promise<CronLockOutcome<T>> {
  const key = `cron:lock:${name}`;

  let acquired = false;
  try {
    const res = await redisConnection.set(key, INSTANCE_ID, "PX", ttlMs, "NX");
    acquired = res === "OK";
  } catch (err) {
    // Fail-open — never let a Redis blip stop reconciliation entirely.
    logger.warn({ err, name }, "cron.lock.acquire_failed_fail_open");
    return { ran: true, result: await fn() };
  }

  if (!acquired) {
    return { ran: false, reason: "held" };
  }

  try {
    return { ran: true, result: await fn() };
  } finally {
    try {
      await redisConnection.eval(RELEASE_SCRIPT, 1, key, INSTANCE_ID);
    } catch {
      // The TTL will expire the lock; a release failure is non-fatal.
    }
  }
}
