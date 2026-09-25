/**
 * Operations › Quotas & usage — render test of the REAL screen
 * (`app/(stack)/operations/quotas.tsx`, web `operations/quotas/page.tsx`).
 *
 * Every payload is the server's own reply, from
 * `services/api/src/routes/enterprise.routes.ts`:
 *   GET /v1/quotas       → `{ data }`, data = getRealQuotas(): four lines
 *                          { limit, used, remaining } and `resetDate` on
 *                          `analyses` only.
 *   GET /v1/usage-stats  → `{ data }`, data = getRealUsageStats():
 *                          dailyAnalyses{today,thisWeek,thisMonth},
 *                          costBreakdown{totalCost,thisMonth,averagePerAnalysis},
 *                          topEvidenceTypes, activeApiKeys, activeBatches.
 * Both are user-scoped (no teamId) and gated by requireAuthAndLegal, whose
 * refusal is 428 LEGAL_REACCEPT_REQUIRED (require-legal-acceptance.ts).
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let routes = {};
let requests = [];

const reply = (status, body) => ({ __status: status, body });

const quotasBody = () => ({
  data: {
    analyses: { limit: 10000, used: 9500, remaining: 500, resetDate: "2026-10-01T00:00:00.000Z" },
    batchJobs: { limit: 100, used: 75, remaining: 25 },
    apiKeys: { limit: 50, used: 3, remaining: 47 },
    teamMembers: { limit: 10, used: 4, remaining: 6 },
  },
});
const usageBody = () => ({
  data: {
    dailyAnalyses: { today: 12, thisWeek: 40, thisMonth: 95 },
    costBreakdown: { totalCost: 21.5, thisMonth: 9.5, averagePerAnalysis: 0.1 },
    topEvidenceTypes: { photo: 30, video: 5 },
    activeApiKeys: 3,
    activeBatches: 1,
  },
});

before(async () => {
  M = await loadModule("app/(stack)/operations/quotas.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  M.calls.push.length = 0;
  routes = {
    ...authenticatedRoutes(),
    "/v1/quotas": () => quotasBody(),
    "/v1/usage-stats": () => usageBody(),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, method: init.method ?? "GET" });
    const bare = path.split("?")[0];
    const res = routes[bare] ? routes[bare](init) : undefined;
    const status = res === undefined ? 404 : res.__status ?? 200;
    const body = res && "__status" in res ? res.body : res ?? {};
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  return r;
};
const screenCalls = () => requests.filter((q) => q.path.startsWith("/v1/quotas") || q.path.startsWith("/v1/usage-stats"));

test("reads both canonical sources exactly as the server routes them — GET, no query, no workspace param", async () => {
  const r = await render();
  assert.deepEqual(
    screenCalls().map((q) => `${q.method} ${q.path}`).sort(),
    ["GET /v1/quotas", "GET /v1/usage-stats"],
  );
  r.unmount();
});

test("loaded: the four allowance lines in the web's order, with counts, bands, remaining and the analyses reset", async () => {
  const r = await render();
  const bars = r.byRole("progressbar").map((n) => n.props.accessibilityLabel).filter((l) => l.includes("% used"));
  assert.deepEqual(bars, [
    "Analysis API Calls: 95% used",
    "Batch Jobs: 75% used",
    "API Keys: 6% used",
    "Team Members: 40% used",
  ]);
  assert.ok(r.hasText("9500 / 10000"));
  assert.ok(r.hasText("500 remaining"));
  assert.ok(r.hasText("25 remaining") && r.hasText("47 remaining") && r.hasText("6 remaining"));
  // resetDate is sent on `analyses` only (enterprise.routes.ts getRealQuotas).
  assert.equal(r.texts().filter((t) => t.startsWith("Quotas reset on ")).length, 1);
  r.unmount();
});

test("loaded: the analysis counters and costs come from dailyAnalyses / costBreakdown", async () => {
  const r = await render();
  for (const [label, value] of [["Today", "12"], ["This Week", "40"], ["This Month", "95"], ["Average Per Analysis", "$0.1000"]]) {
    assert.ok(r.hasText(label), label);
    assert.ok(r.hasText(value), value);
  }
  assert.ok(r.hasText("Total Cost") && r.hasText("$21.50"));
  r.unmount();
});

test("empty: a fresh account (the server's zero state) shows 0% bars and zero counters — not an error, not a blank", async () => {
  routes["/v1/quotas"] = () => ({
    data: {
      analyses: { limit: 10000, used: 0, remaining: 10000, resetDate: "2026-10-01T00:00:00.000Z" },
      batchJobs: { limit: 100, used: 0, remaining: 100 },
      apiKeys: { limit: 50, used: 0, remaining: 50 },
      teamMembers: { limit: 10, used: 0, remaining: 10 },
    },
  });
  // getRealUsageStats sends averagePerAnalysis: 0 (not null) when there were none.
  routes["/v1/usage-stats"] = () => ({
    data: {
      dailyAnalyses: { today: 0, thisWeek: 0, thisMonth: 0 },
      costBreakdown: { totalCost: 0, thisMonth: 0, averagePerAnalysis: 0 },
      topEvidenceTypes: {},
      activeApiKeys: 0,
      activeBatches: 0,
    },
  });
  const r = await render();
  const bars = r.byRole("progressbar").map((n) => n.props.accessibilityLabel).filter((l) => l.includes("% used"));
  assert.equal(bars.length, 4);
  assert.ok(bars.every((l) => l.endsWith(": 0% used")), bars.join(" | "));
  assert.ok(r.hasText("$0.0000"));
  assert.ok(r.hasText("$0.00"));
  assert.ok(!r.hasText("Something went wrong"));
  r.unmount();
});

test("a usage failure is stated and does not blank the allowances; Try again re-reads both", async () => {
  routes["/v1/usage-stats"] = () => reply(500, { error: { code: "INTERNAL_SERVER_ERROR", message: "Failed to load usage statistics" } });
  const r = await render();
  assert.ok(r.hasText("Usage could not be loaded."));
  assert.ok(!r.hasText("Allowances could not be loaded."));
  assert.equal(r.byRole("progressbar").filter((n) => String(n.props.accessibilityLabel).includes("% used")).length, 4);
  assert.ok(!r.hasText("Today"), "zeroes were rendered for a read that failed");

  routes["/v1/usage-stats"] = () => usageBody();
  const before = screenCalls().length;
  await r.press("Try again");
  await settle();
  assert.deepEqual(screenCalls().slice(before).map((q) => q.path).sort(), ["/v1/quotas", "/v1/usage-stats"]);
  assert.ok(!r.hasText("Usage could not be loaded."));
  assert.ok(r.hasText("$21.50"));
  r.unmount();
});

test("a quotas failure is stated and the usage still renders", async () => {
  routes["/v1/quotas"] = () => reply(500, { error: { code: "INTERNAL_SERVER_ERROR", message: "Failed to load quotas" } });
  const r = await render();
  assert.ok(r.hasText("Allowances could not be loaded."));
  assert.ok(r.hasText("$21.50"));
  assert.ok(!r.texts().some((t) => t.includes("Failed to load quotas")), "the raw server message leaked");
  r.unmount();
});

test("the legal gate (428 LEGAL_REACCEPT_REQUIRED) routes to acceptance and both sections say they could not load", async () => {
  const gate = () =>
    reply(428, {
      error: {
        code: "LEGAL_REACCEPT_REQUIRED",
        message: "You must accept the latest legal policies before continuing.",
        requestId: "req-1",
        details: { missingPolicies: ["terms"], acceptedVersions: {}, requiredVersions: { terms: "2026-09" } },
      },
    });
  routes["/v1/quotas"] = gate;
  routes["/v1/usage-stats"] = gate;
  const r = await render();
  assert.ok(r.hasText("Allowances could not be loaded."));
  assert.ok(r.hasText("Usage could not be loaded."));
  assert.ok(
    M.calls.push.some((c) => c && c.pathname === "/legal-acceptance" && c.params?.policies === "terms"),
    `no legal-acceptance navigation: ${JSON.stringify(M.calls.push)}`,
  );
  r.unmount();
});

test("Back returns to the previous screen", async () => {
  const r = await render();
  const before = M.calls.back;
  await r.press("Back");
  assert.equal(M.calls.back, before + 1);
  r.unmount();
});

/* ---- web parity: the rest of the web page (operations/quotas/page.tsx) ---- */

