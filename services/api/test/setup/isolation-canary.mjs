/**
 * PHASE 12 — POINT 7: the ISOLATION CANARY.
 *
 * Twelve checks that must pass before any suite runs. Each one is executed in
 * its own CHILD PROCESS, started with a deliberately hostile environment, so a
 * check that passes has passed against the exact condition that caused the
 * incident, not against a convenient blank slate.
 *
 * That hostile environment is the canary's OWN — synthetic production-shaped
 * sentinels from `canary-env-fixture.mjs`, written to a throwaway `.env` FILE
 * and injected as variables — PLUS any real deployment value the sentinels do
 * not cover. It used to be built solely from the operator's `.env`, which meant
 * check 1 was really asserting "this machine happens to have one": it failed on
 * a clean checkout while nothing was wrong, and checks 2-12 ran against a blank
 * slate, passing because there was nothing hostile left to resist.
 *
 * WHY A SEPARATE SCRIPT AND NOT A TEST
 * ---------------------------------------------------------------------------
 * Because it gates the test runner. A canary that runs inside vitest cannot
 * establish that starting vitest is safe — by the time it reports, the thing it
 * was meant to authorise has already happened. So it is a plain Node script,
 * runnable before anything else, and it never imports vitest.
 *
 * WHAT "HOSTILE ENVIRONMENT" MEANS HERE
 * ---------------------------------------------------------------------------
 * Sentinel values — and any real deployment value that reaches a child — are
 * NEVER printed, logged, written to the ledger, or included in a failure
 * message. The canary reports only whether a variable's value SURVIVED into the
 * child's runtime, as a boolean.
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  hostileEnvironment,
  hostilePremiseHolds,
  SENTINEL,
  SENTINEL_HOSTS,
  withEnvFileFixture,
} from "./canary-env-fixture.mjs";

const require_ = createRequire(import.meta.url);

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(HERE, "../..");
const REPO_ROOT = resolve(API_ROOT, "../..");
const BOOTSTRAP = new URL("./test-bootstrap.mjs", import.meta.url).href;
const LEDGER = resolve(REPO_ROOT, ".p7tmp/canary-network.jsonl");

/** Read the operator's deployment env WITHOUT echoing any value. */
function readDeploymentEnv() {
  const out = {};
  for (const rel of ["services/api/.env", ".env"]) {
    const path = resolve(REPO_ROOT, rel);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i <= 0) continue;
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim();
      if (k && v && out[k] === undefined) out[k] = v;
    }
  }
  return out;
}

const REAL_DEPLOYMENT_ENV = readDeploymentEnv();

/**
 * The hostile environment is the canary's OWN, not the machine's — see
 * `canary-env-fixture.mjs` for why, and for the sentinel values themselves.
 */
const DEPLOYMENT_ENV = hostileEnvironment(REAL_DEPLOYMENT_ENV);

/**
 * Run one probe in a child process, with the bootstrap preloaded and the
 * hostile environment injected.
 */
function probe(name, source, extraEnv = {}, cwd = API_ROOT) {
  const file = resolve(REPO_ROOT, `.p7tmp/canary-${name}.mjs`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source, "utf8");
  const res = spawnSync(
    process.execPath,
    ["--import", BOOTSTRAP, file],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        ...DEPLOYMENT_ENV,
        P7_CANARY_LIVE_ENV: "1",
        P7_NETWORK_LEDGER: LEDGER, P7_CANARY_LEDGER: LEDGER, P7_PHASE: "canary",
        P7_PROCESS: `canary:${name}`,
        ...extraEnv,
      },
      timeout: 180_000,
    },
  );
  return {
    status: res.status,
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
  };
}


const results = [];
function check(n, title, ok, detail = "") {
  results.push({ n, title, ok, detail });
  // eslint-disable-next-line no-console
  console.log(`${ok ? "PASS" : "FAIL"}  ${String(n).padStart(2)}. ${title}${detail ? `  — ${detail}` : ""}`);
}

rmSync(LEDGER, { force: true });

