/**
 * MEMBERS AUDIT LIFE-01/02/07 — mobile Settings → Workspace lifecycle.
 *
 * Parity with the web section: the screen renders the SERVER's `lifecycle`
 * projection and offers no delete control for any Workspace kind. Ownership
 * transfer, closure and reopen moved here from the People screen; their
 * behaviour is proven against the real reply shapes, as it was there.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests;
let routes;
let detail;
let closure;
let current;

const member = (id, userId, role, name) => ({ id, userId, role, status: "ACTIVE", createdAt: "2026-01-01T00:00:00.000Z", user: { id: userId, displayName: name }, label: name });

const POLICY = {
  PERSONAL: { kind: "PERSONAL", endPath: "ACCOUNT_CLOSURE", deletable: false, closable: false, transferable: false, nextAction: "CLOSE_ACCOUNT" },
  ORGANIZATION: { kind: "ORGANIZATION", endPath: "ORGANIZATION_OFFBOARDING", deletable: false, closable: false, transferable: false, nextAction: "ORGANIZATION_OFFBOARDING" },
  OWNED: { kind: "OWNED", endPath: "WORKSPACE_CLOSURE", deletable: false, closable: true, transferable: true, nextAction: "REQUEST_WORKSPACE_CLOSURE" },
};

before(async () => {
  M = await loadModule("app/(stack)/settings/workspace-lifecycle.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});

beforeEach(async () => {
  requests = [];
  detail = {
    id: "team-1",
    name: "Acme",
    ownerUserId: "user-1",
    currentUserRole: "OWNER",
    canManageMembers: true,
    canManageWorkspace: true,
    lifecycle: POLICY.OWNED,
    stats: { memberCount: 2, pendingInviteCount: 0, caseCount: 0 },
    memberPage: { total: 2, returned: 2, hasMore: false, endpoint: "/v1/teams/team-1/members" },
    members: [member("m-self", "user-1", "OWNER", "Test Operator")],
  };
  closure = { request: null, blockers: [], confirmationPhrase: "close this workspace", coolingOffDays: 7, membersLosingAccess: 1 };
  current = { reopen: () => ({ reopened: { teamId: "team-1" } }) };
  routes = {
    ...authenticatedRoutes(),
    "/v1/teams/team-1/members": (path) =>
      path.includes("eligible=ownership_transfer")
        ? { members: [member("m-dana", "u-dana", "MEMBER", "Dana")], nextCursor: "m-dana", total: 60 }
        : { members: detail.members, nextCursor: null, total: detail.members.length },
    "/v1/teams/team-1/closure": () => closure,
    "/v1/teams/team-1/reopen": () => current.reopen(),
    "/v1/teams/team-1/transfer-ownership": () => ({ transfer: { teamId: "team-1", fromUserId: "user-1", toUserId: "u-dana" } }),
    "/v1/teams/team-1": () => detail,
    "/v1/me/inbox/summary": () => ({ unread: 0 }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    requests.push({ path, method, body: init.body ? JSON.parse(init.body) : null });
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    let res = key ? routes[key](path, method) : undefined;
    const status = res?.__status ?? (res === undefined ? 500 : 200);
    if (res?.__status) res = res.body;
    return new Response(JSON.stringify(res ?? {}), { status, headers: { "content-type": "application/json" } });
  };
  M.calls.reset();
  await signIn(M);
});

const settle = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  return r;
};
const noDelete = (r) => {
  assert.equal(r.byLabel("Delete workspace").length, 0, "a delete control is offered");
  assert.equal(requests.filter((q) => q.method === "DELETE").length, 0, "a DELETE was sent");
};

test("PERSONAL owner: no forwarding screen — straight to account closure (members experience D)", async () => {
  Object.assign(detail, { lifecycle: POLICY.PERSONAL });
  const r = await render();
  // A Personal Workspace has no lifecycle of its own: its owner lands on
  // Settings → Privacy, the history entry REPLACED so Back does not bounce.
  assert.equal(M.calls.replace.at(-1), "/settings/privacy");
  assert.equal(r.byLabel("Go to Close account").length, 0);
  noDelete(r);
  assert.equal(r.byLabel("Close this workspace…").length, 0);
  assert.equal(requests.filter((q) => q.path.includes("eligible=ownership_transfer")).length, 0, "transfer candidates were read");
  r.unmount();
});

test("PERSONAL, a collaborator: stays, says whose account it ends with, offers no account closure", async () => {
  Object.assign(detail, { lifecycle: POLICY.PERSONAL, canManageWorkspace: false, currentUserRole: "MEMBER" });
  const r = await render();
  assert.equal(M.calls.replace.length, 0);
  assert.ok(r.texts().some((t) => t.includes("belongs to its owner's account")));
  assert.equal(r.byLabel("Go to Close account").length, 0);
  assert.equal(r.hasText("Your Personal Workspace"), false);
  r.unmount();
});

test("ORGANIZATION: explains organization offboarding; no workspace-level actions", async () => {
  Object.assign(detail, { lifecycle: POLICY.ORGANIZATION });
  const r = await render();
  assert.ok(r.hasText("Organization Workspace"));
  noDelete(r);
  assert.equal(r.byLabel("Go to Close account").length, 0);
  assert.equal(requests.filter((q) => q.path === "/v1/teams/team-1/closure").length, 0);
  r.unmount();
});

test("OWNED owner: the transfer picker reads the server's eligible list, pages it, and confirms before sending", async () => {
  const r = await render();
  const eligible = requests.filter((q) => q.path.includes("eligible=ownership_transfer"));
  assert.ok(eligible.length >= 1, "the candidates were not read from the server");
  assert.match(eligible[0].path, /limit=50/);
  assert.ok(r.hasText("Showing 1 of 60 members who can take ownership"));
  await r.press("Dana");
  await r.press("Transfer ownership…");
  assert.ok(r.texts().some((t) => t.startsWith("Transfer Acme to Dana?")));
  await r.press("Confirm transfer");
  await settle();
  const post = requests.find((q) => q.path === "/v1/teams/team-1/transfer-ownership");
  assert.deepEqual(post.body, { newOwnerUserId: "u-dana" });
  assert.ok(r.hasText("Dana now owns Acme. Billing ownership moved with it; you remain a member."));
  noDelete(r);
  r.unmount();
});

test("OWNED owner: closure states the consequence and a completed closure offers Reopen — still no delete", async () => {
  closure = { ...closure, request: { id: "r1", status: "COMPLETED", blockersJson: null, requestedAtUtc: "2026-01-01T00:00:00.000Z", coolingOffEndsAtUtc: null, failureCode: null } };
  const r = await render();
  assert.ok(r.texts().some((t) => t.includes("7-day cancellation window") && t.includes("1 other member will lose access")));
  await r.press("Reopen workspace");
  await settle();
  assert.equal(requests.filter((q) => q.path === "/v1/teams/team-1/reopen" && q.method === "POST").length, 1);
  assert.ok(r.texts().some((t) => t.startsWith("Workspace reopened.")));
  noDelete(r);
  r.unmount();
});

test("OWNED owner: a 409 on reopen explains there is nothing to reopen", async () => {
  closure = { ...closure, request: { id: "r1", status: "COMPLETED", blockersJson: null } };
  current.reopen = () => ({ __status: 409, body: { error: { code: "workspace_not_closed" } } });
  const r = await render();
  await r.press("Reopen workspace");
  await settle();
  assert.ok(r.texts().some((t) => t.startsWith("There is nothing to reopen")));
  r.unmount();
});

test("OWNED non-owner: the explanation only", async () => {
  Object.assign(detail, { currentUserRole: "ADMIN", canManageWorkspace: false });
  const r = await render();
  assert.ok(r.hasText("Workspace closure"));
  assert.equal(requests.filter((q) => q.path === "/v1/teams/team-1/closure").length, 0);
  assert.equal(requests.filter((q) => q.path.includes("eligible=ownership_transfer")).length, 0);
  noDelete(r);
  r.unmount();
});
