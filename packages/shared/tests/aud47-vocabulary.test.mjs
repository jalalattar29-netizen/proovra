/**
 * AUD-47 (2026-10-20) — one vocabulary: verification status, Object Lock mode,
 * organization and contract status, and the tone of every verification status.
 * Unknown values are never printed raw; tones are by exact value.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  enterpriseContractStatusLabel,
  enterpriseContractStatusTone,
  evidenceVerificationStatusLabel,
  evidenceVerificationStatusTone,
  objectLockModeLabel,
  organizationStatusLabel,
  VERIFICATION_STATUS_TONES,
} from "../dist/index.js";

test("verification status: words and exact-value tones", () => {
  assert.equal(evidenceVerificationStatusLabel("RECORDED_INTEGRITY_VERIFIED"), "Recorded integrity state verified");
  assert.equal(evidenceVerificationStatusLabel("SOMETHING_VERIFIED"), "Verification status not recorded");
  assert.equal(evidenceVerificationStatusTone("RECORDED_INTEGRITY_VERIFIED"), "success");
  // endsWith("VERIFIED") is not a rule.
  assert.equal(evidenceVerificationStatusTone("SOMETHING_VERIFIED"), "neutral");
  assert.equal(evidenceVerificationStatusTone("MATERIALS_AVAILABLE"), "neutral");
  assert.equal(evidenceVerificationStatusTone("FAILED"), "danger");
});

test("NOT_CHECKED is neutral, never amber", () => {
  assert.equal(VERIFICATION_STATUS_TONES.NOT_CHECKED, "neutral");
  assert.equal(VERIFICATION_STATUS_TONES.VERIFIED, "success");
  assert.equal(VERIFICATION_STATUS_TONES.FAILED, "danger");
});

test("Object Lock mode, organization and contract status in words", () => {
  assert.equal(objectLockModeLabel("COMPLIANCE"), "Compliance retention lock");
  assert.equal(objectLockModeLabel("governance"), "Governance retention lock");
  assert.equal(objectLockModeLabel(null), null);
  assert.equal(organizationStatusLabel("ARCHIVED"), "Closed");
  assert.equal(organizationStatusLabel("WEIRD"), "Status not recorded");
  assert.equal(enterpriseContractStatusLabel("PENDING_ACTIVATION"), "Pending activation");
  assert.equal(enterpriseContractStatusTone("DRAFT"), "neutral");
  assert.equal(enterpriseContractStatusTone("TERMINATED"), "danger");
});
