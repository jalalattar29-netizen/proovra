/**
 * AUTH-LOCKOUT-NONTOTP — the native sign-in asks for the second factor the
 * person enrolled, the same as the web's /auth/mfa-challenge.
 *
 * Server contract (services/api/src/routes/auth.routes.ts):
 *   POST /v1/auth/mfa/methods   { mfaPendingToken, handoff: true }
 *        200 { methods, destinationMask, passkeyOptions: null, passkeyHandoffUrl }
 *   POST /v1/auth/mfa/send-code { mfaPendingToken }  200 { sent, channel, destinationMask }
 *   POST /v1/auth/mfa/verify    { mfaPendingToken, contactCode | passkeyHandoff: true | code | recoveryCode }
 *
 * A passkey is proved in the system browser (/auth/mfa-passkey); the app then
 * asks the server, which alone decides whether it was.
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let Mfa;
let Api;
let posts = [];
let answer;
const TOKEN = "pending-token-aaaaaaaaaaaa";
const HANDOFF = "https://app.proovra.test/auth/mfa-passkey#token=abc&return=app";

before(async () => {
  Mfa = await loadModule("app/(stack)/mfa.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
  Api = await loadModule("src/auth/auth-api.ts", []);
});
beforeEach(() => {
  posts = [];
  globalThis.__EXPO_PARAMS__ = { pendingToken: TOKEN };
  delete globalThis.__AUTH_SESSION__;
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
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const mounted = [];
const render = async () => {
  const r = await renderComponent(h(Mfa.TestProviders, null, h(Mfa.default, {})));
  mounted.push(r);
  await settle();
  return r;
};
afterEach(() => {
  while (mounted.length) mounted.pop().unmount();
});
const to = (p) => posts.filter((x) => x.path === p);

test("a phone-only account is offered a code to its phone, and the code completes the sign-in", async () => {
  answer = (p) =>
    p === "/v1/auth/mfa/methods"
      ? { status: 200, body: { methods: ["SMS"], destinationMask: "+1 •••• 1234", passkeyOptions: null, passkeyHandoffUrl: null } }
      : p === "/v1/auth/mfa/send-code"
        ? { status: 200, body: { sent: true, channel: "SMS", destinationMask: "+1 •••• 1234" } }
        : p === "/v1/auth/mfa/verify"
          ? { status: 401, body: { message: "mfa_invalid" } }
          : { status: 200, body: {} };
  const r = await render();
  assert.deepEqual(to("/v1/auth/mfa/methods")[0].body, { mfaPendingToken: TOKEN, handoff: true });
  await r.press("Send code");
  await settle();
  assert.ok(r.hasText("We sent a code to +1 •••• 1234."));
  assert.equal(to("/v1/auth/mfa/verify").length, 0);
  await r.type("Code sent to your phone", "482 913");
  await r.press("Verify and continue");
  await settle();
  assert.deepEqual(to("/v1/auth/mfa/verify")[0].body, { mfaPendingToken: TOKEN, contactCode: "482913" });
  assert.ok(r.hasText("That code did not match. Check the latest message and try again, or send a new code."));
});

test("a passkey-only account proves its passkey in the system browser, then the server is asked", async () => {
  answer = (p) =>
    p === "/v1/auth/mfa/methods"
      ? { status: 200, body: { methods: ["PASSKEY"], destinationMask: null, passkeyOptions: null, passkeyHandoffUrl: HANDOFF } }
      : p === "/v1/auth/mfa/verify"
        ? { status: 401, body: { message: "mfa_invalid" } }
        : { status: 200, body: {} };
  let opened = null;
  globalThis.__AUTH_SESSION__ = async (url, returnUrl) => {
    opened = { url, returnUrl };
    return { type: "success", url: `${returnUrl}?result=approved` };
  };
  const r = await render();
  await r.press("Continue with passkey");
  await settle();
  assert.deepEqual(opened, { url: HANDOFF, returnUrl: "proovra://sign-in/passkey-complete" });
  assert.deepEqual(to("/v1/auth/mfa/verify")[0].body, { mfaPendingToken: TOKEN, passkeyHandoff: true });
  // The browser said "approved", but only the server decides: refused here, so the app says so.
  assert.ok(r.hasText("Your passkey wasn't confirmed. Try again, or choose another way to sign in."));
});

test("the return link and the methods parser accept only what they should", () => {
  assert.equal(Api.isSignInPasskeyReturn("proovra://sign-in/passkey-complete?result=approved"), true);
  assert.equal(Api.isSignInPasskeyReturn("proovra://sign-in/passkey-completed"), false);
  assert.equal(Api.parseSignInMethods({ methods: ["NOPE"] }), null);
  assert.deepEqual(Api.parseSignInMethods({ methods: ["TOTP", "X", "SMS"], destinationMask: 7, passkeyHandoffUrl: "http://x" }), {
    methods: ["TOTP", "SMS"],
    destinationMask: null,
    passkeyHandoffUrl: null,
  });
});