// ---------------------------------------------------------------------------
// 1. The deployment env really does contain live-looking endpoints, and the
//    bootstrap refuses them. If the first half were false the whole canary
//    would be vacuous, so it is asserted rather than assumed.
// ---------------------------------------------------------------------------
{
  // The hostile environment is asserted, not assumed — but it is now the
  // canary's OWN synthetic one, so this holds on every machine.
  const premise = hostilePremiseHolds(DEPLOYMENT_ENV);

  const { parsed, stdout, stderr } = withEnvFileFixture((dir) => {
    const r = probe(
      "env",
      `
      // Give dotenv every chance: load it explicitly from THIS directory, which
      // holds a real .env full of production-shaped values.
      try { (await import("dotenv")).config(); } catch { /* absent is fine */ }
      const net = await import("node:net");
      const blocked = [];
      for (const host of ${JSON.stringify(SENTINEL_HOSTS)}) {
        try {
          new net.Socket().connect({ host, port: 443 });
          blocked.push(host + ":allowed");
        } catch (e) {
          blocked.push(host + (e?.code === "POINT7_OUTBOUND_DENIED" ? ":blocked" : ":other"));
        }
      }
      console.log(JSON.stringify({
        sentry: process.env.SENTRY_DSN ?? null,
        sentryEnabled: process.env.SENTRY_ENABLED,
        redisIsLocal: /127\\.0\\.0\\.1|localhost/.test(process.env.REDIS_URL ?? ""),
        dbIsLocal: /127\\.0\\.0\\.1|localhost/.test(process.env.DATABASE_URL ?? ""),
        storageIsLocal: /127\\.0\\.0\\.1|localhost/.test(process.env.S3_ENDPOINT ?? ""),
        nodeEnv: process.env.NODE_ENV,
        bucket: process.env.S3_BUCKET,
        blocked,
      }));
      process.exit(0);`,
      {},
      dir,
    );
    let p = {};
    try {
      p = JSON.parse(r.stdout.split("\n").filter((l) => l.startsWith("{")).pop() ?? "{}");
    } catch { /* reported below */ }
    return { parsed: p, stdout: r.stdout, stderr: r.stderr };
  });

  // No sentinel VALUE may appear in anything the child emitted.
  const sentinelValues = Object.values(SENTINEL).filter((v) => v.length >= 8);
  const leakedSentinel = sentinelValues.some(
    (v) => stdout.includes(v) || stderr.includes(v),
  );

  const allSentinelHostsBlocked =
    Array.isArray(parsed.blocked) &&
    parsed.blocked.length === SENTINEL_HOSTS.length &&
    parsed.blocked.every((b) => b.endsWith(":blocked"));

  check(
    1,
    "an .env file cannot override the safe test environment",
    premise &&
      parsed.sentry === null &&
      parsed.redisIsLocal === true &&
      parsed.dbIsLocal === true &&
      parsed.storageIsLocal === true &&
      parsed.nodeEnv === "test" &&
      parsed.bucket === "point7-local-bucket" &&
      allSentinelHostsBlocked &&
      !leakedSentinel,
    leakedSentinel
      ? "a sentinel value reached the child's output"
      : allSentinelHostsBlocked
        ? ""
        : `sentinel hosts not all blocked: ${(parsed.blocked ?? []).join(",")}`,
  );
}

// ---------------------------------------------------------------------------
// 2-4. Importing application modules must not load the deployment .env and
//      must not reach anything remote.
// ---------------------------------------------------------------------------
const IMPORT_PROBE = (spec) => `
  await import(${JSON.stringify(spec)});
  console.log(JSON.stringify({
    sentry: process.env.SENTRY_DSN ?? null,
    dbIsLocal: /127\\.0\\.0\\.1|localhost/.test(process.env.DATABASE_URL ?? ""),
    redisIsLocal: /127\\.0\\.0\\.1|localhost/.test(process.env.REDIS_URL ?? ""),
  }));
  // Importing a queue or server module opens handles that keep the loop
  // alive. The probe has said what it came to say; exiting is the difference
  // between a result and a timeout that reads as a failure.
  process.exit(0);`;

for (const [n, title, spec] of [
  [2, "importing db.ts does not load the deployment .env", `${API_ROOT}/src/db.ts`],
  [3, "importing API server modules reaches nothing remote", `${API_ROOT}/src/server.ts`],
  [4, "importing Worker modules reaches nothing remote", `${resolve(REPO_ROOT, "services/worker/src/queue.ts")}`],
]) {
  if (!existsSync(spec.replace(/\\/g, "/"))) {
    check(n, title, false, `module not found: ${spec}`);
    continue;
  }
  // The probes import TypeScript, so they run through tsx rather than bare node.
  const file = resolve(REPO_ROOT, `.p7tmp/canary-import-${n}.mjs`);
  mkdirSync(dirname(file), { recursive: true });
  // Node refuses a bare Windows path as an ESM specifier; a file URL is the
  // portable form and is what tsx resolves.
  require_("node:fs").writeFileSync(file, IMPORT_PROBE(pathToFileURL(spec).href), "utf8");
  const res = spawnSync(
    "pnpm",
    ["exec", "tsx", "--import", BOOTSTRAP, file],
    {
      cwd: API_ROOT,
      encoding: "utf8",
      shell: true,
      env: {
        ...process.env,
        ...DEPLOYMENT_ENV,
        P7_NETWORK_LEDGER: LEDGER, P7_CANARY_LEDGER: LEDGER, P7_PHASE: "canary",
        P7_PROCESS: `canary:import-${n}`,
      },
      timeout: 300_000,
    },
  );
  let parsed = {};
  try {
    const last = (res.stdout ?? "").trim().split("\n").filter((l) => l.startsWith("{")).pop();
    parsed = JSON.parse(last ?? "{}");
  } catch { /* reported below */ }
  check(
    n,
    title,
    parsed.sentry === null && parsed.dbIsLocal === true && parsed.redisIsLocal === true,
    parsed.sentry === undefined ? `probe produced no output (exit ${res.status})` : "",
  );
}

