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
 *
 * An ISOLATED TEST STACK (E2E) loads nothing either — the same rule and the
 * same 2026-10-22 incident as services/api/src/env.ts: a developer `.env`
 * holds live credentials, and a test stack must never inherit them. And a
 * `.env` file never turns live email on for any process (refuseFileSourcedLiveEmail):
 * started from the repository root, this loader reads the root `.env`, which
 * carries NODE_ENV=production beside a live Resend key.
 */
type Env = Record<string, string | undefined>;

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

export type WorkerEnvFileLoad = {
  /** Paths that contributed at least one value, in load order. */
  loaded: string[];
  /** Set when a file supplied a variable that could turn live email on (names only). */
  emailLiveRefused: string | null;
};

/** Load the worker's `.env` files into `env`. */
export function loadWorkerEnvFiles(cwd: string, env: Env = process.env): WorkerEnvFileLoad {
  if ((env.PROOVRA_ENV_BOOTSTRAPPED ?? "").trim() === "1") return { loaded: [], emailLiveRefused: null };
  if (resolveTestStackIsolation(env).isolated) return { loaded: [], emailLiveRefused: null };
  const cwdEnv = resolve(cwd, ".env");
  const serviceEnv = resolve(cwd, "services/worker/.env");
  const candidates = serviceEnv !== cwdEnv ? [cwdEnv, serviceEnv] : [cwdEnv];
  // The transport the REAL environment asked for, before any file could add one.
  const realEmailTransport = env.EMAIL_TRANSPORT;
  const filled = new Set<string>();
  const loaded = candidates.filter((path) => loadEnvFile(path, env, filled));
  return { loaded, emailLiveRefused: refuseFileSourcedLiveEmail(env, filled, realEmailTransport) };
}

const workerEnvFileLoad = loadWorkerEnvFiles(process.cwd());
if (workerEnvFileLoad.emailLiveRefused) {
  // Said once, at boot, before any logger exists. Names only, never values.
  process.stderr.write(
    `[env] live email refused — ${workerEnvFileLoad.emailLiveRefused}; email is recorded. ` +
      "Set EMAIL_TRANSPORT=resend in the real environment to send.\n",
  );
}

/** How many `.env` files this worker read — reported in its isolation facts. */
export function getWorkerEnvFileLoad(): WorkerEnvFileLoad {
  return { loaded: [...workerEnvFileLoad.loaded], emailLiveRefused: workerEnvFileLoad.emailLiveRefused };
}
