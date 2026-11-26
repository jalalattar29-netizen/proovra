import "./env.js";
// Phase 31.22 — register the api's Prisma instance with the
// @proovra/shared-runtime registry BEFORE any service code runs.
import "./register-shared-runtime.js";
import { closeDatabasePool } from "./db.js";
import { installGracefulShutdown, SHUTDOWN_DEADLINE_MS } from "./graceful-shutdown.js";
import { drainPendingAuditAppends } from "./services/audit/detached-audit-tracker.js";
import { otelShutdownSettled } from "./observability/otel.js";
import { buildServer } from "./server.js";
import { drainBackgroundWork, stopBackgroundWork } from "./runtime/background-work.js";

const port = Number(process.env.PORT ?? 8081);

buildServer()
  .then(async (app) => {
    await app.listen({ port, host: "0.0.0.0" });
    // F-21 — drain in-flight requests before the container is replaced.
    installGracefulShutdown(app, {
      closePool: closeDatabasePool,
      // PRO-S1-02 — audit appends still running get half the drain budget;
      // what is left is logged as lost, never silently cut.
      drainBackground: async () => {
        const result = await drainPendingAuditAppends(Math.floor(SHUTDOWN_DEADLINE_MS / 2));
        if (!result.drained) app.log.warn({ stillPending: result.stillPending }, "api.shutdown_audit_appends_cut");
      },
      flushTelemetry: otelShutdownSettled,
      backgroundWork: { stop: stopBackgroundWork, drain: drainBackgroundWork },
      exit: (code) => process.exit(code),
      on: (signal, handler) => process.once(signal, handler),
    });
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
