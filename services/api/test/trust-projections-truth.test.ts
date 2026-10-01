/**
 * UC-TRUST-007 — secondary projections derive trust words from the canonical
 * resolvers, never from a column's presence or a raw status.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({ prisma: {} }));

const { buildVerificationProof } = await import("../src/services/evidence-intelligence.service.js");
const { otsBucket } = await import("../src/services/dashboard/trust-summary.service.js");

const base = {
  status: "SIGNED",
  verificationStatus: "MATERIALS_AVAILABLE",
  recordedIntegrityVerifiedAtUtc: null,
  fileSha256: "a".repeat(64),
  fingerprintHash: "b".repeat(64),
  signatureBase64: "sig",
  signingKeyId: "k",
  signingKeyVersion: 1,
  tsaStatus: "STAMPED",
  tsaValidatedAtUtc: null,
  otsStatus: "ANCHORED",
  otsAnchoredAtUtc: new Date(),
  otsAnchorCheck: null,
} as never;

describe("evidenceIntelligence.verificationProof", () => {
  it("a digest column alone is NOT a hash match; a legacy unvalidated token is not RECORDED; an unchecked anchor is not ANCHORED", () => {
    const p = buildVerificationProof(base);
    expect(p.hashMatch).toBe("NOT_CHECKED");
    expect(p.tsaStatus).toBe("UNKNOWN");
    expect(p.otsStatus).toBe("UNKNOWN");
  });

  it("explicitly verified + validated + chain-verified reads positive; a rejected record is MISMATCH", () => {
    const ok = buildVerificationProof({
      ...(base as object),
      verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
      recordedIntegrityVerifiedAtUtc: new Date(),
      tsaValidatedAtUtc: new Date(),
      otsAnchorCheck: "BITCOIN_VERIFIED",
    } as never);
    expect(ok).toMatchObject({ hashMatch: "MATCH", tsaStatus: "RECORDED", otsStatus: "ANCHORED" });
    expect(buildVerificationProof({ ...(base as object), status: "FAILED_HASH_MISMATCH" } as never).hashMatch).toBe("MISMATCH");
  });
});

describe("dashboard OTS bucket", () => {
  it("ANCHORED whose chain was not checked is never counted as anchored", () => {
    expect(otsBucket({ otsStatus: "ANCHORED", otsAnchoredAtUtc: new Date(), otsAnchorCheck: null })).toBe("anchoredNotChecked");
    expect(otsBucket({ otsStatus: "ANCHORED", otsAnchoredAtUtc: new Date(), otsAnchorCheck: "PROOF_STRUCTURE" })).toBe("anchoredNotChecked");
    expect(otsBucket({ otsStatus: "ANCHORED", otsAnchoredAtUtc: new Date(), otsAnchorCheck: "BITCOIN_VERIFIED" })).toBe("anchored");
    expect(otsBucket({ otsStatus: "PENDING" })).toBe("pending");
  });
});
