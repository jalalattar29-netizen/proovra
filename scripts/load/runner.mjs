#!/usr/bin/env node
// scripts/load/runner.mjs
//
// Enterprise LOAD-TEST BASELINE runner — plain Node ESM, zero dependencies
// (uses only built-in http/https, perf_hooks, process). Non-destructive:
// read-only + dry-run scenarios only (see scenarios.mjs / README.md).
//
// SAFETY:
//   * Refuses to run against a production-looking target unless
//     LOAD_TEST_ALLOW_PROD=true is explicitly set.
//   * Refuses to run when NODE_ENV==="production" without that same flag.
//   * Never logs the bearer token or raw response bodies — the token is
//     redacted anywhere config is echoed.
//
// Usage:
//   node scripts/load/runner.mjs --help
//   node scripts/load/runner.mjs --validate-config
//   node scripts/load/runner.mjs                 # run the baseline
//   node scripts/load/runner.mjs --config ./scripts/load/my.json
//
// Config (env, overridden by --config JSON file):
//   LOAD_TEST_BASE_URL   default http://localhost:3001
//   LOAD_TEST_TOKEN      bearer token (redacted in output); required for authed scenarios
//   LOAD_TEST_ORG_ID     required for org-scoped scenarios
//   LOAD_TEST_TEAM_ID    required for team-scoped scenarios
//   LOAD_TEST_CONCURRENCY  default 5
//   LOAD_TEST_ITERATIONS   requests per endpoint (default 50; ignored if duration set)
//   LOAD_TEST_DURATION_MS  run each endpoint for this long instead of a fixed count
//   LOAD_TEST_ALLOW_PROD   "true" to permit prod-looking targets
//   NODE_ENV

import http from "node:http";
import https from "node:https";
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// PURE, TESTABLE HELPERS (imported by scripts/load/runner.test.mjs)
// ---------------------------------------------------------------------------

export const DEFAULT_BASE_URL = "http://localhost:3001";

/**
 * Redact a bearer token for safe echoing. Never returns the raw secret.
 * @param {string | undefined | null} token
 * @returns {string}
 */
export function redactToken(token) {
  if (!token) return "(none)";
  const s = String(token);
  if (s.length <= 8) return "****";
  return `${s.slice(0, 4)}…${s.slice(-2)} (redacted, len=${s.length})`;
}

/**
 * Decide whether a target URL / environment looks like production.
 * Pure predicate — no I/O.
 * @param {{ baseUrl: string, nodeEnv?: string, allowProd?: boolean }} args
 * @returns {{ isProdLike: boolean, blocked: boolean, reasons: string[] }}
 */
export function evaluateProdGuard({ baseUrl, nodeEnv, allowProd }) {
  const reasons = [];
  let host = "";
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    // Unparseable URL is treated as unsafe (cannot prove it is local).
    reasons.push(`base URL is not a valid URL: ${baseUrl}`);
  }

  const isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.endsWith(".local") ||
    host.endsWith(".localhost");

  const looksProdHost =
    host !== "" &&
    !isLocal &&
    // Anything that isn't obviously a local/dev/staging host is treated as
    // prod-like. Staging carve-outs are opt-in via the substrings below.
    !/(^|[.-])(staging|stg|dev|test|qa|sandbox|preview|preprod|pre-prod)([.-]|$)/.test(host);

  if (looksProdHost) reasons.push(`target host "${host}" looks like production`);
  const nodeEnvProd = String(nodeEnv ?? "").toLowerCase() === "production";
  if (nodeEnvProd) reasons.push('NODE_ENV is "production"');

  const isProdLike = looksProdHost || nodeEnvProd || (host === "" && reasons.length > 0);
  const blocked = isProdLike && allowProd !== true;
  return { isProdLike, blocked, reasons };
}

/**
 * Parse raw env/CLI/file inputs into a normalised config object.
 * Pure — takes an env-like record, returns config; performs no I/O.
 * @param {Record<string, string | undefined>} env
 * @param {Record<string, unknown>} [fileConfig]
 */
