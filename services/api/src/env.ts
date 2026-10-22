import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  refuseFileSourcedLiveEmail,
  resolveTestStackIsolation,
} from "@proovra/shared-runtime/isolation";

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

type Env = Record<string, string | undefined>;

/**
 * Fill only UNSET keys of `env` from one dotenv-style file, recording each key
 * it filled in `filled`. True when it contributed.
 */
function loadEnvFile(path: string, env: Env, filled: Set<string>): boolean {
  if (!existsSync(path)) return false;
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
    if (env[key] === undefined) {
      env[key] = value;
      filled.add(key);
      contributed = true;
    }
  }
  return contributed;
}

export type EnvFileLoad = {
  /** Paths that contributed at least one value, in load order. */
  loaded: string[];
  /** Why nothing was read, when nothing was. */
  skipped: "bootstrapped" | "isolated-test-stack" | null;
  /**
   * Set when a file supplied a variable that could turn live email on, so the
   * transport was pinned to the recorder (variable names only). See
   * refuseFileSourcedLiveEmail in @proovra/shared-runtime/isolation.
   */
  emailLiveRefused: string | null;
};

/**
 * Load the API's `.env` files into `env`.
 *
 * ISOLATED TEST STACKS LOAD NOTHING (2026-10-22 incident). A stack started for
 * E2E carried only the variables it meant to set, and this loader filled the
 * rest from the developer's repo-root `.env` — a live Resend key among them —
 * so the run emailed real addresses. The decision is made from the REAL
 * environment, before any file is read, so a marker can be neither laundered
 * in nor removed through a `.env`. See @proovra/shared-runtime/isolation.
 */
export function loadEnvFiles(cwd: string, env: Env = process.env): EnvFileLoad {
  if ((env.PROOVRA_ENV_BOOTSTRAPPED ?? "").trim() === "1") return { loaded: [], skipped: "bootstrapped", emailLiveRefused: null };
  if (resolveTestStackIsolation(env).isolated) return { loaded: [], skipped: "isolated-test-stack", emailLiveRefused: null };

  const cwdEnv = resolve(cwd, ".env");
  const serviceEnv = resolve(cwd, "services/api/.env");
  // When cwd === services/api/, the canonical service env file is just
  // `<cwd>/.env` (already covered by cwdEnv), and the repo-root .env lives
  // two directories up. Load both so devs can split secrets between a
  // gitignored repo-root file and the service-scoped file.
  const repoRootEnv = resolve(cwd, "../../.env");

  // Precedence: first writer wins (loadEnvFile only sets undefined keys).
  // Service-local file wins over repo-root, matching the existing convention
  // where the service-scoped .env is the operator's primary surface.
  const candidates = [cwdEnv];
  if (serviceEnv !== cwdEnv) candidates.push(serviceEnv);
  if (repoRootEnv !== cwdEnv && repoRootEnv !== serviceEnv) candidates.push(repoRootEnv);
  const loaded: string[] = [];
  // The transport the REAL environment asked for, before any file could add one.
  const realEmailTransport = env.EMAIL_TRANSPORT;
  const filled = new Set<string>();
  for (const path of candidates) if (loadEnvFile(path, env, filled)) loaded.push(path);
  const emailLiveRefused = refuseFileSourcedLiveEmail(env, filled, realEmailTransport);
  return { loaded, skipped: null, emailLiveRefused };
}

// Tracks which .env file paths actually contributed values to process.env.
// Exposed (via getEnvSourceHint) to admin diagnostics so operators can tell
// whether the API process is reading the env file they think it is — the
// hint is the bare basename + parent directory (e.g. "services/api/.env"),
// never the full absolute path, and NEVER any variable value.
const envFileLoad = loadEnvFiles(process.cwd());
if (envFileLoad.emailLiveRefused) {
  // Said once, at boot, before any logger exists. Names only, never values.
  process.stderr.write(
    `[env] live email refused — ${envFileLoad.emailLiveRefused}; email is recorded. ` +
      "Set EMAIL_TRANSPORT=resend in the real environment to send.\n",
  );
}
const loadedEnvSources: string[] = envFileLoad.loaded;

/** Whether this process read `.env` files, and if not, why. Paths only, never values. */
export function getEnvFileLoad(): EnvFileLoad {
  return { loaded: [...envFileLoad.loaded], skipped: envFileLoad.skipped, emailLiveRefused: envFileLoad.emailLiveRefused };
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
