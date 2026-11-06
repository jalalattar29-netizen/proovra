/**
 * MOBILE-002 — Organization single sign-on on the sign-in screen.
 *
 * Server contract (services/api/src/routes/sso-auth.routes.ts):
 *   POST /v1/auth/sso/discover          200 { sso: false } | { sso: true, loginPath }
 *   GET  <loginPath>?native=1&codeChallenge=<S256>   (opened in the system browser)
 *        → proovra://sso/complete?code=<single use>  | ?error=<reason>
 *   POST /v1/auth/sso/native/exchange { code, codeVerifier }
 *        200 { token, user } | 200 { mfaRequired, mfaPendingToken } | 400 SSO_NATIVE_CODE_INVALID
 * The browser is scripted to answer as the callback does, and the exchange stub
 * checks the S256 proof exactly as sso-native-handoff.service.ts does.
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
const CONNECTION = "0f8e3c1a-5b2d-4e6f-9a7b-1c2d3e4f5a6b";
const consent = "I agree to the Terms of Service, Privacy Policy and Cookie Policy";
let M;
let Complete;
let posts;
let challenge;
let discovered;

before(async () => {
  M = await loadModule("app/(stack)/auth.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/auth/sso-native.ts"]);
  Complete = await loadModule("app/(stack)/sso-complete.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/auth/sso-native.ts"]);
});

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  posts = [];
  challenge = null;
  discovered = { sso: true, loginPath: `/v1/auth/sso/${CONNECTION}/initiate` };
  globalThis.__EXPO_PARAMS__ = {};
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const body = init.body ? JSON.parse(init.body) : null;
    if ((init.method ?? "GET") === "POST") posts.push({ path, body, auth: new Headers(init.headers).get("authorization") });
    if (path === "/v1/auth/sso/discover") return reply(200, discovered);
    if (path === "/v1/auth/sso/native/exchange") {
      const proof = createHash("sha256").update(body.codeVerifier, "ascii").digest("base64url");
      if (body.code !== "code-1" || proof !== challenge) return reply(400, { error: { code: "SSO_NATIVE_CODE_INVALID", message: "This sign-in has expired. Start again." } });
      return reply(200, { token: "sso-jwt", user: { id: "u-sso", email: "member@acme.example" } });
    }
    if (path === "/v1/auth/me") return reply(200, { user: { id: "u-sso", email: "member@acme.example" } });
    if (path === "/v1/users/legal-status") return reply(200, { ok: true, missingPolicies: [], requiredVersions: {} });
    return reply(200, {});
  };
  // The system browser: the callback answers with a code for the challenge it was given.
  globalThis.__AUTH_SESSION__ = async (url) => {
    challenge = new URL(url).searchParams.get("codeChallenge");
    return { type: "success", url: "proovra://sso/complete?code=code-1" };
  };
  M.calls.reset();
  return M.deleteItemAsync("proovra-token");
});
const mounted = [];
afterEach(() => {
  while (mounted.length) mounted.pop().unmount();
  delete globalThis.__AUTH_SESSION__;
});
const settle = async () => {
  for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async (Mod = M) => {
  const r = await renderComponent(h(Mod.TestProviders, null, h(Mod.default, {})));
  mounted.push(r);
  await settle();
  return r;
};
const ssoReady = async () => {
  const r = await render();
  await r.type("Email", "member@acme.example");
  await r.press(consent);
  return r;
};

test("MOBILE-002: the work email finds the Organization's sign-in, the browser opens it with a PKCE challenge, and the code is redeemed with the verifier", async () => {
  const r = await ssoReady();
  await r.press("Sign in with your organization (SSO)");
  await settle();
  assert.deepEqual(posts.find((p) => p.path === "/v1/auth/sso/discover").body, { email: "member@acme.example" });
  const opened = new URL(M.calls.openURL.at(-1));
  assert.equal(opened.pathname, `/v1/auth/sso/${CONNECTION}/initiate`);
  assert.equal(opened.searchParams.get("native"), "1");
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  const ex = posts.find((p) => p.path === "/v1/auth/sso/native/exchange");
  assert.ok(ex, "the code was never redeemed");
  assert.match(ex.body.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(ex.body.codeVerifier, challenge, "the verifier itself was sent to the browser");
  assert.ok(!M.calls.openURL.at(-1).includes(ex.body.codeVerifier), "the verifier left the app in a URL");
  assert.equal(await M.getItemAsync("proovra-token"), "sso-jwt");
  assert.equal(await M.getItemAsync("proovra-auth-mode"), "sso");
  assert.equal(M.calls.replace.at(-1), "/(tabs)");
});

test("an address with no SSO says so and opens nothing", async () => {
  discovered = { sso: false };
  const r = await ssoReady();
  await r.press("Sign in with your organization (SSO)");
  await settle();
  assert.ok(r.hasText("No single sign-on is set up for this email address."));
  assert.equal(M.calls.openURL.length, 0);
});

test("SSO needs the work email and the consent first, like every sign-in", async () => {
  const r = await render();
  await r.press("Sign in with your organization (SSO)");
  assert.ok(r.hasText("Enter your work email address to use single sign-on."));
  const r2 = await render();
  await r2.type("Email", "member@acme.example");
  await r2.press("Sign in with your organization (SSO)");
  assert.ok(r2.hasText("You must accept the Terms of Service"));
  assert.equal(posts.length, 0);
});

test("a refusal reported by the callback is said in words, and nothing is redeemed", async () => {
  globalThis.__AUTH_SESSION__ = async () => ({ type: "success", url: "proovra://sso/complete?error=seat_limit_reached" });
  const r = await ssoReady();
  await r.press("Sign in with your organization (SSO)");
  await settle();
  assert.ok(r.hasText("Your organization has no free seat for this sign-in."));
  assert.equal(posts.filter((p) => p.path === "/v1/auth/sso/native/exchange").length, 0);
});

test("closing the browser is a cancellation, not a failure", async () => {
  globalThis.__AUTH_SESSION__ = async () => ({ type: "cancel" });
  const r = await ssoReady();
  await r.press("Sign in with your organization (SSO)");
  await settle();
  assert.ok(r.hasText("Single sign-on was cancelled."));
  assert.equal(await M.getItemAsync("proovra-token"), null);
});

test("an MFA-protected SSO account goes on to its challenge", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/v1/auth/sso/native/exchange")) {
      return reply(200, { mfaRequired: true, mfaPendingToken: "pending-token-abcdefghijklmnop", user: { id: "u-sso" } });
    }
    return realFetch(url, init);
  };
  const r = await ssoReady();
  await r.press("Sign in with your organization (SSO)");
  await settle();
  assert.deepEqual(M.calls.push.at(-1), { pathname: "/mfa", params: { pendingToken: "pending-token-abcdefghijklmnop", mode: "sso" } });
  assert.equal(await M.getItemAsync("proovra-token"), null);
});

test("the deep-link landing redeems a return with the held verifier, and a second return finds nothing to redeem", async () => {
  await Complete.deleteItemAsync("proovra-token");
  const pair = await Complete.createPkcePair();
  challenge = pair.challenge;
  Complete.holdSsoVerifier(pair.verifier);
  globalThis.__EXPO_PARAMS__ = { code: "code-1" };
  await render(Complete);
  assert.equal(posts.filter((p) => p.path === "/v1/auth/sso/native/exchange").length, 1);
  assert.equal(await Complete.getItemAsync("proovra-token"), "sso-jwt");

  const again = await render(Complete);
  assert.equal(posts.filter((p) => p.path === "/v1/auth/sso/native/exchange").length, 1);
  assert.ok(again.hasText("This sign-in has expired. Start again from the sign-in screen."));
});

test("deep links: only proovra://sso/complete is the SSO return", () => {
  assert.deepEqual(M.ssoReturnRoute("proovra://sso/complete?code=abc"), { pathname: "/(stack)/sso-complete", params: { code: "abc" } });
  assert.deepEqual(M.ssoReturnRoute("proovra://sso/complete?error=x"), { pathname: "/(stack)/sso-complete", params: { error: "x" } });
  assert.equal(M.ssoReturnRoute("proovra://sso/completed?code=abc"), null);
  assert.equal(M.parseSsoDiscovery({ sso: true, loginPath: "https://evil.example/v1/auth/sso/x/initiate" }), null, "only the server's own routes are opened");
});