export function buildConfig(env, fileConfig = {}) {
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  const pick = (envKey, fileKey) =>
    env[envKey] ?? (fileKey in fileConfig ? fileConfig[fileKey] : undefined);

  const durationRaw = pick("LOAD_TEST_DURATION_MS", "durationMs");
  const durationMs = durationRaw != null ? num(durationRaw, 0) : 0;

  return {
    baseUrl: String(pick("LOAD_TEST_BASE_URL", "baseUrl") ?? DEFAULT_BASE_URL),
    token: pick("LOAD_TEST_TOKEN", "token") ?? undefined,
    orgId: pick("LOAD_TEST_ORG_ID", "orgId") ?? undefined,
    teamId: pick("LOAD_TEST_TEAM_ID", "teamId") ?? undefined,
    concurrency: num(pick("LOAD_TEST_CONCURRENCY", "concurrency"), 5),
    iterations: num(pick("LOAD_TEST_ITERATIONS", "iterations"), 50),
    durationMs,
    allowProd: String(pick("LOAD_TEST_ALLOW_PROD", "allowProd") ?? "").toLowerCase() === "true"
      || fileConfig.allowProd === true,
    nodeEnv: env.NODE_ENV,
    bulkInviteRows: num(pick("LOAD_TEST_BULK_ROWS", "bulkInviteRows"), 5),
    endpointOverrides:
      (fileConfig.endpointOverrides && typeof fileConfig.endpointOverrides === "object"
        ? fileConfig.endpointOverrides
        : {}),
  };
}

/**
 * Validate config against the scenarios that will actually run.
 * Pure — returns a list of human-readable errors (empty = valid).
 * @param {ReturnType<typeof buildConfig>} config
 * @param {Array<any>} scenarios
 * @returns {string[]}
 */
export function validateConfig(config, scenarios) {
  const errors = [];
  const anyAuth = scenarios.some((s) => s.auth);
  const anyOrg = scenarios.some((s) => s.needsOrg);
  const anyTeam = scenarios.some((s) => s.needsTeam);

  if (anyAuth && !config.token) {
    errors.push(
      "LOAD_TEST_TOKEN is required because authenticated scenarios are enabled. " +
        "Set a bearer token, or restrict to public scenarios (healthz/readyz).",
    );
  }
  if (anyOrg && !config.orgId) {
    errors.push(
      "LOAD_TEST_ORG_ID is required because org-scoped scenarios are enabled " +
        "(e.g. audit-events, bulk-invite validate/CSV).",
    );
  }
  if (anyTeam && !config.teamId) {
    errors.push(
      "LOAD_TEST_TEAM_ID is required because team-scoped scenarios are enabled " +
        "(e.g. reviewer-ops queue/dashboard).",
    );
  }
  if (!(config.concurrency > 0)) errors.push("concurrency must be a positive number.");
  if (config.durationMs <= 0 && !(config.iterations > 0)) {
    errors.push("Either iterations (>0) or durationMs (>0) must be set.");
  }
  return errors;
}

/**
 * Compute a percentile (nearest-rank) from an array of numbers.
 * @param {number[]} values  latencies (any order)
 * @param {number} p         percentile in (0,100]
 * @returns {number}
 */
export function percentile(values, p) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

/**
 * Build a per-endpoint summary from raw samples.
 * @param {string} name
 * @param {{ latencies: number[], errors: number, total: number, wallMs: number }} agg
 */
export function summarizeEndpoint(name, agg) {
  const { latencies, errors, total, wallMs } = agg;
  const ok = latencies.length;
  const round = (n) => Math.round(n * 100) / 100;
  return {
    endpoint: name,
    requests: total,
    successful: ok,
    errors,
    errorRate: total > 0 ? round(errors / total) : 0,
    throughput: wallMs > 0 ? round((total / wallMs) * 1000) : 0, // req/s
    latencyMs: {
      min: ok ? round(Math.min(...latencies)) : 0,
      p50: round(percentile(latencies, 50)),
      p95: round(percentile(latencies, 95)),
      p99: round(percentile(latencies, 99)),
      max: ok ? round(Math.max(...latencies)) : 0,
    },
  };
}

/**
 * Assemble the full baseline report object from per-endpoint summaries.
 * Pure — no I/O. This is the canonical report schema.
 * @param {{ baseUrl: string, concurrency: number, iterations: number, durationMs: number }} config
 * @param {ReturnType<typeof summarizeEndpoint>[]} perEndpoint
 * @param {{ startedAt: string, wallMs: number }} meta
 */
