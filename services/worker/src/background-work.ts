/**
 * THE WORKER'S SCHEDULED BACKGROUND WORK: one scope per run, tracked, drained.
 *
 * Every scheduler in index.ts runs its tick in the process's root context, so
 * all ticks shared one Sentry isolation scope: one sweep's breadcrumbs (S3
 * object keys, payment-provider calls, the Bitcoin RPC) were attached to another
 * sweep's events, and a tick's error carried a stale transaction name
 * (`GET /readyz` from the health probe). Each run now gets its OWN isolation
 * scope, starts with no breadcrumbs and is named `background.<operation>`
 * (Sentry alert audit, 2026-11-26).
 *
 * Runs are also tracked: once shutdown begins no new run starts, and the
 * shutdown waits (bounded) for the running ones before it closes the queues and
 * the Redis connection they use.
 */
import * as Sentry from "@sentry/node";

const running = new Set<Promise<unknown>>();
let stopping = false;

export function isBackgroundShutdown(): boolean {
  return stopping;
}

/**
 * Run one background operation in its own telemetry scope, tracked for the
 * shutdown drain. Resolves `undefined` without running once shutdown has begun.
 */
export function runBackgroundOperation<T>(name: string, fn: () => Promise<T> | T): Promise<T | undefined> {
  if (stopping) return Promise.resolve(undefined);
  const op = String(name).slice(0, 64);
  const run = Sentry.withIsolationScope(async (scope) => {
    scope.clearBreadcrumbs();
    scope.setTransactionName(`background.${op}`);
    scope.setTag("background_operation", op);
    return fn();
  });
  running.add(run);
  void run.then(
    () => running.delete(run),
    () => running.delete(run),
  );
  return run;
}

export function runningBackgroundOperations(): number {
  return running.size;
}

export function stopBackgroundWork(): void {
  stopping = true;
}

/** Wait for the runs in progress, at most `timeoutMs`. */
export async function drainBackgroundWork(timeoutMs: number): Promise<{ drained: boolean; stillRunning: number }> {
  stopBackgroundWork();
  if (running.size === 0) return { drained: true, stillRunning: 0 };
  let timer: NodeJS.Timeout | null = null;
  const timedOut = Symbol("timed_out");
  const outcome = await Promise.race([
    Promise.allSettled([...running]).then(() => "settled" as const),
    new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), Math.max(0, timeoutMs));
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (outcome === timedOut || running.size > 0) return { drained: false, stillRunning: running.size };
  return { drained: true, stillRunning: 0 };
}

/** Test seam. */
export function __resetBackgroundWorkForTests(): void {
  running.clear();
  stopping = false;
}
