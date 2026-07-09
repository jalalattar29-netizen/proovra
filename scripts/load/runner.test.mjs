// scripts/load/runner.test.mjs
//
// Unit tests for the load-test baseline runner. Uses only node:test /
// node:assert (built-in) — no dependency, no live server hit. Run with:
//   node --test scripts/load/runner.test.mjs
//
// Proves: prod guard refuses by default, config validation rejects missing
// required config, report schema has the expected keys, and tokens are
// redacted (never logged raw).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  redactToken,
  evaluateProdGuard,
  buildConfig,
  validateConfig,
  percentile,
  summarizeEndpoint,
  buildReport,
  resolvePath,
  DEFAULT_BASE_URL,
} from "./runner.mjs";
import { SCENARIOS, syntheticInviteBody, syntheticCsvBody } from "./scenarios.mjs";

// ---------------------------------------------------------------------------
// Production guard
// ---------------------------------------------------------------------------

test("prod guard: localhost is allowed", () => {
  const g = evaluateProdGuard({ baseUrl: DEFAULT_BASE_URL, nodeEnv: "test", allowProd: false });
  assert.equal(g.blocked, false);
  assert.equal(g.isProdLike, false);
});

test("prod guard: prod-looking host is blocked by default", () => {
  const g = evaluateProdGuard({
    baseUrl: "https://api.proovra.com",
    nodeEnv: "development",
    allowProd: false,
  });
  assert.equal(g.isProdLike, true);
  assert.equal(g.blocked, true);
  assert.ok(g.reasons.some((r) => r.includes("production")));
});

test("prod guard: NODE_ENV=production blocked even on localhost", () => {
  const g = evaluateProdGuard({
    baseUrl: DEFAULT_BASE_URL,
    nodeEnv: "production",
    allowProd: false,
  });
  assert.equal(g.blocked, true);
  assert.ok(g.reasons.some((r) => r.includes("NODE_ENV")));
});

test("prod guard: explicit allow flag unblocks prod-looking target", () => {
  const g = evaluateProdGuard({
    baseUrl: "https://api.proovra.com",
    nodeEnv: "production",
    allowProd: true,
  });
  assert.equal(g.isProdLike, true);
  assert.equal(g.blocked, false);
});

test("prod guard: staging host is not treated as production", () => {
  const g = evaluateProdGuard({
    baseUrl: "https://api.staging.proovra.com",
    nodeEnv: "staging",
    allowProd: false,
  });
  assert.equal(g.blocked, false);
});

