/**
 * Org invite accept — the web page (apps/web/app/(app)/org-invites/[token]/accept/page.tsx).
 *
 * Server (services/api/src/routes/organizations.routes.ts, POST /v1/org-invites/:token/accept):
 *   200 { organizationId, role, assignedWorkspaceIds, …setupRedirect? }   (:1136-1151)
 *   404 { message: "Invite not found." } · 410 { message } revoked / accepted / expired / closed
 *   403 { message: "Invite email does not match your account." }          (:1065-1086)
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let accept;
before(async () => {
  M = await loadModule("app/(stack)/org-invite/[token].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/api.ts", "src/product/org-invite.ts"]);
});
beforeEach(async () => {
  globalThis.__EXPO_PARAMS__ = { token: "oinv_1" };
  accept = () => ({ status: 200, body: { organizationId: "o1", role: "ORG_MEMBER", assignedWorkspaceIds: [] } });
  const routes = authenticatedRoutes({});
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const send = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
    if (init.method === "POST" && path === "/v1/org-invites/accept") {
      assert.deepEqual(JSON.parse(init.body), { token: "oinv_1" }, "B-15: the token travels in the body");
      const a = accept();
      return send(a.body, a.status);
    }
    const key = Object.keys(routes).find((p) => path.startsWith(p));
    return send(key ? routes[key]() : {});
  };
  M.calls.reset();
  await signIn(M);
  M.setAuthToken("test-token");
});
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const mounted = [];
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  mounted.push(r);
  await settle();
  return r;
};
afterEach(() => {
  while (mounted.length) mounted.pop().unmount();
});

// PRO-072 (2026-11-06): the scope note said "This does NOT grant you access to
// workspace evidence…" for every invitation, which was false for one carrying
// workspace assignments. The note is now read from POST /v1/org-invites/lookup
// (org-invite-grants.render.test.mjs); with no lookup answer here it claims
// nothing either way.
test("the web's heading and Accept invite; the scope note makes no false claim", async () => {
  const r = await render();
  assert.ok(r.hasText("Accept organization invite"));
  assert.ok(!r.hasText("This does NOT grant you access to workspace evidence, cases, or reviewer queues — those remain workspace-scoped."));
  assert.ok(r.hasText("We could not load the details of this invitation. Accepting adds you to the organization with the role the inviter chose, and to any workspaces the invitation names, at the role it names."));
  assert.equal(r.byLabel("Accept invite").length, 1);
});

test("a governance-only accept says so and lands on the organization after a moment", async () => {
  const r = await render();
  await r.press("Accept invite");
  await settle();
  assert.ok(r.hasText("You are now an org member of the organization. Redirecting…"));
  assert.equal(M.calls.replace.length, 0, "landed before the confirmation could be read");
  await act(async () => { await new Promise((x) => setTimeout(x, 1600)); });
  assert.equal(M.calls.replace.at(-1), "/organizations/o1");
});

test("grants: the count is said, and Open organization is offered beside each Open", async () => {
  accept = () => ({ status: 200, body: { organizationId: "o1", role: "ORG_ADMIN", assignedWorkspaceIds: ["ws-a", "ws-b"] } });
  const r = await render();
  await r.press("Accept invite");
  await settle();
  assert.ok(r.hasText("You are now an org admin of the organization with access to 2 workspaces."));
  await r.press("Open organization");
  assert.equal(M.calls.replace.at(-1), "/organizations/o1");
});

for (const [status, message, words] of [
  [410, "Invite has expired.", "This invite is expired, revoked, or already accepted. Ask an organization administrator to send a new one."],
  [404, "Invite not found.", "Invite not found — the link may be incorrect. Ask an organization administrator for a new invitation."],
  [403, "Invite email does not match your account.", "The invite couldn't be accepted. Ask an organization administrator for a new invitation."],
]) {
  test(`a ${status} is "We couldn't accept this invite" with the web's reason and two ways on`, async () => {
    accept = () => ({ status, body: { message } });
    const r = await render();
    await r.press("Accept invite");
    await settle();
    assert.equal(r.byTestId("org-invite-error").length, 1);
    assert.ok(r.hasText("We couldn't accept this invite"));
    assert.ok(r.hasText(words), r.texts().join(" | "));
    await r.press("Go to organizations");
    assert.equal(M.calls.replace.at(-1), "/organizations");
    await r.press("Return to dashboard");
    assert.equal(M.calls.replace.at(-1), "/(tabs)");
  });
}

test("MOBILE-012: a new Enterprise owner is told the setup waits in the web app, and is not auto-landed past it", async () => {
  process.env.EXPO_PUBLIC_WEB_BASE = "https://www.proovra.com";
  accept = () => ({ status: 200, body: { organizationId: "o1", role: "ORG_OWNER", assignedWorkspaceIds: [], setupRedirect: "/organizations/o1/setup" } });
  const r = await render();
  await r.press("Accept invite");
  await settle();
  assert.equal(r.byTestId("org-invite-setup-on-web").length, 1);
  assert.ok(r.hasText("You are now an org owner of the organization."));
  assert.ok(!r.hasText("Redirecting…"));
  await act(async () => { await new Promise((x) => setTimeout(x, 1600)); });
  assert.equal(M.calls.replace.length, 0, "the owner was landed past the owed setup");
  await r.press("Continue setup in the web app");
  assert.equal(M.calls.openURL.at(-1), "https://www.proovra.com/organizations/o1/setup");
  assert.equal(M.orgSetupWebUrl({ setupRedirect: "https://evil.example/x" }, "https://www.proovra.com"), null, "only the server's setup route is opened");
});

// B-16 — the accept route now names each refusal (nested error.code); the
// screen says what to do, in the web page's words, instead of "ask for a new
// invitation" for all of them.
for (const [status, code, title, words] of [
  [403, "INVITE_EMAIL_MISMATCH", "This invitation was sent to a different address", "You are signed in with another account. Sign out, sign in (or create an account) with the address the invitation was sent to, then open the link again. The invitation stays valid."],
  [410, "INVITE_EXPIRED", "This invitation has expired", "Ask an organization administrator to send a new invitation if you still need access."],
  [410, "ORGANIZATION_NOT_ACCEPTING_MEMBERS", "This organization isn't accepting members", "It is archived or suspended. Ask an organization administrator if you still need access."],
  [409, "MEMBERSHIP_SUSPENDED", "Your membership in this organization is suspended", "Ask an organization administrator to reinstate it. A new invitation does not lift a suspension."],
  [409, "INVITE_SUPERSEDED", "This invitation is no longer valid", "It was issued before your access to this organization ended. Ask for a new invitation."],
  // NEW-RG-07-4 / NEW-RG-26-3 (DEC-28) — the inviter can no longer grant it.
  [409, "INVITE_INVITER_AUTHORITY_LOST", "This invitation needs to be sent again", "The person who sent it can no longer grant this access, so nothing was changed. Ask an organization administrator to send the invitation again."],
]) {
  test(`B-16: ${code} says "${title}"`, async () => {
    accept = () => ({ status, body: { error: { code }, message: "server sentence" } });
    const r = await render();
    await r.press("Accept invite");
    await settle();
    assert.ok(r.hasText(title), r.texts().join(" | "));
    assert.ok(r.hasText(words));
    assert.ok(!r.hasText("We couldn't accept this invite"));
  });
}

test("B-16: a busy workspace offers Try again, which accepts and succeeds", async () => {
  let n = 0;
  accept = () =>
    n++ === 0
      ? { status: 409, body: { error: { code: "WORKSPACE_SEAT_CONTENTION" }, message: "busy" } }
      : { status: 200, body: { organizationId: "o1", role: "ORG_MEMBER", assignedWorkspaceIds: [] } };
  const r = await render();
  await r.press("Accept invite");
  await settle();
  assert.ok(r.hasText("Too many people are joining at once"));
  await r.press("Try again");
  await settle();
  assert.ok(r.hasText("You are now an org member of the organization. Redirecting…"));
});
