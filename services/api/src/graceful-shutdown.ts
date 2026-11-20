/**
 * F-21 (Free-user audit, capacity) — drain the API on SIGTERM / SIGINT.
 *
 * The production API is ONE container recreated on every deploy
 * (scripts/deploy-prod-pull.sh: `compose up -d --no-deps proovra-api`), and the
 * compose file sets no `stop_grace_period`, so Docker sends SIGTERM and then
 * SIGKILL after its default 10 s. Nothing called `app.close()`: with the OTel
 * SDK bootstrapped its `process.once("SIGTERM")` listener kept the process
 * serving until the SIGKILL cut every in-flight request (a finalize that had
 * already spent its timestamp token among them); without it Node exited at
 * once. Fastify's own `close()` stops accepting connections and waits for the
 * requests in flight; then the pool this process owns is ended.
 *
 * The deadline is derived from that 10 s default, not tuned: the process exits
 * on its own before Docker kills it, so the exit code says whether it drained.
 */
import { markActiveReconciliationRunsInterrupted } from "@proovra/shared-runtime";

export const SHUTDOWN_DEADLINE_MS = 8_000;

/**
 * NEW-RG-22-8 (RG-22) — the API also holds reconciliation runs (workspace
 * operations, search reconcile). Like the worker (PRO-W2-09), a stopping API
 * closes every run it still holds as FAILED(interrupted_by_shutdown), so the
 * next replica's tick takes the slot at once instead of after the 5-minute
 * heartbeat staleness. Bounded so a dead database cannot spend the drain
 * budget; a failure is logged, never thrown (the staleness rule still frees
 * the slot).
 */
export const INTERRUPT_RUNS_BOUND_MS = 1_500;

async function interruptActiveRuns(app: DrainableServer, boundMs: number): Promise<void> {
  let timer: NodeJS.Timeout | null = null;
  const timedOut = Symbol("timed_out");
  try {
    const outcome = await Promise.race([
      markActiveReconciliationRunsInterrupted(),
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), boundMs);
        timer.unref?.();
      }),
    ]);
    if (outcome === timedOut) {
      app.log.warn({ boundMs }, "api.shutdown_runs_interrupt_timed_out");
    } else if (outcome > 0) {
      app.log.warn({ interrupted: outcome }, "api.shutdown_runs_interrupted");
    }
  } catch (err) {
    app.log.warn(
      { err: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) },
      "api.shutdown_runs_interrupt_failed",
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type DrainableServer = {
  close: () => Promise<unknown>;
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
};

export function installGracefulShutdown(
  app: DrainableServer,
  deps: {
    closePool: () => Promise<unknown>;
    /**
     * PRO-S1-02 — detached work that must finish on this pool (audit appends
     * started after their response). Awaited after the server stopped taking
     * requests and before the pool closes; it must bound itself.
     */
    drainBackground?: () => Promise<unknown>;
    /** Waits for telemetry's own flush (otel.ts) so exit does not cut it. */
    flushTelemetry?: () => Promise<unknown>;
    exit: (code: number) => void;
    on: (signal: "SIGTERM" | "SIGINT", handler: () => void) => void;
    deadlineMs?: number;
    /** Bound for closing the held reconciliation runs (NEW-RG-22-8). */
    interruptRunsBoundMs?: number;
  },
): { shutdown: (signal: string) => Promise<void> } {
  let draining: Promise<void> | null = null;
  const shutdown = (signal: string): Promise<void> => {
    if (draining) return draining;
    app.log.info({ signal }, "api.shutdown_started");
    const deadline = setTimeout(() => {
      app.log.warn({ signal, deadlineMs: deps.deadlineMs ?? SHUTDOWN_DEADLINE_MS }, "api.shutdown_deadline_exceeded");
      deps.exit(1);
    }, deps.deadlineMs ?? SHUTDOWN_DEADLINE_MS);
    deadline.unref?.();
    draining = app
      .close()
      .then(() => (deps.drainBackground ? deps.drainBackground() : undefined))
      .then(() => interruptActiveRuns(app, deps.interruptRunsBoundMs ?? INTERRUPT_RUNS_BOUND_MS))
      .then(() => deps.closePool())
      .then(() => (deps.flushTelemetry ? deps.flushTelemetry() : undefined))
      .then(
        () => {
          clearTimeout(deadline);
          app.log.info({ signal }, "api.shutdown_drained");
          deps.exit(0);
        },
        (err: unknown) => {
          clearTimeout(deadline);
          app.log.warn({ signal, err: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) }, "api.shutdown_failed");
          deps.exit(1);
        },
      );
    return draining;
  };
  deps.on("SIGTERM", () => void shutdown("SIGTERM"));
  deps.on("SIGINT", () => void shutdown("SIGINT"));
  return { shutdown };
}
