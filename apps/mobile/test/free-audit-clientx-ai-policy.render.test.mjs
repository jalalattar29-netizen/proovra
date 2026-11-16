/**
 * CLIENT-X — B6-F-22 / B6-F-46 (native half).
 *
 * `PUT /v1/workspaces/ai-policy` now answers 403 `ENTITLEMENT_REQUIRED` when a
 * paid switch (semantic search, embeddings, content intelligence, raw content,
 * OCR, transcription, reviewer/case copilot) is turned ON for a workspace whose
 * plan lacks it (FREE / PAYG). Before: the native governance editor offered
 * every paid switch on a Free organization workspace, and the 403 read "Only
 * workspace owners or admins can change AI settings." to the owner.
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
  rawContentProcessingAllowed: false, ocrAllowed: true, transcriptionAllowed: false, embeddingsAllowed: false,
};
const orgOn = (plan) =>
  platformContextEnvelope({
    activeSpace: { id: TEST_TEAM_ID, type: "ORGANIZATION", plan, displayName: "Org", status: "active" },
    capabilities: { SETTINGS_MANAGE: true },
  });

before(async () => {
  M = await loadModule("app/(stack)/settings/ai.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  routes = {
    ...authenticatedRoutes({ "/v1/platform/context": () => orgOn("FREE") }),
    "/v1/workspaces/ai-assistance-status": () => ({ status: "AVAILABLE", enabled: true, features: [] }),
    "/v1/workspaces/ai-policy": (method) =>
      method === "PUT"
        ? { __status: 403, error: { code: "ENTITLEMENT_REQUIRED", message: "x", details: { entitlement: "AI_CAPABILITY", capabilities: [], fields: ["semanticSearchEnabled"] } } }
        : { policy: POLICY, version: 3, hasExplicitPolicy: true },
    "/v1/workspaces/ai-usage": () => ({ monthUtc: "2026-11", allowance: { plan: "FREE", monthlyOperations: 20, consumed: 1, remaining: 19 } }),
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
});
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async (session) => {
  await signIn(M, session);
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  return r;
};
const sw = (r, label) => r.byLabel(label).find((n) => n.props.accessibilityRole === "switch");

test("B6-F-22/46: on a Free workspace the paid switches are plan-locked, labelled, and not offered", async () => {
  const r = await render("free-org");
  const semantic = sw(r, "Semantic search");
  assert.ok(semantic, "the governance editor did not render");
  assert.equal(semantic.props.accessibilityState.disabled, true, "a paid switch was offered on a Free plan (403 on save)");
  assert.ok(r.hasText("Not included in your plan"), "the lock is not explained");
  // A switch already on may still be turned off (the API allows it).
  assert.equal(sw(r, "OCR").props.accessibilityState.disabled, false);
  // Included switches stay editable.
  assert.equal(sw(r, "Capture assistance").props.accessibilityState.disabled, false);
});

test("B6-F-22/46: a 403 ENTITLEMENT_REQUIRED on save says 'Not included in your plan', not 'owners or admins'", async () => {
  const r = await render("free-org-save");
  await r.press("OCR"); // turning a legacy switch off is allowed; the stub refuses anyway to exercise the mapping
  await r.press("Save AI policy");
  await settle();
  assert.ok(r.hasText("Not included in your plan:"), r.texts().join(" | "));
  assert.ok(!r.hasText("Only workspace owners or admins"));
});

test("B6-F-22/46 control: a paid plan keeps every switch editable", async () => {
  routes["/v1/platform/context"] = () => orgOn("ENTERPRISE");
  routes["/v1/workspaces/ai-usage"] = () => ({ monthUtc: "2026-11", allowance: { plan: "ENTERPRISE", monthlyOperations: null, consumed: 0, remaining: null } });
  const r = await render("ent-org");
  assert.equal(sw(r, "Semantic search").props.accessibilityState.disabled, false);
});
