/**
 * T-14 — External collaborators (web TeamAccessReviewCard.tsx:336). Native had
 * no way to see who outside the workspace holds case access, nor to withdraw
 * it. Driven through the real Workspace People screen against the route's own
 * reply shape (`externalCollaborators[].grants[]`); revoke success is decided
 * by the reread, a refusal by the server's code, a 403 by the admin gate.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let review;
let reviewStatus;
let deleteReply;
const GRANTS = () => [
  { grantId: "g-1", caseId: "c-1", caseName: "Harbour claim", grantedAt: "2026-08-01T10:00:00.000Z" },
  { grantId: "g-2", caseId: "c-2", caseName: "(unknown case)", grantedAt: "2026-08-03T10:00:00.000Z" },
];

before(async () => {
  M = await loadModule("app/(stack)/workspace-people.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  reviewStatus = 200;
  deleteReply = { status: 200, body: { ok: true, grantId: "g-1" } };
  review = {
    teamId: "team-1",
    summary: { internalMembers: 1, pendingInvites: 0, externalCollaborators: 1 },
    members: [],
    pendingInvites: [],
    externalCollaborators: [
      { kind: "EXTERNAL", userId: "u-ext", email: "lee@outside.test", displayName: "Lee Outside", firstGrantedAt: "2026-08-01T10:00:00.000Z", grants: GRANTS() },
    ],
  };
  const routes = {
    ...authenticatedRoutes(),
    "/v1/teams/team-1/access-review": () => ({ status: reviewStatus, body: reviewStatus === 200 ? review : { message: "Forbidden" } }),
    "/v1/teams/team-1/external-grants/g-1": (method) => {
      if (method === "DELETE" && deleteReply.status === 200) {
        review.externalCollaborators[0].grants = review.externalCollaborators[0].grants.filter((g) => g.grantId !== "g-1");
      }
      return deleteReply;
    },
    "/v1/teams/team-1/members": () => ({ status: 200, body: { members: [], nextCursor: null, total: 0 } }),
    "/v1/teams/team-1/invites": () => ({ status: 200, body: { invites: [] } }),
    "/v1/teams/team-1/cases": () => ({ status: 200, body: { items: [] } }),
    "/v1/teams/team-1/activity": () => ({ status: 200, body: { activities: [] } }),
    "/v1/teams/team-1/closure": () => ({ status: 200, body: {} }),
    "/v1/teams/team-1": () => ({ status: 200, body: { id: "team-1", name: "Acme", canManageMembers: true, stats: { memberCount: 1 } } }),
    "/v1/me/inbox/summary": () => ({ status: 200, body: { unread: 0 } }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    requests.push({ path, method });
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    let out = key ? routes[key](method) : { status: 500, body: {} };
    if (!out || typeof out.status !== "number") out = { status: 200, body: out };
    return new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json" } });
  };
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
const confirm = async (r) => {
  const node = r.byLabel("Revoke access").find((n) => n.props.onPress && !String(n.props.accessibilityLabel ?? "").startsWith("Revoke Lee"));
  assert.ok(node, "no confirm control");
  await act(async () => { await node.props.onPress(); });
  await settle();
};

test("external collaborators are listed from the access review, and expand to their case grants", async () => {
  const r = await render();
  assert.equal(r.byTestId("external-collaborators").length, 1, "no External collaborators card");
  assert.ok(r.hasText("Lee Outside"));
  assert.ok(r.texts().some((t) => t.includes("lee@outside.test") && t.includes("2 cases")), "no identity meta line");
  assert.ok(r.hasText("Case-scoped"));
  assert.ok(!r.hasText("Harbour claim"), "grants should start collapsed");
  await r.press("Show cases for Lee Outside");
  assert.ok(r.hasText("Harbour claim"));
  assert.ok(r.hasText("an unnamed case"), "the server's placeholder name was shown verbatim");
  assert.ok(r.texts().some((t) => t.startsWith("granted ")));
});

test("revoke is confirmed, DELETEs the grant, and succeeds only once the reread no longer lists it", async () => {
  const r = await render();
  await r.press("Show cases for Lee Outside");
  await r.press("Revoke Lee Outside's access to Harbour claim");
  await settle();
  assert.ok(r.hasText("Remove Lee Outside's access to Harbour claim?"), "no confirmation");
  assert.equal(requests.filter((q) => q.method === "DELETE").length, 0, "deleted before confirming");
  await confirm(r);
  const del = requests.find((q) => q.method === "DELETE");
  assert.equal(del?.path, "/v1/teams/team-1/external-grants/g-1");
  assert.ok(requests.filter((q) => q.path === "/v1/teams/team-1/access-review").length >= 2, "not reread");
  assert.ok(r.hasText("Lee Outside no longer has access to Harbour claim."));
});

test("an INTERNAL_MEMBER refusal points at Members and says nothing changed", async () => {
  deleteReply = { status: 422, body: { code: "INTERNAL_MEMBER", message: "internal" } };
  const r = await render();
  await r.press("Show cases for Lee Outside");
  await r.press("Revoke Lee Outside's access to Harbour claim");
  await settle();
  await confirm(r);
  assert.ok(r.hasText("Lee Outside is now a member of this workspace, so their access is managed from Members, not here. Nothing was changed."));
});

test("a 403 on the access review is the admin gate, never an empty list", async () => {
  reviewStatus = 403;
  const r = await render();
  assert.equal(r.byTestId("external-collaborators-gate").length, 1);
  assert.ok(r.hasText("External access can only be reviewed by admins"));
  assert.ok(!r.texts().some((t) => t.startsWith("No external collaborators")));
});
