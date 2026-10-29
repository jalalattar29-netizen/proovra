/**
 * THE TRUSTED-TIMESTAMP DEGRADED STATE (2026-10-29).
 *
 * A requested timestamp the provider never issued is ONE state on every owner
 * surface: "Trusted timestamp not obtained", warning tone. The completion
 * notice says so instead of a plain success, names the bounded failure
 * category, and states what remains supported — never a retry.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TSA_FAILURE_NOTES,
  TSA_NOT_OBTAINED_PRESENTATION,
  TSA_NOT_OBTAINED_SUPPORT_STATEMENT,
  TSA_PROOF_STATUS_LABELS,
  TSA_PROOF_STATUS_TONE,
  TSA_PROOF_STATUSES,
  tsaCompletionNotice,
  tsaFailureCategory,
  tsaFailureNote,
  tsaProofStatusPresentation,
} from "../dist/index.js";

test("tsaFailureCategory is the bounded category tsaFailureNote words", () => {
  assert.equal(tsaFailureCategory("tsa_provider_quota_exceeded"), "QUOTA");
  for (const c of ["tsa_provider_unreachable", "tsa_provider_timeout", "tsa_provider_http_error", "tsa_response_parse_failed", "tsa_token_missing", "tsa_response_not_granted", "tsa_unknown_error"]) {
    assert.equal(tsaFailureCategory(c), "NOT_ISSUED", c);
  }
  assert.equal(tsaFailureCategory("tsa_trust_anchor_not_configured"), "NOT_VALIDATED");
  assert.equal(tsaFailureCategory("tsa_token_untrusted"), "VALIDATION_FAILED");
  assert.equal(tsaFailureCategory("something_new"), "UNSPECIFIED");
  assert.equal(tsaFailureCategory(null), null);
  assert.equal(tsaFailureCategory(null, true), "UNSPECIFIED");
  for (const c of ["tsa_provider_quota_exceeded", "tsa_provider_unreachable", "tsa_token_untrusted", "x", null]) {
    const cat = tsaFailureCategory(c, true);
    assert.equal(tsaFailureNote(c, true), TSA_FAILURE_NOTES[cat]);
  }
});

test("NOT_OBTAINED presents as the degraded state; every other status keeps its shared label and tone", () => {
  assert.deepEqual(tsaProofStatusPresentation("NOT_OBTAINED"), { label: "Trusted timestamp not obtained", tone: "warning" });
  assert.equal(TSA_NOT_OBTAINED_PRESENTATION.label, "Trusted timestamp not obtained");
  for (const s of TSA_PROOF_STATUSES) {
    if (s === "NOT_OBTAINED") continue;
    assert.deepEqual(tsaProofStatusPresentation(s), { label: TSA_PROOF_STATUS_LABELS[s], tone: TSA_PROOF_STATUS_TONE[s] });
  }
});

test("completion notice: a provider that issued no token is a warning naming the category and what remains true", () => {
  const n = tsaCompletionNotice({ tsaStatus: "FAILED", tsaFailureCode: "tsa_provider_unreachable", tsaTokenPresent: false });
  assert.ok(n);
  assert.equal(n.tone, "warning");
  assert.match(n.title, /trusted timestamp not obtained/i);
  assert.ok(n.message.startsWith(TSA_FAILURE_NOTES.NOT_ISSUED));
  assert.ok(n.message.includes(TSA_NOT_OBTAINED_SUPPORT_STATEMENT));
  assert.doesNotMatch(`${n.title} ${n.message}`, /retry|try again|will be (added|issued)/i);
});

test("completion notice: quota is named as quota", () => {
  const n = tsaCompletionNotice({ tsaStatus: "FAILED", tsaFailureCode: "tsa_provider_quota_exceeded", tsaTokenPresent: false });
  assert.ok(n.message.startsWith(TSA_FAILURE_NOTES.QUOTA));
});

test("completion notice: a token received but refused is 'not validated', never 'not obtained'", () => {
  const n = tsaCompletionNotice({ tsaStatus: "FAILED", tsaFailureCode: "tsa_token_untrusted", tsaTokenPresent: true });
  assert.ok(n);
  assert.match(n.title, /not validated/);
  assert.ok(n.message.startsWith(TSA_FAILURE_NOTES.VALIDATION_FAILED));
});

test("completion notice: nothing to add for validated, pending, not requested or absent", () => {
  assert.equal(tsaCompletionNotice({ tsaStatus: "STAMPED", tsaTokenPresent: true, tsaValidatedAtUtc: "2026-10-29T10:00:00Z" }), null);
  assert.equal(tsaCompletionNotice({ tsaStatus: "PENDING" }), null);
  assert.equal(tsaCompletionNotice({ tsaStatus: null }), null);
  assert.equal(tsaCompletionNotice(null), null);
});

test("the support statement promises no retry and no backdating", () => {
  assert.match(TSA_NOT_OBTAINED_SUPPORT_STATEMENT, /sealed and signed/);
  assert.match(TSA_NOT_OBTAINED_SUPPORT_STATEMENT, /OpenTimestamps anchoring proceeds independently/);
  assert.match(TSA_NOT_OBTAINED_SUPPORT_STATEMENT, /cannot be issued later for the sealing moment/);
});
