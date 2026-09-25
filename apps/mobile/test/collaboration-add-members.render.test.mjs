/**
 * T-12 / RC-13 — "Add workspace members" on a collaboration group
 * (collaboration-teams/[teamId]/_tabs/MembersTab.tsx:1031 AddMemberPanel).
 *
 * Before: a group's roster was read-only on native — nobody could be put on a
 * team from a phone. Now the server's eligible-members directory is offered as
 * a multi-select; one person uses the single writer, several use the bulk
 * route, and partial success is reported with the failures left selected.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadWithProviders, renderInProviders, React, act } from "./support/render.mjs";

const h = React.createElement;
let Screen;
let requests = [];
let routes = {};

const TEAM = (over = {}) => ({
  team: { id: "t1", name: "Claims", status: "ACTIVE", viewerRole: "LEAD", activeMemberCount: 2, pendingInviteCount: 0, members: [], invites: [], ...over },
});
const ELIGIBLE = {
  members: [
    { userId: "u-a", displayName: "Ari", email: "ari@example.com", workspaceRole: "MEMBER" },
    { userId: "u-b", displayName: "Bo", email: null, workspaceRole: "ADMIN" },
  ],
  nextCursor: null,
};

before(async () => {
  Screen = await loadWithProviders("app/(stack)/collaboration-team/[id].tsx");
});
beforeEach(() => {
  requests = [];
  globalThis.__EXPO_PARAMS__ = { id: "t1" };
  routes = {
    "/v1/collaboration-teams/t1": () => TEAM(),
    "/v1/collaboration-teams/entitlement": () => ({ collaborationTeamMembers: { limit: 10, source: "plan" } }),
    "/v1/collaboration-teams/t1/eligible-members": () => ELIGIBLE,
    "/v1/collaboration-teams/t1/members/bulk": () => ({ added: ["u-a", "u-b"], failed: [] }),
    "/v1/collaboration-teams/t1/members": () => ({ member: { id: "m-new" } }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    requests.push({ path, method, body: init.body ? JSON.parse(init.body) : null });
    const bare = path.split("?")[0];
    const res = routes[bare] ? routes[bare](method) : undefined;
    const status = res === undefined ? 500 : res.__status ?? 200;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status, headers: { "content-type": "application/json" } });
  };
});

const settle = async (ms = 0) => {
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, ms)); });
};
const render = async () => {
  const r = await renderInProviders(Screen, h(Screen.default, {}));
  await settle();
  return r;
};
const openPanel = async (r) => {
  await r.press("Add workspace members");
  await settle(80); // the directory read is debounced 200ms, as on the web
};

test("a LEAD can open the picker; it lists the server's ELIGIBLE members", async () => {
  const r = await render();
  await openPanel(r);
  assert.ok(requests.some((q) => q.path === "/v1/collaboration-teams/t1/eligible-members?limit=25"), "directory never read");
  assert.equal(r.byRole("checkbox").length, 2);
  assert.ok(r.byLabel("Ari, ari@example.com").length === 1);
});

test("one person → the single writer, with the chosen role", async () => {
  const r = await render();
  await openPanel(r);
  await r.press("Ari, ari@example.com");
  await r.press("Role in this team: Viewer");
  await r.press("Add to team");
  await settle();
  const post = requests.find((q) => q.method === "POST");
  assert.equal(post.path, "/v1/collaboration-teams/t1/members");
  assert.deepEqual(post.body, { userId: "u-a", role: "VIEWER" });
  assert.equal(r.byTestId("add-member-panel").length, 0, "panel stayed open after a full success");
});

test("several → the bulk route; partial success keeps the failures selected", async () => {
  routes["/v1/collaboration-teams/t1/members/bulk"] = () => ({ added: ["u-a"], failed: [{ userId: "u-b", reason: "limit_reached" }] });
  const r = await render();
  await openPanel(r);
  await r.press("Ari, ari@example.com");
  await r.press("Bo");
  assert.ok(r.byLabel("Add 2 to team").length === 1);
  await r.press("Add 2 to team");
  await settle();
  const post = requests.find((q) => q.method === "POST");
  assert.equal(post.path, "/v1/collaboration-teams/t1/members/bulk");
  assert.deepEqual(post.body, { userIds: ["u-a", "u-b"], role: "MEMBER" });
  assert.ok(r.hasText("Added 1. 1 could not be added — the team may be at its member limit."));
  assert.equal(r.byTestId("add-member-panel").length, 1, "panel closed on a partial failure");
  const bo = r.byLabel("Bo")[0];
  assert.equal(bo.props.accessibilityState.checked, true, "the failed person was deselected");
  assert.equal(r.byLabel("Ari, ari@example.com")[0].props.accessibilityState.checked, false);
});

test("a MEMBER (no team.member.invite) is offered no add control; an archived team neither", async () => {
  routes["/v1/collaboration-teams/t1"] = () => TEAM({ viewerRole: "MEMBER" });
  let r = await render();
  assert.equal(r.byLabel("Add workspace members").length, 0);
  r.unmount();
  routes["/v1/collaboration-teams/t1"] = () => TEAM({ status: "ARCHIVED" });
  r = await render();
  assert.equal(r.byLabel("Add workspace members").length, 0);
});

test("at the plan's per-group limit the control is disabled and Upgrade is offered", async () => {
  routes["/v1/collaboration-teams/entitlement"] = () => ({ collaborationTeamMembers: { limit: 2, source: "plan" } });
  const r = await render();
  const btn = r.byLabel("Add workspace members, team is at capacity")[0];
  assert.ok(btn?.props.accessibilityState.disabled, "add offered past the member ceiling");
  assert.ok(r.hasText("Team is at capacity for your plan. Upgrade to add more."));
  assert.ok(r.byLabel("Upgrade").length === 1);
});

test("an empty directory hands off to workspace invitation instead of dead-ending", async () => {
  routes["/v1/collaboration-teams/t1/eligible-members"] = () => ({ members: [], nextCursor: null });
  const r = await render();
  await openPanel(r);
  assert.ok(r.hasText("Everyone in this workspace is already in this team."));
  assert.ok(r.byLabel("Invite someone to the workspace").length === 1);
});
