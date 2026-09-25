/**
 * T-12 / RC-13 — linked evidence requests on the evidence record, and "New
 * request" from it (EvidenceRequestPanel.tsx:625 Request type, :656 Recipient).
 *
 * Before: a request could not be created from the record it is about, and the
 * record did not list the requests linked to it. Now the Overview carries both,
 * gated like the web (intakeIncluded), scoped to the record's review workspace.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};

const RW_TEAM = "22222222-2222-2222-2222-222222222222";
const LIST = `/v1/evidence-requests?teamId=${RW_TEAM}&evidenceId=ev-1`;
const REQ = {
  id: "rq-1", title: "Roof photos", status: "SENT", requestType: "ADDITIONAL_EVIDENCE", recipientMode: "EXTERNAL_CONTRIBUTOR",
  recipientLabel: "John Smith", dueAtUtc: null, deliverables: [], responses: [],
};

before(async () => {
  M = await loadModule("app/(stack)/evidence/[id].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  globalThis.__EXPO_PARAMS__ = { id: "ev-1" };
  routes = {
    ...authenticatedRoutes({
      "/v1/platform/context": () => platformContextEnvelope({ planFeatures: { intakeIncluded: true } }),
    }),
    "/v1/evidence/ev-1/review-workspace": () => ({ relationships: { items: [] }, reviewWorkflow: { teamId: RW_TEAM } }),
    "/v1/evidence/ev-1": () => ({ evidence: { id: "ev-1", status: "SIGNED", type: "PHOTO" } }),
    [LIST]: () => ({ requests: [REQ] }),
    "/v1/evidence-requests": () => ({ request: { id: "rq-2" } }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    // Presence heartbeats (every record screen, as on the web) are not this suite's traffic.
    if (!path.startsWith("/v1/me/presence")) requests.push({ path, method, body: init.body ? JSON.parse(init.body) : null });
    const key = routes[path] ? path : Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
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

test("the Overview lists requests linked to this record, read in its review workspace", async () => {
  const r = await render();
  assert.ok(requests.some((q) => q.path === LIST), "linked requests never read");
  assert.equal(r.byTestId("evidence-linked-requests").length, 1);
  assert.ok(r.hasText("Roof photos"));
  assert.ok(r.hasText("ADDITIONAL_EVIDENCE · External contributor · John Smith"));
});

test("New request posts the web's body — type, recipient, deliverables — to the one writer", async () => {
  routes[LIST] = () => ({ requests: [] });
  const r = await render();
  assert.ok(r.hasText("No linked requests yet."));
  await r.press("New request");
  await settle();
  assert.ok(r.hasText("Enter a title for the request."));
  await r.type("Title", "Close-ups of the leak");
  await r.press("Request type: Witness statement");
  await r.press("Priority: High");
  await r.type("Recipient email (optional)", "not-an-email");
  assert.ok(r.hasText("Enter a valid recipient email, or leave it empty."));
  await r.type("Recipient email (optional)", "owner@example.com");
  await r.press("Add deliverable");
  assert.ok(r.hasText("Deliverable 2 needs a title."), "a blank deliverable would reach the server as a flat 400");
  await r.type("Deliverable 2 title", "Wide shot");
  const before = Date.now();
  await r.press("Create request");
  await settle();
  const post = requests.find((q) => q.method === "POST" && q.path === "/v1/evidence-requests");
  assert.ok(post, "nothing was created");
  const { dueAtUtc, ...body } = post.body;
  assert.deepEqual(body, {
    teamId: RW_TEAM,
    evidenceId: "ev-1",
    requestType: "WITNESS_STATEMENT",
    title: "Close-ups of the leak",
    instructions: "",
    priority: "HIGH",
    recipientMode: "EXTERNAL_CONTRIBUTOR",
    recipientLabel: null,
    recipientEmail: "owner@example.com",
    createIntakeLink: true,
    deliverables: [
      { title: "Primary evidence", description: "", required: true, acceptedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"], minCount: 1, locationRequirement: "optional", captureAfterRequest: false, sortOrder: 0 },
      { title: "Wide shot", description: "", required: false, acceptedKinds: ["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"], minCount: 1, locationRequirement: "optional", captureAfterRequest: false, sortOrder: 1 },
    ],
  });
  const dueMs = Date.parse(dueAtUtc) - before;
  assert.ok(dueMs > 71.9 * 3600e3 && dueMs < 72.1 * 3600e3, "default due is not 72 hours");
  assert.equal(r.byTestId("create-request-sheet").length, 0, "sheet stayed open after a create");
  assert.ok(requests.filter((q) => q.path === LIST).length >= 2, "the list was not reread after the create");
});

test("an email typed for an external contributor is NOT sent after switching to an anonymous source", async () => {
  routes[LIST] = () => ({ requests: [] });
  const r = await render();
  await r.press("New request");
  await settle();
  await r.type("Title", "Tip");
  await r.type("Recipient email (optional)", "someone@example.com");
  await r.press("Recipient: Anonymous source");
  await r.press("Create request");
  await settle();
  const post = requests.find((q) => q.method === "POST");
  assert.equal(post.body.recipientMode, "ANONYMOUS_SOURCE");
  assert.equal(post.body.recipientEmail, null, "an anonymous request carried an email address");
});

test("no intakeIncluded → no panel; a disabled feature (503) hides it; other failures are said", async () => {
  routes["/v1/platform/context"] = () => platformContextEnvelope({ planFeatures: { intakeIncluded: false } });
  let r = await render();
  assert.equal(r.byTestId("evidence-linked-requests").length, 0);
  assert.ok(!requests.some((q) => q.path === LIST), "read requests for a plan without intake");
  r.unmount();

  routes["/v1/platform/context"] = () => platformContextEnvelope({ planFeatures: { intakeIncluded: true } });
  routes[LIST] = () => ({ __status: 503, error: { code: "FEATURE_DISABLED" } });
  r = await render();
  assert.equal(r.byTestId("evidence-linked-requests").length, 0);
  r.unmount();

  routes[LIST] = () => ({ __status: 500 });
  r = await render();
  assert.equal(r.byTestId("evidence-linked-requests").length, 1);
  assert.ok(!r.hasText("No linked requests yet."), "a failed read shown as 'none'");
});
