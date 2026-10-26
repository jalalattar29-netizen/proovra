/**
 * SECOND RE-AUDIT INV-03 / B8 + B7 — the native Members & Access screen,
 * rendered, reads invitations the way the web does (teams/[id]/page.tsx).
 *
 * INV-03 / B8: creating an invitation says what the server did —
 *   POST /v1/teams/:id/invites → { invite, emailSent, existing } (teams.routes.ts)
 *   - emailSent:false → a warning naming Resend, never "Invitation created successfully";
 *   - existing:true   → "already pending … sent again";
 *   - positive control: emailSent:true → "Invitation sent to …".
 *
 * B7: the invitation list carries `status` (PENDING | EXPIRED, INV-05):
 *   - an EXPIRED invitation is not counted as pending and is labelled
 *     "Expired … — resend to renew";
 *   - a caller who cannot read the list sees the server's count, and "—" (never
 *     0) when the server gave none.
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
let createAnswer;

const member = (id, userId, role, name) => ({ id, userId, role, status: "ACTIVE", createdAt: "2026-01-01T00:00:00.000Z", user: { id: userId, displayName: name }, label: name });
const pendingInvite = { id: "inv-1", email: "new@x.io", role: "MEMBER", status: "PENDING", createdAt: "2026-02-01T00:00:00.000Z", expiresAt: "2099-02-08T00:00:00.000Z", lastResentAt: null };
const expiredInvite = { id: "inv-2", email: "late@x.io", role: "MEMBER", status: "EXPIRED", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-08T00:00:00.000Z", lastResentAt: null };

before(async () => {
  M = await loadModule("app/(stack)/workspace-people.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});

beforeEach(async () => {
  requests = [];
  invites = [pendingInvite, expiredInvite];
  createAnswer = { emailSent: true, existing: false };
  detail = {
    id: "team-1",
    name: "Acme",
    ownerUserId: "u-own",
    currentUserRole: "ADMIN",
    canManageMembers: true,
    canManageWorkspace: false,
    effectivePlan: "team",
    stats: { memberCount: 2, pendingInviteCount: 1, caseCount: 0, seatLimit: null, seatUsed: null, seatAvailable: null },
    memberPage: { total: 2, returned: 2, hasMore: false, endpoint: "/v1/teams/team-1/members" },
    members: [member("m-own", "u-own", "OWNER", "Olivia Owner"), member("m-self", "user-1", "ADMIN", "Test Operator")],
  };
  routes = {
    ...authenticatedRoutes(),
    "/v1/teams/team-1/members": () => ({ members: detail.members, nextCursor: null, total: detail.members.length }),
    "/v1/teams/team-1/invites": (_path, method) => {
      if (method === "POST") {
        return {
          __status: createAnswer.existing ? 200 : 201,
          body: {
            invite: { ...pendingInvite, id: "inv-new", email: "fresh@x.io" },
            ...createAnswer,
            message: createAnswer.emailSent ? "Invitation sent successfully" : "Invitation created successfully",
          },
        };
      }
      if (!detail.canManageMembers) return { __status: 403, body: { error: { code: "FORBIDDEN" } } };
      return { invites };
    },
    "/v1/teams/team-1/activity": () => ({ activities: [] }),
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

async function createInvite(r) {
  await r.press("Invite person");
  await settle(2);
  await r.type("Email address to invite", "fresh@x.io");
  await r.press("Send invitation");
  await settle();
  assert.equal(requests.filter((q) => q.path === "/v1/teams/team-1/invites" && q.method === "POST").length, 1);
}

test("INV-03 — emailSent:false: a warning naming Resend, never 'Invitation created successfully'", async () => {
  createAnswer = { emailSent: false, existing: false };
  const r = await render();
  await createInvite(r);
  assert.ok(r.hasText("The invitation for fresh@x.io was created, but the email could not be delivered. Use Resend to try again."));
  assert.equal(r.hasText("Invitation created successfully"), false);
  assert.equal(r.hasText("Invitation sent to fresh@x.io."), false);
  r.unmount();
});

test("INV-03 positive control — emailSent:true: 'Invitation sent to …'", async () => {
  const r = await render();
  await createInvite(r);
  assert.ok(r.hasText("Invitation sent to fresh@x.io."));
  assert.equal(r.hasText("could not be delivered"), false);
  r.unmount();
});

test("B8 — existing:true: the pending invitation was sent again, not a new one", async () => {
  createAnswer = { emailSent: true, existing: true };
  const r = await render();
  await createInvite(r);
  assert.ok(r.hasText("An invitation for fresh@x.io was already pending. It has been sent again."));
  r.unmount();
});

test("B7 — an EXPIRED invitation is listed and labelled, but not counted as pending", async () => {
  const r = await render();
  assert.equal(r.byLabel("Pending invitations: 1").length, 1, "expired invitation counted as pending");
  assert.equal(r.byLabel("Pending invitations: 2").length, 0);
  assert.ok(r.hasText("late@x.io"));
  assert.ok(r.texts().some((t) => t.includes(" · Expired ") && t.endsWith("— resend to renew")));
  // Positive control: the open invitation keeps its expiry date, no Expired label.
  assert.equal(r.texts().filter((t) => t.includes("resend to renew")).length, 1);
  r.unmount();
});

test("B7 — positive control: two PENDING invitations count 2", async () => {
  invites = [pendingInvite, { ...expiredInvite, status: "PENDING", expiresAt: "2099-01-08T00:00:00.000Z" }];
  const r = await render();
  assert.equal(r.byLabel("Pending invitations: 2").length, 1);
  assert.equal(r.hasText("resend to renew"), false);
  r.unmount();
});

test("B7 — a caller who cannot read the list sees the server's count; none given → '—', never 0", async () => {
  detail.canManageMembers = false;
  detail.currentUserRole = "MEMBER";
  detail.stats.pendingInviteCount = 3;
  let r = await render();
  assert.equal(r.byLabel("Pending invitations: 3").length, 1);
  r.unmount();

  delete detail.stats.pendingInviteCount;
  r = await render();
  assert.equal(r.byLabel("Pending invitations: —").length, 1, "an unknown count rendered as a number");
  assert.equal(r.byLabel("Pending invitations: 0").length, 0);
  r.unmount();
});
