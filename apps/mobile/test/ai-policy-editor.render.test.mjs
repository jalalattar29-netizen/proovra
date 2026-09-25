/**
 * T-15 — Settings → AI editing (PUT /v1/workspaces/ai-policy) and usage
 * (GET /v1/workspaces/ai-usage). Native was read-only for everyone; the web
 * lets the people the server allows change the policy. Switches appear only
 * where the web shows them and only when the server returned the editable
 * envelope; a 403 leaves the read-only transparency view as the answer.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn, TEST_TEAM_ID } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};
const POLICY = {
  aiEnabled: true, supportChatEnabled: true, captureAssistanceEnabled: false, evidenceCategorizationEnabled: true,
  semanticSearchEnabled: false, contentIntelligenceEnabled: false, reviewerCopilotEnabled: false, caseCopilotEnabled: false,
  rawContentProcessingAllowed: false, ocrAllowed: false, transcriptionAllowed: false, embeddingsAllowed: false,
};
const personal = () =>
  platformContextEnvelope({
    activeSpace: { id: TEST_TEAM_ID, type: "PERSONAL", plan: "PRO", displayName: "Me", status: "active" },
    planFeatures: { aiAssistanceMonthlyOperations: 500 },
  });

before(async () => {
  M = await loadModule("app/(stack)/settings/ai.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  routes = {
    ...authenticatedRoutes({ "/v1/platform/context": personal }),
    "/v1/workspaces/ai-assistance-status": () => ({ status: "AVAILABLE", enabled: true, features: [] }),
    "/v1/workspaces/ai-policy": (method) =>
      method === "PUT" ? { policy: { ...POLICY, captureAssistanceEnabled: true }, version: 4, hasExplicitPolicy: true } : { policy: POLICY, version: 3, hasExplicitPolicy: true },
    "/v1/workspaces/ai-usage": () => ({ monthUtc: "2026-09", allowance: { plan: "PRO", monthlyOperations: 500, consumed: 120, remaining: 380 } }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    requests.push({ path, method, body: init.body ? JSON.parse(init.body) : null });
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key](method) : undefined;
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

test("personal assistance: usage in the web's rows, master switch, launched features only", async () => {
  const r = await render();
  assert.ok(requests.some((q) => q.path === `/v1/workspaces/ai-policy?teamId=${TEST_TEAM_ID}`));
  assert.ok(r.hasText("Current plan") && r.hasText("Pro") && r.hasText("120 of 500") && r.hasText("380"));
  assert.equal(r.byLabel("Enable AI assistance in this workspace").length, 1);
  assert.equal(r.byLabel("Capture assistance").length, 1);
  assert.equal(r.byLabel("Semantic search").length, 0, "an unlaunched/enterprise capability was offered on a personal plan");
});

test("save sends every column with the expected version, and is refused when nothing changed", async () => {
  const r = await render();
  assert.ok(r.byLabel("Save changes")[0].props.accessibilityState.disabled, "save offered with no changes");
  await r.press("Capture assistance");
  await r.press("Save changes");
  await settle();
  const put = requests.find((q) => q.method === "PUT");
  assert.equal(put.path, "/v1/workspaces/ai-policy");
  assert.equal(put.body.teamId, TEST_TEAM_ID);
  assert.equal(put.body.expectedVersion, 3);
  assert.equal(put.body.captureAssistanceEnabled, true);
  assert.equal(put.body.semanticSearchEnabled, false, "unshown columns were not preserved");
  assert.ok(r.hasText("Saved. Changes take effect immediately."));
});

test("a stale version (409) is a conflict with Reload latest — never a silent overwrite", async () => {
  routes["/v1/workspaces/ai-policy"] = (method) => (method === "PUT" ? { __status: 409 } : { policy: POLICY, version: 3, hasExplicitPolicy: true });
  const r = await render();
  await r.press("Capture assistance");
  await r.press("Save changes");
  await settle();
  assert.ok(r.hasText("These settings were changed elsewhere."));
  assert.equal(r.byLabel("Reload latest").length, 1);
});

test("a 403 on the policy read leaves the read-only view — no switches at all", async () => {
  routes["/v1/workspaces/ai-policy"] = () => ({ __status: 403 });
  const r = await render();
  assert.equal(r.byLabel("Enable AI assistance in this workspace").length, 0);
  assert.equal(r.byRole("switch").length, 0, "a switch was offered to someone the server refused");
});

test("organization admins get the full governance editor; members do not", async () => {
  routes["/v1/platform/context"] = () =>
    platformContextEnvelope({ capabilities: { SETTINGS_MANAGE: true } });
  let r = await render();
  assert.equal(r.byLabel("AI capabilities may run in this workspace (per the policy below)").length, 1);
  assert.equal(r.byLabel("Semantic search").length, 1);
  assert.equal(r.byLabel("Save AI policy").length, 1);
  r.unmount();
  routes["/v1/platform/context"] = () => platformContextEnvelope({ capabilities: { SETTINGS_MANAGE: false } });
  requests = [];
  r = await render();
  assert.equal(r.byRole("switch").length, 0, "an organization member was offered policy switches");
  assert.ok(!requests.some((q) => q.path.startsWith("/v1/workspaces/ai-policy")), "the editable policy was read for a read-only member");
});

test("AI on for the workspace but not served by the platform says both facts (AiStatusRow :114)", async () => {
  routes["/v1/workspaces/ai-assistance-status"] = () => ({ status: "TEMPORARILY_UNAVAILABLE", enabled: true, features: [] });
  const r = await render();
  assert.ok(r.hasText("This workspace has AI assistance enabled; the platform is not serving AI requests at the moment. No change is needed here."), r.texts().join(" | "));
});
