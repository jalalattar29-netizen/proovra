/**
 * AUD-48 / AUD-47 (2026-10-20) — the live-delta categories are named for a
 * reader (never printed as keys), TSA validation is one of them, and a TSA
 * failure is stated by its code, never by the provider's raw text.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LIVE_DELTA_MATERIALS,
  liveDeltaMaterialsText,
  TSA_FAILURE_NOTES,
  tsaFailureNote,
} from "../dist/index.js";

test("live-delta keys are labelled and TSA validation is listed", () => {
  assert.deepEqual([...LIVE_DELTA_MATERIALS], ["custodyChain", "otsAnchoring", "timestampValidation"]);
  assert.equal(liveDeltaMaterialsText(["custodyChain", "otsAnchoring", "timestampValidation"]), "Chain of custody, Bitcoin anchoring, Trusted timestamp validation");
  assert.equal(liveDeltaMaterialsText(["somethingInternal"]), "");
  assert.ok(!/custodyChain|otsAnchoring/.test(liveDeltaMaterialsText(LIVE_DELTA_MATERIALS)));
});

test("a TSA failure is worded by its code; raw provider text is never returned", () => {
  assert.equal(tsaFailureNote("tsa_provider_quota_exceeded"), TSA_FAILURE_NOTES.QUOTA);
  assert.equal(tsaFailureNote("tsa_provider_timeout"), TSA_FAILURE_NOTES.NOT_ISSUED);
  assert.equal(tsaFailureNote("tsa_trust_anchor_not_configured"), TSA_FAILURE_NOTES.NOT_VALIDATED);
  assert.equal(tsaFailureNote("tsa_token_signature_invalid"), TSA_FAILURE_NOTES.VALIDATION_FAILED);
  assert.equal(tsaFailureNote("something_new"), TSA_FAILURE_NOTES.UNSPECIFIED);
  assert.equal(tsaFailureNote(null), null);
  assert.equal(tsaFailureNote(null, true), TSA_FAILURE_NOTES.UNSPECIFIED);
});

test("AUD-47: a tsa_failure notification states the code's note, never a provider's raw text", async () => {
  const { notificationItemText } = await import("../dist/index.js");
  const raw = "HTTP 403 Kontingent verbraucht https://tsa.internal.example";
  const withCode = notificationItemText("en", { title: "t", body: raw, message: { key: "tsa_failure", params: { evidence: "Photo", code: "tsa_provider_quota_exceeded" } } });
  assert.ok(withCode.body.includes(TSA_FAILURE_NOTES.QUOTA), withCode.body);
  const legacy = notificationItemText("en", { title: "t", body: raw, message: { key: "tsa_failure", params: { evidence: "Photo", reason: raw } } });
  assert.ok(!legacy.body.includes("Kontingent"), legacy.body);
  const de = notificationItemText("de", { title: "t", body: raw, message: { key: "tsa_failure", params: { evidence: "Photo", code: "tsa_provider_quota_exceeded" } } });
  assert.ok(!de.body.includes("Kontingent"));
});
