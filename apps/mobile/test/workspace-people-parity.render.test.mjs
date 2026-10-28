/**
 * Workspace People ↔ web teams/[id]/page.tsx parity: the summary figures, the
 * seat-full notice, the Workspace overview (owner resolved from the embedded
 * first page), the Collaboration Teams signpost, invitation resend outcomes,
 * (case links were removed from this screen — members audit MEM-05), the
 * owner-only lifecycle (server-side eligible transfer candidates, closure + reopen,
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
    stats: {
      memberCount: 2,
      memberCounts: { active: 2, suspended: 0, removed: 0, unassigned: 0 },
      pendingInviteCount: 1,
      caseCount: 3,
      openCaseCount: 1,
      // An Enterprise-style contract seat count, full — the one ceiling that can fill.
      seatLimit: 2,
      seatUsed: 2,
      seatAvailable: 0,
      collaborationTeams: { featureIncluded: true, active: 1, limit: 5, limitSource: "PLAN_CATALOG", membersPerTeam: 10 },
    },
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
  // Members experience B — no "Seats available" card; Collaboration Teams
  // against the plan limit, worded by the module the web uses.
  assert.equal(r.byLabel("Seats available: 0").length, 0);
  assert.equal(r.byLabel("Collaboration Teams: 1 of 5").length, 1);
  assert.ok(r.texts().some((t) => t.includes("up to 10 members per Team, owner not counted")));
  assert.ok(r.hasText("Every seat is in use."));
  await r.press("Review plan and seats");
  assert.equal(M.calls.push.at(-1), "/billing");
  // Open cases — the server's open, visible count, not every Case row.
  await r.press("Open cases: 1");
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

// MEMBERS AUDIT MEM-05 — case link management left Members & Access (web and
// native alike): it offered one page of cases and is not people management.
test("People offers no case linking, and asks for no case list", async () => {
  detail.currentUserRole = "OWNER";
  const r = await render();
  assert.equal(r.byLabel("Link a case").length, 0, "a case-link control is offered");
  assert.equal(requests.filter((q) => q.path === "/v1/teams/team-1/cases").length, 0, "People read the case list");
  assert.equal(requests.filter((q) => q.path === "/v1/cases").length, 0);
  r.unmount();
});

// MEMBERS AUDIT LIFE-01/02 — transfer, closure and reopen moved to Settings →
// Workspace lifecycle (workspace-lifecycle.render.test.mjs proves them there).
// The People screen manages people: for the owner it only points at the
// lifecycle screen, and it offers no delete control at all.
test("People has no lifecycle controls; a Personal owner goes straight to Close account", async () => {
  Object.assign(detail, {
    currentUserRole: "OWNER",
    canManageWorkspace: true,
    lifecycle: { kind: "PERSONAL", endPath: "ACCOUNT_CLOSURE", deletable: false, closable: false, transferable: false, nextAction: "CLOSE_ACCOUNT" },
  });
  const r = await render();
  assert.equal(r.byLabel("Delete workspace").length, 0, "a delete control is offered");
  assert.equal(r.byLabel("Close this workspace…").length, 0);
  assert.equal(r.byLabel("Transfer ownership…").length, 0);
  assert.equal(requests.filter((q) => q.path === "/v1/teams/team-1/closure").length, 0, "People read closure state");
  assert.ok(r.texts().some((t) => t.includes("closes only when you close your account")));
  // Members experience D — no forwarding screen: account closure, directly.
  assert.equal(r.byLabel("Open workspace lifecycle").length, 0);
  await r.press("Close account");
  assert.equal(M.calls.push.at(-1), "/settings/privacy");
  assert.equal(requests.filter((q) => q.method === "DELETE" && q.path === "/v1/teams/team-1").length, 0);
  r.unmount();
});

test("unknown figures read —, never 0 (members experience B)", async () => {
  Object.assign(detail, { stats: { pendingInviteCount: 1 } });
  const r = await render();
  assert.equal(r.byLabel("Active members: —").length, 1);
  assert.equal(r.byLabel("Open cases: —").length, 1);
  assert.equal(r.byLabel("Collaboration Teams: —").length, 1);
  r.unmount();
});

test("FREE: Collaboration Teams are not included and no invitation is offered", async () => {
  Object.assign(detail, {
    stats: { ...detail.stats, seatLimit: 0, seatUsed: 0, seatAvailable: 0, collaborationTeams: { featureIncluded: false, active: 0, limit: 0, limitSource: "PLAN_CATALOG", membersPerTeam: 0 } },
  });
  const r = await render();
  assert.equal(r.byLabel("Collaboration Teams: Not included").length, 1);
  assert.equal(r.byLabel("Invite person").length, 0);
  assert.equal(r.hasText("Every seat is in use."), false);
  r.unmount();
});

test("an Organization Workspace owner gets no account-closure route from People", async () => {
  Object.assign(detail, {
    currentUserRole: "OWNER",
    canManageWorkspace: true,
    lifecycle: { kind: "ORGANIZATION", endPath: "ORGANIZATION_OFFBOARDING", deletable: false, closable: false, transferable: false, nextAction: "ORGANIZATION_OFFBOARDING" },
  });
  const r = await render();
  assert.equal(r.byLabel("Close account").length, 0);
  assert.equal(r.byLabel("Manage workspace lifecycle").length, 0);
  r.unmount();
});

test("an Enterprise contract with seats but no Teams still offers invitations", async () => {
  Object.assign(detail, {
    stats: { ...detail.stats, seatLimit: 50, seatUsed: 3, seatAvailable: 47, collaborationTeams: { featureIncluded: false, active: 0, limit: 0, limitSource: "ENTERPRISE_CONTRACT", membersPerTeam: 0 } },
  });
  const r = await render();
  assert.equal(r.byLabel("Collaboration Teams: Not included").length, 1);
  assert.ok(r.byLabel("Invite person").length >= 1);
  r.unmount();
});
