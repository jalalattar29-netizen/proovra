/**
 * T-14 — Workspace People (WorkspaceMembersPanel.tsx:476 Remove, :497
 * Showing; teams/[id]/page.tsx:1978 Billing). Native could not remove a
 * member. The web flow: read the removal impact, require an ADMIN/OWNER
 * transfer target when the member owns records, DELETE on an explicit tap,
 * report from the re-read roster.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let roster;
let impact;
const MEMBERS = () => [
  { id: "m-own", userId: "u-own", role: "OWNER", status: "ACTIVE", user: { displayName: "Owner" } },
  { id: "m-self", userId: "user-1", role: "ADMIN", status: "ACTIVE", user: { displayName: "Test Operator" } },
  { id: "m-dana", userId: "u-dana", role: "MEMBER", status: "ACTIVE", user: { displayName: "Dana" } },
];

before(async () => {
  M = await loadModule("app/(stack)/workspace-people.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  roster = MEMBERS();
  impact = {
    member: { memberId: "m-dana", userId: "u-dana", role: "MEMBER" },
    impact: { ownedEvidence: 4, ownedCases: 1, openAssignments: 2, requiresTransfer: true },
    eligibleTransferTargets: [{ memberId: "m-own", userId: "u-own", displayName: "Owner", email: null, role: "OWNER" }],
  };
  const routes = {
    ...authenticatedRoutes(),
    "/v1/teams/team-1/members/m-dana/removal-impact": () => impact,
    "/v1/teams/team-1/members/m-dana": (method) => {
      if (method === "DELETE") roster = roster.filter((m) => m.id !== "m-dana");
      return {};
    },
    "/v1/teams/team-1/members": () => ({ members: roster, nextCursor: null, total: roster.length }),
    "/v1/teams/team-1/invites": () => ({ invites: [] }),
    "/v1/teams/team-1/cases": () => ({ items: [] }),
    "/v1/teams/team-1/activity": () => ({ activities: [] }),
    "/v1/teams/team-1/closure": () => ({}),
    "/v1/teams/team-1": () => ({ id: "team-1", name: "Acme", canManageMembers: true, stats: { memberCount: 3 } }),
    "/v1/me/inbox/summary": () => ({ unread: 0 }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    requests.push({ path, method, body: init.body ? JSON.parse(init.body) : null });
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key](method) : {};
    // The member DELETE answers 204 with NO body (teams.routes.ts:2206); a
    // `{}` 200 stub hid that the client parsed the empty body and failed.
    if (method === "DELETE" && path === "/v1/teams/team-1/members/m-dana") return new Response(null, { status: 204 });
    return new Response(JSON.stringify(res), { status: key ? 200 : 500, headers: { "content-type": "application/json" } });
  };
  M.calls.reset();
  await signIn(M);
});
const settle = async (n = 6) => {
  for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  return r;
};

test("Remove is offered only for others who are not the owner; the roster total is shown", async () => {
  const r = await render();
  assert.equal(r.byLabel("Remove Dana").length, 1);
  assert.equal(r.byLabel("Remove Owner").length, 0, "the owner was removable");
  assert.equal(r.byLabel("Remove Test Operator").length, 0, "you could remove yourself");
  assert.ok(r.hasText("Showing 3 of 3 people"));
});

test("a member who owns records needs a transfer target; the DELETE carries it and the roster is re-read", async () => {
  const r = await render();
  await r.press("Remove Dana");
  await settle();
  assert.ok(r.hasText("Evidence owned 4 · Cases owned 1 · Open assignments 2"));
  const submit = () => r.byLabel("Remove member").find((n) => n.props.onPress);
  assert.equal(submit().props.disabled ?? submit().props.accessibilityState?.disabled, true, "removal allowed without a transfer target");
  await r.press("Transfer ownership to: Owner (OWNER)");
  await act(async () => { await submit().props.onPress(); });
  await settle();
  const del = requests.find((q) => q.method === "DELETE");
  assert.equal(del.path, "/v1/teams/team-1/members/m-dana");
  assert.deepEqual(del.body, { transferToUserId: "u-own" });
  assert.ok(r.hasText("Showing 2 of 2 people"), "the roster was not re-read");
});

test("no eligible target blocks the removal in words; Open billing goes to billing", async () => {
  impact = { ...impact, eligibleTransferTargets: [] };
  const r = await render();
  await r.press("Remove Dana");
  await settle();
  assert.ok(r.texts().some((t) => t.startsWith("Removal blocked — no eligible transfer target.")));
  r.unmount();
  const r2 = await render();
  await r2.press("Open billing");
  assert.equal(M.calls.push.at(-1), "/billing");
});
