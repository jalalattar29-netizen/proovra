/**
 * THE API'S SCHEDULED BACKGROUND WORK: one scope per run, tracked, drained.
 *
 * Two production defects meet here (Sentry alert audit, 2026-11-26):
 *
 *   1. TELEMETRY. A scheduled sweep runs in the process's root context, so every
 *      sweep shared one Sentry isolation scope: one sweep's breadcrumbs (S3 object
 *      keys, payment-provider calls) were attached to another's events, and a
 *      sweep's error carried whatever transaction name was last set
 *      (`GET /readyz`). Each run now gets its OWN isolation scope, starts with no
 *      breadcrumbs and is named `background.<operation>`.
 *
 *   2. SHUTDOWN. The drain cleared the sweeps' timers but did not wait for a run
 *      already in progress, then closed the database pool under it: on
 *      2026-11-26 10:14:18Z four platform-maintenance steps queried a closed pool.
 *      Runs are now tracked; once shutdown begins no new run starts, a running
 *      sweep can ask `isBackgroundShutdown()` between steps, and the shutdown
 *      waits for the running ones (bounded) before it closes the pool.
 */
import * as Sentry from "@sentry/node";

const running = new Set<Promise<unknown>>();
let stopping = false;

/** True once shutdown has begun: no new background run starts. */
export function isBackgroundShutdown(): boolean {
  return stopping;
}

/**
 * Run one background operation in its own telemetry scope, tracked for the
 * shutdown drain. Resolves `undefined` without running when shutdown has begun.
 */
export function runBackgroundOperation<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (stopping) return Promise.resolve(undefined);
  const op = String(name).slice(0, 64);
  const run = Sentry.withIsolationScope((scope) => {
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

/** The number of background runs in progress. */
export function runningBackgroundOperations(): number {
  return running.size;
}

/** Shutdown has begun: refuse new runs. Idempotent. */
export function stopBackgroundWork(): void {
  stopping = true;
}

/**
 * Wait for the runs in progress, at most `timeoutMs`. `drained: false` means
 * something is still running and the caller must NOT close what it uses.
 */
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
