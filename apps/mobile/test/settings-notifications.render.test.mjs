/**
 * WEB PARITY — Settings › Notifications
 * (components/notifications/NotificationPreferencesPanel.tsx: the panel and
 * NotificationScheduleCard).
 *
 * Stubs are the server's real replies:
 *   GET /v1/me/notification-preferences  notification-preferences.routes.ts:243-265
 *   GET /v1/me/notification-schedule     → { schedule } (…routes.ts:408), or 503
 *                                          { error: { code: "notification_schedule_unavailable" } } (…:398)
 *   GET /v1/users/me                     users.routes.ts pickMe → { user: { timezone } }
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn, TEST_TEAM_ID } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};
const mounted = [];

const TYPES = ["MENTION", "ASSIGNED_THREAD", "REVIEWER_ASSIGNMENT", "ESCALATION", "SLA_NEAR_BREACH", "EVIDENCE_REQUEST_UPDATE", "GOVERNANCE_UPDATE"];
const PREFS = (over = {}) => ({
  teamId: TEST_TEAM_ID,
  preferences: [],
  lockedTypes: ["SLA_NEAR_BREACH", "GOVERNANCE_UPDATE"],
  emailLockedTypes: [],
  minimumFrequencyByType: {},
  organizationId: "org-1",
  canManageOrgPolicy: false,
  isPersonalWorkspace: false,
  catalog: {
    preferenceTypes: TYPES,
    channels: ["IN_APP", "EMAIL"],
    frequencies: ["IMMEDIATE", "HOURLY", "DAILY", "WEEKLY", "OFF"],
    defaults: { IN_APP: true, EMAIL: false, frequency: "IMMEDIATE" },
  },
  ...over,
});
const SCHEDULE = (over = {}) => ({
  schedule: { teamId: TEST_TEAM_ID, timezone: null, quietHoursEnabled: true, quietStartMinute: 1320, quietEndMinute: 420, quietCriticalOverride: true, updatedAt: null, ...over },
});

before(async () => {
  M = await loadModule("app/(stack)/settings/notifications.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});

beforeEach(async () => {
  while (mounted.length) mounted.pop().unmount();
  requests = [];
  routes = {
    ...authenticatedRoutes(),
    "/v1/me/notification-preferences": () => ({ status: 200, body: PREFS() }),
    "/v1/me/notification-schedule": () => ({ status: 200, body: SCHEDULE() }),
    "/v1/users/me": () => ({ status: 200, body: { user: { id: "user-1", timezone: "Europe/Berlin" } } }),
    "/v1/communications": () => ({ status: 200, body: {} }),
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
  mounted.push(r);
  await settle();
  return r;
};

test("parity: the web's intro and legend", async () => {
  const r = await render();
  assert.ok(r.hasText("Operational notifications for this workspace. In-app delivery is enabled by default; email is opt-in. Toggling here is audited."));
  assert.ok(r.hasText(" — what appears in your bell and Operations Center."));
  assert.ok(r.hasText("Critical evidence-integrity alerts always remain enabled in-app."));
});

test("parity: categories in the web's groups, with its labels and help lines", async () => {
  const r = await render();
  for (const g of ["Evidence integrity & verification", "Reviews & quality", "Secure intake", "Collaboration", "Governance & retention"]) {
    assert.ok(r.hasText(g), `missing group: ${g}`);
  }
  assert.ok(r.hasText("Evidence integrity & verification failures"), "SLA_NEAR_BREACH is the integrity-failure category");
  assert.ok(r.hasText("Notified when an escalation is routed to you."));
});

test("parity: a platform in-app lock says why; the organization legend only appears for a real org lock", async () => {
  const r = await render();
  assert.ok(r.hasText("Required for evidence integrity — always shown in the app"));
  assert.ok(r.hasText("Required governance duty — always shown in the app"));
  assert.equal(r.byTestId("notification-org-policy-legend").length, 0, "platform duties are not organization policy");

  routes["/v1/me/notification-preferences"] = () => ({ status: 200, body: PREFS({ emailLockedTypes: ["ESCALATION"] }) });
  const r2 = await render();
  assert.ok(r2.byTestId("notification-org-policy-legend").length > 0);
  assert.ok(r2.hasText("Managed by your organization — email delivery is required."));
});

test("parity: quiet hours & timezone — inherit vs override, the effective zone, the window and the critical override", async () => {
  const r = await render();
  assert.ok(r.hasText("Quiet hours & timezone"));
  assert.ok(r.byLabel("Use account timezone — Europe/Berlin").length > 0, r.texts().join(" | "));
  assert.ok(r.hasText("Europe/Berlin"), "the effective timezone is not stated");
  assert.ok(r.hasText("22:00") && r.hasText("07:00"));
  assert.ok(r.byLabel("Allow critical notifications during quiet hours").length > 0);

  await r.press("Quiet hours start later");
  const put = requests.filter((q) => q.method === "PUT" && q.path === "/v1/me/notification-schedule").pop();
  assert.ok(put, "moving the window saved nothing");
  assert.deepEqual(put.body, { teamId: TEST_TEAM_ID, timezone: null, quietHoursEnabled: true, quietStartMinute: 1350, quietEndMinute: 420, quietCriticalOverride: true });

  await r.press("Override for this workspace");
  const put2 = requests.filter((q) => q.method === "PUT" && q.path === "/v1/me/notification-schedule").pop();
  assert.equal(put2.body.timezone, "Europe/Berlin", "the override did not start from the account timezone");
});

test("parity: an unprovisioned schedule says so, never renders defaults as saved", async () => {
  routes["/v1/me/notification-schedule"] = () => ({ status: 503, body: { error: { code: "notification_schedule_unavailable", message: "x" } } });
  const r = await render();
  assert.ok(r.hasText("Quiet hours and digest scheduling aren’t provisioned in this environment yet. Your other preferences still work."));
  const save = r.byLabel("Save schedule").find((n) => n.props.accessibilityRole === "button");
  assert.equal(save.props.accessibilityState.disabled, true);
});
