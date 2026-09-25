/**
 * Create account — the web card (apps/web/app/register/page.tsx:936-1660).
 *
 * Server contract (services/api/src/routes/auth.routes.ts):
 *   POST /v1/auth/email/register  201 { verificationSent, email }             (:953)
 *                                 409 { error: { code: "EMAIL_ALREADY_EXISTS", message } } (:887)
 *   GET  /v1/auth/email/availability?email=  { available: true } | { available: false, reason } (:964-987)
 *   POST /v1/auth/email/resend-verification   200 { ok: true }                (:1343/:1358)
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let M;
let posts = [];
let answer;
const PW = "Abcdefghijk1!";
const CONSENT = "I agree to the Terms of Service, Privacy Policy and Cookie Policy";

before(async () => {
  M = await loadModule("app/(stack)/register.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(() => {
  posts = [];
  answer = (path) => {
    if (path.startsWith("/v1/auth/email/availability")) return { status: 200, body: { available: true } };
    if (path === "/v1/auth/email/register") return { status: 201, body: { verificationSent: true, email: "new@example.com" } };
    if (path === "/v1/auth/email/resend-verification") return { status: 200, body: { ok: true } };
    return { status: 200, body: {} };
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (init.method === "POST") posts.push({ path, body: init.body ? JSON.parse(init.body) : null });
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
const submit = (r) => r.press("Create account with Email");

test("the card head and the web's hero words", async () => {
  const r = await render();
  assert.ok(r.hasText("Account setup"));
  assert.ok(r.hasText("Create your account"));
  assert.ok(r.hasText("Create your secure PROOVRA account."));
  assert.ok(r.hasText("Register to manage evidence records, verification pages, reports, and protected review workflows from one place."));
  assert.equal(r.byLabel("Create account with Email").length >= 1, true);
});

test("the form answers on submit, in the web's order and words", async () => {
  const r = await render();
  await submit(r);
  assert.ok(r.hasText("Please fill in your email and choose a password."));
  const r2 = await render();
  await r2.type("Email address", "new@example.com");
  await r2.type("Password", "short");
  await r2.type("Confirm password", "short");
  await submit(r2);
  assert.ok(r2.hasText("Your password does not meet the requirements listed below the password field."));
  // After a refused submit an unmet rule is a failure (✕), as on the web.
  assert.ok(r2.texts().some((s) => s.startsWith("✕ ")), r2.texts().join(" | "));
  assert.equal(posts.length, 0);
});

test("both password fields can be shown and hidden, separately", async () => {
  const r = await render();
  const pw = () => r.byTestId("register-password")[0];
  const pw2 = () => r.byTestId("register-password-confirm")[0];
  assert.equal(pw().props.secureTextEntry, true);
  await r.press("Show password");
  assert.equal(pw().props.secureTextEntry, false);
  assert.equal(pw2().props.secureTextEntry, true);
  await r.press("Show confirm password");
  assert.equal(pw2().props.secureTextEntry, false);
});

test("a server 409 turns into the existing-account answer with Sign in / Forgot password", async () => {
  answer = ((prev) => (path) =>
    path === "/v1/auth/email/register"
      ? { status: 409, body: { error: { code: "EMAIL_ALREADY_EXISTS", message: "An account already exists for this email." } } }
      : prev(path))(answer);
  const r = await render();
  await r.type("Email address", "new@example.com");
  await r.type("Password", PW);
  await r.type("Confirm password", PW);
  await r.press(CONSENT);
  await submit(r);
  await settle();
  assert.ok(r.hasText("An account already exists for this email. Sign in or reset your password instead."));
  assert.equal(r.byLabel("Forgot password?").length, 1);
});

test("success is the web's verify card: address, spam note, held Resend, Change email", async () => {
  const r = await render();
  await r.type("Email address", "new@example.com");
  await r.type("Password", PW);
  await r.type("Confirm password", PW);
  await r.press(CONSENT);
  await submit(r);
  await settle();
  assert.equal(r.byTestId("register-verify").length, 1);
  assert.ok(r.hasText("Verify your email"));
  assert.ok(r.hasText("Verify your email address"));
  assert.ok(r.hasText("We’ve sent a verification email to new@example.com. Please open the email and click the verification link to activate your PROOVRA account."));
  assert.ok(r.hasText("If you don’t see the email within a minute, check your spam folder. Verification links expire after 24 hours."));
  await r.press("Resend email");
  await settle();
  assert.deepEqual(posts.at(-1), { path: "/v1/auth/email/resend-verification", body: { email: "new@example.com" } });
  assert.ok(r.hasText("Verification email sent."));
  assert.ok(r.byLabel("Resend pending…")[0]?.props.accessibilityState?.disabled);
  await r.press("Change email");
  assert.equal(r.byTestId("register-verify").length, 0);
  assert.equal(r.byTestId("register-email")[0].props.value, "");
});
