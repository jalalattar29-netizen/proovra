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
