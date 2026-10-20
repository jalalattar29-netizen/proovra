#!/usr/bin/env node
/**
 * FORWARD EVIDENCE MUTATION SUITE (AUD-33, 2026-10-20).
 *
 *   node scripts/mutation/run-mutations.mjs <catalog.json> [--only=ID,ID] [--skip-integration | --integration-only] [--check-anchors]
 *
 * The catalog (scripts/mutation/forward-evidence-mutations.json) holds one
 * entry per re-introduced defect the forward remediation removed:
 *
 *   { id, aud, name, file, find, replace, build?: ["shared"|"shared-runtime"],
 *     tests: [{ cwd, cmd, args, env?, integration? }] }
 *
 * Each mutation is applied to the source (exactly one textual match is
 * required — a missing or ambiguous anchor FAILS the suite rather than passing
 * silently), its tests run, and the source is ALWAYS restored (rebuilding what
 * it rebuilt). A mutation is KILLED when any of its tests fails against a
 * GREEN baseline. The suite exits 1 when any mutation survives, any anchor is
 * missing, any baseline is red, or the worktree is not byte-identical after.
 *
 * --check-anchors applies nothing and runs nothing: it proves every anchor
 * still matches exactly once (a fast per-push gate that keeps the catalog
 * honest as the code moves).
 *
 * Integration tests need the API integration infrastructure (Postgres via
 * TEST_DATABASE_URL or testcontainers, Redis on P7_TEST_REDIS_URL, MinIO on
 * P7_HOST_S3_PORT); with --skip-integration their mutations are reported as
 * SKIPPED, never as killed.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLACEHOLDER_DB = "postgresql://placeholder:placeholder@127.0.0.1:1/placeholder_test";

/**
 * Children inherit only what a test run needs — never production credentials.
 * TEST_DATABASE_URL / RUN_LIVE_INTEGRATION_NO_TESTCONTAINERS name a disposable
 * database (the harness refuses any name without "test").
 */
const CHILD_ENV_ALLOW = /^(PATH|Path|PATHEXT|SystemRoot|SYSTEMROOT|windir|ComSpec|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|HOMEDRIVE|HOMEPATH|PROGRAMFILES|ProgramFiles|ProgramData|CommonProgramFiles|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS|LANG|TERM|CI|DOCKER_HOST|TESTCONTAINERS_.*|P7_.*|PNPM_HOME|npm_config_.*|TEST_DATABASE_URL|RUN_LIVE_INTEGRATION_NO_TESTCONTAINERS|PUPPETEER_EXECUTABLE_PATH|AUTH_JWT_SECRET)$/;

function childEnv(extra) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => CHILD_ENV_ALLOW.test(k)));
  return Object.assign(env, { DATABASE_URL: PLACEHOLDER_DB }, extra ?? {});
}

function run(t) {
  const r = spawnSync(t.cmd, t.args, {
    cwd: join(ROOT, t.cwd),
    encoding: "utf8",
    shell: process.platform === "win32",
    env: childEnv(t.env),
    maxBuffer: 256 * 1024 * 1024,
  });
  return r.status;
}

function build(pkg) {
  const r = spawnSync("pnpm", ["build"], { cwd: join(ROOT, "packages", pkg), encoding: "utf8", shell: process.platform === "win32" });
  return r.status === 0;
}

function gitStatus() {
  return spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).stdout;
}

function main() {
  const catalogPath = process.argv[2];
  if (!catalogPath || catalogPath.startsWith("--")) {
    console.error("usage: run-mutations.mjs <catalog.json> [--only=ID,ID] [--skip-integration | --integration-only] [--check-anchors]");
    process.exit(2);
  }
  const catalog = JSON.parse(readFileSync(resolve(ROOT, catalogPath), "utf8"));
  const onlyArg = process.argv.find((a) => a.startsWith("--only="));
  const only = onlyArg ? new Set(onlyArg.slice(7).split(",")) : null;
  const skipIntegration = process.argv.includes("--skip-integration");
  const checkAnchors = process.argv.includes("--check-anchors");
  // The CI split: unit mutants on every push (ci.yml), the integration mutants
  // in their own job with the disposable stack (forward-mutation.yml).
  const integrationOnly = process.argv.includes("--integration-only");
  const before = gitStatus();
  const baselines = new Map();
  const baseline = (t) => {
    const key = JSON.stringify([t.cwd, t.cmd, t.args, t.env ?? null]);
    if (!baselines.has(key)) baselines.set(key, run(t));
    return baselines.get(key);
  };
  const results = [];
  for (const m of catalog) {
    if (only && !only.has(m.id)) continue;
    if (integrationOnly && !m.tests.some((t) => t.integration)) continue;
    const path = join(ROOT, m.file);
    let original;
    try {
      original = readFileSync(path, "utf8");
    } catch {
      results.push({ id: m.id, name: m.name, outcome: "ANCHOR_MISSING (file)" });
      continue;
    }
    const count = original.split(m.find).length - 1;
    if (count !== 1) {
      results.push({ id: m.id, name: m.name, outcome: `ANCHOR_MISSING (${count} matches)` });
      continue;
    }
    if (checkAnchors) {
      results.push({ id: m.id, name: m.name, outcome: "ANCHOR_OK" });
      continue;
    }
    const runnable = m.tests.filter((t) => !(skipIntegration && t.integration));
    if (runnable.length === 0) {
      results.push({ id: m.id, name: m.name, outcome: "SKIPPED (integration)" });
      continue;
    }
    const red = runnable.find((t) => baseline(t) !== 0);
    if (red) {
      results.push({ id: m.id, name: m.name, outcome: `BASELINE_RED (${red.cwd}: ${red.args.slice(-1)[0]})` });
      console.log(`[mutation ${m.id}] BASELINE_RED — ${m.name}`);
      continue;
    }
    let killedBy = null;
    try {
      writeFileSync(path, original.replace(m.find, () => m.replace));
      for (const pkg of m.build ?? []) {
        if (!build(pkg)) {
          killedBy = "MUTATION_DID_NOT_BUILD";
          break;
        }
      }
      if (!killedBy) {
        for (const t of runnable) {
          if (run(t) !== 0) {
            killedBy = `${t.cwd}: ${t.args.filter((a) => !a.startsWith("-")).slice(-1).join(" ")}`;
            break;
          }
        }
      }
    } finally {
      writeFileSync(path, original);
      for (const pkg of m.build ?? []) build(pkg);
    }
    const outcome = killedBy === "MUTATION_DID_NOT_BUILD" ? "MUTATION_DID_NOT_BUILD" : killedBy ? "KILLED" : "SURVIVED";
    results.push({ id: m.id, aud: m.aud, name: m.name, outcome, killedBy });
    console.log(`[mutation ${m.id}] ${outcome} — ${m.name}${killedBy ? ` (${killedBy})` : ""}`);
  }
  const after = gitStatus();
  console.log(JSON.stringify(results, null, 2));
  const counts = results.reduce((a, r) => ((a[r.outcome.split(" ")[0]] = (a[r.outcome.split(" ")[0]] ?? 0) + 1), a), {});
  console.log("summary:", JSON.stringify(counts));
  const ok = checkAnchors ? "ANCHOR_OK" : "KILLED";
  const bad = results.filter((r) => r.outcome !== ok && !r.outcome.startsWith("SKIPPED"));
  if (after !== before) {
    console.error("::error::the worktree changed during the mutation run");
    process.exitCode = 1;
    return;
  }
  process.exitCode = bad.length > 0 ? 1 : 0;
}

main();
