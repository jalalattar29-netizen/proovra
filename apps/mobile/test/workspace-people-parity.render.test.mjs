/**
 * Workspace People ↔ web teams/[id]/page.tsx parity: the summary figures, the
 * seat-full notice, the Workspace overview (owner resolved from the embedded
 * first page), the Collaboration Teams signpost, invitation resend outcomes,
 * the case picker's exclusion of cases linked elsewhere, the owner-only
 * lifecycle (server-side eligible transfer candidates, closure + reopen,
 * delete). Stubs use the real reply shapes:
 *   GET  /v1/teams/:id                          teams.routes.ts:760
 *   GET  /v1/teams/:id/members[?eligible=…]     teams.routes.ts:1025
 *   POST /v1/teams/:id/invites/:id/resend       teams.routes.ts:2441 { invite, emailSent } | { error: { code } }
 *   GET  /v1/teams/:id/closure                  teams.routes.ts:3462
 *   POST /v1/teams/:id/reopen                   teams.routes.ts:3720 { reopened }
 *   DELETE /v1/teams/:id                        teams.routes.ts:1362 (204)
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
let invites;
let closure;
let current;

const member = (id, userId, role, name, extra = {}) => ({ id, userId, role, status: "ACTIVE", createdAt: "2026-01-01T00:00:00.000Z", user: { id: userId, displayName: name }, label: name, ...extra });

before(async () => {
  M = await loadModule("app/(stack)/workspace-people.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});

beforeEach(async () => {
  requests = [];
  invites = [{ id: "inv-1", email: "new@x.io", role: "MEMBER", createdAt: "2026-02-01T00:00:00.000Z", expiresAt: "2026-02-08T00:00:00.000Z", lastResentAt: null }];
  detail = {
    id: "team-1",
    name: "Acme",
    ownerUserId: "u-own",
    currentUserRole: "ADMIN",
    canManageMembers: true,
    canManageWorkspace: false,
    effectivePlan: "team",
    stats: { memberCount: 2, pendingInviteCount: 1, caseCount: 1, seatLimit: 2, seatUsed: 2, seatAvailable: 0 },
    memberPage: { total: 2, returned: 2, hasMore: false, endpoint: "/v1/teams/team-1/members" },
    members: [member("m-own", "u-own", "OWNER", "Olivia Owner"), member("m-self", "user-1", "ADMIN", "Test Operator")],
  };
  closure = { request: null, blockers: [], confirmationPhrase: "close this workspace", coolingOffDays: 7, membersLosingAccess: 1 };
  current = {
    resend: () => ({ invite: invites[0], emailSent: false }),
    reopen: () => ({ reopened: { teamId: "team-1" } }),
  };
  routes = {
    ...authenticatedRoutes(),
    "/v1/teams/team-1/members": (path) =>
      path.includes("eligible=ownership_transfer")
        ? { members: [member("m-dana", "u-dana", "MEMBER", "Dana")], nextCursor: "m-dana", total: 60 }
        : { members: detail.members, nextCursor: null, total: detail.members.length },
    "/v1/teams/team-1/invites/inv-1/resend": () => current.resend(),
    "/v1/teams/team-1/invites": () => ({ invites }),
    "/v1/teams/team-1/cases": () => ({ items: [{ id: "c-1", name: "Harbour claim", createdAt: "2026-01-02T00:00:00.000Z", teamId: "team-1" }] }),
    "/v1/teams/team-1/activity": () => ({ activities: [{ id: "a1", eventType: "invite_created", targetType: "invite", actor: { id: "u-own", displayName: "Olivia Owner" }, createdAt: "2026-02-01T00:00:00.000Z" }] }),
    "/v1/teams/team-1/closure": () => closure,
    "/v1/teams/team-1/reopen": () => current.reopen(),
    "/v1/teams/team-1/transfer-ownership": () => ({ transfer: { teamId: "team-1", fromUserId: "user-1", toUserId: "u-dana" } }),
    "/v1/teams/team-1": () => detail,
    "/v1/cases": () => ({
      items: [
        { id: "c-1", name: "Harbour claim", teamId: "team-1" },
        { id: "c-2", name: "Linked elsewhere", teamId: "team-9" },
        { id: "c-3", name: "Free case", teamId: null },
      ],
    }),
    "/v1/me/inbox/summary": () => ({ unread: 0 }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    requests.push({ path, method, body: init.body ? JSON.parse(init.body) : null });
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    let res = key ? routes[key](path, method) : undefined;
    if (method === "DELETE" && path === "/v1/teams/team-1") return new Response(null, { status: 204 });
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

test("the header, summary figures and seat-full notice come from the server's projection", async () => {
  const r = await render();
  assert.ok(r.hasText("Members & Access"));
  assert.ok(r.texts().some((t) => t.startsWith("Who can access Acme — members, invitations, roles and access governance.")));
  assert.ok(r.texts().some((t) => t.includes("TEAM plan")));
  assert.equal(r.byLabel("Active members: 2").length, 1);
  assert.equal(r.byLabel("Pending invitations: 1").length, 1);
  assert.equal(r.byLabel("Seats available: 0").length, 1);
  assert.ok(r.hasText("2 of 2 used"));
  assert.ok(r.hasText("Every seat is in use."));
  await r.press("Review plan and seats");
  assert.equal(M.calls.push.at(-1), "/billing");
  await r.press("Cases in this workspace: 1");
  assert.equal(M.calls.push.at(-1), "/cases");
  r.unmount();
});

test("Workspace overview names the owner from the first page, and the signpost opens Collaboration Teams", async () => {
  const r = await render();
  assert.equal(r.byTestId("people-workspace-overview").length, 1);
  assert.ok(r.hasText("Olivia Owner"));
  assert.ok(r.hasText("2 of 2 seats used"));
  assert.ok(r.hasText("Storage, subscription and payment for this workspace are managed in Billing."));
  assert.ok(r.hasText("Invitation sent — Olivia Owner"), "activity is not in the web's words");
  await r.press("Organise members");
  assert.equal(M.calls.push.at(-1), "/(tabs)/teams");
  r.unmount();
});

test("a resend that could not email says so from the re-read list; a stale invite gets the bounded copy", async () => {
  const r = await render();
  await r.press("Resend invitation to new@x.io");
  await settle();
  assert.equal(requests.filter((q) => q.path === "/v1/teams/team-1/invites/inv-1/resend" && q.method === "POST").length, 1);
  assert.ok(
    r.hasText("A new invitation link was issued for new@x.io, but the email could not be delivered. The previous link no longer works; try resending later."),
  );
  current.resend = () => ({ __status: 409, body: { error: { code: "INVITE_NOT_PENDING" }, message: "x" } });
  await r.press("Resend invitation to new@x.io");
  await settle();
  assert.ok(r.hasText("That invitation was already accepted or revoked, so it cannot be resent. The list has been reloaded."));
  r.unmount();
});

test("the case picker never offers a case already linked to another workspace", async () => {
  detail.currentUserRole = "OWNER";
  const r = await render();
  await r.press("Link a case");
  await settle();
  assert.equal(r.byLabel("Link Free case").length, 1);
  assert.equal(r.byLabel("Link Linked elsewhere").length, 0, "a case the route refuses was offered");
  r.unmount();
});

test("the owner's transfer picker reads the server's eligible list, pages it, and confirms before sending", async () => {
  Object.assign(detail, { currentUserRole: "OWNER", canManageWorkspace: true });
  const r = await render();
  const eligible = requests.filter((q) => q.path.includes("eligible=ownership_transfer"));
  assert.ok(eligible.length >= 1, "the candidates were not read from the server");
  assert.match(eligible[0].path, /limit=50/);
  assert.ok(r.hasText("Showing 1 of 60 members who can take ownership"));
  assert.equal(r.byLabel("Show more members").length, 1);
  await r.press("Dana");
  await r.press("Transfer ownership…");
  assert.ok(r.texts().some((t) => t.startsWith("Transfer Acme to Dana?")));
  await r.press("Confirm transfer");
  await settle();
  const post = requests.find((q) => q.path === "/v1/teams/team-1/transfer-ownership");
  assert.deepEqual(post.body, { newOwnerUserId: "u-dana" });
  assert.ok(r.hasText("Dana now owns Acme. Billing ownership moved with it; you remain a member."));
  r.unmount();
});

test("closure states the consequence; a completed closure offers Reopen; delete confirms first", async () => {
  Object.assign(detail, { currentUserRole: "OWNER", canManageWorkspace: true });
  closure = { ...closure, request: { id: "r1", status: "COMPLETED", blockersJson: null, requestedAtUtc: "2026-01-01T00:00:00.000Z", coolingOffEndsAtUtc: null, failureCode: null } };
  const r = await render();
  assert.ok(r.texts().some((t) => t.includes("7-day cancellation window") && t.includes("1 other member will lose access")));
  await r.press("Reopen workspace");
  await settle();
  assert.equal(requests.filter((q) => q.path === "/v1/teams/team-1/reopen" && q.method === "POST").length, 1);
  assert.ok(r.texts().some((t) => t.startsWith("Workspace reopened.")));

  await r.press("Delete workspace");
  assert.ok(r.hasText("Delete this workspace?"));
  assert.equal(requests.filter((q) => q.method === "DELETE").length, 0, "deleted before the confirmation");
  const confirm = r.byLabel("Delete workspace").filter((n) => n.props.onPress).at(-1);
  await act(async () => { await confirm.props.onPress(); });
  await settle();
  assert.equal(requests.filter((q) => q.method === "DELETE" && q.path === "/v1/teams/team-1").length, 1);
  assert.equal(M.calls.replace.at(-1), "/spaces");
  r.unmount();
});

test("a 409 on reopen explains there is nothing to reopen", async () => {
  Object.assign(detail, { currentUserRole: "OWNER", canManageWorkspace: true });
  closure = { ...closure, request: { id: "r1", status: "COMPLETED", blockersJson: null } };
  current.reopen = () => ({ __status: 409, body: { error: { code: "workspace_not_closed" } } });
  const r = await render();
  await r.press("Reopen workspace");
  await settle();
  assert.ok(r.texts().some((t) => t.startsWith("There is nothing to reopen")));
  r.unmount();
});