test("the header, usage-card and quota-card copy is the web's", async () => {
  const r = await render();
  assert.ok(r.hasText("USAGE & QUOTAS"));
  assert.ok(r.hasText("Monitor platform usage and current limits."));
  assert.ok(r.hasText("Review analysis activity, cost metrics, quota consumption, and active service usage from one dashboard."));
  for (const t of ["Analyses processed today", "Analyses processed this week", "Analyses processed this month", "Average AI analysis cost"]) assert.ok(r.hasText(t), t);
  for (const t of ["Analysis Calls", "Batch Jobs", "API Keys", "Team Members"]) assert.ok(r.hasText(t), t);
  assert.ok(r.hasText("9500 / 10000 used · 500 remaining"));
  assert.ok(r.hasText("Current Quotas"));
  r.unmount();
});

test("Cost Overview, Active Services and Evidence Types Analyzed come from usage-stats", async () => {
  const r = await render();
  assert.equal(r.byTestId("cost-overview").length, 1);
  assert.ok(r.hasText("Total Cost") && r.hasText("$21.50") && r.hasText("$9.50"));
  assert.equal(r.byTestId("active-services").length, 1);
  assert.ok(r.hasText("Active API Keys") && r.hasText("Active Batch Jobs"));
  assert.equal(r.byTestId("evidence-types").length, 1);
  assert.ok(r.hasText("Evidence Types Analyzed") && r.hasText("photo") && r.hasText("30") && r.hasText("video"));
  r.unmount();
});

test("no evidence types analysed: the web omits that card", async () => {
  routes["/v1/usage-stats"] = () => ({ data: { ...usageBody().data, topEvidenceTypes: {} } });
  const r = await render();
  assert.equal(r.byTestId("evidence-types").length, 0);
  assert.equal(r.byTestId("active-services").length, 1);
  r.unmount();
});
