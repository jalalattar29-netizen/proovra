/**
 * UC-TRUST-007 — secondary projections derive trust words from the canonical
 * resolvers, never from a column's presence or a raw status.
 *
 * (2026-10-13) The OTS state is the ONE authority (resolveRecordOtsAnchoring):
 * ANCHORED only when the stored proof executes from the record's digest to a
 * valid Bitcoin block attestation — never from ots_status, a txid or a time.
 */
import { describe, expect, it, vi } from "vitest";

import { otsProofForDigest } from "./helpers/ots-proof-bytes.js";

vi.mock("../src/db.js", () => ({ prisma: {} }));

const { buildVerificationProof } = await import("../src/services/evidence-intelligence.service.js");
const { otsBucket } = await import("../src/services/dashboard/trust-summary.service.js");

const DIGEST = "b".repeat(64);
const ANCHORED_PROOF = otsProofForDigest(DIGEST, { bitcoinHeight: 860000 });
const PENDING_PROOF = otsProofForDigest(DIGEST);

const base = {
  status: "SIGNED",
  verificationStatus: "MATERIALS_AVAILABLE",
  recordedIntegrityVerifiedAtUtc: null,
  fileSha256: "a".repeat(64),
  fingerprintHash: DIGEST,
  signatureBase64: "sig",
  signingKeyId: "k",
  signingKeyVersion: 1,
  tsaStatus: "STAMPED",
  tsaValidatedAtUtc: null,
  otsStatus: "ANCHORED",
  otsAnchoredAtUtc: new Date(),
  otsProofBase64: null,
} as never;

describe("evidenceIntelligence.verificationProof", () => {
  it("a digest column alone is NOT a hash match; a legacy unvalidated token is not RECORDED; ANCHORED without proof bytes is not ANCHORED", () => {
    const p = buildVerificationProof(base);
    expect(p.hashMatch).toBe("NOT_CHECKED");
    expect(p.tsaStatus).toBe("UNKNOWN");
    // The row says ANCHORED but carries no proof: UNAVAILABLE, never anchored.
    expect(p.otsState).toBe("UNAVAILABLE");
  });

  it("explicitly verified + validated + an anchored proof reads positive; a rejected record is MISMATCH", () => {
    const ok = buildVerificationProof({
      ...(base as object),
      verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
      recordedIntegrityVerifiedAtUtc: new Date(),
      tsaValidatedAtUtc: new Date(),
      otsProofBase64: ANCHORED_PROOF,
    } as never);
    expect(ok).toMatchObject({ hashMatch: "MATCH", tsaStatus: "RECORDED", otsState: "ANCHORED" });
    expect(buildVerificationProof({ ...(base as object), status: "FAILED_HASH_MISMATCH" } as never).hashMatch).toBe("MISMATCH");
  });

  it("a proof bound to another digest is FAILED, even when the row says ANCHORED", () => {
    const p = buildVerificationProof({
      ...(base as object),
      otsProofBase64: otsProofForDigest("c".repeat(64), { bitcoinHeight: 860000 }),
    } as never);
    expect(p.otsState).toBe("FAILED");
  });
});

describe("dashboard OTS bucket", () => {
  it("counts ANCHORED only from a proof that executes to a Bitcoin attestation", () => {
    // A status string, a time or a txid never makes a record anchored.
    expect(otsBucket({ otsStatus: "ANCHORED", otsAnchoredAtUtc: new Date(), fingerprintHash: DIGEST })).toBe("unavailable");
    expect(otsBucket({ otsStatus: "ANCHORED", otsProofBase64: PENDING_PROOF, fingerprintHash: DIGEST })).toBe("pending");
    expect(otsBucket({ otsStatus: "ANCHORED", otsProofBase64: ANCHORED_PROOF, fingerprintHash: DIGEST })).toBe("anchored");
    // The proof decides, whatever the stored status says.
    expect(otsBucket({ otsStatus: "PENDING", otsProofBase64: ANCHORED_PROOF, fingerprintHash: DIGEST })).toBe("anchored");
    expect(otsBucket({ otsStatus: "PENDING", otsProofBase64: PENDING_PROOF, fingerprintHash: DIGEST })).toBe("pending");
    expect(otsBucket({ otsStatus: "FAILED", otsFailureReason: "OTS_GLOBAL_BUDGET_EXHAUSTED" })).toBe("failed");
    expect(otsBucket({ otsStatus: "DISABLED" })).toBe("notRequested");
    expect(otsBucket({ otsStatus: null })).toBe("notRequested");
  });
});
