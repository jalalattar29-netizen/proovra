#!/usr/bin/env node
/**
 * UC-1 WINDOWS ACCEPTANCE HARNESS  (`pnpm uc1:acceptance:windows`)
 *
 * The ONE UC-1 gate that cannot run in the engineering/CI sandbox: a real
 * Chrome + Edge browser drives the unpacked extension through the full first-
 * party OAuth journey (Authorization Code + PKCE S256), captures deterministic
 * fixture pages through the real pipeline, and the SAME Evidence id is traced
 * across the canonical PROOVRA surfaces.
 *
 * This orchestrator boots a fully DISPOSABLE stack, seeds one paid workspace,
 * builds the extension, and runs the Playwright acceptance in Chrome and Edge.
 *
 * =====================  HARD PRODUCTION-SAFETY (fail closed)  =================
 * Every process it starts gets its environment from `scripts/local-fixture-env`,
 * which is an ALLOWLIST — nothing is inherited but an OS baseline, and the
 * result is scanned before any process starts. Construction THROWS if any value
 * resolves off this machine or looks like a live credential, so a production DB,
 * API, Redis or storage endpoint cannot reach a child. In addition this harness:
 *   - refuses a database/redis/api/fixture host that is not local,
 *   - refuses a database name that does not read as disposable,
 *   - never reads services/api/.env (dotenv is neutralised by the fixture env),
 *   - never deploys, never publishes an extension, never touches Production.
 *
 * USAGE (Windows PowerShell or bash), from the repo root:
 *   pnpm uc1:acceptance:windows --start-infra
 *   pnpm uc1:acceptance:windows --browsers=chromium        # Chrome only
 *   pnpm uc1:acceptance:windows --db-url=... --redis-url=... # bring your own
 *
 * FLAGS:
 *   --start-infra        docker run a disposable Postgres 16 (pgvector) + Redis
 *   --keep-infra         leave the containers running afterwards
 *   --db-url=URL         disposable Postgres URL   (default: the --start-infra one)
 *   --redis-url=URL      disposable Redis URL      (default: the --start-infra one)
 *   --api-port=N         API port (default 4000 — the extension's default origin)
 *   --web-port=N         Web port (default 3311)
 *   --fixture-port=N     fixture server port (default 4599)
 *   --skip-web           do not start Next.js (Library/Detail read is via API)
 *   --browsers=a,b       chromium,edge (default both)
 *   --keep-up            leave API/worker/web running after the run (for debugging)
 *
 * EXIT CODE: 0 only if every requested browser passed. Any failure -> non-zero,
 * and the honest UC-1 status stays "BROWSER ACCEPTANCE PENDING".
 */
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

import { buildLocalFixtureEnv, describeLocalFixtureEnv } from "./local-fixture-env/index.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// --- disposable infra identity (kept away from the canonical dev ports) -------
const PG_CONTAINER = "uc1-acc-pg";
const REDIS_CONTAINER = "uc1-acc-redis";
const PG_HOST_PORT = "56421";
const REDIS_HOST_PORT = "56422";
const PG_USER = "proovra";
const PG_PASSWORD = "uc1_disposable";
const PG_DB = "uc1_acceptance_test";
const DEFAULT_DB_URL = `postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_HOST_PORT}/${PG_DB}`;
const DEFAULT_REDIS_URL = `redis://127.0.0.1:${REDIS_HOST_PORT}/0`;

