import assert from "node:assert/strict";
import { test } from "node:test";

import { denialToMessage } from "./dist/denial-copy.js";

test("a generic entitlement denial is NOT surfaced as a Direct Web Capture plan restriction", () => {
  for (const code of ["TEAM_PLAN_REQUIRED", "ENTITLEMENT_REQUIRED", "UPGRADE_REQUIRED"]) {
    const msg = denialToMessage(code);
    assert.ok(msg, `${code} should map to truthful copy`);
    // The old, false copy said capture "isn't available on this workspace's plan".
    assert.doesNotMatch(msg, /Direct Web Capture/i, `${code} must not claim a capture-specific plan`);
    assert.doesNotMatch(msg, /capture isn't available|capture is not available/i);
    // It must speak to evidence creation, the capability capture inherits.
    assert.match(msg, /evidence/i);
  }
});

test("evidence-record allowance codes read as an evidence limit, not a capture limit", () => {
  for (const code of [
    "FREE_LIMIT_REACHED",
    "EVIDENCE_RECORD_LIMIT_REACHED",
    "EVIDENCE_RECORD_MONTHLY_LIMIT_REACHED",
  ]) {
    const msg = denialToMessage(code);
    assert.ok(msg, `${code} should map to copy`);
    assert.match(msg, /evidence record/i);
    // Reassurance that existing records survive is preserved.
    assert.match(msg, /existing records remain available/i);
    assert.doesNotMatch(msg, /Direct Web Capture/i);
  }
});

test("the monthly cap says 'last 30 days' so it does not read as permanent", () => {
  assert.match(denialToMessage("EVIDENCE_RECORD_MONTHLY_LIMIT_REACHED"), /30 days/i);
});

test("credit exhaustion is about credits, not a plan restriction", () => {
  for (const code of ["INSUFFICIENT_CREDITS", "INSUFFICIENT_EVIDENCE_CREDITS"]) {
    const msg = denialToMessage(code);
    assert.match(msg, /credits/i);
    assert.doesNotMatch(msg, /Direct Web Capture/i);
  }
});

test("storage and subscription denials are surfaced truthfully", () => {
  assert.match(denialToMessage("STORAGE_LIMIT_REACHED"), /storage/i);
  assert.match(denialToMessage("SUBSCRIPTION_INACTIVE"), /subscription/i);
});

test("a rate-limit denial asks the user to wait, not to upgrade", () => {
  const msg = denialToMessage("RATE_LIMITED");
  assert.match(msg, /wait|try again/i);
  assert.doesNotMatch(msg, /plan|upgrade/i);
});

test("unknown / non-commercial codes return null so the caller uses its generic line", () => {
  for (const code of ["WORKSPACE_NOT_FOUND", "FORBIDDEN", "CAPTURE_REQUEST_REFUSED", "INTERNAL_ERROR"]) {
    assert.equal(denialToMessage(code), null);
  }
});

test("null / undefined / empty denial returns null", () => {
  assert.equal(denialToMessage(null), null);
  assert.equal(denialToMessage(undefined), null);
  assert.equal(denialToMessage(""), null);
});

// A1-06 — the server-wide terms gate (428 LEGAL_REACCEPT_REQUIRED, nested error
// shape) reaches the popup as an actionable sentence, through the real client.
import { ApiError, apiFetch } from "./dist/api-client.js";

test("the terms gate says what to do: accept the current terms in PROOVRA", () => {
  const msg = denialToMessage("LEGAL_REACCEPT_REQUIRED");
  assert.ok(msg);
  assert.match(msg, /accept the current terms/i);
  assert.doesNotMatch(msg, /plan|credits/i);
});

test("the client lifts the nested LEGAL_REACCEPT_REQUIRED code into the denial — and no other nested code", async () => {
  const realFetch = globalThis.fetch;
  try {
    const answer = (status, body) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    globalThis.fetch = answer(428, { error: { code: "LEGAL_REACCEPT_REQUIRED", message: "x", details: { missingPolicies: ["terms"] } } });
    const legal = await apiFetch("t", "POST", "/v1/capture/direct-sessions", {}).catch((e) => e);
    assert.ok(legal instanceof ApiError);
    assert.equal(legal.status, 428);
    assert.equal(legal.denial, "LEGAL_REACCEPT_REQUIRED");

    globalThis.fetch = answer(403, { error: { code: "FORBIDDEN" } });
    const other = await apiFetch("t", "POST", "/v1/capture/direct-sessions", {}).catch((e) => e);
    assert.equal(other.denial, null);

    globalThis.fetch = answer(402, { denial: "FREE_LIMIT_REACHED" });
    const capture = await apiFetch("t", "POST", "/v1/capture/direct-sessions", {}).catch((e) => e);
    assert.equal(capture.denial, "FREE_LIMIT_REACHED");
  } finally {
    globalThis.fetch = realFetch;
  }
});

// F-04 — the seal answers 409 EVIDENCE_COMPLETION_INPUTS_CHANGED when the stored
// files changed between its two sealing transactions; nothing was sealed.
test("EVIDENCE_COMPLETION_INPUTS_CHANGED says nothing was sealed and to capture again", () => {
  const msg = denialToMessage("EVIDENCE_COMPLETION_INPUTS_CHANGED");
  assert.ok(msg);
  assert.match(msg, /nothing was sealed/i);
  assert.match(msg, /capture again/i);
  assert.doesNotMatch(msg, /plan|credits/i);
});
