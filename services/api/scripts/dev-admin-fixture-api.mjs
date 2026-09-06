#!/usr/bin/env node
/**
 * RUN THE API AGAINST THE LOCAL FIXTURE.
 *
 * This is a launcher. It owns no policy: the environment comes from
 * `scripts/local-fixture-env`, which is the single canonical mechanism shared
 * by every fixture launcher (API, Worker, Web) and by the isolation tests.
 *
 * An earlier version of this file carried its own deny-list. That was the
 * defect, not the fix — see the header of the shared module for why a
 * per-launcher list of blanked variables cannot work, and what it missed.
 *
 * Usage:
 *   node services/api/scripts/dev-admin-fixture-api.mjs
 *   node services/api/scripts/dev-admin-fixture-api.mjs --api-port=8191 \
 *     --database-url=postgresql://pv:pv@localhost:55533/proovra_admin_cp
 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildLocalFixtureEnv,
  describeLocalFixtureEnv,
  LOCAL_FIXTURE_DEFAULTS,
  UnsafeFixtureEnvironmentError,
} from "../../../scripts/local-fixture-env/index.mjs";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

let env;
try {
  env = buildLocalFixtureEnv({
    apiPort: arg("api-port", LOCAL_FIXTURE_DEFAULTS.apiPort),
    webPort: arg("web-port", LOCAL_FIXTURE_DEFAULTS.webPort),
    databaseUrl: arg("database-url", LOCAL_FIXTURE_DEFAULTS.databaseUrl),
    redisUrl: arg("redis-url", LOCAL_FIXTURE_DEFAULTS.redisUrl),
    allow: arg("allow", "").split(",").map((s) => s.trim()).filter(Boolean),
    /**
     * Let the local stack host the Playwright E2E suites.
     *
     * The point7 project asks the API for its rate-limit reset endpoint before
     * it does anything else, and that endpoint only registers when a bypass
     * secret is configured — so without this the whole browser suite fails at
     * the first fixture call, on a stack that is otherwise ready to serve it.
     *
     * This is a TEST-ONLY variable with three independent kill switches in the
     * API itself: it is ignored under `NODE_ENV=production`, ignored when
     * shorter than 32 characters, and ignored without the matching request
     * header. It is generated per run and exists only in the child process, so
     * it is not a secret that can leak into anything durable — and it only
     * ever bypasses a RATE LIMIT, never authentication.
     */
    extra: {
      E2E_AUTH_BYPASS_SECRET:
        process.env.E2E_AUTH_BYPASS_SECRET ??
        `local-fixture-e2e-${randomUUID().replace(/-/g, "")}`,
    },
  });
} catch (err) {
  console.error(
    err instanceof UnsafeFixtureEnvironmentError
      ? `dev-admin-fixture-api: REFUSED — ${err.message}`
      : `dev-admin-fixture-api: ${err.message}`,
  );
  process.exit(2);
}

const TSX = resolve(API_ROOT, "node_modules/.bin/tsx");
if (!existsSync(TSX) && !existsSync(`${TSX}.cmd`)) {
  console.error(`dev-admin-fixture-api: tsx not found at ${TSX}`);
  process.exit(2);
}

console.log(
  [
    "dev-admin-fixture-api",
    `  api         http://localhost:${env.PORT}`,
    describeLocalFixtureEnv(env),
    "",
    "  services/api/.env is neither read for these values nor modified.",
    "",
  ].join("\n"),
);

const child = spawn(TSX, ["src/index.ts"], {
  cwd: API_ROOT,
  shell: true,
  stdio: "inherit",
  env,
});
child.on("exit", (code) => process.exit(code ?? 0));
