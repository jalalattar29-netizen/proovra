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
const MINIO_CONTAINER = "uc1-acc-minio";
const PG_HOST_PORT = "56421";
const REDIS_HOST_PORT = "56422";
const MINIO_HOST_PORT = "56423";
const PG_USER = "proovra";
const PG_PASSWORD = "uc1_disposable";
const PG_DB = "uc1_acceptance_test";
// Disposable object storage. The UC-1 lifecycle is storage-backed end to end
// (capture PUT, worker Report + Verification Package upload, public Verify read),
// so the acceptance stack MUST have a real S3 — the canonical fixture env points
// it at a dead address on purpose. These are disposable local-only credentials.
const MINIO_USER = "uc1miniolocal";
const MINIO_PASSWORD = "uc1miniolocalsecret";
const MINIO_BUCKET = "uc1-acceptance";
const DEFAULT_DB_URL = `postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_HOST_PORT}/${PG_DB}`;
const DEFAULT_REDIS_URL = `redis://127.0.0.1:${REDIS_HOST_PORT}/0`;
const DEFAULT_S3_ENDPOINT = `http://127.0.0.1:${MINIO_HOST_PORT}`;

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
  s3Endpoint: opt("s3-endpoint", DEFAULT_S3_ENDPOINT),
  s3Bucket: opt("s3-bucket", MINIO_BUCKET),
  s3AccessKey: opt("s3-access-key", MINIO_USER),
  s3SecretKey: opt("s3-secret-key", MINIO_PASSWORD),
  apiPort: opt("api-port", "4000"),
  webPort: opt("web-port", "3311"),
  fixturePort: opt("fixture-port", "4599"),
  browsers: opt("browsers", "chromium,edge").split(",").map((s) => s.trim()).filter(Boolean),
  grep: opt("grep", ""),
};

/**
 * Resolve a Chromium/Chrome executable for the worker's Report PDF rendering.
 *
 * report-v2 renders the Report PDF with Puppeteer, and its resolver only accepts
 * `PUPPETEER_EXECUTABLE_PATH` or hard-coded Linux paths — so on a Windows host the
 * worker finds no browser and the Report (and the Package that embeds it) fail
 * with a RETRYABLE_FAILURE that never clears. We resolve one here and pass it in.
 * Preference: an explicit env override, then Puppeteer's own downloaded Chromium,
 * then the system Chrome/Edge, then common Linux paths (for CI/dev).
 */
