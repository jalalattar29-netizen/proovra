/**
 * T-12 / RC-13 — the evidence request's assigned reviewer
 * (EvidenceRequestAssignment.tsx:279).
 *
 * Native had `buildRequestAssignPath` and nothing called it: no one could be
 * made responsible for a request from a phone, and an INTERNAL request with no
 * reviewer offered a "Send" the server always refuses
 * (`internal_recipient_requires_assignee`).
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadWithProviders, renderInProviders, React, act } from "./support/render.mjs";

const h = React.createElement;
let Screen;
let requests = [];
let assigned = null;

function install() {
  const routes = {
    "/v1/evidence-requests/req-1/deliveries": () => ({ deliveries: [] }),
    "/v1/evidence-requests/req-1/events": () => ({ events: [] }),
    "/v1/evidence-requests/req-1/assign": (_p, init) => {
      assigned = JSON.parse(init.body).assignedReviewerUserId;
      return {};
    },
    "/v1/evidence-requests/req-1": () => ({
      request: {
        id: "req-1",
        teamId: "team-1",
        title: "Internal statement",
        status: "DRAFT",
        recipientMode: "INTERNAL_USER",
        assignedReviewerUserId: assigned,
        deliverables: [],
        responses: [],
      },
    }),
    "/v1/teams/team-1/members": () => ({
      members: [
        { id: "m1", userId: "u-dana", role: "MEMBER", status: "ACTIVE", user: { displayName: "Dana" } },
        { id: "m2", userId: "u-gone", role: "MEMBER", status: "SUSPENDED", user: { displayName: "Suspended Sam" } },
      ],
      nextCursor: null,
    }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, method: init.method ?? "GET" });
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    return new Response(JSON.stringify(key ? routes[key](path, init) : { message: "unstubbed" }), {
      status: key ? 200 : 500,
      headers: { "content-type": "application/json" },
    });
  };
}

before(async () => {
  Screen = await loadWithProviders("app/(stack)/evidence-request/[id].tsx");
});
beforeEach(() => {
  requests = [];
  assigned = null;
  globalThis.__EXPO_PARAMS__ = { id: "req-1" };
  install();
});

const settle = async () => {
  for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};

test("an internal request without a reviewer says why it cannot be sent", async () => {
  const r = await renderInProviders(Screen, h(Screen.default, {}));
  await settle();
  assert.ok(r.hasText("Unassigned"));
  assert.ok(r.hasText("Assign a reviewer first. A request addressed to an internal team member cannot be sent without an assigned reviewer."));
});

test("assigning posts the member, re-reads the request, and reports from the saved row", async () => {
  const r = await renderInProviders(Screen, h(Screen.default, {}));
  await settle();
  await r.press("Assign reviewer");
  await settle();
  assert.ok(!r.hasText("Suspended Sam"), "a suspended member was offered");
  assert.match(requests.filter((q) => q.path.startsWith("/v1/teams/team-1/members")).at(-1).path, /status=ACTIVE/);
  await r.press("Dana");
  await settle();
  // Choosing stages the member; "Save reviewer" writes it (EvidenceRequestAssignment.tsx:279-296).
  assert.equal(assigned, null, "choosing a member wrote the assignment before it was saved");
  await r.press("Save reviewer");
  await settle();
  assert.equal(assigned, "u-dana");
  assert.ok(r.hasText("Dana is now the assigned reviewer. The saved request was reloaded."));
  assert.ok(r.byLabel("Change reviewer").length > 0);
});

test("the request's events read as the web Activity timeline (HiddenFeaturePanels.tsx:722, :728)", async () => {
  const r = await renderInProviders(Screen, h(Screen.default, {}));
  await settle();
  assert.ok(r.hasText("Activity timeline"));
  assert.ok(r.hasText("No events recorded for this request."));
});
