import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "./config.js";

/**
 * The connection pool's ceiling (CAP-9, capacity 2026-11-03). Unset keeps the
 * `pg` default of 10, which is what every deployment ran before this setting
 * existed. A value must be a whole number from 1 to 500; anything else stops the
 * process rather than guessing. The right production number depends on the
 * database's connection limit and pooler and is not chosen here
 * (docs/operations/capacity-measurements.md).
 */
export const DEFAULT_DATABASE_POOL_MAX = 10;

export function databasePoolMax(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_DATABASE_POOL_MAX;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1 || n > 500) {
    throw new Error("DATABASE_POOL_MAX must be a whole number from 1 to 500");
  }
  return n;
}

/**
 * B8-F-002 (free-audit 0ea0) — the worker pool's WAIT is bounded too. The F-08
 * hardening gave the API pool a connection timeout; the worker kept the `pg`
 * default 0 (wait for ever). Pool starvation (13 BullMQ slots + ~25 timers on
 * a default pool of 10, or one slow query holding connections) then stalled a
 * job silently: BullMQ keeps renewing the lock while the event loop lives, so
 * the attempt never failed, never retried, and the person's report stayed "in
 * progress" with no error. Now a query that cannot get a connection within the
 * bound throws (`timeout exceeded when trying to connect`), the attempt fails,
 * and the queue's canonical retry policy (attempts + backoff) applies; the
 * durable claim leases are unchanged. Unset = 30 s (worker attempts are not
 * interactive, so the bound is looser than the API's 10 s); `0` restores the
 * unbounded wait as an explicit choice; a value must be a whole number from 0
 * to 600000, anything else stops the process.
 *
 * The per-ATTEMPT wall-clock budget stays observed, not enforced (AUD-50,
 * RETRY_TIMEOUT_IS_ENFORCED=false): abandoning an attempt that may still be
 * writing would race the claim fences. Bounding every wait is the part that
 * turns starvation into a failure + retry without that race.
 */
export const DEFAULT_WORKER_DATABASE_POOL_CONNECTION_TIMEOUT_MS = 30_000;

export function databasePoolConnectionTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_WORKER_DATABASE_POOL_CONNECTION_TIMEOUT_MS;
  }
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 0 || n > 600_000) {
    throw new Error("DATABASE_POOL_CONNECTION_TIMEOUT_MS must be a whole number from 0 to 600000");
  }
  return n;
}

/** B8-F-002 — true when an error (or its cause chain) is a pool-wait timeout. */
export function isDatabasePoolTimeout(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    const message = String((e as { message?: unknown }).message ?? "");
    if (/timeout exceeded when trying to connect|Connection terminated due to connection timeout/i.test(message)) {
      return true;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * B8-F-002 — the headroom the pool needs: every BullMQ slot this process opens
 * plus the timers/reconcilers that share the pool. A pool smaller than this can
 * starve; the bounded wait above turns that into retries, and the startup log
 * (`worker.database_pool_below_concurrency`) says so before it happens.
 */
export function databasePoolHeadroomWarning(
  poolMax: number,
  totalConcurrency: number,
  sweepHeadroom = 4,
): { required: number; poolMax: number } | null {
  const required = totalConcurrency + sweepHeadroom;
  return poolMax < required ? { required, poolMax } : null;
}

const poolMax = databasePoolMax(process.env.DATABASE_POOL_MAX);
const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: poolMax,
  connectionTimeoutMillis: databasePoolConnectionTimeoutMs(
    process.env.DATABASE_POOL_CONNECTION_TIMEOUT_MS,
  ),
});

/** B8-F-002 — the pool's live counters (no identifiers) for logs and tests. */
export function databasePoolStats(): { max: number; totalCount: number; idleCount: number; waitingCount: number } {
  return {
    max: poolMax,
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  };
}
const adapter = new PrismaPg(pool);

export const prisma = new PrismaClient({ adapter });
