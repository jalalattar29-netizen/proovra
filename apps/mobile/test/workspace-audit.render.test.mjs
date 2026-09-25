/**
 * T-12 / RC-13 — the workspace Audit history (WorkspaceAuditTab.tsx:129
 * "Filter by outcome"), mounted on Spaces as the web mounts it on /workspaces.
 *
 * Native had no tenant-audit surface at all. These tests assert the filters
 * reach the SERVER query (never an in-memory filter), paging uses the server
 * cursor, the gate matches the web (ORGANIZATION + TEAM_MANAGE), and a denial
 * is one generic sentence.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn, TEST_TEAM_ID } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};

const PAGE1 = {
  items: [
    { eventId: "e1", occurredAtUtc: "2026-09-24T10:00:00.000Z", action: "evidence.viewed", outcome: "success", resourceType: "evidence", resourceId: "ev-1" },
    { eventId: "e2", occurredAtUtc: "2026-09-24T09:00:00.000Z", action: "team.member.removed", outcome: "denied", resourceType: null, resourceId: null },
  ],
  nextCursorId: "11111111-1111-1111-1111-111111111111",
};
const PAGE2 = { items: [{ eventId: "e3", occurredAtUtc: "2026-09-23T09:00:00.000Z", action: "report.generated", outcome: "error", resourceType: "report", resourceId: "r-1" }], nextCursorId: null };

before(async () => {
  M = await loadModule("app/(stack)/spaces.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  routes = {
    ...authenticatedRoutes({
      "/v1/platform/context": () => platformContextEnvelope({ capabilities: { TEAM_MANAGE: true } }),
    }),
    "/v1/audit/tenant": (path) => (path.includes("cursorId=") ? PAGE2 : PAGE1),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push(path);
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
const audits = () => requests.filter((p) => p.startsWith("/v1/audit/tenant"));

test("an ORGANIZATION admin sees the workspace audit, read through the tenant authority", async () => {
  const r = await render();
  assert.equal(r.byTestId("workspace-audit").length, 1);
  assert.equal(audits()[0], `/v1/audit/tenant?teamId=${TEST_TEAM_ID}`);
  assert.ok(r.hasText("evidence.viewed"));
  assert.ok(r.hasText("2026-09-24T10:00:00.000Z UTC · evidence:ev-1"));
  assert.ok(r.hasText("2026-09-24T09:00:00.000Z UTC · —"));
});

test("the outcome and action filters run on the SERVER", async () => {
  const r = await render();
  await r.press("Filter by outcome: Denied");
  await settle();
  assert.match(audits().at(-1), /[?&]outcome=denied(&|$)/);
  await r.type("Filter by action", "team.member.removed");
  await settle(150);
  assert.match(audits().at(-1), /[?&]action=team\.member\.removed(&|$)/);
  assert.match(audits().at(-1), /outcome=denied/, "filters did not compose into one query");
  await r.press("Filter by outcome: Any outcome");
  await settle();
  assert.doesNotMatch(audits().at(-1), /outcome=/);
});

test("Load more follows the server cursor and appends", async () => {
  const r = await render();
  await r.press("Load more");
  await settle();
  assert.match(audits().at(-1), /cursorId=11111111-1111-1111-1111-111111111111/);
  assert.ok(r.hasText("evidence.viewed") && r.hasText("report.generated"), "the second page replaced the first");
  assert.equal(r.byLabel("Load more").length, 0, "Load more offered past the last page");
});

test("a denial is one generic sentence, never an empty history", async () => {
  routes["/v1/audit/tenant"] = () => ({ __status: 403, message: "forbidden" });
  const r = await render();
  assert.ok(!r.hasText("No audit events for the current filters."), "a denial read as 'no events'");
  assert.equal(r.byTestId("workspace-audit").length, 1);
  assert.ok(r.hasText("Audit history is not available."), "the denial is not the generic sentence");
  assert.ok(!r.hasText("forbidden"), "the server's denial text leaked through");
});

test("no TEAM_MANAGE, or a PERSONAL space: no audit surface and no audit request", async () => {
  routes["/v1/platform/context"] = () => platformContextEnvelope();
  let r = await render();
  assert.equal(r.byTestId("workspace-audit").length, 0);
  r.unmount();
  routes["/v1/platform/context"] = () =>
    platformContextEnvelope({ capabilities: { TEAM_MANAGE: true }, activeSpace: { id: TEST_TEAM_ID, type: "PERSONAL", plan: "PRO", displayName: "Me", status: "active" } });
  r = await render();
  assert.equal(r.byTestId("workspace-audit").length, 0);
  assert.equal(audits().length, 0, "audit queried for a surface that is not shown");
});
