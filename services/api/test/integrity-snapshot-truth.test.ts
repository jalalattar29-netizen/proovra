/**
 * ET-SEC-35 — the integrity snapshot claims only what was actually checked.
 *
 * On a40ca76f MATERIALS_AVAILABLE (the materials exist) set canonicalHashMatches,
 * signatureValid and custodyChainValid to true, an integrity FAILURE set the
 * signature and chain to false, and otsHashMatches was true for any ANCHORED
 * row and false for any FAILED one — by status, with no comparison.
 */
import { describe, expect, it } from "vitest";

import { deriveIntegritySnapshot, type IntegritySnapshotInput } from "../src/services/dashboard/integrity-snapshot.service.js";
import { otsProofForDigest } from "./helpers/ots-proof-bytes.js";

const FP = "a".repeat(64);
const base: IntegritySnapshotInput = {
  evidenceId: "ev",
  teamId: "t",
  verificationStatus: null,
  tsaStatus: null,
  tsaValidatedAtUtc: null,
  tsaTokenBase64: null,
  tsaGenTimeUtc: null,
  tsaMessageImprint: null,
  tsaInputDigestHex: null,
  tsaInputKind: null,
  otsStatus: null,
  otsHash: null,
  fileSha256: "b".repeat(64),
  fingerprintHash: FP,
  signatureBase64: "sig",
} as IntegritySnapshotInput;

describe("integrity snapshot truth (ET-SEC-35)", () => {
  it("MATERIALS_AVAILABLE verifies nothing: hash, signature and chain are unknown", () => {
    const s = deriveIntegritySnapshot({ ...base, verificationStatus: "MATERIALS_AVAILABLE" });
    expect([s.canonicalHashMatches, s.signatureValid, s.custodyChainValid]).toEqual([null, null, null]);
  });

  it("RECORDED_INTEGRITY_VERIFIED is the only state that claims all three", () => {
    const s = deriveIntegritySnapshot({ ...base, verificationStatus: "RECORDED_INTEGRITY_VERIFIED" });
    expect([s.canonicalHashMatches, s.signatureValid, s.custodyChainValid]).toEqual([true, true, true]);
  });

  it("an integrity FAILURE is a hash mismatch, not a signature or custody verdict", () => {
    const s = deriveIntegritySnapshot({ ...base, verificationStatus: "FAILED" });
    expect([s.canonicalHashMatches, s.signatureValid, s.custodyChainValid]).toEqual([false, null, null]);
  });

  it("otsHashMatches compares the stamped digest with the fingerprint hash", () => {
    const anchored = otsProofForDigest(FP, { bitcoinHeight: 860000 });
    expect(deriveIntegritySnapshot({ ...base, otsStatus: "ANCHORED", otsHash: FP, otsProofBase64: anchored }).otsHashMatches).toBe(true);
    // A stamped digest that disagrees with the fingerprint: the proof is not
    // bound to this record (FAILED), and the comparison says so.
    expect(deriveIntegritySnapshot({ ...base, otsStatus: "ANCHORED", otsHash: "c".repeat(64), otsProofBase64: anchored }).otsHashMatches).toBe(false);
    // A FAILED OTS row with a matching digest (e.g. the retry budget ran out) is not a mismatch.
    expect(deriveIntegritySnapshot({ ...base, otsStatus: "FAILED", otsHash: FP }).otsHashMatches).toBeNull();
  });
});

describe("integrity snapshot OTS state (2026-10-13): the proof decides, never the status", () => {
  it("ANCHORED without proof bytes is not OK; a proof with a Bitcoin attestation is", () => {
    expect(deriveIntegritySnapshot({ ...base, otsStatus: "ANCHORED", otsHash: FP }).otsStatus).toBe("UNAVAILABLE");
    expect(deriveIntegritySnapshot({ ...base, otsStatus: "ANCHORED", otsHash: FP, otsProofBase64: otsProofForDigest(FP) }).otsStatus).toBe("PENDING");
    expect(
      deriveIntegritySnapshot({ ...base, otsStatus: "PENDING", otsHash: FP, otsProofBase64: otsProofForDigest(FP, { bitcoinHeight: 1 }) }).otsStatus,
    ).toBe("OK");
  });
});
