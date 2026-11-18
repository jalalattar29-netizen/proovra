/**
 * SN-0054 /mfa-recovery-verify (Free audit 0ea0, residual coverage §2.5) —
 * the emailed recovery link, walked through the real screen and the real
 * apiFetch (the error path is api.ts's, not a hand-built error).
 *
 * Server contract (services/api/src/routes/mfa-admin.routes.ts):
 *   POST /v1/identity/mfa/recovery-requests/analytics/page-viewed   200 { ok }   (non-session write)
 *   POST /v1/identity/mfa/recovery-requests/:id/verify-email { token }
 *        200 { ok: true }
 *        404 { error: "request_not_found" }   (wrong_user / token_invalid / unknown id, D11 + D55)
 *        400 { error: "token_expired" | "request_not_in_email_pending" | … }   FLAT, no message
 *   GET  /v1/auth/session-light   { authenticated: boolean }
 *
 * NAT-MFA-01 — the screen classified the failure by the error MESSAGE; a flat
 * `{ error: "token_expired" }` has none, so api.ts's message is "HTTP 400: API
 * error" and every expired or already-handled link read "could not be
 * confirmed". The reason is the error's CODE (api.ts reads the flat form there).
 * NAT-MFA-02 — the web strips `?token=` the moment it posts it
 * (verify/page.tsx:96-110); native kept it in the route params for the life of
 * the screen.
 */
import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
const ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "tok_" + "x".repeat(40);
let M;
let requests;
let verifyAnswer;
let sessionLight;
const mounted = [];

before(async () => {
  M = await loadModule("app/(stack)/mfa-recovery-verify.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/product/mfa-recovery.ts"]);
});

const reply = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

beforeEach(() => {
  requests = [];
  verifyAnswer = () => reply(200, { ok: true });
  sessionLight = { authenticated: false };
  globalThis.__EXPO_PARAMS__ = { id: ID, token: TOKEN };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    requests.push({ path, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
    if (path.endsWith("/verify-email")) return verifyAnswer();
    if (path === "/v1/auth/session-light") return reply(200, sessionLight);
    return reply(200, { ok: true });
  };
  M.calls.reset();
});
afterEach(() => {
  while (mounted.length) mounted.pop().unmount();
});
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  mounted.push(r);
  await settle();
  return r;
};
const verifies = () => requests.filter((q) => q.path.endsWith("/verify-email"));

/* ------------------------------------------------- NAT-MFA-01 (fail-first) */

test("NAT-MFA-01 — an expired link (flat 400 token_expired) says it expired, not 'could not be confirmed'", async () => {
  verifyAnswer = () => reply(400, { error: "token_expired" }, { "x-request-id": "req-77" });
  const r = await render();
  assert.ok(r.hasText("This link has expired. Ask for a new recovery email and use the newest link."), r.texts().join(" | "));
  assert.ok(!r.hasText("token_expired"), "the raw reason was rendered");
});

test("NAT-MFA-01 — a request already past email confirmation (flat 400) says it was already handled", async () => {
  verifyAnswer = () => reply(400, { error: "request_not_in_email_pending" });
  const r = await render();
  assert.ok(r.hasText("This recovery request has already been handled. If you are still locked out, start a new one."), r.texts().join(" | "));
});

test("NAT-MFA-01 — the unit projection reads the flat reason from the error code", () => {
  assert.equal(M.classifyVerifyFailure({ statusCode: 400, code: "token_expired", message: "HTTP 400: API error (requestId: r)" }), "expired");
  assert.equal(M.classifyVerifyFailure({ statusCode: 400, code: "request_not_in_email_pending", message: "HTTP 400: API error" }), "already_handled");
  assert.equal(M.classifyVerifyFailure({ statusCode: 404, code: "request_not_found", message: "HTTP 404: API error" }), "invalid");
  assert.equal(M.classifyVerifyFailure({ statusCode: 400, code: "VALIDATION_ERROR", message: "Invalid request" }), "unknown");
  assert.equal(M.classifyVerifyFailure(new TypeError("Network request failed")), "unknown");
});

/* ------------------------------------------------- NAT-MFA-02 (fail-first) */

