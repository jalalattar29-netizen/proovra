/**
 * Phase P2.0B — OpenTelemetry bootstrap (side-effect import).
 *
 * Imported FIRST by `services/api/src/server.ts` so the OTEL SDK
 * patches Node's built-in `http`, `ioredis`, and `pg` modules before
 * Fastify / Prisma / BullMQ load them. If OTEL_ENABLED is not "true"
 * this is a no-op — local dev / Docker are unaffected.
 *
 * Logging here is intentionally plain console.* — Fastify's logger
 * is not constructed yet, but this side-effect runs once at process
 * boot. The lines are bounded (service-name + namespace + environment
 * + version) and NEVER include the OTLP endpoint URL or headers.
 */

import { initOpenTelemetry } from "./otel.js";

function consoleLog(obj: Record<string, unknown>, msg: string): void {
  // Bounded JSON line. No secret-bearing field reaches this layer
  // because `initOpenTelemetry()` is the only caller and it scrubs
  // its own logged shape.
  try {
    process.stdout.write(
      JSON.stringify({ level: "info", msg, ...obj }) + "\n",
    );
  } catch {
    // ignore
  }
}

function consoleWarn(obj: Record<string, unknown>, msg: string): void {
  try {
    process.stderr.write(
      JSON.stringify({ level: "warn", msg, ...obj }) + "\n",
    );
  } catch {
    // ignore
  }
}

initOpenTelemetry({
  defaultServiceName: "proovra-api",
  log: { info: consoleLog, warn: consoleWarn },
});
