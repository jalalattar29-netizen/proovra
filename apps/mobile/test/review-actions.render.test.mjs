/**
 * T-15 — internal review actions on the evidence Review tab
 * (POST /v1/review-operations/evidence/:id/{claim,decision}). Native could
 * read the review state but never claim a review or record a decision.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};
let wf;

before(async () => {
  M = await loadModule("app/(stack)/evidence/[id].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  wf = { teamId: "t-1", status: "IN_REVIEW", assignedTo: null };
  globalThis.__EXPO_PARAMS__ = { id: "ev-1" };
  routes = {
    ...authenticatedRoutes({ "/v1/platform/context": () => platformContextEnvelope({ planFeatures: { reviewerOperationsIncluded: true } }) }),
    "/v1/evidence/ev-1/review-workspace": () => ({ relationships: { items: [] }, reviewWorkflow: wf }),
    "/v1/evidence/ev-1": () => ({ evidence: { id: "ev-1", status: "SIGNED", type: "PHOTO" } }),
    "/v1/review-operations/evidence/ev-1/claim": () => {
      wf = { ...wf, assignedTo: { id: "u-me-123456789" } };
      return {};
    },
    "/v1/review-operations/evidence/ev-1/decision": () => ({}),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    // Presence heartbeats (every record screen, as on the web) are not this suite's traffic.
    if (!path.startsWith("/v1/me/presence")) requests.push({ path, method, body: init.body ? JSON.parse(init.body) : null });
    const key = routes[path] ? path : Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key]() : undefined;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status: res ? 200 : 500, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const openReview = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  await r.press("Review");
  await settle();
  return r;
};
const posts = () => requests.filter((q) => q.method === "POST");

test("an unassigned review can be claimed for the record's workspace, and the panel reloads", async () => {
  const r = await openReview();
  assert.ok(r.hasText("Internal-only actions."));
  assert.ok(r.hasText("unassigned"));
  await r.press("Claim review");
  await settle();
  assert.deepEqual(posts()[0], { path: "/v1/review-operations/evidence/ev-1/claim", method: "POST", body: { teamId: "t-1" } });
  assert.ok(r.hasText("assigned to u-me-123…"), "the claim was not re-read");
});

test("from IN_REVIEW: approve posts directly; reject requires an internal note first", async () => {
  const r = await openReview();
  await r.press("Approve (internal review)");
  await settle();
  assert.deepEqual(posts()[0].body, { decision: "APPROVE_INTERNAL", note: null });
  await r.press("Reject as insufficient");
  assert.equal(posts().length, 1, "rejected without the required note");
  await r.type("Reason for rejection (required, internal only)", "Timestamp contradicts the metadata.");
  await r.press("Submit: Reject as insufficient");
  await settle();
  assert.deepEqual(posts()[1].body, { decision: "REJECT_INSUFFICIENT", note: "Timestamp contradicts the metadata." });
});

test("escalation carries the reason twice, as the web sends it", async () => {
  const r = await openReview();
  await r.press("Escalate");
  await r.type("Escalation reason (required, internal only)", "Needs legal.");
  await r.press("Submit: Escalate");
  await settle();
  assert.deepEqual(posts()[0].body, { decision: "ESCALATE", note: "Needs legal.", escalationReason: "Needs legal." });
});

test("decisions the stage does not allow stay visible but disabled, and say why", async () => {
  wf = { teamId: "t-1", status: "APPROVED_INTERNAL", assignedTo: { id: "u-other-9999" } };
  const r = await openReview();
  assert.equal(r.byLabel("Approve (internal review), not available from APPROVED_INTERNAL").length, 1);
  assert.ok(!r.byLabel("Reopen")[0].props.accessibilityState?.disabled);
  assert.equal(r.byLabel("Claim review").length, 0, "an assigned review offered Claim");
});
