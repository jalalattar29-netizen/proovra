/**
 * ET-RPT-09 — the executive conclusion's anchoring claim follows the check.
 *
 * On a40ca76f an OpenTimestamps proof anchored to a Bitcoin block but NOT
 * checked against the chain scored "passed" (10/10) with anchoringState
 * "finalized", so the conclusion said the record had "finalized supporting
 * publication materials" while the OTS callout in the same PDF said
 * "Anchored — chain not checked".
 */
import { describe, expect, it } from "vitest";

import { OTS_ANCHOR_CLAIM_LABELS } from "@proovra/shared";

import { buildExecutiveConclusion } from "../src/report-v2/truth-model.js";
import type { ReportTrustDecision } from "../src/report-v2/types.js";

function decision(anchorSummary: string): ReportTrustDecision {
  return {
    presentationState: "VERIFIED_FINALIZED",
    signals: [{ key: "bitcoin_anchoring", label: "Bitcoin anchoring", status: "passed", points: 10, maxPoints: 10, summary: anchorSummary }],
  } as unknown as ReportTrustDecision;
}

describe("executive conclusion vs the OTS chain check (ET-RPT-09)", () => {
  it("anchored but not chain-checked: no 'finalized' claim, says anchored-not-verified", () => {
    const c = buildExecutiveConclusion(decision(OTS_ANCHOR_CLAIM_LABELS.ANCHORED_NOT_CHECKED));
    expect(c.body).not.toMatch(/finalized/i);
    expect(c.body).toContain("not checked against the Bitcoin chain");
    expect(c.body).toContain("anchored, not as independently verified");
  });

  it("chain-verified keeps the finalized conclusion", () => {
    const c = buildExecutiveConclusion(decision(OTS_ANCHOR_CLAIM_LABELS.VERIFIED));
    expect(c.body).toContain("finalized supporting publication materials");
    expect(c.tone).toBe("success");
  });
});
