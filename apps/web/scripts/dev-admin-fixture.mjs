#!/usr/bin/env node
/**
 * RUN THE WEB APP AGAINST THE LOCAL ADMIN FIXTURE.
 *
 * =============================================================================
 * THE PROBLEM THIS SOLVES
 * =============================================================================
 * `apps/web/.env.local` points at Production. That is a developer's own file
 * and this script does not touch it — but it means `next dev` talks to
 * Production by default, which is why browser verification of the admin console
 * kept being deferred.
 *
 * `NEXT_PUBLIC_API_BASE` is INLINED AT COMPILE TIME. In `next dev` compilation
 * happens per request, so a value present in the process environment when the
 * server starts is the value the client bundle gets. Next's env loader does not
 * overwrite variables already set in `process.env`, so setting it here wins
 * over `.env.local` without editing it.
 *
 * =============================================================================
 * WHAT IT WILL NOT DO
 * =============================================================================
 * It refuses to start if the API base it was given is not localhost. The entire
 * point is to keep this process away from Production, and a typo in an override
 * would otherwise produce a browser session against real customer data while
 * looking exactly like a local one.
 *
 * It writes nothing. No .env file is created, modified or read for secrets.
 *
 * =============================================================================
 * USAGE
 * =============================================================================
 *   1. start Postgres and Redis, migrate and seed:
 *        docker exec <pg> psql -U <u> -d postgres -c 'CREATE DATABASE proovra_admin_fixture;'
 *        DATABASE_URL=…/proovra_admin_fixture pnpm --filter proovra-api exec prisma migrate deploy
 *        NODE_ENV=development DATABASE_URL=…/proovra_admin_fixture \
 *          pnpm --filter proovra-api exec tsx scripts/seed-admin-fixture.ts
 *
 *   2. start the API on 8081 with that DATABASE_URL.
 *
 *   3. node apps/web/scripts/dev-admin-fixture.mjs
 *
 * Override with `--api=http://localhost:PORT` and `--port=PORT`.
 */

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const API_BASE = arg("api", "http://localhost:8081");
const PORT = arg("port", "3200");

let host;
try {
  host = new URL(API_BASE).hostname;
} catch {
  console.error(`dev-admin-fixture: --api=${API_BASE} is not a URL.`);
  process.exit(2);
}

if (!["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(host)) {
  // The whole purpose is to stay away from Production. A typo here would put a
  // browser session on real customer data while looking local.
  console.error(
    `dev-admin-fixture: REFUSED — the API base must be localhost, got "${host}".`,
  );
  process.exit(2);
}

console.log(
  [
    "dev-admin-fixture",
    `  web  http://localhost:${PORT}`,
    `  api  ${API_BASE}`,
    "",
    "  .env.local is neither read for this override nor modified.",
    "",
  ].join("\n"),
);

// `shell: true` because on Windows the resolved binary is `npx.cmd`, and
// spawning a .cmd without a shell fails with EINVAL.
const child = spawn("npx", ["next", "dev", "-p", PORT], {
  cwd: WEB_ROOT,
  shell: true,
  stdio: "inherit",
  env: {
      ...process.env,
      NODE_ENV: "development",
      // Both spellings: the web reads NEXT_PUBLIC_API_BASE, and some server
      // paths read API_BASE_URL. Setting one and not the other produces a page
      // whose server half and client half disagree about where the API is.
      NEXT_PUBLIC_API_BASE: API_BASE,
      API_BASE_URL: API_BASE,
      NEXT_PUBLIC_WEB_BASE: `http://localhost:${PORT}`,
      NEXT_PUBLIC_APP_BASE: `http://localhost:${PORT}`,
  },
});

child.on("exit", (code) => process.exit(code ?? 0));
