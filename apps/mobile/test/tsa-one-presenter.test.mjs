/**
 * AUD-14 / AUD-17 (2026-10-20) — MOBILE STATES THE SHARED TSA PRESENTER.
 *
 * Characterization (before): mobile kept its own label tables — FAILED was an
 * amber "Failed" (or "Timestamp failed") for a provider outage, a kept token
 * never validated was amber, and the owner Integrity row printed the raw
 * stored word ("Status: FAILED"). Now the server's canonical proof status is
 * stated in the shared words and tones; a raw word without it never says
 * "failed".
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./support/render.mjs";

let PV;
before(async () => {
  PV = await loadModule("src/product/public-verify.ts", []);
});

test("the server's proof status is stated in the shared words and tones", () => {
  // 2026-10-29 — a timestamp the provider did not issue is ONE degraded state (warning) on every surface.
  assert.deepEqual(PV.verifyTimestampTone("FAILED", "NOT_OBTAINED"), { label: "Not obtained", tone: "warning" });
  assert.deepEqual(PV.verifyTimestampTone("FAILED", "RECORDED_NOT_VALIDATED"), { label: "Recorded, not validated", tone: "neutral" });
  assert.deepEqual(PV.verifyTimestampTone("FAILED", "FAILED"), { label: "Validation failed", tone: "danger" });
  assert.deepEqual(PV.verifyTimestampTone("STAMPED", "VALIDATED"), { label: "RFC 3161 timestamp validated", tone: "success" });
});

test("a raw word without the proof status never says failed, and a kept token is never amber", () => {
  const raw = PV.verifyTimestampTone("FAILED");
  assert.doesNotMatch(raw.label, /fail/i);
  assert.notEqual(raw.tone, "danger");
  assert.equal(PV.verifyTimestampTone("RECORDED_NOT_VALIDATED").tone, "neutral");
  assert.equal(PV.verifyTimestampTone("STAMPED").tone, "neutral");
});
