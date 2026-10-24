/**
 * MEMBERS AUDIT LIFE-07 + AUD-05 — a lifecycle refusal reaches the person as
 * the truth, with its support reference, and is not reported as an incident.
 *
 * The observed defect: DELETE /v1/teams/{id} answered a code-less 409, the
 * client turned it into "Please review your input and try again", dropped the
 * request id, and sent the refusal to Sentry as an exception. These cases drive
 * the REAL apiFetch against the route's real response shape.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { apiFetch } from "../lib/api";
import {
  isExpectedBusinessRefusal,
  toSafeUserError,
} from "../lib/feedback/toSafeUserError";

function respond(status: number, body: unknown, requestId = "req-life-07") {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "x-request-id": requestId },
    })) as typeof fetch;
}

async function refusal(status: number, body: unknown): Promise<unknown> {
  respond(status, body);
  try {
    await apiFetch("/v1/teams/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { method: "DELETE" });
  } catch (err) {
    return err;
  }
  throw new Error("expected a refusal");
}

const ROUTE_BODY = (code: string, nextAction: string) => ({
  error: {
    code,
    message: "A Personal Workspace can't be deleted. It closes only when you close your account.",
    state: "ACTIVE",
    nextAction,
    requestId: "req-life-07",
  },
  requestId: "req-life-07",
});

test("WORKSPACE_KIND_NOT_DELETABLE renders its own copy, never the generic 4xx bucket", async () => {
  const err = await refusal(409, ROUTE_BODY("WORKSPACE_KIND_NOT_DELETABLE", "CLOSE_ACCOUNT"));
  const safe = toSafeUserError(err, { message: "Failed to delete workspace" });
  assert.equal(safe.title, "This workspace can't be deleted");
  assert.match(safe.message, /closes only when you close your account/);
  assert.doesNotMatch(safe.message, /review your input/i);
  assert.equal(safe.supportReference, "req-life-07");
});

test("every lifecycle refusal code has customer copy and keeps the support reference", async () => {
  for (const [code, next] of [
    ["WORKSPACE_KIND_NOT_DELETABLE", "ORGANIZATION_OFFBOARDING"],
    ["WORKSPACE_CLOSURE_REQUIRED", "REQUEST_WORKSPACE_CLOSURE"],
    ["WORKSPACE_KIND_NOT_CLOSABLE", "CLOSE_ACCOUNT"],
    ["WORKSPACE_OWNER_REQUIRED", ""],
  ] as const) {
    const err = await refusal(code === "WORKSPACE_OWNER_REQUIRED" ? 403 : 409, ROUTE_BODY(code, next));
    const safe = toSafeUserError(err);
    assert.doesNotMatch(safe.message, /review your input|try again/i, code);
    assert.doesNotMatch(`${safe.title} ${safe.message}`, /\bteam\b/i, code);
    assert.equal(safe.supportReference, "req-life-07", code);
  }
});

test("a typed refusal is an expected business decision, not a Sentry incident", async () => {
  const err = await refusal(409, ROUTE_BODY("WORKSPACE_KIND_NOT_DELETABLE", "CLOSE_ACCOUNT"));
  assert.equal(isExpectedBusinessRefusal(err), true);
});

test("a code-less 4xx, a 5xx and a network failure are still reported", async () => {
  assert.equal(isExpectedBusinessRefusal(await refusal(409, { message: "legacy" })), false);
  assert.equal(isExpectedBusinessRefusal(await refusal(500, { error: { code: "INTERNAL" } })), false);
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  let network: unknown;
  try {
    await apiFetch("/v1/teams/x");
  } catch (err) {
    network = err;
  }
  assert.equal(isExpectedBusinessRefusal(network), false);
});