test("NAT-MFA-02 — the token is dropped from the route params once it has been posted, and is posted once", async () => {
  const r = await render();
  assert.equal(verifies().length, 1);
  assert.deepEqual(verifies()[0].body, { token: TOKEN });
  assert.ok(M.calls.setParams.some((p) => p && "token" in p && p.token === undefined), `token not scrubbed: ${JSON.stringify(M.calls.setParams)}`);
  // The scrub re-renders the screen with no token: it must not re-run the
  // verify (single-use) nor fall to "link incomplete".
  globalThis.__EXPO_PARAMS__ = { id: ID };
  await r.update(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  assert.equal(verifies().length, 1, "the single-use token was posted twice");
  assert.ok(r.hasText("Thanks — your mailbox access is confirmed."));
});

/* --------------------------------------------- traced behaviour (pinned) */

test("trace: page-viewed fires first, then one verify with { token } only; nothing renders the token", async () => {
  const r = await render();
  assert.equal(requests[0].path, "/v1/identity/mfa/recovery-requests/analytics/page-viewed");
  assert.equal(verifies()[0].path, `/v1/identity/mfa/recovery-requests/${ID}/verify-email`);
  assert.equal(verifies()[0].method, "POST");
  assert.ok(!r.texts().some((t) => t.includes(TOKEN)), "the token was rendered");
  assert.equal(M.calls.push.length, 0);
});

test("trace: success signed out offers 'Return to sign in' and never creates a session", async () => {
  const r = await render();
  assert.ok(r.hasText("This step confirmed your email only. It did NOT log you in and did NOT change your two-factor authentication. You will still need to enroll a fresh authenticator once an admin approves your reset."));
  await r.press("Return to sign in");
  assert.equal(M.calls.replace.at(-1), "/(stack)/auth");
  assert.equal(await M.getItemAsync("proovra-token"), null);
});

test("trace: success with a session on this device offers 'Continue to home'", async () => {
  sessionLight = { authenticated: true };
  const r = await render();
  await r.press("Continue to home");
  assert.equal(M.calls.replace.at(-1), "/(tabs)");
});

test("trace: a probe failure is 'no session', never a crash", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => (String(url).endsWith("/v1/auth/session-light") ? reply(500, {}) : real(url, init));
  const r = await render();
  assert.ok(r.hasText("Thanks — your mailbox access is confirmed."));
  assert.equal(r.byLabel("Return to sign in").length > 0, true);
});

test("trace: an unknown id / wrong account / bad token (404, collapsed by the server) reads 'not valid'", async () => {
  verifyAnswer = () => reply(404, { error: "request_not_found" });
  const r = await render();
  assert.ok(r.hasText("This link is not valid. Open the most recent recovery email and tap the link again."));
  await r.press("Return to sign in");
  assert.equal(M.calls.replace.at(-1), "/(stack)/auth");
});

test("trace: a link without its token or id posts nothing and says it is incomplete", async () => {
  globalThis.__EXPO_PARAMS__ = { id: ID };
  const r = await render();
  assert.equal(verifies().length, 0);
  assert.ok(r.hasText("This link is incomplete. Open the most recent recovery email and tap the link again."));
});

test("trace: a server or network failure is bounded copy, never the raw error", async () => {
  verifyAnswer = () => reply(500, { error: { code: "INTERNAL", message: "db exploded at row 7" } });
  const r = await render();
  assert.ok(r.hasText("This link could not be confirmed. Try again, or ask for a new recovery email."));
  assert.ok(!r.hasText("db exploded"));
});

test("trace: a failed verify never routes to the legal gate or ends a session (non-session write)", async () => {
  verifyAnswer = () => reply(400, { error: "token_expired" });
  await render();
  assert.ok(!M.calls.push.some((c) => c && c.pathname === "/legal-acceptance"));
  assert.equal(M.calls.replace.length, 0);
});

test("trace: the token is never written to device storage or the console", async () => {
  const logged = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => logged.push(a.map(String).join(" "));
  try {
    await render();
  } finally {
    Object.assign(console, orig);
  }
  assert.ok(!logged.some((l) => l.includes(TOKEN)), "the token was logged");
  for (const [, v] of globalThis.__SECURE_STORE__ ?? new Map()) assert.ok(!String(v).includes(TOKEN), "the token was stored");
  const keys = await M.AsyncStorage.getAllKeys?.();
  for (const k of keys ?? []) assert.ok(!String(await M.AsyncStorage.getItem(k)).includes(TOKEN), "the token was stored");
});
