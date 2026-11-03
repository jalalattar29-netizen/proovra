import test from "node:test";
import assert from "node:assert/strict";

// RT-011 — review pages printed the denial code itself ("Coding refused:
// NOT_ASSIGNED"). Every bounded reason has a sentence, and none is a code.
import { REVIEWER_DENIAL_REASONS, reviewerDenialMessage } from "../dist/index.js";

test("every reviewer denial reason reads as a sentence, never as its code", () => {
  for (const reason of REVIEWER_DENIAL_REASONS) {
    const message = reviewerDenialMessage(reason);
    assert.ok(message.length > 10, reason);
    assert.doesNotMatch(message, /[A-Z]{3,}_[A-Z_]+/, reason);
    assert.ok(message.endsWith("."), reason);
  }
});

test("an unknown or missing code reads as a plain refusal", () => {
  assert.equal(reviewerDenialMessage("SOMETHING_NEW"), "The request was refused.");
  assert.equal(reviewerDenialMessage(null), "The request was refused.");
});
