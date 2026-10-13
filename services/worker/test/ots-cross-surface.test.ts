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
  OTS_STATE_LABELS,
  OTS_STATE_WORDS,
  buildEvidenceTrustDecision,
  buildVerificationMatrix,
  otsBlocksPublication,
  otsStateFromTrustState,
  readOtsAnchoringView,
  resolveOtsAnchoring,
  toOtsAnchoringView,
  type OtsState,
} from "@proovra/shared";
import { describe, expect, it } from "vitest";

import { otsCard } from "../../../apps/mobile/src/product/ots-anchoring.js";
import { otsTone } from "../../../apps/web/components/verify-v2/_helpers.js";
import { REAL, upgradedProof } from "../../../packages/shared/tests/helpers/ots-fixtures.mjs";
import { otsStatusLineFor, otsStatusWordFor, reportOtsAnchoring } from "../src/report-v2/ots-presentation.js";
import { decideOtsPackageArtifact } from "../src/verification-package.js";

const FP = REAL.boundFingerprintHash;

type Case = { name: string; expected: OtsState; status: string | null; proofBase64: string | null; failureReason?: string | null };
const CASES: Case[] = [
  { name: "pending proof", expected: "PENDING", status: "PENDING", proofBase64: REAL.boundProofBase64 },
  { name: "upgraded proof", expected: "ANCHORED", status: "ANCHORED", proofBase64: upgradedProof().base64 },
  { name: "upgraded proof under a stale PENDING label", expected: "ANCHORED", status: "PENDING", proofBase64: upgradedProof().base64 },
  { name: "upgraded proof without a tx step", expected: "ANCHORED", status: "ANCHORED", proofBase64: upgradedProof({ withTransaction: false }).base64 },
  { name: "ANCHORED label over a pending proof", expected: "PENDING", status: "ANCHORED", proofBase64: REAL.boundProofBase64 },
  { name: "budget exhausted", expected: "FAILED", status: "FAILED", proofBase64: REAL.boundProofBase64, failureReason: "OTS_GLOBAL_BUDGET_EXHAUSTED" },
  { name: "proof for another digest", expected: "FAILED", status: "ANCHORED", proofBase64: REAL.otherProofBase64 },
  { name: "ANCHORED label with no proof", expected: "UNAVAILABLE", status: "ANCHORED", proofBase64: null },
  { name: "disabled", expected: "NOT_REQUESTED", status: "DISABLED", proofBase64: null },
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
    },
    custodyEvents: [],
  });
}

describe("one OpenTimestamps state on every surface", () => {
  for (const c of CASES) {
    it(`${c.name} → ${c.expected}`, () => {
      const record = {
        status: c.status,
        proofBase64: c.proofBase64,
        fingerprintHash: FP,
        otsHash: FP,
        failureReason: c.failureReason ?? null,
        anchoredAtUtc: "2026-10-01T02:00:00.000Z",
      };
      const authority = resolveOtsAnchoring(record);
      expect(authority.state).toBe(c.expected);

      // API → wire → client.
      const wire = JSON.parse(JSON.stringify(toOtsAnchoringView(authority)));
      const client = readOtsAnchoringView(wire);
      expect(client.state).toBe(c.expected);
      expect(client.label).toBe(OTS_STATE_LABELS[c.expected]);

      // Web badge and mobile card.
      expect(otsTone(wire).label).toBe(OTS_STATE_LABELS[c.expected]);
      expect(otsTone(wire).tone === "success").toBe(c.expected === "ANCHORED");
      const card = otsCard(wire, "en");
      expect(card.state).toBe(c.expected);
      expect(card.status).toBe(OTS_STATE_WORDS[c.expected]);
      expect(card.check).toBe(c.expected === "ANCHORED");

      // Trust decision and verification matrix.
      const decision = trustDecisionFor(c);
      const signal = decision.signals.find((s) => s.key === "bitcoin_anchoring")!;
      expect(otsStateFromTrustState(signal.state)).toBe(c.expected);
      const matrix = buildVerificationMatrix({
        signals: decision.signals,
        identity: null,
        acquisitionMode: "PROOVRA_WEB_UPLOAD",
        packageSeal: { kind: "SELF" },
        publication: { kind: "DOCUMENT" },
      });
      expect(matrix.rows.find((r) => r.key === "ots_anchoring")!.otsState).toBe(c.expected);

      // The report's card words.
      const report = reportOtsAnchoring({
        otsStatus: c.status,
        otsProofBase64: c.proofBase64,
        otsHash: FP,
        fingerprintHash: FP,
        otsFailureReason: c.failureReason ?? null,
        otsAnchoredAtUtc: "2026-10-01T02:00:00.000Z",
      });
      expect(report.state).toBe(c.expected);
      expect(otsStatusWordFor(report.state)).toBe(card.status);
      expect(otsStatusLineFor(report.state)).toBe(client.label);

      // The verification package: the same state — or, for a proof-integrity
      // failure, no package at all.
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
        });
      if (otsBlocksPublication(authority)) {
        expect(pkg).toThrow();
      } else {
        const decision = pkg();
        expect(decision.anchoring.state).toBe(c.expected);
        expect(decision.companion?.state ?? "NOT_REQUESTED").toBe(c.expected);
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
});
