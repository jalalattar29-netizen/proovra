/**
 * T-14 — small web facts native dropped:
 *   collaboration-teams/[teamId]/page.tsx:405 Request id on a load failure,
 *   :637 the "Archived" badge every member sees,
 *   collaboration-teams/invites/[token]/accept/page.tsx:604 Request id,
 *   CreateCaseModal.tsx:257 "Request ID:" on a create failure,
 *   FilterBar.tsx:256 Clear search on Matters.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let Team;
let Invite;
let Cases;
let routes = {};
const fail = (status, requestId) => ({ __status: status, error: { code: "INTERNAL", message: "Something failed.", requestId } });

before(async () => {
  Team = await loadModule("app/(stack)/collaboration-team/[id].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
  Invite = await loadModule("app/(stack)/invite/[token].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/api.ts"]);
  Cases = await loadModule("app/(tabs)/cases.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(() => {
  routes = { ...authenticatedRoutes() };
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const key = routes[path.split("?")[0]] ? path.split("?")[0] : Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key]() : undefined;
    const status = res === undefined ? 500 : res.__status ?? 200;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status, headers: { "content-type": "application/json" } });
  };
});
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const mount = async (M) => {
  await signIn(M);
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  return r;
};

test("a collaboration group that fails to load shows its request id", async () => {
  globalThis.__EXPO_PARAMS__ = { id: "t1" };
  routes["/v1/collaboration-teams/t1"] = () => fail(503, "req-team-9");
  const r = await mount(Team);
  assert.ok(r.hasText("Support reference") && r.hasText("req-team-9"));
});

test("an archived group says so to every member", async () => {
  globalThis.__EXPO_PARAMS__ = { id: "t1" };
  routes["/v1/collaboration-teams/t1"] = () => ({ team: { id: "t1", name: "Claims", status: "ARCHIVED", viewerRole: "MEMBER", activeMemberCount: 2, pendingInviteCount: 0, members: [], invites: [] } });
  routes["/v1/collaboration-teams/entitlement"] = () => ({});
  routes["/v1/collaboration-teams/t1/comments"] = () => ({ items: [], directory: {} });
  routes["/v1/collaboration-teams/t1/assignments"] = () => ({ items: [], nextCursor: null, total: 0 });
  const r = await mount(Team);
  assert.equal(r.byLabel("Archived").length, 1);
});

test("a failed invitation accept shows its request id", async () => {
  globalThis.__EXPO_PARAMS__ = { token: "ctinv_abc" };
  routes["/v1/collaboration-team-invites/accept"] = () => fail(503, "req-inv-7");
  Invite.setAuthToken("test-token");
  const r = await mount(Invite);
  await r.press("Accept invitation");
  await settle();
  assert.ok(r.hasText("Support reference") && r.hasText("req-inv-7"));
  await r.press("Copy support reference");
  for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
  assert.equal(globalThis.__CLIPBOARD__, "req-inv-7");
});

test("Matters: Clear search empties the query; a create failure carries its Request ID", async () => {
  routes["/v1/cases/matter-queue"] = () => ({ items: [], nextCursor: null, total: 0, summary: {} });
  routes["/v1/cases"] = () => fail(500, "req-case-3");
  const r = await mount(Cases);
  await r.type("Search cases, owners, IDs, or references", "roof");
  await r.press("Clear search");
  assert.equal(r.byLabel("Clear search").length, 0, "the query was not cleared");
  await r.press("Create case");
  await r.type("Case name", "Leaking roof");
  // The create sheet's submit is the LAST pressable "Create case" (the header and empty-state CTAs open it).
  const create = r.byLabel("Create case").filter((n) => n.props.onPress).at(-1);
  await act(async () => { await create.props.onPress(); });
  await settle();
  assert.ok(r.hasText("Support reference") && r.hasText("req-case-3"), "the create failure lost its support reference");
});

test("the invitation keeps the web trust line with Privacy, Terms and Support", async () => {
  globalThis.__EXPO_PARAMS__ = { token: "ctinv_abc" };
  Invite.setAuthToken("test-token");
  const r = await mount(Invite);
  assert.ok(r.texts().some((t) => t.includes("Invitation links are single-use and expire. Never share this link.")));
  await r.press("Support");
  assert.equal(Invite.calls.push.at(-1), "/support");
});