function resolveChromiumPath() {
  const candidates = [];
  if (process.env.PUPPETEER_EXECUTABLE_PATH) candidates.push(process.env.PUPPETEER_EXECUTABLE_PATH);
  try {
    const r = spawnSync(
      "pnpm",
      ["--filter", "proovra-worker", "exec", "node", "-e", "try{process.stdout.write(require('puppeteer').executablePath())}catch{}"],
      { cwd: REPO_ROOT, encoding: "utf8", shell: process.platform === "win32" },
    );
    const ep = (r.stdout || "").trim();
    if (ep) candidates.push(ep);
  } catch {
    /* puppeteer not resolvable — fall through to system browsers */
  }
  candidates.push(
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/chrome",
  );
  for (const c of candidates) {
    try {
      if (c && existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

// ----------------------------------------------------------------------------
// 0. Independent safety assertions (belt to the local-fixture-env braces).
// ----------------------------------------------------------------------------
function assertLocalDisposable() {
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
  for (const [label, raw] of [
    ["db-url", config.dbUrl],
    ["redis-url", config.redisUrl],
    ["s3-endpoint", config.s3Endpoint],
  ]) {
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
  log("starting disposable Postgres 16 (pgvector) + Redis + MinIO (object storage) …");
  docker(["rm", "-f", PG_CONTAINER], { check: false });
  docker(["rm", "-f", REDIS_CONTAINER], { check: false });
  docker(["rm", "-f", MINIO_CONTAINER], { check: false });
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
  // The UC-1 lifecycle is storage-backed; without a real S3 the capture upload,
  // the worker's Report + Verification Package writes, and public Verify's
  // package read all fail — which is exactly a 360s hang, not a fast failure.
  docker([
    "run", "-d", "--name", MINIO_CONTAINER,
    "-p", `127.0.0.1:${MINIO_HOST_PORT}:9000`,
    "-e", `MINIO_ROOT_USER=${MINIO_USER}`,
    "-e", `MINIO_ROOT_PASSWORD=${MINIO_PASSWORD}`,
    "minio/minio", "server", "/data",
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

async function waitForMinioAndBucket() {
  log("waiting for MinIO to become ready …");
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${config.s3Endpoint}/minio/health/ready`);
      if (res.status === 200) {
        ready = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  if (!ready) fail("MinIO did not become ready in 60s.");
  // Create the disposable bucket via the API workspace's own S3 SDK.
  const r = spawnSync(
    "pnpm",
    ["--filter", "proovra-api", "exec", "node", "scripts/uc1-ensure-bucket.mjs"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        S3_ENDPOINT: config.s3Endpoint,
        S3_BUCKET: config.s3Bucket,
        S3_REGION: "us-east-1",
        S3_ACCESS_KEY: config.s3AccessKey,
        S3_SECRET_KEY: config.s3SecretKey,
      },
      encoding: "utf8",
      shell: process.platform === "win32",
    },
  );
  process.stdout.write(r.stdout || "");
  if (r.status !== 0) fail(`bucket creation failed:\n${r.stderr || r.stdout}`);
}

function stopInfra() {
  if (config.startInfra && !config.keepInfra) {
    log("removing disposable containers …");
    docker(["rm", "-f", PG_CONTAINER], { check: false });
    docker(["rm", "-f", REDIS_CONTAINER], { check: false });
    docker(["rm", "-f", MINIO_CONTAINER], { check: false });
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
/**
 * The S3 overrides that replace the canonical "dead storage" with the disposable
 * MinIO. EXPORTED so a regression can prove the acceptance stack points at a real,
 * local, disposable object store — the absence of one is what hangs the whole
 * capture -> report -> package -> verify lifecycle to the test timeout.
 */
export function s3FixtureOverrides(config) {
  return {
    S3_ENDPOINT: config.s3Endpoint,
    S3_PUBLIC_BASE_URL: config.s3Endpoint,
    S3_BUCKET: config.s3Bucket,
    S3_REGION: "us-east-1",
    S3_ACCESS_KEY: config.s3AccessKey,
    S3_SECRET_KEY: config.s3SecretKey,
    S3_FORCE_PATH_STYLE: "true",
    S3_ALLOW_INSECURE: "true",
  };
}

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

  // The worker renders the Report PDF with Puppeteer; without a browser the
  // Report and Package fail forever (RETRYABLE_FAILURE). Resolve one up front.
  const chromiumPath = resolveChromiumPath();
  if (!chromiumPath) {
    fail(
      "No Chromium/Chrome/Edge found for the worker's Report PDF rendering. " +
        "Install Google Chrome, or set PUPPETEER_EXECUTABLE_PATH to a Chromium executable.",
    );
  }

  // The canonical safe child environment. Throws if anything is unsafe — this is
  // the hard production-safety gate. API port is chosen to match the extension's
  // default origin so the built artifact needs no rebuild per run.
  const fixtureEnv = buildLocalFixtureEnv({
    apiPort: config.apiPort,
    webPort: config.webPort,
    databaseUrl: config.dbUrl,
    redisUrl: config.redisUrl,
    // Override the canonical "dead storage" with the disposable MinIO (so capture
    // upload, the worker's Report + Package writes, and public Verify's package
    // read all work), and give the worker a Puppeteer browser. All local paths /
    // non-credential-shaped values, so the fixture-env leak scan still passes.
    extra: { ...s3FixtureOverrides(config), PUPPETEER_EXECUTABLE_PATH: chromiumPath },
  });
  const apiOrigin = `http://localhost:${config.apiPort}`;
  const fixtureOrigin = `http://127.0.0.1:${config.fixturePort}`;
  log(`report PDF renderer: ${chromiumPath}`);
  log("environment is safe:");
  process.stdout.write(describeLocalFixtureEnv(fixtureEnv) + "\n");

  try {
    if (config.startInfra) {
      startInfra();
      await waitForPostgres();
      await waitForMinioAndBucket();
    }

    // 1. Migrate the disposable DB (safe-migrate refuses non-local hosts).
    run("migrate", "node", ["services/api/scripts/safe-migrate.mjs", "deploy"], {
      env: { ...process.env, DATABASE_URL: config.dbUrl, DIRECT_URL: config.dbUrl },
    });

    // 1b. Register the fixture signing key(s) in the DB. Evidence reads verify the
    //     record's signing key against this registry, so without it every read
    //     after a capture 503s SIGNING_KEY_MISSING. Uses the same SIGNING_* the
    //     fixture env signs with.
    run("seed:signing-key", "pnpm", ["--filter", "proovra-api", "exec", "tsx", "src/seed-signing-key.ts"], {
      env: fixtureEnv,
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
    // A --grep passes straight through to Playwright, so the focused
    // Chromium/static run is: --browsers=chromium --grep=static
    const grepArgs = config.grep ? ["--grep", config.grep] : [];
    const results = {};
    for (const project of config.browsers) {
      log(`running Playwright acceptance: ${project}${config.grep ? ` (grep: ${config.grep})` : ""}`);
      const r = spawnSync("npx", ["playwright", "test", `--project=${project}`, ...grepArgs], {
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
