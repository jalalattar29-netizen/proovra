/**
 * MOBILE-007 — enrolling a factor during a sign-in the organization refused.
 *
 * The contract, from services/api/src/routes/auth.routes.ts and mfa.routes.ts:
 *   sign-in → 403 { mfaEnrollmentRequired: true, code: "MFA_ENROLLMENT_REQUIRED",
 *                   mfaEnrollmentToken, mfaEnrollmentExpiresInSeconds, ... }
 *   POST /v1/identity/mfa/enroll/start   (bearer: that token) → { factorId, otpauthUri, secretBase32 }
 *   POST /v1/identity/mfa/enroll/verify  (bearer: that token) → { factorId, recoveryCodes, mfaEnrollmentToken }
 *        400 { error: "code_invalid" } · 404 { error: "factor_not_enrolling" } · 429 { error: "rate_limited" }
 *   POST /v1/auth/mfa/enrollment/complete (bearer: the NEW token) → { token, user }
 *        409 { message: "mfa_factor_not_enrolled" } · 401 canonical
 *
 * Bodies below are what those handlers send. The screen runs the real sign-in
 * screen, the real apiFetch/publicFetch and the real AuthProvider.
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let Mfa;
let Auth;
let requests = [];
let routes;

const SECRET = "JBSWY3DPEHPK3PXP";
const OTPAUTH = `otpauth://totp/PROOVRA:a%40b.co?secret=${SECRET}&issuer=PROOVRA`;
const RECOVERY = ["ABCDE-FGHJK", "LMNPQ-RSTUV"];

const refusal = (extra = {}) => ({
  status: 403,
  body: {
    mfaRequired: true,
    mfaEnrollmentRequired: true,
    code: "MFA_ENROLLMENT_REQUIRED",
    mfaEnrollmentToken: "enrol-token-1",
    mfaEnrollmentExpiresInSeconds: 900,
    reason: "org_policy_requires_mfa",
    message: "Your organization requires multi-factor authentication. Please enroll an authenticator to continue.",
    user: { id: "u1", email: "a@b.co", provider: "EMAIL" },
    ...extra,
  },
});

const happyRoutes = () => ({
  "/v1/auth/email/login": () => refusal(),
  "/v1/identity/mfa/enroll/start": () => ({
    status: 200,
    body: { factorId: "factor-1", otpauthUri: OTPAUTH, secretBase32: SECRET },
  }),
  "/v1/identity/mfa/enroll/verify": () => ({
    status: 200,
    body: { factorId: "factor-1", recoveryCodes: RECOVERY, mfaEnrollmentToken: "enrol-token-proven" },
  }),
  "/v1/auth/mfa/enrollment/complete": () => ({
    status: 200,
    body: { token: "real-session", user: { id: "u1", email: "a@b.co" } },
  }),
  "/v1/users/legal-status": () => ({
    status: 200,
    body: { ok: true, missingPolicies: [], requiredVersions: {} },
  }),
});

before(async () => {
  const extras = ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/auth/mfa-enrollment-session.ts"];
  Mfa = await loadModule("app/(stack)/mfa.tsx", extras);
  Auth = await loadModule("app/(stack)/auth.tsx", extras);
});

beforeEach(async () => {
  await Mfa.deleteItemAsync("proovra-token");
  await Mfa.deleteItemAsync("proovra-auth-mode");
  requests = [];
  routes = happyRoutes();
  globalThis.__EXPO_PARAMS__ = {};
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const headers = new Headers(init.headers);
    requests.push({
      path,
      method: init.method ?? "GET",
      bearer: headers.get("authorization"),
      body: init.body ? JSON.parse(init.body) : null,
    });
    const route = routes[path];
    const a = route ? route() : { status: 200, body: {} };
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  };
  Mfa.calls.reset();
  Auth.calls.reset();
  Mfa.endMfaEnrollment();
  Auth.endMfaEnrollment();
});

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
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

const paths = () => requests.map((r) => r.path);
const enter = (token = "enrol-token-1", extra = {}) =>
  Mfa.holdMfaEnrollment({ token, mode: "email", expiresInSeconds: 900, ...extra });

const enrolScreen = async (token) => {
  enter(token);
  globalThis.__EXPO_PARAMS__ = { enroll: "1", mode: "email" };
  const r = await render(Mfa);
  return r;
};

test("a refused sign-in carries its token in memory, never in the route", async () => {
  const r = await render(Auth);
  await r.type("Email", "a@b.co");
  await r.type("Password", "Secret-password-1");
  await r.press("I agree to the Terms of Service, Privacy Policy and Cookie Policy");
  await r.press("Sign in with Email");
  await settle();
  const pushed = Auth.calls.push.at(-1);
  assert.deepEqual(pushed, { pathname: "/mfa", params: { enroll: "1", mode: "email" } });
  assert.ok(!JSON.stringify(Auth.calls.push).includes("enrol-token-1"), "the token must not ride in the route");
  assert.equal(Auth.currentMfaEnrollment()?.token, "enrol-token-1");
});

test("the enrolment token reaches no disk", async () => {
  const r = await enrolScreen();
  await r.type("Authenticator code", "123 456");
  await r.press("Verify and continue");
  await settle();
  for (const key of ["proovra-token", "proovra-auth-mode"]) {
    assert.equal(await Mfa.getItemAsync(key), null, `${key} must stay empty until a real session exists`);
  }
  // Nothing was written to AsyncStorage either: this module stores no keys.
  assert.equal(await Mfa.AsyncStorage.getItem("proovra.mfa-enrollment"), null);
});

test("the whole enrolment: setup key, code, recovery codes, then a real session", async () => {
  const r = await enrolScreen();

  // Set up with the sign-in token as the bearer, and nothing from the app's session.
  const start = requests.find((q) => q.path === "/v1/identity/mfa/enroll/start");
  assert.equal(start.bearer, "Bearer enrol-token-1");
  assert.equal(start.method, "POST");
  assert.ok(r.hasText("Set up two-factor authentication"));
  assert.ok(r.hasText(SECRET), "the setup key is on screen");

  await r.press("Open in authenticator");
  await settle();

  await r.type("Authenticator code", "123 456");
  await r.press("Verify and continue");
  await settle();

  const verify = requests.find((q) => q.path === "/v1/identity/mfa/enroll/verify");
  assert.equal(verify.bearer, "Bearer enrol-token-1");
  assert.deepEqual(verify.body, { factorId: "factor-1", code: "123456" });

  // The codes are on screen once, and nothing finishes until they are acknowledged.
  for (const code of RECOVERY) assert.ok(r.hasText(code), `recovery code ${code} is shown`);
  assert.ok(!paths().includes("/v1/auth/mfa/enrollment/complete"));
  assert.equal(Mfa.currentMfaEnrollment()?.token, "enrol-token-proven");
  assert.equal(r.byLabel("Done")[0].props.disabled ?? r.byLabel("Done")[0].props.accessibilityState?.disabled, true);

  const ack = r.byLabel("I saved these recovery codes in a safe place.").find((n) => n.props.onValueChange);
  await act(async () => { ack.props.onValueChange(true); });
  await r.press("Done");
  await settle();

  // Only the proving token can finish.
  const complete = requests.find((q) => q.path === "/v1/auth/mfa/enrollment/complete");
  assert.equal(complete.bearer, "Bearer enrol-token-proven");
  assert.equal(await Mfa.getItemAsync("proovra-token"), "real-session");
  assert.equal(Mfa.currentMfaEnrollment(), null, "the enrolment token ends with the sign-in");
  assert.equal(Mfa.calls.replace.at(-1), "/(tabs)");
});

test("a wrong code stays on the step; the factor is not restarted", async () => {
  routes["/v1/identity/mfa/enroll/verify"] = () => ({ status: 400, body: { error: "code_invalid" } });
  const r = await enrolScreen();
  await r.type("Authenticator code", "000000");
  await r.press("Verify and continue");
  await settle();
  assert.ok(r.hasText("That code did not match."));
  assert.equal(paths().filter((p) => p === "/v1/identity/mfa/enroll/start").length, 1);
  assert.ok(r.hasText(SECRET), "the same setup key is still shown");
});

test("the rate limit is said as a rate limit", async () => {
  routes["/v1/identity/mfa/enroll/verify"] = () => ({ status: 429, body: { error: "rate_limited", retryAfterMs: 60000 } });
  const r = await enrolScreen();
  await r.type("Authenticator code", "000000");
  await r.press("Verify and continue");
  await settle();
  assert.ok(r.hasText("Too many attempts."));
});

test("a factor that is gone gets a new setup key, and says why it changed", async () => {
  let started = 0;
  routes["/v1/identity/mfa/enroll/start"] = () => {
    started += 1;
    return { status: 200, body: { factorId: `factor-${started}`, otpauthUri: OTPAUTH, secretBase32: `${SECRET}${started}` } };
  };
  routes["/v1/identity/mfa/enroll/verify"] = () => ({ status: 404, body: { error: "factor_not_enrolling" } });
  const r = await enrolScreen();
  await r.type("Authenticator code", "000000");
  await r.press("Verify and continue");
  await settle();
  assert.equal(started, 2);
  assert.ok(r.hasText(`${SECRET}2`));
  assert.ok(r.hasText("This setup expired. Add this new key to your authenticator."));
});

test("an enrolment token the server stopped accepting ends the sign-in plainly", async () => {
  routes["/v1/identity/mfa/enroll/start"] = () => ({
    status: 401,
    body: { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
  });
  const r = await enrolScreen();
  assert.equal(r.byTestId("mfa-enroll-ended").length, 1);
  assert.equal(Mfa.currentMfaEnrollment(), null);
  await r.press("Return to sign in");
  assert.equal(Mfa.calls.replace.at(-1), "/(stack)/auth");
});

test("a start that fails on the network offers a retry, and the retry works", async () => {
  const real = globalThis.fetch;
  let failing = true;
  globalThis.fetch = async (url, init) => {
    if (failing) throw new TypeError("Network request failed");
    return real(url, init);
  };
  const r = await enrolScreen();
  assert.ok(r.hasText("Could not start setup. Check your connection and try again."));
  failing = false;
  await r.press("Try again");
  await settle();
  assert.ok(r.hasText(SECRET));
});

test("arriving with no token in memory (the app restarted) is the ended surface, not a code box", async () => {
  globalThis.__EXPO_PARAMS__ = { enroll: "1" };
  const r = await render(Mfa);
  assert.equal(r.byTestId("mfa-enroll-ended").length, 1);
  assert.equal(r.byLabel("Authenticator code").length, 0);
  assert.equal(requests.filter((q) => q.path.startsWith("/v1/identity/")).length, 0);
});

test("an expired enrolment token is dropped without a round trip", async () => {
  enter("enrol-token-1", { expiresInSeconds: -1 });
  globalThis.__EXPO_PARAMS__ = { enroll: "1" };
  const r = await render(Mfa);
  assert.equal(r.byTestId("mfa-enroll-ended").length, 1);
  assert.equal(requests.filter((q) => q.path.startsWith("/v1/identity/")).length, 0);
});

test("a failed finish can be retried with the same proving token, and the codes were already saved", async () => {
  let attempts = 0;
  routes["/v1/auth/mfa/enrollment/complete"] = () => {
    attempts += 1;
    return attempts === 1
      ? { status: 503, body: { error: { code: "SERVICE_UNAVAILABLE", message: "x" } } }
      : { status: 200, body: { token: "real-session", user: { id: "u1", email: "a@b.co" } } };
  };
  const r = await enrolScreen();
  await r.type("Authenticator code", "123456");
  await r.press("Verify and continue");
  await settle();
  const ack = r.byLabel("I saved these recovery codes in a safe place.").find((n) => n.props.onValueChange);
  await act(async () => { ack.props.onValueChange(true); });
  await r.press("Done");
  await settle();
  assert.ok(r.hasText("Could not finish signing in. Try again."));
  await r.press("Finish signing in");
  await settle();
  assert.equal(attempts, 2);
  assert.equal(await Mfa.getItemAsync("proovra-token"), "real-session");
});

test("a finish refused after the factor is active says the next sign-in asks for a code", async () => {
  routes["/v1/auth/mfa/enrollment/complete"] = () => ({
    status: 401,
    body: { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
  });
  const r = await enrolScreen();
  await r.type("Authenticator code", "123456");
  await r.press("Verify and continue");
  await settle();
  const ack = r.byLabel("I saved these recovery codes in a safe place.").find((n) => n.props.onValueChange);
  await act(async () => { ack.props.onValueChange(true); });
  await r.press("Done");
  await settle();
  assert.equal(r.byTestId("mfa-enroll-ended").length, 1);
  assert.ok(r.hasText("Your authenticator is set up. Sign in again and enter a code from it."));
  assert.equal(await Mfa.getItemAsync("proovra-token"), null);
});

test("leaving the screen forgets the token", async () => {
  const r = await enrolScreen();
  assert.equal(Mfa.currentMfaEnrollment()?.token, "enrol-token-1");
  mounted.pop();
  r.unmount();
  assert.equal(Mfa.currentMfaEnrollment(), null);
});

test("the ticked legal consent survives the enrolment detour", async () => {
  routes["/v1/users/legal-status"] = () => ({
    status: 200,
    body: { ok: false, missingPolicies: ["terms"], requiredVersions: { terms: "2026-01" } },
  });
  enter("enrol-token-1", { legalAcceptedSource: "login" });
  globalThis.__EXPO_PARAMS__ = { enroll: "1", mode: "email" };
  const r = await render(Mfa);
  await r.type("Authenticator code", "123456");
  await r.press("Verify and continue");
  await settle();
  const ack = r.byLabel("I saved these recovery codes in a safe place.").find((n) => n.props.onValueChange);
  await act(async () => { ack.props.onValueChange(true); });
  await r.press("Done");
  await settle();
  const accepted = requests.find((q) => q.path === "/v1/users/legal-acceptance");
  assert.deepEqual(accepted?.body, { source: "login", acceptances: [{ policyKey: "terms", policyVersion: "2026-01" }] });
});
