/**
 * MEMBERS RE-AUDIT AUD-05 / DEFECT 19 — the MOBILE Sentry wiring had no
 * expected-refusal filter at all. This drives the REAL `initSentry` and
 * `captureException` (src/sentry.ts) against the recording Sentry fake in
 * test/support/expo-stub.mjs, with errors produced by the REAL `apiFetch`
 * (src/api.ts) from real HTTP responses:
 *
 *   - a 409 business refusal (typed, and code-less) is NOT sent;
 *   - a 500 and a network failure ARE sent;
 *   - the installed `beforeSend` drops an event whose original exception is a
 *     business refusal (the unhandled-rejection path) and keeps a 500.
 */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./support/render.mjs";

let M;
const realFetch = globalThis.fetch;

before(async () => {
  M = await loadModule("src/sentry.ts", ["src/api.ts"]);
  process.env.EXPO_PUBLIC_SENTRY_DSN = "https://public@sentry.test.invalid/1";
  globalThis.__SENTRY__ = { initOptions: null, captured: [] };
  M.initSentry();
});

after(() => {
  globalThis.fetch = realFetch;
  delete process.env.EXPO_PUBLIC_SENTRY_DSN;
});

beforeEach(() => {
  globalThis.__SENTRY__.captured.length = 0;
});

function respond(status, body) {
  globalThis.fetch = async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "x-request-id": "req-aud-05" },
    });
}

async function failure(status, body) {
  respond(status, body);
  try {
    await M.apiFetch("/v1/teams/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/invites", { method: "POST" });
  } catch (err) {
    return err;
  }
  throw new Error("expected the request to fail");
}

async function networkFailure() {
  globalThis.fetch = async () => {
    throw new TypeError("Network request failed");
  };
  try {
    await M.apiFetch("/v1/teams/x");
  } catch (err) {
    return err;
  }
  throw new Error("expected a network failure");
}

const captured = () => globalThis.__SENTRY__.captured;

test("initSentry installed the real hooks", () => {
  assert.equal(globalThis.__SENTRY__.initOptions?.beforeSend, M.mobileSentryBeforeSend);
});

test("a typed 409 refusal is NOT sent", async () => {
  const err = await failure(409, { error: { code: "WORKSPACE_SEAT_LIMIT_REACHED", message: "No seat." } });
  M.captureException(err, { where: "invite" });
  assert.deepEqual(captured(), []);
});

test("a code-less 409 / 422 conflict or validation answer is NOT sent", async () => {
  for (const status of [409, 422]) {
    const err = await failure(status, { message: "no" });
    assert.equal(err.code, "API_ERROR");
    M.captureException(err);
  }
  assert.deepEqual(captured(), []);
});

test("typed business 4xx refusals (401, 403, 404, 400, 429) are NOT sent", async () => {
  M.captureException(await failure(401, { error: { code: "TOKEN_EXPIRED" } }));
  M.captureException(await failure(403, { error: { code: "WORKSPACE_ACCESS_DENIED" } }));
  M.captureException(await failure(403, { error: { code: "PERMISSION_REQUIRED" } }));
  M.captureException(await failure(404, { code: "GRANT_NOT_FOUND" }));
  M.captureException(await failure(400, { error: { code: "INVALID_QUERY" } }));
  M.captureException(await failure(429, { error: { code: "RATE_LIMITED" } }));
  assert.deepEqual(captured(), []);
});

// Third re-audit N-7 — codes that never mean a business refusal are sent,
// exactly as a code-less answer of the same status. Real server shapes: the
// canonical unknown-route 404 (http/not-found-handler.ts), the legacy-handler
// 500 (createErrorResponse(INTERNAL_SERVER_ERROR)), the untyped-legacy
// REQUEST_REFUSED.
test("the canonical ROUTE_NOT_FOUND 404, an INTERNAL_SERVER_ERROR 500 and a REQUEST_REFUSED 403 ARE sent", async () => {
  const ts = "2026-10-26T00:00:00.000Z";
  const sent = [];
  for (const [status, body] of [
    [404, { error: { code: "ROUTE_NOT_FOUND", message: "Resource not found.", requestId: "r1" } }],
    [500, { error: { code: "INTERNAL_SERVER_ERROR", message: "Internal server error", requestId: "r2", timestamp: ts } }],
    [403, { error: { code: "REQUEST_REFUSED", message: "Request refused.", requestId: "r3" } }],
  ]) {
    const err = await failure(status, body);
    sent.push(err);
    M.captureException(err);
  }
  assert.deepEqual(captured(), sent);
});

