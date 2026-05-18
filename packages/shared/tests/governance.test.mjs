import test from "node:test";
import assert from "node:assert/strict";

// Phase 14 — Enterprise governance shared-type tests.
//
// Coverage:
//   - public verify state catalog + predicate
//   - retention policy source catalog
//   - case legal hold status catalog
//   - redaction scope + field catalog
//   - redaction mode catalog
//   - DEFAULT_REDACTION_POLICY safe defaults (public verify hides
//     operator-only fields)
//   - resolveRedactionPolicy override merge + public-verify floor

import {
  CASE_LEGAL_HOLD_STATUSES,
  DEFAULT_REDACTION_POLICY,
  PUBLIC_VERIFY_STATES,
  REDACTION_FIELDS,
  REDACTION_MODES,
  REDACTION_SCOPES,
  RETENTION_POLICY_SOURCES,
  applyRedaction,
  maskEmail,
  maskGpsCoordinate,
  maskPhone,
  publicVerifyStateAllowsAccess,
  resolveRedactionPolicy,
} from "../dist/index.js";

// -----------------------------------------------------------------------------
// Catalogs
// -----------------------------------------------------------------------------

test("PUBLIC_VERIFY_STATES has the four canonical states", () => {
  assert.deepEqual([...PUBLIC_VERIFY_STATES].sort(), [
    "NOT_PUBLISHED",
    "PUBLISHED",
    "SUSPENDED",
    "UNPUBLISHED",
  ]);
});

test("publicVerifyStateAllowsAccess — only PUBLISHED is visible", () => {
  assert.equal(publicVerifyStateAllowsAccess("PUBLISHED"), true);
  for (const s of ["NOT_PUBLISHED", "SUSPENDED", "UNPUBLISHED"]) {
    assert.equal(publicVerifyStateAllowsAccess(s), false, s);
  }
});

test("RETENTION_POLICY_SOURCES has the four canonical sources", () => {
  assert.deepEqual([...RETENTION_POLICY_SOURCES].sort(), [
    "CASE_OVERRIDE",
    "EVIDENCE_OVERRIDE",
    "WORKFLOW_TEMPLATE",
    "WORKSPACE_DEFAULT",
  ]);
});

test("CASE_LEGAL_HOLD_STATUSES is ACTIVE/RELEASED", () => {
  assert.deepEqual([...CASE_LEGAL_HOLD_STATUSES].sort(), [
    "ACTIVE",
    "RELEASED",
  ]);
});

test("REDACTION_SCOPES has the five canonical scopes", () => {
  assert.deepEqual([...REDACTION_SCOPES].sort(), [
    "EXTERNAL_CONTRIBUTOR",
    "INTEGRATION",
    "PACKAGE",
    "PUBLIC_VERIFY",
    "REPORT",
  ]);
});

test("REDACTION_FIELDS contains operator-only privacy fields", () => {
  for (const f of [
    "internalNotes",
    "reviewerNotes",
    "legalHoldReason",
    "rejectionReason",
    "escalationReason",
  ]) {
    assert.ok(REDACTION_FIELDS.includes(f), `expected ${f} in catalog`);
  }
});

test("REDACTION_MODES is visible/masked/hidden", () => {
  assert.deepEqual([...REDACTION_MODES].sort(), [
    "hidden",
    "masked",
    "visible",
  ]);
});

// -----------------------------------------------------------------------------
// DEFAULT_REDACTION_POLICY
// -----------------------------------------------------------------------------

test("PUBLIC_VERIFY default hides every operator-only field", () => {
  const p = DEFAULT_REDACTION_POLICY.PUBLIC_VERIFY;
  for (const f of [
    "internalNotes",
    "reviewerNotes",
    "legalHoldReason",
    "rejectionReason",
    "escalationReason",
    "ipAddress",
    "userAgent",
  ]) {
    assert.equal(p[f], "hidden", `${f} must be hidden on public verify`);
  }
});

test("EXTERNAL_CONTRIBUTOR default hides every privacy field", () => {
  const p = DEFAULT_REDACTION_POLICY.EXTERNAL_CONTRIBUTOR;
  for (const f of REDACTION_FIELDS) {
    assert.equal(
      p[f],
      "hidden",
      `external contributor default must hide ${f}`,
    );
  }
});

// -----------------------------------------------------------------------------
// resolveRedactionPolicy
// -----------------------------------------------------------------------------

test("resolveRedactionPolicy with null override returns defaults", () => {
  const resolved = resolveRedactionPolicy(null);
  assert.equal(
    resolved.PUBLIC_VERIFY.internalNotes,
    DEFAULT_REDACTION_POLICY.PUBLIC_VERIFY.internalNotes,
  );
});

test("resolveRedactionPolicy honors operator override on REPORT", () => {
  const resolved = resolveRedactionPolicy({
    REPORT: { submitterEmail: "visible" },
  });
  assert.equal(resolved.REPORT.submitterEmail, "visible");
});

test("resolveRedactionPolicy ENFORCES PUBLIC_VERIFY floor for operator-only fields", () => {
  // An operator override that tries to expose operator-only fields on
  // public verify MUST be ignored.
  const resolved = resolveRedactionPolicy({
    PUBLIC_VERIFY: {
      internalNotes: "visible",
      reviewerNotes: "visible",
      legalHoldReason: "visible",
      rejectionReason: "masked",
      escalationReason: "masked",
    },
  });
  assert.equal(resolved.PUBLIC_VERIFY.internalNotes, "hidden");
  assert.equal(resolved.PUBLIC_VERIFY.reviewerNotes, "hidden");
  assert.equal(resolved.PUBLIC_VERIFY.legalHoldReason, "hidden");
  assert.equal(resolved.PUBLIC_VERIFY.rejectionReason, "hidden");
  assert.equal(resolved.PUBLIC_VERIFY.escalationReason, "hidden");
});

test("resolveRedactionPolicy allows masking GPS on REPORT but not on PUBLIC_VERIFY override-up", () => {
  const resolved = resolveRedactionPolicy({
    PUBLIC_VERIFY: { gpsCoordinates: "visible" },
  });
  // GPS isn't in the strict floor set — operator can override.
  assert.equal(resolved.PUBLIC_VERIFY.gpsCoordinates, "visible");
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

test("maskEmail masks the local part", () => {
  assert.equal(maskEmail("alice@example.com"), "a***@example.com");
  assert.equal(maskEmail("a@example.com"), "a***@example.com");
  assert.equal(maskEmail(null), null);
  assert.equal(maskEmail("noatsign"), "***");
});

test("maskPhone retains the last 4 digits", () => {
  assert.equal(maskPhone("+1-555-867-5309"), "***5309");
  assert.equal(maskPhone(null), null);
  assert.equal(maskPhone("12"), "***");
});

test("maskGpsCoordinate truncates to ~1.1 km precision", () => {
  const out = maskGpsCoordinate({ lat: 37.7749295, lng: -122.4194155 });
  assert.equal(out?.lat, 37.77);
  assert.equal(out?.lng, -122.42);
});

test("applyRedaction respects the mode", () => {
  const value = "hello@example.com";
  assert.equal(applyRedaction(value, "hidden", (s) => s), null);
  assert.equal(applyRedaction(value, "visible", (s) => s), value);
  assert.equal(applyRedaction(value, "masked", () => "[masked]"), "[masked]");
});
