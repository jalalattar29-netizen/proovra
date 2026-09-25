/**
 * T-14 — organization detail: the workspace list and the Settings card
 * (PATCH /v1/orgs/:id). Native listed NO workspaces for any organization (it
 * read `id` where the server sends `workspaceId`) and had no way to change the
 * organization's identity metadata.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};
let org;
const ORG = "0a0a0a0a-0000-4000-8000-000000000001";

before(async () => {
  M = await loadModule("app/(stack)/organizations/[id].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  // GET/PATCH /v1/orgs/:id send a FLAT object keyed organizationId (organizations.routes.ts).
  org = { organizationId: ORG, name: "Acme Legal", legalName: null, legalEmail: "legal@acme.test", status: "ACTIVE", timezone: "Europe/London", address: null, logoUrl: null, createdAt: "2026-01-01T00:00:00.000Z" };
  globalThis.__EXPO_PARAMS__ = { id: ORG };
  routes = {
    ...authenticatedRoutes(),
    [`/v1/orgs/${ORG}/workspaces`]: () => ({
      organizationId: ORG,
      summary: { totalWorkspaces: 1 },
      callerCanSeeBilling: true,
      workspaces: [{ workspaceId: "w1", name: "Claims desk", isPersonal: false, createdAt: "2026-02-01T00:00:00.000Z", billing: { plan: "TEAM", status: "PAST_DUE", includedSeats: 5, overSeatLimit: true } }],
    }),
    [`/v1/orgs/${ORG}/members`]: () => ({ members: [] }),
    [`/v1/orgs/${ORG}/audit-events`]: () => ({ events: [] }),
    [`/v1/orgs/${ORG}/closure`]: () => ({ closure: null }),
    [`/v1/orgs/${ORG}`]: (method, body) => {
      if (method === "PATCH") {
        org = { ...org, ...body };
        return { ...org };
      }
      return { ...org, callerRole: "ORG_ADMIN", summary: { memberCount: 3, workspaceCount: 1, pendingInviteCount: 2 } };
    },
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ path, method, body });
    const key = routes[path] ? path : Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const res = key ? routes[key](method, body) : undefined;
    const status = res === undefined ? 500 : res.__status ?? 200;
    return new Response(JSON.stringify(res ?? { message: "unstubbed" }), { status, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  return r;
};

test("the organization's workspaces are listed, with plan, billing status and the seat flag", async () => {
  const r = await render();
  assert.ok(!r.hasText("This organization has no workspaces."), "a workspace row was dropped");
  assert.ok(r.hasText("Claims desk"));
  assert.ok(r.hasText("Team") && r.hasText("Payment failed") && r.hasText("OVER SEAT LIMIT"));
  assert.ok(r.texts().some((t) => t.includes("5 included seats")));
});

test("an admin edits the identity metadata; blanks go as null; the stored values are re-read", async () => {
  const r = await render();
  assert.ok(r.hasText("Identity metadata. ORG_ADMIN+ required."));
  await r.type("Legal name (optional)", "Acme Legal Services Ltd");
  await r.type("Legal email (optional)", "");
  await r.press("Save settings");
  await settle();
  const patch = requests.find((q) => q.method === "PATCH" && q.path === `/v1/orgs/${ORG}`);
  assert.deepEqual(patch.body, { name: "Acme Legal", legalName: "Acme Legal Services Ltd", legalEmail: null, address: null, timezone: "Europe/London", logoUrl: null });
  assert.ok(r.texts().some((t) => t.startsWith("Saved at ")));
  assert.ok(r.hasText("Acme Legal Services Ltd"), "the header did not show the stored value");
});

test("a member below ORG_ADMIN is told why, and gets no form", async () => {
  routes[`/v1/orgs/${ORG}`] = () => ({ ...org, callerRole: "ORG_MEMBER", summary: { memberCount: 3, workspaceCount: 1, pendingInviteCount: 0 } });
  const r = await render();
  assert.ok(r.hasText("You don’t have permission to change settings. Ask an organization admin."));
  assert.equal(r.byLabel("Save settings").length, 0);
});

/* ---- T-14 (page.tsx:670/:681/:967/:1185 + OrgWorkspaceLifecycleControls) ---- */

test("the server's flat detail is read: members and pending invites summarised, scope explained", async () => {
  const r = await render();
  assert.ok(r.hasText("3 members · 2 pending invites"), "the member / pending-invite summary is missing");
  assert.equal(r.byTestId("org-scope").length, 1);
  assert.ok(r.hasText("Personal Space") && r.hasText("Organization (you are here)") && r.hasText("Workspace (a.k.a. Team)"));
  assert.equal(r.byTestId("org-onboarding").length, 0, "onboarding shown to a non-owner of a populated org");
});

