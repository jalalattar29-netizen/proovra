/**
 * CROSS-SURFACE AGREEMENT (2026-10-13): ONE OpenTimestamps state on every
 * surface, for every state, on real proof bytes.
 *
 * For each record the test derives what each surface states — the API's wire
 * view (serialized, then read back by a client), the trust decision's signal,
 * the verification matrix row, the report's card words, the verification
 * package companion, the web badge and the mobile card — and requires them all
 * to name the same canonical state the shared authority resolves.
 */
import {
  OTS_STATE_WORDS,
  OTS_VERIFICATION_LABELS,
  OTS_VERIFICATION_WORDS,
  buildEvidenceTrustDecision,
  buildVerificationMatrix,
  otsBlocksPublication,
  otsChainRecordOf,
  otsStateFromTrustState,
  otsVerificationOfSignalState,
  readOtsAnchoringView,
  resolveOtsAnchoring,
  toOtsAnchoringView,
  type OtsState,
  type OtsVerificationKey,
} from "@proovra/shared";
import { describe, expect, it } from "vitest";

import { otsCard } from "../../../apps/mobile/src/product/ots-anchoring.js";
import { otsTone } from "../../../apps/web/components/verify-v2/_helpers.js";
import { REAL, upgradedProof } from "../../../packages/shared/tests/helpers/ots-fixtures.mjs";
import { chainColumnsFor, type ChainFixtureColumns } from "./fixtures/ots-chain-fixtures.js";
import {
  otsStatusWordFor,
  otsVerificationLabelFor,
  REPORT_SNAPSHOT_OTS_LABELS,
  otsVerificationWordFor,
  reportOtsAnchoring,
} from "../src/report-v2/ots-presentation.js";
import { decideOtsPackageArtifact } from "../src/verification-package.js";

const FP = REAL.boundFingerprintHash;
const UP = upgradedProof();

type Case = {
  name: string;
  expected: OtsState;
  /** 2026-10-15: the derived verification every surface presents. */
  verification: OtsVerificationKey;
  status: string | null;
  proofBase64: string | null;
  failureReason?: string | null;
  chain?: ChainFixtureColumns;
};
// 2026-10-15: ANCHORED only means the proof NAMES a block. Without an
// independent chain check bound to this proof it is ATTESTATION_RECORDED —
// never a success on any surface. CHAIN_VERIFIED is the only success.
const CASES: Case[] = [
  { name: "pending proof", expected: "PENDING", verification: "PENDING", status: "PENDING", proofBase64: REAL.boundProofBase64 },
  { name: "upgraded proof", expected: "ANCHORED", verification: "ATTESTATION_RECORDED", status: "ANCHORED", proofBase64: UP.base64 },
  { name: "upgraded proof under a stale PENDING label", expected: "ANCHORED", verification: "ATTESTATION_RECORDED", status: "PENDING", proofBase64: UP.base64 },
  { name: "upgraded proof without a tx step", expected: "ANCHORED", verification: "ATTESTATION_RECORDED", status: "ANCHORED", proofBase64: upgradedProof({ withTransaction: false }).base64 },
  { name: "upgraded proof independently verified against the chain", expected: "ANCHORED", verification: "CHAIN_VERIFIED", status: "ANCHORED", proofBase64: UP.base64, chain: chainColumnsFor(UP) },
  { name: "upgraded proof with confirmations pending", expected: "ANCHORED", verification: "CHAIN_CONFIRMATIONS_PENDING", status: "ANCHORED", proofBase64: UP.base64, chain: chainColumnsFor(UP, { status: "INSUFFICIENT_CONFIRMATIONS" }) },
  { name: "upgraded proof whose chain check failed", expected: "ANCHORED", verification: "CHAIN_FAILED", status: "ANCHORED", proofBase64: UP.base64, chain: chainColumnsFor(UP, { status: "FAILED" }) },
  { name: "upgraded proof whose chain check was unavailable", expected: "ANCHORED", verification: "CHAIN_UNAVAILABLE", status: "ANCHORED", proofBase64: UP.base64, chain: chainColumnsFor(UP, { status: "UNAVAILABLE" }) },
  { name: "a VERIFIED chain record about ANOTHER proof is not believed", expected: "ANCHORED", verification: "ATTESTATION_RECORDED", status: "ANCHORED", proofBase64: UP.base64, chain: chainColumnsFor(UP, { proofSha256: "f".repeat(64) }) },
  { name: "ANCHORED label over a pending proof", expected: "PENDING", verification: "PENDING", status: "ANCHORED", proofBase64: REAL.boundProofBase64 },
  { name: "ANCHORED label and a VERIFIED chain row over a pending proof", expected: "PENDING", verification: "PENDING", status: "ANCHORED", proofBase64: REAL.boundProofBase64, chain: chainColumnsFor(UP) },
  { name: "budget exhausted", expected: "FAILED", verification: "FAILED", status: "FAILED", proofBase64: REAL.boundProofBase64, failureReason: "OTS_GLOBAL_BUDGET_EXHAUSTED" },
  { name: "proof for another digest", expected: "FAILED", verification: "FAILED", status: "ANCHORED", proofBase64: REAL.otherProofBase64 },
  { name: "ANCHORED label with no proof", expected: "UNAVAILABLE", verification: "UNAVAILABLE", status: "ANCHORED", proofBase64: null },
  { name: "disabled", expected: "NOT_REQUESTED", verification: "NOT_REQUESTED", status: "DISABLED", proofBase64: null },
];

