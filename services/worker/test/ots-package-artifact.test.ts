/**
 * THE VERIFICATION PACKAGE'S OPENTIMESTAMPS MATERIAL — `decideOtsPackageArtifact`.
 *
 * Every proof here is a REAL OpenTimestamps proof (opentimestamps-client
 * 0.7.2, packages/shared/tests/fixtures/ots-proofs.json) read by the product
 * parser. The rules:
 *   * a proof is packaged only when it commits to the package's fingerprint
 *     digest (sha256 of fingerprint.json); one bound elsewhere, or unreadable,
 *     REFUSES the build while the record presents it as pending/attested, and
 *     is left out (with the reason) when the record already says FAILED;
 *   * an attestation read from the proof is never "anchored": anchoredAtUtc is
 *     the verified block time only, the recording time is proofRecordedAtUtc,
 *     and the txid is marked unverified;
 *   * DISABLED emits nothing; missing bytes never become a file; ANCHORED
 *     without its time degrades to PENDING; failureReason only for FAILED.
 *
 * Also asserts the source contract: processor.ts forwards the OTS state and
 * the builder binds it to fingerprint.json.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { decideOtsPackageArtifact } from "../src/verification-package.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const PROOFS = JSON.parse(
  readFileSync(new URL("../../../packages/shared/tests/fixtures/ots-proofs.json", import.meta.url), "utf8"),
) as { boundFingerprintHash: string; boundProofBase64: string; otherProofBase64: string };

const FP = PROOFS.boundFingerprintHash;
const BOUND = PROOFS.boundProofBase64;
const OTHER = PROOFS.otherProofBase64;
const VALID_TXID = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const RECORDED = "2026-10-08T17:22:20.958Z";

const base = {
  hash: FP,
  fingerprintHash: FP,
  calendar: "https://a.pool.opentimestamps.org",
  bitcoinTxid: null,
  anchoredAtUtc: null,
  upgradedAtUtc: null,
  failureReason: null,
};

describe("PENDING with a proof bound to the fingerprint digest", () => {
  const result = decideOtsPackageArtifact({ ...base, status: "PENDING", proofBase64: BOUND });

  it("emits the proof bytes unchanged", () => {
    expect(result.proofBytes!.equals(Buffer.from(BOUND, "base64"))).toBe(true);
  });

  it("states the committed digest and that it is fingerprint.json's", () => {
    expect(result.companion).toMatchObject({
      schema: "PROOVRA_OPENTIMESTAMPS_STATE",
      version: 2,
      status: "PENDING",
      truthState: "PENDING",
      committedDigest: { algorithm: "sha256", hex: FP, fingerprintFile: "fingerprint.json", matchesFingerprint: true },
      proofPresent: true,
      proofFile: "opentimestamps-proof.ots",
      bitcoinTxid: null,
      anchoredAtUtc: null,
      failureReason: null,
    });
  });
});

describe("THE INCIDENT: an attestation read by structure is not an anchor", () => {
  const result = decideOtsPackageArtifact({
    ...base,
    status: "ANCHORED",
    proofBase64: BOUND,
    bitcoinTxid: VALID_TXID,
    anchoredAtUtc: RECORDED,
    upgradedAtUtc: RECORDED,
    anchorCheck: "PROOF_STRUCTURE",
    attestationBlockHeight: 970507,
    otsClient: "opentimestamps-client 0.7.2",
  });

  it("carries no anchor time; the recording time is named for what it is", () => {
    expect(result.companion!.anchoredAtUtc).toBeNull();
    expect(result.companion!.proofRecordedAtUtc).toBe(RECORDED);
  });

  it("reports the txid and height as the proof's, unverified, and claims nothing", () => {
    expect(result.companion).toMatchObject({
      truthState: "ATTESTATION_PRESENT_NOT_VERIFIED",
      statusLine: "Attestation recorded",
      bitcoinTxid: VALID_TXID,
      bitcoinTxidVerified: false,
      reportedBlockHeight: 970507,
      chainVerification: null,
      anchorClaim: "ANCHORED_NOT_CHECKED",
      publicAnchoringVerified: false,
      verificationStatus: "NOT_CHECKED",
      otsClient: "opentimestamps-client 0.7.2",
    });
  });

  it("gives a runnable procedure that separates structure from chain verification", () => {
    const hint = result.companion!.verificationHint;
    expect(hint).toContain("ots info opentimestamps-proof.ots");
    expect(hint).toContain("sha256sum fingerprint.json");
    expect(hint).toContain("ots --bitcoin-node <node URL> verify -d <committedDigest.hex> opentimestamps-proof.ots");
    expect(hint).toContain("Step 1 alone does not verify anything against Bitcoin");
  });
});

describe("CHAIN_VERIFIED: only recorded chain evidence is an anchor", () => {
  const chain = {
    chainVerificationStatus: "VERIFIED",
    chainCheckedAtUtc: "2026-10-12T09:00:00.000Z",
    chainVerifiedAtUtc: "2026-10-12T09:00:00.000Z",
    chainBlockHeight: 970507,
    chainBlockHash: "00000000000000000001ec3f183cf87a623516376df048fed10a1696ed0f328f",
    chainBlockTimeUtc: "2026-10-08T15:24:48.000Z",
    chainConfirmations: 499,
    chainVerifier: "test-double/1",
  };
  const input = {
    ...base,
    status: "ANCHORED",
    proofBase64: BOUND,
    bitcoinTxid: VALID_TXID,
    anchoredAtUtc: "2026-10-08T15:24:48.000Z",
    anchorCheck: "BITCOIN_VERIFIED",
    attestationRecordedAtUtc: RECORDED,
  };

  it("states the verified block time and the evidence", () => {
    const c = decideOtsPackageArtifact({ ...input, ...chain }).companion!;
    expect(c).toMatchObject({
      truthState: "CHAIN_VERIFIED",
      anchoredAtUtc: "2026-10-08T15:24:48.000Z",
      bitcoinTxidVerified: true,
      publicAnchoringVerified: true,
      verificationStatus: "VERIFIED",
    });
    expect(c.chainVerification).toMatchObject({ blockHeight: 970507, confirmations: 499, verifier: "test-double/1" });
  });

  it("a recorded check WITHOUT its chain evidence is not verified", () => {
    const c = decideOtsPackageArtifact(input).companion!;
    expect(c.publicAnchoringVerified).toBe(false);
    expect(c.anchoredAtUtc).toBeNull();
    expect(c.verificationStatus).toBe("NOT_CHECKED");
  });
});

describe("a proof bound to ANOTHER digest is never packaged (real bytes)", () => {
  for (const status of ["PENDING", "ANCHORED", null]) {
    it(`refuses the build while the record presents it as ${String(status)}`, () => {
      expect(() =>
        decideOtsPackageArtifact({ ...base, status, proofBase64: OTHER, anchoredAtUtc: RECORDED, anchorCheck: "PROOF_STRUCTURE" }),
      ).toThrow(/OTS_PROOF_DIGEST_MISMATCH/);
    });
  }

  it("refuses an unreadable proof while the record presents it as pending", () => {
    expect(() =>
      decideOtsPackageArtifact({ ...base, status: "PENDING", proofBase64: Buffer.from("not a proof").toString("base64") }),
    ).toThrow(/OTS_PROOF_UNREADABLE/);
  });

  it("refuses a proof whose digest is right but whose record names another OTS hash", () => {
    expect(() => decideOtsPackageArtifact({ ...base, hash: "f".repeat(64), status: "PENDING", proofBase64: BOUND })).toThrow(
      /OTS_PROOF_DIGEST_MISMATCH/,
    );
  });

  it("refuses when the package's fingerprint digest is unknown — the binding cannot be established", () => {
    expect(() => decideOtsPackageArtifact({ ...base, fingerprintHash: null, status: "PENDING", proofBase64: BOUND })).toThrow(
      /OTS_PROOF_UNREADABLE/,
    );
  });

  it("refuses it even when the worker already recorded it FAILED — a retry cannot get past it (2026-10-12)", () => {
    for (const status of ["FAILED", "ANCHORED", "PENDING"]) {
      expect(() =>
        decideOtsPackageArtifact({ ...base, status, proofBase64: OTHER, failureReason: "PROOF_HASH_MISMATCH" }),
      ).toThrow(/OTS_PROOF_DIGEST_MISMATCH/);
    }
    try {
      decideOtsPackageArtifact({ ...base, status: "FAILED", proofBase64: OTHER });
    } catch (e) {
      expect((e as { retriable?: boolean }).retriable).toBe(false);
    }
  });

  it("packages a correctly bound proof: the refusal is for the binding, not for a missing verifier", () => {
    const r = decideOtsPackageArtifact({ ...base, status: "PENDING", proofBase64: BOUND });
    expect(r.proofBytes).not.toBeNull();
    expect(r.companion!.proofExcludedReason).toBeNull();
  });
});

describe("degradation and FAILED", () => {
  it("ANCHORED without its time degrades to PENDING", () => {
    const r = decideOtsPackageArtifact({ ...base, status: "ANCHORED", proofBase64: BOUND });
    expect(r.companion).toMatchObject({ status: "PENDING", bitcoinTxid: null, anchoredAtUtc: null });
  });

  it("a malformed txid is never echoed", () => {
    const r = decideOtsPackageArtifact({
      ...base,
      status: "ANCHORED",
      proofBase64: BOUND,
      bitcoinTxid: "not-a-txid",
      anchoredAtUtc: RECORDED,
      anchorCheck: "PROOF_STRUCTURE",
    });
    expect(r.companion!.bitcoinTxid).toBeNull();
  });

  it("FAILED (budget) keeps its bound proof: the stamp succeeded, only anchoring did not", () => {
    const r = decideOtsPackageArtifact({ ...base, status: "FAILED", proofBase64: BOUND, failureReason: "OTS_GLOBAL_BUDGET_EXHAUSTED" });
    expect(r.proofBytes).not.toBeNull();
    expect(r.companion).toMatchObject({ status: "FAILED", failureReason: "OTS_GLOBAL_BUDGET_EXHAUSTED", bitcoinTxid: null, anchoredAtUtc: null });
  });

  it("FAILED without a proof emits the companion only", () => {
    const r = decideOtsPackageArtifact({ ...base, status: "FAILED", proofBase64: null, failureReason: "OTS_PROCESSING_FAILED" });
    expect(r.proofBytes).toBeNull();
    expect(r.companion).toMatchObject({ status: "FAILED", proofPresent: false, proofFile: null });
  });
});

describe("DISABLED and robustness", () => {
  it("DISABLED emits nothing, even with stale proof bytes", () => {
    for (const proofBase64 of [null, BOUND]) {
      const r = decideOtsPackageArtifact({ ...base, status: "DISABLED", proofBase64 });
      expect(r.proofBytes).toBeNull();
      expect(r.companion).toBeNull();
    }
  });

  it("empty and null status are UNKNOWN; a bound proof is still packaged", () => {
    for (const status of ["", null]) {
      const r = decideOtsPackageArtifact({ ...base, status, proofBase64: BOUND });
      expect(r.companion!.status).toBe("UNKNOWN");
      expect(r.proofBytes).not.toBeNull();
    }
  });

  it("a zero-length proof is no proof", () => {
    const r = decideOtsPackageArtifact({ ...base, status: "PENDING", proofBase64: "" });
    expect(r.proofBytes).toBeNull();
    expect(r.companion!.proofPresent).toBe(false);
  });

  it("normalizes status casing and trims the txid", () => {
    expect(decideOtsPackageArtifact({ ...base, status: "pending", proofBase64: BOUND }).companion!.status).toBe("PENDING");
    const r = decideOtsPackageArtifact({
      ...base,
      status: "ANCHORED",
      proofBase64: BOUND,
      bitcoinTxid: `  ${VALID_TXID}  `,
      anchoredAtUtc: RECORDED,
      anchorCheck: "PROOF_STRUCTURE",
    });
    expect(r.companion!.bitcoinTxid).toBe(VALID_TXID);
  });
});

describe("processor and builder wiring", () => {
  const processorSrc = readSource("../src/processor.ts");
  const packageSrc = readSource("../src/verification-package.ts");

  it("the processor forwards the OTS state, the truth columns and the client", () => {
    expect(processorSrc).toMatch(/ots:\s*\{[\s\S]*?proofBase64:\s*[\s\S]*?finalized\.finalizedReportEvidencePayload\.otsProofBase64/);
    expect(processorSrc).toContain("status: finalized.finalizedReportEvidencePayload.otsStatus");
    expect(processorSrc).toContain("chainVerificationStatus: finalized.finalizedReportEvidencePayload.otsChainVerificationStatus");
    expect(processorSrc).toContain("attestationRecordedAtUtc: finalized.finalizedReportEvidencePayload.otsAttestationRecordedAtUtc");
    expect(processorSrc).toMatch(/const otsClient = await otsClientIdentity\(\);/);
  });

  it("the builder binds the proof to the SHA-256 of fingerprint.json and writes both artifacts", () => {
    expect(packageSrc).toMatch(/decideOtsPackageArtifact\(\{\s*\.\.\.data\.ots,\s*fingerprintHash: sha256Hex\(Buffer\.from\(data\.fingerprint, "utf8"\)\),/);
    expect(packageSrc).toContain('"opentimestamps-proof.ots"');
    expect(packageSrc).toContain('"opentimestamps.json"');
  });

  it("anchor.json names the digest the proof commits to, and what anchorHash is not", () => {
    expect(packageSrc).toMatch(/otsProofCommitsTo: \{\s*digest: data\.anchor\.fingerprintHash,\s*file: "fingerprint\.json"/);
    expect(packageSrc).toContain("The OpenTimestamps proof does not commit to it");
    expect(packageSrc).toMatch(/anchoredAtUtc: otsCompanion\?\.anchoredAtUtc \?\? null/);
  });
});
