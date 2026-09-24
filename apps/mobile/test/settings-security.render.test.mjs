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
import { loadModule, renderComponent, React } from "./support/render.mjs";
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
    requests.push({ path, method: init.method ?? "GET" });
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

const OK_ROUTES = () => ({
  ...authenticatedRoutes(),
  "/v1/identity/links": () => ({
    body: {
      passwordConfigured: true,
      usableMethods: 2,
      links: [{ provider: "GOOGLE", linkedAtUtc: "2026-01-02T03:04:05.000Z" }],
    },
  }),
  "/v1/identity/mfa/factors": () => ({
    body: { hasMfa: true, factors: [{ id: "f1", label: "Authenticator app", status: "ACTIVE" }], recoveryCodesRemaining: 2 },
  }),
  "/v1/identity-security/my-sessions": () => ({
    body: {
      sessions: [
        { id: "s1", isCurrent: true, uaPreview: "PROOVRA iOS", lastSeenAtUtc: "2026-02-02T00:00:00.000Z" },
        { id: "s2", isCurrent: false, uaPreview: "Firefox on Windows", ipPreview: "198.51.100.x", lastSeenAtUtc: "2026-02-01T00:00:00.000Z" },
      ],
    },
  }),
  "/v1/identity-security/security-events": () => ({
    body: { events: [{ id: "e1", eventType: "PASSWORD_CHANGED", atUtc: "2026-02-03T00:00:00.000Z" }] },
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
    assert.ok(paths.includes(p), `the screen never requested ${p}`);
  }
});

test("it renders every canonical section heading", async () => {
  const r = await render();
  for (const heading of [
    "Change password",
    "Sign-in methods",
    "Two-factor authentication",
    "Where you are signed in",
    "Account & security activity",
  ]) {
    assert.ok(r.hasText(heading), `missing section: ${heading}`);
  }
});

test("it names this device and offers to sign out the others", async () => {
  const r = await render();
  assert.ok(r.hasText("PROOVRA iOS"));
  assert.ok(r.hasText("This device"));
  assert.ok(r.hasText("Firefox on Windows · 198.51.100.x"));
  assert.ok(r.hasText("Sign out others"));
});

test("it warns when recovery codes are running out", async () => {
  const r = await render();
  assert.ok(r.hasText("2 recovery codes left"));
  assert.ok(r.hasText("regenerate before you run out"));
});

test("revoking a session asks first and states the consequence", async () => {
  const r = await render();
  await r.press("Sign out others");
  assert.ok(r.hasText("Sign out 1 other session?"));
  assert.ok(
    r.hasText("This device stays signed in."),
    "a destructive security action must say what it does NOT do, too",
  );
  // Nothing was sent until the confirmation is accepted.
  assert.equal(requests.filter((x) => x.method === "POST").length, 0);
});

test("confirming the revoke posts to the canonical endpoint and reloads", async () => {
  const r = await render();
  await r.press("Sign out others");
  await r.press("Sign out other sessions");
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
  assert.ok(r.hasText("PROOVRA iOS"), "sessions still render");
  assert.ok(r.hasText("No security events in the recent window"));
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
  assert.ok(r.byLabel("Remove two-factor method").length === 1);
  assert.ok(r.hasText("Remove this two-factor method?"));
  assert.ok(r.hasText("Your password alone will be enough to sign in to this account."));
});
