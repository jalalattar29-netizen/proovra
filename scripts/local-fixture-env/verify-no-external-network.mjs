#!/usr/bin/env node
/**
 * MEASURE, DO NOT ARGUE: boot the fixture API and record every socket it opens.
 *
 * =============================================================================
 * WHY A MEASUREMENT AND NOT A REVIEW
 * =============================================================================
 * The incident that produced all of this was not caught by reading
 * configuration. The configuration looked fine to everyone who looked at it;
 * the process still performed an authenticated read of a private production S3
 * bucket and said so in its own startup log, where it went unread.
 *
 * "The environment contains no production values" is an argument about a data
 * structure. "The process opened seven sockets and all seven were to
 * localhost" is a fact about what happened. This produces the second kind.
 *
 * =============================================================================
 * WHAT IT DOES
 * =============================================================================
 * Boots the API through the canonical fixture launcher with
 * `scripts/local-fixture-env/record-connections.cjs` preloaded, waits for it to
 * listen, exercises a couple of routes, stops it, and fails if ANY recorded
 * connection or DNS lookup targeted something that is not this machine.
 *
 * Requires the local fixture Postgres to be up and migrated. If it is not, this
 * exits 3 (INFRASTRUCTURE) rather than 0, because a check that passes when it
 * could not run is worse than no check — it converts an unknown into a
 * reassurance, which is exactly how the original incident survived.
 *
 * Usage:
 *   node scripts/local-fixture-env/verify-no-external-network.mjs
 *   node scripts/local-fixture-env/verify-no-external-network.mjs --api-port=8191
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { LOCAL_FIXTURE_DEFAULTS } from "./index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const API_PORT = arg("api-port", LOCAL_FIXTURE_DEFAULTS.apiPort);
const DATABASE_URL = arg("database-url", LOCAL_FIXTURE_DEFAULTS.databaseUrl);
const REDIS_URL = arg("redis-url", LOCAL_FIXTURE_DEFAULTS.redisUrl);

const workDir = resolve(tmpdir(), "proovra-network-proof");
mkdirSync(workDir, { recursive: true });
const LOG = resolve(workDir, `connections-${process.pid}.jsonl`);
rmSync(LOG, { force: true });

const RECORDER = resolve(HERE, "record-connections.cjs");
if (!existsSync(RECORDER)) {
  console.error("verify-no-external-network: recorder missing");
  process.exit(3);
}

const child = spawn(
  process.execPath,
  [
    resolve(REPO, "services/api/scripts/dev-admin-fixture-api.mjs"),
    `--api-port=${API_PORT}`,
    `--database-url=${DATABASE_URL}`,
    `--redis-url=${REDIS_URL}`,
  ],
  {
    cwd: REPO,
    env: {
      ...process.env,
      PROOVRA_CONNECTION_LOG: LOG,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${RECORDER}`.trim(),
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let output = "";
child.stdout.on("data", (d) => (output += d.toString()));
child.stderr.on("data", (d) => (output += d.toString()));

async function waitForListening(deadlineMs) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    if (child.exitCode !== null) return false;
    try {
      const res = await fetch(`http://localhost:${API_PORT}/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

const listening = await waitForListening(90_000);

if (listening) {
  // Exercise a little surface so the check covers more than module import.
  for (const path of ["/health", "/v1/auth/me", "/v1/operations/signers"]) {
    try {
      await fetch(`http://localhost:${API_PORT}${path}`);
    } catch {
      /* a 401 or a refusal is fine; the point is that it was attempted */
    }
  }
}

/**
 * Kill the TREE, not the launcher.
 *
 * The launcher spawns tsx with `shell: true`, so `child.kill()` reaps the
 * shell and leaves the API listening — and its open pipes then keep THIS
 * process alive too. The first run hung for five minutes and left an orphan
 * holding the port, which is a worse outcome than the check simply failing.
 */
function killTree(pid) {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    /* already gone */
  }
}
killTree(child.pid);
child.stdout.destroy();
child.stderr.destroy();
child.unref();
await new Promise((r) => setTimeout(r, 1500));

if (!listening) {
  console.error(
    [
      "verify-no-external-network: INFRASTRUCTURE — the API never listened.",
      "  Is the fixture Postgres up and migrated?",
      `    ${DATABASE_URL}`,
      "",
      output.split("\n").slice(-25).join("\n"),
    ].join("\n"),
  );
  process.exit(3);
}

if (!existsSync(LOG)) {
  console.error(
    "verify-no-external-network: INFRASTRUCTURE — the recorder wrote nothing.\n" +
      "  PROOVRA_CONNECTION_LOG must survive into the child; it is on the\n" +
      "  allowlist in index.mjs for exactly this reason.",
  );
  process.exit(3);
}

const entries = readFileSync(LOG, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const external = entries.filter((e) => !e.local);
const summary = new Map();
for (const e of entries) {
  const key = `${e.kind} ${e.host}${e.port ? `:${e.port}` : ""}`;
  summary.set(key, (summary.get(key) ?? 0) + 1);
}

console.log("verify-no-external-network");
console.log(`  attempts  ${entries.length}`);
for (const [k, v] of [...summary].sort()) console.log(`    ${String(v).padStart(3)} x ${k}`);

if (external.length > 0) {
  console.error(
    [
      "",
      `  FAILED — ${external.length} attempt(s) left this machine:`,
      ...[...new Set(external.map((e) => `${e.kind} ${e.host}${e.port ? `:${e.port}` : ""}`))]
        .sort()
        .map((s) => `    ${s}`),
      "",
    ].join("\n"),
  );
  process.exit(1);
}

if (entries.length === 0) {
  // Zero recorded attempts means the hook did not run, not that the process
  // was quiet: it always talks to Postgres.
  console.error("\n  FAILED — no attempts recorded at all; the hook did not install.\n");
  process.exit(3);
}

console.log("  external  0\n");
rmSync(LOG, { force: true });
process.exit(0);
