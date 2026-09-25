/**
 * T-15 — WORKSPACE invitations on native (`/invite/<wsit_v1_…>`, the link
 * `sendTeamInvitation` emails). Native's `/invite/[token]` only knew
 * collaboration invitations, so a workspace invitation opened in the app was
 * posted to /v1/collaboration-team-invites/accept and reported as invalid.
 *
 * The view comes from the SAME resolveInvitationView the web renders.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};
const TOKEN = "wsit_v1_" + "A".repeat(43);
const PENDING = {
  state: "PENDING",
  context: { workspaceName: "Acme Claims", organizationName: "Acme Ltd", role: "REVIEWER", invitedEmailMasked: "j••••@acme.com", expiresAtUtc: "2026-10-10T10:00:00Z" },
};

before(async () => {
  M = await loadModule("app/(stack)/invite/[token].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/api.ts"]);
});
beforeEach(async () => {
  requests = [];
  globalThis.__EXPO_PARAMS__ = { token: TOKEN };
  routes = {
    ...authenticatedRoutes(),
    "/v1/teams/invites/lookup": () => ({ status: 200, body: PENDING }),
    [`/v1/teams/invites/${TOKEN}/accept`]: () => ({ status: 200, body: { workspaceId: "ws-1", alreadyMember: false } }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    requests.push({ path, method, body: init.body ? JSON.parse(init.body) : null });
    const key = routes[path] ? path : Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const out = key ? routes[key]() : { status: 500, body: {} };
    const status = out.status ?? 200;
    const body = out.body ?? out;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  M.calls.reset();
  await signIn(M);
  M.setAuthToken("test-token");
});

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  return r;
};

test("a workspace token is LOOKED UP (not consumed) and never sent to the collaboration endpoint", async () => {
  const r = await render();
  const lookup = requests.find((q) => q.path === "/v1/teams/invites/lookup");
  assert.deepEqual(lookup?.body, { token: TOKEN });
  assert.ok(!requests.some((q) => q.path.startsWith("/v1/collaboration-team-invites")), "a workspace invitation went to the collaboration endpoint");
  assert.ok(!requests.some((q) => q.path.endsWith("/accept")), "arriving accepted the invitation");
  assert.ok(r.hasText("You've been invited to join a workspace"));
  assert.ok(r.hasText("Acme Claims") && r.hasText("Acme Ltd") && r.hasText("Reviewer") && r.hasText("j••••@acme.com"));
});

test("Accept posts to the workspace route and shows the web's accepted state", async () => {
  const r = await render();
  await r.press("Accept invitation");
  await settle();
  assert.ok(requests.some((q) => q.method === "POST" && q.path === `/v1/teams/invites/${TOKEN}/accept`));
  assert.ok(r.hasText("Invitation accepted"));
  assert.equal(r.byLabel("Open workspace").length, 1);
});

test("a server refusal renders as itself — wrong account offers switching", async () => {
  routes[`/v1/teams/invites/${TOKEN}/accept`] = () => ({ status: 403, body: { error: { code: "INVITE_EMAIL_MISMATCH" } } });
  const r = await render();
  await r.press("Accept invitation");
  await settle();
  assert.ok(r.hasText("This invitation was sent to a different address"));
  assert.equal(r.byLabel("Sign in with another account").length, 1);
});

test("a 404 lookup is 'not available'; a 5xx is an interruption with Try again — never 'invalid'", async () => {
  routes["/v1/teams/invites/lookup"] = () => ({ status: 404, body: { error: { code: "INVITE_NOT_FOUND" } } });
  let r = await render();
  assert.ok(r.hasText("This invitation link isn't available"));
  r.unmount();
  routes["/v1/teams/invites/lookup"] = () => ({ status: 503, body: {} });
  r = await render();
  assert.ok(r.hasText("We couldn't check this invitation"));
  routes["/v1/teams/invites/lookup"] = () => ({ status: 200, body: PENDING });
  await r.press("Try again");
  await settle();
  assert.ok(r.hasText("You've been invited to join a workspace"), "Try again did not re-run the lookup");
});

test("signed out: the invitation is described and Sign in keeps it for after the journey", async () => {
  await M.deleteItemAsync("proovra-token");
  M.setAuthToken(null);
  const r = await render();
  assert.ok(r.hasText("Sign in to accept this invitation."));
  await r.press("Sign in to continue");
  assert.equal(M.calls.push.at(-1), "/(stack)/auth");
  assert.equal(r.byLabel("Accept invitation").length, 0, "Accept offered without a session");
});

test("a collaboration token still takes the collaboration flow", async () => {
  globalThis.__EXPO_PARAMS__ = { token: "ctit_v1_" + "B".repeat(43) };
  const r = await render();
  assert.ok(r.hasText("You’ve been invited to join a collaboration group."));
  assert.ok(!requests.some((q) => q.path === "/v1/teams/invites/lookup"));
});
