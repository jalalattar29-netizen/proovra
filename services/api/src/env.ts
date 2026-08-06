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


// Tracks which .env file paths actually contributed values to process.env.
// Exposed (via getEnvSourceHint) to admin diagnostics so operators can tell
// whether the API process is reading the env file they think it is — the
// hint is the bare basename + parent directory (e.g. "services/api/.env"),
// never the full absolute path, and NEVER any variable value.
const loadedEnvSources: string[] = [];

function loadEnvFile(path: string) {
  if (ALREADY_BOOTSTRAPPED) return;
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf8");
  let contributed = false;
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
      contributed = true;
    }
  }
  if (contributed) loadedEnvSources.push(path);
}



const cwdEnv = resolve(process.cwd(), ".env");
const serviceEnv = resolve(process.cwd(), "services/api/.env");
// When cwd === services/api/, the canonical service env file is just
// `<cwd>/.env` (already covered by cwdEnv), and the repo-root .env lives
// two directories up. Load both so devs can split secrets between a
// gitignored repo-root file and the service-scoped file.
const repoRootEnv = resolve(process.cwd(), "../../.env");

// Precedence: first writer wins (loadEnvFile only sets undefined keys).
// Service-local file wins over repo-root, matching the existing convention
// where the service-scoped .env is the operator's primary surface.
loadEnvFile(cwdEnv);
if (serviceEnv !== cwdEnv) {
  loadEnvFile(serviceEnv);
}
if (repoRootEnv !== cwdEnv && repoRootEnv !== serviceEnv) {
  loadEnvFile(repoRootEnv);
}

/**
 * Returns a non-sensitive hint string describing which .env files the
 * loader read values from. Safe to surface in admin diagnostics — only
 * paths, never values.
 *
 * Format: comma-separated relative-ish basenames, or "none" if no file
 * contributed (e.g. all values come from the real shell environment).
 */
export function getEnvSourceHint(): string {
  if (loadedEnvSources.length === 0) return "none";
  return loadedEnvSources
    .map((p) => {
      // Strip everything above the repo root for log-safety; keep at most
      // the last two path segments so operators can tell repo-root vs
      // services/api apart without leaking the developer's home dir.
      const parts = p.replace(/\\/g, "/").split("/");
      return parts.slice(-2).join("/");
    })
    .join(",");
}
