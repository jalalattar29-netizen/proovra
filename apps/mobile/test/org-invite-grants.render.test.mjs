/**
 * PRO-072 — the native org-invite screen states what accepting grants.
 *
 * It said "This does NOT grant you access to workspace evidence, cases, or
 * reviewer queues" for every invitation, while accepting wrote the
 * invitation's workspace assignments (up to workspace ADMIN). It now reads
 * POST /v1/org-invites/lookup (organizations.routes.ts), as the web page does.
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let lookup;
let lookupCalls;
before(async () => {
  M = await loadModule("app/(stack)/org-invite/[token].tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/api.ts", "src/product/org-invite.ts"]);
});
beforeEach(async () => {
  globalThis.__EXPO_PARAMS__ = { token: "oinv_1" };
  lookupCalls = [];
  const routes = authenticatedRoutes({});
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const send = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
    if (init.method === "POST" && path === "/v1/org-invites/lookup") {
      lookupCalls.push({ path, body: init.body ? JSON.parse(init.body) : null });
      const l = lookup();
      return send(l.body, l.status);
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
const pending = (workspaces) => ({
  status: 200,
  body: { state: "PENDING", context: { organizationName: "Acme Claims", role: "ORG_MEMBER", invitedEmailMasked: "j•••@acme.test", expiresAtUtc: "2026-12-01T00:00:00.000Z", workspaces } },
});

test("an invitation carrying workspace ADMIN says so before Accept", async () => {
  lookup = () => pending([{ workspaceName: "Claims Review", role: "ADMIN" }]);
  const r = await render();
  assert.deepEqual(lookupCalls[0].body, { token: "oinv_1" }, "the token travels in the body");
  assert.ok(r.hasText("Accepting adds you to Acme Claims as an organization member. Invited address: j•••@acme.test."));
  assert.ok(r.hasText("Claims Review: Admin: can manage the workspace, its members and its settings"));
  assert.ok(!r.hasText("It gives you no workspace access. Evidence, cases and reviewer queues belong to workspaces, and an administrator can add you to one later."));
  assert.equal(r.byLabel("Accept invite").length, 1);
});

test("control: a governance-only invitation says it gives no workspace access", async () => {
  lookup = () => pending([]);
  const r = await render();
  assert.ok(r.hasText("It gives you no workspace access. Evidence, cases and reviewer queues belong to workspaces, and an administrator can add you to one later."));
});

test("a revoked invitation offers no Accept", async () => {
  lookup = () => ({ status: 200, body: { state: "REVOKED", context: null } });
  const r = await render();
  assert.ok(r.hasText("This invitation was revoked."));
  assert.equal(r.byLabel("Accept invite").length, 0);
});

test("an unknown link is the not-found refusal", async () => {
  lookup = () => ({ status: 404, body: { error: { code: "INVITE_NOT_FOUND", message: "This invitation link is not available." } } });
  const r = await render();
  assert.ok(r.hasText("Invite not found — the link may be incorrect. Ask an organization administrator for a new invitation."));
  assert.equal(r.byLabel("Accept invite").length, 0);
});
