/**
 * OTS AND THE RENDER GATE (production 2026-10-08, evidence ce465a9e…;
 * re-stated on the one OTS authority 2026-10-13).
 *
 * The report payload was prepared while otsStatus was still null; OTS
 * initialization then committed PENDING, and the render gate re-read the
 * record — a valid report failed terminally. A run states ONE record snapshot:
 * the payload's lifecycle fields come from the same row the gate's facts do
 * (reportLifecycleFields). The gate compares the canonical OTS state, resolved
 * from the stored proof bytes (real OpenTimestamps bytes here).
 */
import { describe, expect, it } from "vitest";

import { compareIssuanceFactsToRecord, deriveCanonicalArtifactFacts, type CanonicalArtifactFacts } from "@proovra/shared";

import { REAL, upgradedProof } from "../../../packages/shared/tests/helpers/ots-fixtures.mjs";
import { assertRenderInputs, OutputVerificationError, reportLifecycleFields } from "../src/output-verification.js";
import type { ReportEvidence } from "../src/report-v2/types.js";

type Row = Parameters<typeof reportLifecycleFields>[0] & { fingerprintHash: string | null };

const FP = REAL.boundFingerprintHash;
const UPGRADED = upgradedProof();

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
  fingerprintHash: FP,
} as Row;
const DIGEST = "a".repeat(64);
const custody: never[] = [];

function factsOf(row: Row): CanonicalArtifactFacts {
  return deriveCanonicalArtifactFacts({ ...row, fileSha256: DIGEST, tsaTokenPresent: Boolean(row.tsaTokenBase64) }, custody);
}
function payloadOf(row: Row): ReportEvidence {
  return {
    fileSha256: DIGEST,
    fingerprintHash: row.fingerprintHash ?? null,
    acquisitionMode: null,
    ...reportLifecycleFields(row, custody),
  } as unknown as ReportEvidence;
}

const PENDING: Row = { ...BASE_ROW, otsStatus: "PENDING", otsHash: FP, otsProofBase64: REAL.boundProofBase64 };
const ANCHORED: Row = {
  ...PENDING,
  otsStatus: "ANCHORED",
  otsProofBase64: UPGRADED.base64,
  otsBitcoinTxid: UPGRADED.txid,
  otsAnchoredAtUtc: new Date("2026-10-08T06:00:00Z"),
  otsUpgradedAtUtc: new Date("2026-10-08T06:00:00Z"),
};
/** A legacy ANCHORED label with a txid over a proof with no Bitcoin attestation. */
const LABEL_ONLY: Row = { ...PENDING, otsStatus: "ANCHORED", otsBitcoinTxid: "c".repeat(64), otsAnchoredAtUtc: new Date("2026-10-08T06:00:00Z") };
const BUDGET_FAILED: Row = { ...PENDING, otsStatus: "FAILED", otsFailureReason: "OTS_GLOBAL_BUDGET_EXHAUSTED" };
const MISSING: Row = { ...BASE_ROW, otsStatus: "PENDING", otsHash: FP };

describe("render gate over ONE snapshot", () => {
  it("every OTS state passes against its own snapshot", () => {
    const cases: Array<[Row, string]> = [
      [BASE_ROW, "NOT_REQUESTED"],
      [PENDING, "PENDING"],
      [ANCHORED, "ANCHORED"],
      [LABEL_ONLY, "PENDING"],
      [BUDGET_FAILED, "FAILED"],
      [MISSING, "UNAVAILABLE"],
    ];
    for (const [row, state] of cases) {
      const facts = factsOf(row);
      expect(facts.otsState, state).toBe(state);
      expect(() => assertRenderInputs(facts, payloadOf(row), custody), state).not.toThrow();
    }
  });

  it("the anchored state carries the stored proof's SHA-256", () => {
    expect(factsOf(ANCHORED).otsProofSha256).toBe(UPGRADED.proofSha256);
  });

  it("the production failure reproduces only from a MIXED read", () => {
    let err: unknown;
    try {
      assertRenderInputs(factsOf(PENDING), payloadOf(BASE_ROW), custody);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(OutputVerificationError);
    expect(String((err as Error).message)).toBe("REPORT_RENDER_INPUT_INCONSISTENT: OTS_STATE (record PENDING, payload NOT_REQUESTED)");
  });

  it("a payload claiming ANCHORED over a PENDING record is refused", () => {
    expect(() => assertRenderInputs(factsOf(PENDING), payloadOf(ANCHORED), custody)).toThrow(/OTS_STATE \(record PENDING, payload ANCHORED\)/);
  });
});

describe("issuance facts vs a later read: forward progress only", () => {
  it("OTS may advance (not requested → pending → anchored) and be re-requested after a failure", () => {
    const chain = [BASE_ROW, PENDING, ANCHORED].map(factsOf);
    for (let i = 0; i < chain.length; i += 1) {
      for (let j = i; j < chain.length; j += 1) {
        expect(compareIssuanceFactsToRecord(chain[i]!, chain[j]!), `${chain[i]!.otsState} → ${chain[j]!.otsState}`).toEqual([]);
      }
    }
    expect(compareIssuanceFactsToRecord(factsOf(BUDGET_FAILED), factsOf(PENDING))).toEqual([]);
  });

  it("a later read BEHIND the issuance is a contradiction (anchored → pending, pending → not requested)", () => {
    expect(compareIssuanceFactsToRecord(factsOf(ANCHORED), factsOf(PENDING)).map((f) => f.check)).toEqual(["OTS_STATE"]);
    expect(compareIssuanceFactsToRecord(factsOf(PENDING), factsOf(BASE_ROW)).map((f) => f.check)).toEqual(["OTS_STATE"]);
  });

  it("a different digest is never 'progress'", () => {
    const later = { ...factsOf(PENDING), evidenceFileSha256: "d".repeat(64) };
    expect(compareIssuanceFactsToRecord(factsOf(PENDING), later).map((f) => f.check)).toEqual(["EVIDENCE_DIGEST"]);
  });
});

describe("the render gate refuses a proof-integrity failure (real proof bytes)", () => {
  const MISBOUND: Row = { ...ANCHORED, otsProofBase64: REAL.otherProofBase64 };

  it("a record presenting the proof as anchored while its bytes commit elsewhere is refused, terminal", () => {
    const facts = factsOf(MISBOUND);
    expect(facts.otsState).toBe("FAILED");
    expect(facts.otsFailureCode).toBe("PROOF_HASH_MISMATCH");
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

  it("a malformed Bitcoin attestation is refused as OTS_PROOF_INVALID", () => {
    const row: Row = { ...ANCHORED, otsProofBase64: upgradedProof({ trailingPayload: new Uint8Array([1]) }).base64 };
    expect(() => assertRenderInputs(factsOf(row), payloadOf(row), custody)).toThrow(/OTS_PROOF_INVALID/);
  });

  it("an exhausted budget and a missing proof do NOT block the report", () => {
    expect(() => assertRenderInputs(factsOf(BUDGET_FAILED), payloadOf(BUDGET_FAILED), custody)).not.toThrow();
    expect(() => assertRenderInputs(factsOf(MISSING), payloadOf(MISSING), custody)).not.toThrow();
  });
});
