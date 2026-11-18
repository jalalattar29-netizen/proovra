/**
 * PRO-S1-06 / PRO-W2-11 — THE WORKER'S SHUTDOWN IS BOUNDED AND VISIBLE.
 *
 * `shutdown()` stops every scheduler and then awaits each BullMQ consumer's
 * `close()`, which waits for its active jobs with no bound. A shutdown started
 * by an unhandled rejection or uncaught exception (not by the container
 * runtime, whose SIGKILL bounds SIGTERM) could therefore wait forever on one
 * hung job: every scheduler stopped, no exit for the supervisor to restart,
 * and `/readyz` still green because it never looked at shutdown.
 *
 * Two facts live here so the health server can read them without importing
 * the entry module:
 *   - the process is shutting down (readiness answers 503 from that moment);
 *   - a hard deadline, armed when shutdown starts, that exits the process
 *     (exit code 1 unless shutdown asked for another non-zero code) if the
 *     drain has not finished. The timer is unref'd, so it never keeps an
 *     otherwise finished process alive.
 *
 * The deadline (WORKER_SHUTDOWN_DEADLINE_MS, default 120 s) is the bound on
 * draining active jobs; the production compose `stop_grace_period` is set
 * above it so a SIGTERM drain ends by this deadline, not by SIGKILL.
 */
export { markActiveReconciliationRunsInterrupted } from "@proovra/shared-runtime";

export const DEFAULT_WORKER_SHUTDOWN_DEADLINE_MS = 120_000;

let shuttingDown = false;
let deadline: ReturnType<typeof setTimeout> | null = null;

export function workerShutdownDeadlineMs(): number {
  const raw = Number.parseInt(process.env.WORKER_SHUTDOWN_DEADLINE_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WORKER_SHUTDOWN_DEADLINE_MS;
}

export function isWorkerShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * Mark the process as shutting down and arm the hard deadline. Idempotent.
 * `onDeadline` runs (bounded by the caller) before `exit` when the deadline
 * passes — used to close this process's running sweep rows.
 */
export function beginWorkerShutdown(input: {
  exitCode: number;
  exit: (code: number) => void;
  onDeadline?: () => Promise<unknown>;
  log?: (obj: Record<string, unknown>, msg: string) => void;
  deadlineMs?: number;
}): void {
  if (shuttingDown) return;
  shuttingDown = true;
  const ms = input.deadlineMs ?? workerShutdownDeadlineMs();
  deadline = setTimeout(() => {
    input.log?.({ deadlineMs: ms, exitCode: input.exitCode }, "worker.shutdown_deadline_exceeded");
    const finish = () => input.exit(input.exitCode || 1);
    if (!input.onDeadline) return finish();
    // The finaliser gets a short bound of its own; exit happens regardless.
    const guard = setTimeout(finish, 2_000);
    guard.unref?.();
    void input.onDeadline().then(finish, finish);
  }, ms);
  deadline.unref?.();
}

/** Test seam. */
export function __resetWorkerShutdownStateForTests(): void {
  shuttingDown = false;
  if (deadline) clearTimeout(deadline);
  deadline = null;
}
