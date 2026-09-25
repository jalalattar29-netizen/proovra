/**
 * T-14 — auth dead ends native left (auth/mfa-challenge/page.tsx:300 Return
 * to sign in; auth/verify-email/page.tsx:364 Email address, :424 Email sent).
 * An expired MFA challenge said "sign in again" with no way there; a failed
 * verification link offered no resend, and a resend said nothing.
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let Mfa;
let Verify;
let answer = null;
let posts = [];

before(async () => {
  Mfa = await loadModule("app/(stack)/mfa.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
  Verify = await loadModule("app/(stack)/verify-email.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(() => {
  posts = [];
  answer = () => ({ status: 200, body: {} });
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (init.method === "POST") posts.push({ path, body: init.body ? JSON.parse(init.body) : null });
    const a = answer(path);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  };
  Mfa.calls.reset();
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
// Unmount every screen so its timers (the 60s resend hold) die with it.
afterEach(() => {
  while (mounted.length) mounted.pop().unmount();
});

test("an expired MFA challenge ends with Return to sign in", async () => {
  globalThis.__EXPO_PARAMS__ = { pendingToken: "pt-1" };
  // auth.routes.ts: 401 { message: "mfa_challenge_expired" }.
  answer = (p) => (p === "/v1/auth/mfa/verify" ? { status: 401, body: { message: "mfa_challenge_expired" } } : { status: 200, body: {} });
  const r = await render(Mfa);
  await r.type("Six-digit authenticator code", "123456");
  await r.press("Verify and continue");
  await settle();
  assert.equal(r.byTestId("mfa-expired").length, 1);
  assert.ok(r.hasText("Your two-factor challenge expired. Please sign in again to start a fresh challenge."));
  await r.press("Return to sign in");
  assert.equal(Mfa.calls.replace.at(-1), "/(stack)/auth");
});

test("a wrong code stays on the challenge with the web's words", async () => {
  globalThis.__EXPO_PARAMS__ = { pendingToken: "pt-1" };
  answer = (p) => (p === "/v1/auth/mfa/verify" ? { status: 401, body: { message: "mfa_invalid" } } : { status: 200, body: {} });
  const r = await render(Mfa);
  await r.type("Six-digit authenticator code", "000000");
  await r.press("Verify and continue");
  await settle();
  assert.equal(r.byTestId("mfa-expired").length, 0);
  assert.ok(r.hasText("That code did not match. Check the timer on your authenticator and try again."));
});

test("a dead verification link offers a fresh one, and says when it was sent", async () => {
  globalThis.__EXPO_PARAMS__ = { token: "vt-1" };
  answer = (p) => (p === "/v1/auth/email/verify" ? { status: 400, body: { message: "invalid_or_expired" } } : { status: 200, body: { ok: true } });
  const r = await render(Verify);
  assert.equal(r.byTestId("verify-invalid").length, 1);
  await r.type("Email address", "  me@example.com ");
  await r.press("Resend verification email");
  await settle();
  assert.deepEqual(posts.find((p) => p.path === "/v1/auth/email/resend-verification").body, { email: "me@example.com" });
  assert.ok(r.hasText("Check your inbox"));
});

test("a failed resend is Retry needed, with the form still there", async () => {
  // A dead token (the verify read fails too) — an ABSENT token is the missing-token card, below.
  globalThis.__EXPO_PARAMS__ = { token: "vt-dead" };
  answer = () => ({ status: 503, body: { message: "down" } });
  const r = await render(Verify);
  await r.type("Email address", "me@example.com");
  await r.press("Resend verification email");
  await settle();
  assert.ok(r.hasText("We couldn’t send the email"));
  assert.ok(r.byLabel("Email address").length >= 1);
});

test("no token is the web's missing-token card, with no resend form (verify-email/page.tsx:333)", async () => {
  globalThis.__EXPO_PARAMS__ = {};
  const r = await render(Verify);
  assert.equal(r.byTestId("verify-missing-token").length, 1);
  assert.ok(r.hasText("Missing token") && r.hasText("Verification link not recognised"));
  assert.ok(r.hasText("Open the verification link directly from your email. If you no longer have it, you can request a new one from the sign-in page."));
  assert.equal(r.byLabel("Email address").length, 0, "a missing token offered the dead-link resend form");
  assert.ok(r.byLabel("Back to sign in").length >= 1);
});

test("a good link shows Email verified with Continue to PROOVRA before moving on (:320, :324)", async () => {
  globalThis.__EXPO_PARAMS__ = { token: "vt-good" };
  answer = (p) => (p === "/v1/auth/email/verify" ? { status: 200, body: { token: "sess-1", user: { id: "u1", email: "me@example.com" } } } : { status: 200, body: {} });
  const r = await render(Verify);
  assert.equal(r.byTestId("verify-success").length, 1, r.texts().join(" | "));
  assert.ok(r.hasText("Email verified"));
  assert.ok(r.hasText("Your account has been successfully verified. You’ll land in your PROOVRA workspace in a moment."));
  assert.ok(r.byLabel("Continue to PROOVRA").length >= 1);
});
