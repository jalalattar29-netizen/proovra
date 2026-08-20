#!/usr/bin/env node
/**
 * PHASE 12 — POINT 7: the fresh-proof RUNNER.
 *
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * Point 7's evidence is only worth anything if BOTH layers ran under ONE run id
 * and ONE build id, against disposable infrastructure, with the outbound guard
 * armed and a production web build under strict CSP. Every one of those is easy
 * to get wrong by hand, and each way of getting it wrong produces a run that
 * LOOKS green:
 *
 *   - a surviving `next start` from a previous session serves the OLD build
 *     under the NEW run id;
 *   - `NEXT_PUBLIC_API_BASE` is inlined at BUILD time and defaults to the
 *     PRODUCTION host, so a build without it bakes production into the bundle;
 *   - the web bundle's origin and the harness's origin must be the SAME host,
 *     because the served CSP `connect-src` is derived from the former and a
 *     session cookie is per-host — `localhost` and `127.0.0.1` are two origins;
 *   - `INTERNAL_API_BASE_URL` matches the `API_BASE` credential fragment, so an
 *     unscrubbed run writes the worker's refused compose-default connections
 *     into the PRODUCT ledger the gate reads;
 *   - a database carried over from a previous suite leaves archive-eligible
 *     rows that push the tier sweep's bounded batch past the row under test.
 *
 * The recipe therefore lives in code rather than in a checkpoint, so the next
 * pass reproduces the run instead of reconstructing it.
 *
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 * It provisions nothing external and asserts nothing about the product. It
 * starts no worker: no Point-7 scenario needs one, and a live worker re-delivers
 * the server layer's `example.invalid` webhook fixtures for as long as it runs —
 * external attempts the gate correctly refuses.
 *
 * Usage:
 *   node scripts/point7-run.mjs                # full fresh run
 *   node scripts/point7-run.mjs --server-only  # server layer + gate
 *   node scripts/point7-run.mjs --browser-only # browser layer + gate (reuses db)
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = resolve(ROOT, ".p7tmp");

const ARGS = new Set(process.argv.slice(2));
const SERVER_ONLY = ARGS.has("--server-only");
const BROWSER_ONLY = ARGS.has("--browser-only");

// ===========================================================================
// The disposable stack this run addresses
// ===========================================================================

/**
 * Ports and names, stated once.
 *
 * The S3 values are NOT configurable here on purpose:
 * `services/api/test/setup/test-bootstrap.mjs` scrubs every `S3_*` key and
 * then applies its own LOCAL_FAKES unconditionally, so these are the values the
 * API process WILL hold whatever this runner exports. Disagreeing with them
 * would produce a run whose fixtures write to one bucket and whose application
 * reads from another.
 */
const STACK = {
  pgHostPort: 55432,
  redisHostPort: 56379,
  s3Endpoint: "http://127.0.0.1:59000",
  s3Bucket: "point7-local-bucket",
  apiPort: 8091,
  webPort: 3007,
  host: "127.0.0.1",
  /** The container's own superuser — `POSTGRES_USER` on `p12-pg`, not `postgres`. */
  pgSuperUser: "p12",
  pgSuperPassword: "p12",
  p7Database: "proovra_point7_test",
  p7Role: "p7",
  p7Password: "p7pass",
};

const P7_DATABASE_URL = `postgresql://${STACK.p7Role}:${STACK.p7Password}@127.0.0.1:${STACK.pgHostPort}/${STACK.p7Database}`;
const REDIS_URL = `redis://127.0.0.1:${STACK.redisHostPort}`;
const API_BASE = `http://${STACK.host}:${STACK.apiPort}`;
const WEB_BASE = `http://${STACK.host}:${STACK.webPort}`;

