/**
 * Independent forward audit closure — Wave D (shared presentation authorities).
 *
 * F-12: a record signature is presented from its VALIDITY STATE — a revoked
 *       key, a mismatched key or a bad signature is never a neutral "Recorded".
 * F-13: the record status label and tone are one table (server, web, mobile).
 * F-16: the Reports row lifecycle is one mapping, total over the output
 *       states; a value off the wire this build does not know is "unavailable".
 * F-27: a TSA "validation failure" is a kept token whose validation failed.
 * F-28: custody days are LOCAL calendar days; custody verdicts, event types and
 *       PDF signature statuses are named by one vocabulary.
 * F-32: a package manifest signature that was never inspected has its own
 *       status, never SIGNED by default.
 *
 * Expected values are literal strings, never re-derived through the helpers.
 */
// F-28 — fix the zone BEFORE any Date is formatted: an evening in Los Angeles
// is the next day in UTC.
process.env.TZ = "America/Los_Angeles";

import test from "node:test";
import assert from "node:assert/strict";
import {
  recordSignaturePresentation,
  parseRecordSignatureValidityState,
  evidenceRecordStatusLabel,
  evidenceRecordStatusTone,
  outputRowLifecycle,
  outputRowLifecycleOf,
  EVIDENCE_OUTPUT_STATES,
  TSA_VALIDATION_FAILED_CODE_LIST,
  custodyLocalDayKey,
  custodyLocalDayInstant,
  custodyChainVerdictLabel,
  custodyEventLabel,
  pdfSignatureStatusLabel,
  VERIFICATION_PACKAGE_SIGNATURE_STATUSES,
} from "../dist/index.js";

test("F-12: the signature is presented from its validity state", () => {
  assert.deepEqual(recordSignaturePresentation({ validityState: "VALID" }), { state: "verified", label: "Signature verified" });
  assert.deepEqual(recordSignaturePresentation({ validityState: "VALID_SUPERSEDED_KEY" }), {
    state: "verified",
    label: "Signature verified with a rotated (not revoked) signing key",
  });
  assert.deepEqual(recordSignaturePresentation({ validityState: "INVALID" }), { state: "failed", label: "Signature did not verify" });
  const revoked = recordSignaturePresentation({ validityState: "REVOKED_KEY", revokedAtUtc: "2026-10-01T00:00:00.000Z" });
  assert.equal(revoked.state, "failed");
  assert.match(revoked.label, /^Signing key revoked at 2026-10-01T00:00:00\.000Z; /);
  assert.equal(recordSignaturePresentation({ validityState: "KEY_MISMATCH" }).state, "failed");
  assert.equal(recordSignaturePresentation({ validityState: "KEY_NOT_REGISTERED" }).state, "failed");
  assert.deepEqual(recordSignaturePresentation({ validityState: "NOT_SIGNED" }), { state: "unavailable", label: "Signature missing" });
  // An absent or unknown state is never verified, and never "Recorded".
  for (const v of [undefined, null, "", "RECORDED", "valid"]) {
    assert.deepEqual(recordSignaturePresentation({ validityState: v }), { state: "unavailable", label: "Signature validity not stated" }, String(v));
    assert.equal(parseRecordSignatureValidityState(v), null);
  }
});

test("F-13: the record status label and tone are one table", () => {
  const expected = {
    CREATED: ["Created", "processing"],
    UPLOADING: ["Uploading", "processing"],
    UPLOADED: ["Uploaded (legacy)", "neutral"],
    SIGNED: ["Signed", "success"],
    REPORTED: ["Reported", "success"],
    FAILED_HASH_MISMATCH: ["Integrity check failed", "danger"],
  };
  for (const [status, [label, tone]] of Object.entries(expected)) {
    assert.equal(evidenceRecordStatusLabel(status), label, status);
    assert.equal(evidenceRecordStatusTone(status), tone, status);
  }
});

