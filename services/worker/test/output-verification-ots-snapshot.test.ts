/**
 * OTS PENDING REPORT REGRESSION (production 2026-10-08, evidence ce465a9e…).
 *
 * The report payload was prepared while otsStatus was still null; OTS
 * initialization then committed PENDING, and the render gate re-read the
 * record: "REPORT_RENDER_INPUT_INCONSISTENT: OTS_STATE (record PENDING,
 * payload UNAVAILABLE)" — a valid report failed terminally into the DLQ.
 *
 * A run now states ONE record snapshot: the payload's lifecycle fields come
 * from the same row the gate's facts do (reportLifecycleFields), so the gate
 * compares like with like. It stays an equality gate: a payload that does not
 * say what its own snapshot says is still refused, and the production
 * message still reproduces when the two come from different reads.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  compareIssuanceFactsToRecord,
  deriveCanonicalArtifactFacts,
  toVerificationStatus,
  type CanonicalArtifactFacts,
} from "@proovra/shared";

import { assertRenderInputs, OutputVerificationError, reportLifecycleFields } from "../src/output-verification.js";
import type { ReportEvidence } from "../src/report-v2/types.js";

type Row = Parameters<typeof reportLifecycleFields>[0];

/** Real OpenTimestamps proofs (opentimestamps-client 0.7.2); see the fixture's _about. */
const PROOFS = JSON.parse(
  readFileSync(new URL("../../../packages/shared/tests/fixtures/ots-proofs.json", import.meta.url), "utf8"),
) as { boundFingerprintHash: string; boundProofBase64: string; otherProofBase64: string };

const BASE_ROW: Row = {
  tsaProvider: null,
  tsaUrl: null,
  tsaSerialNumber: null,
  tsaGenTimeUtc: null,
  tsaTokenBase64: null,
  tsaMessageImprint: null,
  tsaInputDigestHex: null,
  tsaInputKind: null,
  tsaHashAlgorithm: null,
  tsaStatus: null,
  tsaFailureReason: null,
  tsaFailureCode: null,
  tsaValidatedAtUtc: null,
  otsProofBase64: null,
  otsHash: null,
  otsStatus: null,
  otsCalendar: null,
  otsBitcoinTxid: null,
  otsAnchoredAtUtc: null,
  otsUpgradedAtUtc: null,
  otsFailureReason: null,
  otsAnchorCheck: null,
  fingerprintHash: PROOFS.boundFingerprintHash,
};
const DIGEST = "a".repeat(64);
const custody: never[] = [];

function factsOf(row: Row): CanonicalArtifactFacts {
  return deriveCanonicalArtifactFacts(
    { ...row, fileSha256: DIGEST, tsaTokenPresent: Boolean(row.tsaTokenBase64), otsProofPresent: Boolean(row.otsProofBase64) },
    custody,
  );
}
function payloadOf(row: Row): ReportEvidence {
  return {
    fileSha256: DIGEST,
    fingerprintHash: row.fingerprintHash ?? null,
    acquisitionMode: null,
    ...reportLifecycleFields(row, custody),
  } as unknown as ReportEvidence;
}

const PENDING: Row = {
  ...BASE_ROW,
  otsStatus: "PENDING",
  otsHash: PROOFS.boundFingerprintHash,
  otsProofBase64: PROOFS.boundProofBase64,
};
const PRESENT: Row = {
  ...PENDING,
  otsStatus: "ANCHORED",
  otsBitcoinTxid: "c".repeat(64),
  otsAnchoredAtUtc: new Date("2026-10-08T06:00:00Z"),
  otsUpgradedAtUtc: new Date("2026-10-08T06:00:00Z"),
  otsAnchorCheck: "PROOF_STRUCTURE",
};
// (2026-10-12) Verified means a recorded chain check WITH its evidence.
const VERIFIED: Row = {
  ...PRESENT,
  otsAnchorCheck: "BITCOIN_VERIFIED",
  otsChainVerificationStatus: "VERIFIED",
  otsChainCheckedAtUtc: new Date("2026-10-08T07:00:00Z"),
  otsChainVerifiedAtUtc: new Date("2026-10-08T07:00:00Z"),
  otsChainBlockHeight: 970507,
  otsChainBlockHash: "00000000000000000001ec3f183cf87a623516376df048fed10a1696ed0f328f",
  otsChainBlockTimeUtc: new Date("2026-10-08T05:24:48Z"),
  otsChainConfirmations: 6,
  otsChainVerifier: "test-double/1",
};
const FAILED: Row = { ...BASE_ROW, otsStatus: "FAILED", otsFailureReason: "calendar unreachable" };