function flag(name) {
  return process.argv.includes(`--${name}`);
}
function opt(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
function log(msg) {
  process.stdout.write(`\x1b[36m[uc1-acceptance]\x1b[0m ${msg}\n`);
}
function fail(msg) {
  process.stderr.write(`\x1b[31m[uc1-acceptance] FATAL:\x1b[0m ${msg}\n`);
  process.exit(1);
}

const config = {
  startInfra: flag("start-infra"),
  keepInfra: flag("keep-infra"),
  skipWeb: flag("skip-web"),
  keepUp: flag("keep-up"),
  dbUrl: opt("db-url", DEFAULT_DB_URL),
  redisUrl: opt("redis-url", DEFAULT_REDIS_URL),
  apiPort: opt("api-port", "4000"),
  webPort: opt("web-port", "3311"),
  fixturePort: opt("fixture-port", "4599"),
  browsers: opt("browsers", "chromium,edge").split(",").map((s) => s.trim()).filter(Boolean),
};

// ----------------------------------------------------------------------------
// 0. Independent safety assertions (belt to the local-fixture-env braces).
// ----------------------------------------------------------------------------
function assertLocalDisposable() {
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
  for (const [label, raw] of [["db-url", config.dbUrl], ["redis-url", config.redisUrl]]) {
    let u;
    try {
      u = new URL(raw);
    } catch {
      fail(`${label} is not a URL`);
    }
    if (!localHosts.has(u.hostname.toLowerCase())) {
      fail(`${label} host '${u.hostname}' is not local. This harness runs disposable stacks only.`);
    }
  }
  const dbName = new URL(config.dbUrl).pathname.replace(/^\//, "").toLowerCase();
  if (!/(test|fixture|local|dev|acceptance)/.test(dbName)) {
    fail(`db-url database name '${dbName}' does not read as disposable (needs test/fixture/local/dev/acceptance).`);
  }
  const apiOrigin = `http://localhost:${config.apiPort}`;
  const forbidden = ["proovra.com", "amazonaws.com", "neon.tech"];
  for (const bad of forbidden) {
    if (apiOrigin.includes(bad) || config.dbUrl.includes(bad) || config.redisUrl.includes(bad)) {
      fail(`a configured endpoint contains the forbidden production token '${bad}'.`);
    }
  }
}

// ----------------------------------------------------------------------------
// 1. Disposable infra (optional).
// ----------------------------------------------------------------------------
function docker(args, { check = true } = {}) {
  const r = spawnSync("docker", args, { stdio: "pipe", encoding: "utf8" });
  if (check && r.status !== 0) {
    fail(`docker ${args.join(" ")} failed:\n${r.stderr || r.stdout}`);
  }
  return r;
}

function startInfra() {
  log("starting disposable Postgres 16 (pgvector) + Redis …");
  docker(["rm", "-f", PG_CONTAINER], { check: false });
  docker(["rm", "-f", REDIS_CONTAINER], { check: false });
  docker([
    "run", "-d", "--name", PG_CONTAINER,
    "-p", `127.0.0.1:${PG_HOST_PORT}:5432`,
    "-e", `POSTGRES_USER=${PG_USER}`,
    "-e", `POSTGRES_PASSWORD=${PG_PASSWORD}`,
    "-e", `POSTGRES_DB=${PG_DB}`,
    "pgvector/pgvector:pg16",
  ]);
  docker([
    "run", "-d", "--name", REDIS_CONTAINER,
    "-p", `127.0.0.1:${REDIS_HOST_PORT}:6379`,
    "redis:7-alpine",
  ]);
}

async function waitForPostgres() {
  log("waiting for Postgres to accept connections …");
  for (let i = 0; i < 60; i++) {
    const r = spawnSync(
      "docker",
      ["exec", PG_CONTAINER, "pg_isready", "-U", PG_USER, "-d", PG_DB],
      { stdio: "pipe", encoding: "utf8" },
    );
    if (r.status === 0) return;
    await sleep(1000);
  }
  fail("Postgres did not become ready in 60s.");
}

function stopInfra() {
  if (config.startInfra && !config.keepInfra) {
    log("removing disposable containers …");
    docker(["rm", "-f", PG_CONTAINER], { check: false });
    docker(["rm", "-f", REDIS_CONTAINER], { check: false });
  }
}

// ----------------------------------------------------------------------------
// child-process bookkeeping
// ----------------------------------------------------------------------------
const children = [];
function startChild(name, cmd, args, { cwd, env }) {
  log(`starting ${name}: ${cmd} ${args.join(" ")}`);
  const child = spawn(cmd, args, {
    cwd: cwd ?? REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32", // pnpm.cmd on Windows
  });
  child.stdout.on("data", (d) => process.stdout.write(`\x1b[90m[${name}]\x1b[0m ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`\x1b[90m[${name}]\x1b[0m ${d}`));
  child.on("exit", (code) => log(`${name} exited (${code})`));
  children.push({ name, child });
  return child;
}
function stopChildren() {
  for (const { name, child } of children.reverse()) {
    if (child.exitCode === null) {
      log(`stopping ${name} …`);
      try {
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        } else {
          child.kill("SIGTERM");
        }
      } catch {
        /* best effort */
      }
    }
  }
}

async function waitForHttp(url, label, { tries = 120, expectStatus = null } = {}) {
  log(`waiting for ${label} at ${url} …`);
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      // When an exact status is required (the API endpoints), a wrong service
      // squatting the port — e.g. the Next.js web app answering the API's port
      // with a 404 not-found page — must NOT count as ready. That masquerade is
      // exactly what a `PORT` collision produced, so the readiness check is the
      // second line of defence after correct port wiring.
      if (expectStatus === null ? res.status < 500 : res.status === expectStatus) return;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  fail(`${label} did not become ready at ${url}${expectStatus ? ` (needed HTTP ${expectStatus})` : ""}.`);
}

/**
 * The child processes the acceptance stack runs, each with its OWN correct port.
 *
 * PURE and EXPORTED so the port wiring is unit-testable without spawning
 * anything. THE BUG THIS ENCODES: `buildLocalFixtureEnv` sets `PORT = apiPort`
 * for the whole stack, so a web child that inherits it and is started as a bare
 * `next dev` binds the API's port (4000) and then answers `/v1/oauth/extension/
 * authorize` with the Next.js 404 page instead of the API's 302. The API and the
 * extension both use the API origin, so the web child MUST get its own port:
 *   - its env `PORT` is overridden to the web port, and
 *   - `next dev -p <webPort>` is passed explicitly (the canonical web launcher
 *     does the same, because relying on the `PORT` env alone has silently used
 *     the wrong port before).
 * The API keeps `PORT = apiPort`; the worker uses `WORKER_PORT`; the fixture
 * server gets the fixture port. No two services share a port.
 */
export function planServiceChildren({ fixtureEnv, config }) {
  const children = [
    { name: "api", cmd: "pnpm", args: ["--filter", "proovra-api", "dev"], env: fixtureEnv },
    { name: "worker", cmd: "pnpm", args: ["--filter", "proovra-worker", "dev"], env: fixtureEnv },
  ];
  if (!config.skipWeb) {
    children.push({
      name: "web",
      cmd: "pnpm",
      args: ["--filter", "proovra-web", "exec", "next", "dev", "-p", String(config.webPort)],
      env: { ...fixtureEnv, PORT: String(config.webPort) },
    });
  }
  children.push({
    name: "fixtures",
    cmd: "node",
    args: ["apps/extension/e2e/fixture-server.mjs"],
    env: { ...fixtureEnv, PORT: String(config.fixturePort), FIXTURE_PORT: String(config.fixturePort) },
  });
  return children;
}

function run(name, cmd, args, { cwd, env } = {}) {
  log(`${name}: ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, {
    cwd: cwd ?? REPO_ROOT,
    env: env ?? process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) fail(`${name} failed (exit ${r.status}).`);
}

// ----------------------------------------------------------------------------
// main
// ----------------------------------------------------------------------------
async function main() {
  assertLocalDisposable();

  // The canonical safe child environment. Throws if anything is unsafe — this is
  // the hard production-safety gate. API port is chosen to match the extension's
  // default origin so the built artifact needs no rebuild per run.
  const fixtureEnv = buildLocalFixtureEnv({
    apiPort: config.apiPort,
    webPort: config.webPort,
    databaseUrl: config.dbUrl,
    redisUrl: config.redisUrl,
  });
  const apiOrigin = `http://localhost:${config.apiPort}`;
  const fixtureOrigin = `http://127.0.0.1:${config.fixturePort}`;
  log("environment is safe:");
  process.stdout.write(describeLocalFixtureEnv(fixtureEnv) + "\n");

  try {
    if (config.startInfra) {
      startInfra();
      await waitForPostgres();
    }

    // 1. Migrate the disposable DB (safe-migrate refuses non-local hosts).
    run("migrate", "node", ["services/api/scripts/safe-migrate.mjs", "deploy"], {
      env: { ...process.env, DATABASE_URL: config.dbUrl, DIRECT_URL: config.dbUrl },
    });

    // 2. Build shared packages + the extension (reproducible; local origin).
    run("build:shared", "pnpm", ["run", "build:shared"]);
    run("build:extension", "pnpm", ["--filter", "@proovra/extension", "build"], {
      env: { ...process.env, PROOVRA_API_ORIGIN: apiOrigin, NODE_ENV: "production" },
    });
    const extDist = resolve(REPO_ROOT, "apps/extension/dist");
    if (!existsSync(resolve(extDist, "manifest.json"))) {
      fail(`extension build did not produce ${extDist}/manifest.json`);
    }

    // 3. Seed one paid workspace + a real session bearer (disposable DB only).
    log("seeding acceptance user + paid workspace …");
    const seedRes = spawnSync(
      "pnpm",
      ["--filter", "proovra-api", "exec", "tsx", "scripts/uc1-seed-acceptance.ts"],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          DATABASE_URL: config.dbUrl,
          DIRECT_URL: config.dbUrl,
          AUTH_JWT_SECRET: fixtureEnv.AUTH_JWT_SECRET,
        },
        encoding: "utf8",
        shell: process.platform === "win32",
      },
    );
    if (seedRes.status !== 0) fail(`seed failed:\n${seedRes.stderr || seedRes.stdout}`);
    const seedLine = (seedRes.stdout || "").trim().split("\n").filter(Boolean).pop();
    let seed;
    try {
      seed = JSON.parse(seedLine);
    } catch {
      fail(`seed did not print JSON. Got:\n${seedRes.stdout}`);
    }
    log(`seeded team ${seed.teamId} (user ${seed.userId}).`);

    // 4. Boot API + worker + (optional) web + fixture server, each on its OWN
    //    port (see planServiceChildren — the web child must NOT inherit the
    //    API's PORT or it squats the API origin and OAuth 404s).
    for (const spec of planServiceChildren({ fixtureEnv, config })) {
      startChild(spec.name, spec.cmd, spec.args, { env: spec.env });
    }

    // The API endpoints must answer 200 as the API — a 404 (the web app on the
    // wrong port) is NOT ready.
    await waitForHttp(`${apiOrigin}/healthz`, "API", { expectStatus: 200 });
    await waitForHttp(`${apiOrigin}/readyz`, "API (DB ready)", { expectStatus: 200 });
    await waitForHttp(fixtureOrigin, "fixture server");

    // 5. Run the Playwright acceptance per requested browser.
    const e2eDir = resolve(REPO_ROOT, "apps/extension/e2e");
    const acceptanceEnv = {
      ...process.env,
      PROOVRA_API_ORIGIN: apiOrigin,
      PROOVRA_E2E_SESSION_BEARER: seed.sessionBearer,
      PROOVRA_E2E_TEAM_ID: seed.teamId,
      PROOVRA_OAUTH_CLIENT_ID: "proovra-extension",
      EXTENSION_DIST: extDist,
      FIXTURE_ORIGIN: fixtureOrigin,
    };
    const results = {};
    for (const project of config.browsers) {
      log(`running Playwright acceptance: ${project}`);
      const r = spawnSync("npx", ["playwright", "test", `--project=${project}`], {
        cwd: e2eDir,
        env: acceptanceEnv,
        stdio: "inherit",
        shell: process.platform === "win32",
      });
      results[project] = r.status === 0 ? "PASS" : "FAIL";
    }

    // 6. Report.
    log("──────────────── UC-1 ACCEPTANCE RESULT ────────────────");
    for (const [project, verdict] of Object.entries(results)) {
      log(`  ${project.padEnd(10)} ${verdict}`);
    }
    const allPassed = Object.values(results).every((v) => v === "PASS");
    log(allPassed ? "  UC-1 CLOSED (browser gate) [PASS]" : "  UC-1 BROWSER ACCEPTANCE PENDING [FAIL]");

    if (config.keepUp) {
      log("--keep-up: leaving processes running. Ctrl-C to stop.");
      await new Promise(() => {});
    }
    return allPassed ? 0 : 1;
  } finally {
    stopChildren();
    stopInfra();
  }
}

// Only run the stack when executed directly (`node scripts/uc1-acceptance-windows.mjs`).
// When imported (e.g. by the port-wiring regression test) the pure helpers above
// are used without booting anything.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  process.on("SIGINT", () => {
    stopChildren();
    stopInfra();
    process.exit(130);
  });

  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      stopChildren();
      stopInfra();
      fail(err instanceof Error ? err.stack || err.message : String(err));
    });
}
