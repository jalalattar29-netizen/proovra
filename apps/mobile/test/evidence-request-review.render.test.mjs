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
import { loadModule, renderInProviders, React, act } from "./support/render.mjs";

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
  // The expo stub is in the graph so router pushes are observable (Screen.calls).
  Screen = await loadModule("app/(stack)/evidence-request/[id].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
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
  // Web parity (page.tsx:646): the absence reads "External contributor".
  assert.ok(r.hasText("External contributor"), "the anonymous submission has no label at all");
  assert.ok(
    !r.texts().some((t) => t.includes("aa11bb22")),
    "a raw response id reached the screen where a person belongs",
  );
});

test("a request with nothing submitted says so, rather than showing an empty frame", async () => {
  routes["/v1/evidence-requests/req-1"] = () => ({ body: REQUEST([]) });
  const r = await render();
  // page.tsx:615 — the web empty copy.
  assert.ok(r.hasText("No responses received yet. Responses appear here once the contributor submits via the intake link."));
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

test("a retryable delivery is shown in the server's words and can be retried", async () => {
  routes["/v1/evidence-requests/req-1/deliveries"] = () => ({
    body: { deliveries: [{ id: "d1", eventType: "REMINDER", status: "FAILED", errorCode: "bounced", retryCount: 1, lastAttemptAtUtc: "2026-09-24T09:00:00.000Z", retryable: true }] },
  });
  routes["/v1/evidence-requests/req-1/deliveries/d1/retry"] = () => ({ body: { ok: true } });
  const r = await render();
  await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
  assert.ok(r.texts().some((t) => t.startsWith("reminder · last attempt")), "the delivery was not described");
  assert.ok(r.hasText("Failed") && r.hasText("(bounced)"));
  assert.ok(!r.hasText("Recipient"), "the invented 'Recipient' fallback is back");
  await r.press("Retry reminder");
  await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
  assert.ok(requests.some((q) => q.method === "POST" && q.path === "/v1/evidence-requests/req-1/deliveries/d1/retry"));
});

/* ---- T-14 (page.tsx:580 received, :658 Open evidence) ---- */

test("each requested item says how much of it arrived, what it accepts, and a waiver", async () => {
  routes["/v1/evidence-requests/req-1"] = () => ({
    body: {
      request: {
        ...REQUEST([RECEIVED]).request,
        // The server row (prisma EvidenceRequestDeliverable).
        deliverables: [
          { id: "d1", title: "Front photo", required: true, status: "PARTIALLY_FULFILLED", fulfilledCount: 1, minCount: 2, maxCount: 4, acceptedKinds: ["PHOTO", "VIDEO"], waivedReason: null },
          { id: "d2", title: "Invoice", required: false, status: "WAIVED", fulfilledCount: 0, minCount: 1, maxCount: null, acceptedKinds: [], waivedReason: "Not applicable" },
        ],
      },
    },
  });
  const r = await render();
  assert.ok(r.texts().some((t) => t.includes("1 of 2 received (up to 4) · Accepts PHOTO, VIDEO")), r.texts().join(" | "));
  assert.ok(r.texts().some((t) => t.includes("0 of 1 received · Waived: Not applicable")));
});

test("a submission with a record opens it", async () => {
  const r = await render();
  const open = r.byLabel("Open evidence");
  assert.equal(open.filter((n) => n.props.onPress).length, 1, "only the response with a record offers it");
  await act(async () => { open.find((n) => n.props.onPress).props.onPress(); });
  assert.equal(Screen.calls.push.at(-1), "/evidence/ev-1");
});
