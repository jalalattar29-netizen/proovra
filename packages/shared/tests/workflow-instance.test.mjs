import test from "node:test";
import assert from "node:assert/strict";

import {
  WORKFLOW_ACTOR_ROLES,
  WORKFLOW_ERROR_CODES,
  WORKFLOW_EXPORT_TARGETS,
  WORKFLOW_INSTANCE_STATUSES,
  WORKFLOW_STEP_IDENTITY_REQUIREMENTS,
  WORKFLOW_STEP_INSTANCE_STATUSES,
  WORKFLOW_STEP_UP_ACTIONS,
  WORKFLOW_TEMPLATE_STATUSES,
  WORKFLOW_VISIBILITY_TARGETS,
  isAllowedWorkflowInstanceTransition,
  isExternalActorRole,
  isReviewerOrAboveRole,
  isSatisfyingWorkflowStepStatus,
  isServiceAccountAllowedRole,
  isTerminalWorkflowInstanceStatus,
  isTerminalWorkflowStepStatus,
  listAllowedWorkflowInstanceTransitions,
} from "../dist/index.js";

// -----------------------------------------------------------------------------
// Catalogs
// -----------------------------------------------------------------------------

test("template statuses cover DRAFT/ACTIVE/ARCHIVED", () => {
  assert.deepEqual([...WORKFLOW_TEMPLATE_STATUSES].sort(), [
    "ACTIVE",
    "ARCHIVED",
    "DRAFT",
  ]);
});

test("Phase R — instance statuses contain ONLY the canonical six", () => {
  assert.deepEqual([...WORKFLOW_INSTANCE_STATUSES].sort(), [
    "APPROVED",
    "CANCELLED",
    "CHANGES_REQUESTED",
    "DRAFT",
    "NEEDS_REVIEW",
    "SUBMITTED",
  ]);
});

test("Phase R — retired statuses are NOT in the canonical enum", () => {
  for (const dead of [
    "ACTIVE",
    "REPORT_READY",
    "PACKAGE_READY",
    "SHARED_EXTERNALLY",
    "ARCHIVED",
    "RETAINED",
    "LEGAL_HOLD",
  ]) {
    assert.equal(
      WORKFLOW_INSTANCE_STATUSES.includes(dead),
      false,
      `${dead} must not be a canonical workflow instance status`,
    );
  }
});

test("step statuses cover NOT_STARTED → SATISFIED/WAIVED/FAILED", () => {
  for (const s of [
    "NOT_STARTED",
    "IN_PROGRESS",
    "SATISFIED",
    "NEEDS_ATTENTION",
    "WAIVED",
    "FAILED",
  ]) {
    assert.ok(WORKFLOW_STEP_INSTANCE_STATUSES.includes(s), s);
  }
});

test("actor roles cover workspace + external + service-account", () => {
  for (const r of [
    "WORKSPACE_OWNER",
    "WORKSPACE_ADMIN",
    "OPERATOR",
    "REVIEWER",
    "EXTERNAL_CONTRIBUTOR",
    "ANONYMOUS_SOURCE",
    "SERVICE_ACCOUNT",
  ]) {
    assert.ok(WORKFLOW_ACTOR_ROLES.includes(r), r);
  }
});

test("step-up actions cover sensitive workflow purposes", () => {
  for (const a of [
    "TEMPLATE_ACTIVATE",
    "TEMPLATE_ARCHIVE",
    "INSTANCE_CANCEL_AFTER_SUBMIT",
    "STEP_WAIVE_REQUIRED",
    "APPROVE_HIGH_RISK",
    "OVERRIDE_EXPORT_BLOCK",
    "PUBLISH_PUBLIC_VERIFICATION",
  ]) {
    assert.ok(WORKFLOW_STEP_UP_ACTIONS.includes(a), a);
  }
});

