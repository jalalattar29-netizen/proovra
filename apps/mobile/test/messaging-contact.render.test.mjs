/**
 * T-15 — Messaging contact on Settings → Notifications
 * (/v1/communications/verify/start, verify/check, preferences). Native had no
 * way to verify an SMS/WhatsApp delivery destination or record its preference.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn, TEST_TEAM_ID } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};

before(async () => {
  M = await loadModule("app/(stack)/settings/notifications.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(async () => {
  requests = [];
  routes = {
    ...authenticatedRoutes(),
    "/v1/me/notification-preferences": () => ({ status: 200, body: { preferences: [] } }),
    "/v1/me/notification-schedule": () => ({ status: 200, body: {} }),
    "/v1/communications/verify/start": () => ({
      status: 200,
      body: { status: "started", attempt: { id: "att-1", channel: "SMS", status: "PENDING", recipientPreview: "+44 •••• 000", checkAttemptCount: 0, expiresAtUtc: null } },
    }),
    "/v1/communications/verify/check": (m, body) =>
      body.code === "123456" ? { status: 200, body: { status: "approved", verificationId: "att-1" } } : { status: 400, body: { status: "denied" } },
    "/v1/communications/preferences": (m, body) => ({
      status: 200,
      body: { preference: { smsOptOut: body.smsOptOut ?? false, whatsappOptOut: false, preferredChannel: body.preferredChannel ?? null, updatedAt: "2026-09-24T10:00:00.000Z" } },
    }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ path, method, body });
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    const out = key ? routes[key](method, body) : { status: 500, body: {} };
    const wrapped = out && typeof out === "object" && "body" in out && "status" in out && typeof out.status === "number";
    return new Response(JSON.stringify(wrapped ? out.body : out), { status: wrapped ? out.status : 200, headers: { "content-type": "application/json" } });
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
const disabled = (r, label) => r.byLabel(label)[0].props.accessibilityState?.disabled === true;

test("verify a number: the server alone decides, then the preference is recorded", async () => {
  const r = await render();
  assert.ok(r.hasText("Messaging contact"));
  assert.ok(disabled(r, "Send verification code"), "send offered before a number was typed");
  await r.type("Mobile number", "+44 7700 900000");
  await r.press("Send verification code");
  await settle();
  const start = requests.find((q) => q.path === "/v1/communications/verify/start");
  assert.deepEqual(start.body, { teamId: TEST_TEAM_ID, channel: "SMS", phone: "+44 7700 900000", purpose: "OTP" });
  assert.ok(r.hasText("Code sent to +44 •••• 000."));
  await r.type("Verification code", "999999");
  await r.press("Confirm code");
  await settle();
  assert.ok(r.hasText("That code was not accepted. Codes expire quickly and can only be used once — request a new one."));
  assert.ok(r.byLabel("Allow messages").length === 0, "a denied code reached the verified state");
  await r.type("Verification code", "123456");
  await r.press("Confirm code");
  await settle();
  assert.ok(r.hasText("Contact confirmed (+44 •••• 000)."));
  await r.press("Allow messages");
  await settle();
  const pref = requests.find((q) => q.path === "/v1/communications/preferences");
  assert.deepEqual(pref.body, { teamId: TEST_TEAM_ID, target: { kind: "contact", phone: "+44 7700 900000" }, smsOptOut: false, preferredChannel: "SMS" });
  assert.ok(r.hasText("Messaging preference saved for this contact."));
  assert.ok(r.hasText("Saved preference — SMS: allowed; WhatsApp: allowed; preferred: SMS."));
});

test("rate limiting is a 200 verdict, shown as its own state — not success, not failure", async () => {
  routes["/v1/communications/verify/start"] = () => ({ status: 200, body: { status: "rate_limited" } });
  const r = await render();
  await r.type("Mobile number", "+44 7700 900000");
  await r.press("Send verification code");
  await settle();
  assert.ok(r.hasText("Too many verification attempts for this number."));
  assert.ok(!r.hasText("Code sent to"));
});

test("messaging provider not configured / invalid number say so", async () => {
  routes["/v1/communications/verify/start"] = () => ({ status: 503, body: { error: { code: "feature_disabled" } } });
  const r = await render();
  await r.type("Mobile number", "+44 7700 900000");
  await r.press("Send verification code");
  await settle();
  assert.ok(r.hasText("Message verification is not enabled for this environment yet. Ask your administrator to configure a messaging provider."));
});

test("opting in without server verification is refused in words (409 contact_not_verified)", async () => {
  routes["/v1/communications/preferences"] = () => ({ status: 409, body: { error: { code: "contact_not_verified" } } });
  const r = await render();
  await r.type("Mobile number", "+44 7700 900000");
  await r.press("Send verification code");
  await settle();
  await r.type("Verification code", "123456");
  await r.press("Confirm code");
  await settle();
  await r.press("Allow messages");
  await settle();
  assert.ok(r.hasText("This contact has not completed verification, so messaging cannot be enabled for it yet."));
  assert.ok(!r.hasText("Saved preference"));
});

test("no active workspace, once the context has answered, is the web's sentence — not an endless spinner (NotificationsSection :25)", async () => {
  routes["/v1/platform/context"] = () => ({ activeSpace: null, personalSpaceAllowed: true });
  const r = await render();
  assert.equal(r.byTestId("notifications-no-workspace").length, 1, r.texts().join(" | "));
  assert.ok(r.hasText("Select a workspace to manage its notification preferences."));
});
