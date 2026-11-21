/**
 * OPS outage watchdog (2026-11-21) — WHAT A WORKER SAYS ABOUT ITS OWN BOOTS.
 *
 * In production the worker crash-looped for ~25 h (306 restarts): each start
 * reached the schema-head gate, found the database behind its build
 * (HEAD_NOT_APPLIED) and exited. It did so BEFORE it registered a lease or
 * wrote a heartbeat, so the only evidence was the container's own log, and
 * nothing alerted.
 *
 * These two records are written to the shared Redis at the earliest point a
 * worker can write anything, and the API's outage watchdog reads them:
 *
 *   recordWorkerBoot       one member per process start in a 24 h sorted set,
 *                          so N starts within an hour is a restart loop;
 *   recordSchemaRefusal    the newest refusal and its reason (kind + expected
 *                          head), so the alert says WHY, not merely "down";
 *   clearSchemaRefusal     a worker whose head is current removes it.
 *
 * Every call is best-effort and bounded: a Redis that cannot be reached must
 * never stop or delay a worker that is otherwise able to start, and a refusing
 * worker still exits. Nothing secret is written (ids, kinds, a migration name).
 */
import {
  OPS_WORKER_BOOT_EVENTS_KEY,
  OPS_WORKER_SCHEMA_REFUSAL_KEY,
} from "@proovra/shared";

/** The narrow Redis surface used here (ioredis-compatible). */
export type BootSignalRedis = {
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zremrangebyscore(key: string, min: number | string, max: number | string): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
};

export const BOOT_EVENTS_RETAIN_MS = 24 * 3600 * 1000;
const KEY_TTL_SECONDS = 2 * 24 * 3600;
const SIGNAL_TIMEOUT_MS = 3_000;

async function bounded(work: Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), SIGNAL_TIMEOUT_MS);
      timer.unref?.();
    });
    const outcome = await Promise.race([work.then(() => "ok" as const), timeout]);
    return outcome === "ok";
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function recordWorkerBoot(
  redis: BootSignalRedis,
  input: { workerId: string; pid: number; nowMs?: number },
): Promise<boolean> {
  const now = input.nowMs ?? Date.now();
  const member = `${input.workerId.slice(0, 120)}|${input.pid}|${now}`;
  return bounded(
    (async () => {
      await redis.zadd(OPS_WORKER_BOOT_EVENTS_KEY, now, member);
      await redis.zremrangebyscore(OPS_WORKER_BOOT_EVENTS_KEY, "-inf", now - BOOT_EVENTS_RETAIN_MS);
      await redis.expire(OPS_WORKER_BOOT_EVENTS_KEY, KEY_TTL_SECONDS);
    })(),
  );
}

export type SchemaRefusalRecord = {
  kind: string;
  expected: string;
  workerId: string;
  atMs: number;
};

export async function recordSchemaRefusal(
  redis: BootSignalRedis,
  input: { kind: string; expected: string; workerId: string; nowMs?: number },
): Promise<boolean> {
  const record: SchemaRefusalRecord = {
    kind: input.kind.slice(0, 40),
    expected: input.expected.slice(0, 160),
    workerId: input.workerId.slice(0, 120),
    atMs: input.nowMs ?? Date.now(),
  };
  return bounded(redis.set(OPS_WORKER_SCHEMA_REFUSAL_KEY, JSON.stringify(record), "EX", KEY_TTL_SECONDS));
}

export async function clearSchemaRefusal(redis: BootSignalRedis): Promise<boolean> {
  return bounded(redis.del(OPS_WORKER_SCHEMA_REFUSAL_KEY));
}
