/**
 * Invitation acceptance (`portal/accept/[grantId].tsx`), rendered for real
 * against the SERVER's contract:
 *
 *   POST /v1/external-review/access/:token   external-review.routes.ts:331
 *     - :token is TokenParamSchema (:109) — hex, 32..128; no body schema;
 *     - 200 { context: ReviewerContextProjection } (:388);
 *     - 401 { error: { code: "grant_not_active" } } for unknown, expired AND
 *       revoked alike — deliberately indistinguishable (:343-348);
 *     - 403 PORTAL_MFA_REQUIRED_BODY = { error: { code: "portal_mfa_required",
 *       portalPath: "/portal" } } (:72, :352) — this route has NO code step.
 *
 * DEFECT this pins (fixed in portal/accept/[grantId].tsx + src/product/portal.ts):
 * an invitation that requires MFA answered 403 portal_mfa_required, which native
 * classified UNKNOWN and showed as a dead end ("could not be opened"). The
 * server's own answer names the way on: the portal token exchange, which owns
 * the emailed-code step and accepts the invitation once the code is verified
 * (external-portal.routes.ts:827, acceptInvited: true).
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
const GRANT = "9b1f0000-0000-4000-8000-000000000001";
const TOKEN = "c0ffee".repeat(10) + "abcd"; // 64 hex

let M;
let requests = [];
let reply;

const send = (b, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

before(async () => {
  M = await loadModule("app/(stack)/portal/accept/[grantId].tsx", [
    "test/support/providers.tsx",
    "test/support/expo-stub.mjs",
    "src/portal/portal-session.ts",
  ]);
});

beforeEach(() => {
  requests = [];
  M.calls.reset();
  M.clearPortalSession();
  globalThis.__EXPO_PARAMS__ = { grantId: GRANT, token: TOKEN };
  reply = {
    status: 200,
    body: {
      context: {
        scopeKind: "CASE",
        state: "ACTIVE",
        reviewerDisplayName: "Rae Counsel",
        expiresAtUtc: "2026-12-01T00:00:00.000Z",
        allowOriginalDownload: false,
        allowPackageDownload: false,
        safeNote: null,
        redactionPolicyVersion: 1,
      },
    },
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const method = init.method ?? "GET";
    requests.push({ path, method, headers: new Headers(init.headers) });
    const m = /^\/v1\/external-review\/access\/([^/]+)$/.exec(path);
    if (m && method === "POST") {
      // TokenParamSchema (external-review.routes.ts:109).
      if (!/^[a-f0-9]{32,128}$/i.test(decodeURIComponent(m[1]))) return send({ message: "invalid params" }, 400);
      return send(reply.body, reply.status);
    }
    return send({ message: "unstubbed" }, 500);
  };
});

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
};
const render = async () => {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  return r;
};

test("a valid link is accepted once, then hands the reviewer into their portal with the same token", async () => {
  const r = await render();
  assert.equal(requests.length, 1, "acceptance is single-use: exactly one POST");
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].path, `/v1/external-review/access/${TOKEN}`, "the token travels in the path");
  assert.ok(r.hasText("Your review access is active. You can open the reviews assigned to you now."));
  assert.equal(M.getPortalToken(), TOKEN, "the token is held (in memory) for the portal");
  await r.press("Open my reviews");
  assert.deepEqual(M.calls.replace, [`/portal/${TOKEN}`]);
});

test("a re-render does not spend the acceptance a second time", async () => {
  const r = await render();
  await r.update(h(M.TestProviders, null, h(M.default, {})));
  await settle();
  assert.equal(requests.length, 1);
});

for (const [name, params] of [
  ["missing token", { grantId: GRANT }],
  ["missing grant id", { token: TOKEN }],
]) {
  test(`a link with a ${name} is not half-attempted`, async () => {
    globalThis.__EXPO_PARAMS__ = params;
    const r = await render();
    assert.equal(requests.length, 0, "nothing is posted for half a link");
    assert.ok(r.hasText("This invitation is not open"));
    assert.ok(r.hasText("This link is not valid. Open the most recent invitation email and use the link there."));
  });
}

test("a grant that is not active (401 grant_not_active) is refused without claiming which reason", async () => {
  reply = { status: 401, body: { error: { code: "grant_not_active" } } };
  const r = await render();
  assert.ok(r.hasText("This invitation is not open"));
  // The server hides expired vs revoked vs unknown (anti-enumeration); the
  // screen must not invent one.
  assert.ok(!r.hasText("expired"));
  assert.ok(!r.hasText("withdrawn"));
  assert.ok(r.hasText("This review access could not be opened. Try again, or ask for a new link."));
  assert.equal(r.byLabel("Open my reviews").length, 0);
  assert.equal(M.getPortalToken(), null, "a refused token is not held");
});

test("an invitation that requires MFA (403 portal_mfa_required) goes on to the portal's code step", async () => {
  reply = { status: 403, body: { error: { code: "portal_mfa_required", portalPath: "/portal" } } };
  const r = await render();
  assert.deepEqual(
    M.calls.replace,
    [`/portal/${TOKEN}`],
    "the portal exchange owns the emailed-code step; the accept route has none",
  );
  assert.ok(!r.hasText("This review access could not be opened. Try again, or ask for a new link."));
});

test("a throttled acceptance says to wait", async () => {
  reply = { status: 429, body: { error: { code: "rate_limited" } } };
  const r = await render();
  assert.ok(r.hasText("Too many attempts. Wait a few minutes and try again."));
});
