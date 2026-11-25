// Round 2 (2026-11-25) — the ONE Start rule the /start door and the Review page
// offer share: the stage rule, plus the handover case on an in-review review.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewStartRefusal, reviewWasHandedOver } from "../dist/index.js";

test("Start from an in-review review is refused unless it was handed over", () => {
  assert.equal(reviewStartRefusal("IN_REVIEW", false), "already_started");
  assert.equal(reviewStartRefusal("IN_REVIEW", true), null);
});

test("Start from other stages follows the stage matrix; the handover fact changes nothing there", () => {
  for (const stage of ["ASSIGNED", "ESCALATED", "RESPONSE_RECEIVED", "NEEDS_MORE_INFO", "REOPENED"]) {
    assert.equal(reviewStartRefusal(stage, false), null, stage);
    assert.equal(reviewStartRefusal(stage, true), null, stage);
  }
  for (const stage of ["APPROVED_INTERNAL", "REJECTED_INSUFFICIENT", "CLOSED"]) {
    assert.equal(reviewStartRefusal(stage, true), "invalid_stage_transition", stage);
  }
});

test("a handover needs a recorded Start by someone other than the assignee", () => {
  assert.equal(reviewWasHandedOver({ assignedToUserId: "b", latestStartActorUserId: "a" }), true);
  assert.equal(reviewWasHandedOver({ assignedToUserId: "a", latestStartActorUserId: "a" }), false);
  assert.equal(reviewWasHandedOver({ assignedToUserId: "a", latestStartActorUserId: null }), false);
  assert.equal(reviewWasHandedOver({ assignedToUserId: null, latestStartActorUserId: "a" }), false);
});
