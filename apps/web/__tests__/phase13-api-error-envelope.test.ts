/**
 * PHASE 13 §2 — THE ERROR ENVELOPE, DRIVEN.
 *
 * Two defects, one symptom: a component that receives a denial it cannot act
 * on.
 *
 *   NEW-030  `ApiError` copied `code`/`statusCode`/`requestId`/`details` off
 *            the envelope and threw the envelope away, so every
 *            `err.body?.error?.code` branch in the app read `undefined`.
 *   NEW-032  the "standard shape" test required BOTH a nested `code` AND a
 *            nested `message`, so `{ error: { code: "STEP_UP_REQUIRED",
 *            methods: ["totp"] } }` — what the step-up gate actually sends —
 *            failed it, fell to the generic branch, and arrived as a plain
 *            Error with code `API_ERROR` and no body at all. The step-up panel
 *            never reopened and `methods` never reached the component.
 *
 * These drive the REAL `apiFetch` against a stubbed `fetch`, because what
 * regressed is behaviour, not a string. A source-shape pin would have passed
 * against the broken code.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { apiFetch, ApiError } from "../lib/api";

type Thrown = ApiError & { body?: { error?: Record<string, unknown> } };

/** Install a `fetch` that answers once with `status` and `body`. */
function stubFetch(status: number, body: unknown, contentType = "application/json") {
  const original = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": contentType, "x-request-id": "req-fixture" },
    });
  return () => {
    (globalThis as { fetch: unknown }).fetch = original;
  };
}

async function thrownFrom(status: number, body: unknown): Promise<Thrown> {
  const restore = stubFetch(status, body);
  try {
    await apiFetch("/v1/fixture");
    assert.fail("apiFetch resolved on a non-2xx response");
  } catch (err) {
    return err as Thrown;
  } finally {
    restore();
  }
}

test("NEW-030: the standard envelope reaches err.body", async () => {
  const err = await thrownFrom(409, {
    error: { code: "export_request_active", message: "An export is already requested." },
  });
  assert.ok(err instanceof ApiError, "a standard envelope must throw ApiError");
  assert.equal(err.body?.error?.code, "export_request_active");
  assert.equal(err.body?.error?.message, "An export is already requested.");
  assert.equal(err.code, "export_request_active");
  assert.equal(err.statusCode, 409);
});

test("NEW-032: a nested code with NO message is still the standard shape", async () => {
  // The exact body the step-up gate sends. Before the fix this arrived as a
  // plain Error with code "API_ERROR" and no body.
  const err = await thrownFrom(403, {
    error: { code: "STEP_UP_REQUIRED", methods: ["totp", "password"] },
  });
  assert.ok(err instanceof ApiError, "a nested code without a message must still be an ApiError");
  assert.equal(err.code, "STEP_UP_REQUIRED", "the code must survive, not become API_ERROR");
  assert.equal(err.body?.error?.code, "STEP_UP_REQUIRED");
  assert.deepEqual(
    err.body?.error?.methods,
    ["totp", "password"],
    "the actionable fields beside the code must reach the component",
  );
  // A missing message must not become an empty string or the literal
  // "undefined" in front of a user.
  assert.ok(
    typeof err.message === "string" && err.message.length > 0 && !/undefined/.test(err.message),
    `message fell back badly: ${err.message}`,
  );
});

test("NEW-032: extra denial fields survive for every code that carries them", async () => {
  for (const [code, extra] of [
    ["STEP_UP_INVALID", { methods: ["totp"], attemptsRemaining: 2 }],
    ["closure_blocked", { blockers: ["evidence_on_hold"] }],
    ["ILLEGAL_MEMBERSHIP_TRANSITION", { currentStatus: "REVOKED" }],
  ] as const) {
    const err = await thrownFrom(409, { error: { code, ...extra } });
    assert.equal(err.code, code);
    for (const [k, v] of Object.entries(extra)) {
      assert.deepEqual(err.body?.error?.[k], v, `${code}: ${k} was dropped`);
    }
  }
});

test("a body with no nested code still fails safely and carries no invented code", async () => {
  const err = (await thrownFrom(500, { unexpected: true })) as Thrown & { code?: string };
  assert.equal(err.code, "API_ERROR");
  assert.equal(err.statusCode, 500);
  // The generic branch deliberately does NOT fabricate an envelope.
  assert.equal(err.body, undefined);
});

test("the request id from the header is preserved as a support reference", async () => {
  const err = await thrownFrom(403, { error: { code: "owner_required" } });
  assert.equal(err.requestId, "req-fixture");
});

test("the shared step-up detector sees a server denial that carries no message", async () => {
  // The end this exists for: `extractStepUp` and its callers branch on the
  // nested code. If the envelope does not arrive, the panel never reopens.
  const err = await thrownFrom(403, { error: { code: "STEP_UP_REQUIRED", methods: ["totp"] } });
  const code =
    (err as { body?: { error?: { code?: string } } }).body?.error?.code ??
    (err as { code?: string }).code;
  assert.equal(code, "STEP_UP_REQUIRED", "the step-up branch would not have fired");
});
