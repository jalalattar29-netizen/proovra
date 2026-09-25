/**
 * RENDER TEST — the evidence request list.
 *
 * The web has no standalone list page; its request rows live on the matter
 * (MatterWorkspace.tsx:1300-1321), where each row reads
 * "status · N/M required · P% complete · needs more info · review-ready".
 * Native's list now carries that same summary, computed from the
 * projection's deliverables (GET /v1/evidence-requests?teamId= →
 * { requests: projectRequestForAuthenticatedView[] }, routes.ts:284-286).
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn, assertScopedRequests } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let routes = {};
let requests = [];
let mounted = null;

const ROW = (over = {}) => ({
  id: "r-1",
  teamId: "team-1",
  title: "Photographs of the vehicle",
  status: "NEEDS_MORE_INFO",
  priority: "NORMAL",
  requestType: "PHOTO_SET",
  dueAtUtc: null,
  caseId: null,
  evidenceId: null,
  deliverables: [
    { id: "d1", title: "Front", required: true, status: "FULFILLED", fulfilledCount: 1, minCount: 1, maxCount: null, acceptedKinds: [], waivedReason: null },
    { id: "d2", title: "Rear", required: true, status: "PENDING", fulfilledCount: 0, minCount: 1, maxCount: null, acceptedKinds: [], waivedReason: null },
  ],
  responses: [],
  ...over,
});

before(async () => {
  M = await loadModule("app/(stack)/evidence-requests.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  routes = authenticatedRoutes({
    "/v1/evidence-requests": () => ({ requests: [ROW()] }),
  });
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, method: init.method ?? "GET" });
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    return new Response(JSON.stringify(key ? routes[key]() : { message: "unstubbed" }), {
      status: key ? 200 : 500,
      headers: { "content-type": "application/json" },
    });
  };
  await signIn(M);
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};

test("each row carries the web's completion summary (MatterWorkspace.tsx:1311-1321)", async () => {
  mounted = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  assertScopedRequests(assert, requests, ["/v1/evidence-requests"]);
  assert.ok(mounted.hasText("Photographs of the vehicle"));
  assert.ok(mounted.hasText("1/2 required · 50% complete · needs more info"), mounted.texts().join(" | "));
  await mounted.press("Photographs of the vehicle");
  assert.equal(M.calls.push.at(-1), "/evidence-request/r-1");
});
