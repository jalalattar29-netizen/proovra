/**
 * T-15 / T-14 — Evidence Copilot (POST /v1/ai/evidence/:id/copilot) at the top
 * of the Review tab. Native had no copilot, and hid the Review tab from every
 * plan without reviewer operations although the web shows it to everyone.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};
let revision;
const EV = "11111111-1111-4111-8111-111111111111";
const RESULT = {
  data: {
    status: "ok",
    droppedCitations: 1,
    data: {
      operationalSummary: "Signed and timestamped; report pending.",
      missingContext: ["No capture location recorded."],
      integritySignalExplanations: [],
      custodyObservations: ["Two custody events recorded."],
      timestampingObservations: [], reportReadiness: [], packageReadiness: [], reviewerPreparation: [], workflowGaps: [], suggestedNavigation: [], suggestedActions: [],
      citations: [
        { type: "EVIDENCE_RECORD", objectId: EV, displayLabel: "Roof photo", route: `/evidence/${EV}`, objectVersion: 2 },
        { type: "POLICY", objectId: "p1", displayLabel: "Retention policy", route: "javascript:alert(1)", objectVersion: null },
      ],
      advisoryBoundary: "Advisory only — not a determination of authenticity.",
    },
  },
  serverActions: [{ suggestionId: "s1", actionType: "GENERATE_REPORT", displayLabel: "Generate report & verification package", reason: "", riskLevel: "LOW" }],
};

before(async () => {
  M = await loadModule("app/(stack)/evidence/[id].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  revision = "rev-abc";
  M.calls.reset();
  globalThis.__EXPO_PARAMS__ = { id: EV };
  routes = {
    ...authenticatedRoutes(),
    // The revision lives on the REVIEW-WORKSPACE record, as the server sends it.
    [`/v1/evidence/${EV}/review-workspace`]: () => ({ evidence: { id: EV, analysisRevision: revision }, relationships: { items: [] }, reviewWorkflow: null }),
    [`/v1/evidence/${EV}/reports/regenerate`]: () => ({ outcome: "ENQUEUED", message: "Report generation was queued." }),
    // GET /v1/evidence/:id carries no analysisRevision (evidence.routes.ts) — a stub that put it here proved nothing.
    [`/v1/evidence/${EV}`]: () => ({ evidence: { id: EV, status: "SIGNED", type: "PHOTO" } }),
    [`/v1/ai/evidence/${EV}/copilot`]: () => RESULT,
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    if (!path.startsWith("/v1/me/presence")) requests.push({ path, method, body });
    const key = routes[path] ? path : Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key]() : undefined;
    const status = res === undefined ? 500 : res.__status ?? 200;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status, headers: { "content-type": "application/json" } });
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

test("the Review tab exists without reviewer operations and opens with the advisory copilot", async () => {
  const r = await openReview();
  assert.ok(r.hasText("Evidence Copilot") && r.hasText("Advisory only") && r.hasText("Metadata only"));
  await r.press("Run Evidence Copilot");
  await settle();
  const post = requests.find((q) => q.path === `/v1/ai/evidence/${EV}/copilot`);
  assert.equal(post.body.evidenceRevision, "rev-abc");
  assert.equal(post.body.processingMode, "METADATA_ONLY");
  assert.match(post.body.idempotencyKey, /^evidence:11111111-1111-4111-8111-111111111111:/);
  assert.ok(r.hasText("Signed and timestamped; report pending."));
  assert.ok(r.hasText("Missing context") && r.hasText("• No capture location recorded."));
  assert.ok(!r.hasText("Integrity signals (explained)"), "an empty section was rendered");
  assert.ok(r.hasText("1 unverifiable citation(s) were removed."));
  assert.ok(r.hasText("Advisory only — not a determination of authenticity."));
});

test("citations link only through a safe server route mapped to a native screen", async () => {
  const r = await openReview();
  await r.press("Run Evidence Copilot");
  await settle();
  await r.press("View Evidence source: Roof photo · v2");
  assert.equal(M.calls.push.at(-1), `/evidence/${EV}`);
  assert.equal(r.byLabel("View Policy source: Retention policy").length, 0, "an unsafe route became a link");
  assert.equal(r.byLabel("Policy source: Retention policy").length, 1);
});

test("the server's offer runs only after confirmation and reports the typed outcome", async () => {
  const r = await openReview();
  await r.press("Run Evidence Copilot");
  await settle();
  await r.press("Generate report & verification package");
  assert.ok(!requests.some((q) => q.path.endsWith("/reports/regenerate")), "ran without confirmation");
  await r.press("Confirm and run");
  await settle();
  assert.ok(requests.some((q) => q.method === "POST" && q.path === `/v1/evidence/${EV}/reports/regenerate`));
  assert.ok(r.hasText("Report generation was queued."));
});

test("no revision → no run is sent; a discarded answer is never shown", async () => {
  revision = null;
  let r = await openReview();
  assert.ok(r.hasText("This record's analysis revision is not available, so the copilot cannot be run on it right now."));
  await r.press("Run Evidence Copilot");
  assert.ok(!requests.some((q) => q.path.includes("/copilot")));
  r.unmount();
  revision = "rev-abc";
  routes[`/v1/ai/evidence/${EV}/copilot`] = () => ({ data: { status: "schema_error", data: { operationalSummary: "LEAKED" } } });
  r = await openReview();
  await r.press("Run Evidence Copilot");
  await settle();
  assert.ok(r.hasText("The AI response did not meet PROOVRA's output contract and was discarded. Nothing from it was saved or shown."));
  assert.ok(!r.hasText("LEAKED"));
});
