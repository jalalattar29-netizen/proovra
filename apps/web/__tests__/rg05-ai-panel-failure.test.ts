/**
 * PRO-AI1C-04 / PRO-AI1Z-04 / PRO-AI1-05 — what the AI panels, the Settings
 * status and a citation link say, as behaviour.
 *
 * At the base SHA the copilot panels mapped the HTTP status alone: a spent
 * monthly allowance read "Too many AI requests. Please wait a moment." and a
 * plan without AI read as a retryable failure.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { aiPanelFailure } from "../lib/ai/assistant-state";
import { aiStatusCopy, resolveManagedBy } from "../lib/ai/assistanceStatus";

const statusOnly = (status: number) => `status ${status}`;

test("a spent monthly allowance is said as such, is not retryable and points at Settings", () => {
  const f = aiPanelFailure({ code: "AI_MONTHLY_LIMIT_REACHED", statusCode: 429 }, statusOnly);
  assert.match(f.message, /allowance/i);
  assert.doesNotMatch(f.message, /too many/i);
  assert.equal(f.retryable, false);
  assert.ok(f.settingsHref);
});

test("a plan without AI is a plan sentence, not a retryable failure", () => {
  const f = aiPanelFailure({ code: "AI_NOT_INCLUDED", statusCode: 402 }, statusOnly);
  assert.match(f.message, /plan/i);
  assert.equal(f.retryable, false);
});

test("a restricted subscription is not retryable", () => {
  const f = aiPanelFailure({ code: "COMMERCIAL_LIFECYCLE_RESTRICTED", statusCode: 402 }, statusOnly);
  assert.equal(f.retryable, false);
});

test("an owner budget limit reads as the allowance, not as rate limiting", () => {
  const f = aiPanelFailure({ code: "AI_BUDGET_DAILY_OP_LIMIT", statusCode: 429 }, statusOnly);
  assert.equal(f.retryable, false);
});

test("a transient 503 stays retryable", () => {
  const f = aiPanelFailure({ statusCode: 503 }, statusOnly);
  assert.equal(f.retryable, true);
});

test("a request-specific status keeps the panel's own wording", () => {
  const f = aiPanelFailure({ statusCode: 409 }, statusOnly);
  assert.equal(f.message, "status 409");
});

test("Settings: an exhausted allowance is a plan fact with its reset date, not a platform outage", () => {
  const copy = aiStatusCopy("TEMPORARILY_UNAVAILABLE", {
    reason: "ALLOWANCE_EXHAUSTED",
    allowanceResetsAtUtc: "2028-12-01T00:00:00.000Z",
  });
  assert.equal(copy.label, "Allowance used");
  assert.match(copy.detail, /resets/i);
  assert.equal(
    resolveManagedBy({ status: "TEMPORARILY_UNAVAILABLE", workspaceKind: "PERSONAL", canManage: true, reason: "ALLOWANCE_EXHAUSTED" }),
    "PLAN",
  );
  // An older API sends no reason: unchanged copy.
  assert.equal(aiStatusCopy("TEMPORARILY_UNAVAILABLE").label, "Unavailable");
});
