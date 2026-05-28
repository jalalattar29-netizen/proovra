/**
 * Phase P2.0B — Worker OpenTelemetry bootstrap (side-effect import).
 *
 * Imported FIRST by `services/worker/src/index.ts` so the OTEL SDK
 * patches Node's built-in `http`, `ioredis`, and `pg` modules before
 * BullMQ / Prisma load them. No-op when OTEL_ENABLED is not "true".
 *
 * Service-name resolution: the worker container sets
 * `OTEL_SERVICE_NAME=proovra-worker` in docker-compose.prod.yml.
 * The fallback default is the same string, so even a misconfigured
 * deployment still groups worker telemetry separately from the api.
 */

import { initOpenTelemetry } from "./otel.js";

function consoleLog(obj: Record<string, unknown>, msg: string): void {
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
  defaultServiceName: "proovra-worker",
  log: { info: consoleLog, warn: consoleWarn },
});
