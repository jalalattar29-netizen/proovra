import "./env.js";
// Phase 31.22 — register the api's Prisma instance with the
// @proovra/shared-runtime registry BEFORE any service code runs.
import "./register-shared-runtime.js";
import { closeDatabasePool } from "./db.js";
import { installGracefulShutdown } from "./graceful-shutdown.js";
import { otelShutdownSettled } from "./observability/otel.js";
import { buildServer } from "./server.js";

const port = Number(process.env.PORT ?? 8081);

buildServer()
  .then(async (app) => {
    await app.listen({ port, host: "0.0.0.0" });
    // F-21 — drain in-flight requests before the container is replaced.
    installGracefulShutdown(app, {
      closePool: closeDatabasePool,
      flushTelemetry: otelShutdownSettled,
      exit: (code) => process.exit(code),
      on: (signal, handler) => process.once(signal, handler),
    });
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
