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

test("instance statuses cover the lifecycle", () => {
  for (const s of [
    "DRAFT",
    "ACTIVE",
    "SUBMITTED",
    "NEEDS_REVIEW",
    "APPROVED",
    "REPORT_READY",
    "PACKAGE_READY",
    "SHARED_EXTERNALLY",
    "ARCHIVED",
    "RETAINED",
    "LEGAL_HOLD",
    "CANCELLED",
    "CHANGES_REQUESTED",
  ]) {
    assert.ok(WORKFLOW_INSTANCE_STATUSES.includes(s), s);
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

test("isTerminalWorkflowInstanceStatus: ARCHIVED/RETAINED/CANCELLED", () => {
  for (const s of ["ARCHIVED", "RETAINED", "CANCELLED"]) {
    assert.equal(isTerminalWorkflowInstanceStatus(s), true, s);
  }
  for (const s of ["DRAFT", "ACTIVE", "SUBMITTED", "APPROVED", "LEGAL_HOLD"]) {
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
// Transition allow-list
// -----------------------------------------------------------------------------

test("DRAFT → ACTIVE / CANCELLED / LEGAL_HOLD", () => {
  for (const next of ["ACTIVE", "CANCELLED", "LEGAL_HOLD"]) {
    assert.equal(
      isAllowedWorkflowInstanceTransition("DRAFT", next),
      true,
      `DRAFT -> ${next}`,
    );
  }
});

test("DRAFT cannot jump directly to SUBMITTED / APPROVED / SHARED_EXTERNALLY", () => {
  for (const next of [
    "SUBMITTED",
    "NEEDS_REVIEW",
    "APPROVED",
    "REPORT_READY",
    "PACKAGE_READY",
    "SHARED_EXTERNALLY",
  ]) {
    assert.equal(
      isAllowedWorkflowInstanceTransition("DRAFT", next),
      false,
      `DRAFT -> ${next}`,
    );
  }
});

test("SUBMITTED → NEEDS_REVIEW / CHANGES_REQUESTED / CANCELLED / LEGAL_HOLD", () => {
  for (const next of [
    "NEEDS_REVIEW",
    "CHANGES_REQUESTED",
    "CANCELLED",
    "LEGAL_HOLD",
  ]) {
    assert.equal(
      isAllowedWorkflowInstanceTransition("SUBMITTED", next),
      true,
      `SUBMITTED -> ${next}`,
    );
  }
  for (const next of ["DRAFT", "APPROVED", "SHARED_EXTERNALLY", "ARCHIVED"]) {
    assert.equal(
      isAllowedWorkflowInstanceTransition("SUBMITTED", next),
      false,
      `SUBMITTED -> ${next}`,
    );
  }
});

test("APPROVED → REPORT_READY → PACKAGE_READY → SHARED_EXTERNALLY", () => {
  assert.equal(
    isAllowedWorkflowInstanceTransition("APPROVED", "REPORT_READY"),
    true,
  );
  assert.equal(
    isAllowedWorkflowInstanceTransition("REPORT_READY", "PACKAGE_READY"),
    true,
  );
  assert.equal(
    isAllowedWorkflowInstanceTransition("PACKAGE_READY", "SHARED_EXTERNALLY"),
    true,
  );
});

test("APPROVED cannot skip directly to PACKAGE_READY", () => {
  assert.equal(
    isAllowedWorkflowInstanceTransition("APPROVED", "PACKAGE_READY"),
    false,
  );
});

test("LEGAL_HOLD can release to any prior non-terminal state", () => {
  for (const next of [
    "ACTIVE",
    "SUBMITTED",
    "NEEDS_REVIEW",
    "APPROVED",
    "REPORT_READY",
    "PACKAGE_READY",
    "SHARED_EXTERNALLY",
  ]) {
    assert.equal(
      isAllowedWorkflowInstanceTransition("LEGAL_HOLD", next),
      true,
      `LEGAL_HOLD -> ${next}`,
    );
  }
});

test("LEGAL_HOLD cannot move directly to ARCHIVED or CANCELLED", () => {
  for (const next of ["ARCHIVED", "RETAINED", "CANCELLED"]) {
    assert.equal(
      isAllowedWorkflowInstanceTransition("LEGAL_HOLD", next),
      false,
      `LEGAL_HOLD -> ${next}`,
    );
  }
});

test("Terminal states (ARCHIVED + CANCELLED) cannot transition", () => {
  for (const from of ["ARCHIVED", "CANCELLED"]) {
    for (const next of WORKFLOW_INSTANCE_STATUSES) {
      assert.equal(
        isAllowedWorkflowInstanceTransition(from, next),
        false,
        `${from} -> ${next}`,
      );
    }
  }
});

test("listAllowedWorkflowInstanceTransitions matches the allow-list", () => {
  assert.deepEqual(
    [...listAllowedWorkflowInstanceTransitions("DRAFT")].sort(),
    ["ACTIVE", "CANCELLED", "LEGAL_HOLD"],
  );
  assert.deepEqual(
    [...listAllowedWorkflowInstanceTransitions("ARCHIVED")],
    [],
  );
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
