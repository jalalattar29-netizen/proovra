/**
 * Team remediation T-098 — the claim refusal for the placement prerequisite.
 *
 * Outside Enterprise a person must be in a Collaboration Team before they can
 * be given or claim work. The claim route answers 422
 * { error: { code: "REVIEW_ASSIGNEE_NOT_PLACED", details: { reason: "assignee_not_placed" } } };
 * older servers sent the lowercase engine code `assignee_not_placed` as the
 * code itself, which no copy knew, so the phone showed a generic 422 sentence.
 * Both spellings must read as the placement step, with the way to the Teams
 * screen. Rendered through the REAL apiFetch (fetch is stubbed).
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let refusal;

before(async () => {
  M = await loadModule("app/(stack)/evidence/[id].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/errors/safe-error.ts"]);
});
beforeEach(async () => {
  refusal = { error: { code: "REVIEW_ASSIGNEE_NOT_PLACED", details: { reason: "assignee_not_placed" } } };
  globalThis.__EXPO_PARAMS__ = { id: "ev-1" };
  const routes = {
    ...authenticatedRoutes({ "/v1/platform/context": () => platformContextEnvelope({ planFeatures: { reviewerOperationsIncluded: true } }) }),
    "/v1/evidence/ev-1/review-workspace": () => ({ relationships: { items: [] }, reviewWorkflow: { teamId: "t-1", status: "QUEUED", assignedTo: null } }),
    "/v1/evidence/ev-1": () => ({ evidence: { id: "ev-1", status: "SIGNED", type: "PHOTO" } }),
  };
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (path === "/v1/review-operations/evidence/ev-1/claim") {
      return new Response(JSON.stringify(refusal), { status: 422, headers: { "content-type": "application/json" } });
    }
    const key = routes[path] ? path : Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key]() : { items: [] };
    return new Response(JSON.stringify(res), { status: 200, headers: { "content-type": "application/json" } });
  };
  M.calls.reset();
  await signIn(M);
});

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const claim = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  await r.press("Review");
  await settle();
  await r.press("Claim review");
  await settle();
  return r;
};

for (const [label, body] of [
  ["REVIEW_ASSIGNEE_NOT_PLACED", { error: { code: "REVIEW_ASSIGNEE_NOT_PLACED", details: { reason: "assignee_not_placed" } } }],
  ["legacy lowercase assignee_not_placed", { error: { code: "assignee_not_placed" } }],
]) {
  test(`a ${label} claim refusal says to be placed in a team first, with the way there`, async () => {
    refusal = body;
    const r = await claim();
    assert.ok(r.hasText("Place them in a team first"), "the placement refusal title is missing");
    assert.ok(r.hasText("You are not in a Collaboration Team in this workspace yet"), "the generic 422 sentence was shown");
    await r.press("Open Collaboration Teams");
    assert.equal(M.calls.push.at(-1), "/teams");
  });
}

test("any other screen that maps errors reads the legacy lowercase code as the placement step", () => {
  const e = Object.assign(new Error("Request failed"), { status: 422, statusCode: 422, code: "assignee_not_placed" });
  const safe = M.toSafeUserError(e);
  assert.equal(safe.title, "Place them in a team first");
});
