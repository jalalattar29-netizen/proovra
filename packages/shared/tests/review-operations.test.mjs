import test from "node:test";
import assert from "node:assert/strict";

// Phase 13 — Review operations shared-type contract tests.
//
// Coverage:
//   - stage catalog
//   - transition matrix (positive + negative)
//   - decision types + decisions-requiring-note
//   - target-stage mapping
//   - legacy DB status mapping
//   - SLA computation
//   - governance gate predicate
//   - notification event types include Phase 13 additions

import {
  NOTIFICATION_EVENT_TYPES,
  REVIEW_DECISIONS_REQUIRING_NOTE,
  REVIEW_DECISION_TYPES,
  REVIEW_SLA_STATUSES,
  REVIEW_STAGES,
  REVIEW_STAGE_TERMINAL,
  computeReviewSlaStatus,
  decisionRequiresNote,
  decisionTargetStage,
  isAllowedReviewStageTransition,
  isTerminalReviewStage,
  listAllowedReviewStageTransitions,
  mapDbStatusToReviewStage,
  reviewStageSatisfiesGovernanceGate,
} from "../dist/index.js";

// -----------------------------------------------------------------------------
// Catalog
// -----------------------------------------------------------------------------

test("REVIEW_STAGES has the ten canonical Phase 13 stages", () => {
  assert.deepEqual([...REVIEW_STAGES].sort(), [
    "APPROVED_INTERNAL",
    "ASSIGNED",
    "CLOSED",
    "ESCALATED",
    "IN_REVIEW",
    "NEEDS_MORE_INFO",
    "QUEUED",
    "REJECTED_INSUFFICIENT",
    "REOPENED",
    "RESPONSE_RECEIVED",
  ]);
});

test("CLOSED is the only auto-terminal stage", () => {
  assert.deepEqual([...REVIEW_STAGE_TERMINAL], ["CLOSED"]);
  assert.equal(isTerminalReviewStage("CLOSED"), true);
  assert.equal(isTerminalReviewStage("APPROVED_INTERNAL"), false);
  assert.equal(isTerminalReviewStage("REJECTED_INSUFFICIENT"), false);
});

test("only APPROVED_INTERNAL satisfies the governance gate", () => {
  for (const s of REVIEW_STAGES) {
    const expected = s === "APPROVED_INTERNAL";
    assert.equal(
      reviewStageSatisfiesGovernanceGate(s),
      expected,
      `${s} should ${expected ? "satisfy" : "not satisfy"} the gate`,
    );
  }
});

// -----------------------------------------------------------------------------
// Transitions
// -----------------------------------------------------------------------------

test("QUEUED → IN_REVIEW is allowed", () => {
  assert.equal(isAllowedReviewStageTransition("QUEUED", "IN_REVIEW"), true);
});

test("QUEUED → APPROVED_INTERNAL is NOT allowed (must pass through review)", () => {
  assert.equal(
    isAllowedReviewStageTransition("QUEUED", "APPROVED_INTERNAL"),
    false,
  );
});

test("CLOSED → REOPENED is allowed (reopen flow)", () => {
  assert.equal(isAllowedReviewStageTransition("CLOSED", "REOPENED"), true);
});

test("APPROVED_INTERNAL → REOPENED is allowed (dispute flow)", () => {
  assert.equal(
    isAllowedReviewStageTransition("APPROVED_INTERNAL", "REOPENED"),
    true,
  );
});

test("REJECTED_INSUFFICIENT → REOPENED is allowed", () => {
  assert.equal(
    isAllowedReviewStageTransition("REJECTED_INSUFFICIENT", "REOPENED"),
    true,
  );
});

test("REOPENED → IN_REVIEW is allowed", () => {
  assert.equal(isAllowedReviewStageTransition("REOPENED", "IN_REVIEW"), true);
});

test("self-transitions are heartbeats (allowed)", () => {
  for (const s of REVIEW_STAGES) {
    assert.equal(isAllowedReviewStageTransition(s, s), true);
  }
});

test("listAllowedReviewStageTransitions returns matrix slice", () => {
  const fromInReview = listAllowedReviewStageTransitions("IN_REVIEW");
  assert.ok(fromInReview.includes("APPROVED_INTERNAL"));
  assert.ok(fromInReview.includes("REJECTED_INSUFFICIENT"));
  assert.ok(!fromInReview.includes("QUEUED"));
});

// -----------------------------------------------------------------------------
// Decisions
// -----------------------------------------------------------------------------

test("REVIEW_DECISION_TYPES has the six canonical decisions", () => {
  assert.deepEqual([...REVIEW_DECISION_TYPES].sort(), [
    "APPROVE_INTERNAL",
    "CLOSE",
    "ESCALATE",
    "REJECT_INSUFFICIENT",
    "REOPEN",
    "REQUEST_MORE_INFO",
  ]);
});

test("decisionTargetStage maps each decision to its target stage", () => {
  assert.equal(decisionTargetStage("APPROVE_INTERNAL"), "APPROVED_INTERNAL");
  assert.equal(decisionTargetStage("REQUEST_MORE_INFO"), "NEEDS_MORE_INFO");
  assert.equal(decisionTargetStage("REJECT_INSUFFICIENT"), "REJECTED_INSUFFICIENT");
  assert.equal(decisionTargetStage("ESCALATE"), "ESCALATED");
  assert.equal(decisionTargetStage("REOPEN"), "REOPENED");
  assert.equal(decisionTargetStage("CLOSE"), "CLOSED");
});

