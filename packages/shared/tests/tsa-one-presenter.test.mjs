/**
 * ONE TSA AUTHORITY AND PRESENTER (2026-10-20, AUD-14 / 16 / 17).
 *
 * The canonical proof status is the reading of resolveTsaTrustState. A stored
 * FAILED is three facts — a refused token, a kept token never validated, no
 * token at all — and is never one "Timestamp failed". A kept token whose cause
 * was not recorded states no cause. A token's own time and serial are claims
 * unless it was validated.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveTsaProofStatus,
  resolveTsaTrustState,
  TSA_PROOF_STATUS_LABELS,
  TSA_PROOF_STATUS_TONE,
  TSA_PROOF_STATUSES,
  tsaProofComponentState,
  tsaTokenClaimsBasis,
} from "../dist/index.js";

const NOW = "2026-10-12T08:00:00.000Z";

test("a stored FAILED is three facts, never one", () => {
  const refused = resolveTsaProofStatus({ tsaStatus: "FAILED", tsaTokenPresent: true, tsaFailureCode: "tsa_message_imprint_mismatch" });
  const keptNoAnchor = resolveTsaProofStatus({ tsaStatus: "FAILED", tsaTokenPresent: true, tsaFailureCode: "tsa_trust_anchor_not_configured" });
  const keptNoCause = resolveTsaProofStatus({ tsaStatus: "FAILED", tsaTokenPresent: true, tsaFailureCode: null });
  const outage = resolveTsaProofStatus({ tsaStatus: "FAILED", tsaTokenPresent: false, tsaFailureCode: "tsa_provider_unreachable" });
  assert.deepEqual([refused, keptNoAnchor, keptNoCause, outage], ["FAILED", "RECORDED_NOT_VALIDATED", "RECORDED_NOT_VALIDATED", "NOT_OBTAINED"]);
  assert.equal(TSA_PROOF_STATUS_LABELS[outage], "Not obtained");
  assert.equal(TSA_PROOF_STATUS_LABELS[refused], "Validation failed");
  assert.ok(!Object.values(TSA_PROOF_STATUS_LABELS).includes("Timestamp failed"));
});

test("the stored token itself is a presence input too", () => {
  assert.equal(resolveTsaProofStatus({ tsaStatus: "FAILED", tsaTokenBase64: "MIIB" }), "RECORDED_NOT_VALIDATED");
  assert.equal(resolveTsaProofStatus({ tsaStatus: "FAILED", tsaTokenBase64: null }), "NOT_OBTAINED");
  assert.equal(resolveTsaProofStatus({ tsaStatus: "STAMPED", tsaValidatedAtUtc: NOW, tsaTokenBase64: "MIIB" }), "VALIDATED");
  // STAMPED without a validation time is a kept legacy token.
  assert.equal(resolveTsaProofStatus({ tsaStatus: "STAMPED", tsaValidatedAtUtc: null, tsaTokenBase64: "MIIB" }), "RECORDED_NOT_VALIDATED");
  assert.equal(resolveTsaProofStatus({ tsaStatus: "PENDING", tsaTokenPresent: false }), "PENDING");
  assert.equal(resolveTsaProofStatus({ tsaStatus: null, tsaTokenPresent: false }), "NOT_REQUESTED");
});

test("AUD-16: a kept token with no recorded cause states no cause", () => {
  const t = resolveTsaTrustState({ presentedStatus: "FAILED", tokenPresent: true, failureCode: null });
  assert.equal(t.state, "PRESENT_NOT_INDEPENDENTLY_VERIFIED");
  assert.equal(t.label, "Timestamp token obtained; not validated");
  assert.doesNotMatch(t.label, /trust anchor/);
  // An unknown code with a kept token is not "not obtained" either.
  const unknown = resolveTsaTrustState({ presentedStatus: "FAILED", tokenPresent: true, failureCode: "tsa_something_new" });
  assert.equal(unknown.state, "PRESENT_NOT_INDEPENDENTLY_VERIFIED");
  assert.doesNotMatch(unknown.label, /not obtained|trust anchor/);
  // The recorded no-anchor cause is still stated.
  assert.match(resolveTsaTrustState({ presentedStatus: "FAILED", tokenPresent: true, failureCode: "tsa_trust_anchor_not_configured" }).label, /no trust anchor/);
});

test("one tone per status: a not-validated token is never amber 'pending'; failure is red", () => {
  assert.equal(TSA_PROOF_STATUS_TONE.RECORDED_NOT_VALIDATED, "neutral");
  assert.equal(TSA_PROOF_STATUS_TONE.NOT_OBTAINED, "neutral");
  assert.equal(TSA_PROOF_STATUS_TONE.FAILED, "danger");
  assert.equal(TSA_PROOF_STATUS_TONE.VALIDATED, "success");
  for (const s of TSA_PROOF_STATUSES) assert.ok(TSA_PROOF_STATUS_LABELS[s] && TSA_PROOF_STATUS_TONE[s], s);
});

test("component state: only a validated token with a matching imprint is verified", () => {
  assert.equal(tsaProofComponentState("VALIDATED", true), "verified");
  assert.equal(tsaProofComponentState("VALIDATED", null), "not_checked");
  assert.equal(tsaProofComponentState("VALIDATED", false), "failed");
  assert.equal(tsaProofComponentState("RECORDED_NOT_VALIDATED", null), "not_checked");
  assert.equal(tsaProofComponentState("NOT_OBTAINED", null), "not_issued");
  assert.equal(tsaProofComponentState("FAILED", null), "failed");
});

test("AUD-17: a token's own time and serial are facts only when it was validated", () => {
  assert.equal(tsaTokenClaimsBasis("VALIDATED"), "VALIDATED_TOKEN");
  assert.equal(tsaTokenClaimsBasis("RECORDED_NOT_VALIDATED"), "CLAIMED_BY_UNVALIDATED_TOKEN");
  assert.equal(tsaTokenClaimsBasis("FAILED"), "CLAIMED_BY_UNVALIDATED_TOKEN");
  assert.equal(tsaTokenClaimsBasis("NOT_OBTAINED"), null);
});

test("a failure code says what it says about the token, and an unknown one says nothing", async () => {
  const { tsaFailureCodeImpliesToken } = await import("../dist/index.js");
  assert.equal(tsaFailureCodeImpliesToken("tsa_message_imprint_mismatch"), true);
  assert.equal(tsaFailureCodeImpliesToken("tsa_trust_anchor_not_configured"), true);
  assert.equal(tsaFailureCodeImpliesToken("tsa_provider_unreachable"), false);
  assert.equal(tsaFailureCodeImpliesToken("x"), null);
  assert.equal(tsaFailureCodeImpliesToken(null), null);
});
