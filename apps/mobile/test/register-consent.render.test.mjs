/**
 * T-14 — register (page.tsx:1362 Password strength, :1483 "Passwords do not
 * match.", :1518 Terms of Service, :1534 Cookie Policy). Native had one
 * password entry, a plain "you agree to the Terms and Privacy Policy" sentence
 * with no links and no Cookie Policy, and no consent step: an account (email
 * or Google/Apple) was created without it. The web gates all three on the box.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let M;
let posts = [];
const PW = "Abcdefghijk1!";
const LEGAL = "You must accept the Terms of Service, Privacy Policy, and Cookie Policy to create an account.";

before(async () => {
  M = await loadModule("app/(stack)/register.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/auth/email-availability.ts"]);
});
beforeEach(() => {
  posts = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (init.method === "POST") posts.push(path);
    const body = path.startsWith("/v1/auth/email/availability") ? { available: true } : { email: "new@example.com" };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
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
// register/page.tsx:1513 — the email CTA reads "Create account with Email"; the
// field label is "Email address" (:1109).
const create = (r) => r.byLabel("Create account with Email").find((n) => n.props.onPress);
const fill = async (r, confirm = PW) => {
  await r.type("Email address", "new@example.com");
  await r.type("Password", PW);
  await r.type("Confirm password", confirm);
};

// The web keeps the CTA enabled and answers on submit (register/page.tsx:809-812):
// the mismatch is said live, and a submit is refused without any request.
test("a mismatched confirmation is said and cannot be submitted", async () => {
  const r = await render();
  await fill(r, `${PW}x`);
  assert.ok(r.hasText("Passwords do not match."));
  await r.press("I agree to the Terms of Service, Privacy Policy and Cookie Policy");
  await act(async () => { await create(r).props.onPress(); });
  assert.equal(posts.includes("/v1/auth/email/register"), false);
  assert.equal(r.byTestId("register-error").length, 1);
});

test("no account without consent — email or Google", async () => {
  const r = await render();
  await fill(r);
  await act(async () => { await create(r).props.onPress(); });
  await settle();
  assert.ok(r.hasText(LEGAL), "the consent refusal was not said");
  assert.equal(posts.includes("/v1/auth/email/register"), false, "an account was requested without consent");
  r.unmount();
  const g = await render();
  await g.press("Continue with Google");
  assert.ok(g.hasText(LEGAL), "Google sign-up proceeded without consent");
});

test("with consent the account is requested; each policy opens in the reader", async () => {
  const r = await render();
  await fill(r);
  await r.press("I agree to the Terms of Service, Privacy Policy and Cookie Policy");
  await act(async () => { await create(r).props.onPress(); });
  await settle();
  assert.ok(posts.includes("/v1/auth/email/register"));
  r.unmount();
  const l = await render();
  for (const [word, path] of [["Terms of Service", "/legal/terms"], ["Privacy Policy", "/legal/privacy"], ["Cookie Policy", "/legal/cookies"]]) {
    await l.press(word);
    assert.equal(M.calls.push.at(-1), path);
  }
});

test("the strength caption is shown, as on the web", async () => {
  const r = await render();
  await r.type("Password", PW);
  assert.ok(r.hasText("Password strength"));
  assert.ok(r.hasText("Strong"));
});