test("visibility + export target catalogs are exhaustive", () => {
  for (const t of [
    "AUTHENTICATED_APP",
    "EXTERNAL_CONTRIBUTOR",
    "PUBLIC_VERIFY",
    "REPORT",
    "VERIFICATION_PACKAGE",
  ]) {
    assert.ok(WORKFLOW_VISIBILITY_TARGETS.includes(t), t);
  }
  for (const t of [
    "REPORT",
    "VERIFICATION_PACKAGE",
    "ORIGINAL_DOWNLOAD",
    "PUBLIC_VERIFY",
    "INTEGRATION_API",
  ]) {
    assert.ok(WORKFLOW_EXPORT_TARGETS.includes(t), t);
  }
});

test("identity requirements include the per-step ladder", () => {
  for (const r of [
    "NONE",
    "EMAIL",
    "PHONE",
    "VERIFIED_PHONE",
    "WORKSPACE_MEMBER",
  ]) {
    assert.ok(WORKFLOW_STEP_IDENTITY_REQUIREMENTS.includes(r), r);
  }
});

test("error codes are stable", () => {
  for (const c of [
    "WORKFLOW_INVALID_TRANSITION",
    "WORKFLOW_GOVERNANCE_BLOCKED",
    "WORKFLOW_STEP_REQUIRED",
    "WORKFLOW_VISIBILITY_DENIED",
    "WORKFLOW_INSTANCE_NOT_FOUND",
    "WORKFLOW_LEGAL_HOLD_ACTIVE",
    "WORKFLOW_ACTOR_NOT_PERMITTED",
  ]) {
    assert.ok(WORKFLOW_ERROR_CODES.includes(c), c);
  }
});

// -----------------------------------------------------------------------------
// Status helpers
// -----------------------------------------------------------------------------

test("Phase R — isTerminalWorkflowInstanceStatus: APPROVED/CANCELLED", () => {
  for (const s of ["APPROVED", "CANCELLED"]) {
    assert.equal(isTerminalWorkflowInstanceStatus(s), true, s);
  }
  for (const s of ["DRAFT", "SUBMITTED", "NEEDS_REVIEW", "CHANGES_REQUESTED"]) {
    assert.equal(isTerminalWorkflowInstanceStatus(s), false, s);
  }
});

test("isTerminalWorkflowStepStatus: SATISFIED/WAIVED/FAILED", () => {
  for (const s of ["SATISFIED", "WAIVED", "FAILED"]) {
    assert.equal(isTerminalWorkflowStepStatus(s), true, s);
  }
  for (const s of ["NOT_STARTED", "IN_PROGRESS", "NEEDS_ATTENTION"]) {
    assert.equal(isTerminalWorkflowStepStatus(s), false, s);
  }
});

test("isSatisfyingWorkflowStepStatus: SATISFIED + WAIVED only", () => {
  assert.equal(isSatisfyingWorkflowStepStatus("SATISFIED"), true);
  assert.equal(isSatisfyingWorkflowStepStatus("WAIVED"), true);
  assert.equal(isSatisfyingWorkflowStepStatus("FAILED"), false);
  assert.equal(isSatisfyingWorkflowStepStatus("NOT_STARTED"), false);
});

// -----------------------------------------------------------------------------
// Actor role helpers
// -----------------------------------------------------------------------------

test("isExternalActorRole: EXTERNAL_CONTRIBUTOR + ANONYMOUS_SOURCE", () => {
  assert.equal(isExternalActorRole("EXTERNAL_CONTRIBUTOR"), true);
  assert.equal(isExternalActorRole("ANONYMOUS_SOURCE"), true);
  for (const r of [
    "WORKSPACE_OWNER",
    "WORKSPACE_ADMIN",
    "OPERATOR",
    "REVIEWER",
    "SERVICE_ACCOUNT",
  ]) {
    assert.equal(isExternalActorRole(r), false, r);
  }
});