function trustDecisionFor(c: Case) {
  return buildEvidenceTrustDecision({
    evidence: {
      verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
      recordedIntegrityVerifiedAtUtc: "2026-10-01T00:00:00.000Z",
      fileSha256: "a".repeat(64),
      fingerprintHash: FP,
      signatureBase64: "c2ln",
      signingKeyId: "k1",
      otsStatus: c.status,
      otsHash: FP,
      otsFailureReason: c.failureReason ?? null,
      otsAnchoredAtUtc: "2026-10-01T02:00:00.000Z",
      otsProofBase64: c.proofBase64,
      ...(c.chain ?? {}),
    },
    custodyEvents: [],
  });
}

describe("one OpenTimestamps state on every surface", () => {
  for (const c of CASES) {
    it(`${c.name} → ${c.expected} / ${c.verification}`, () => {
      const chainRecord = c.chain ? otsChainRecordOf(c.chain) : null;
      const record = {
        status: c.status,
        proofBase64: c.proofBase64,
        fingerprintHash: FP,
        otsHash: FP,
        failureReason: c.failureReason ?? null,
        anchoredAtUtc: "2026-10-01T02:00:00.000Z",
        chain: chainRecord,
      };
      const authority = resolveOtsAnchoring(record);
      expect(authority.state).toBe(c.expected);
      expect(authority.verification).toBe(c.verification);
      const success = c.verification === "CHAIN_VERIFIED";

      // API → wire → client.
      const wire = JSON.parse(JSON.stringify(toOtsAnchoringView(authority)));
      const client = readOtsAnchoringView(wire);
      expect(client.state).toBe(c.expected);
      expect(client.verification).toBe(c.verification);
      expect(client.label).toBe(OTS_VERIFICATION_LABELS[c.verification]);
      expect(client.tone === "success").toBe(success);

      // Web badge: success ONLY for CHAIN_VERIFIED. (The mobile card is pinned
      // in its own block below.)
      expect(otsTone(wire).label).toBe(OTS_VERIFICATION_LABELS[c.verification]);
      expect(otsTone(wire).tone === "success").toBe(success);

      // Trust decision and verification matrix.
      const decision = trustDecisionFor(c);
      const signal = decision.signals.find((s) => s.key === "bitcoin_anchoring")!;
      // The signal carries the verification; the (lossy, legacy) state-only
      // reading names the lifecycle state for every non-chain verification.
      expect(otsVerificationOfSignalState(signal.state, signal.otsVerification)).toBe(c.verification);
      if (!c.verification.startsWith("CHAIN_")) expect(otsStateFromTrustState(signal.state)).toBe(c.expected);
      expect(signal.state === "PASSED").toBe(success);
      const matrix = buildVerificationMatrix({
        signals: decision.signals,
        identity: null,
        acquisitionMode: "PROOVRA_WEB_UPLOAD",
        packageSeal: { kind: "SELF" },
        publication: { kind: "DOCUMENT" },
      });
      const row = matrix.rows.find((r) => r.key === "ots_anchoring")!;
      expect(row.otsState).toBe(c.expected);
      expect(row.otsVerification).toBe(c.verification);

      // The report's card words.
      const report = reportOtsAnchoring({
        otsStatus: c.status,
        otsProofBase64: c.proofBase64,
        otsHash: FP,
        fingerprintHash: FP,
        otsFailureReason: c.failureReason ?? null,
        otsAnchoredAtUtc: "2026-10-01T02:00:00.000Z",
        ...(c.chain ?? {}),
      });
      expect(report.state).toBe(c.expected);
      expect(report.verification).toBe(c.verification);
      expect(otsVerificationWordFor(report.verification)).toBe(OTS_VERIFICATION_WORDS[c.verification]);
      // AUD-48 (2026-10-20) — the report is a snapshot: the live wording, except
      // that an outage at render time is stated as of issue, never as
      // "temporarily unavailable" / "currently" in an immutable PDF.
      expect(otsVerificationLabelFor(report.verification)).toBe(REPORT_SNAPSHOT_OTS_LABELS[report.verification] ?? client.label);
      expect(otsVerificationLabelFor(report.verification)).not.toMatch(/temporarily|currently/i);
      // The lifecycle word (state only) is still the shared table's.
      expect(otsStatusWordFor(report.state)).toBe(OTS_STATE_WORDS[c.expected]);

      // The verification package: the same state and verification — or, for a
      // proof-integrity failure, no package at all.
      const pkg = () =>
        decideOtsPackageArtifact({
          status: c.status,
          proofBase64: c.proofBase64,
          hash: FP,
          fingerprintHash: FP,
          calendar: null,
          anchoredAtUtc: "2026-10-01T02:00:00.000Z",
          upgradedAtUtc: null,
          failureReason: c.failureReason ?? null,
          chain: chainRecord,
        });
      if (otsBlocksPublication(authority)) {
        expect(pkg).toThrow();
      } else {
        const decision = pkg();
        expect(decision.anchoring.state).toBe(c.expected);
        expect(decision.companion?.state ?? "NOT_REQUESTED").toBe(c.expected);
        expect(decision.companion?.verification ?? "NOT_REQUESTED").toBe(c.verification);
      }
    });
  }

  it("an unknown or missing state from a server reads Unavailable on every client, never anchored", () => {
    for (const wire of [undefined, null, {}, { state: "CHAIN_VERIFIED", label: "Verified", tone: "success" }, { state: "anchored" }]) {
      expect(readOtsAnchoringView(wire).state).toBe("UNAVAILABLE");
      expect(otsTone(wire).tone).not.toBe("success");
      expect(otsCard(wire, "de").state).toBe("UNAVAILABLE");
    }
  });

  it("a CHAIN_VERIFIED claim on the wire without a VERIFIED chain fact reads as an unchecked attestation, never a success", () => {
    const forged = { ...JSON.parse(JSON.stringify(toOtsAnchoringView(resolveOtsAnchoring({ status: "ANCHORED", proofBase64: UP.base64, fingerprintHash: FP, otsHash: FP })))), verification: "CHAIN_VERIFIED", tone: "success" };
    expect(readOtsAnchoringView(forged).verification).toBe("ATTESTATION_RECORDED");
    expect(otsTone(forged).tone).not.toBe("success");
  });
});