test("an owner who is the only member gets the next steps, with Workspace administration", async () => {
  routes[`/v1/orgs/${ORG}`] = () => ({ ...org, callerRole: "ORG_OWNER", summary: { memberCount: 1, workspaceCount: 0, pendingInviteCount: 0 } });
  M.calls.reset();
  const r = await render();
  assert.equal(r.byTestId("org-onboarding").length, 1);
  assert.ok(r.texts().some((t) => t.includes("Fill name, legal name, and legal email in the Settings panel below")));
  await r.press("Workspace administration");
  assert.equal(M.calls.push.at(-1), "/spaces");
});

test("suspend is confirmed, posted, announced in place; the list is re-read without a page reload", async () => {
  let suspended = 0;
  routes[`/v1/orgs/${ORG}/workspaces/w1/suspend`] = (method) => {
    suspended += method === "POST" ? 1 : 0;
    return { suspend: { teamId: "w1", membersSuspended: 4 } };
  };
  const r = await render();
  const listReads = () => requests.filter((q) => q.method === "GET" && q.path === `/v1/orgs/${ORG}/workspaces`).length;
  const orgReads = () => requests.filter((q) => q.method === "GET" && q.path === `/v1/orgs/${ORG}`).length;
  const [l0, o0] = [listReads(), orgReads()];
  await r.press("Suspend workspace Claims desk");
  assert.equal(suspended, 0, "suspended without confirmation");
  await r.press("Confirm suspension");
  await settle();
  assert.equal(suspended, 1);
  assert.ok(r.hasText("Claims desk is suspended. 4 members lost access and webhook delivery is paused. Evidence and audit history are untouched."));
  assert.ok(listReads() > l0, "the workspace list was not re-read");
  assert.equal(orgReads(), o0, "the whole page reloaded");
});

test("a refusal is said in the web's words per status; a member cannot manage", async () => {
  routes[`/v1/orgs/${ORG}/workspaces/w1/resume`] = () => ({ __status: 409, error: { code: "NOT_ORGANIZATION_WORKSPACE" } });
  let r = await render();
  await r.press("Resume workspace Claims desk");
  await settle();
  assert.ok(r.hasText("Only organization workspaces can be suspended here. Personal spaces and individually owned workspaces are governed by their owner."));
  r.unmount();
  routes[`/v1/orgs/${ORG}`] = () => ({ ...org, callerRole: "ORG_MEMBER", summary: { memberCount: 3, workspaceCount: 1, pendingInviteCount: 0 } });
  r = await render();
  assert.ok(r.hasText("Organization admin access is required to suspend or resume a workspace."));
});

test("a closure in cooling-off is shown with its date and can be cancelled (server status COOLING_OFF)", async () => {
  routes[`/v1/orgs/${ORG}`] = () => ({ ...org, callerRole: "ORG_OWNER", summary: { memberCount: 3, workspaceCount: 1, pendingInviteCount: 0 } });
  routes[`/v1/orgs/${ORG}/closure`] = () => ({
    request: { id: "cr-1", status: "COOLING_OFF", requestedAtUtc: "2026-09-20T00:00:00.000Z", coolingOffEndsAtUtc: "2026-10-20T12:00:00.000Z" },
    blockers: [],
    confirmationPhrase: "close this organization",
    coolingOffDays: 30,
  });
  const r = await render();
  assert.ok(r.hasText("Closure requested"));
  assert.ok(r.texts().some((t) => t.startsWith("This organization is scheduled to close on ")), "the cooling-off end was not shown");
  assert.ok(r.byLabel("Cancel the closure request").length >= 1);
});

/* ---- web parity: header, overview tiles, leave, lifecycle card (organizations/[id]/page.tsx) ---- */

// GET /v1/orgs/:id/members (organizations.routes.ts) — membershipId + userId per row.
const membersReply = (rows) => ({ organizationId: ORG, summary: { totalMembers: rows.length }, members: rows });
const MEMBER = (n, role) => ({ membershipId: `m${n}`, userId: `u${n}`, email: `p${n}@acme.test`, displayName: `Person ${n}`, role, memberSince: "2026-01-02T00:00:00.000Z" });

test("the header carries the caller's role, the counts and the legal line, with the web's navigation", async () => {
  const r = await render();
  assert.ok(r.hasText("ORGANIZATION · GOVERNANCE"));
  assert.ok(r.hasText("Your role · Admin"));
  assert.ok(r.hasText("3 members · 1 workspace"));
  assert.ok(r.hasText("legal@acme.test"));
  await r.press("Workspace admin →");
  assert.equal(M.calls.push.at(-1), "/spaces");
  await r.press("← All organizations");
  assert.equal(M.calls.replace.at(-1), "/organizations");
  r.unmount();
});