/** Absolute, because four processes with four working directories append here. */
const PRODUCT_LEDGER = resolve(TMP, "product-run-network.jsonl");
/**
 * The canary's ledger, NAMED here rather than left to a default.
 *
 * Both canonical ledger paths are now declared by this runner, because the
 * vitest project's defaults became RUN-SCOPED. They had been fixed shared
 * paths, so every ordinary `pnpm test:integration` appended its own
 * connections to the canonical PRODUCT ledger under a fresh run id — and the
 * closure gate, correctly, refused the whole proof with "N ledger record(s)
 * belong to a different run id". A diagnostic run must not be able to
 * invalidate an authoritative one by merely existing, so the workflow that IS
 * entitled to write the canonical ledgers is the one that names them.
 */
const CANARY_LEDGER = resolve(TMP, "canary-network.jsonl");
const BROWSER_LEDGER = resolve(TMP, "browser-network.jsonl");
const EMAIL_RECORDER = resolve(TMP, "recorded-emails.jsonl");
/**
 * The messaging boundary's recorder, on the same principle as the mailbox.
 *
 * The enterprise step-up gate delivers its one-time code by SMS, and the only
 * providers were Twilio and Noop — so the two evidence-publication capabilities
 * could not be driven at all: a real provider is unreachable from a hermetic
 * run, and a Noop discards the code the journey has to type back. The recording
 * provider is a real implementation of the same contract that keeps the code
 * locally, exactly as the recording EMAIL provider does.
 */
const MESSAGING_RECORDER = resolve(TMP, "recorded-messages.jsonl");
const BOOTSTRAP = resolve(ROOT, "services/api/test/setup/test-bootstrap.mjs");

const E2E_BYPASS_SECRET =
  "e2e-bypass-do-not-use-in-prod-7f2c3a91b4d9e8f10c2b3a4d5e6f70819";

/**
 * The intake secret the API process — and ONLY the API process — is given.
 *
 * `test-bootstrap.mjs` scrubs `WORKFLOW_INTAKE_TOKEN_SECRET` out of every
 * in-process suite on purpose (a harness-supplied secret changes what
 * `hmacForIntake()` returns), and carves out exactly one exception for the
 * long-lived API process the browser layer talks to, keyed on `P7_PROCESS=api`.
 * Its own comment ends "the VALUE is supplied by the focused runner" — and this
 * runner never supplied it, so the carve-out protected a key that was never set.
 *
 * The cost is not a failed request, it is a MISLEADING one. With the secret
 * absent `workflowIntakeFeatureDisabledReason()` answers `secret_missing` and
 * `GET /v1/workflow/intake-links` returns 503 to the authenticated shell, which
 * requests that list on every page. The 503 is correct behaviour for a feature
 * that is off, so nothing in the product is wrong — but it lands inside every
 * browser scenario's "no console errors" assertion, failing journeys that have
 * nothing to do with intake links.
 *
 * Supplying it turns the feature ON for the run, which is the stronger posture:
 * the surface is exercised rather than stubbed out. Local, disposable, >= 32
 * chars (`readSecret()` refuses anything shorter), and never printed.
 */
const WORKFLOW_INTAKE_SECRET =
  "point7-local-disposable-intake-secret-4b1c8e2a9d7f3061";

// ===========================================================================
// Small helpers
// ===========================================================================

function log(step, message) {
  process.stdout.write(`\n[point7:${step}] ${message}\n`);
}

function die(message) {
  process.stderr.write(`\n[point7] FAILED: ${message}\n`);
  // Kill the stack BEFORE exiting. `process.exit()` does not run the `finally`
  // that owns `stopAll()`, so every `die()` raised after `startStack()` — a
  // failing browser layer being the ordinary case — used to leave `next start`
  // and the API holding 3007 and 8091. That fails closed rather than silently
  // (the next run's `requireFreePorts` refuses to start on a survivor), but it
  // turns one failed run into two, and the survivor serves the OLD build.
  stopAll();
  process.exit(1);
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: options.capture ? "pipe" : "inherit",
    shell: true,
    encoding: "utf8",
  });
  if (!options.allowFailure && result.status !== 0) {
    die(`${cmd} ${args.join(" ")} exited ${result.status}`);
  }
  return result;
}

