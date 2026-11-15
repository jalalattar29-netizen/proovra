/**
 * B-23 — the native Google nonce is not used after it has grown old.
 *
 * `useOAuth` fetched the PRO-034 nonce once on mount and kept it. The API keeps
 * a nonce for 10 minutes, so the first tap on a sign-in screen left open (or an
 * app brought back from the background) sent an expired nonce and the exchange
 * failed. The hook now replaces a nonce older than OAUTH_NONCE_FRESH_MS on a
 * schedule, on return to the foreground, and at the tap itself.
 *
 * The REAL hook runs; the Google request (expo-auth-session) and the API are
 * doubles. Time is moved by replacing Date.now.
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let M;
let hook;
let nonceCalls = 0;
const realNow = Date.now;
let shift = 0;

before(async () => {
  M = await loadModule("src/auth/use-oauth.ts", []);
});
beforeEach(() => {
  nonceCalls = 0;
  shift = 0;
  Date.now = () => realNow() + shift;
  globalThis.__RN_OS__ = "ios";
  process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID = "ios-client.apps.googleusercontent.com";
  globalThis.__GOOGLE_AUTH__ = { configs: [], prompts: [] };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (init.method === "POST" && path === "/v1/auth/oauth/nonce") {
      nonceCalls += 1;
      return new Response(JSON.stringify({ nonce: `nonce-${nonceCalls}` }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
  };
});
afterEach(() => {
  Date.now = realNow;
  delete globalThis.__GOOGLE_AUTH__;
  delete process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
});

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
function Probe() {
  hook = M.useOAuth({ onResult: () => {} });
  return null;
}
const lastPromptNonce = () => globalThis.__GOOGLE_AUTH__.prompts.at(-1)?.extraParams?.nonce;

test("the freshness rule: younger than five minutes only", () => {
  assert.equal(M.OAUTH_NONCE_FRESH_MS, 5 * 60 * 1000);
  assert.equal(M.oauthNonceIsFresh(null, 1000), false);
  assert.equal(M.oauthNonceIsFresh(0, M.OAUTH_NONCE_FRESH_MS - 1), true);
  assert.equal(M.oauthNonceIsFresh(0, M.OAUTH_NONCE_FRESH_MS), false);
});

test("an old nonce is replaced at the tap, never sent; the next tap carries the fresh one", async () => {
  const r = await renderComponent(h(Probe));
  await settle();
  assert.equal(nonceCalls, 1);
  assert.equal(hook.googleReady, true);

  await act(async () => hook.promptGoogle());
  assert.equal(globalThis.__GOOGLE_AUTH__.prompts.length, 1);
  assert.equal(lastPromptNonce(), "nonce-1");

  // Eleven minutes later (a screen left open; timers suspended in the background).
  shift = 11 * 60 * 1000;
  await act(async () => hook.promptGoogle());
  assert.equal(globalThis.__GOOGLE_AUTH__.prompts.length, 1, "the expired nonce was sent to Google");
  await settle();
  assert.equal(nonceCalls, 2);
  assert.equal(hook.googleReady, true);
  await act(async () => hook.promptGoogle());
  assert.equal(globalThis.__GOOGLE_AUTH__.prompts.length, 2);
  assert.equal(lastPromptNonce(), "nonce-2");
  r.unmount();
});

test("coming back to the foreground with an old nonce fetches a new one", async () => {
  const r = await renderComponent(h(Probe));
  await settle();
  assert.equal(nonceCalls, 1);
  shift = 7 * 60 * 1000;
  await act(async () => globalThis.__emitAppState("active"));
  await settle();
  assert.equal(nonceCalls, 2);
  // A fresh nonce is left alone.
  await act(async () => globalThis.__emitAppState("active"));
  await settle();
  assert.equal(nonceCalls, 2);
  r.unmount();
});