test("isReviewerOrAboveRole: covers OWNER/ADMIN/OPERATOR/REVIEWER", () => {
  for (const r of ["WORKSPACE_OWNER", "WORKSPACE_ADMIN", "OPERATOR", "REVIEWER"]) {
    assert.equal(isReviewerOrAboveRole(r), true, r);
  }
  for (const r of ["EXTERNAL_CONTRIBUTOR", "ANONYMOUS_SOURCE", "SERVICE_ACCOUNT"]) {
    assert.equal(isReviewerOrAboveRole(r), false, r);
  }
});

test("isServiceAccountAllowedRole: only SERVICE_ACCOUNT", () => {
  assert.equal(isServiceAccountAllowedRole("SERVICE_ACCOUNT"), true);
  assert.equal(isServiceAccountAllowedRole("OPERATOR"), false);
});

// -----------------------------------------------------------------------------
// Transition allow-list (Phase R)
// -----------------------------------------------------------------------------

test("Phase R — DRAFT → SUBMITTED / CANCELLED only", () => {
  for (const next of ["SUBMITTED", "CANCELLED"]) {
    assert.equal(
      isAllowedWorkflowInstanceTransition("DRAFT", next),
      true,
      `DRAFT -> ${next}`,
    );
  }
  for (const dead of [
    "ACTIVE",
    "NEEDS_REVIEW",
    "APPROVED",
    "CHANGES_REQUESTED",
  ]) {
    assert.equal(
      isAllowedWorkflowInstanceTransition("DRAFT", dead),
      false,
      `DRAFT -> ${dead}`,
    );
  }
});

test("Phase R — SUBMITTED → NEEDS_REVIEW / CHANGES_REQUESTED / CANCELLED", () => {
  for (const next of ["NEEDS_REVIEW", "CHANGES_REQUESTED", "CANCELLED"]) {
    assert.equal(
      isAllowedWorkflowInstanceTransition("SUBMITTED", next),
      true,
      `SUBMITTED -> ${next}`,
    );
  }
  for (const dead of ["APPROVED", "DRAFT"]) {
    assert.equal(
      isAllowedWorkflowInstanceTransition("SUBMITTED", dead),
      false,
      `SUBMITTED -> ${dead}`,
    );
  }
});

test("Phase R — NEEDS_REVIEW → APPROVED / CHANGES_REQUESTED / CANCELLED", () => {
  for (const next of ["APPROVED", "CHANGES_REQUESTED", "CANCELLED"]) {
    assert.equal(
      isAllowedWorkflowInstanceTransition("NEEDS_REVIEW", next),
      true,
      `NEEDS_REVIEW -> ${next}`,
    );
  }
});

test("Phase R — CHANGES_REQUESTED can re-submit or cancel", () => {
  for (const next of ["SUBMITTED", "CANCELLED"]) {
    assert.equal(
      isAllowedWorkflowInstanceTransition("CHANGES_REQUESTED", next),
      true,
      `CHANGES_REQUESTED -> ${next}`,
    );
  }
});

test("Phase R — APPROVED and CANCELLED are terminal", () => {
  for (const from of ["APPROVED", "CANCELLED"]) {
    for (const next of WORKFLOW_INSTANCE_STATUSES) {
      assert.equal(
        isAllowedWorkflowInstanceTransition(from, next),
        false,
        `${from} -> ${next}`,
      );
    }
  }
});

test("Phase R — listAllowedWorkflowInstanceTransitions matches the allow-list", () => {
  assert.deepEqual(
    [...listAllowedWorkflowInstanceTransitions("DRAFT")].sort(),
    ["CANCELLED", "SUBMITTED"],
  );
  assert.deepEqual([...listAllowedWorkflowInstanceTransitions("APPROVED")], []);
  assert.deepEqual([...listAllowedWorkflowInstanceTransitions("CANCELLED")], []);
});

test("Self-transition is blocked for every status", () => {
  for (const s of WORKFLOW_INSTANCE_STATUSES) {
    assert.equal(
      isAllowedWorkflowInstanceTransition(s, s),
      false,
      `${s} -> ${s}`,
    );
  }
});
