/**
 * T-14 — reset-password (page.tsx:497 Confirm new password, :607 Back to sign
 * in, :729 expired-link state). Native had one password field (a mistype was
 * never caught), no way back to sign in, and showed an invalid or expired
 * token as a raw inline error instead of the web's Request-new-link card.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let M;
let reply = null;
let posts = [];
const PW = "Abcdefghijk1!";

before(async () => {
  M = await loadModule("app/(stack)/reset-password.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(() => {
  posts = [];
  reply = { status: 200, body: { ok: true } };
  globalThis.__EXPO_PARAMS__ = { token: "tok-1" };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (init.method === "POST") posts.push({ path, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  };
  M.calls.reset();
});
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  return r;
};
// reset-password/page.tsx:589-600 — the CTA is "Reset password"; it stays enabled
// and answers on submit, as the web does.
const submitNode = (r) => r.byLabel("Reset password").find((n) => n.props.onPress);

test("a mistyped confirmation is caught and never sent", async () => {
  const r = await render();
  await r.type("New password", PW);
  await r.type("Confirm new password", `${PW}x`);
  assert.ok(r.hasText("Passwords don’t match."));
  await act(async () => { await submitNode(r).props.onPress(); });
  assert.equal(posts.length, 0, "a mismatch was sent");
  assert.ok(r.hasText("Passwords do not match."));
  await r.type("Confirm new password", PW);
  await act(async () => { await submitNode(r).props.onPress(); });
  await settle();
  assert.deepEqual(posts.map((p) => p.path), ["/v1/auth/password-reset/confirm"]);
  assert.equal(posts[0].body.newPassword, PW);
  // The web's SuccessCard (reset-password/page.tsx:640-668).
  assert.ok(r.hasText("Password updated"));
  assert.ok(r.hasText("You can now sign in with your new password."));
});

test("a link with no token is the expired-link card at once, never a form", async () => {
  globalThis.__EXPO_PARAMS__ = {};
  const r = await render();
  assert.equal(r.byTestId("reset-link-expired").length, 1);
  assert.ok(r.hasText("Reset link expired"));
  assert.equal(r.byLabel("New password").length, 0);
});

test("the web card head, show/hide on both fields, and failed rules after a refused submit", async () => {
  const r = await render();
  assert.ok(r.hasText("Password Access"));
  assert.ok(r.hasText("Create a new password"));
  assert.ok(r.hasText("Choose a strong password to secure your PROOVRA account."));
  await r.press("Show password");
  assert.equal(r.byTestId("reset-new")[0].props.secureTextEntry, false);
  await r.press("Show confirm password");
  assert.equal(r.byTestId("reset-confirm")[0].props.secureTextEntry, false);
  await r.type("New password", "short");
  await act(async () => { await submitNode(r).props.onPress(); });
  assert.ok(r.hasText("Your password does not meet the requirements listed below the password field."));
  assert.ok(r.texts().some((s) => s.startsWith("✕ ")));
  assert.equal(posts.length, 0);
});

test("an expired or invalid token lands on the Request-new-link card", async () => {
  reply = { status: 400, body: { message: "invalid_or_expired" } };
  const r = await render();
  await r.type("New password", PW);
  await r.type("Confirm new password", PW);
  await act(async () => { await submitNode(r).props.onPress(); });
  await settle();
  assert.equal(r.byTestId("reset-link-expired").length, 1, "the expired-link state was not shown");
  assert.ok(r.hasText("This password reset link is invalid or has expired. Request a new reset link to continue."));
  await r.press("Request new link");
  assert.equal(M.calls.replace.at(-1), "/(stack)/forgot-password");
});

test("other failures say so in the web's words; Back to sign in is on the form", async () => {
  reply = { status: 400, body: { message: "weak_new_password" } };
  const r = await render();
  await r.type("New password", PW);
  await r.type("Confirm new password", PW);
  await act(async () => { await submitNode(r).props.onPress(); });
  await settle();
  assert.ok(r.hasText("We couldn’t reset your password right now. Please try again."));
  await r.press("Back to sign in");
  assert.equal(M.calls.replace.at(-1), "/(stack)/auth");
});
