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
 *   - Fail-CLOSED (AUD-50, 2026-10-20): if the lock cannot be read the tick
 *     is skipped. These reconcilers schedule destruction, flip retention and
 *     send notifications; "every replica runs it at once" is exactly the
 *     failure the lock exists to prevent, so an unreadable lock is not a
 *     licence to run. The next tick tries again.
 *   - Renewed lease (AUD-50): while the holder runs, the TTL is extended every
 *     third of it, so a run longer than the TTL is not joined by a second
 *     replica halfway through. A renewal that finds the lock lost is logged.
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

const RENEW_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";

const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export type CronLockOutcome<T> =
  | { ran: true; result: T }
  | { ran: false; reason: "held" }
  | { ran: false; reason: "lock_unavailable" };

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
    // Fail-closed (AUD-50): the tick is skipped, never run unlocked.
    logger.warn({ err, name }, "cron.lock.acquire_failed_skipped");
    return { ran: false, reason: "lock_unavailable" };
  }

  if (!acquired) {
    return { ran: false, reason: "held" };
  }

  const renewEveryMs = Math.max(1_000, Math.floor(ttlMs / 3));
  const renewal = setInterval(() => {
    void (async () => {
      try {
        const kept = await redisConnection.eval(RENEW_SCRIPT, 1, key, INSTANCE_ID, String(ttlMs));
        if (kept !== 1) logger.warn({ name }, "cron.lock.renewal_lost");
      } catch (err) {
        logger.warn({ err, name }, "cron.lock.renewal_failed");
      }
    })();
  }, renewEveryMs);
  renewal.unref?.();

  try {
    return { ran: true, result: await fn() };
  } finally {
    clearInterval(renewal);
    try {
      await redisConnection.eval(RELEASE_SCRIPT, 1, key, INSTANCE_ID);
    } catch {
      // The TTL will expire the lock; a release failure is non-fatal.
    }
  }
}