export function buildReport(config, perEndpoint, meta) {
  const totalReq = perEndpoint.reduce((s, e) => s + e.requests, 0);
  const totalErr = perEndpoint.reduce((s, e) => s + e.errors, 0);
  const allLat = perEndpoint.flatMap((e) => [e.latencyMs.p50, e.latencyMs.p95, e.latencyMs.p99]);
  const round = (n) => Math.round(n * 100) / 100;
  return {
    schemaVersion: 1,
    kind: "enterprise-load-test-baseline",
    startedAt: meta.startedAt,
    durationMs: meta.wallMs,
    target: config.baseUrl, // never contains the token
    settings: {
      concurrency: config.concurrency,
      iterations: config.iterations,
      durationMs: config.durationMs,
    },
    totals: {
      requests: totalReq,
      errors: totalErr,
      errorRate: totalReq > 0 ? round(totalErr / totalReq) : 0,
      throughput: meta.wallMs > 0 ? round((totalReq / meta.wallMs) * 1000) : 0,
    },
    aggregate: {
      p50: round(percentile(allLat, 50)),
      p95: round(percentile(allLat, 95)),
      p99: round(percentile(allLat, 99)),
      errorRate: totalReq > 0 ? round(totalErr / totalReq) : 0,
      throughput: meta.wallMs > 0 ? round((totalReq / meta.wallMs) * 1000) : 0,
    },
    perEndpoint,
  };
}

/**
 * Resolve a scenario's path template against config (org/team/overrides).
 * @param {any} scenario
 * @param {ReturnType<typeof buildConfig>} config
 * @returns {string}
 */
export function resolvePath(scenario, config) {
  const override =
    scenario.configurable && config.endpointOverrides?.[scenario.name]
      ? String(config.endpointOverrides[scenario.name])
      : scenario.pathTemplate;
  return override
    .replaceAll(":orgId", encodeURIComponent(config.orgId ?? ""))
    .replaceAll(":teamId", encodeURIComponent(config.teamId ?? ""));
}

// ---------------------------------------------------------------------------
// I/O LAYER (not exercised by unit tests — never hits a server in tests)
// ---------------------------------------------------------------------------

/**
 * Fire a single HTTP(S) request; resolve with { ok, ms }. Never throws.
 */
