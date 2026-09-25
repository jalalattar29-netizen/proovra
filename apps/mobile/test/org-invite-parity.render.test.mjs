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
  M = await loadModule("app/(stack)/org-invite/[token].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/api.ts"]);
});
beforeEach(async () => {
  globalThis.__EXPO_PARAMS__ = { token: "oinv_1" };
  accept = () => ({ status: 200, body: { organizationId: "o1", role: "ORG_MEMBER", assignedWorkspaceIds: [] } });
  const routes = authenticatedRoutes({});
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const send = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
    if (init.method === "POST" && path === "/v1/org-invites/oinv_1/accept") {
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

test("the web's heading, scope note and Accept invite", async () => {
  const r = await render();
  assert.ok(r.hasText("Accept organization invite"));
  assert.ok(r.hasText("Accepting will add you to the organization at the role the inviter chose. This does NOT grant you access to workspace evidence, cases, or reviewer queues — those remain workspace-scoped."));
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
