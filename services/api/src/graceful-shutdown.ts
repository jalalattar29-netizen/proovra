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
export const SHUTDOWN_DEADLINE_MS = 8_000;

export type DrainableServer = {
  close: () => Promise<unknown>;
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
};

export function installGracefulShutdown(
  app: DrainableServer,
  deps: {
    closePool: () => Promise<unknown>;
    /** Waits for telemetry's own flush (otel.ts) so exit does not cut it. */
    flushTelemetry?: () => Promise<unknown>;
    exit: (code: number) => void;
    on: (signal: "SIGTERM" | "SIGINT", handler: () => void) => void;
    deadlineMs?: number;
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
