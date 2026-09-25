/**
 * Sign-in — the web card (apps/web/app/login/page.tsx:755-1180), feature by feature.
 *
 * Server contract (services/api/src/routes/auth.routes.ts):
 *   POST /v1/auth/email/login            200 { token, user }                      (:1123)
 *                                        403 { error: { code: "EMAIL_NOT_VERIFIED", message } } (:1087)
 *   POST /v1/auth/email/resend-verification  200 { ok: true }                    (:1343/:1358)
 * users.routes.ts:
 *   GET  /v1/users/legal-status   { ok, requiresReacceptance, missingPolicies, acceptedVersions, requiredVersions } (:184)
 *   POST /v1/users/legal-acceptance { source?, acceptances: [{ policyKey, policyVersion }] } (:17, :211)
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let M;
let posts = [];
let answer;
const REQUIRED = { terms: "2026-06-23", privacy: "2026-06-26", cookies: "2026-06-23" };

before(async () => {
  M = await loadModule("app/(stack)/auth.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(() => {
  posts = [];
  globalThis.__EXPO_PARAMS__ = {};
  answer = (path) => {
    if (path === "/v1/auth/email/login") return { status: 200, body: { token: "jwt-1", user: { id: "u1", email: "a@b.co" } } };
    if (path === "/v1/users/legal-status")
      return { status: 200, body: { ok: false, requiresReacceptance: true, missingPolicies: ["terms", "privacy", "cookies"], acceptedVersions: {}, requiredVersions: REQUIRED } };
    if (path === "/v1/users/legal-acceptance") return { status: 200, body: { ok: true } };
    if (path === "/v1/auth/email/resend-verification") return { status: 200, body: { ok: true } };
    return { status: 200, body: {} };
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    if ((init.method ?? "GET") === "POST") posts.push({ path, body: init.body ? JSON.parse(init.body) : null });
    const a = answer(path);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  };
  M.calls.reset();
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
const consent = "I agree to the Terms of Service, Privacy Policy and Cookie Policy";

test("the card head, the web order (Google → Or → email) and the email CTA", async () => {
  const r = await render();
  assert.ok(r.hasText("Account access"));
  assert.ok(r.hasText("Sign in"));
  assert.ok(r.hasText("Continue with your preferred sign-in method and return safely to your PROOVRA workspace."));
  const texts = r.texts();
  const google = texts.findIndex((s) => s === "Continue with Google");
  const or = texts.findIndex((s) => s === "Or");
  const cta = texts.findIndex((s) => s === "Sign in with Email");
  assert.ok(google >= 0 && or > google && cta > or, texts.join(" | "));
  assert.equal(r.byRole("checkbox").length, 1);
  assert.ok(!r.hasText("By continuing you agree"), "the passive notice replaced the consent box");
});

test("missing or malformed fields are answered on the field, with no request", async () => {
  const r = await render();
  await r.press("Sign in with Email");
  assert.ok(r.hasText("Enter your email address."));
  assert.ok(r.hasText("Enter your password."));
  const r2 = await render();
  await r2.type("Email", "not-an-address");
  await r2.type("Password", "pw");
  await r2.press("Sign in with Email");
  assert.ok(r2.hasText("Enter a valid email address."));
  assert.equal(posts.length, 0);
});

test("consent gates email and Google alike", async () => {
  const r = await render();
  await r.type("Email", "a@b.co");
  await r.type("Password", "Secret-password-1");
  await r.press("Sign in with Email");
  assert.ok(r.hasText("You must accept the Terms of Service, Privacy Policy, and Cookie Policy before continuing."));
  assert.equal(posts.length, 0);
  await r.press(consent);
  assert.ok(!r.hasText("You must accept the Terms of Service"), "ticking the box clears the refusal");
  await r.press(consent); // untick
  await r.press("Continue with Google");
  assert.ok(r.hasText("You must accept the Terms of Service, Privacy Policy, and Cookie Policy before continuing."));
});

test("a signed-in session records the acceptances the person just gave (source login, server versions)", async () => {
  const r = await render();
  await r.type("Email", "a@b.co");
  await r.type("Password", "Secret-password-1");
  await r.press(consent);
  await r.press("Sign in with Email");
  await settle();
  assert.deepEqual(posts[0], { path: "/v1/auth/email/login", body: { email: "a@b.co", password: "Secret-password-1" } });
  const legal = posts.find((p) => p.path === "/v1/users/legal-acceptance");
  assert.ok(legal, "no acceptance was recorded");
  assert.equal(legal.body.source, "login");
  assert.deepEqual(
    [...legal.body.acceptances].sort((a, b) => a.policyKey.localeCompare(b.policyKey)),
    [
      { policyKey: "cookies", policyVersion: REQUIRED.cookies },
      { policyKey: "privacy", policyVersion: REQUIRED.privacy },
      { policyKey: "terms", policyVersion: REQUIRED.terms },
    ],
  );
  // Recorded, so the person is not sent through the acceptance gate a second time.
  assert.equal(M.calls.replace.at(-1), "/(tabs)");
});

test("an unverified address gets the verify panel, a held Resend, and Use a different email", async () => {
  answer = ((prev) => (path) =>
    path === "/v1/auth/email/login"
      ? { status: 403, body: { error: { code: "EMAIL_NOT_VERIFIED", message: "Please verify your email address before signing in." } } }
      : prev(path))(answer);
  const r = await render();
  await r.type("Email", "a@b.co");
  await r.type("Password", "Secret-password-1");
  await r.press(consent);
  await r.press("Sign in with Email");
  await settle();
  assert.equal(r.byTestId("auth-verify-panel").length, 1);
  assert.ok(r.hasText("Verify your email address"));
  assert.ok(r.hasText("Please verify your email address before signing in. The link in your inbox will activate your account."));
  assert.equal(r.byTestId("auth-error").length, 0, "an unverified address is not an error");
  await r.press("Resend verification email");
  await settle();
  assert.deepEqual(posts.at(-1), { path: "/v1/auth/email/resend-verification", body: { email: "a@b.co" } });
  assert.ok(r.hasText("Verification email sent."));
  const held = r.byLabel("Resend pending…")[0];
  assert.ok(held?.props.accessibilityState?.disabled, "resend is not held after sending");
  await r.press("Use a different email");
  assert.equal(r.byTestId("auth-verify-panel").length, 0);
});

test("the password can be shown and hidden", async () => {
  const r = await render();
  const field = () => r.byTestId("auth-password")[0];
  assert.equal(field().props.secureTextEntry, true);
  await r.press("Show password");
  assert.equal(field().props.secureTextEntry, false);
  await r.press("Hide password");
  assert.equal(field().props.secureTextEntry, true);
});

test("the OAuth return states: 'Signing you in…' while exchanging, 'Sign-in failed' when refused", async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const base = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/v1/auth/apple")) {
      await gate;
      // auth.routes.ts answers a rejected provider token with 401 { message }.
      return new Response(JSON.stringify({ message: "invalid_token" }), { status: 401, headers: { "content-type": "application/json" } });
    }
    return base(url, init);
  };
  const r = await render();
  await r.press(consent);
  await r.press("Continue with Apple");
  await settle();
  assert.equal(r.byTestId("auth-oauth-progress").length, 1, r.texts().join(" | "));
  assert.ok(r.hasText("Signing you in…"));
  assert.ok(r.hasText("Please wait while we securely complete your sign-in."));
  release();
  await settle();
  assert.equal(r.byTestId("auth-oauth-progress").length, 0);
  assert.ok(r.hasText("Sign-in failed"));
  assert.ok(r.texts().some((s) => s.startsWith("Apple sign-in failed: ")), r.texts().join(" | "));
});
