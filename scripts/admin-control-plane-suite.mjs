#!/usr/bin/env node
/**
 * RUN THE ADMIN CONTROL-PLANE SUITE, AND LEAVE NOTHING BEHIND.
 *
 * =============================================================================
 * WHY THIS EXISTS (ADM-P2-004)
 * =============================================================================
 * The suite needs four things running: PostgreSQL 16, Redis, the fixture API,
 * and the web tier. Playwright's `webServer` owns the web tier and tears it
 * down on its own — including when a test fails. Nothing owned the other three.
 *
 * They were started by hand, with `nohup`, and a failed run left them running.
 * That is not tidiness: a leftover fixture API holds the seeded database open,
 * a leftover container holds a port, and the NEXT run then either attaches to
 * state it did not create or fails to bind and reports it as a product problem.
 * A verification harness that leaks its own dependencies eventually verifies
 * the wrong thing.
 *
 * So this script owns the whole lifecycle. Every process and container it
 * starts is registered, and the teardown runs from a `finally` plus the signal
 * handlers — so it runs on success, on a failing test, on a thrown error, and
 * on Ctrl-C.
 *
 * =============================================================================
 * WHAT IT DOES NOT DO
 * =============================================================================
 * It does not touch anything it did not start. Containers are named with a
 * per-run suffix and removed by that name, so a concurrent session's stack on
 * this machine is never stopped — that has already happened once in this
 * repository and is worth not repeating.
 *
 * Usage:
 *   node scripts/admin-control-plane-suite.mjs
 *   node scripts/admin-control-plane-suite.mjs --grep "admin-states"
 *   node scripts/admin-control-plane-suite.mjs --keep      (leave the stack up)
 */

import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildLocalFixtureEnv,
  describeLocalFixtureEnv,
} from "./local-fixture-env/index.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const KEEP = process.argv.includes("--keep");
const GREP = arg("grep", null);

const TAG = arg("tag", "p10");
const PG_PORT = Number(arg("pg-port", 55610));
const REDIS_PORT = Number(arg("redis-port", 56610));
const API_PORT = Number(arg("api-port", 8291));
const WEB_PORT = Number(arg("web-port", 3311));

const PG_NAME = `pv-${TAG}-pg`;
const REDIS_NAME = `pv-${TAG}-redis`;
const DB = "proovra_admin_cp_fixture";
const DATABASE_URL = `postgresql://pv:pv@127.0.0.1:${PG_PORT}/${DB}`;
const REDIS_URL = `redis://127.0.0.1:${REDIS_PORT}/0`;
const API_BASE = `http://localhost:${API_PORT}`;
const WEB_BASE = `http://localhost:${WEB_PORT}`;

/**
 * THE CHILD ENVIRONMENT IS BUILT, NOT INHERITED.
 *
 * This script spawns docker, pnpm, prisma, the fixture API and Playwright.
 * The first version handed each of them `{ ...process.env }`, which is the
 * leak path this repository already has a guard for — and the guard caught
 * it (`apps/web/__tests__/local-fixture-env-isolation.test.mjs`), which is
 * the guard doing its job on the person who added the script.
 *
 * It matters here specifically: `services/api/.env` holds live Production
 * credentials on a developer machine, and anything in the ambient shell
 * flows into the API the suite then measures. A verification harness that
 * can reach Production is not a verification harness.
 *
 * `buildLocalFixtureEnv` is the one sanctioned mechanism: an OS baseline
 * plus named local values, nothing else, scanned for non-local endpoints and
 * credential shapes BEFORE the first child starts. It throws rather than
 * spawns if the result would carry a leak.
 */
const CHILD_ENV = buildLocalFixtureEnv({
  apiPort: String(API_PORT),
  webPort: String(WEB_PORT),
  databaseUrl: DATABASE_URL,
  redisUrl: REDIS_URL,
  extra: {
    // The suite and the launcher read these to agree on one origin; see the
    // refusal in apps/web/scripts/dev-admin-fixture.mjs.
    PROOVRA_FIXTURE_API_BASE: API_BASE,
    PROOVRA_FIXTURE_WEB_BASE: WEB_BASE,
    PROOVRA_FIXTURE_WEB_PORT: String(WEB_PORT),
  },
});

/** Everything this run created, newest first. Teardown walks it in order. */
const cleanups = [];
let tornDown = false;

function teardown(why) {
  if (tornDown) return;
  tornDown = true;
  console.log(`\n[suite] teardown (${why})`);
  for (const { label, fn } of cleanups.reverse()) {
    try {
      fn();
      console.log(`[suite]   stopped ${label}`);
    } catch (err) {
      // Report and keep going. One failed stop must not strand the rest.
      console.error(`[suite]   FAILED to stop ${label}: ${err?.message ?? err}`);
    }
  }
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    // `--keep` is honoured here too. A run killed by an outer `timeout` sends
    // SIGTERM, and tearing the stack down under someone who explicitly asked to
    // keep it destroys the state they wanted to inspect — which is the whole
    // reason to pass the flag.
    if (!KEEP) teardown(sig);
    else console.log(`\n[suite] ${sig} — --keep, leaving the stack up.`);
    process.exit(130);
  });
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: REPO,
    shell: true,
    stdio: opts.quiet ? "pipe" : "inherit",
    env: { ...CHILD_ENV, ...(opts.env ?? {}) },
    ...opts,
  });
  return r;
}

