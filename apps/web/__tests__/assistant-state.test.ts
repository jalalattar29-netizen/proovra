/**
 * WHAT THE ASSISTANT SAYS WHEN IT CANNOT ANSWER.
 *
 * The mapping these assertions cover used to live inside a `catch` block in a
 * rendering component, where reaching it meant rendering the widget and
 * provoking a network failure. Nobody did, and it shipped checking a code no
 * route emits (`AI_DISABLED`) while reporting a workspace's own opt-out as
 * "AI assistant currently unavailable".
 *
 * These are behaviour tests, not source-string tests. Every AI-chat test in
 * `services/api/test` reads its route file as text and asserts on substrings,
 * which is exactly why a runtime failure survived them all: a string assertion
 * cannot notice that a branch is unreachable.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  classifyAssistantError,
  classifyAssistantResult,
  SENSITIVE_ROUTE_STATE,
} from "../lib/ai/assistant-state";

const denial = (decision: string) =>
  classifyAssistantError({
    code: "AI_WORKSPACE_POLICY_DENIED",
    statusCode: 403,
    details: { decision },
  });

// ===========================================================================
// THE DEFECT ITSELF
// ===========================================================================
test("a workspace opt-out is never reported as unavailability", () => {
  const s = denial("WORKSPACE_DISABLED");
  assert.equal(s.kind, "POLICY_DISABLED");
  assert.equal(s.tone, "notice", "a deliberate setting is not a malfunction");
  assert.doesNotMatch(
    `${s.title} ${s.body}`,
    /unavailable|error|failed|wrong/i,
    "nothing here is broken, so nothing may say it is",
  );
});

test("each policy decision produces its own explanation", () => {
  const seen = new Map<string, string>();
  for (const d of [
    "WORKSPACE_DISABLED",
    "FEATURE_DISABLED",
    "ROLE_NOT_PERMITTED",
    "PLAN_NOT_ENTITLED",
    "DATA_CLASS_NOT_ALLOWED",
    "GLOBAL_DISABLED",
  ]) {
    const s = denial(d);
    assert.ok(s.title.length > 0 && s.body.length > 0, `${d} needs copy`);
    seen.set(d, `${s.title}|${s.body}`);
  }
  assert.equal(
    new Set(seen.values()).size,
    seen.size,
    "two decisions sharing one sentence is the old bug in a new place",
  );
});

test("a plan entitlement does not invite a retry, a rate limit does", () => {
  assert.equal(denial("PLAN_NOT_ENTITLED").canSend, false);
  assert.equal(
    classifyAssistantError({ code: "AI_CHAT_RATE_LIMITED", statusCode: 429 }).canSend,
    true,
  );
});

// ===========================================================================
// ONE STATUS, SEVERAL MEANINGS
// ===========================================================================
test("three different 429s are told apart by code, not by status", () => {
  const rate = classifyAssistantError({ code: "AI_CHAT_RATE_LIMITED", statusCode: 429 });
  const monthly = classifyAssistantError({ code: "AI_MONTHLY_LIMIT_REACHED", statusCode: 429 });
  const budget = classifyAssistantError({ code: "AI_BUDGET_LIMIT_EXCEEDED", statusCode: 429 });

  assert.equal(rate.kind, "RATE_LIMITED");
  assert.equal(monthly.kind, "COST_GUARD");
  assert.equal(budget.kind, "COST_GUARD");
  assert.notEqual(rate.body, monthly.body);
});

test("a timeout is separated from a general outage", () => {
  assert.equal(
    classifyAssistantError({ code: "AI_CHAT_TIMEOUT", statusCode: 504 }).kind,
    "PROVIDER_TIMEOUT",
  );
  assert.equal(
    classifyAssistantError({ code: "API_ERROR", statusCode: 503 }).kind,
    "TEMPORARILY_UNAVAILABLE",
  );
});

test("an expired session is not an AI failure", () => {
  const s = classifyAssistantError({ code: "UNAUTHORIZED", statusCode: 401 });
  assert.equal(s.kind, "SESSION_EXPIRED");
  assert.equal(s.tone, "notice");
});

// ===========================================================================
// A 200 IS NOT AN ANSWER
// ===========================================================================
test("the provider's own caught failure is not rendered as advice", () => {
  // `OpenAiProvider.runInner` catches everything and returns HTTP 200 with
  // `status: "error"`, so this is the shape a real provider outage takes.
  const s = classifyAssistantResult("error");
  assert.equal(s.kind, "PROVIDER_ERROR");
  assert.equal(s.tone, "problem");
});

test("a refusal reads as a boundary, not as a breakage", () => {
  const s = classifyAssistantResult("blocked");
  assert.equal(s.kind, "SAFETY_BLOCKED");
  assert.equal(s.tone, "notice");
  assert.equal(s.canSend, true, "the next question may be perfectly answerable");
});

test("an ok result carries no banner", () => {
  assert.equal(classifyAssistantResult("ok").kind, "READY");
});

// ===========================================================================
// THE CONFIGURATION GAP IS THE ONE PARTIAL STATE
// ===========================================================================
test("a deployment with AI switched off still offers product answers", () => {
  for (const d of ["GLOBAL_DISABLED", "PROVIDER_NOT_CONFIGURED"]) {
    const s = denial(d);
    assert.equal(s.kind, "CONFIGURATION_ERROR");
    assert.equal(
      s.canSend,
      true,
      "the server answers product questions from compiled knowledge with no provider",
    );
  }
});

// ===========================================================================
// COPY RULES THAT APPLY TO EVERY STATE
// ===========================================================================
test("no state blames the reader or leaks operator instructions", () => {
  const all = [
    ...["WORKSPACE_DISABLED", "FEATURE_DISABLED", "ROLE_NOT_PERMITTED", "PLAN_NOT_ENTITLED",
      "DATA_CLASS_NOT_ALLOWED", "GLOBAL_DISABLED", "PROVIDER_NOT_CONFIGURED"].map(denial),
    classifyAssistantError({ code: "AI_CHAT_RATE_LIMITED", statusCode: 429 }),
    classifyAssistantError({ code: "AI_CHAT_TIMEOUT", statusCode: 504 }),
    classifyAssistantError({ code: "API_ERROR", statusCode: 500 }),
    classifyAssistantError({ code: "API_ERROR", statusCode: 400 }),
    classifyAssistantError({}),
    classifyAssistantResult("blocked"),
    classifyAssistantResult("error"),
    SENSITIVE_ROUTE_STATE,
  ];

  for (const s of all) {
    const text = `${s.title} ${s.body}`;
    // The Noop provider's own summary tells the reader to set environment
    // variables. That is operator instruction and must never reach a user.
    assert.doesNotMatch(text, /OPENAI_|API[_ ]key|env(ironment)? variable/i, s.kind);
    assert.ok(s.title.length > 0, `${s.kind} needs a title`);
    assert.ok(s.body.length > 0, `${s.kind} needs a body`);
  }
});

test("an unrecognised failure still says something true", () => {
  const s = classifyAssistantError({});
  assert.equal(s.kind, "UNKNOWN_ERROR");
  assert.ok(s.canSend, "an unknown cause may well be transient");
});
