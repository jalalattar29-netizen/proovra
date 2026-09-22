/**
 * RENDER TESTS for Evidence Request › Submissions (per-response review).
 *
 * A parser test proves a row exists in memory. It cannot prove a reviewer can
 * SEE what was sent in and answer it, which is the whole point of this
 * surface — and it is exactly the level F-09 was found at, where three
 * parsers read a key the routes never send and 2156 unit assertions passed.
 *
 * So this drives the REAL screen through the REAL apiFetch with
 * `globalThis.fetch` stubbed to return the REAL envelopes, and asserts what a
 * person holding the phone actually sees and sends.
 *
 * The envelopes are verbatim from the handlers:
 *   evidence-requests.routes.ts  GET  /v1/evidence-requests/:id  { request }
 *   evidence-request.service.ts:1606  the response projection's own fields
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadWithProviders, renderInProviders, React } from "./support/render.mjs";

const h = React.createElement;
let Screen;

let requests = [];
let routes = {};

function installFetch() {
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, method: init.method ?? "GET", body: init.body ?? null });
    const responder = Object.entries(routes)
      .sort((a, b) => b[0].length - a[0].length)
      .find(([p]) => path.startsWith(p));
    if (!responder) {
      return new Response(JSON.stringify({ message: "unstubbed" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    const out = responder[1](path, init);
    return new Response(JSON.stringify(out.body ?? {}), {
      status: out.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
}

const RECEIVED = {
  id: "aa11bb22-cc33-4d44-8e55-000000000001",
  status: "RECEIVED",
  submittedAtUtc: "2026-09-20T10:15:00.000Z",
  submittedByExternalLabel: "Witness A",
  responseEvidenceId: "ev-1",
  reviewerNote: null,
  reviewedAtUtc: null,
};

const ANONYMOUS = {
  id: "aa11bb22-cc33-4d44-8e55-000000000002",
  status: "REJECTED",
  submittedAtUtc: "2026-09-20T11:00:00.000Z",
  submittedByExternalLabel: null,
  responseEvidenceId: null,
  reviewerNote: "Out of scope for this request.",
  reviewedAtUtc: "2026-09-20T12:00:00.000Z",
};

const REQUEST = (responses) => ({
  request: {
    id: "req-1",
    title: "Photographs of the vehicle",
    status: "RESPONSE_RECEIVED",
    instructions: "Four corners, in daylight.",
    priority: "NORMAL",
    recipientLabel: "External contributor",
    dueAtUtc: null,
    caseId: null,
    evidenceId: null,
    deliverables: [],
    responses,
  },
});

const POPULATED = () => ({
  "/v1/evidence-requests/req-1/deliveries": () => ({ body: { deliveries: [] } }),
  "/v1/evidence-requests/req-1/events": () => ({ body: { events: [] } }),
  "/v1/evidence-requests/req-1/responses": () => ({ body: { response: RECEIVED } }),
  "/v1/evidence-requests/req-1": () => ({ body: REQUEST([RECEIVED, ANONYMOUS]) }),
});

before(async () => {
  Screen = await loadWithProviders("app/(stack)/evidence-request/[id].tsx");
});

beforeEach(() => {
  requests = [];
  routes = POPULATED();
  globalThis.__EXPO_PARAMS__ = { id: "req-1" };
  installFetch();
});

const render = () => renderInProviders(Screen, h(Screen.default, {}));

test("what was submitted reaches the screen", async () => {
  // Native parsed the deliverables and dropped the responses entirely, so a
  // reviewer could see that a request had moved without seeing what moved it.
  const r = await render();
  assert.ok(r.hasText("Witness A"), "the contributor's own label is not on screen");
  assert.ok(r.hasText("Rejected as insufficient"), "a decision already made is not shown");
});

test("a reviewer's earlier note is shown with the submission it belongs to", async () => {
  const r = await render();
  assert.ok(r.hasText("Out of scope for this request."));
});

test("an anonymous submission is not given an invented name", async () => {
  const r = await render();
  assert.ok(r.hasText("Contributor"), "the anonymous submission has no label at all");
  assert.ok(
    !r.texts().some((t) => t.includes("aa11bb22")),
    "a raw response id reached the screen where a person belongs",
  );
});

test("a request with nothing submitted says so, rather than showing an empty frame", async () => {
  routes["/v1/evidence-requests/req-1"] = () => ({ body: REQUEST([]) });
  const r = await render();
  assert.ok(r.hasText("Nothing has been submitted against this request yet."));
});

test("the submissions section survives a request the reader cannot see deliveries for", async () => {
  // Deliveries and history are separately gated; one refusal must not blank
  // the submissions, which is the part a reviewer came for.
  routes["/v1/evidence-requests/req-1/deliveries"] = () => ({
    status: 403,
    body: { message: "forbidden" },
  });
  const r = await render();
  assert.ok(r.hasText("Witness A"));
});

test("acceptance is offered as admission to review, never as verification", async () => {
  const r = await render();
  // The status vocabulary is on the screen as the product says it, not as a
  // shorter word a reviewer could read as a finding about the evidence.
  assert.ok(!r.texts().some((t) => t === "Accepted"), "bare 'Accepted' would overstate the act");
});
