/**
 * T-15 — contact-factor enrolment on Settings → Security. The step-up gate
 * sends its one-time code ONLY to an ACTIVE enrolled factor, and native had no
 * way to enrol one — so every step-up-dependent action was unreachable.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn, TEST_TEAM_ID } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};
let factors;

before(async () => {
  M = await loadModule("app/(stack)/settings/security.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  factors = [];
  routes = {
    ...authenticatedRoutes(),
    "/v1/identity/links": () => ({ status: 200, body: { passwordConfigured: true, usableMethods: 1, links: [] } }),
    "/v1/identity/mfa/factors": () => ({ status: 200, body: { hasMfa: false, factors: [], recoveryCodesRemaining: 0 } }),
    "/v1/identity-security/my-sessions": () => ({ status: 200, body: { sessions: [] } }),
    "/v1/identity-security/security-events": () => ({ status: 200, body: { events: [] } }),
    "/v1/identity-security/contact-factors/enroll/start": () => {
      factors = [{ factorId: "cf-1", kind: "SMS", label: "Work", destinationMask: "+44 •••• 123", status: "ENROLLING" }];
      return { status: 200, body: { factor: factors[0], verificationAttemptId: "att-1", codeExpiresAtUtc: new Date(Date.now() + 600000).toISOString() } };
    },
    "/v1/identity-security/contact-factors/enroll/verify": (m, body) => {
      if (body.code !== "123456") return { status: 400, body: { status: "denied" } };
      factors = [{ ...factors[0], status: "ACTIVE" }];
      return { status: 200, body: { factor: factors[0] } };
    },
    "/v1/identity-security/contact-factors/cf-1/revoke": () => {
      factors = [{ ...factors[0], status: "REVOKED" }];
      return { status: 200, body: {} };
    },
    "/v1/identity-security/contact-factors": () => ({ status: 200, body: { factors } }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ path, method, body });
    const key = routes[path] ? path : Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const out = key ? routes[key](method, body) : { status: 500, body: {} };
    // authenticatedRoutes() answers raw bodies; this file's own routes answer { status, body }.
    const wrapped = out && typeof out === "object" && "body" in out;
    return new Response(JSON.stringify(wrapped ? out.body : out), { status: wrapped ? out.status ?? 200 : 200, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  return r;
};

test("no device yet: enrol by SMS, verify the code, and only the MASK is ever shown", async () => {
  const r = await render();
  assert.ok(r.hasText("You have no verified device yet."));
  await r.type("Phone number", "letters");
  await r.press("Send verification code");
  assert.ok(r.hasText("A phone number can only contain digits"), "an invalid number reached the server");
  assert.ok(!requests.some((q) => q.path.endsWith("/enroll/start")), "an invalid number reached the server");
  // The field is now named with its error (ProovraFormField), as a screen reader hears it.
  await r.type("Phone number, A phone number can only contain digits, spaces, and the characters + ( ) - .", "+44 7700 900123");
  await r.type("Label (optional)", "Work");
  await r.press("Send verification code");
  await settle();
  const startReq = requests.find((q) => q.path.endsWith("/enroll/start"));
  assert.deepEqual(startReq.body, { teamId: TEST_TEAM_ID, channel: "SMS", destination: "+44 7700 900123", label: "Work" });
  assert.ok(r.hasText("A code was sent to +44 •••• 123."));
  await r.type("Verification code", "999999");
  await r.press("Verify and enrol");
  await settle();
  assert.ok(r.hasText("That code was not correct."));
  await r.type("Verification code", "123456");
  await r.press("Verify and enrol");
  await settle();
  const verifyReq = requests.filter((q) => q.path.endsWith("/enroll/verify")).at(-1);
  assert.deepEqual(verifyReq.body, { teamId: TEST_TEAM_ID, factorId: "cf-1", verificationAttemptId: "att-1", code: "123456" });
  assert.ok(r.hasText("Device enrolled. Codes for sensitive operations will be sent to +44 •••• 123."));
  assert.ok(!r.hasText("+44 7700 900123"), "the full number stayed on screen after enrolment");
  assert.ok(r.hasText("Active"));
});

test("resend is withheld during the cooldown", async () => {
  const r = await render();
  await r.type("Phone number", "+44 7700 900123");
  await r.press("Send verification code");
  await settle();
  assert.ok(r.byLabel("Resend code")[0].props.accessibilityState.disabled, "resend offered during the cooldown");
});

test("rate limiting and provider failure say so in the web's words", async () => {
  routes["/v1/identity-security/contact-factors/enroll/start"] = () => ({ status: 429, body: { error: { code: "rate_limited" } } });
  const r = await render();
  await r.type("Phone number", "+44 7700 900123");
  await r.press("Send verification code");
  await settle();
  assert.ok(r.hasText("Too many verification codes have been requested for this account recently."));
});

test("an active device can be revoked, and says what that blocks", async () => {
  factors = [{ factorId: "cf-1", kind: "SMS", label: "", destinationMask: "+44 •••• 123", status: "ACTIVE" }];
  const r = await render();
  assert.ok(r.byLabel("Replace this device").length === 1);
  await r.press("Revoke +44 •••• 123");
  await settle();
  assert.ok(requests.some((q) => q.method === "POST" && q.path === "/v1/identity-security/contact-factors/cf-1/revoke"));
  assert.ok(r.hasText("sensitive operations stay blocked until you enrol another device"));
});