function fireOnce(scenario, config) {
  return new Promise((resolve) => {
    const url = new URL(resolvePath(scenario, config), config.baseUrl);
    const lib = url.protocol === "https:" ? https : http;
    const headers = { accept: "application/json", ...(scenario.headers ?? {}) };
    if (scenario.auth && config.token) headers.authorization = `Bearer ${config.token}`;

    let payload;
    if (scenario.body) {
      const b = scenario.body(config);
      payload = typeof b === "string" ? b : JSON.stringify(b);
      if (!headers["content-type"]) headers["content-type"] = "application/json";
    }

    const start = performance.now();
    const req = lib.request(
      url,
      { method: scenario.method, headers, timeout: 15_000 },
      (res) => {
        // Drain body without retaining it (never log response bodies).
        res.on("data", () => {});
        res.on("end", () => {
          const ms = performance.now() - start;
          const ok = res.statusCode != null && res.statusCode < 500;
          resolve({ ok, ms, status: res.statusCode });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve({ ok: false, ms: performance.now() - start, status: 0 }));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Run one scenario under the configured load and return its aggregate. */
async function runScenario(scenario, config) {
  const latencies = [];
  let errors = 0;
  let total = 0;
  const deadline = config.durationMs > 0 ? performance.now() + config.durationMs : 0;
  const target = config.durationMs > 0 ? Infinity : config.iterations;
  const wallStart = performance.now();

  let launched = 0;
  async function worker() {
    while (launched < target && (deadline === 0 || performance.now() < deadline)) {
      launched++;
      const r = await fireOnce(scenario, config);
      total++;
      if (r.ok) latencies.push(r.ms);
      else errors++;
    }
  }
  await Promise.all(Array.from({ length: config.concurrency }, () => worker()));
  const wallMs = performance.now() - wallStart;
  return summarizeEndpoint(scenario.name, { latencies, errors, total, wallMs });
}

/** Load an optional --config JSON file. */
function loadFileConfig(argv) {
  const idx = argv.indexOf("--config");
  if (idx === -1 || !argv[idx + 1]) return {};
  try {
    return JSON.parse(readFileSync(argv[idx + 1], "utf8"));
  } catch (e) {
    console.error(`Failed to read --config file: ${e.message}`);
    process.exit(2);
  }
}

function printHelp() {
  console.log(
    [
      "Enterprise load-test baseline runner (read-only + dry-run only).",
      "",
      "Usage:",
      "  node scripts/load/runner.mjs --help",
      "  node scripts/load/runner.mjs --validate-config",
      "  node scripts/load/runner.mjs [--config <file.json>] [--out <report.json>]",
      "",
      "Config via env: LOAD_TEST_BASE_URL, LOAD_TEST_TOKEN, LOAD_TEST_ORG_ID,",
      "  LOAD_TEST_TEAM_ID, LOAD_TEST_CONCURRENCY, LOAD_TEST_ITERATIONS,",
      "  LOAD_TEST_DURATION_MS, LOAD_TEST_ALLOW_PROD.",
      "",
      "Refuses production-looking targets unless LOAD_TEST_ALLOW_PROD=true.",
      "See scripts/load/README.md for the safety contract.",
    ].join("\n"),
  );
}

function echoConfig(config) {
  console.log("Configuration:");
  console.log(`  target       : ${config.baseUrl}`);
  console.log(`  token        : ${redactToken(config.token)}`);
  console.log(`  orgId        : ${config.orgId ?? "(none)"}`);
  console.log(`  teamId       : ${config.teamId ?? "(none)"}`);
  console.log(`  concurrency  : ${config.concurrency}`);
  console.log(
    `  workload     : ${config.durationMs > 0 ? `${config.durationMs}ms/endpoint` : `${config.iterations} req/endpoint`}`,
  );
  console.log(`  allowProd    : ${config.allowProd}`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return 0;
  }

  const { SCENARIOS } = await import("./scenarios.mjs");
  const fileConfig = loadFileConfig(argv);
  const config = buildConfig(process.env, fileConfig);

  echoConfig(config);

  // --- Production guard: refuse before any traffic is sent. ---
  const guard = evaluateProdGuard({
    baseUrl: config.baseUrl,
    nodeEnv: config.nodeEnv,
    allowProd: config.allowProd,
  });
  if (guard.blocked) {
    console.error("\nREFUSING TO RUN: target looks like production.");
    for (const r of guard.reasons) console.error(`  - ${r}`);
    console.error(
      "\nThis runner is for local/staging baselines only. If you REALLY intend to " +
        "run against this target, set LOAD_TEST_ALLOW_PROD=true explicitly.",
    );
    return 3;
  }

  const errors = validateConfig(config, SCENARIOS);
  if (errors.length > 0) {
    console.error("\nConfiguration invalid:");
    for (const e of errors) console.error(`  - ${e}`);
    return 4;
  }

  if (argv.includes("--validate-config")) {
    console.log("\nConfig OK. Prod guard OK. (No traffic sent — --validate-config.)");
    return 0;
  }

  console.log(`\nRunning ${SCENARIOS.length} scenarios...\n`);
  const startedAt = new Date().toISOString();
  const wallStart = performance.now();
  const perEndpoint = [];
  for (const scenario of SCENARIOS) {
    process.stdout.write(`  ${scenario.name} ... `);
    const summary = await runScenario(scenario, config);
    perEndpoint.push(summary);
    console.log(
      `${summary.requests} req, ${(summary.errorRate * 100).toFixed(1)}% err, ` +
        `p95 ${summary.latencyMs.p95}ms, ${summary.throughput} req/s`,
    );
  }
  const wallMs = performance.now() - wallStart;
  const report = buildReport(config, perEndpoint, { startedAt, wallMs });

  // Write JSON report if requested.
  const outIdx = argv.indexOf("--out");
  if (outIdx !== -1 && argv[outIdx + 1]) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(argv[outIdx + 1], JSON.stringify(report, null, 2));
    console.log(`\nBaseline report written to ${argv[outIdx + 1]}`);
  }

  console.log("\n=== Baseline summary ===");
  console.log(
    `Total: ${report.totals.requests} req, ${(report.totals.errorRate * 100).toFixed(1)}% error, ` +
      `${report.totals.throughput} req/s`,
  );
  console.log(
    `Aggregate latency (across endpoint p-values): p50 ${report.aggregate.p50}ms, ` +
      `p95 ${report.aggregate.p95}ms, p99 ${report.aggregate.p99}ms`,
  );
  console.log("\nJSON report:");
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

// Only run main() when invoked directly (not when imported by tests).
// Compare resolved paths (cross-platform; avoids file:// URL quirks on Windows).
let invokedDirectly = false;
try {
  const { fileURLToPath } = await import("node:url");
  const { resolve } = await import("node:path");
  invokedDirectly =
    process.argv[1] != null &&
    resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
} catch {
  invokedDirectly = false;
}

if (invokedDirectly) {
  main()
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      console.error(`Fatal: ${err?.message ?? err}`);
      process.exit(1);
    });
}
