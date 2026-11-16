/**
 * CLIENT-X — B4-F-001 (native half).
 *
 * An integrity-rejected (`FAILED_HASH_MISMATCH`) record with no report no
 * longer occupies a Free included-record slot. Before: the record view said
 * only that the record cannot be used, leaving a Free user to think it still
 * counted against their three records.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn, TEST_TEAM_ID } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let routes = {};
const NOTE = "This record failed its integrity check and does not use one of your included records.";
const space = (plan) => platformContextEnvelope({ activeSpace: { id: TEST_TEAM_ID, type: "PERSONAL", plan, displayName: "Me", status: "active" } });

before(async () => {
  M = await loadModule("app/(stack)/evidence/[id].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  globalThis.__EXPO_PARAMS__ = { id: "ev-1" };
  routes = {
    ...authenticatedRoutes({ "/v1/platform/context": () => space("FREE") }),
    "/v1/evidence/ev-1/review-workspace": () => ({ relationships: { items: [] }, reviewWorkflow: { status: "NOT_STARTED", teamId: TEST_TEAM_ID } }),
    "/v1/evidence/ev-1/artifacts/status": () => ({ outputs: { report: { state: "NOT_ELIGIBLE" }, verificationPackage: { state: "NOT_ELIGIBLE" } } }),
    "/v1/evidence/ev-1": () => ({ evidence: { id: "ev-1", status: "FAILED_HASH_MISMATCH", type: "PHOTO", teamId: TEST_TEAM_ID } }),
  };
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const key = routes[path] ? path : Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key]() : undefined;
    return new Response(JSON.stringify(res ?? {}), { status: res === undefined ? 500 : 200, headers: { "content-type": "application/json" } });
  };
});
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async (session) => {
  await signIn(M, session);
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  return r;
};

test("B4-F-001: a Free integrity-failed record without a report says it does not use an included record", async () => {
  const r = await render("free");
  assert.equal(r.byTestId("evidence-integrity-failed").length, 1, "no integrity banner");
  assert.ok(r.hasText(NOTE), r.texts().slice(0, 30).join(" | "));
  assert.ok(r.hasText("move this one to Trash to free its storage"));
  r.unmount();
});

test("B4-F-001 control: a paid plan's integrity banner makes no included-record claim", async () => {
  routes["/v1/platform/context"] = () => space("PRO");
  const r = await render("pro");
  assert.equal(r.byTestId("evidence-integrity-failed").length, 1);
  assert.ok(!r.hasText(NOTE));
  r.unmount();
});
