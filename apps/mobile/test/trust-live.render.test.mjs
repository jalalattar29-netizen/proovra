/**
 * T-15 — Trust Center live data: the status projection (GET /v1/trust/status)
 * and the subprocessor REGISTRY (GET /v1/trust/subprocessors + per-vendor
 * versions). Native listed only "Status" / "Subprocessors" articles, so the
 * current health, incidents, maintenance, per-vendor region, data categories,
 * effective date and change history were all unreachable on a phone.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};

const STATUS = {
  status: {
    schemaVersion: "PROOVRA_STATUS_PAGE_V1",
    generatedAtUtc: "2026-09-24T10:00:00Z",
    upstreamProvider: "BETTER_STACK",
    overallHealth: "DEGRADED",
    components: [
      { key: "api", label: "API", health: "OPERATIONAL", description: "Public API", lastUpdatedUtc: "2026-09-24T09:59:00Z", upstreamSource: "better_stack", upstreamReference: null },
      { key: "storage", label: "Evidence storage", health: "DEGRADED", description: "Object storage", lastUpdatedUtc: "2026-09-24T09:58:00Z", upstreamSource: "better_stack", upstreamReference: null },
    ],
    activeIncidents: [
      { id: "inc-1", externalRef: null, title: "Slow uploads", severity: "MINOR", state: "MONITORING", componentKeys: ["storage"], startedAtUtc: "2026-09-24T08:00:00Z", resolvedAtUtc: null, postmortemUrl: null, updates: [{ id: "u1", body: "Throughput recovering.", state: "MONITORING", createdAtUtc: "2026-09-24T09:00:00Z" }] },
    ],
    recentIncidents: [],
    maintenanceWindows: [],
    limitations: ["STATUS_IS_ADVISORY"],
  },
};
const REGISTRY = {
  subprocessors: [
    { id: "sp-1", name: "Amazon Web Services", slug: "aws", vendor: "Amazon", purpose: "Hosting", region: "EU (Frankfurt)", dataCategories: ["EVIDENCE_CONTENT", "ACCOUNT_DATA"], state: "ACTIVE", effectiveAtUtc: "2026-01-01T00:00:00Z", documentationUrl: "https://aws.amazon.com/compliance/", contractRef: null, version: 3, changeHistorySummary: "" },
  ],
};

before(async () => {
  M = await loadModule("app/(stack)/trust-center.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  routes = {
    ...authenticatedRoutes(),
    "/v1/trust/articles": () => ({ articles: [] }),
    "/v1/trust/status": () => STATUS,
    "/v1/trust/subprocessors/sp-1/versions": () => ({
      versions: [
        { id: "v2", version: 2, changeSummary: "Region moved to EU.", snapshot: { state: "ACTIVE", region: "EU (Frankfurt)", dataCategories: ["EVIDENCE_CONTENT"], effectiveAtUtc: "2026-06-01T00:00:00Z" } },
        { id: "v3", version: 3, changeSummary: "Account data added.", snapshot: { state: "ACTIVE", region: "EU (Frankfurt)", dataCategories: ["EVIDENCE_CONTENT", "ACCOUNT_DATA"] } },
      ],
    }),
    "/v1/trust/subprocessors": () => REGISTRY,
  };
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push(path);
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key]() : undefined;
    const status = res === undefined ? 500 : res.__status ?? 200;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  return r;
};

test("Status shows the LIVE projection: overall health, components, incidents with updates, limitations", async () => {
  const r = await render();
  assert.ok(requests.includes("/v1/trust/status"), "the live status was never read");
  assert.ok(r.hasText("Overall health:"));
  assert.ok(r.hasText("Evidence storage") && r.hasText("Public API · Source better_stack"));
  assert.ok(r.hasText("Active incidents · 1") && r.hasText("Slow uploads"));
  assert.ok(r.hasText("MONITORING · ") && r.hasText("Throughput recovering."));
  assert.ok(r.hasText("None scheduled."));
  assert.ok(r.hasText("STATUS_IS_ADVISORY"));
});

test("a degraded status is said as degraded — never 'nothing configured'", async () => {
  routes["/v1/trust/status"] = () => ({ degraded: true, reason: "SCHEMA_NOT_READY" });
  const r = await render();
  assert.ok(r.hasText("Status page is degraded.") && r.hasText("SCHEMA_NOT_READY"));
  assert.ok(!r.hasText("No status components configured"));
});

test("the subprocessor REGISTRY shows region, data categories, effective date; history is newest first", async () => {
  const r = await render();
  assert.ok(r.hasText("Amazon Web Services"));
  assert.ok(r.hasText("Region EU (Frankfurt) · Active · v3"));
  assert.ok(r.hasText("Data categories: Evidence content, Account data"));
  assert.equal(r.byLabel("Vendor documentation").length, 1);
  await r.press("Change history for Amazon Web Services");
  await settle();
  const t = r.texts();
  const i3 = t.findIndex((x) => x.startsWith("Version 3"));
  const i2 = t.findIndex((x) => x.startsWith("Version 2"));
  assert.ok(i3 >= 0 && i2 > i3, "change history is not newest first");
  assert.ok(r.hasText("Region moved to EU."));
});

test("a degraded registry names its reason", async () => {
  routes["/v1/trust/subprocessors"] = () => ({ degraded: true, reason: "DB_UNAVAILABLE" });
  const r = await render();
  assert.ok(r.hasText("because the database is unavailable"));
});
