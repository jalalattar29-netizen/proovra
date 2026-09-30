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
    expect(deriveIntegritySnapshot({ ...base, otsStatus: "ANCHORED", otsHash: FP }).otsHashMatches).toBe(true);
    expect(deriveIntegritySnapshot({ ...base, otsStatus: "ANCHORED", otsHash: "c".repeat(64) }).otsHashMatches).toBe(false);
    // A FAILED OTS row with a matching digest (e.g. the retry budget ran out) is not a mismatch.
    expect(deriveIntegritySnapshot({ ...base, otsStatus: "FAILED", otsHash: FP }).otsHashMatches).toBeNull();
  });
});
