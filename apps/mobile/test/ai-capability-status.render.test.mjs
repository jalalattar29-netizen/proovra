/**
 * T-14 — AiCapabilityStatusTable (:118 Capability, :119 Provider, :122 Opt-in,
 * :123 Status) on the Trust Center AI disclosure section: the live
 * per-workspace capabilities from GET /v1/workspaces/ai-policy. Native listed
 * AI_DISCLOSURE articles only. A role refusal is not an outage.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn, TEST_TEAM_ID } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let routes = {};
let requests = [];
const CAP = (over = {}) => ({
  capability: "EVIDENCE_COPILOT", provider: "Anthropic", purpose: "Advisory review of metadata.", dataCategory: "METADATA_ONLY", rawContent: false,
  defaultState: "OFF", workspaceOptInRequired: true, globalConfigured: true, workspacePolicyState: "ENABLED",
  operationalStatus: "ENABLED_FOR_THIS_WORKSPACE", region: "EU", transferMechanism: "SCCs", trainingMode: "No training", retentionMode: "Zero retention",
  lastVerifiedAtUtc: "2026-09-24T08:00:00.000Z", note: "", ...over,
});

before(async () => {
  M = await loadModule("app/(stack)/trust-center.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  routes = {
    ...authenticatedRoutes(),
    "/v1/trust/articles": () => ({ articles: [] }),
    "/v1/trust/status": () => ({}),
    "/v1/trust/subprocessors": () => ({ subprocessors: [] }),
    // workspace-ai-policy.routes.ts: capabilities is top-level beside the policy.
    "/v1/workspaces/ai-policy": () => ({ policy: {}, version: 1, capabilities: [CAP(), CAP({ capability: "SEMANTIC_SEARCH", operationalStatus: "STUB_NOT_OPERATIONAL", workspaceOptInRequired: false })] }),
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
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  return r;
};

test("each capability states its provider, region, opt-in and the server's status", async () => {
  const r = await render();
  assert.ok(requests.includes(`/v1/workspaces/ai-policy?teamId=${TEST_TEAM_ID}`), "the live table was never read");
  assert.ok(r.hasText("Live AI capability status (this workspace)"));
  assert.ok(r.hasText("EVIDENCE_COPILOT"));
  assert.ok(r.hasText("Provider Anthropic · EU · SCCs"));
  assert.ok(r.hasText("Data metadata only · Default OFF · Opt-in required"));
  assert.ok(r.byLabel("enabled for this workspace").length === 1);
  assert.ok(r.byLabel("stub not operational").length === 1, "a stub was not labelled as a stub");
});

test("a role refusal says the disclosures still apply, not that something broke", async () => {
  routes["/v1/workspaces/ai-policy"] = () => ({ __status: 403, error: { code: "FORBIDDEN" } });
  const r = await render();
  assert.ok(r.hasText("Live capability status isn't shown for your role in this workspace. The disclosures below still apply."));
});

test("Trust Center carries the public page's seven-step trust flow (trust/page.tsx:904)", async () => {
  const r = await render();
  assert.equal(r.byTestId("trust-flow").length, 1);
  assert.ok(r.hasText("Step 01") && r.hasText("Capture / Intake"));
  assert.ok(r.hasText("Step 07") && r.hasText("External Inspection"));
});
