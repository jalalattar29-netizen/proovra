/**
 * forgot-password — request a password-reset link.
 *
 * Server contract (services/api/src/routes/auth.routes.ts):
 *   :235  PasswordResetRequestBody = z.object({ email: z.string().email() })
 *   :1126 POST /v1/auth/password-reset/request
 *         200 { ok: true } whether or not an account matched (no enumeration)
 *         429 { message: "too_many_requests" } + Retry-After (per-IP limiter)
 *   A body the schema rejects is a ZodError → server.ts buildZodWirePayload:
 *         400 { error: { code: "INVALID_INPUT", message: "Invalid input: email — …", fields, requestId } }
 *
 * Web counterpart: /forgot-password redirects to /login?forgot=1, whose form is
 * apps/web/components/marketing/ForgotPasswordModal.tsx — it validates the
 * address locally ("Enter a valid email address.") and says "Too many
 * requests. Please try again in a minute." on a 429.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let M;
let reply = null;
let posts = [];

before(async () => {
  M = await loadModule("app/(stack)/forgot-password.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs"]);
});
beforeEach(() => {
  posts = [];
  reply = { status: 200, body: { ok: true } };
  globalThis.__EXPO_PARAMS__ = {};
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    if (init.method === "POST") posts.push({ path, body: JSON.parse(init.body) });
    // The server's zod gate, applied for real: a malformed address is a 400.
    if (path === "/v1/auth/password-reset/request" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(JSON.parse(init.body).email ?? "")) {
      return new Response(
        JSON.stringify({ error: { code: "INVALID_INPUT", message: "Invalid input: email — Invalid email", fields: [{ path: "email", code: "invalid_string", message: "Invalid email" }], requestId: "req-1" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    const headers = { "content-type": "application/json" };
    if (reply.status === 429) headers["retry-after"] = "42";
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers });
  };
  M.calls.reset();
});
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  return r;
};
const send = async (r) => {
  await act(async () => { await r.byLabel("Send reset link").find((n) => n.props.onPress).props.onPress(); });
  await settle();
};

test("happy path: POSTs { email } (trimmed) and shows the neutral confirmation", async () => {
  const r = await render();
  assert.ok(r.hasText("Reset your password"));
  await r.type("Email address", "  someone@example.com  ");
  await send(r);
  assert.deepEqual(posts, [{ path: "/v1/auth/password-reset/request", body: { email: "someone@example.com" } }]);
  assert.deepEqual(Object.keys(posts[0].body), ["email"], "the body carries a key the zod schema does not declare");
  assert.ok(r.hasText("If an account exists for this address, a secure password reset link has been sent."));
  assert.equal(r.byLabel("Send reset link").length, 0, "the form stayed up after success");
  await r.press("Back to sign in");
  assert.equal(M.calls.replace.at(-1), "/(stack)/auth");
});

test("an ?email= param pre-fills the field and is what gets sent", async () => {
  globalThis.__EXPO_PARAMS__ = { email: "prefill@example.com" };
  const r = await render();
  await send(r);
  assert.deepEqual(posts.map((p) => p.body), [{ email: "prefill@example.com" }]);
});

test("an empty address is refused locally and never sent", async () => {
  const r = await render();
  await send(r);
  assert.equal(posts.length, 0);
  assert.ok(r.hasText("Enter a valid email address."));
});

test("a malformed address is refused locally with the web's words — never the server's zod summary", async () => {
  const r = await render();
  await r.type("Email address", "not-an-email");
  await send(r);
  assert.equal(posts.length, 0, "posted a body PasswordResetRequestBody rejects");
  assert.ok(r.hasText("Enter a valid email address."));
  assert.ok(!r.texts().some((t) => /Invalid input|requestId/.test(t)), "leaked the raw validation envelope");
});

test("429 too_many_requests says so, in the web's words, and keeps the form", async () => {
  reply = { status: 429, body: { message: "too_many_requests" } };
  const r = await render();
  await r.type("Email address", "someone@example.com");
  await send(r);
  assert.equal(posts.length, 1);
  assert.ok(r.hasText("Too many requests. Please try again in a minute."));
  assert.ok(!r.hasText("If an account exists for this address, a secure password reset link has been sent."));
  assert.equal(r.byLabel("Send reset link").length > 0, true);
});

test("a server failure shows safe copy, not the confirmation; the ghost Back goes back", async () => {
  reply = { status: 500, body: { error: { code: "INTERNAL_SERVER_ERROR", message: "boom at db.ts:12", requestId: "req-9" } } };
  const r = await render();
  await r.type("Email address", "someone@example.com");
  await send(r);
  assert.ok(r.hasText("We couldn’t send the reset email right now. Please try again."), "not the web neutral failure sentence");
  assert.ok(!r.texts().some((t) => /boom|db\.ts/.test(t)), "leaked the raw server message");
  await r.press("Back to sign in");
  assert.equal(M.calls.back, 1);
});

test("NEW:FORGOT-PW-FLOW — the web request step: intro, Check your email, and Send again returns to the form", async () => {
  const r = await render();
  assert.ok(r.hasText("Password reset"));
  assert.ok(r.hasText("Enter the email address associated with your PROOVRA account. If an account exists, we’ll send a secure password reset link."));
  await r.type("Email address", "someone@example.com");
  await send(r);
  assert.ok(r.hasText("Check your email"));
  await r.press("Send again");
  assert.ok(r.byLabel("Send reset link").length > 0, "Send again did not return to the form");
});
