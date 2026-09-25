/**
 * Cases index — the web CasesIndex header, CreateCaseModal and row action menu
 * on native (apps/web/components/cases-experience/CasesIndex.tsx,
 * matter-modals/CreateCaseModal.tsx).
 *
 * Stubs use the server's own replies:
 *   GET  /v1/cases/matter-queue → { generatedAt, workspace, items, total } (case-workspace.routes.ts:303)
 *   POST /v1/cases              → the created row itself, 201 (cases.routes.ts:430)
 *   POST /v1/cases/:id/status   → { case } (case-workspace.routes.ts:925)
 *   DELETE /v1/cases/:id        → 204, no body (cases.routes.ts:1272)
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn, TEST_TEAM_ID } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};
const ID = "c0ffee00-0000-4000-8000-000000000001";
const NEW_ID = "c0ffee00-0000-4000-8000-0000000000ff";
const ROW = (over) => ({
  id: ID, name: "Leaking roof", referenceNumber: null, status: "OPEN", priority: "P2", ownerUserId: null, owner: null,
  teamId: TEST_TEAM_ID, linkedEvidenceCount: 2, evidenceGapCount: 0, openIncidentCount: 0, overdueWorkflowCount: 0,
  governanceBlockerCount: 0, activeLegalHoldCount: 0, riskScore: null, riskLevel: null, riskReasonCodes: [],
  recommendedAction: null, latestActivityAtUtc: new Date(Date.now() - 3 * 3600_000).toISOString(), ...over,
});

before(async () => {
  M = await loadModule("app/(tabs)/cases.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  M.calls.reset();
  routes = {
    ...authenticatedRoutes(),
    "/v1/cases/matter-queue": () => ({
      generatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      workspace: { teamId: TEST_TEAM_ID, role: "ADMIN" },
      items: [ROW({})],
      total: 1,
    }),
    [`/v1/cases/${ID}/status`]: () => ({ case: { id: ID, status: "ARCHIVED" } }),
    [`/v1/cases/${ID}`]: (method) => (method === "DELETE" ? { __status: 204 } : { case: {} }),
    "/v1/cases": () => ({ __status: 201, id: NEW_ID, name: "Insurance claim", teamId: TEST_TEAM_ID, ownerUserId: "user-1", status: "OPEN" }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    requests.push({ path, method, body: init.body ? JSON.parse(init.body) : null });
    const key = routes[path] ? path : Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key](method, path) : undefined;
    const status = res === undefined ? 500 : res.__status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  return r;
};

test("the header carries the web subtitle, the case total and when the queue was built", async () => {
  const r = await render();
  assert.ok(r.hasText("Group related evidence into simple workspaces for incidents, claims, projects, or reviews."));
  assert.equal(r.byLabel("1 case").length, 1, "the total badge is missing");
  assert.ok(r.hasText("Refreshed 5m ago"), "generatedAt was not read");
  // The web shows no workspace-summary metrics on this page.
  assert.ok(!requests.some((q) => q.path.startsWith("/v1/cases/summary")), "a metrics read the web page does not make");
  r.unmount();
});

test("status and readiness are stated as text in their tones, not as capsules", async () => {
  const r = await render();
  assert.ok(r.hasText("Open") && r.hasText("Ready"));
  // (the "Open" status FILTER chip is a button; a badge would be role=text)
  assert.equal(r.byLabel("Open").filter((n) => n.props.accessibilityRole === "text").length, 0, "the status still rendered as a badge");
  r.unmount();
});

test("Create case opens the web dialog: workspace, placeholder, helper; the created row's id is opened", async () => {
  const r = await render();
  await r.press("Create case");
  assert.ok(r.hasText("Create a new investigation matter in this workspace."));
  assert.ok(r.hasText("New case will be created in Test Workspace"));
  assert.ok(r.hasText("You can rename the case from its workspace at any time. Evidence, assignments, and comments are added after creation."));
  assert.equal(r.byLabel("Case name")[0].props.placeholder, "e.g. Insurance claim #4823");
  const submit = () => r.byLabel("Create case").filter((n) => n.props.onPress).at(-1);
  assert.equal(submit().props.accessibilityState.disabled, true, "an empty name could be submitted");
  await r.type("Case name", "Insurance claim");
  await act(async () => { await submit().props.onPress(); });
  await settle();
  assert.deepEqual(requests.find((q) => q.method === "POST" && q.path === "/v1/cases").body, { name: "Insurance claim", teamId: TEST_TEAM_ID });
  assert.equal(M.calls.push.at(-1), `/case/${NEW_ID}`, "the created row's own id was not opened");
  r.unmount();
});

test("the row menu: Rename / Change status open the case's Settings; Archive confirms then archives", async () => {
  const r = await render();
  await r.press("Case actions for Leaking roof");
  await r.press("Rename");
  assert.equal(M.calls.push.at(-1), `/case/${ID}?tab=settings`);
  await r.press("Case actions for Leaking roof");
  await r.press("Archive");
  assert.ok(r.hasText('Archive "Leaking roof"?'));
  assert.ok(r.hasText("Archiving hides this case from the default list. Linked evidence, reports and packages are preserved and unchanged."));
  await r.press("Archive case");
  await settle();
  assert.deepEqual(requests.find((q) => q.method === "POST" && q.path === `/v1/cases/${ID}/status`).body, { toStatus: "ARCHIVED" });
  assert.ok(r.hasText("Case archived."));
  r.unmount();
});

test("Delete from the row menu confirms, sends DELETE, and a 204 reads as success", async () => {
  const r = await render();
  await r.press("Case actions for Leaking roof");
  await r.press("Delete");
  assert.ok(r.hasText('Delete "Leaking roof"?'));
  await r.press("Delete case");
  await settle();
  assert.equal(requests.filter((q) => q.method === "DELETE" && q.path === `/v1/cases/${ID}`).length, 1);
  assert.ok(r.hasText("Case deleted."), "a successful 204 was reported as a failure");
  r.unmount();
});

test("an archived case cannot be archived again; enterprise rows name their reason codes", async () => {
  routes["/v1/platform/context"] = () => platformContextEnvelope({ flags: { isEnterpriseWorkspace: true } });
  routes["/v1/cases/matter-queue"] = () => ({ generatedAt: null, items: [ROW({ status: "ARCHIVED", riskLevel: "MEDIUM", riskScore: 40, riskReasonCodes: ["EVIDENCE_GAP", "LEGAL_HOLD_ACTIVE"] })], total: 1 });
  const r = await render();
  assert.ok(r.hasText("Evidence gap") && r.hasText("Legal preservation") && r.hasText("Risk: MEDIUM · 40"));
  await r.press("Case actions for Leaking roof");
  assert.equal(r.byLabel("Archive")[0].props.accessibilityState.disabled, true);
  r.unmount();
});
