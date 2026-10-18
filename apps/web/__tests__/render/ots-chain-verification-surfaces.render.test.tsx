/**
 * OPENTIMESTAMPS — ONLY AN INDEPENDENT BITCOIN-CHAIN CHECK IS GREEN (2026-10-15).
 *
 * ANCHORED now means only "a Bitcoin attestation is recorded": the proof names
 * a block, and PROOVRA has not checked it against the Bitcoin main chain. The
 * derived verification key decides every surface; CHAIN_VERIFIED is the only
 * key that may be green, carry ✓, read "Verified", or be counted as a success.
 *
 *   (a) ANCHORED without a chain check: "Bitcoin attestation recorded" +
 *       "Not independently checked against Bitcoin", neutral, no "Verified".
 *   (b) CHAIN_VERIFIED: the green "Independently verified against the Bitcoin
 *       main chain" with block height and confirmations.
 *   (c) CHAIN_FAILED and FAILED: danger.
 *   (d) PENDING: never danger.
 *   (e) filter chips and admin badges: human words, never raw codes.
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { ArtifactTruthHeader, otsLabel } from "../../components/evidence-outputs/ArtifactTruthHeader";
import { otsTrustRow } from "../../components/home-experience/HomeSections";
import {
  VERIFY_MATRIX_INTRO,
  VerificationMatrixGrid,
  otsMatrixRowPresentation,
} from "../../app/verify/[token]/VerifyMatrixPanels";
import { trustFilterChips } from "../../app/(app)/evidence/lib/evidence-trust-filter-chips";
import { otsFilterValueLabel, otsRawStatusPresentation } from "../../lib/ots-presentation";
import { OTS_VERIFICATION_TONES } from "@proovra/shared";

afterEach(() => cleanup());

const CHAIN = {
  status: "VERIFIED",
  failureCode: null,
  blockHeight: 812345,
  blockHash: "0".repeat(10) + "a".repeat(54),
  blockTimeUtc: "2026-10-01T00:00:00Z",
  confirmations: 14,
  minConfirmations: 6,
  checkedAtUtc: "2026-10-02T08:00:00Z",
  verifiedAtUtc: "2026-10-02T08:00:00Z",
  verifier: "bitcoin-core",
};

const OTS = {
  recorded: { state: "ANCHORED", verification: "ATTESTATION_RECORDED", bitcoinBlockHeight: 812345, anchoredAtUtc: "2026-10-01T01:00:00Z" },
  verified: { state: "ANCHORED", verification: "CHAIN_VERIFIED", bitcoinBlockHeight: 812345, anchoredAtUtc: "2026-10-01T01:00:00Z", chain: CHAIN },
  chainFailed: {
    state: "ANCHORED",
    verification: "CHAIN_FAILED",
    bitcoinBlockHeight: 812345,
    chain: { ...CHAIN, status: "FAILED", failureCode: "ROOT_MISMATCH", verifiedAtUtc: null },
  },
  confirmations: {
    state: "ANCHORED",
    verification: "CHAIN_CONFIRMATIONS_PENDING",
    bitcoinBlockHeight: 812345,
    chain: { ...CHAIN, status: "INSUFFICIENT_CONFIRMATIONS", confirmations: 3, verifiedAtUtc: null },
  },
  chainUnavailable: {
    state: "ANCHORED",
    verification: "CHAIN_UNAVAILABLE",
    chain: { ...CHAIN, status: "UNAVAILABLE", failureCode: "BTC_RPC_TIMEOUT", verifiedAtUtc: null },
  },
  failed: { state: "FAILED", failureCode: "PROOF_HASH_MISMATCH" },
  pending: { state: "PENDING" },
} as const;

const fmt = (v: string | number | null | undefined) => String(v ?? "");

function header(ots: unknown) {
  return render(
    <ArtifactTruthHeader
      latest={null}
      trust={{ tsa: null, ots } as never}
      freshness={null}
      activeRequest={null}
      formatDateTime={fmt}
      formatBytes={fmt}
      actions={null}
    />,
  );
}
const factTone = (el: HTMLElement) => el.closest("[data-tone]")?.getAttribute("data-tone");

describe("Artifact truth header — Bitcoin anchoring", () => {
  it("(a) ANCHORED without a chain check: attestation recorded, not independently checked, neutral, NOT_CHECKED", () => {
    const { getByTestId } = header(OTS.recorded);
    expect(getByTestId("truth-ots").textContent).toBe("Bitcoin attestation recorded");
    expect(getByTestId("truth-ots-status").textContent).toBe("Not independently checked against Bitcoin");
    expect(getByTestId("truth-ots-status").getAttribute("data-verification-status")).toBe("NOT_CHECKED");
    expect(factTone(getByTestId("truth-ots"))).toBe("neutral");
    const fact = getByTestId("truth-ots").closest(".rga-truth__fact")!.textContent ?? "";
    expect(fact).not.toMatch(/✓|Verified\b/);
  });

  it("(b) CHAIN_VERIFIED: the only green ✓ 'Independently verified against the Bitcoin main chain', VERIFIED, dated by the check", () => {
    const { getByTestId } = header(OTS.verified);
    expect(getByTestId("truth-ots").textContent).toBe("✓ Independently verified against the Bitcoin main chain");
    expect(factTone(getByTestId("truth-ots"))).toBe("ok");
    expect(getByTestId("truth-ots-status").getAttribute("data-verification-status")).toBe("VERIFIED");
    expect(getByTestId("truth-ots-measured").textContent).toBe("Checked against the Bitcoin main chain 2026-10-02T08:00:00Z");
    const o = otsLabel(OTS.verified as never);
    expect(o.sentence).toMatch(/^Merkle root matches Bitcoin block 812345; 14 confirmations at 2026-10-02/);
  });

  it("(c) CHAIN_FAILED and FAILED are danger", () => {
    const failedChain = header(OTS.chainFailed);
    expect(failedChain.getByTestId("truth-ots").textContent).toBe("Bitcoin verification failed");
    expect(factTone(failedChain.getByTestId("truth-ots"))).toBe("danger");
    expect(failedChain.getByTestId("truth-ots-status").getAttribute("data-verification-status")).toBe("FAILED");
    cleanup();
    const failed = header(OTS.failed);
    expect(failed.getByTestId("truth-ots").textContent).toBe("Bitcoin anchoring failed");
    expect(factTone(failed.getByTestId("truth-ots"))).toBe("danger");
  });

  it("(d) PENDING, pending confirmations and an unavailable chain are never danger and never green", () => {
    for (const ots of [OTS.pending, OTS.confirmations, OTS.chainUnavailable]) {
      const { getByTestId } = header(ots);
      expect(factTone(getByTestId("truth-ots"))).toBe("neutral");
      expect(getByTestId("truth-ots").textContent).not.toMatch(/✓/);
      cleanup();
    }
    expect(otsLabel(OTS.confirmations as never).label).toBe("Bitcoin verification pending");
    expect(otsLabel(OTS.confirmations as never).sentence).toBe(
      "The proof matches Bitcoin block 812345; 3 of 6 confirmations recorded.",
    );
    expect(otsLabel(OTS.chainUnavailable as never).label).toBe("Bitcoin verification temporarily unavailable");
  });
});

// ---------------------------------------------------------------------------
// Public Verify — the matrix row and its intro
// ---------------------------------------------------------------------------

function otsRow(over: Record<string, unknown>) {
  return {
    key: "ots_anchoring",
    label: "Bitcoin anchoring",
    status: "NOT_CHECKED",
    statement: "Statement.",
    otsState: "ANCHORED",
    otsVerification: "ATTESTATION_RECORDED",
    ...over,
  } as never;
}

describe("Public Verify — the Bitcoin anchoring matrix row", () => {
  // The rich page prints the row's server statusLabel (the shared matrix sets
  // it to OTS_VERIFICATION_WORDS[verification]) beside the status icon.
  it("(a) an attestation recorded is a neutral 'Attestation recorded' — never Verified", () => {
    const { getByTestId } = render(<VerificationMatrixGrid rows={[otsRow({ statusLabel: "Attestation recorded" })]} />);
    expect(getByTestId("verify-matrix-status-ots_anchoring").textContent).toBe("○Attestation recorded");
    expect(getByTestId("verify-matrix-status-ots_anchoring").getAttribute("data-status")).toBe("NOT_CHECKED");
    expect(otsMatrixRowPresentation(otsRow({}))?.tone).toBe("neutral");
  });

  it("(b) CHAIN_VERIFIED on a VERIFIED row is the only ✓; on a row that is not VERIFIED it is not believed", () => {
    const { getByTestId } = render(
      <VerificationMatrixGrid rows={[otsRow({ status: "VERIFIED", otsVerification: "CHAIN_VERIFIED", statusLabel: "Independently verified" })]} />,
    );
    expect(getByTestId("verify-matrix-status-ots_anchoring").textContent).toBe("✓Independently verified");
    expect(otsMatrixRowPresentation(otsRow({ status: "VERIFIED", otsVerification: "CHAIN_VERIFIED" }))?.tone).toBe("success");
    expect(otsMatrixRowPresentation(otsRow({ status: "NOT_CHECKED", otsVerification: "CHAIN_VERIFIED" }))).toMatchObject({
      word: "Attestation recorded",
      tone: "neutral",
    });
  });

  it("(c) FAILED and CHAIN_FAILED rows are danger; (d) PENDING is neutral", () => {
    expect(otsMatrixRowPresentation(otsRow({ status: "FAILED", otsState: "FAILED", otsVerification: "FAILED" }))?.tone).toBe("danger");
    expect(otsMatrixRowPresentation(otsRow({ status: "FAILED", otsVerification: "CHAIN_FAILED" }))).toMatchObject({
      word: "Verification failed",
      tone: "danger",
    });
    expect(otsMatrixRowPresentation(otsRow({ status: "NOT_CHECKED", otsState: "PENDING", otsVerification: "PENDING" }))).toMatchObject({
      word: "Pending",
      tone: "neutral",
    });
  });

  it("the matrix intro uses the new vocabulary: Verified only for an independent Bitcoin main-chain check", () => {
    expect(VERIFY_MATRIX_INTRO).toContain("Bitcoin anchoring is Verified only when PROOVRA independently checked");
    expect(VERIFY_MATRIX_INTRO).toContain("“Attestation recorded”");
    expect(VERIFY_MATRIX_INTRO).not.toMatch(/\banchored\b/i);
  });
});

// ---------------------------------------------------------------------------
// Home — the OpenTimestamps trust row
// ---------------------------------------------------------------------------

describe("Home — OpenTimestamps trust row", () => {
  it("recorded attestations are neutral (never ok/green); pending is attention, never danger; only failed is danger", () => {
    const row = otsTrustRow({ otsAnchored: 4, otsPending: 2, otsFailed: 0, otsNone: 3 });
    expect(row.value).toBe("4 attestations recorded · 2 pending · 3 not anchored yet");
    expect(row.segments?.find((s) => s.text === "4 attestations recorded")?.tone).toBe("neutral");
    expect(row.segments?.find((s) => s.text === "2 pending")?.tone).toBe("warn");
    expect(row.segments?.find((s) => s.text === "3 not anchored yet")?.tone).toBe("neutral");
    expect(row.segments?.some((s) => s.tone === "ok" || s.tone === "danger")).toBe(false);
    expect(row.tone).toBe("warn");
    expect(otsTrustRow({ otsAnchored: 10, otsPending: 0, otsFailed: 0, otsNone: 0 }).tone).toBe("neutral");
    expect(otsTrustRow({ otsAnchored: 1, otsPending: 0, otsFailed: 0, otsNone: 0 }).value).toBe("1 attestation recorded");
    const failed = otsTrustRow({ otsAnchored: 1, otsPending: 1, otsFailed: 2, otsNone: 0 });
    expect(failed.tone).toBe("danger");
    expect(failed.segments?.find((s) => s.text === "2 failed")?.tone).toBe("danger");
  });
});

// ---------------------------------------------------------------------------
// (e) Evidence library chips and admin badges — words, never raw codes
// ---------------------------------------------------------------------------

const RAW_CODE = /\b(ANCHORED|PENDING|FAILED|UPGRADING|QUEUED|ERRORED|ERROR|ATTESTATION_RECORDED|CHAIN_[A-Z_]+|NOT_REQUESTED|REVIEW_REQUIRED)\b/;

describe("(e) filter chips and admin badges", () => {
  it("Bitcoin anchoring chips speak the shared words; stored codes fold onto one word each", () => {
    const chips = trustFilterChips({
      otsStatus: "PENDING,UPGRADING,QUEUED",
      tsaStatus: "FAILED",
      verificationDisclosure: "CONTENT_PREVIEW",
      verificationStatus: "REVIEW_REQUIRED,FAILED",
    });
    const labels = chips.map((c) => c.label);
    expect(labels).toEqual([
      "Trust timestamp: Failed",
      "Bitcoin anchoring: Pending",
      "Verification page: Content preview",
      "Needs integrity review",
    ]);
    for (const label of labels) expect(label).not.toMatch(RAW_CODE);
    expect(otsFilterValueLabel("ANCHORED")).toBe("Attestation recorded");
    expect(otsFilterValueLabel("FAILED,ERRORED,ERROR")).toBe("Failed");
    expect(otsFilterValueLabel("ATTESTATION_RECORDED")).toBe("Attestation recorded");
    expect(otsFilterValueLabel("CHAIN_VERIFIED")).toBe("Independently verified");
    // A legacy stored "VERIFIED"/"OK" never reads as verified.
    expect(otsFilterValueLabel("VERIFIED,OK")).toBe("Attestation recorded");
    expect(trustFilterChips({ otsStatus: "all" })).toEqual([]);
  });

  it("the admin records badge renders the API's verification key in words; only CHAIN_VERIFIED is a success", () => {
    expect(otsRawStatusPresentation("ATTESTATION_RECORDED")).toMatchObject({
      label: "Bitcoin attestation recorded",
      tone: "neutral",
    });
    expect(otsRawStatusPresentation("CHAIN_VERIFIED")).toMatchObject({
      label: "Independently verified against the Bitcoin main chain",
      tone: "success",
    });
    expect(otsRawStatusPresentation("CHAIN_FAILED").tone).toBe("danger");
    expect(otsRawStatusPresentation("FAILED").tone).toBe("danger");
    expect(otsRawStatusPresentation("PENDING")).toMatchObject({ label: "OpenTimestamps proof pending", tone: "neutral" });
    // An old server sending the stored lifecycle state: never a success.
    expect(otsRawStatusPresentation("ANCHORED")).toMatchObject({ verification: "ATTESTATION_RECORDED", tone: "neutral" });
    expect(otsRawStatusPresentation("SOMETHING_NEW")).toMatchObject({ verification: "UNAVAILABLE", tone: "neutral" });
    for (const raw of ["ATTESTATION_RECORDED", "CHAIN_VERIFIED", "CHAIN_FAILED", "PENDING", "ANCHORED"]) {
      expect(otsRawStatusPresentation(raw).label).not.toMatch(RAW_CODE);
    }
  });

  it("the shared OpenTimestamps tones never paint an unchecked attestation green", () => {
    // The owner page's substring tone mapper is gone; the shared table is the
    // one authority every surface reads.
    expect(OTS_VERIFICATION_TONES.ATTESTATION_RECORDED).toBe("neutral");
    expect(OTS_VERIFICATION_TONES.CHAIN_CONFIRMATIONS_PENDING).toBe("neutral");
    expect(OTS_VERIFICATION_TONES.CHAIN_UNAVAILABLE).toBe("neutral");
    expect(OTS_VERIFICATION_TONES.PENDING).toBe("neutral");
    expect(OTS_VERIFICATION_TONES.CHAIN_VERIFIED).toBe("success");
    expect(OTS_VERIFICATION_TONES.CHAIN_FAILED).toBe("danger");
    expect(otsRawStatusPresentation("ANCHORED").tone).not.toBe("success");
  });
});