function portListening(port) {
  return new Promise((res) => {
    const socket = createConnection({ host: "127.0.0.1", port }, () => {
      socket.destroy();
      res(true);
    });
    socket.on("error", () => res(false));
    socket.setTimeout(700, () => {
      socket.destroy();
      res(false);
    });
  });
}

async function waitForPort(port, label, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await portListening(port)) return;
    if (Date.now() > deadline) die(`${label} never listened on ${port}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Refuse to start on top of a survivor.
 *
 * The previous corrective pass lost a whole run to this: `TaskStop` killed an
 * `npx` wrapper and left its `tsx` child holding the port, which kept writing
 * the PREVIOUS run's id into the ledger after `.p7tmp` had been cleared. Ports
 * are checked, never assumed.
 */
async function requireFreePorts(ports) {
  const busy = [];
  for (const p of ports) if (await portListening(p)) busy.push(p);
  if (busy.length > 0) {
    die(
      `ports already in use: ${busy.join(", ")}. A survivor process from a ` +
        "previous run would serve the OLD build under the NEW run id. Stop it " +
        "and check its process tree before retrying.",
    );
  }
}

async function requireInfrastructure() {
  for (const [port, what] of [
    [STACK.pgHostPort, "disposable PostgreSQL 16 + pgvector (p12-pg)"],
    [STACK.redisHostPort, "disposable Redis (p12-redis)"],
    [59000, "disposable S3 (p7-minio)"],
  ]) {
    if (!(await portListening(port))) {
      die(`${what} is not listening on ${port}`);
    }
  }
}

// ===========================================================================
// Environment blocks
// ===========================================================================

/**
 * Everything every Point-7 process shares.
 *
 * `NODE_OPTIONS` carries the bootstrap preload: it is the env scrub AND the
 * outbound guard, and it must run before the entry module is resolved, because
 * module-level code in the application graph captures `process.env` on first
 * import.
 */
function commonEnv(runId) {
  return {
    POINT7: "1",
    POINT7_RUN_ID: runId,
    P7_NETWORK_LEDGER: PRODUCT_LEDGER,
    P7_CANARY_LEDGER: CANARY_LEDGER,
    P7_WEB_RUNTIME_MODE: "production-build",
    P7_STRICT_CSP: "true",
    EMAIL_RECORDER_FILE: EMAIL_RECORDER,
    MESSAGING_TRANSPORT: "recording",
    MESSAGING_RECORDER_FILE: MESSAGING_RECORDER,
    E2E_AUTH_BYPASS_SECRET: E2E_BYPASS_SECRET,
    TEST_DATABASE_URL: P7_DATABASE_URL,
    P7_TEST_DATABASE_URL: P7_DATABASE_URL,
    P7_TEST_REDIS_URL: REDIS_URL,
    P7_DATABASE_URL,
    /**
     * A file URL, not a path.
     *
     * Node's `--import` takes a module specifier, and on Windows a bare
     * absolute path begins `D:\`, which the ESM resolver reads as the URL
     * scheme `d:` and refuses with ERR_UNSUPPORTED_ESM_URL_SCHEME. The process
     * then dies before it opens a port, which looks exactly like a slow boot.
     */
    NODE_OPTIONS: `--import ${pathToFileURL(BOOTSTRAP).href}`,
  };
}

// ===========================================================================
// 1. A database this run alone has touched
// ===========================================================================

function psql(sql, { database = "postgres", allowFailure = false } = {}) {
  return run(
    "docker",
    [
      "exec",
      "-e",
      `PGPASSWORD=${STACK.pgSuperPassword}`,
      "p12-pg",
      "psql",
      "-U",
      STACK.pgSuperUser,
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      JSON.stringify(sql),
    ],
    { allowFailure, capture: true },
  );
}

function recreateDatabase() {
  log("db", `recreating ${STACK.p7Database}`);
  // A database carried over from a previous suite is not a neutral starting
  // point: five suites' worth of archive-eligible evidence pushed the tier
  // sweep's bounded batch past the row a test had just written, and five
  // assertions failed for a reason that had nothing to do with the product.
  psql(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${STACK.p7Database}'`,
    { allowFailure: true },
  );
  psql(`DROP DATABASE IF EXISTS ${STACK.p7Database}`);
  psql(
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${STACK.p7Role}') THEN CREATE ROLE ${STACK.p7Role} LOGIN PASSWORD '${STACK.p7Password}' SUPERUSER; END IF; END $$`,
  );
  psql(`CREATE DATABASE ${STACK.p7Database} OWNER ${STACK.p7Role}`);
  psql("CREATE EXTENSION IF NOT EXISTS vector", { database: STACK.p7Database });

  log("db", "prisma migrate deploy");
  run("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    cwd: resolve(ROOT, "services/api"),
    env: {
      DATABASE_URL: P7_DATABASE_URL,
      DIRECT_URL: P7_DATABASE_URL,
      CHECKPOINT_DISABLE: "1",
      PRISMA_HIDE_UPDATE_MESSAGE: "true",
    },
  });
}

