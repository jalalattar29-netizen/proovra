/**
 * WEB PARITY — Settings › Overview (apps/web/app/(app)/settings/_sections/SettingsOverview.tsx)
 * and the pane map (lib/settings/settingsNavigation.ts).
 *
 * Stubs use the server's real shapes:
 *   /v1/platform/context       platform-context/types.ts (activeSpace, organizations, capabilities, planFeatures, flags)
 *   /v1/users/me               users.routes.ts pickMe → { user: { timezone, … } }
 *   /v1/identity/links         identity-links.routes.ts:256-262
 *   /v1/identity/mfa/factors   { hasMfa, factors, recoveryCodesRemaining }
 *   /v1/identity-security/my-sessions  identity-security.routes.ts:1105-1120
 *   /v1/platform/rbac/matrix   { roles, categories, version }
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, platformContextEnvelope, signIn, TEST_TEAM_ID } from "./support/authenticated.mjs";

const h = React.createElement;
let M;
let requests = [];
let routes = {};
const mounted = [];

const FIREFOX_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0";

const ORG_ENVELOPE = (caps = {}) =>
  platformContextEnvelope({
    activeSpace: { id: TEST_TEAM_ID, type: "ORGANIZATION", plan: "BUSINESS", displayName: "Acme Legal", roleLabel: "ADMIN", status: "active" },
    organizations: [{ id: TEST_TEAM_ID, name: "Acme Legal", displayName: "Acme Legal", role: "ADMIN", membershipStatus: "ACTIVE", plan: "BUSINESS", memberCount: 4 }],
    capabilities: { SETTINGS_VIEW: true, SETTINGS_MANAGE: true, BILLING_MANAGE: true, ...caps },
    planFeatures: { reviewerOperationsIncluded: true, aiAssistanceMonthlyOperations: 500 },
    flags: { isEnterpriseWorkspace: false },
    account: { userId: "user-1", email: null, displayName: null, accountPlan: "PRO", accountStatus: "active" },
    personalSpace: { status: "active", id: "p1", label: "Personal Space", ownerUserId: "user-1", plan: "PRO" },
  });

before(async () => {
  M = await loadModule("app/(tabs)/settings.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});

beforeEach(async () => {
  while (mounted.length) mounted.pop().unmount?.();
  requests = [];
  routes = {
    ...authenticatedRoutes({ "/v1/platform/context": () => ORG_ENVELOPE() }),
    "/v1/users/me": () => ({ user: { id: "user-1", timezone: null } }),
    "/v1/identity/links": () => ({ passwordConfigured: true, usableMethods: 2, legacyProvider: null, links: [{ id: "l1", provider: "GOOGLE", normalizedEmail: null, linkedAtUtc: "2026-01-01T00:00:00.000Z", lastUsedAtUtc: null }] }),
    "/v1/identity/mfa/factors": () => ({ hasMfa: false, factors: [], recoveryCodesRemaining: 0 }),
    "/v1/identity-security/my-sessions": () => ({
      sessions: [
        { id: "s1", isCurrent: true, uaPreview: FIREFOX_UA, ipPreview: null, countryCode: null, ssoConnectionId: null, quarantined: false, issuedAtUtc: "2026-01-01T00:00:00.000Z", expiresAtUtc: "2026-03-01T00:00:00.000Z", lastSeenAtUtc: "2026-02-02T00:00:00.000Z" },
        { id: "s2", isCurrent: false, uaPreview: null, ipPreview: null, countryCode: null, ssoConnectionId: null, quarantined: false, issuedAtUtc: "2026-01-01T00:00:00.000Z", expiresAtUtc: "2026-03-01T00:00:00.000Z", lastSeenAtUtc: "2026-02-01T00:00:00.000Z" },
      ],
    }),
    "/v1/platform/rbac/matrix": () => ({
      version: "v7",
      roles: [{ id: "OWNER", label: "Owner", rank: 4 }, { id: "ADMIN", label: "Admin", rank: 3 }, { id: "VIEWER", label: "Viewer", rank: 1 }],
      categories: [{ id: "evidence", label: "Evidence", capabilities: [{ id: "evidence.delete", label: "Delete evidence", description: null, roles: ["OWNER", "ADMIN"] }, { id: "evidence.read", label: "Read evidence", description: null, roles: ["OWNER", "ADMIN", "VIEWER"] }] }],
    }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
    const key = Object.keys(routes).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    return new Response(JSON.stringify(key ? routes[key](path, init) : {}), { status: 200, headers: { "content-type": "application/json" } });
  };
  await signIn(M);
});

async function render() {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  mounted.push(r);
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
  return r;
}

test("overview: the account context — role, organization, and the plan in its own words", async () => {
  const r = await render();
  assert.ok(r.byTestId("settings-identity").length > 0);
  assert.ok(r.hasText("Your account, its preferences, and the workspace you are working in."));
  assert.ok(r.hasText("Organization") && r.hasText("Acme Legal"), r.texts().join(" | "));
  assert.ok(r.hasText("Organization plan") && r.hasText("BUSINESS"));
  assert.ok(r.hasText("Admin"), "the viewer's role is not stated");
});

test("overview: Workspace, Plan, Security and Recent sign-ins summary cards", async () => {
  const r = await render();
  for (const id of ["workspace", "plan", "security", "activity"]) {
    assert.ok(r.byTestId(`settings-summary-${id}`).length > 0, `missing summary card: ${id}`);
  }
  assert.ok(r.hasText("Managed by"), "an organization plan does not say who manages it");
  assert.ok(r.byLabel("View billing").length > 0, "BILLING_MANAGE holder offered no billing action");
  assert.ok(r.byLabel("Manage members").length > 0, "SETTINGS_MANAGE holder offered no member administration");
  assert.ok(r.hasText("Not configured"), "two-factor state not summarised");
  assert.ok(r.hasText("Google · Password"));
  assert.ok(r.hasText("Firefox on Windows") && r.hasText("This device"), "recent sign-ins not listed");
  assert.ok(r.hasText("Unknown device"));
});

test("overview: a member without BILLING_MANAGE / SETTINGS_MANAGE gets no dead actions", async () => {
  routes["/v1/platform/context"] = () => ORG_ENVELOPE({ BILLING_MANAGE: false, SETTINGS_MANAGE: false, SETTINGS_VIEW: false });
  const r = await render();
  assert.equal(r.byLabel("View billing").length, 0);
  assert.equal(r.byLabel("Manage members").length, 0);
  assert.equal(r.byLabel("Roles & permissions").length + (r.hasText("Roles & permissions") ? 1 : 0), 0, "Roles offered without SETTINGS_VIEW");
});

test("overview: no recent sign-ins says so", async () => {
  routes["/v1/identity-security/my-sessions"] = () => ({ sessions: [] });
  const r = await render();
  assert.ok(r.hasText("No recent sign-in activity available."));
});

test("preferences: an unset account timezone is stated, and 'Use my current timezone' saves the device zone", async () => {
  const r = await render();
  assert.ok(r.hasText("Used for notification digests and quiet hours. Evidence and audit timestamps remain in UTC."));
  assert.ok(r.hasText("Not set — UTC is currently used as the fallback."));
  await r.press("Use my current timezone");
  const patch = requests.find((q) => q.method === "PATCH" && q.path === "/v1/users/me");
  assert.ok(patch && typeof patch.body.timezone === "string" && patch.body.timezone.length > 0);
});

test("preferences: a saved account timezone is shown", async () => {
  routes["/v1/users/me"] = () => ({ user: { id: "user-1", timezone: "Europe/Berlin" } });
  const r = await render();
  assert.ok(r.hasText("Berlin — Europe/Berlin"), r.texts().join(" | "));
});

test("roles & permissions: counted from the server catalog, the viewer's role marked (RolesSection)", async () => {
  const r = await render();
  await r.press("Roles & permissions");
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
  assert.ok(requests.some((q) => q.path === "/v1/platform/rbac/matrix"));
  assert.ok(r.hasText("Your role"));
  assert.ok(r.hasText("Permissions: 2 of 2") && r.hasText("Permissions: 1 of 2"));
  assert.ok(r.hasText("Delete evidence") === false, "the detailed matrix is open before it was asked for");
  await r.press("View detailed permission matrix");
  assert.ok(r.hasText("Delete evidence"));
  assert.ok(r.hasText("Owner ✓ · Admin ✓ · Viewer —"));
});

test("roles & permissions: a 403 is a statement about this account", async () => {
  routes["/v1/platform/rbac/matrix"] = () => { throw new Error("unused"); };
  globalThis.fetch = (orig => async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (path.startsWith("/v1/platform/rbac/matrix")) {
      return new Response(JSON.stringify({ error: { code: "FORBIDDEN" } }), { status: 403, headers: { "content-type": "application/json" } });
    }
    return orig(url, init);
  })(globalThis.fetch);
  const r = await render();
  await r.press("Roles & permissions");
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
  assert.ok(r.hasText("This reference is not available to you"));
});
