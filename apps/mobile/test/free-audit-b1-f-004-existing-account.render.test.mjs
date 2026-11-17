/**
 * B1-F-004 (free-audit 0ea0) — one person, one self-serve account per verified
 * address, on native.
 *
 *   - A Google/Apple sign-in whose verified address an existing account holds is
 *     refused 409 { code: "EXISTING_ACCOUNT_SIGN_IN_REQUIRED" } (auth.routes.ts).
 *     The sign-in screen shows the shared guidance (@proovra/shared
 *     USER_FACING_ERRORS) under its own title — not "Sign-in failed" and not
 *     "Apple sign-in failed: …" — and no session is completed.
 *   - Forgot password explains that a Google/Apple account has no PROOVRA
 *     password, before and after the neutral request; nothing else is sent.
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
const GUIDANCE_TITLE = "Sign in to your existing account";
const HINT =
  "Signed up with Google or Apple? Your account may not have a PROOVRA password. Use Continue with Google or Continue with Apple to sign in; you can add a password afterwards from Security > Sign-in methods.";

let Auth;
let Forgot;
let E;
let posts = [];
let appleAnswer;

before(async () => {
  Auth = await loadModule("app/(stack)/auth.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
  Forgot = await loadModule("app/(stack)/forgot-password.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
  E = await loadModule("src/errors/safe-error.ts");
});
beforeEach(() => {
  posts = [];
  globalThis.__EXPO_PARAMS__ = {};
  appleAnswer = { status: 409, body: { code: "EXISTING_ACCOUNT_SIGN_IN_REQUIRED", message: "server sentence" } };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    if ((init.method ?? "GET") === "POST") posts.push({ path, body: init.body ? JSON.parse(init.body) : null });
    let a = { status: 200, body: {} };
    if (path === "/v1/auth/oauth/nonce") a = { status: 200, body: { nonce: "stub-nonce", expiresInSeconds: 600 } };
    if (path === "/v1/auth/apple") a = appleAnswer;
    if (path === "/v1/auth/password-reset/request") a = { status: 200, body: { ok: true } };
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  };
  Auth.calls.reset();
  Forgot.calls.reset();
});
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const mounted = [];
const mount = async (M) => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  mounted.push(r);
  await settle();
  return r;
};
afterEach(() => {
  while (mounted.length) mounted.pop().unmount();
});
const consent = "I agree to the Terms of Service, Privacy Policy and Cookie Policy";

test("the shared guidance maps the code on native, with no raw code", () => {
  const e = E.toSafeUserError(Object.assign(new Error("HTTP 409"), { statusCode: 409, code: "EXISTING_ACCOUNT_SIGN_IN_REQUIRED" }));
  assert.equal(e.explained, true);
  assert.equal(e.title, GUIDANCE_TITLE);
  assert.match(e.message, /no new account was created/);
  assert.match(e.message, /Security > Sign-in methods/);
});

test("Apple sign-in refused with EXISTING_ACCOUNT_SIGN_IN_REQUIRED shows guidance, not 'sign-in failed'", async () => {
  const r = await mount(Auth);
  await r.press(consent);
  await r.press("Continue with Apple");
  await settle();
  assert.ok(posts.some((p) => p.path === "/v1/auth/apple"), posts.map((p) => p.path).join(","));
  assert.ok(r.hasText(GUIDANCE_TITLE), r.texts().join(" | "));
  assert.ok(!r.hasText("Sign-in failed"), r.texts().join(" | "));
  assert.ok(!r.texts().some((s) => s.startsWith("Apple sign-in failed: ")), r.texts().join(" | "));
  assert.ok(!r.texts().some((s) => s.includes("EXISTING_ACCOUNT_SIGN_IN_REQUIRED")));
  assert.ok(r.texts().some((s) => /no new account was created/.test(s)), r.texts().join(" | "));
});

test("control: any other Apple refusal still reads 'Apple sign-in failed: …'", async () => {
  appleAnswer = { status: 401, body: { message: "invalid_id_token" } };
  const r = await mount(Auth);
  await r.press(consent);
  await r.press("Continue with Apple");
  await settle();
  assert.ok(r.hasText("Sign-in failed"));
  assert.ok(r.texts().some((s) => s.startsWith("Apple sign-in failed: ")), r.texts().join(" | "));
});

test("Forgot password: the social sign-in hint before and after the neutral request; only that request is sent", async () => {
  const r = await mount(Forgot);
  assert.ok(r.hasText(HINT), r.texts().join(" | "));
  await r.type("Email address", "someone@example.com");
  await act(async () => { await r.byLabel("Send reset link").find((n) => n.props.onPress).props.onPress(); });
  await settle();
  assert.ok(r.hasText("If an account exists for this address, a secure password reset link has been sent."));
  assert.ok(r.hasText(HINT));
  assert.deepEqual(posts, [{ path: "/v1/auth/password-reset/request", body: { email: "someone@example.com" } }]);
});
