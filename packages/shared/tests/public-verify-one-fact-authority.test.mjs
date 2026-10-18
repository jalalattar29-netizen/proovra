/**
 * ONE FACT, ONE STATUS ON THE PUBLIC VERIFY PAGE (2026-10-17).
 *
 * Production showed "Trusted timestamp: Not checked" in the verification
 * matrix beside "Trusted timestamp: Verified/failed" in the original-evidence
 * section, and "Public Verify publication: Verified" on a canonical page that
 * has no publication step. Every surface now reads the one authority:
 *
 *   - RFC 3161: a FAILED status with a KEPT token whose validation was never
 *     performed (no trust anchor) is "not checked" in the Basic Verify view,
 *     exactly as the trust signal and the matrix say — never "failed"; a token
 *     that validation refused, and a token never obtained, keep their states.
 *   - Publication: the canonical page states that it does not depend on owner
 *     publication (NOT_APPLICABLE), never "Published".
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildBasicVerification, buildEvidenceTrustDecision, buildVerificationMatrix } from "../dist/index.js";

const D = "a".repeat(64);
const AT = "2026-09-01T00:00:00.000Z";

const basic = (over) =>
  buildBasicVerification({
    now: new Date("2026-10-17T00:00:00Z"),
    integrity: { fingerprintMatches: true, signatureValid: true, custodyChainValid: true },
    fileSha256: D,
    fingerprintHash: D,
    capturedAtUtc: null,
    signedAtUtc: AT,
    tsaStatus: "FAILED",
    tsaImprintMatches: null,
    tsaGenTimeUtc: null,
    ots: { status: null, proofBase64: null, fingerprintHash: D },
    latestReport: null,
    pairedPackage: null,
    ...over,
  });

const matrixTsa = (evidence) =>
  buildVerificationMatrix({
    signals: buildEvidenceTrustDecision({ evidence: { fileSha256: D, fingerprintHash: D, ...evidence }, custodyEvents: [] }).signals,
    identity: null,
    acquisitionMode: null,
    acquisitionModeSource: null,
    packageSeal: { kind: "NONE" },
    publication: { kind: "CANONICAL" },
  }).rows.find((r) => r.key === "tsa_token");

test("RFC 3161: a kept token never validated (no trust anchor) is not_checked in Basic Verify AND in the matrix", () => {
  const b = basic({ tsaTokenPresent: true, tsaFailureCode: "tsa_trust_anchor_not_configured" });
  assert.equal(b.timestamp.state, "not_checked");
  assert.equal(b.timestamp.basis, "TOKEN_OBTAINED_NOT_VALIDATED");
  const row = matrixTsa({ tsaStatus: "FAILED", tsaTokenPresent: true, tsaFailureCode: "tsa_trust_anchor_not_configured" });
  assert.equal(row.status, "NOT_CHECKED");
});

test("RFC 3161: a request that obtained no token stays failed (\"none was obtained\"; matrix: Unavailable, not obtained)", () => {
  assert.equal(basic({ tsaTokenPresent: false, tsaFailureCode: null }).timestamp.state, "failed");
  assert.equal(matrixTsa({ tsaStatus: "FAILED", tsaTokenPresent: false }).status, "UNAVAILABLE");
  // An older caller without the authority's inputs keeps the status-only reading.
  assert.equal(basic({}).timestamp.state, "failed");
});

test("Disclosure: the canonical page states its disclosure policy and never claims an owner publication step", () => {
  const rowFor = (disclosure) =>
    buildVerificationMatrix({
      signals: [],
      identity: null,
      acquisitionMode: null,
      acquisitionModeSource: null,
      packageSeal: { kind: "NONE" },
      publication: { kind: "CANONICAL", disclosure },
    }).rows.find((r) => r.key === "public_verify_publication");
  for (const disclosure of ["VERIFICATION_ONLY", "CONTENT_PREVIEW"]) {
    const row = rowFor(disclosure);
    assert.equal(row.status, "NOT_APPLICABLE");
    assert.match(row.statement, /permanent PROOVRA verification page/);
    assert.doesNotMatch(row.statement, /^Published/);
  }
  assert.match(rowFor("VERIFICATION_ONLY").statement, /Verification only — the complete verification result is shown and the record.s content is withheld/);
  assert.match(rowFor("CONTENT_PREVIEW").statement, /Content preview — .*original files are never offered/);
});