// The mobile card reads the same wire view: its word follows the verification
// and its check mark appears ONLY for CHAIN_VERIFIED (2026-10-15 contract).
describe("the mobile card states the same verification (apps/mobile otsCard)", () => {
  for (const c of CASES) {
    it(`${c.name} → ${c.verification}`, () => {
      const authority = resolveOtsAnchoring({
        status: c.status,
        proofBase64: c.proofBase64,
        fingerprintHash: FP,
        otsHash: FP,
        failureReason: c.failureReason ?? null,
        anchoredAtUtc: "2026-10-01T02:00:00.000Z",
        chain: c.chain ? otsChainRecordOf(c.chain) : null,
      });
      const card = otsCard(JSON.parse(JSON.stringify(toOtsAnchoringView(authority))), "en");
      expect(card.state).toBe(c.expected);
      expect(card.status).toBe(OTS_VERIFICATION_WORDS[c.verification]);
      expect(card.check).toBe(c.verification === "CHAIN_VERIFIED");
    });
  }

  it("a forged CHAIN_VERIFIED claim never shows a check mark", () => {
    const forged = { ...JSON.parse(JSON.stringify(toOtsAnchoringView(resolveOtsAnchoring({ status: "ANCHORED", proofBase64: UP.base64, fingerprintHash: FP, otsHash: FP })))), verification: "CHAIN_VERIFIED", tone: "success" };
    expect(otsCard(forged, "en").check).toBe(false);
  });
});