test("the four overview tiles: governance with pending invites and the role tally, workspaces, billing, audit", async () => {
  routes[`/v1/orgs/${ORG}/members`] = () => membersReply([MEMBER(1, "ORG_OWNER"), MEMBER(2, "ORG_ADMIN"), MEMBER(3, "ORG_MEMBER")]);
  // GET /v1/orgs/:id/invites (organizations.routes.ts:1206) — summary.totalPending.
  routes[`/v1/orgs/${ORG}/invites`] = () => ({ organizationId: ORG, summary: { totalPending: 4 }, invites: [] });
  routes[`/v1/orgs/${ORG}/audit-events`] = () => ({
    organizationId: ORG,
    summary: { totalEvents: 1, nextCursor: null },
    events: [{ id: "e1", actorUserId: "u1", actorEmail: null, actorDisplayName: "Person 1", eventType: "ORG_SETTINGS_UPDATED", targetType: "organization", targetId: ORG, metadata: null, createdAt: "2026-09-01T10:00:00.000Z" }],
  });
  const r = await render();
  assert.equal(r.byTestId("org-overview").length, 1);
  assert.ok(r.hasText("4 pending invites"), "the pending figure is the invites route's, not the summary's");
  assert.ok(r.hasText("1 Owner · 1 Admin · 1 Member"));
  assert.ok(r.hasText("1× TEAM · 1 over seat limit"), "the billing tile did not summarise the visible plans");
  assert.ok(r.hasText("1 event"));
  assert.ok(r.texts().some((t) => t.startsWith("Latest ")));
  await r.press("Open billing →");
  assert.equal(M.calls.push.at(-1), "/billing");
  r.unmount();
});

test("a caller who cannot see billing gets Workspace-scoped; below auditor the audit tile says so", async () => {
  routes[`/v1/orgs/${ORG}/workspaces`] = () => ({ organizationId: ORG, summary: { totalWorkspaces: 1 }, callerCanSeeBilling: false, workspaces: [{ workspaceId: "w1", name: "Claims desk", isPersonal: false, createdAt: "2026-02-01T00:00:00.000Z" }] });
  routes[`/v1/orgs/${ORG}/audit-events`] = () => ({ __status: 403, error: { code: "FORBIDDEN" } });
  const r = await render();
  assert.ok(r.hasText("Workspace-scoped"));
  assert.ok(r.hasText("Auditor-only"));
  r.unmount();
});

test("a member leaves from the header; the owner's refusal is the server's sentence; success returns to the list", async () => {
  routes[`/v1/orgs/${ORG}`] = () => ({ ...org, callerRole: "ORG_MEMBER", summary: { memberCount: 3, workspaceCount: 1, pendingInviteCount: 0 } });
  // POST /v1/orgs/:id/leave → 409 OWNERSHIP_TRANSFER_REQUIRED (organizations.routes.ts:2057).
  routes[`/v1/orgs/${ORG}/leave`] = () => ({ __status: 409, error: { code: "OWNERSHIP_TRANSFER_REQUIRED", message: "You are the organization owner. Transfer ownership or close the organization before leaving." } });
  const r = await render();
  assert.ok(r.hasText("Ownership transfer and organization closure are available to the organization owner only. To leave this organization, use Leave organization in the page header."));
  await r.press("Leave organization");
  assert.ok(r.hasText("Leave Acme Legal?"));
  const confirm = r.byLabel("Leave organization");
  await act(async () => { await confirm[confirm.length - 1].props.onPress(); });
  await settle();
  assert.ok(r.hasText("You are the organization owner. Transfer ownership or close the organization before leaving."));
  routes[`/v1/orgs/${ORG}/leave`] = () => ({ left: true, formerRole: "ORG_MEMBER", workspacesDeactivated: 0, workspaceFallback: null });
  await r.press("Leave organization");
  const again = r.byLabel("Leave organization");
  await act(async () => { await again[again.length - 1].props.onPress(); });
  await settle();
  assert.equal(M.calls.replace.at(-1), "/organizations");
  r.unmount();
});

test("the owner's lifecycle card: transfer needs another member; closure states its window and can be kept", async () => {
  routes[`/v1/orgs/${ORG}`] = () => ({ ...org, callerRole: "ORG_OWNER", summary: { memberCount: 2, workspaceCount: 1, pendingInviteCount: 0 } });
  routes[`/v1/orgs/${ORG}/members`] = () => membersReply([MEMBER(1, "ORG_OWNER")]);
  routes[`/v1/orgs/${ORG}/closure`] = () => ({ request: null, blockers: [], confirmationPhrase: "close this organization", coolingOffDays: 7 });
  const r = await render();
  assert.equal(r.byTestId("org-lifecycle").length, 1);
  assert.ok(r.hasText("Organization lifecycle"));
  assert.ok(r.hasText("No other members yet — invite a member before transferring ownership."));
  assert.ok(r.texts().some((t) => t.startsWith("Archives the organization after a 7-day cancellation window.")));
  assert.equal(r.byLabel("Leave organization").length, 0, "the owner was offered Leave");
  await r.press("Close this organization…");
  assert.ok(r.hasText("Type close this organization to confirm."));
  await r.press("Keep the organization");
  assert.ok(!r.hasText("Type close this organization to confirm."));
  r.unmount();
});
