import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";


/**
 * PHASE 12 — POINT 7 (2026-08-05): a bootstrapped process loads NO env file.
 *
 * This loader is an ENTRYPOINT authority and it is correct for production and
 * staging. It was also the last leak into test processes: it fills any variable
 * that is currently `undefined`, and the test bootstrap works by DELETING the
 * dangerous ones — so importing anything in the server graph handed the
 * production Sentry DSN straight back, after the scrub, silently.
 *
 * The isolation canary caught exactly that: `SENTRY_DSN` was null after the
 * bootstrap and live again after `import("src/server.ts")`.
 *
 * `PROOVRA_ENV_BOOTSTRAPPED` is set only by the canonical test bootstrap. When
 * it is present, configuration has ALREADY been established deliberately and
 * this loader must not second-guess it. There is one authority per process.
 */
const ALREADY_BOOTSTRAPPED =
  (process.env.PROOVRA_ENV_BOOTSTRAPPED ?? "").trim() === "1";

function loadEnvFile(path: string) {
  if (ALREADY_BOOTSTRAPPED) return;
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const cwdEnv = resolve(process.cwd(), ".env");
const serviceEnv = resolve(process.cwd(), "services/worker/.env");

loadEnvFile(cwdEnv);
if (serviceEnv !== cwdEnv) {
  loadEnvFile(serviceEnv);
}
