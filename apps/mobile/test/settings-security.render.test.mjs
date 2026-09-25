/**
 * RENDER TESTS for Settings › Security.
 *
 * Drives the real screen through the real `apiFetch`, with `globalThis.fetch`
 * replaced — so the screen's own loading, error, empty and populated branches
 * execute, and the requests it makes are observable.
 *
 * This is the surface that did not exist: native Settings read one endpoint and
 * pointed at a web page for everything else, so a user could not change their
 * password, revoke a session or manage two-factor from their phone.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";
import { authenticatedRoutes, signIn } from "./support/authenticated.mjs";

const h = React.createElement;
let M;

/** Requests the screen made during a render, in order. */
let requests = [];
/** path → responder. A missing entry is a 500, which is a real state too. */
let routes = {};

function installFetch() {
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
    const responder = Object.entries(routes).find(([p]) => path.startsWith(p));
    if (!responder) {
      return new Response(JSON.stringify({ message: "unstubbed" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    const out = responder[1](path, init);
    return new Response(JSON.stringify(out.body ?? {}), {
      status: out.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
}

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const FIREFOX_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0";

const OK_ROUTES = () => ({
  ...authenticatedRoutes(),
  "/v1/identity/links": () => ({
    body: {
      passwordConfigured: true,
      usableMethods: 2,
      links: [{ id: "l1", provider: "GOOGLE", normalizedEmail: null, linkedAtUtc: "2026-01-02T03:04:05.000Z", lastUsedAtUtc: null }],
      legacyProvider: null,
    },
  }),
  "/v1/identity/mfa/factors": () => ({
    body: { hasMfa: true, factors: [{ id: "f1", label: "Authenticator app", status: "ACTIVE" }], recoveryCodesRemaining: 2 },
  }),
  "/v1/identity-security/my-sessions": () => ({
    body: {
      sessions: [
        // The route's row (identity-security.routes.ts:1105-1120): previews of the RAW user agent.
        { id: "s1", isCurrent: true, uaPreview: IPHONE_UA, ipPreview: null, countryCode: null, ssoConnectionId: null, quarantined: false, lastSeenAtUtc: "2026-02-02T00:00:00.000Z", issuedAtUtc: "2026-01-30T00:00:00.000Z", expiresAtUtc: "2026-03-01T00:00:00.000Z" },
        { id: "s2", isCurrent: false, uaPreview: FIREFOX_UA, ipPreview: "198.51.100.x", countryCode: null, ssoConnectionId: null, quarantined: false, lastSeenAtUtc: "2026-02-01T00:00:00.000Z", issuedAtUtc: "2026-01-29T00:00:00.000Z", expiresAtUtc: "2026-02-28T00:00:00.000Z" },
      ],
    },
  }),
  "/v1/identity-security/security-events": () => ({
    // The server's row (identity-security.routes.ts): `action`, not the `eventType` this used to invent.
    body: { events: [{ id: "e1", action: "identity_security.password_change", severity: "info", outcome: "success", occurredAtUtc: "2026-02-03T00:00:00.000Z" }] },
  }),
});

before(async () => {
  M = await loadModule("app/(stack)/settings/security.tsx", [
    "test/support/providers.tsx",
    "test/support/expo-stub.mjs",
  ]);
});

beforeEach(async () => {
  requests = [];
  routes = OK_ROUTES();
  installFetch();
  // This suite asserted on the security screen while SIGNED OUT.
  await signIn(M);
});

const render = () => renderComponent(h(M.TestProviders, null, h(M.default, {})));

test("it reads all four canonical security sections", async () => {
  await render();
  const paths = requests.map((r) => r.path);
  for (const p of [
    "/v1/identity/links",
    "/v1/identity/mfa/factors",
    "/v1/identity-security/my-sessions",
    "/v1/identity-security/security-events",
  ]) {
    assert.ok(paths.some((x) => x.split("?")[0] === p), `the screen never requested ${p}`);
  }
});

test("it renders every canonical section heading", async () => {
  const r = await render();
  for (const heading of [
    "Change password",
    "Sign-in methods",
    "Two-factor authentication",
    "Your active sessions",
    "Account & security activity",
  ]) {
    assert.ok(r.hasText(heading), `missing section: ${heading}`);
  }
});

test("it names this device and offers to sign out the others", async () => {
  // UPDATED (web parity, sessionPresentation.ts): the device is DESCRIBED from
  // the raw UA preview; the preview and masked IP are Technical details only.
  const r = await render();
  assert.ok(r.hasText("Safari on iPhone"));
  assert.ok(r.hasText("Current session"));
  assert.ok(r.hasText("Firefox on Windows"));
  assert.equal(r.hasText("198.51.100.x"), false, "the masked IP is forensic detail, not primary content");
  assert.ok(r.hasText("Sign out other sessions"));
});

test("it warns when recovery codes are running out", async () => {
  const r = await render();
  assert.ok(r.hasText("Two-factor authentication is enabled. Recovery codes remaining: 2."));
  assert.ok(r.hasText("Regenerate before you run out."));
});

test("revoking a session asks first and states the consequence", async () => {
  const r = await render();
  await r.press("Sign out other sessions");
  assert.ok(r.hasText("Sign out other sessions?"));
  assert.ok(
    r.hasText("You will not be signed out from this device."),
    "a destructive security action must say what it does NOT do, too",
  );
  // Nothing was sent until the confirmation is accepted.
  assert.equal(requests.filter((x) => x.method === "POST").length, 0);
});

test("confirming the revoke posts to the canonical endpoint and reloads", async () => {
  const r = await render();
  await r.press("Sign out other sessions");
  await r.press("Sign out others");
  const posts = requests.filter((x) => x.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, "/v1/identity-security/my-sessions/revoke-others");
  assert.ok(
    requests.filter((x) => x.path === "/v1/identity-security/my-sessions").length >= 2,
    "the inventory must be re-read after a revoke, not left stale",
  );
});

test("the change-password button is inert until the form is valid", async () => {
  const r = await render();
  const button = r.byLabel("Change password").find((n) => n.props.accessibilityRole === "button");
  assert.equal(button.props.accessibilityState.disabled, true);
  await r.press("Change password");
  assert.equal(requests.filter((x) => x.method === "POST").length, 0);
});

test("a valid password change posts the canonical body", async () => {
  routes["/v1/identity-security/password"] = () => ({ body: { ok: true } });
  const r = await render();
  await r.type("Current password", "OldPassword9Here");
  await r.type("New password", "CorrectHorse9Battery");
  await r.type("Confirm new password", "CorrectHorse9Battery");
  await r.press("Change password");

  const post = requests.find((x) => x.path === "/v1/identity-security/password");
  assert.ok(post, "the password change never reached the server");
  assert.equal(post.method, "POST");
});

test("the password requirements update as the user types", async () => {
  const r = await render();
  assert.ok(r.hasText("At least 12 characters"));
  await r.type("New password", "CorrectHorse9Battery");
  // Met requirements render with a tick; the list itself never disappears.
  assert.ok(r.hasText("✓ At least 12 characters"));
  assert.ok(r.hasText("✓ A number"));
});

test("mismatched confirmation is reported on the field, not after submitting", async () => {
  const r = await render();
  await r.type("New password", "CorrectHorse9Battery");
  await r.type("Confirm new password", "Different9Battery");
  assert.ok(r.hasText("The two new passwords do not match."));
});

test("one failed section does not blank the others", async () => {
  // A user who cannot load their security ACTIVITY can still need to revoke a
  // session right now.
  delete routes["/v1/identity-security/security-events"];
  const r = await render();
  assert.ok(r.hasText("Safari on iPhone"), "sessions still render");
  // CORRECTED (T-12, 2026-09-24): this used to assert "No security events in
  // the recent window" for a FAILED read — pinning an outage as a quiet
  // account. The web separates them (PersonalSecuritySections.tsx:1980-2008).
  assert.ok(r.hasText("Could not load security events."));
  assert.ok(!r.hasText("No security events in the recent window"), "a failed read claimed the account was quiet");
});

test("when identity and sessions both fail, the page reports an error with a retry", async () => {
  routes = {};
  const r = await render();
  assert.equal(r.hasText("Change password"), false, "no form over data that failed to load");
  assert.ok(r.byLabel("Try again").length > 0, "an error state must offer a way out");
});

test("retrying re-requests the canonical endpoints", async () => {
  routes = {};
  const r = await render();
  const before = requests.length;
  await r.press("Try again");
  assert.ok(requests.length > before, "Try again did not re-request anything");
});

test("an account with one sign-in method and no second factor is told so", async () => {
  routes["/v1/identity/links"] = () => ({
    body: { passwordConfigured: true, usableMethods: 1, links: [] },
  });
  routes["/v1/identity/mfa/factors"] = () => ({ body: { hasMfa: false, factors: [], recoveryCodesRemaining: 0 } });
  const r = await render();
  assert.ok(r.hasText("One sign-in method, no second factor"));
  assert.ok(r.hasText("This is the only way into your account."));
  assert.ok(r.hasText("No second factor"));
});

test("removing a two-factor method states what it costs", async () => {
  const r = await render();
  await r.press("Remove");
  // The confirm control restates the specific action — "Sign out" also labels
  // every session row behind the sheet.
  assert.ok(r.byLabel("Remove factor").length === 1);
  assert.ok(r.hasText("Remove two-factor authentication?"));
  assert.ok(r.hasText("Your account will no longer require a second factor at sign-in. If your organization requires MFA, you will be asked to re-enroll on your next sign-in."));
});

test("a security event is worded by the SHARED vocabulary from its action key", async () => {
  const r = await render();
  assert.ok(r.hasText("Password changed"), "the event was not worded from its action");
  assert.ok(!r.hasText("identity_security.password_change"), "a raw internal key was shown");
});

/* ---- T-14 (PersonalSecuritySections.tsx:2080 Technical details) ---- */

test("each security event keeps its exact key and raw facts behind Technical details", async () => {
  routes["/v1/identity-security/security-events"] = () => ({
    body: { events: [{ id: "e1", action: "identity_security.password_change", severity: "info", outcome: "success", ipPreview: "203.0.113.x", resourceType: "USER", occurredAtUtc: "2026-02-03T00:00:00.000Z" }] },
  });
  const r = await render();
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
  assert.equal(r.hasText("Resource: USER"), false, "the forensic detail was shown before it was asked for");
  const node = r.byLabel("Technical details: Password changed").find((n) => n.props.onPress);
  assert.ok(node, "no Technical details control");
  await act(async () => { node.props.onPress(); });
  assert.ok(r.hasText("Event key: identity_security.password_change"));
  assert.ok(r.hasText("Outcome: success") && r.hasText("Severity: info") && r.hasText("IP: 203.0.113.x") && r.hasText("Resource: USER"));
});

/* ---- WEB PARITY (PersonalSecuritySections.tsx) ---- */

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};

test("parity: the summary strip states login method, two-factor and session count (SummaryStrip :250)", async () => {
  const r = await render();
  assert.ok(r.byTestId("security-summary").length > 0, "no summary strip");
  assert.ok(r.hasText("Login method") && r.hasText("Google · Password"));
  assert.ok(r.hasText("Enabled"));
  assert.ok(r.hasText("Active sessions") && r.hasText("2"));
});

test("parity: one row per sign-in method with its status and the one action the web offers (LoginMethodsCard :921)", async () => {
  const r = await render();
  assert.ok(r.hasText("Email & password") && r.hasText("Configured"));
  assert.ok(r.hasText("Connected"), "the linked Google identity is not shown as connected");
  assert.ok(r.hasText("Not connected"), "Apple is not offered as a method to connect");
  assert.ok(r.byLabel("Disconnect Google").length > 0);
  assert.ok(r.hasText("Organization single sign-on is managed by your organization and never appears here."));
});

test("parity: the last usable method cannot be disconnected, and says why", async () => {
  routes["/v1/identity/links"] = () => ({
    body: { passwordConfigured: false, usableMethods: 1, legacyProvider: null, links: [{ id: "l1", provider: "GOOGLE", normalizedEmail: null, linkedAtUtc: "2026-01-02T03:04:05.000Z", lastUsedAtUtc: null }] },
  });
  const r = await render();
  const btn = r.byLabel("Disconnect Google").find((n) => n.props.accessibilityRole === "button");
  assert.equal(btn.props.accessibilityState.disabled, true);
  assert.ok(r.hasText("Add another login method before disconnecting Google."));
  // No password configured: the Change password card does not render; Add password is the row action.
  assert.equal(r.hasText("Use at least 12 characters with upper- and lower-case letters and a number. Your current password is required."), false);
  assert.ok(r.byLabel("Add password").length > 0);
});

test("parity: a password change sends revokeOtherSessions and reports how many were signed out", async () => {
  // identity-security.routes.ts:1071 — { ok: true, revokedOtherSessions }.
  routes["/v1/identity-security/password"] = () => ({ body: { ok: true, revokedOtherSessions: 3 } });
  const r = await render();
  assert.ok(r.byLabel("Sign out my other sessions after the change").length > 0, "no revoke-others option");
  await r.type("Current password", "OldPassword9Here");
  await r.type("New password", "CorrectHorse9Battery");
  await r.type("Confirm new password", "CorrectHorse9Battery");
  await r.press("Change password");
  await settle();
  const post = requests.find((x) => x.path === "/v1/identity-security/password");
  assert.equal(post.body.revokeOtherSessions, true, "the web's default (sign the others out) was not sent");
  assert.ok(r.hasText("Password updated. 3 other session(s) signed out."), r.texts().join(" | "));
});

test("parity: a wrong current password is named, not a generic failure", async () => {
  routes["/v1/identity-security/password"] = () => ({ status: 400, body: { error: { code: "current_password_invalid" } } });
  const r = await render();
  await r.type("Current password", "OldPassword9Here");
  await r.type("New password", "CorrectHorse9Battery");
  await r.type("Confirm new password", "CorrectHorse9Battery");
  await r.press("Change password");
  await settle();
  assert.ok(r.hasText("The current password is incorrect."), r.texts().join(" | "));
});

test("parity: regenerating recovery codes asks first, then SHOWS the new codes until acknowledged (MfaCard :1224)", async () => {
  // mfa.routes.ts:307 — the codes are returned ONCE.
  routes["/v1/identity/mfa/recovery-codes/regenerate"] = () => ({ body: { recoveryCodes: ["aaaa-1111", "bbbb-2222"] } });
  const r = await render();
  await r.press("Regenerate recovery codes");
  assert.ok(r.hasText("Regenerate recovery codes?"));
  assert.equal(requests.filter((x) => x.method === "POST").length, 0, "regenerated before confirming");
  await r.press("Regenerate");
  await settle();
  assert.ok(requests.some((x) => x.path === "/v1/identity/mfa/recovery-codes/regenerate" && x.method === "POST"));
  assert.ok(r.hasText("New recovery codes generated."));
  assert.ok(r.hasText("aaaa-1111") && r.hasText("bbbb-2222"), "the only copy of the new codes was discarded");
  const done = r.byLabel("Done").find((n) => n.props.accessibilityRole === "button");
  assert.equal(done.props.accessibilityState.disabled, true, "the codes could be dismissed without acknowledging them");
});

test("parity: sessions show location, sign-in time and Technical details on request (ActiveSessionsCard :1757)", async () => {
  const r = await render();
  assert.ok(r.hasText("Location unavailable"), r.texts().join(" | "));
  assert.equal(r.hasText("Session reference: s2"), false, "forensic detail shown before it was asked for");
  const node = r.byLabel("Technical details: Firefox on Windows").find((n) => n.props.onPress);
  await act(async () => { node.props.onPress(); });
  assert.ok(r.hasText(`User agent: ${FIREFOX_UA}`));
  assert.ok(r.hasText("IP (masked): 198.51.100.x"));
  assert.ok(r.hasText("Session reference: s2"));
});

test("parity: the latest three sessions, then Show N more; and no others says so", async () => {
  routes["/v1/identity-security/my-sessions"] = () => ({
    body: {
      sessions: ["a", "b", "c", "d", "e"].map((id, i) => ({
        id, isCurrent: i === 0, uaPreview: FIREFOX_UA, ipPreview: null, countryCode: null, ssoConnectionId: null, quarantined: false,
        lastSeenAtUtc: `2026-02-0${9 - i}T00:00:00.000Z`, issuedAtUtc: "2026-01-01T00:00:00.000Z", expiresAtUtc: "2026-03-01T00:00:00.000Z",
      })),
    },
  });
  const r = await render();
  assert.ok(r.byTestId("session-c").length > 0 && r.byTestId("session-d").length === 0, "more than three sessions rendered up front");
  await r.press("Show 2 more sessions");
  assert.ok(r.byTestId("session-e").length > 0);
  assert.ok(r.byLabel("Show fewer sessions").length > 0);

  routes["/v1/identity-security/my-sessions"] = () => ({ body: { sessions: [{ id: "only", isCurrent: true, uaPreview: IPHONE_UA, lastSeenAtUtc: "2026-02-02T00:00:00.000Z" }] } });
  const r2 = await render();
  assert.ok(r2.hasText("No other active sessions."));
});

test("parity: security activity reads the bounded window and pages it (SecurityEventsCard :1969)", async () => {
  routes["/v1/identity-security/security-events"] = () => ({
    body: { events: Array.from({ length: 5 }, (_, i) => ({ id: `e${i}`, action: "auth.login", severity: "info", outcome: "success", occurredAtUtc: "2026-02-03T00:00:00.000Z", resourceType: null, resourceId: null, ipPreview: null, uaPreview: null, metadata: null })) },
  });
  const r = await render();
  assert.ok(requests.some((x) => x.path === "/v1/identity-security/security-events?limit=50"));
  assert.ok(r.hasText("View more (2 older)"), r.texts().join(" | "));
  await r.press("View more (2 older)");
  assert.equal(r.hasText("View more (2 older)"), false);
});