function mustRun(label, cmd, args, opts = {}) {
  console.log(`[suite] ${label}`);
  const r = run(cmd, args, opts);
  if (r.status !== 0) {
    throw new Error(`${label} failed (exit ${r.status})`);
  }
  return r;
}

async function waitFor(label, url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        console.log(`[suite] ${label} ready`);
        return;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${label} never became ready at ${url}`);
}

async function main() {
  // Say what the children will actually get. Never a value — the point is to
  // make the boundary auditable from the run log, not to print secrets.
  console.log("[suite] child environment:");
  console.log(describeLocalFixtureEnv(CHILD_ENV));

  // ---- 1. containers, named for THIS run --------------------------------
  run("docker", ["rm", "-f", PG_NAME, REDIS_NAME], { quiet: true });
  mustRun(
    "start PostgreSQL 16",
    "docker",
    [
      "run", "-d", "--name", PG_NAME,
      "-p", `127.0.0.1:${PG_PORT}:5432`,
      "-e", "POSTGRES_USER=pv", "-e", "POSTGRES_PASSWORD=pv", "-e", "POSTGRES_DB=pv_root",
      "pgvector/pgvector:pg16",
    ],
    { quiet: true },
  );
  cleanups.push({
    label: `container ${PG_NAME}`,
    fn: () => run("docker", ["rm", "-f", PG_NAME], { quiet: true }),
  });

  mustRun(
    "start Redis",
    "docker",
    ["run", "-d", "--name", REDIS_NAME, "-p", `127.0.0.1:${REDIS_PORT}:6379`, "redis:7-alpine"],
    { quiet: true },
  );
  cleanups.push({
    label: `container ${REDIS_NAME}`,
    fn: () => run("docker", ["rm", "-f", REDIS_NAME], { quiet: true }),
  });

  // Wait for the socket to accept, then create the fixture database.
  for (let i = 0; i < 60; i += 1) {
    const r = run("docker", ["exec", PG_NAME, "pg_isready", "-U", "pv"], { quiet: true });
    if (r.status === 0) break;
    await new Promise((r2) => setTimeout(r2, 1000));
  }
  mustRun(
    "create the fixture database",
    "docker",
    ["exec", PG_NAME, "psql", "-U", "pv", "-d", "pv_root", "-c", `"CREATE DATABASE ${DB};"`],
    { quiet: true },
  );

  // ---- 2. schema + fixture ----------------------------------------------
  mustRun("migrate", "pnpm", ["--filter", "proovra-api", "exec", "prisma", "migrate", "deploy"], {
    env: { DATABASE_URL, DIRECT_URL: DATABASE_URL },
  });
  mustRun(
    "seed the admin fixture",
    "pnpm",
    ["--filter", "proovra-api", "exec", "tsx", "scripts/seed-admin-fixture.ts"],
    { env: { DATABASE_URL, DIRECT_URL: DATABASE_URL, NODE_ENV: "development", LOG_LEVEL: "warn" } },
  );

  // ---- 3. the API --------------------------------------------------------
  console.log("[suite] start the fixture API");
  const api = spawn(
    "node",
    [
      "services/api/scripts/dev-admin-fixture-api.mjs",
      `--api-port=${API_PORT}`,
      `--database-url=${DATABASE_URL}`,
      `--redis-url=${REDIS_URL}`,
    ],
    // Explicit, not inherited. Omitting `env` hands the child the ambient
    // shell, which is the same leak by a quieter route.
    { cwd: REPO, shell: true, stdio: "inherit", env: CHILD_ENV },
  );
  cleanups.push({
    label: `fixture API (pid ${api.pid})`,
    fn: () => {
      // The launcher spawns tsx, so kill the TREE. Killing the launcher alone
      // leaves the server holding the port — which is how a "port in use"
      // failure gets misread as a product defect on the next run.
      if (process.platform === "win32") {
        run("taskkill", ["/PID", String(api.pid), "/T", "/F"], { quiet: true });
      } else {
        try { process.kill(-api.pid, "SIGTERM"); } catch { api.kill("SIGTERM"); }
      }
    },
  });
  await waitFor("fixture API", `${API_BASE}/healthz`, 180_000);

  // ---- 4. build the web tier ONCE ---------------------------------------
  // Playwright's `webServer` starts `next start` against this output; it does
  // not build. Building here keeps it to exactly one build per run.
  mustRun("build the web app (production, once)", "pnpm", ["-s", "test:e2e:admin:build"], {
    env: { PROOVRA_FIXTURE_API_BASE: API_BASE },
  });

  // ---- 5. the suite ------------------------------------------------------
  const args = ["-s", "test:e2e:admin"];
  if (GREP) args.push("--", "-g", JSON.stringify(GREP));
  console.log(`[suite] run${GREP ? ` (grep ${GREP})` : ""}`);
  const r = run("pnpm", args, {
    env: {
      PROOVRA_FIXTURE_WEB_BASE: WEB_BASE,
      PROOVRA_FIXTURE_WEB_PORT: String(WEB_PORT),
      PROOVRA_FIXTURE_API_BASE: API_BASE,
    },
  });
  return r.status ?? 1;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (err) {
  console.error(`[suite] ${err?.message ?? err}`);
  exitCode = 1;
} finally {
  if (KEEP) {
    console.log("\n[suite] --keep: leaving the stack up.");
  } else {
    teardown(exitCode === 0 ? "run finished" : "run failed");
  }
}
process.exit(exitCode);
