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

test("a code-less 409 / 403 / 404 / 422 business answer is NOT sent", async () => {
  for (const status of [409, 403, 404, 422]) {
    const err = await failure(status, { message: "no" });
    assert.equal(err.code, "API_ERROR");
    M.captureException(err);
  }
  assert.deepEqual(captured(), []);
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
});