test("F-16: one row mapping, total over the canonical output states", () => {
  const expected = {
    NOT_INCLUDED: "unavailable",
    ENTITLEMENT_UNAVAILABLE: "unavailable",
    NOT_APPLICABLE: "not_requested",
    ELIGIBLE_NOT_GENERATED: "not_requested",
    QUEUED: "pending",
    GENERATING: "pending",
    RETRYABLE_FAILURE: "failed",
    TERMINAL_FAILURE: "failed",
    ARTIFACT_MISSING: "failed",
    BLOCKED: "blocked",
    READY: "ready",
  };
  assert.deepEqual([...EVIDENCE_OUTPUT_STATES].sort(), Object.keys(expected).sort());
  for (const [state, row] of Object.entries(expected)) {
    assert.equal(outputRowLifecycle(state), row, state);
    assert.equal(outputRowLifecycleOf(state), row, state);
  }
  // Off the wire: anything this build does not know is unavailable — never
  // "not requested", never "ready" (the old `?? "ELIGIBLE"` fallback).
  for (const v of ["ELIGIBLE", "SIGNED", "ready", "", null, undefined, 3]) {
    assert.equal(outputRowLifecycleOf(v), "unavailable", String(v));
  }
});

test("F-27: a TSA validation failure is one of the token-validation failure codes", () => {
  assert.deepEqual([...TSA_VALIDATION_FAILED_CODE_LIST], [
    "tsa_token_untrusted",
    "tsa_token_signature_invalid",
    "tsa_nonce_mismatch",
    "tsa_message_imprint_mismatch",
    "tsa_policy_not_accepted",
  ]);
});

test("F-28: a custody day is the LOCAL calendar day of the event", () => {
  // 03:00 UTC on the 21st is 20:00 on the 20th in Los Angeles.
  assert.equal(custodyLocalDayKey("2026-10-21T03:00:00.000Z"), "2026-10-20");
  assert.equal(custodyLocalDayKey("2026-10-21T19:00:00.000Z"), "2026-10-21");
  assert.equal(custodyLocalDayKey(null), "Undated");
  assert.equal(custodyLocalDayKey("not a date"), "Undated");
  // The instant used to print the day falls inside that local day.
  const instant = custodyLocalDayInstant("2026-10-20");
  assert.equal(custodyLocalDayKey(instant), "2026-10-20");
  assert.equal(custodyLocalDayInstant("Undated"), null);
});

test("F-28: custody verdicts, event types and PDF signature statuses are named by one vocabulary", () => {
  assert.equal(custodyChainVerdictLabel({ valid: true }), "Continuous — every event is hash-linked to the one before it");
  assert.equal(custodyChainVerdictLabel({ valid: true, mode: "legacy" }), "Continuous (recorded before events were hash-linked)");
  assert.equal(custodyChainVerdictLabel({ valid: null }), "Not checked");
  assert.equal(custodyChainVerdictLabel({ valid: false, reason: "prev_hash_mismatch" }), "Review required — an event does not link to the one before it");
  assert.equal(custodyChainVerdictLabel({ valid: false, reason: "something_new" }), "Review required");
  assert.equal(custodyEventLabel("EVIDENCE_COMPLETED"), "Evidence record completed");
  assert.equal(pdfSignatureStatusLabel("SIGNED"), "Signed");
  assert.equal(pdfSignatureStatusLabel("SIGNING_FAILED"), "Signing failed");
  assert.equal(pdfSignatureStatusLabel("SIGNING_UNAVAILABLE"), "Signing unavailable (not a production signing environment)");
  // An unknown status is never "Signed" and never the raw code.
  assert.equal(pdfSignatureStatusLabel("weird"), "Signature status not recorded");
  assert.equal(pdfSignatureStatusLabel(null), "Signature status not recorded");
});

test("F-32: a never-inspected package manifest signature has its own status", () => {
  assert.deepEqual([...VERIFICATION_PACKAGE_SIGNATURE_STATUSES], ["SIGNED", "UNSIGNED", "NOT_INSPECTED", "NOT_APPLICABLE"]);
});
