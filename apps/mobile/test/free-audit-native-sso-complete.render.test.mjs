/**
 * SN-0080 /sso-complete (Free audit 0ea0, residual coverage §2.5; R1-G-002) —
 * the Organization SSO return when the platform delivers it as a deep link.
 *
 * Entry: proovra://sso/complete?code=|?error= → DeepLinkGate (ssoReturnRoute,
 * before the session branch) → router.push("/(stack)/sso-complete", { code | error }).
 * Public route (route-access.ts "sso-complete"). Server:
 *   POST /v1/auth/sso/native/exchange { code, codeVerifier }
 *        200 { token, user } | 200 { mfaRequired, … } | 400 SSO_NATIVE_CODE_INVALID
 *        | 403 SSO_SIGN_IN_REFUSED { reason } | 503 SSO_TEMPORARILY_UNAVAILABLE
 *   The code lives 2 minutes; the PKCE challenge (the attempt) 15 minutes
 *   (sso-native-handoff.service.ts NATIVE_SSO_CODE_TTL_MS / _CHALLENGE_TTL_MS).
 *
 * NAT-SSO-01 (R1-G-002, fail-first) — the PKCE verifier lived only in memory.
 * Android routinely kills an app while the system browser is in front; the
 * return then cold-starts the app, the verifier is gone, and a sign-in the
 * person just completed at their IdP ends in "This sign-in has expired". The
 * verifier is now also kept in the device's secure store for the attempt's
 * lifetime, spent once, and read back only by a process that did not start an
 * attempt itself (a cold start). "App kill" here is a fresh bundle of the
 * screen: new module state, the same secure store (expo-stub keeps it on
 * globalThis, as the keychain outlives the process).
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
const CONNECTION = "0f8e3c1a-5b2d-4e6f-9a7b-1c2d3e4f5a6b";
const consent = "I agree to the Terms of Service, Privacy Policy and Cookie Policy";
const KEY = "proovra-sso-verifier";
let posts;
let challenge;
const mounted = [];

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const extras = ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/auth/sso-native.ts"];
/** A fresh process: the screen's module graph loaded again, nothing in memory. */
const coldStart = () => loadModule("app/(stack)/sso-complete.tsx", extras);

beforeEach(async () => {
  posts = [];
  challenge = null;
  globalThis.__SECURE_STORE__?.clear();
  globalThis.__EXPO_PARAMS__ = {};
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const body = init.body ? JSON.parse(init.body) : null;
    if ((init.method ?? "GET") === "POST") posts.push({ path, body });
    if (path === "/v1/auth/sso/discover") return reply(200, { sso: true, loginPath: `/v1/auth/sso/${CONNECTION}/initiate` });
    if (path === "/v1/auth/sso/native/exchange") {
      const proof = createHash("sha256").update(body.codeVerifier, "ascii").digest("base64url");
      if (body.code !== "code-1" || proof !== challenge) return reply(400, { error: { code: "SSO_NATIVE_CODE_INVALID", message: "This sign-in has expired. Start again." } });
      return reply(200, { token: "sso-jwt", user: { id: "u-sso", email: "member@acme.example" } });
    }
    if (path === "/v1/auth/me") return reply(200, { user: { id: "u-sso", email: "member@acme.example" } });
    if (path === "/v1/users/legal-status") return reply(200, { ok: true, missingPolicies: [], requiredVersions: {} });
    return reply(200, {});
  };
});
afterEach(() => {
  while (mounted.length) mounted.pop().unmount();
  delete globalThis.__AUTH_SESSION__;
});
const settle = async (n = 10) => {
  for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async (Mod) => {
  const r = await renderComponent(h(Mod.TestProviders, null, h(Mod.default, {})));
  mounted.push(r);
  await settle();
  return r;
};
const exchanges = () => posts.filter((p) => p.path === "/v1/auth/sso/native/exchange");

/** Start SSO on the sign-in screen; the browser takes over and the app is killed behind it. */
async function startThenKill() {
  const Auth = await loadModule("app/(stack)/auth.tsx", extras);
  Auth.calls.reset();
  globalThis.__AUTH_SESSION__ = async (url) => {
    challenge = new URL(url).searchParams.get("codeChallenge");
    return new Promise(() => {}); // never answers: the process dies with the browser open
  };
  const r = await render(Auth);
  await r.type("Email", "member@acme.example");
  await r.press(consent);
  await r.press("Sign in with your organization (SSO)");
  await settle();
  assert.match(challenge ?? "", /^[A-Za-z0-9_-]{43}$/, "the browser was never opened");
  return Auth;
}

/* ---------------------------------------------- NAT-SSO-01 (fail-first) */

test("NAT-SSO-01 / R1-G-002 — app killed while the IdP was open: the cold-started return still completes the sign-in", async () => {
  const Auth = await startThenKill();
  const opened = Auth.calls.openURL.at(-1);
  const Complete = await coldStart();
  Complete.calls.reset();
  globalThis.__EXPO_PARAMS__ = { code: "code-1" };
  const r = await render(Complete);
  assert.equal(exchanges().length, 1, r.texts().join(" | "));
  const verifier = exchanges()[0].body.codeVerifier;
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!opened.includes(verifier), "the verifier left the app in a URL");
  assert.equal(await Complete.getItemAsync("proovra-token"), "sso-jwt");
  assert.equal(Complete.calls.replace.at(-1), "/(tabs)");
  assert.equal(await Complete.getItemAsync(KEY), null, "the verifier outlived its single use");
});

