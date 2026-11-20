/**
 * M172 (RG-15) — a record link opened while signed out still opens in its own
 * workspace when the sign-in stops at the legal-acceptance gate.
 *
 * The normal replay (src/auth/use-auth-flow.ts, PRO-NA-04) resolves the link on
 * the server and switches to the record's workspace through
 * openRecordLinkInItsWorkspace. When acceptance was missing, the bootstrap sent
 * the gate `next=<raw record route>` and the gate did router.replace(next): the
 * record opened in whatever workspace was active, with no resolve and no switch.
 *
 * Real sign-in screen, real legal gate, real apiFetch; the server bodies are the
 * ones users.routes.ts / deep-link resolve send.
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let Auth;
let Gate;
let requests;
let legalOk;
let failAcceptance;
const mounted = [];

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

before(async () => {
  const extras = ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/deep-link/pending-intent.ts"];
  Auth = await loadModule("app/(stack)/auth.tsx", extras);
  Gate = await loadModule("app/(stack)/legal-acceptance.tsx", extras);
});

beforeEach(async () => {
  requests = [];
  legalOk = false;
  failAcceptance = false;
  delete globalThis.__EXPO_CAN_GO_BACK__;
  globalThis.__EXPO_PARAMS__ = {};
  await Auth.deleteItemAsync("proovra-token");
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
    if (path === "/v1/auth/email/login") return reply(200, { token: "session-1", user: { id: "u1", email: "a@b.co" } });
    if (path === "/v1/users/legal-status") {
      return legalOk
        ? reply(200, { ok: true, missingPolicies: [], requiredVersions: { terms: "2026-09" } })
        : reply(200, { ok: false, missingPolicies: ["terms"], requiredVersions: { terms: "2026-09" } });
    }
    if (path === "/v1/users/legal-acceptance" && init.method === "POST") {
      // The sign-in screen's own acceptance is not saved here, so the gate asks.
      if (failAcceptance) return reply(503, { error: { code: "SERVICE_UNAVAILABLE", message: "x" } });
      legalOk = true;
      return reply(200, { items: [] });
    }
    if (path === "/v1/deep-link/resolve") return reply(200, { ok: true, workspaceId: "team-9" });
    if (path.startsWith("/v1/workspaces/switch") || path.startsWith("/v1/platform/context/switch")) return reply(200, { activeWorkspaceId: "team-9" });
    return reply(200, {});
  };
  Auth.calls.reset();
  Gate.calls.reset();
  Auth.clearPendingRoute();
  Gate.clearPendingRoute();
});
afterEach(() => {
  while (mounted.length) mounted.pop().unmount();
  Auth.clearPendingRoute();
  Gate.clearPendingRoute();
});

const settle = async () => {
  for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async (M) => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  mounted.push(r);
  await settle();
  return r;
};

test("M172 — sign-in with acceptance missing never hands the gate the raw record route; the link stays pending for the resolver", async () => {
  Auth.setPendingRoute("/(stack)/evidence/ev-1", "proovra://evidence/ev-1");
  failAcceptance = true;
  const r = await render(Auth);
  await r.type("Email", "a@b.co");
  await r.type("Password", "Secret-password-1");
  await r.press("I agree to the Terms of Service, Privacy Policy and Cookie Policy");
  await r.press("Sign in with Email");
  await settle();
  const toGate = Auth.calls.replace.find((x) => typeof x === "object" && x?.pathname === "/legal-acceptance");
  assert.ok(toGate, `the gate was not opened: ${JSON.stringify(Auth.calls.replace)}`);
  assert.notEqual(toGate.params.next, "/(stack)/evidence/ev-1", "the raw record route rides to the gate");
  assert.equal(toGate.params.next, "/(tabs)");
  assert.equal(Auth.peekPendingRoute(), "/(stack)/evidence/ev-1", "the record link is kept for the post-acceptance replay");
  assert.equal(requests.some((q) => q.path === "/v1/deep-link/resolve"), false, "nothing is opened before acceptance");
});

test("M172 — accepting at the sign-in gate replays the pending record link through the resolve + workspace switch", async () => {
  Gate.setPendingRoute("/(stack)/evidence/ev-1", "proovra://evidence/ev-1");
  globalThis.__EXPO_PARAMS__ = { policies: "terms", next: "/(tabs)" };
  const r = await render(Gate);
  await r.press("Accept and continue");
  await settle();
  assert.equal(Gate.calls.replace.at(-1), "/(tabs)");
  assert.deepEqual(requests.find((q) => q.path === "/v1/deep-link/resolve")?.body, { resourceType: "evidence", resourceId: "ev-1" });
  assert.deepEqual(Gate.calls.push.filter((p) => p !== "/legal/terms"), ["/(stack)/evidence/ev-1"]);
  assert.equal(Gate.peekPendingRoute(), null, "the replay is one-shot");
});

test("M172 control — the gate opened by a refused write (no next) leaves any pending link alone", async () => {
  Gate.setPendingRoute("/(stack)/evidence/ev-1", "proovra://evidence/ev-1");
  globalThis.__EXPO_PARAMS__ = { policies: "terms" };
  const r = await render(Gate);
  await r.press("Accept and continue");
  await settle();
  assert.equal(Gate.calls.back, 1);
  assert.equal(requests.some((q) => q.path === "/v1/deep-link/resolve"), false);
});
