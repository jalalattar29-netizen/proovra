/**
 * T-14 — AI categorization (web AiCategorizationPanel, EvidenceReviewTab review
 * tools, every plan). Native had no categorization at all. Payloads are the
 * route's own replies (evidence.routes.ts:8517 GET, :8592 run): read only on
 * open; DISABLED says so and offers no Run (the web rule); a FAILED record
 * offers Run; a COMPLETED record lists the advisory and offers Re-run; a 429
 * from the cost guard is shown, not retried.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn, platformContextEnvelope } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let routes = {};
let reads = [];
const CAT = (over = {}) => ({
  categorization: {
    status: "COMPLETED",
    summary: "Photo of a vehicle, daytime, outdoor.",
    categories: ["Vehicle damage", "Outdoor scene"],
    suggestedTags: ["car", "daylight"],
    riskFlags: [{ severity: "LOW", title: "Low resolution", detail: "Fine detail may be hard to review." }],
    legalDisclaimer: "Advisory only.",
    model: "claude-sonnet-5",
    createdAt: "2026-09-20T10:00:00.000Z",
    updatedAt: "2026-09-20T10:00:00.000Z",
    ...over,
  },
});

before(async () => {
  M = await loadModule("app/(stack)/evidence/[id].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  reads = [];
  globalThis.__EXPO_PARAMS__ = { id: "ev-1" };
  routes = {
    ...authenticatedRoutes({ "/v1/platform/context": () => platformContextEnvelope({}) }),
    "/v1/evidence/ev-1/ai-categorization/run": () => ({ status: 200, body: CAT() }),
    "/v1/evidence/ev-1/ai-categorization": () => ({ status: 200, body: CAT() }),
    "/v1/evidence/ev-1/review-workspace": () => ({ status: 200, body: { relationships: { items: [] } } }),
    "/v1/evidence/ev-1": () => ({ status: 200, body: { evidence: { id: "ev-1", status: "SIGNED", type: "PHOTO" } } }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    reads.push({ path, method: init.method ?? "GET" });
    const key = routes[path] ? path : Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    let out = key ? routes[key]() : { status: 500, body: {} };
    if (!out || typeof out.status !== "number") out = { status: 200, body: out };
    return new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const openPanel = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  await r.press("Review");
  await settle();
  assert.equal(r.byTestId("ai-categorization").length, 1, "no AI categorization on the Review tab");
  assert.ok(!reads.some((q) => q.path === "/v1/evidence/ev-1/ai-categorization"), "read before it was opened");
  await r.press("AI categorization");
  await settle();
  return r;
};

test("a completed categorization lists the advisory in the web's words, with Re-run", async () => {
  const r = await openPanel();
  assert.ok(r.hasText("AI categorization is advisory and metadata-only. It does not determine factual truth, authorship, integrity, or legal outcome."));
  assert.ok(r.hasText("Photo of a vehicle, daytime, outdoor."));
  assert.ok(r.hasText("Vehicle damage, Outdoor scene") && r.hasText("car, daylight"));
  assert.ok(r.hasText("Low resolution") && r.hasText("Fine detail may be hard to review."));
  assert.ok(r.texts().some((t) => t.startsWith("claude-sonnet-5 • ")));
  assert.equal(r.byLabel("Run metadata-only AI categorization").length, 0);
  await r.press("Re-run AI advisory review");
  await settle();
  assert.ok(reads.some((q) => q.path === "/v1/evidence/ev-1/ai-categorization/run" && q.method === "POST"));
});

test("DISABLED says it is not active and offers no Run (the web rule); FAILED offers Run", async () => {
  routes["/v1/evidence/ev-1/ai-categorization"] = () => ({ status: 200, body: CAT({ status: "DISABLED", summary: null, categories: [], suggestedTags: [], riskFlags: [], model: null, updatedAt: null }) });
  let r = await openPanel();
  assert.ok(r.hasText("AI categorization is not active for this record."));
  assert.equal(r.byLabel("Run metadata-only AI categorization").length, 0);
  r.unmount();
  reads = [];
  routes["/v1/evidence/ev-1/ai-categorization"] = () => ({ status: 200, body: CAT({ status: "FAILED" }) });
  r = await openPanel();
  await r.press("Run metadata-only AI categorization");
  await settle();
  assert.ok(reads.some((q) => q.path === "/v1/evidence/ev-1/ai-categorization/run" && q.method === "POST"));
  assert.ok(r.hasText("Photo of a vehicle, daytime, outdoor."), "the run result was not shown");
});

test("a cost-guard 429 on Run is stated and nothing is shown as categorized", async () => {
  routes["/v1/evidence/ev-1/ai-categorization"] = () => ({ status: 200, body: CAT({ status: "FAILED" }) });
  routes["/v1/evidence/ev-1/ai-categorization/run"] = () => ({ status: 429, body: { message: "AI categorization is temporarily unavailable" } });
  const r = await openPanel();
  await r.press("Run metadata-only AI categorization");
  await settle();
  assert.equal(r.byTestId("ai-categorization-result").length, 0);
  assert.ok(r.hasText("Please wait a moment and try again."), "a 429 was not read as the rate-limit answer");
  assert.ok(r.byLabel("Run metadata-only AI categorization").length >= 1, "Run vanished after a refusal");
});