describe("render gate over ONE snapshot (OTS lifecycle)", () => {
  it("record PENDING: the payload from the same snapshot passes the gate, and states PENDING → NOT_CHECKED", () => {
    const facts = factsOf(PENDING);
    expect(facts.otsState).toBe("PENDING");
    expect(toVerificationStatus(facts.otsState)).toBe("NOT_CHECKED");
    expect(() => assertRenderInputs(facts, payloadOf(PENDING), custody)).not.toThrow();
  });

  it("every OTS stage passes against its own snapshot and projects to the canonical status", () => {
    const cases: Array<[Row, string, string]> = [
      [BASE_ROW, "UNAVAILABLE", "UNAVAILABLE"],
      [PENDING, "PENDING", "NOT_CHECKED"],
      [PRESENT, "PRESENT_NOT_INDEPENDENTLY_VERIFIED", "NOT_CHECKED"],
      [VERIFIED, "PASSED", "VERIFIED"],
      [FAILED, "FAILED", "FAILED"],
    ];
    for (const [row, state, status] of cases) {
      const facts = factsOf(row);
      expect(facts.otsState, state).toBe(state);
      expect(toVerificationStatus(facts.otsState), state).toBe(status);
      expect(() => assertRenderInputs(facts, payloadOf(row), custody), state).not.toThrow();
    }
  });

  it("the production failure reproduces only from a MIXED read (payload prepared before OTS init, record read after)", () => {
    let err: unknown;
    try {
      assertRenderInputs(factsOf(PENDING), payloadOf(BASE_ROW), custody);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(OutputVerificationError);
    expect(String((err as Error).message)).toBe("REPORT_RENDER_INPUT_INCONSISTENT: OTS_STATE (record PENDING, payload UNAVAILABLE)");
  });

  it("a genuine contradiction is still refused: a payload claiming a chain-verified anchor over a PENDING record", () => {
    expect(() => assertRenderInputs(factsOf(PENDING), payloadOf(VERIFIED), custody)).toThrow(/OTS_STATE \(record PENDING, payload PASSED\)/);
  });
});

describe("issuance facts vs a later read: forward progress only", () => {
  it("OTS may advance (not requested → pending → proof present → verified) and may be re-requested after a failure", () => {
    const chain = [BASE_ROW, PENDING, PRESENT, VERIFIED].map(factsOf);
    for (let i = 0; i < chain.length; i += 1) {
      for (let j = i; j < chain.length; j += 1) {
        expect(compareIssuanceFactsToRecord(chain[i]!, chain[j]!), `${chain[i]!.otsState} → ${chain[j]!.otsState}`).toEqual([]);
      }
    }
    expect(compareIssuanceFactsToRecord(factsOf(FAILED), factsOf(PENDING))).toEqual([]);
  });

  it("a later read BEHIND the issuance is a contradiction (verified → bare proof, proof → gone)", () => {
    expect(compareIssuanceFactsToRecord(factsOf(VERIFIED), factsOf(PRESENT)).map((f) => f.check)).toEqual(["OTS_STATE"]);
    expect(compareIssuanceFactsToRecord(factsOf(PRESENT), factsOf(BASE_ROW)).map((f) => f.check)).toEqual(["OTS_STATE"]);
    expect(compareIssuanceFactsToRecord(factsOf(PRESENT), factsOf(PENDING)).map((f) => f.check)).toEqual(["OTS_STATE"]);
  });

  it("a different digest is never 'progress'", () => {
    const later = { ...factsOf(PENDING), evidenceFileSha256: "d".repeat(64) };
    expect(compareIssuanceFactsToRecord(factsOf(PENDING), later).map((f) => f.check)).toEqual(["EVIDENCE_DIGEST"]);
  });
});

describe("the render gate refuses an OTS proof bound to another digest (real proof bytes)", () => {
  const MISBOUND: Row = { ...PRESENT, otsProofBase64: PROOFS.otherProofBase64 };

  it("a record presenting the proof as an attestation while its bytes commit elsewhere is refused, terminal", () => {
    const facts = factsOf(MISBOUND);
    expect(facts.otsDigestBinding).toBe("MISMATCH");
    expect(facts.otsTruthState).toBe("PROOF_INVALID");
    let err: unknown;
    try {
      assertRenderInputs(facts, payloadOf(MISBOUND), custody);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(OutputVerificationError);
    expect((err as OutputVerificationError).retriable).toBe(false);
    expect((err as OutputVerificationError).findings.map((f) => f.check)).toEqual(["OTS_PROOF_DIGEST_MISMATCH"]);
  });

  it("a pending record whose proof bytes commit elsewhere is refused too", () => {
    const pendingMisbound: Row = { ...PENDING, otsProofBase64: PROOFS.otherProofBase64 };
    expect(() => assertRenderInputs(factsOf(pendingMisbound), payloadOf(pendingMisbound), custody)).toThrow(/OTS_PROOF_DIGEST_MISMATCH/);
  });

  it("a record the worker already recorded FAILED (PROOF_HASH_MISMATCH) is refused too: no 'proof unusable' report (2026-10-12)", () => {
    const recordedInvalid: Row = { ...MISBOUND, otsStatus: "FAILED", otsFailureReason: "PROOF_HASH_MISMATCH", otsAnchorCheck: null };
    const facts = factsOf(recordedInvalid);
    expect(facts.otsState).toBe("FAILED");
    expect(() => assertRenderInputs(facts, payloadOf(recordedInvalid), custody)).toThrow(/OTS_PROOF_DIGEST_MISMATCH/);
  });

  it("a correctly bound proof with no verifier renders (the distinction)", () => {
    expect(() => assertRenderInputs(factsOf(PRESENT), payloadOf(PRESENT), custody)).not.toThrow();
  });
});
