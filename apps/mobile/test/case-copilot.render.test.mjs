/**
 * T-15 / T-14 — Case Copilot (POST /v1/ai/case/:id/copilot) on the case
 * screen. Native had none. Eligibility is the shared authority the server also
 * runs; revisions come from the matter-workspace projection and are carried
 * back verbatim.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};
let wsReads = 0;
const CASE = "c0ffee00-0000-4000-8000-000000000001";
const REV_A = `ear2_${"A".repeat(43)}`;
const REV_B = `ear2_${"B".repeat(43)}`;
const ITEMS = [
  { id: "e-a", title: "Roof photo", type: "PHOTO", status: "SIGNED", lifecycleState: "ACTIVE", verificationPackageVersion: 2, analysisRevision: REV_A },
  { id: "e-b", title: null, displayFileName: "gutter.mov", type: "VIDEO", status: "REPORTED", lifecycleState: "ACTIVE", verificationPackageVersion: null, analysisRevision: REV_B },
  { id: "e-c", title: "Still uploading clip", type: "VIDEO", status: "UPLOADING", lifecycleState: "ACTIVE", verificationPackageVersion: null, analysisRevision: REV_B },
];

before(async () => {
  M = await loadModule("app/(stack)/case/[id].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  wsReads = 0;
  globalThis.__EXPO_PARAMS__ = { id: CASE };
  routes = {
    ...authenticatedRoutes(),
    [`/v1/cases/${CASE}/matter-workspace`]: () => {
      wsReads += 1;
      return { case: { id: CASE }, viewer: {}, sections: { evidence: { status: "ok", items: ITEMS } } };
    },
    [`/v1/cases/${CASE}`]: () => ({ case: { id: CASE, name: "Leaking roof", status: "OPEN", teamId: "team-1", access: [] } }),
    "/v1/evidence": () => ({ items: [] }),
    [`/v1/ai/case/${CASE}/copilot`]: () => ({
      data: {
        status: "ok",
        data: {
          caseSummary: "Two records cover the north-east corner.",
          timelineHighlights: ["Photo precedes video by 2 days."],
          missingEvidenceCategories: [], workflowGaps: [], conflictingMetadata: [], reviewerPreparation: [], disclosureChecklist: [], unresolvedQuestions: [],
          citations: [{ type: "CASE", objectId: CASE, displayLabel: "Leaking roof", route: `/cases/${CASE}`, objectVersion: null }],
          advisoryBoundary: "Advisory only.",
        },
      },
    }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    if (!path.startsWith("/v1/me/presence")) requests.push({ path, method, body: init.body ? JSON.parse(init.body) : null });
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
// The Copilot sits beside the evidence, on the Evidence section (SimpleCaseDetail.tsx:385-445).
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  await r.press("Evidence");
  await settle();
  return r;
};

test("eligibility is shown per record; only eligible ones can be chosen; the run carries their revisions", async () => {
  const r = await render();
  assert.ok(r.hasText("Evidence Operations Copilot"));
  assert.ok(r.hasText("Still uploading"), "an ineligible record did not say why");
  assert.ok(r.texts().some((t) => t.includes("PHOTO · Signed · Package v2")));
  assert.ok(r.texts().some((t) => t.includes("gutter.mov")), "the title cascade was not applied");
  assert.ok(r.hasText("Select at least one eligible evidence record to run the Copilot."));
  await r.press("Select all");
  assert.ok(r.hasText("2 selected"), "an ineligible record was selected");
  assert.ok(r.hasText("Before you run") && r.hasText("Raw content: Not sent"));
  await r.press("Run Case Copilot");
  await settle();
  const post = requests.find((q) => q.path === `/v1/ai/case/${CASE}/copilot`);
  assert.deepEqual(post.body.selectedEvidenceIds, ["e-a", "e-b"]);
  assert.deepEqual(post.body.selectedEvidenceRevisions, { "e-a": REV_A, "e-b": REV_B });
  assert.match(post.body.idempotencyKey, new RegExp(`^case:${CASE}:`));
  assert.ok(post.body.idempotencyKey.length <= 80, "the key grew with the selection");
  assert.ok(r.hasText("Two records cover the north-east corner.") && r.hasText("• Photo precedes video by 2 days."));
});

test("a 409 re-reads the linked records instead of asking the operator to guess", async () => {
  routes[`/v1/ai/case/${CASE}/copilot`] = () => ({ __status: 409 });
  const r = await render();
  const before = wsReads;
  await r.press("Select all");
  await r.press("Run Case Copilot");
  await settle();
  assert.ok(r.hasText("A selected record changed while you were choosing. The list has been refreshed — review the selection and try again."));
  assert.ok(wsReads > before, "the list was not refreshed");
  assert.equal(r.byLabel("Retry").length, 0);
});
