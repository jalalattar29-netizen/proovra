/**
 * Phase 9.5 — pure logic tests for governance enforcement decisions.
 *
 * Mirrors the canDeleteEvidence / canGenerateReport / canGeneratePackage /
 * canPublishPublicVerify / canCreateIntakeLink / resolveRetentionOnCreate
 * shapes from services/api/src/services/governance.service.ts.
 *
 * No DB. The tests pin the documented decision matrix.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { roleHasPermission } from "../dist/index.js";

// -----------------------------------------------------------------------------
// Pure mirrors of governance decision helpers
// -----------------------------------------------------------------------------

function canDeleteEvidence({ role, evidence, policy, hasActiveLegalHold, now }) {
  if (!roleHasPermission(role, "evidence.delete")) {
    return { allowed: false, reason: `role_${role}_lacks_evidence.delete` };
  }
  if (policy.evidenceDeletionMode === "DISABLED") {
    return { allowed: false, reason: "deletion_disabled_by_policy" };
  }
  if (
    policy.evidenceDeletionMode === "ADMIN_ONLY" &&
    role !== "OWNER" &&
    role !== "ADMIN"
  ) {
    return { allowed: false, reason: "deletion_restricted_to_admin" };
  }
  if (
    evidence.retentionUntilUtc &&
    evidence.retentionUntilUtc.getTime() > now.getTime()
  ) {
    return { allowed: false, reason: "blocked_by_retention" };
  }
  if (hasActiveLegalHold) {
    return { allowed: false, reason: "blocked_by_legal_hold" };
  }
  return { allowed: true };
}

function canGenerateReport({ role, policy, isReviewed }) {
  if (!roleHasPermission(role, "evidence.generate_report")) {
    return { allowed: false, reason: `role_${role}_lacks_evidence.generate_report` };
  }
  if (policy.requireReviewBeforeReport && !isReviewed) {
    return { allowed: false, reason: "review_required_before_report" };
  }
  if (!policy.allowReportDownload) {
    return { allowed: false, reason: "report_disabled_by_policy" };
  }
  return { allowed: true };
}

function canGeneratePackage({ role, policy, isReviewed }) {
  if (!roleHasPermission(role, "evidence.generate_package")) {
    return { allowed: false, reason: `role_${role}_lacks_evidence.generate_package` };
  }
  if (policy.requireReviewBeforePackage && !isReviewed) {
    return { allowed: false, reason: "review_required_before_package" };
  }
  if (!policy.allowPackageDownload) {
    return { allowed: false, reason: "package_disabled_by_policy" };
  }
  return { allowed: true };
}

function canPublishPublicVerify({ role, policy, isReviewed }) {
  if (!roleHasPermission(role, "evidence.publish_verify")) {
    return { allowed: false, reason: `role_${role}_lacks_evidence.publish_verify` };
  }
  if (policy.requireReviewBeforePublicVerify && !isReviewed) {
    return { allowed: false, reason: "review_required_before_public_verify" };
  }
  if (!policy.allowPublicVerify) {
    return { allowed: false, reason: "public_verify_disabled_by_policy" };
  }
  return { allowed: true };
}

function resolveRetentionOnCreate({
  defaultRetentionDays,
  existingRetentionUntilUtc,
  now,
}) {
  if (!defaultRetentionDays || defaultRetentionDays <= 0) return null;
  const policyRetention = new Date(
    now.getTime() + defaultRetentionDays * 24 * 3600 * 1000,
  );
  if (
    existingRetentionUntilUtc &&
    existingRetentionUntilUtc.getTime() >= policyRetention.getTime()
  ) {
    return null;
  }
  return { retentionUntilUtc: policyRetention, source: "workspace_policy" };
}

// -----------------------------------------------------------------------------
// Default permissive policy fixture
// -----------------------------------------------------------------------------

function defaultPolicy(overrides = {}) {
  return {
    defaultRetentionDays: null,
    evidenceDeletionMode: "ALLOWED",
    requireLegalHoldApprovalForDeletion: false,
    requireReviewBeforeReport: false,
    requireReviewBeforePackage: false,
    requireReviewBeforePublicVerify: false,
    allowExternalIntake: true,
    allowAnonymousIntake: true,
    allowPublicVerify: true,
    allowPackageDownload: true,
    allowReportDownload: true,
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Delete
// -----------------------------------------------------------------------------

test("delete allowed for ADMIN under default policy with no holds and no retention", () => {
  const r = canDeleteEvidence({
    role: "ADMIN",
    evidence: { retentionUntilUtc: null },
    policy: defaultPolicy(),
    hasActiveLegalHold: false,
    now: new Date(),
  });
  assert.equal(r.allowed, true);
});

test("delete blocked when policy is DISABLED", () => {
  const r = canDeleteEvidence({
    role: "ADMIN",
    evidence: { retentionUntilUtc: null },
    policy: defaultPolicy({ evidenceDeletionMode: "DISABLED" }),
    hasActiveLegalHold: false,
    now: new Date(),
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "deletion_disabled_by_policy");
});

test("delete blocked for MEMBER when policy is ADMIN_ONLY", () => {
  const r = canDeleteEvidence({
    role: "MEMBER",
    evidence: { retentionUntilUtc: null },
    policy: defaultPolicy({ evidenceDeletionMode: "ADMIN_ONLY" }),
    hasActiveLegalHold: false,
    now: new Date(),
  });
  assert.equal(r.allowed, false);
});

test("delete blocked by retention when retentionUntilUtc is in the future", () => {
  const r = canDeleteEvidence({
    role: "ADMIN",
    evidence: {
      retentionUntilUtc: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    },
    policy: defaultPolicy(),
    hasActiveLegalHold: false,
    now: new Date(),
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "blocked_by_retention");
});

test("delete blocked by legal hold even when retention has expired", () => {
  const r = canDeleteEvidence({
    role: "ADMIN",
    evidence: {
      retentionUntilUtc: new Date(Date.now() - 86400000),
    },
    policy: defaultPolicy(),
    hasActiveLegalHold: true,
    now: new Date(),
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "blocked_by_legal_hold");
});

test("delete blocked for VIEWER regardless of policy", () => {
  const r = canDeleteEvidence({
    role: "VIEWER",
    evidence: { retentionUntilUtc: null },
    policy: defaultPolicy(),
    hasActiveLegalHold: false,
    now: new Date(),
  });
  assert.equal(r.allowed, false);
});

// -----------------------------------------------------------------------------
// Report
// -----------------------------------------------------------------------------

test("report allowed under default policy for MEMBER", () => {
  const r = canGenerateReport({
    role: "MEMBER",
    policy: defaultPolicy(),
    isReviewed: false,
  });
  assert.equal(r.allowed, true);
});

test("report blocked when allowReportDownload=false", () => {
  const r = canGenerateReport({
    role: "ADMIN",
    policy: defaultPolicy({ allowReportDownload: false }),
    isReviewed: true,
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "report_disabled_by_policy");
});

test("report blocked when requireReviewBeforeReport=true and not reviewed", () => {
  const r = canGenerateReport({
    role: "ADMIN",
    policy: defaultPolicy({ requireReviewBeforeReport: true }),
    isReviewed: false,
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "review_required_before_report");
});

test("report allowed when requireReviewBeforeReport=true and IS reviewed", () => {
  const r = canGenerateReport({
    role: "ADMIN",
    policy: defaultPolicy({ requireReviewBeforeReport: true }),
    isReviewed: true,
  });
  assert.equal(r.allowed, true);
});

// -----------------------------------------------------------------------------
// Package
// -----------------------------------------------------------------------------

test("package allowed under default policy", () => {
  const r = canGeneratePackage({
    role: "MEMBER",
    policy: defaultPolicy(),
    isReviewed: false,
  });
  assert.equal(r.allowed, true);
});

test("package blocked when allowPackageDownload=false", () => {
  const r = canGeneratePackage({
    role: "ADMIN",
    policy: defaultPolicy({ allowPackageDownload: false }),
    isReviewed: true,
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "package_disabled_by_policy");
});

test("package blocked when requireReviewBeforePackage=true and not reviewed", () => {
  const r = canGeneratePackage({
    role: "ADMIN",
    policy: defaultPolicy({ requireReviewBeforePackage: true }),
    isReviewed: false,
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "review_required_before_package");
});

// -----------------------------------------------------------------------------
// Public verify publish
// -----------------------------------------------------------------------------

test("publish blocked when allowPublicVerify=false", () => {
  const r = canPublishPublicVerify({
    role: "ADMIN",
    policy: defaultPolicy({ allowPublicVerify: false }),
    isReviewed: true,
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "public_verify_disabled_by_policy");
});

test("publish blocked when requireReviewBeforePublicVerify=true and not reviewed", () => {
  const r = canPublishPublicVerify({
    role: "ADMIN",
    policy: defaultPolicy({ requireReviewBeforePublicVerify: true }),
    isReviewed: false,
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "review_required_before_public_verify");
});

// -----------------------------------------------------------------------------
// Retention application
// -----------------------------------------------------------------------------

test("retention not applied when policy has no defaultRetentionDays", () => {
  const r = resolveRetentionOnCreate({
    defaultRetentionDays: null,
    existingRetentionUntilUtc: null,
    now: new Date(),
  });
  assert.equal(r, null);
});

test("retention applied when policy has a positive value and no existing retention", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const r = resolveRetentionOnCreate({
    defaultRetentionDays: 90,
    existingRetentionUntilUtc: null,
    now,
  });
  assert.ok(r);
  const expected = new Date(now.getTime() + 90 * 24 * 3600 * 1000);
  assert.equal(r.retentionUntilUtc.getTime(), expected.getTime());
  assert.equal(r.source, "workspace_policy");
});

test("retention does NOT shorten an existing longer explicit retention", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const existing = new Date("2027-01-01T00:00:00Z"); // 365 days later
  const r = resolveRetentionOnCreate({
    defaultRetentionDays: 90, // 90 days < 365
    existingRetentionUntilUtc: existing,
    now,
  });
  assert.equal(r, null);
});

test("retention extends a shorter existing retention", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const existing = new Date("2026-02-01T00:00:00Z"); // 31 days
  const r = resolveRetentionOnCreate({
    defaultRetentionDays: 90,
    existingRetentionUntilUtc: existing,
    now,
  });
  assert.ok(r);
  assert.equal(
    r.retentionUntilUtc.getTime(),
    new Date(now.getTime() + 90 * 24 * 3600 * 1000).getTime(),
  );
});

test("retention with zero or negative days is ignored", () => {
  for (const d of [0, -1, -100]) {
    const r = resolveRetentionOnCreate({
      defaultRetentionDays: d,
      existingRetentionUntilUtc: null,
      now: new Date(),
    });
    assert.equal(r, null);
  }
});

// -----------------------------------------------------------------------------
// Privacy / permission gating
// -----------------------------------------------------------------------------

test("external roles cannot generate reports under any policy", () => {
  const r = canGenerateReport({
    role: "EXTERNAL_CONTRIBUTOR",
    policy: defaultPolicy(),
    isReviewed: true,
  });
  assert.equal(r.allowed, false);
});

test("VIEWER cannot generate report (lacks evidence.generate_report)", () => {
  const r = canGenerateReport({
    role: "VIEWER",
    policy: defaultPolicy(),
    isReviewed: true,
  });
  assert.equal(r.allowed, false);
});
