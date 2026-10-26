/**
 * MEMBERS RE-AUDIT INV-06 (mobile half) — at zero free seats the People screen
 * tells the truth the SERVER enforces, and does not block the invite.
 *
 * Server rule (services/api, canonical seat authority): a pending invitation
 * consumes no seat; POST /v1/teams/:id/invites is accepted at full seats
 * (teams.routes.ts — 201 { invite, emailSent, existing, message }); only
 * acceptance needs a free seat. The web teams page states that rule in one
 * sentence; the native screen must state the same sentence, keep "Invite
 * person" enabled, and actually send the invitation.
 *
 * The pre-existing parity suite asserted only the heading "Every seat is in
 * use.", so the old blocking copy and a disabled Invite button both passed.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests;
let routes;
let invites;

const SEAT_FULL_SENTENCE =
  "You can still send invitations, but an invited person can join only once a seat frees up or the contract adds seats.";

const member = (id, userId, role, name) => ({ id, userId, role, status: "ACTIVE", createdAt: "2026-01-01T00:00:00.000Z", user: { id: userId, displayName: name }, label: name });

before(async () => {
  M = await loadModule("app/(stack)/workspace-people.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});

beforeEach(async () => {
  requests = [];
  invites = [];
  const detail = {
    id: "team-1",
    name: "Acme",
    ownerUserId: "u-own",
    currentUserRole: "ADMIN",
    canManageMembers: true,
    canManageWorkspace: false,
    effectivePlan: "team",
    stats: { memberCount: 2, pendingInviteCount: 0, caseCount: 0, seatLimit: 2, seatUsed: 2, seatAvailable: 0 },
    memberPage: { total: 2, returned: 2, hasMore: false, endpoint: "/v1/teams/team-1/members" },
    members: [member("m-own", "u-own", "OWNER", "Olivia Owner"), member("m-self", "user-1", "ADMIN", "Test Operator")],
  };
  routes = {
    ...authenticatedRoutes(),
    "/v1/teams/team-1/members": () => ({ members: detail.members, nextCursor: null, total: 2 }),
    "/v1/teams/team-1/invites": (_path, method) => {
      if (method === "POST") {
        const invite = { id: "inv-new", email: "new@x.io", role: "MEMBER", createdAt: "2026-02-01T00:00:00.000Z", expiresAt: "2026-02-08T00:00:00.000Z", lastResentAt: null };
        invites = [invite];
        // The server's real create reply — accepted, at zero free seats.
        return { __status: 201, body: { invite, emailSent: true, existing: false, message: "Invitation sent successfully" } };
      }
      return { invites };
    },
    "/v1/teams/team-1/cases": () => ({ items: [] }),
    "/v1/teams/team-1/activity": () => ({ activities: [] }),
    "/v1/teams/team-1/closure": () => ({ request: null, blockers: [], confirmationPhrase: "close this workspace", coolingOffDays: 7, membersLosingAccess: 1 }),
    "/v1/teams/team-1": () => detail,
    "/v1/cases": () => ({ items: [] }),
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

test("the seat-full notice is the web's sentence, word for word", async () => {
  // The web page states the rule across JSX lines; normalise its whitespace.
  const webPage = readFileSync(
    fileURLToPath(new URL("../../web/app/(app)/teams/[id]/page.tsx", import.meta.url)),
    "utf8",
  ).replace(/\s+/g, " ");
  assert.ok(
    webPage.includes("You can still send invitations, but an invited person can join only once a seat frees up or the contract adds seats."),
    "the web page no longer states the seat-full rule this test pins",
  );

  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  assert.equal(r.byTestId("people-seats-full").length, 1);
  assert.ok(r.hasText("Every seat is in use."));
  assert.ok(r.texts().some((t) => t.includes(SEAT_FULL_SENTENCE)), "mobile seat-full copy differs from web/server rule");
  r.unmount();
});

test("at zero free seats Invite stays enabled, and the invitation is actually sent", async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();

  const inviteButtons = r.byLabel("Invite person").filter((n) => n.props.onPress);
  assert.ok(inviteButtons.length > 0, "no Invite person action");
  for (const b of inviteButtons) {
    assert.notEqual(b.props.disabled, true, "Invite person is disabled at zero seats");
    assert.notEqual(b.props.accessibilityState?.disabled, true, "Invite person is disabled at zero seats");
  }

  await r.press("Invite person");
  await settle(2);
  assert.ok(r.hasText("Every seat is in use. The invitation is still sent; the person can join once a seat frees up."));

  await r.type("Email address to invite", "new@x.io");
  const send = r.byLabel("Send invitation").filter((n) => n.props.onPress);
  assert.ok(send.length > 0);
  assert.notEqual(send[0].props.disabled, true);
  await r.press("Send invitation");
  await settle();

  const posts = requests.filter((q) => q.path === "/v1/teams/team-1/invites" && q.method === "POST");
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { email: "new@x.io", role: "MEMBER" });
  r.unmount();
});