test("note-requiring decisions: REJECT/ESCALATE/REOPEN", () => {
  assert.equal(decisionRequiresNote("REJECT_INSUFFICIENT"), true);
  assert.equal(decisionRequiresNote("ESCALATE"), true);
  assert.equal(decisionRequiresNote("REOPEN"), true);
  assert.equal(decisionRequiresNote("APPROVE_INTERNAL"), false);
  assert.equal(decisionRequiresNote("REQUEST_MORE_INFO"), false);
  assert.equal(decisionRequiresNote("CLOSE"), false);
  assert.deepEqual([...REVIEW_DECISIONS_REQUIRING_NOTE].sort(), [
    "ESCALATE",
    "REJECT_INSUFFICIENT",
    "REOPEN",
  ]);
});

// -----------------------------------------------------------------------------
// Legacy DB status mapping
// -----------------------------------------------------------------------------

test("mapDbStatusToReviewStage handles legacy + new statuses", () => {
  assert.equal(mapDbStatusToReviewStage("NOT_STARTED"), "QUEUED");
  assert.equal(mapDbStatusToReviewStage("NEEDS_INFO"), "NEEDS_MORE_INFO");
  assert.equal(
    mapDbStatusToReviewStage("READY_FOR_EXTERNAL_REVIEW"),
    "APPROVED_INTERNAL",
  );
  assert.equal(mapDbStatusToReviewStage("APPROVED_INTERNAL"), "APPROVED_INTERNAL");
  assert.equal(mapDbStatusToReviewStage("QUEUED"), "QUEUED");
  assert.equal(mapDbStatusToReviewStage("ASSIGNED"), "ASSIGNED");
  assert.equal(mapDbStatusToReviewStage("RESPONSE_RECEIVED"), "RESPONSE_RECEIVED");
  assert.equal(
    mapDbStatusToReviewStage("REJECTED_INSUFFICIENT"),
    "REJECTED_INSUFFICIENT",
  );
  assert.equal(mapDbStatusToReviewStage("REOPENED"), "REOPENED");
  assert.equal(mapDbStatusToReviewStage(null), "QUEUED");
  assert.equal(mapDbStatusToReviewStage("nonsense"), "QUEUED");
});

// -----------------------------------------------------------------------------
// SLA computation
// -----------------------------------------------------------------------------

const now = new Date("2026-05-21T12:00:00Z");

test("SLA returns null when no due date is configured", () => {
  assert.equal(
    computeReviewSlaStatus({ dueAtUtc: null, nowUtc: now }),
    null,
  );
});

test("SLA — ON_TRACK when due is far in the future", () => {
  assert.equal(
    computeReviewSlaStatus({
      dueAtUtc: new Date("2026-05-25T12:00:00Z"),
      nowUtc: now,
    }),
    "ON_TRACK",
  );
});

test("SLA — DUE_SOON when due is within the configured window", () => {
  assert.equal(
    computeReviewSlaStatus({
      dueAtUtc: new Date("2026-05-21T12:30:00Z"),
      nowUtc: now,
      dueSoonMinutes: 60,
    }),
    "DUE_SOON",
  );
});

test("SLA — OVERDUE when past due but within breach window", () => {
  assert.equal(
    computeReviewSlaStatus({
      dueAtUtc: new Date("2026-05-21T11:30:00Z"),
      nowUtc: now,
      breachAfterMinutes: 60 * 24,
    }),
    "OVERDUE",
  );
});

test("SLA — BREACHED when past due beyond breach window", () => {
  assert.equal(
    computeReviewSlaStatus({
      dueAtUtc: new Date("2026-05-19T12:00:00Z"),
      nowUtc: now,
      breachAfterMinutes: 60 * 24,
    }),
    "BREACHED",
  );
});

test("SLA — PAUSED short-circuits everything", () => {
  assert.equal(
    computeReviewSlaStatus({
      dueAtUtc: new Date("2026-05-01T12:00:00Z"),
      nowUtc: now,
      paused: true,
    }),
    "PAUSED",
  );
});

test("SLA — completed before due is ON_TRACK regardless of timing", () => {
  assert.equal(
    computeReviewSlaStatus({
      dueAtUtc: new Date("2026-05-25T12:00:00Z"),
      completedAtUtc: new Date("2026-05-20T12:00:00Z"),
      nowUtc: now,
    }),
    "ON_TRACK",
  );
});

// -----------------------------------------------------------------------------
// Notifications
// -----------------------------------------------------------------------------

test("Phase 13 notification event types are registered", () => {
  for (const t of [
    "REVIEW_REASSIGNED",
    "REVIEW_ESCALATED",
    "REVIEW_OVERDUE_REMINDER",
    "REVIEW_NEEDS_MORE_INFO",
    "REVIEW_RESPONSE_RECEIVED",
  ]) {
    assert.ok(
      NOTIFICATION_EVENT_TYPES.includes(t),
      `${t} should be in NOTIFICATION_EVENT_TYPES`,
    );
  }
});

test("SLA status enum has the five canonical values", () => {
  assert.deepEqual([...REVIEW_SLA_STATUSES].sort(), [
    "BREACHED",
    "DUE_SOON",
    "ON_TRACK",
    "OVERDUE",
    "PAUSED",
  ]);
});