// ...while NOT_FOUND (a missing or concealed record), FORBIDDEN, the auth
// middleware's nested UNAUTHORIZED (indistinguishable from an expired session)
// and VALIDATION_ERROR stay expected.
test("NOT_FOUND 404, FORBIDDEN 403, nested UNAUTHORIZED 401 and VALIDATION_ERROR 400 are NOT sent", async () => {
  const ts = "2026-10-26T00:00:00.000Z";
  M.captureException(await failure(404, { error: { code: "NOT_FOUND", message: "Not found.", requestId: "r4" } }));
  M.captureException(await failure(403, { error: { code: "FORBIDDEN", message: "Access denied", requestId: "r5", timestamp: ts } }));
  M.captureException(await failure(401, { error: { code: "UNAUTHORIZED", message: "Authentication required", requestId: "r6", timestamp: ts } }));
  M.captureException(await failure(400, { error: { code: "VALIDATION_ERROR", message: "Request validation failed", timestamp: ts } }));
  assert.deepEqual(captured(), []);
});

// Second re-audit N-7 — a code-less 401 / 403 / 404 is a fault (an auth
// regression, a removed or mistyped route), as is any other code-less 4xx.
test("a code-less 401 / 403 / 404 / 405 / 413 / 415 IS sent", async () => {
  const sent = [];
  for (const status of [401, 403, 404, 405, 413, 415]) {
    const err = await failure(status, { message: "no" });
    assert.equal(err.code, "API_ERROR");
    sent.push(err);
    M.captureException(err);
  }
  assert.deepEqual(captured(), sent);
});

test("a 500 IS sent", async () => {
  const err = await failure(500, { error: { code: "INTERNAL_ERROR" } });
  M.captureException(err);
  assert.deepEqual(captured(), [err]);
});

test("a network failure IS sent", async () => {
  const err = await networkFailure();
  M.captureException(err);
  assert.deepEqual(captured(), [err]);
});

test("a code-less 400 (an unexpected request) IS sent", async () => {
  const err = await failure(400, { message: "bad" });
  M.captureException(err);
  assert.deepEqual(captured(), [err]);
});

test("beforeSend drops a refusal's event (unhandled-rejection path) and keeps a 500's", async () => {
  const beforeSend = globalThis.__SENTRY__.initOptions.beforeSend;
  const refusal = await failure(409, { error: { code: "WORKSPACE_SEAT_LIMIT_REACHED" } });
  const fault = await failure(500, { error: { code: "INTERNAL_ERROR" } });
  assert.equal(beforeSend({ message: "unhandled" }, { originalException: refusal }), null);
  assert.notEqual(beforeSend({ message: "unhandled" }, { originalException: fault }), null);
  assert.notEqual(beforeSend({ message: "plain" }, { originalException: new Error("boom") }), null);
  const routeMissing = await failure(404, { message: "Route POST:/v1/teamz not found" });
  assert.notEqual(beforeSend({ message: "unhandled" }, { originalException: routeMissing }), null);
  // Third re-audit N-7 — the canonical unknown-route 404 is kept; a record
  // NOT_FOUND, a nested UNAUTHORIZED and a business 404 are dropped.
  const canonical404 = await failure(404, { error: { code: "ROUTE_NOT_FOUND", message: "Resource not found." } });
  const recordMissing = await failure(404, { error: { code: "NOT_FOUND", message: "Not found." } });
  const authState = await failure(401, { error: { code: "UNAUTHORIZED", message: "Authentication required" } });
  assert.notEqual(beforeSend({ message: "unhandled" }, { originalException: canonical404 }), null);
  assert.equal(beforeSend({ message: "unhandled" }, { originalException: recordMissing }), null);
  assert.equal(beforeSend({ message: "unhandled" }, { originalException: authState }), null);
  const typed404 = await failure(404, { error: { code: "TEAM_NOT_FOUND" } });
  assert.equal(beforeSend({ message: "unhandled" }, { originalException: typed404 }), null);
});
