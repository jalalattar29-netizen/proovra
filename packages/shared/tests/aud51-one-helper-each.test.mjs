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

test("the custody cut-off is a sequence prefix: no gap, whatever the event times say", () => {
  const events = [
    { sequence: 1, atUtc: at("2026-10-01T10:00:00Z") },
    // Recorded later in the chain with its own LATER time.
    { sequence: 2, atUtc: at("2026-10-01T10:10:00Z") },
    // A timestamp event carrying its own (earlier) genTime.
    { sequence: 3, atUtc: at("2026-10-01T10:05:00Z") },
    { sequence: 4, atUtc: at("2026-10-01T10:20:00Z") },
  ];
  const cut = custodyCutoffSequence(events, at("2026-10-01T10:06:00Z"));
  assert.equal(cut, 3);
  // A time filter would keep {1, 3} and leave a gap at 2; the prefix keeps 1-3.
  assert.deepEqual(splitCustodyAtCutoff(events, cut).atIssue.map((e) => e.sequence), [1, 2, 3]);
  assert.deepEqual(splitCustodyAtCutoff(events, cut).afterIssue.map((e) => e.sequence), [4]);
  // No issue time: nothing is cut.
  assert.equal(custodyCutoffSequence(events, null), null);
  assert.equal(splitCustodyAtCutoff(events, null).atIssue.length, 4);
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
