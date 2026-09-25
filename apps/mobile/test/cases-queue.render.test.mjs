/**
 * T-15 — Matters reads the ACTIVE workspace's matter queue
 * (GET /v1/cases/matter-queue?teamId=…). It used to read GET /v1/cases, which
 * returns every case the user can reach in ANY workspace, and filtered that
 * mixed page on the device. Creating a case also dropped the workspace.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn, TEST_TEAM_ID } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};

const ROW = (over) => ({
  id: "c0ffee00-0000-4000-8000-000000000001",
  name: "Leaking roof",
  referenceNumber: null,
  status: "OPEN",
  priority: "P1",
  ownerUserId: "user-2",
  owner: { userId: "user-2", displayName: "Rana Khalil", email: "rana@example.invalid" },
  teamId: TEST_TEAM_ID,
  linkedEvidenceCount: 3,
  evidenceGapCount: 2,
  openIncidentCount: 0,
  overdueWorkflowCount: 1,
  governanceBlockerCount: 0,
  activeLegalHoldCount: 1,
  riskScore: 72,
  riskLevel: "HIGH",
  latestActivityAtUtc: "2026-09-24T09:00:00.000Z",
  ...over,
});

before(async () => {
  M = await loadModule("app/(tabs)/cases.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  M.calls.reset();
  routes = {
    ...authenticatedRoutes(),
    "/v1/cases/matter-queue": () => ({ generatedAt: "x", workspace: { teamId: TEST_TEAM_ID, role: "ADMIN" }, items: [ROW({})], total: 1 }),
    "/v1/cases": () => ({ id: "new-case" }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    requests.push({ path, method, body: init.body ? JSON.parse(init.body) : null });
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key](path) : undefined;
    const status = res === undefined ? 500 : res.__status ?? 200;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});
const settle = async (ms = 0) => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, ms)); });
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  return r;
};
const queueReads = () => requests.filter((q) => q.path.startsWith("/v1/cases/matter-queue"));

test("the list is the active workspace's queue, never the cross-workspace /v1/cases index", async () => {
  const r = await render();
  assert.equal(queueReads()[0]?.path, `/v1/cases/matter-queue?teamId=${TEST_TEAM_ID}`);
  assert.ok(!requests.some((q) => q.method === "GET" && q.path.split("?")[0] === "/v1/cases"), "the cross-workspace index was read");
  assert.ok(r.hasText("Cases · 1"));
  assert.ok(r.hasText("Leaking roof"));
  assert.ok(r.texts().some((t) => t.includes("#c0ffee00 · Rana Khalil · 3 records")), "row identity/owner/evidence not shown");
  assert.ok(r.hasText("Needs attention"), "a case with an evidence gap was not flagged");
});

test("readiness is derived honestly: empty = Not started, no gap = Ready, no owner = Unassigned", async () => {
  routes["/v1/cases/matter-queue"] = () => ({
    items: [
      ROW({ id: "c0ffee00-0000-4000-8000-000000000002", name: "Empty one", linkedEvidenceCount: 0, evidenceGapCount: 0, ownerUserId: null, owner: null }),
      ROW({ id: "c0ffee00-0000-4000-8000-000000000003", name: "Clean one", evidenceGapCount: 0 }),
    ],
    total: 2,
  });
  const r = await render();
  assert.ok(r.hasText("Not started") && r.hasText("Ready"));
  assert.ok(r.texts().some((t) => t.includes("Unassigned · No records")));
});

test("status and search are the SERVER's filters; '#' is stripped from an id search", async () => {
  const r = await render();
  await r.press("Investigating");
  await settle();
  assert.ok(queueReads().some((q) => q.path === `/v1/cases/matter-queue?teamId=${TEST_TEAM_ID}&status=INVESTIGATING`));
  await r.type("Search cases, owners, IDs, or references", "#c0ffee00");
  await settle(60);
  await new Promise((x) => setTimeout(x, 320));
  await settle();
  assert.ok(
    queueReads().some((q) => q.path === `/v1/cases/matter-queue?teamId=${TEST_TEAM_ID}&search=c0ffee00&status=INVESTIGATING`),
    `search not sent to the server: ${queueReads().map((q) => q.path).join(" | ")}`,
  );
});

test("an empty filtered queue says 'no match' and offers to clear, not 'no cases yet'", async () => {
  routes["/v1/cases/matter-queue"] = (path) =>
    path.includes("status=") ? { items: [], total: 0 } : { items: [ROW({})], total: 1 };
  const r = await render();
  await r.press("Archived");
  await settle();
  assert.ok(r.hasText("No cases match these filters"));
  await r.press("Clear filters");
  await settle();
  assert.ok(r.hasText("Leaking roof"));
});

test("enterprise workspaces see risk, hold and counters; others see the simple row", async () => {
  let r = await render();
  assert.ok(!r.hasText("HIGH · 72") && !r.hasText("Legal preservation"), "advanced ops shown to a non-enterprise workspace");
  r.unmount();
  routes["/v1/platform/context"] = () => platformContextEnvelope({ flags: { isEnterpriseWorkspace: true } });
  r = await render();
  // CasesIndex.tsx:1294 / :1619 — the web words: "Legal preservation", "Risk: HIGH · 72".
  assert.ok(r.hasText("Risk: HIGH · 72") && r.hasText("Legal preservation") && r.hasText("P1"));
  assert.ok(r.texts().some((t) => t.includes("2 gap · 1 overdue")));
});

test("403 is a permission statement; a new case is created IN the workspace", async () => {
  routes["/v1/cases/matter-queue"] = () => ({ __status: 403 });
  let r = await render();
  assert.ok(r.hasText("You do not have permission to view the matter queue for this workspace. Ask a workspace administrator."));
  r.unmount();
  routes["/v1/cases/matter-queue"] = () => ({ items: [], total: 0 });
  r = await render();
  await r.press("Create case");
  await r.type("Case name", "Unit 4 inspection");
  // The sheet's submit is the LAST "Create case"; the header and empty-state CTAs come first.
  const submit = r.byLabel("Create case").filter((n) => n.props.onPress).at(-1);
  await act(async () => { await submit.props.onPress(); });
  await settle();
  const post = requests.find((q) => q.method === "POST" && q.path === "/v1/cases");
  assert.deepEqual(post.body, { name: "Unit 4 inspection", teamId: TEST_TEAM_ID });
});