// ===========================================================================
// 2. SERVER layer
// ===========================================================================

function runServerLayer(runId) {
  log("server", "integration matrix against live PostgreSQL 16");
  run("pnpm", ["exec", "vitest", "run", "--config", "vitest.integration.config.ts"], {
    cwd: resolve(ROOT, "services/api"),
    env: {
      ...commonEnv(runId),
      P7_PROCESS: "server-suite",
      RUN_LIVE_INTEGRATION: "1",
      RUN_LIVE_INTEGRATION_DB_OK: "1",
    },
  });
}

// ===========================================================================
// 3. Production web build
// ===========================================================================

function buildWeb() {
  log("build", `next build with NEXT_PUBLIC_API_BASE=${API_BASE}`);
  // Next inlines this at BUILD time and the served CSP `connect-src` is derived
  // from it. Building without it bakes the PRODUCTION api host into the bundle;
  // building with a different host from the one the harness drives makes CSP
  // block the fetch and then, once allowed, drops the session cookie.
  run("pnpm", ["exec", "next", "build"], {
    cwd: resolve(ROOT, "apps/web"),
    env: {
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      NEXT_PUBLIC_API_BASE: API_BASE,
      NEXT_PUBLIC_WEB_BASE: WEB_BASE,
      NEXT_PUBLIC_APP_BASE: WEB_BASE,
      /**
       * The object store, as the BROWSER must be allowed to address it.
       *
       * `middleware.ts` builds `img-src`/`media-src`/`connect-src` from
       * `NEXT_PUBLIC_STORAGE_ORIGIN` (NEW-075/NEW-081) precisely so a non-HTTPS
       * store is reachable; unset, the policy names only the API origin and the
       * production R2 wildcard, and the blanket `https:` token does not cover
       * `http://127.0.0.1:59000`.
       *
       * Unset, the browser refuses the store BEFORE opening a socket, and both
       * failure modes are silent rather than loud: presigned part PUTs never
       * happen so a multipart upload reaches UPLOADING and records zero parts,
       * and a derived-asset `<img>` takes its `onError` path and renders
       * "preview unavailable" for an asset that is COMPLETED and byte-identical.
       *
       * Inlined at BUILD time, so it must be set here AND on `next start`.
       */
      NEXT_PUBLIC_STORAGE_ORIGIN: STACK.s3Endpoint,
      /**
       * Load-bearing for the multipart-cancel journey.
       *
       * `isResumableEnabled()` compares the INLINED value to the exact string
       * "true". Unset at build time, `UploadOperationsPanel` never mounts and
       * there is no Cancel control to click — so NEW-029 would become
       * UNPROVABLE rather than failing, which is the worse of the two.
       */
      NEXT_PUBLIC_RESUMABLE_UPLOADS_ENABLED: "true",
    },
  });

  // The bundle is evidence: assert the production host is absent rather than
  // trusting that the variable was exported.
  const staticDir = resolve(ROOT, "apps/web/.next/static");
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|json|txt)$/.test(entry.name)) {
        if (readFileSync(full, "utf8").includes("api.proovra.com")) offenders.push(full);
      }
    }
  };
  if (existsSync(staticDir)) walk(staticDir);
  if (offenders.length > 0) {
    die(
      `the production API host is inlined in ${offenders.length} bundle file(s); ` +
        "the build did not see NEXT_PUBLIC_API_BASE",
    );
  }
  log("build", "bundle carries no production API host");
}