test("prod guard: unparseable URL is treated as unsafe (blocked)", () => {
  const g = evaluateProdGuard({ baseUrl: "not a url", nodeEnv: "test", allowProd: false });
  assert.equal(g.blocked, true);
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

test("config validation: rejects missing token for authed scenarios", () => {
  const config = buildConfig({}); // no token/org/team
  const errors = validateConfig(config, SCENARIOS);
  assert.ok(errors.some((e) => e.includes("LOAD_TEST_TOKEN")));
  assert.ok(errors.some((e) => e.includes("LOAD_TEST_ORG_ID")));
  assert.ok(errors.some((e) => e.includes("LOAD_TEST_TEAM_ID")));
});

test("config validation: passes when all required config present", () => {
  const config = buildConfig({
    LOAD_TEST_BASE_URL: "http://localhost:3001",
    LOAD_TEST_TOKEN: "abcd1234efgh5678",
    LOAD_TEST_ORG_ID: "org-uuid",
    LOAD_TEST_TEAM_ID: "team-uuid",
  });
  const errors = validateConfig(config, SCENARIOS);
  assert.deepEqual(errors, []);
});

test("config validation: public-only scenarios need no token", () => {
  const publicOnly = SCENARIOS.filter((s) => !s.auth);
  const errors = validateConfig(buildConfig({}), publicOnly);
  assert.deepEqual(errors, []);
});

test("config: file config overrides env defaults; allowProd bool honoured", () => {
  const config = buildConfig({}, { baseUrl: "http://localhost:9999", allowProd: true });
  assert.equal(config.baseUrl, "http://localhost:9999");
  assert.equal(config.allowProd, true);
});

// ---------------------------------------------------------------------------
// Percentiles & report schema
// ---------------------------------------------------------------------------

test("percentile: nearest-rank is correct", () => {
  const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(v, 50), 5);
  assert.equal(percentile(v, 95), 10);
  assert.equal(percentile(v, 99), 10);
  assert.equal(percentile([], 95), 0);
});

test("report schema: has p50/p95/p99/errorRate/throughput/perEndpoint", () => {
  const ep = summarizeEndpoint("healthz", {
    latencies: [10, 20, 30, 40],
    errors: 1,
    total: 5,
    wallMs: 1000,
  });
  const report = buildReport(
    { baseUrl: "http://localhost:3001", concurrency: 5, iterations: 50, durationMs: 0 },
    [ep],
    { startedAt: new Date().toISOString(), wallMs: 1000 },
  );

  // Aggregate keys.
  for (const k of ["p50", "p95", "p99", "errorRate", "throughput"]) {
    assert.ok(k in report.aggregate, `aggregate missing ${k}`);
  }
  assert.ok(Array.isArray(report.perEndpoint));
  // Per-endpoint keys.
  const e = report.perEndpoint[0];
  assert.ok("errorRate" in e && "throughput" in e);
  for (const k of ["p50", "p95", "p99"]) assert.ok(k in e.latencyMs, `latencyMs missing ${k}`);
  assert.equal(e.errorRate, 0.2); // 1 error / 5
  assert.equal(report.kind, "enterprise-load-test-baseline");
  // Target must be the plain URL and must NOT carry a token.
  assert.equal(report.target, "http://localhost:3001");
});

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

test("redactToken: never returns the raw token", () => {
  const secret = "supersecrettoken1234567890";
  const red = redactToken(secret);
  assert.ok(!red.includes(secret));
  assert.ok(!red.includes("secrettoken"));
  assert.ok(red.includes("redacted"));
  assert.equal(redactToken(undefined), "(none)");
  assert.equal(redactToken("short"), "****");
});

test("report never embeds the token anywhere in its JSON", () => {
  const config = buildConfig({
    LOAD_TEST_TOKEN: "TOKEN-SHOULD-NOT-APPEAR-1234",
    LOAD_TEST_ORG_ID: "org",
    LOAD_TEST_TEAM_ID: "team",
  });
  const ep = summarizeEndpoint("healthz", { latencies: [5], errors: 0, total: 1, wallMs: 100 });
  const report = buildReport(config, [ep], { startedAt: "x", wallMs: 100 });
  assert.ok(!JSON.stringify(report).includes(config.token));
});

// ---------------------------------------------------------------------------
// Synthetic data + path resolution
// ---------------------------------------------------------------------------

test("synthetic invite bodies use example.com only (never real data)", () => {
  const body = syntheticInviteBody(5);
  assert.equal(body.rows.length, 5);
  for (const r of body.rows) {
    assert.ok(r.email.startsWith("loadtest+"));
    assert.ok(r.email.endsWith("@example.com"));
  }
  const csv = syntheticCsvBody(3);
  assert.ok(csv.csv.includes("loadtest+1@example.com"));
  assert.ok(!/@(?!example\.com)/.test(csv.csv.replace("email,role", "")));
});

test("resolvePath: fills org/team and honours endpoint overrides", () => {
  const config = buildConfig(
    { LOAD_TEST_ORG_ID: "org-1", LOAD_TEST_TEAM_ID: "team-1" },
    { endpointOverrides: { report_status_poll: "/v1/custom/reports/status" } },
  );
  const audit = SCENARIOS.find((s) => s.name === "audit_events");
  assert.equal(resolvePath(audit, config), "/v1/orgs/org-1/audit-events?limit=25");

  const report = SCENARIOS.find((s) => s.name === "report_status_poll");
  assert.equal(resolvePath(report, config), "/v1/custom/reports/status");
});

test("scenarios: only GET or dry-run POSTs (no destructive writes)", () => {
  for (const s of SCENARIOS) {
    if (s.method === "POST") {
      assert.equal(s.dryRun, true, `POST scenario ${s.name} must be a dry-run`);
    }
  }
});
