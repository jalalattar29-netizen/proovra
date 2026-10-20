/**
 * AUD-51 (2026-10-20) — each duplicated rule now has ONE shared definition:
 * the custody cut-off (a sequence, never a time), the two integrity
 * conclusions, the custody display counts, and the retained-token marker.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildCustodyDisplayCounts,
  custodyCutoffSequence,
  overallIntegrityOf,
  recordedIntegrityVerified,
  splitCustodyAtCutoff,
  TSA_RETAINED_TOKEN_REPAIR_SOURCE,
  tsaValidatedFromRetainedToken,
} from "../dist/index.js";

const at = (iso) => new Date(iso);

test("the custody cut-off is a sequence: a later-sequence event with an earlier time is NOT at issue", () => {
  const events = [
    { sequence: 1, atUtc: at("2026-10-01T10:00:00Z") },
    { sequence: 2, atUtc: at("2026-10-01T10:05:00Z") },
    // A timestamp event recorded later in the chain carrying its own (earlier) genTime.
    { sequence: 3, atUtc: at("2026-10-01T09:59:00Z") },
  ];
  // Issued at 10:06 with the recorded cut-off 2: sequence 3 is after issue.
  const recorded = custodyCutoffSequence(events, at("2026-10-01T10:06:00Z"), 2);
  assert.equal(recorded, 2);
  assert.deepEqual(splitCustodyAtCutoff(events, recorded).afterIssue.map((e) => e.sequence), [3]);
  // A legacy report with no recorded cut-off: the highest sequence at or before the time.
  assert.equal(custodyCutoffSequence(events.slice(0, 2), at("2026-10-01T10:01:00Z"), null), 1);
  // No issue time: nothing is cut.
  assert.equal(custodyCutoffSequence(events, null, null), null);
  assert.equal(splitCustodyAtCutoff(events, null).atIssue.length, 3);
});

test("the integrity conclusions", () => {
  assert.equal(recordedIntegrityVerified({ verificationStatus: "RECORDED_INTEGRITY_VERIFIED" }), true);
  assert.equal(recordedIntegrityVerified({ verificationStatus: "MATERIALS_AVAILABLE", recordedIntegrityVerifiedAtUtc: null }), false);
  const ok = { canonicalHashMatches: true, signatureValid: true, custodyChainValid: true, timestampDigestMatches: null, otsHashMatches: null, digestColumnsMatchSignedFingerprint: null, storedBytesContradict: false };
  assert.equal(overallIntegrityOf(ok), true);
  assert.equal(overallIntegrityOf({ ...ok, otsHashMatches: false }), false);
  assert.equal(overallIntegrityOf({ ...ok, storedBytesContradict: true }), false);
  assert.equal(overallIntegrityOf({ ...ok, timestampDigestMatches: false }), false);
});

test("custody display counts carry no redundant pairs", () => {
  const c = buildCustodyDisplayCounts({ forensicAtReportGeneration: 2, currentForensicEvents: 3, accessAfterReportGeneration: 1, currentAccessEvents: 4, reportGeneratedAtUtc: at("2026-10-01T10:00:00Z") });
  assert.deepEqual(Object.keys(c).sort(), ["accessAfterReportGeneration", "currentAccessEvents", "currentForensicEvents", "forensicAtReportGeneration", "reportGeneratedAtUtc", "totalDisplayedEvents"]);
  assert.equal(c.totalDisplayedEvents, 7);
});

test("the retained-token marker has one value and one reader", () => {
  assert.equal(TSA_RETAINED_TOKEN_REPAIR_SOURCE, "tsa_kept_token_validated");
  assert.equal(tsaValidatedFromRetainedToken([{ eventType: "TIMESTAMP_APPLIED", payload: { repair_source: TSA_RETAINED_TOKEN_REPAIR_SOURCE } }]), true);
  assert.equal(tsaValidatedFromRetainedToken([{ eventType: "TIMESTAMP_APPLIED", payload: [] }]), false);
});