// ===========================================================================
// 4. The two long-lived processes
// ===========================================================================

const children = [];

function startProcess(label, cmd, args, options) {
  const child = spawn(cmd, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });
  children.push({ label, child });
  child.stdout.on("data", (b) => process.stdout.write(`[${label}] ${b}`));
  child.stderr.on("data", (b) => process.stderr.write(`[${label}] ${b}`));
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      process.stderr.write(`\n[point7] ${label} exited ${code}\n`);
    }
  });
  return child;
}

function stopAll() {
  for (const { label, child } of children) {
    if (child.exitCode !== null) continue;
    // Kill the TREE. A killed `pnpm`/`npx` wrapper leaves its `tsx` or `next`
    // child holding the port — the exact survivor that invalidated a previous
    // run by writing the old run id into the ledger after `.p7tmp` was cleared.
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      shell: true,
    });
    process.stdout.write(`[point7] stopped ${label}\n`);
  }
}

async function startStack(runId) {
  log("stack", "starting API (no worker: none of the scenarios need one)");
  startProcess("api", "pnpm", ["exec", "tsx", "src/index.ts"], {
    cwd: resolve(ROOT, "services/api"),
    env: {
      ...commonEnv(runId),
      P7_PROCESS: "api",
      PORT: String(STACK.apiPort),
      HOST: STACK.host,
      DATABASE_URL: P7_DATABASE_URL,
      DIRECT_URL: P7_DATABASE_URL,
      REDIS_URL,
      INTERNAL_API_BASE_URL: API_BASE,
      /**
       * Load-bearing for the public-verify publication journey.
       *
       * For evidence with no anchor row, `summary.configured` is literally
       * `Boolean(process.env.ANCHOR_PROVIDER)`. Unset, the publish control
       * renders permanently disabled and the capability becomes UNPROVABLE
       * rather than failing — the worse of the two outcomes, because nothing
       * says so.
       */
      ANCHOR_PROVIDER: "local-test-anchor",
      /**
       * The intake feature, actually configured.
       *
       * Both halves are required: `workflowIntakeFeatureDisabledReason()`
       * reports `feature_disabled` without the flag and `secret_missing`
       * without the secret, and either answer is a 503 on a route the
       * authenticated shell calls from every page. See the constant above for
       * why the secret survives the bootstrap scrub in THIS process alone.
       */
      WORKFLOW_INTAKE_LINKS_ENABLED: "true",
      WORKFLOW_INTAKE_TOKEN_SECRET: WORKFLOW_INTAKE_SECRET,
    },
  });
  await waitForPort(STACK.apiPort, "api");

  log("stack", "starting next start (production build, strict CSP)");
  startProcess("web", "pnpm", ["exec", "next", "start", "-p", String(STACK.webPort), "-H", STACK.host], {
    cwd: resolve(ROOT, "apps/web"),
    env: {
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      NEXT_PUBLIC_API_BASE: API_BASE,
      NEXT_PUBLIC_WEB_BASE: WEB_BASE,
      NEXT_PUBLIC_APP_BASE: WEB_BASE,
      NEXT_PUBLIC_STORAGE_ORIGIN: STACK.s3Endpoint,
      NEXT_PUBLIC_RESUMABLE_UPLOADS_ENABLED: "true",
      P7_STRICT_CSP: "true",
    },
  });
  await waitForPort(STACK.webPort, "web");
}