test("NAT-SSO-01 — the stored verifier is spent once: a second cold-start landing redeems nothing", async () => {
  await startThenKill();
  const Complete = await coldStart();
  globalThis.__EXPO_PARAMS__ = { code: "code-1" };
  await render(Complete);
  const again = await render(Complete);
  assert.equal(exchanges().length, 1);
  assert.ok(again.hasText("This sign-in has expired. Start again from the sign-in screen."));
});

test("NAT-SSO-01 — two landings racing in one cold-started process redeem once", async () => {
  await startThenKill();
  const Complete = await coldStart();
  globalThis.__EXPO_PARAMS__ = { code: "code-1" };
  const [a, b] = await Promise.all([
    renderComponent(h(Complete.TestProviders, null, h(Complete.default, {}))),
    renderComponent(h(Complete.TestProviders, null, h(Complete.default, {}))),
  ]);
  mounted.push(a, b);
  await settle();
  assert.equal(exchanges().length, 1);
});

test("NAT-SSO-01 — a verifier older than the attempt's lifetime is not used", async () => {
  await startThenKill();
  const raw = JSON.parse(globalThis.__SECURE_STORE__.get(KEY));
  globalThis.__SECURE_STORE__.set(KEY, JSON.stringify({ ...raw, expiresAt: Date.now() - 1 }));
  const Complete = await coldStart();
  globalThis.__EXPO_PARAMS__ = { code: "code-1" };
  const r = await render(Complete);
  assert.equal(exchanges().length, 0);
  assert.ok(r.hasText("This sign-in has expired. Start again from the sign-in screen."));
  assert.equal(await Complete.getItemAsync(KEY), null);
});

test("NAT-SSO-01 — a refusal returned after a cold start spends the stored verifier and redeems nothing", async () => {
  await startThenKill();
  const Complete = await coldStart();
  globalThis.__EXPO_PARAMS__ = { error: "jit_disabled" };
  const r = await render(Complete);
  assert.equal(exchanges().length, 0);
  assert.ok(r.hasText("You have not been added to this organization yet. Ask your administrator."));
  assert.equal(await Complete.getItemAsync(KEY), null);
});

/* --------------------------------------------- traced behaviour (pinned) */

test("trace: the warm path is unchanged — the auth session's return spends the in-memory verifier and clears the stored copy", async () => {
  const Auth = await loadModule("app/(stack)/auth.tsx", extras);
  Auth.calls.reset();
  globalThis.__AUTH_SESSION__ = async (url) => {
    challenge = new URL(url).searchParams.get("codeChallenge");
    return { type: "success", url: "proovra://sso/complete?code=code-1" };
  };
  const r = await render(Auth);
  await r.type("Email", "member@acme.example");
  await r.press(consent);
  await r.press("Sign in with your organization (SSO)");
  await settle();
  assert.equal(exchanges().length, 1);
  assert.equal(await Auth.getItemAsync(KEY), null);
  // The same process then receives the deep-link copy of the return: nothing to redeem.
  globalThis.__EXPO_PARAMS__ = { code: "code-1" };
  // (the landing in this process consults memory only — a store read is for cold starts)
  assert.equal(await Auth.takeSsoVerifierForReturn(), null);
});

test("trace: a cancelled browser clears the stored verifier", async () => {
  const Auth = await loadModule("app/(stack)/auth.tsx", extras);
  globalThis.__AUTH_SESSION__ = async (url) => {
    challenge = new URL(url).searchParams.get("codeChallenge");
    return { type: "cancel" };
  };
  const r = await render(Auth);
  await r.type("Email", "member@acme.example");
  await r.press(consent);
  await r.press("Sign in with your organization (SSO)");
  await settle();
  assert.ok(r.hasText("Single sign-on was cancelled."));
  assert.equal(await Auth.getItemAsync(KEY), null);
});

test("trace: a cold start with no attempt on record says the sign-in expired and redeems nothing", async () => {
  const Complete = await coldStart();
  Complete.calls.reset();
  globalThis.__EXPO_PARAMS__ = { code: "code-1" };
  const r = await render(Complete);
  assert.equal(exchanges().length, 0);
  assert.ok(r.hasText("This sign-in has expired. Start again from the sign-in screen."));
  await r.press("Back to sign in");
  assert.equal(Complete.calls.replace.at(-1), "/(stack)/auth");
});

test("trace: the stored record holds the verifier and its expiry only — never the code, the challenge or a token", async () => {
  await startThenKill();
  const raw = globalThis.__SECURE_STORE__.get(KEY);
  const rec = JSON.parse(raw);
  assert.deepEqual(Object.keys(rec).sort(), ["expiresAt", "verifier"]);
  assert.notEqual(rec.verifier, challenge);
  assert.ok(rec.expiresAt > Date.now() && rec.expiresAt <= Date.now() + 15 * 60 * 1000);
});

test("trace: the code is never rendered or logged", async () => {
  await startThenKill();
  const Complete = await coldStart();
  globalThis.__EXPO_PARAMS__ = { code: "code-1" };
  const logged = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => logged.push(a.map(String).join(" "));
  let r;
  try {
    r = await render(Complete);
  } finally {
    Object.assign(console, orig);
  }
  assert.ok(!r.texts().some((t) => t.includes("code-1")));
  assert.ok(!logged.some((l) => l.includes("code-1") || l.includes(exchanges()[0]?.body.codeVerifier ?? "\u0000")));
});
