/**
 * MOBILE-008 / MOBILE-002 — a session the server ended ends here too, and says why.
 *
 * The 401 bodies below are what the server sends:
 *   requireAuth  { error: { code: "UNAUTHORIZED", details?: { reason, policy } } }
 *                { error: { code: "TOKEN_EXPIRED", details: { reason: "session_expired" } } }
 *   step-up      { error: { code: "STEP_UP_REQUIRED", methods: [...] } }
 *   adaptive     { error: { code: "reauth_required", message, reason } }
 *   switch       { message, code: "session_policy_reauth_required", reason }
 *
 * The real AuthProvider, apiFetch and SessionEndGate run; only fetch is replaced.
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let routes = {};
let requests = [];

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

before(async () => {
  M = await loadModule("app/(stack)/auth.tsx", [
    "test/support/providers.tsx",
    "test/support/expo-stub.mjs",
    "src/api.ts",
    "src/auth/session-end-gate.tsx",
    "src/auth/session-end.ts",
    "src/auth-context.tsx",
  ]);
});

beforeEach(async () => {
  requests = [];
  routes = { ...authenticatedRoutes(), "/v1/probe": () => ({ ok: true }) };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, bearer: new Headers(init.headers).get("authorization") });
    const handler = routes[path];
    if (!handler) return reply(200, {});
    const out = handler();
    return out instanceof Response ? out : reply(200, out);
  };
  M.calls.reset();
  await signIn(M);
});

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const mounted = [];
afterEach(() => {
  while (mounted.length) mounted.pop().unmount();
});

const Who = () => {
  const { token, bootPhase } = M.useAuth();
  return h("Text", { testID: "who" }, `${token ?? "none"}|${bootPhase}`);
};
const render = async () => {
  const r = await renderComponent(
    h(M.TestProviders, null, h(M.SessionEndGate), h(Who), h(M.default, {})),
  );
  mounted.push(r);
  await settle();
  return r;
};
const who = (r) => r.byTestId("who")[0].props.children;
const probe = async (path = "/v1/probe") => {
  await act(async () => {
    await M.apiFetch(path).catch(() => undefined);
  });
  await settle();
};

const expectEnded = async (r, notice) => {
  assert.equal(who(r), "none|expired", "the session is gone from memory");
  assert.equal(await M.getItemAsync("proovra-token"), null, "and from secure storage");
  assert.equal(await M.getItemAsync("proovra-auth-mode"), null);
  assert.equal(M.getAuthToken(), null, "and from the transport");
  assert.deepEqual(M.calls.replace.at(-1), "/(stack)/auth");
  assert.ok(M.calls.dismissAll >= 1, "nothing may stay on the stack beneath the sign-in screen");
  assert.ok(r.byTestId("auth-session-ended").length > 0);
  assert.ok(r.hasText(notice), `expected the notice: ${notice}`);
};

test("positive control: an ordinary session stays signed in", async () => {
  const r = await render();
  await probe();
  assert.equal(who(r), "test-token|authenticated");
  assert.equal(r.byTestId("auth-session-ended").length, 0);
});

test("a session revoked while the app is open ends here, with the reason", async () => {
  const r = await render();
  routes["/v1/probe"] = () => reply(401, { error: { code: "UNAUTHORIZED", message: "Authentication required", requestId: "r1" } });
  await probe();
  await expectEnded(r, "You were signed out.");
});

test("an expired session says it expired", async () => {
  const r = await render();
  routes["/v1/probe"] = () => reply(401, { error: { code: "TOKEN_EXPIRED", details: { reason: "session_expired" } } });
  await probe();
  await expectEnded(r, "Your session expired.");
});

test("a tightened policy says it was the organization's policy", async () => {
  const r = await render();
  routes["/v1/probe"] = () =>
    reply(401, { error: { code: "UNAUTHORIZED", details: { reason: "reauthentication_required", policy: "session_max_age_exceeded" } } });
  await probe();
  await expectEnded(r, "security policy no longer accepts this sign-in");
});

test("MOBILE-002: mandatory SSO says what to do instead of looping through sign-in", async () => {
  const r = await render();
  routes["/v1/probe"] = () =>
    reply(401, { error: { code: "UNAUTHORIZED", details: { reason: "reauthentication_required", policy: "mandatory_sso_required" } } });
  await probe();
  await expectEnded(r, "requires its single sign-on, which the PROOVRA app does not offer");
});

test("a dead token found at boot reports its reason too", async () => {
  routes["/v1/auth/me"] = () => reply(401, { error: { code: "UNAUTHORIZED" } });
  const r = await render();
  await expectEnded(r, "You were signed out.");
});

for (const [name, status, body] of [
  ["a step-up challenge", 401, { error: { code: "STEP_UP_REQUIRED", methods: ["password"], message: "x" } }],
  ["a rejected step-up", 401, { error: { code: "STEP_UP_INVALID", methods: ["password"], message: "x" } }],
  ["an action needing a fresher sign-in", 401, { error: { code: "reauth_required", message: "Sign in again to perform this action." } }],
  ["an adaptive step-up", 401, { error: { code: "step_up_required", message: "x", purpose: "SESSION_SANITY_CHECK" } }],
  ["a workspace this session may not enter", 401, { message: "x", code: "session_policy_reauth_required", reason: "session_max_age_exceeded" }],
  ["a capture target this session may not use", 401, { denial: "REAUTHENTICATION_REQUIRED" }],
  ["an inactive reviewer grant", 401, { error: { code: "grant_not_active" } }],
  ["a route's own flat refusal", 401, { message: "Unknown caller" }],
  ["a permission refusal", 403, { error: { code: "FORBIDDEN" } }],
  ["an outage", 503, { error: { code: "SECURITY_CONTEXT_UNAVAILABLE" } }],
]) {
  test(`${name} leaves the session alone`, async () => {
    const r = await render();
    routes["/v1/probe"] = () => reply(status, body);
    await probe();
    assert.equal(who(r), "test-token|authenticated");
    assert.equal(await M.getItemAsync("proovra-token"), "test-token");
    assert.equal(M.calls.dismissAll, 0);
  });
}

test("a late refusal of a previous session cannot end the next one", async () => {
  const r = await render();
  let release;
  const parked = new Promise((resolve) => { release = resolve; });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/v1/slow")) {
      await parked;
      return reply(401, { error: { code: "UNAUTHORIZED" } });
    }
    return realFetch(url, init);
  };
  const late = M.apiFetch("/v1/slow").catch(() => undefined);
  await act(async () => { M.setAuthToken("next-session"); });
  release();
  await act(async () => { await late; });
  await settle();
  assert.equal(M.getAuthToken(), "next-session");
  assert.equal(M.calls.dismissAll, 0);
  assert.notEqual(who(r), "none|expired");
});

test("an anonymous 401 (a wrong password) ends nothing", async () => {
  await M.deleteItemAsync("proovra-token");
  routes["/v1/auth/email/login"] = () => reply(401, { error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password." } });
  const r = await render();
  await r.type("Email", "a@b.co");
  await r.type("Password", "Wrong-password-1");
  await r.press("I agree to the Terms of Service, Privacy Policy and Cookie Policy");
  await r.press("Sign in with Email");
  await settle();
  assert.equal(r.byTestId("auth-session-ended").length, 0);
  assert.equal(M.calls.dismissAll, 0);
});

test("MOBILE-002: a sign-in whose session the organization refuses is not stored, and says why", async () => {
  await M.deleteItemAsync("proovra-token");
  routes["/v1/auth/email/login"] = () => ({ token: "password-session", user: { id: "u1", email: "a@b.co" } });
  routes["/v1/users/legal-status"] = () =>
    reply(401, { error: { code: "UNAUTHORIZED", details: { reason: "reauthentication_required", policy: "mandatory_sso_required" } } });
  const r = await render();
  await r.type("Email", "a@b.co");
  await r.type("Password", "Secret-password-1");
  await r.press("I agree to the Terms of Service, Privacy Policy and Cookie Policy");
  await r.press("Sign in with Email");
  await settle();
  assert.equal(await M.getItemAsync("proovra-token"), null);
  assert.equal(M.calls.replace.includes("/(tabs)"), false, "the shell must not open on a dead session");
  assert.ok(r.hasText("requires its single sign-on"));
});

test("signing in again clears the notice", async () => {
  const r = await render();
  routes["/v1/probe"] = () => reply(401, { error: { code: "UNAUTHORIZED" } });
  await probe();
  assert.equal(r.byTestId("auth-session-ended").length, 1);
  routes["/v1/auth/email/login"] = () => ({ token: "new-session", user: { id: "u1", email: "a@b.co" } });
  routes["/v1/users/legal-status"] = () => ({ ok: true, missingPolicies: [], requiredVersions: {} });
  await r.type("Email", "a@b.co");
  await r.type("Password", "Secret-password-1");
  await r.press("I agree to the Terms of Service, Privacy Policy and Cookie Policy");
  await r.press("Sign in with Email");
  await settle();
  assert.equal(r.byTestId("auth-session-ended").length, 0);
  assert.equal(await M.getItemAsync("proovra-token"), "new-session");
  assert.equal(M.calls.replace.at(-1), "/(tabs)");
});

test("the refused switch tells a real member the rule, not that they are no member", () => {
  const refused = (code, reason) => Object.assign(new Error("Not a member of this workspace"), { code, body: { reason } });
  assert.match(M.workspaceSwitchRefusal(refused("workspace_membership_required", "mandatory_sso_required")), /single sign-on/);
  assert.match(M.workspaceSwitchRefusal(refused("workspace_membership_required", "auth_method_not_allowed")), /does not accept/);
  assert.match(M.workspaceSwitchRefusal(refused("session_policy_reauth_required", "session_max_age_exceeded")), /more recent sign-in/);
  // An outsider's refusal carries no reason, and stays what it was.
  assert.equal(M.workspaceSwitchRefusal(refused("workspace_membership_required", undefined)), null);
});
