/**
 * RENDER TESTS — Evidence Request inspector parity with the web
 * (apps/web/app/(app)/evidence-requests/[id]/page.tsx and
 * _components/EvidenceRequestAssignment.tsx).
 *
 * The real screen through the real apiFetch; `globalThis.fetch` returns the
 * routes' REAL envelopes (services/api/src/routes/evidence-requests.routes.ts):
 *   GET  /v1/evidence-requests/:id                         → { request }           (:302)
 *   POST /v1/evidence-requests/:id/send                     → { request, rawToken, intakeUrl, warning } (:409-416)
 *   POST /v1/evidence-requests/:id/cancel                   → { request }           (:450)
 *   POST /v1/evidence-requests/:id/needs-more-info          → { request }           (:519)
 *   POST /v1/evidence-requests/:id/deliverables/:d/waive    → { deliverable }       (:560)
 *   POST /v1/evidence-requests/:id/responses/:r/review      → { response }          (:625)
 *   POST /v1/evidence-requests/:id/responses/:r/request-more → { response, newIntakeLinkId, rawToken, communicationMessageId } (:678-683)
 *   GET  /v1/teams/:id/members                              → { members, nextCursor }
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderInProviders, React, act } from "./support/render.mjs";

const h = React.createElement;
let Screen;
let requests = [];
let routes = {};
let mounted = null;

const REQ = "11111111-1111-4111-8111-111111111111";
const RESP = "22222222-2222-4222-8222-222222222222";
const DELIV = "33333333-3333-4333-8333-333333333333";

const RECEIVED = {
  id: RESP,
  intakeSessionId: null,
  responseEvidenceId: null,
  submittedByUserId: null,
  submittedByExternalLabel: "Witness A",
  status: "RECEIVED",
  submittedAtUtc: "2026-09-20T10:15:00.000Z",
  reviewedAtUtc: null,
  reviewedByUserId: null,
  reviewerNote: null,
};

const base = (over = {}) => ({
  id: REQ,
  teamId: "team-1",
  evidenceId: null,
  caseId: "case-1",
  requestType: "PHOTO_SET",
  status: "RESPONSE_RECEIVED",
  priority: "HIGH",
  title: "Photographs of the vehicle",
  instructions: "Four corners, in daylight.",
  dueAtUtc: null,
  recipientMode: "EXTERNAL_LINK",
  recipientLabel: null,
  assignedReviewerUserId: null,
  deliverables: [
    { id: DELIV, title: "Front photo", description: "", required: true, acceptedKinds: ["PHOTO"], minCount: 1, maxCount: null, status: "PENDING", waivedReason: null, fulfilledCount: 0 },
    { id: "d-2", title: "Rear photo", description: "", required: true, acceptedKinds: [], minCount: 1, maxCount: null, status: "FULFILLED", waivedReason: null, fulfilledCount: 1 },
  ],
  responses: [RECEIVED],
  ...over,
});

function installFetch() {
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const out = key ? routes[key](path, init) : { status: 500, body: { message: "unstubbed" } };
    return new Response(JSON.stringify(out.body ?? {}), {
      status: out.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
}

before(async () => {
  // The expo stub is in the graph so router pushes are observable (Screen.calls).
  Screen = await loadModule("app/(stack)/evidence-request/[id].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});

beforeEach(() => {
  requests = [];
  process.env.EXPO_PUBLIC_WEB_BASE = "https://www.proovra.com";
  globalThis.__EXPO_PARAMS__ = { id: REQ };
  globalThis.__CLIPBOARD__ = undefined;
  routes = {
    [`/v1/evidence-requests/${REQ}/deliveries`]: () => ({ body: { deliveries: [] } }),
    [`/v1/evidence-requests/${REQ}/events`]: () => ({ body: { events: [] } }),
    [`/v1/evidence-requests/${REQ}`]: () => ({ body: { request: base() } }),
    "/v1/teams/team-1/members": () => ({
      body: {
        members: [{ id: "m1", userId: "u-dana", role: "MEMBER", status: "ACTIVE", user: { displayName: "Dana" } }],
        nextCursor: null,
      },
    }),
  };
  installFetch();
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const settle = async () => {
  for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async () => {
  mounted = await renderInProviders(Screen, h(Screen.default, {}));
  await settle();
  return mounted;
};
const posted = (suffix) => requests.filter((q) => q.method === "POST" && q.path.endsWith(suffix));

test("header: eyebrow, status/priority chips and readiness (page.tsx:384-412)", async () => {
  const r = await render();
  assert.ok(r.hasText("Evidence Request · photo set"));
  assert.ok(r.byLabel("Status: Response Received").length > 0);
  assert.ok(r.byLabel("Priority: High").length > 0);
  assert.ok(r.byLabel("Required items remaining").length > 0, "one required item is still outstanding");
});

test("completion: percent, bar and required/optional counts (page.tsx:471-524)", async () => {
  const r = await render();
  assert.ok(r.hasText("Completion"));
  assert.ok(r.hasText("50%"));
  assert.ok(r.hasText("Required: 1 / 2"));
  assert.ok(r.hasText("Optional: 0 / 0"));
  assert.equal(r.styleOf(r.byTestId("request-completion-bar")[0]).width, "50%");
});

test("a request with every required item satisfied reads Review-ready", async () => {
  routes[`/v1/evidence-requests/${REQ}`] = () => ({
    body: { request: base({ deliverables: [{ ...base().deliverables[0], status: "WAIVED", waivedReason: "n/a" }] }) },
  });
  const r = await render();
  assert.ok(r.byLabel("Review-ready").length > 0);
  assert.ok(r.hasText("100%"));
});

test("no deliverables and no responses say so in the web's words (page.tsx:531, :615)", async () => {
  routes[`/v1/evidence-requests/${REQ}`] = () => ({ body: { request: base({ deliverables: [], responses: [] }) } });
  const r = await render();
  assert.ok(r.hasText("This request has no deliverable checklist. It accepts free-form uploads only."));
  assert.ok(r.hasText("Responses received"));
  assert.ok(r.hasText("No responses received yet. Responses appear here once the contributor submits via the intake link."));
});

test("Request more information posts the REQUIRED note to needs-more-info (page.tsx:428-468)", async () => {
  routes[`/v1/evidence-requests/${REQ}/needs-more-info`] = () => ({ body: { request: base({ status: "NEEDS_MORE_INFO" }) } });
  const r = await render();
  assert.ok(r.hasText("Request more information"));
  const button = () => r.byLabel("Mark as needs more info").find((n) => n.props.onPress);
  assert.ok(button().props.accessibilityState?.disabled || button().props.disabled, "an empty note is refused server-side (422 reviewer_note_required)");
  await r.type("Reviewer note (workspace-internal, required)", "Need the plate visible");
  await r.press("Mark as needs more info");
  await settle();
  assert.deepEqual(posted("/needs-more-info")[0].body, { reviewerNote: "Need the plate visible" });
});

test("Request more information is not offered where the server refuses it (IN_PROGRESS)", async () => {
  routes[`/v1/evidence-requests/${REQ}`] = () => ({ body: { request: base({ status: "IN_PROGRESS", responses: [] }) } });
  const r = await render();
  assert.ok(!r.hasText("Request more information"));
  assert.equal(r.byLabel("Ask for more").length, 0);
});

test("a pending deliverable can be waived with a reason (page.tsx:180-208, :591-603)", async () => {
  routes[`/v1/evidence-requests/${REQ}/deliverables/${DELIV}/waive`] = () => ({ body: { deliverable: {} } });
  const r = await render();
  assert.equal(r.byLabel("Waive Rear photo").length, 0, "a fulfilled deliverable is not waivable");
  await r.press("Waive Front photo");
  assert.ok(r.hasText("Reason for waiving this deliverable (visible only to workspace members):"));
  await r.type("Waiver reason", "Vehicle already towed");
  await r.press("Confirm waiver");
  await settle();
  assert.deepEqual(posted(`/deliverables/${DELIV}/waive`)[0].body, { reason: "Vehicle already towed" });
});

test("Accept on an unjudged response posts ACCEPTED (page.tsx:678-686)", async () => {
  routes[`/v1/evidence-requests/${REQ}/responses/${RESP}/review`] = () => ({ body: { response: { ...RECEIVED, status: "ACCEPTED" } } });
  const r = await render();
  await r.press("Accept submission from Witness A");
  await settle();
  assert.deepEqual(posted("/review")[0].body, { status: "ACCEPTED", reviewerNote: null });
});

test("Reject asks whether to notify the contributor, and sends the answer (page.tsx:222-248)", async () => {
  routes[`/v1/evidence-requests/${REQ}/responses/${RESP}/review`] = () => ({ body: { response: { ...RECEIVED, status: "REJECTED" } } });
  const r = await render();
  await r.press("Reject submission from Witness A");
  await r.type("Reviewer note", "Wrong vehicle");
  // The decision chosen, then its own submit button (the last one so labelled).
  const submit = r.byLabel("Reject as insufficient").filter((n) => n.props.onPress).at(-1);
  await act(async () => { await submit.props.onPress(); });
  assert.ok(r.hasText("Notify the contributor?"));
  await r.press("Notify by SMS");
  await settle();
  assert.deepEqual(posted("/review")[0].body, {
    status: "REJECTED",
    reviewerNote: "Wrong vehicle",
    notifyContributor: true,
    notifyChannel: "SMS",
  });
});

test("Request more issues a follow-up link shown once, copyable (page.tsx:268-321, :740-804)", async () => {
  routes[`/v1/evidence-requests/${REQ}/responses/${RESP}/request-more`] = () => ({
    body: { response: { ...RECEIVED, status: "NEEDS_MORE_INFO" }, newIntakeLinkId: "l-2", rawToken: "tok_abc", communicationMessageId: null },
  });
  const r = await render();
  await r.press("Request more from Witness A");
  assert.ok(r.hasText("What additional information do you need? (internal note, not sent to contributor)"));
  await r.type("Request more note", "Need the rear plate");
  await r.press("I'll share the link manually");
  await settle();
  assert.deepEqual(posted("/request-more")[0].body, { reviewerNote: "Need the rear plate", notifyContributor: false, notifyChannel: "SMS" });
  assert.ok(r.hasText("Follow-up link created"));
  assert.ok(r.hasText("Copy the link below and share it directly with the contributor. This link will not be shown again."));
  assert.ok(r.hasText("https://www.proovra.com/intake/tok_abc"));
  await r.press("Copy link");
  assert.equal(globalThis.__CLIPBOARD__, "https://www.proovra.com/intake/tok_abc");
});

test("cancelling requires the note the server requires (evidence-request.service.ts:475)", async () => {
  const r = await render();
  await r.press("Cancel request");
  assert.ok(r.hasText("Note (required)"));
  const confirm = r.byLabel("Cancel request").filter((n) => n.props.onPress).at(-1);
  assert.ok(confirm.props.accessibilityState?.disabled || confirm.props.disabled);
});

test("sending an external request reveals the one-shot intake link (routes.ts:409-416)", async () => {
  routes[`/v1/evidence-requests/${REQ}`] = () => ({ body: { request: base({ status: "DRAFT", responses: [] }) } });
  routes[`/v1/evidence-requests/${REQ}/send`] = () => ({
    body: {
      request: base({ status: "SENT" }),
      rawToken: "tok_x",
      intakeUrl: "https://www.proovra.com/intake/tok_x",
      warning: "The intake link is shown exactly once. Capture it now — it is not retrievable later.",
    },
  });
  const r = await render();
  await r.press("Send to recipient");
  const confirm = r.byLabel("Send to recipient").filter((n) => n.props.onPress).at(-1);
  await act(async () => { await confirm.props.onPress(); });
  await settle();
  assert.ok(r.hasText("https://www.proovra.com/intake/tok_x"));
  assert.ok(r.hasText("The intake link is shown exactly once. Capture it now — it is not retrievable later."));
});

test("an internal draft is sent to the assigned reviewer, named from the roster (Assignment.tsx:188-269)", async () => {
  let status = "DRAFT";
  routes[`/v1/evidence-requests/${REQ}`] = () => ({
    body: { request: base({ status, recipientMode: "INTERNAL_USER", assignedReviewerUserId: "u-dana", responses: [] }) },
  });
  routes[`/v1/evidence-requests/${REQ}/send`] = () => {
    status = "SENT";
    return { body: { request: base({ status }), rawToken: null, intakeUrl: null, warning: null } };
  };
  const r = await render();
  assert.ok(r.texts().includes("Dana"), "the assigned reviewer is named, not 'A workspace member'");
  assert.equal(r.byLabel("Send to recipient").length, 0, "the internal send lives in the assignment block");
  await r.press("Send to assigned reviewer");
  assert.ok(r.hasText("Dana is notified by email and the request moves out of draft."));
  await r.press("Send request");
  await settle();
  assert.deepEqual(posted("/send")[0].body, {});
  assert.ok(r.hasText("Request sent to the assigned reviewer. The saved request was reloaded."));
});

test("the way back leads to the matter (page.tsx:721-738)", async () => {
  const r = await render();
  await r.press("← Back to matter");
  assert.equal(Screen.calls.push.at(-1), "/case/case-1");
});

test("loading and unavailable states use the web copy (page.tsx:326, :333)", async () => {
  routes[`/v1/evidence-requests/${REQ}`] = () => ({ status: 404, body: { error: { code: "request_not_found" } } });
  const r = await render();
  assert.ok(r.hasText("Evidence request unavailable"));
});
