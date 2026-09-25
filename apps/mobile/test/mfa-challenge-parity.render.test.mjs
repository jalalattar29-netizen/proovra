/**
 * MFA challenge — the web's /auth/mfa-challenge (apps/web/app/auth/mfa-challenge/page.tsx).
 *
 * Server contract (services/api/src/routes/auth.routes.ts):
 *   POST /v1/auth/mfa/verify { mfaPendingToken, code? | recoveryCode? }   (:1378; body :249-258)
 *        200 { token, user } · 400 { message: "invalid_body" } · 401 { message: reason }
 *   Sign-in when the org requires MFA and no factor is enrolled:
 *        403 { mfaRequired: true, mfaEnrollmentRequired: true, reason: "org_policy_requires_mfa", message, user } (:586-597)
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let Mfa;
let Auth;
let posts = [];
let answer;

before(async () => {
  Mfa = await loadModule("app/(stack)/mfa.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
  Auth = await loadModule("app/(stack)/auth.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(() => {
  posts = [];
  globalThis.__EXPO_PARAMS__ = { pendingToken: "pending-token-aaaaaaaaaaaa" };
  answer = () => ({ status: 200, body: {} });
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (init.method === "POST") posts.push({ path, body: init.body ? JSON.parse(init.body) : null });
    const a = answer(path);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  };
  Mfa.calls.reset();
  Auth.calls.reset();
});
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const mounted = [];
const render = async (M) => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  mounted.push(r);
  await settle();
  return r;
};
afterEach(() => {
  while (mounted.length) mounted.pop().unmount();
});

test("the verify form speaks the web's words and validates before sending", async () => {
  const r = await render(Mfa);
  assert.ok(r.hasText("Two-factor verification"));
  assert.ok(r.hasText("Enter the 6-digit code from your authenticator app to finish signing in."));
  await r.type("Six-digit authenticator code", "12a");
  await r.press("Verify and continue");
  assert.ok(r.hasText("Enter the 6-digit code from your authenticator."));
  assert.equal(posts.length, 0);
  await r.press("Use a recovery code instead");
  assert.ok(r.hasText("Enter one of your single-use recovery codes. Each code works exactly once."));
  await r.type("Single-use recovery code", "short");
  await r.press("Verify and continue");
  assert.ok(r.hasText("Enter a recovery code from your saved batch."));
  assert.equal(posts.length, 0);
  assert.equal(r.byLabel("Use the authenticator code instead").length, 1);
});

test("a spaced authenticator code is sent as six digits", async () => {
  answer = (p) => (p === "/v1/auth/mfa/verify" ? { status: 401, body: { message: "mfa_invalid" } } : { status: 200, body: {} });
  const r = await render(Mfa);
  await r.type("Six-digit authenticator code", "123 456");
  await r.press("Verify and continue");
  await settle();
  assert.deepEqual(posts[0], { path: "/v1/auth/mfa/verify", body: { mfaPendingToken: "pending-token-aaaaaaaaaaaa", code: "123456" } });
  assert.ok(r.hasText("That code did not match. Check the timer on your authenticator and try again."));
});

test("no pending token is the ended-session surface at once", async () => {
  globalThis.__EXPO_PARAMS__ = {};
  const r = await render(Mfa);
  assert.equal(r.byTestId("mfa-expired").length, 1);
  assert.ok(r.hasText("Sign-in session expired"));
  assert.ok(r.hasText("Your sign-in session has expired. Please sign in again."));
});

test("Still stuck? Contact support opens Support", async () => {
  const r = await render(Mfa);
  assert.ok(r.hasText("Still stuck?"));
  await r.press("Contact support");
  assert.equal(Mfa.calls.push.at(-1), "/support");
});

test("enroll=1 is the enrolment-required surface, with no code box", async () => {
  globalThis.__EXPO_PARAMS__ = { enroll: "1" };
  const r = await render(Mfa);
  assert.equal(r.byTestId("mfa-enroll-required").length, 1);
  assert.ok(r.hasText("Set up two-factor authentication"));
  assert.ok(r.hasText("Your organization requires two-factor authentication. To continue, you need to enroll an authenticator on your account."));
  assert.equal(r.byLabel("Six-digit authenticator code").length, 0);
  await r.press("Sign in to start enrollment");
  assert.equal(Mfa.calls.replace.at(-1), "/(stack)/auth");
});

test("a sign-in refused for missing MFA enrolment routes to the enrolment surface", async () => {
  globalThis.__EXPO_PARAMS__ = {};
  answer = (p) =>
    p === "/v1/auth/email/login"
      ? {
          status: 403,
          body: {
            mfaRequired: true,
            mfaEnrollmentRequired: true,
            reason: "org_policy_requires_mfa",
            message: "Your organization requires multi-factor authentication. Please enroll an authenticator to continue.",
            user: { id: "u1", email: "a@b.co", provider: "EMAIL" },
          },
        }
      : { status: 200, body: {} };
  const r = await render(Auth);
  await r.type("Email", "a@b.co");
  await r.type("Password", "Secret-password-1");
  await r.press("I agree to the Terms of Service, Privacy Policy and Cookie Policy");
  await r.press("Sign in with Email");
  await settle();
  assert.deepEqual(Auth.calls.push.at(-1), { pathname: "/mfa", params: { enroll: "1", mode: "email" } });
});