// ===========================================================================
// 5. BROWSER layer
// ===========================================================================

function runBrowserLayer(runId) {
  log("browser", "playwright --project=point7 against the production build");
  run("pnpm", ["exec", "playwright", "test", "--project=point7"], {
    env: {
      ...commonEnv(runId),
      P7_PROCESS: "browser",
      P7_BROWSER_NETWORK_LEDGER: BROWSER_LEDGER,
      WEB_BASE,
      API_BASE,
      /**
       * The object store, as the FIXTURES address it.
       *
       * Some specs put real objects (an SIU archive, a derived-asset image)
       * and read multipart state back. They must agree with what the API
       * process is configured with — and the API's values are not negotiable:
       * `test-bootstrap.mjs` scrubs every `S3_*` key and then applies its own
       * LOCAL_FAKES unconditionally. These ARE those values, restated here for
       * the one process the bootstrap does not run in.
       */
      S3_ENDPOINT: STACK.s3Endpoint,
      S3_REGION: "auto",
      S3_ACCESS_KEY: "point7-local-minio",
      S3_SECRET_KEY: "point7-local-minio-secret",
      S3_BUCKET: STACK.s3Bucket,
      S3_FORCE_PATH_STYLE: "true",
      // Playwright's own workers must NOT preload the API bootstrap: it would
      // scrub the very variables the specs are given.
      NODE_OPTIONS: "",
    },
  });
}

// ===========================================================================
// 6. The gate, run the way the full suite runs it
// ===========================================================================

function runClosureGate() {
  log("gate", "phase-12-point7-closure-gate with NO Point-7 env");
  const stripped = { ...process.env };
  for (const key of Object.keys(stripped)) {
    if (key.startsWith("P7_") || key.startsWith("POINT7")) delete stripped[key];
  }
  // The gate must pass with no env at all, because that is how it runs inside
  // `pnpm --filter proovra-api test`. Handing it the run's variables would
  // prove only that it passes when hand-fed.
  const result = spawnSync(
    "pnpm",
    ["exec", "vitest", "run", "test/phase-12-point7-closure-gate.test.ts"],
    {
      cwd: resolve(ROOT, "services/api"),
      env: { ...stripped, NODE_OPTIONS: "" },
      stdio: "inherit",
      shell: true,
    },
  );
  if (result.status !== 0) die("the Point-7 closure gate refused this run");
}

// ===========================================================================
// main
// ===========================================================================

async function main() {
  const runId = process.env.POINT7_RUN_ID ?? randomUUID().slice(0, 8);
  log("run", `run id ${runId}`);

  await requireInfrastructure();

  if (!BROWSER_ONLY) {
    await requireFreePorts([STACK.apiPort, STACK.webPort]);
    // A fresh run inherits no credit. The global setup clears the browser proof
    // file; the ledgers are cleared here so an old run's entries cannot be read
    // as this one's isolation evidence.
    mkdirSync(TMP, { recursive: true });
    for (const f of [PRODUCT_LEDGER, CANARY_LEDGER, BROWSER_LEDGER, EMAIL_RECORDER, MESSAGING_RECORDER]) {
      rmSync(f, { force: true });
    }
    recreateDatabase();
    runServerLayer(runId);
  }

  if (SERVER_ONLY) {
    // Deliberately no gate here. A server-only run has produced no BROWSER
    // credit, so the gate would refuse it — correctly, and uselessly.
    log("run", "server layer only; the closure gate needs both layers");
    return;
  }

  await requireFreePorts([STACK.apiPort, STACK.webPort]);
  buildWeb();
  try {
    await startStack(runId);
    runBrowserLayer(runId);
  } finally {
    stopAll();
  }

  runClosureGate();
  log("run", `complete — run id ${runId}`);
}

process.on("SIGINT", () => {
  stopAll();
  process.exit(130);
});

main().catch((err) => {
  stopAll();
  die(err instanceof Error ? err.message : String(err));
});
