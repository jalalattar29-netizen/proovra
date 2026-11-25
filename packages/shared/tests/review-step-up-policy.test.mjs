import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// T-030 / T-031 / T-036 / T-040 — the review step-up policy is data, and the
// security doc matches it.

import {
  PRIVILEGED_ACTION_REQUIRES_FRESH_AUTH_HOURS,
  REVIEW_ACTIONS_WITHOUT_STEP_UP,
  REVIEW_GATE_TABLE,
  REVIEW_GOVERNED_ACTIONS,
  REVIEW_STEP_UP_FLAG_KEYS,
  STEP_UP_PURPOSES,
  classifyReviewBulkRequest,
  reviewGateSessionWindowHours,
  reviewStepUpFlagGoverns,
  reauthRequiredSentence,
  stepUpEnrollmentSentence,
  stepUpReasonSentence,
  userFacingErrorFor,
} from "../dist/index.js";

const doc = readFileSync(
  fileURLToPath(new URL("../../../docs/security/review-step-up-action-matrix.md", import.meta.url)),
  "utf8",
);

test("T-031: each checkbox lists what it governs; Close, Reopen, Archive and Suppress are named", () => {
  assert.deepEqual(reviewStepUpFlagGoverns("requireStepUpForReject"), [
    "Reject a review",
    "Close a review from the Evidence page",
    "Reopen a review from the Evidence page",
    "Archive one review (close it without a decision)",
  ]);
  assert.deepEqual(reviewStepUpFlagGoverns("requireStepUpForEscalationResolve"), [
    "Resolve an escalation",
    "Suppress an escalation",
  ]);
  assert.ok(reviewStepUpFlagGoverns("requireStepUpForApprove").includes("Approve a review"));
  assert.ok(reviewStepUpFlagGoverns("requireStepUpForBulk").includes("Bulk decisions and bulk close"));
  for (const flag of REVIEW_STEP_UP_FLAG_KEYS) assert.ok(reviewStepUpFlagGoverns(flag).length > 0, flag);
});

test("T-030: single archive is its own class under the reject flag with the 8 h window", () => {
  assert.equal(REVIEW_GATE_TABLE.archive.flag, "requireStepUpForReject");
  assert.equal(REVIEW_GATE_TABLE.archive.purpose, "REVIEWER_OPS_ARCHIVE");
  assert.ok(STEP_UP_PURPOSES.includes("REVIEWER_OPS_ARCHIVE"));
  assert.equal(reviewGateSessionWindowHours("archive"), 8);
  assert.equal(reviewGateSessionWindowHours("bulk"), 4);
  assert.equal(PRIVILEGED_ACTION_REQUIRES_FRESH_AUTH_HOURS.REVIEWER_ARCHIVE, 8);
  assert.equal(classifyReviewBulkRequest({ action: "CLOSE", itemCount: 1, scope: "single" }), "archive");
  assert.equal(classifyReviewBulkRequest({ action: "CLOSE", itemCount: 1 }), "bulk");
  assert.equal(classifyReviewBulkRequest({ action: "CLOSE", itemCount: 2, scope: "single" }), "bulk");
});

test("T-036: assignment, single or bulk, is never a step-up class", () => {
  for (const action of ["ASSIGN", "REASSIGN", "assign"]) {
    for (const itemCount of [1, 5]) {
      assert.equal(classifyReviewBulkRequest({ action, itemCount }), "assignment");
    }
  }
  assert.equal(classifyReviewBulkRequest({ action: "DECIDE", itemCount: 3 }), "bulk");
  assert.ok(REVIEW_ACTIONS_WITHOUT_STEP_UP.some((a) => /assign/i.test(a)));
});

test("T-040: the action matrix documents revoke as no step-up (protective) and lists every row", () => {
  assert.match(doc, /Revoke an external reviewer or a share link \| \*\*no step-up \(protective\)\*\*/);
  for (const row of REVIEW_GOVERNED_ACTIONS) assert.ok(doc.includes(`| ${row.label} |`), row.label);
  for (const label of REVIEW_ACTIONS_WITHOUT_STEP_UP) assert.ok(doc.includes(`| ${label} |`), label);
});

test("T-028/T-029: every reason has a sentence; reauth is never 'session expired'", () => {
  for (const flag of REVIEW_STEP_UP_FLAG_KEYS) assert.ok(stepUpReasonSentence(`policy_flag:${flag}`));
  for (const r of ["elevated_session_risk", "high_session_risk", "session_age_window", "legacy_session", "save_policy_requires_mfa"]) {
    assert.ok(stepUpReasonSentence(r), r);
  }
  assert.equal(stepUpReasonSentence("raw_unknown_value"), null);
  const reauth = userFacingErrorFor("reauth_required");
  assert.ok(reauth);
  assert.match(reauth.message, /still signed in/i);
  assert.doesNotMatch(reauth.message, /expired/i);
  assert.match(reauthRequiredSentence({ reason: "session_age_window", windowHours: 8 }), /last 8 hours/);
  assert.match(stepUpEnrollmentSentence("elevated_session_risk"), /unusual sign-in activity/);
  assert.match(stepUpEnrollmentSentence(null), /password again does not replace it/);
});