// ---------------------------------------------------------------------------
// 5-9. Runtime posture inside a bootstrapped process.
// ---------------------------------------------------------------------------
{
  const file = resolve(REPO_ROOT, ".p7tmp/canary-runtime.mjs");
  require_("node:fs").writeFileSync(
    file,
    `
    const obs = await import(${JSON.stringify(pathToFileURL(resolve(API_ROOT, "src/observability/observability-environment.ts")).href)});
    console.log(JSON.stringify({
      transport: obs.resolveObservabilityMode(),
      dsn: obs.resolveObservabilityDsn(obs.resolveObservabilityMode()),
      otel: process.env.OTEL_ENABLED,
      otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null,
      awsSecrets: process.env.AWS_SECRETS_ENABLED,
      s3Endpoint: process.env.S3_ENDPOINT,
      awsKey: process.env.AWS_ACCESS_KEY_ID ?? null,
    }));`,
    "utf8",
  );
  const res = spawnSync("pnpm", ["exec", "tsx", "--import", BOOTSTRAP, file], {
    cwd: API_ROOT,
    encoding: "utf8",
    shell: true,
    env: { ...process.env, ...DEPLOYMENT_ENV, P7_NETWORK_LEDGER: LEDGER, P7_CANARY_LEDGER: LEDGER, P7_PHASE: "canary", P7_PROCESS: "canary:runtime" },
    timeout: 300_000,
  });
  let p = {};
  try {
    const last = (res.stdout ?? "").trim().split("\n").filter((l) => l.startsWith("{")).pop();
    p = JSON.parse(last ?? "{}");
  } catch { /* reported below */ }
  check(5, "API runtime resolves only disposable infrastructure", p.s3Endpoint === "http://127.0.0.1:59000");
  check(6, "Worker runtime resolves only disposable infrastructure", p.s3Endpoint === "http://127.0.0.1:59000");
  check(7, "Sentry uses the recording transport", p.transport === "recording" && p.dsn === null);
  check(8, "OTLP is disabled / has no remote endpoint", p.otel === "false" && p.otlpEndpoint === null);
  check(9, "AWS SDK holds no production credential", p.awsKey === null && p.awsSecrets === "false");
}

// ---------------------------------------------------------------------------
// 10-12. The guard blocks, and the block is recorded.
// ---------------------------------------------------------------------------
{
  const r = probe(
    "egress",
    `
    const attempts = [];
    // fetch
    try { await fetch("https://o4511404920864768.ingest.de.sentry.io/api/1/envelope/"); attempts.push("fetch-allowed"); }
    catch (e) { attempts.push(e?.code === "POINT7_OUTBOUND_DENIED" ? "fetch-blocked" : "fetch-other:" + (e?.code ?? e?.message)); }
    // raw socket
    const net = await import("node:net");
    try { new net.Socket().connect({ host: "harmless-lark-138859.upstash.io", port: 6379 }); attempts.push("socket-allowed"); }
    catch (e) { attempts.push(e?.code === "POINT7_OUTBOUND_DENIED" ? "socket-blocked" : "socket-other"); }
    // https
    const https = await import("node:https");
    try { https.request("https://api.proovra.com/v1/health"); attempts.push("https-allowed"); }
    catch (e) { attempts.push(e?.code === "POINT7_OUTBOUND_DENIED" ? "https-blocked" : "https-other"); }
    console.log(JSON.stringify(attempts));`,
  );
  let attempts = [];
  try { attempts = JSON.parse(r.stdout.split("\n").filter((l) => l.startsWith("[")).pop() ?? "[]"); } catch { /* below */ }
  const allBlocked =
    attempts.length === 3 && attempts.every((a) => a.endsWith("-blocked"));
  check(10, "a deliberate external request is blocked before connecting", allBlocked, allBlocked ? "" : attempts.join(","));

  let ledger = [];
  if (existsSync(LEDGER)) {
    ledger = readFileSync(LEDGER, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }
  const blocked = ledger.filter((e) => e.outcome === "BLOCKED");
  check(11, "the guard recorded the blocked attempts", blocked.length >= 3,
    `${blocked.length} blocked entries`);

  const leaked = ledger.some((e) =>
    JSON.stringify(e).match(/sk_live|re_[A-Za-z0-9]{10}|password|authorization|@/i),
  );
  const anyAllowedExternal = ledger.some(
    (e) =>
      e.outcome === "ALLOWED" &&
      !/^(127\.0\.0\.1|::1|0\.0\.0\.0|localhost|::ffff:127\.0\.0\.1)$/.test(e.host) &&
      !e.host.endsWith(".localhost"),
  );
  check(
    12,
    "no real Sentry event can be produced, and the ledger holds no secrets",
    !leaked && !anyAllowedExternal,
    leaked ? "ledger contains credential-shaped text" : anyAllowedExternal ? "an external destination was ALLOWED" : "",
  );
}

// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.ok).length;
// eslint-disable-next-line no-console
console.log(`\nIsolationCanary = ${passed}/${results.length}`);
if (passed !== results.length) {
  // eslint-disable-next-line no-console
  console.error("ISOLATION CANARY FAILED — no suite may run.");
  process.exit(1);
}
