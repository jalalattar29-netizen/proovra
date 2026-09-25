/**
 * T-15 — connect / disconnect Google and Apple from Settings → Security
 * (PersonalSecuritySections.tsx:721-880; POST /v1/identity/links/:provider,
 * DELETE /v1/identity/links/:id).
 *
 * Before: native only LISTED sign-in methods. It could not add a second way
 * into the account — the very thing its own warning ("This is the only way
 * into your account") told the user to do — nor remove one.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};
let links;

before(async () => {
  M = await loadModule("app/(stack)/settings/security.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  links = { passwordConfigured: true, usableMethods: 2, links: [{ id: "lk-g", provider: "GOOGLE", linkedAtUtc: "2026-01-02T03:04:05.000Z" }] };
  routes = {
    ...authenticatedRoutes(),
    "/v1/identity/links/apple": (method, body) => ({ status: 200, body: {} }),
    "/v1/identity/links/lk-g": () => ({ status: 200, body: {} }),
    "/v1/identity/links": () => ({ status: 200, body: links }),
    "/v1/identity/mfa/factors": () => ({ status: 200, body: { hasMfa: false, factors: [], recoveryCodesRemaining: 0 } }),
    "/v1/identity-security/my-sessions": () => ({ status: 200, body: { sessions: [] } }),
    "/v1/identity-security/security-events": () => ({ status: 200, body: { events: [] } }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ path, method, body });
    const key = routes[path] ? path : Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const out = key ? routes[key](method, body) : { status: 500, body: { message: "unstubbed" } };
    return new Response(JSON.stringify(out.body ?? {}), { status: out.status ?? 200, headers: { "content-type": "application/json" } });
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
const writes = () => requests.filter((q) => q.method !== "GET");

test("Apple is offered when not linked; connecting posts the ID token and is NOT a new sign-in", async () => {
  const r = await render();
  assert.equal(r.byLabel("Connect Google").length, 0, "offered to connect an already-linked provider");
  await r.press("Connect Apple");
  await settle();
  const post = writes()[0];
  assert.equal(post.path, "/v1/identity/links/apple");
  assert.deepEqual(post.body, { idToken: "stub-token" });
  assert.ok(!requests.some((q) => q.path.startsWith("/v1/auth/oauth")), "the token was exchanged for a session instead of linked");
  assert.ok(r.hasText("Apple connected."));
});

test("a step-up challenge is answered and the SAME link is retried with the proof", async () => {
  let attempts = 0;
  routes["/v1/identity/links/apple"] = (method, body) => {
    attempts += 1;
    return body?.stepUp ? { status: 200, body: {} } : { status: 401, body: { error: { code: "STEP_UP_REQUIRED", methods: ["password"] } } };
  };
  const r = await render();
  await r.press("Connect Apple");
  await settle();
  await r.type("Your password", "OldPassword9Here");
  await r.press("Confirm");
  await settle();
  const last = writes().at(-1);
  assert.deepEqual(last.body, { idToken: "stub-token", stepUp: { method: "password", currentPassword: "OldPassword9Here" } });
  assert.equal(attempts, 2);
  assert.ok(r.hasText("Apple connected."));
});

test("disconnect asks first, sends DELETE for that link, and shows the server's own refusal", async () => {
  routes["/v1/identity/links/lk-g"] = () => ({
    status: 409,
    body: { error: { code: "last_login_method_protected", message: "Add another way to sign in before removing this one." } },
  });
  const r = await render();
  await r.press("Disconnect Google");
  assert.ok(r.hasText("Disconnect Google?"));
  assert.ok(r.hasText("At least one other usable login method must remain."));
  assert.equal(writes().length, 0, "removed before confirmation");
const confirm = r.byLabel("Disconnect")
  .filter((n) => n.props.onPress).at(-1);

assert.ok(confirm, "Disconnect confirmation button is missing");
  await act(async () => { await confirm.props.onPress(); });
  await settle();
  const del = writes()[0];
  assert.equal(del.path, "/v1/identity/links/lk-g");
  assert.equal(del.method, "DELETE");
  assert.ok(r.hasText("Add another way to sign in before removing this one."), "the server's refusal was replaced with generic copy");
});

test("the only way in is never offered for removal", async () => {
  links = { passwordConfigured: false, usableMethods: 1, links: [{ id: "lk-g", provider: "GOOGLE", linkedAtUtc: null }] };
  const r = await render();
  assert.equal(r.byLabel("Disconnect Google").length, 0);
  assert.ok(r.byLabel("Connect Apple").length === 1, "a second method was not offered to a single-method account");
});

/* ------------------------------------------- first password (OAuth-only) */

test("an OAuth-only account is offered ADD a password — not a change form that needs a password it lacks", async () => {
  links = { passwordConfigured: false, usableMethods: 1, links: [{ id: "lk-g", provider: "GOOGLE", linkedAtUtc: null }] };
  routes["/v1/identity/password"] = () => ({ status: 200, body: {} });
  const r = await render();
  assert.equal(r.byLabel("Current password").length, 0, "asked for a current password the account does not have");
  assert.ok(r.hasText("Add a password"));
await r.press("Add password");
await settle();
const add = () => r.byLabel("Save the new password")[0];
  await r.type("New password (12+ chars, upper- and lower-case, a number)", "short");
  assert.ok(add().props.accessibilityState.disabled, "a password below policy could be submitted");
  await r.type("New password (12+ chars, upper- and lower-case, a number)", "CorrectHorse9Battery");
await r.press("Save the new password");
  await settle();
  const post = writes().find((q) => q.path === "/v1/identity/password");
  assert.deepEqual(post.body, { newPassword: "CorrectHorse9Battery" });
  assert.ok(r.hasText("Password added. You can now sign in with email and password."));
});

test("an account WITH a password still gets the change form", async () => {
  const r = await render();
  assert.equal(r.byLabel("Add password").length, 0);
  assert.ok(r.byLabel("Current password").length > 0);
});
