/**
 * EVIDENCE-CLAIMS CORRECTION (2026-10-08) — every web surface states a record
 * signal by signal through the verification matrix: no numeric trust score,
 * no weighted points, no overall verdict ("strongly verified"), no reliance or
 * confidence level. An OpenTimestamps proof that is present but not checked
 * against the chain is NOT_CHECKED, and the bounded summary and the fixed
 * limitation are always stated.
 *
 * The web deploys before the API, so the old response shape (score, verdict,
 * relianceLevel, points …) is fed through each surface here: none of it may
 * reach the page.
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  VERIFICATION_LIMITATION,
  buildVerificationMatrix,
  findForbiddenCustomerClaims,
  readStoredTrustDecision,
  type BasicVerification,
  type VerificationMatrix,
} from "@proovra/shared";

import {
  VerificationMatrixGrid,
  VerificationSummaryCard,
  matrixRequiresIntegrityReview,
  resolveVerifyMatrix,
} from "../../app/verify/[token]/VerifyMatrixPanels";
import BasicVerificationView from "../../app/verify/[token]/BasicVerificationView";
import { TrustDecisionSummary } from "../../app/(app)/evidence/[id]/_tabs/technical-appendix/TrustDecisionSummary";

afterEach(() => cleanup());

const AT = "2026-10-01T00:00:00.000Z";

/** A trust decision exactly as an API deployed before 2026-10-08 returns it. */
function oldApiTrustDecision() {
  return {
    verdict: "STRONGLY_VERIFIED",
    verdictLabel: "Strongly verified",
    shortLabel: "Strongly verified",
    score: 96,
    scoreLabel: "96/100",
    maxScore: 100,
    confidenceLabel: "High",
    relianceLevel: "high",
    degradedButUsable: false,
    primaryReason: "All signals passed.",
    passedSignals: 7,
    degradedSignals: 0,
    failedSignals: 0,
    summary: "Strongly verified (96/100). Reviewer reliance: high. No degraded signals.",
    reviewerAction: "Rely on this record.",
    tone: "success",
    signals: [
      { key: "core_integrity", label: "Core integrity", status: "passed", tone: "success", points: 30, maxPoints: 30, summary: "Fingerprint matches.", detail: "" },
      { key: "signature", label: "Signature", status: "passed", tone: "success", points: 15, maxPoints: 15, summary: "Signature valid.", detail: "" },
      { key: "custody_chain", label: "Custody chain", status: "passed", tone: "success", points: 15, maxPoints: 15, summary: "Chain intact.", detail: "" },
      { key: "trusted_timestamp", label: "Trusted timestamp", status: "passed", tone: "success", points: 15, maxPoints: 15, summary: "Timestamp issued.", detail: "" },
      // A legacy anchoring "passed" was awarded for a proof's PRESENCE: it is
      // never read as chain-verified.
      { key: "bitcoin_anchoring", label: "Bitcoin anchoring", status: "passed", tone: "success", points: 10, maxPoints: 10, summary: "Proof present", detail: "" },
      { key: "immutable_storage", label: "Immutable storage", status: "passed", tone: "success", points: 10, maxPoints: 10, summary: "Object lock recorded.", detail: "" },
    ],
  };
}

function expectNoRetiredClaims(text: string) {
  expect(findForbiddenCustomerClaims(text)).toEqual([]);
  expect(text).not.toMatch(/\b\d{1,3}\s*\/\s*100\b/);
  expect(text).not.toMatch(/\bpoints\b/i);
  expect(text).not.toMatch(/STRONGLY|Strongly verified/i);
  expect(text).not.toMatch(/Reviewer reliance|Reliance level|Technical Confidence|Confidence: High/i);
  expect(text).not.toMatch(/Passed signals|No degraded signals/i);
}

describe("Public Verify — matrix panels (old API without verificationMatrix)", () => {
  const decision = readStoredTrustDecision(oldApiTrustDecision())!;
  const matrix = resolveVerifyMatrix(null, decision);

  it("derives the signal rows from the trust decision when the API sent no matrix", () => {
    expect(matrix.rows.map((r) => r.key)).toEqual([
      "file_integrity",
      "record_signature",
      "custody_chain",
      "tsa_token",
      "ots_anchoring",
      "storage_protection",
    ]);
    expect(matrix.rows.find((r) => r.key === "ots_anchoring")!.status).toBe("NOT_CHECKED");
    expect(matrix.limitation).toBe(VERIFICATION_LIMITATION);
  });

  it("renders the bounded summary, the limitation and each row's status — never a score or verdict", () => {
    const { container, getByTestId } = render(
      <div>
        <VerificationSummaryCard matrix={matrix} decision={decision} />
        <VerificationMatrixGrid rows={matrix.rows} />
      </div>,
    );
    const text = container.textContent ?? "";
    expectNoRetiredClaims(text);
    expect(getByTestId("verify-matrix-summary").textContent).toMatch(
      /Cryptographic integrity and PROOVRA custody checks passed for the preserved bytes\./,
    );
    expect(getByTestId("verify-matrix-summary").textContent).toMatch(/NOT_CHECKED was not independently verified/);
    expect(getByTestId("verify-matrix-limitation").textContent).toBe(VERIFICATION_LIMITATION);
    // An unchecked OpenTimestamps proof reads NOT_CHECKED.
    expect(getByTestId("verify-matrix-status-ots_anchoring").textContent).toBe("NOT_CHECKED");
    expect(getByTestId("verify-matrix-row-ots_anchoring").textContent).toMatch(
      /has not checked the proof against the Bitcoin chain/,
    );
    expect(getByTestId("verify-matrix-status-file_integrity").textContent).toBe("VERIFIED");
    // The old wire summary and reviewer action never reach the page.
    expect(text).not.toContain("Rely on this record.");
    expect(text).not.toContain("All signals passed.");
  });

  it("uses the API's matrix verbatim when one is sent", () => {
    const server: VerificationMatrix = buildVerificationMatrix({
      signals: decision.signals,
      identity: null,
      acquisitionMode: null,
      packageSeal: { kind: "NONE" },
      publication: { kind: "THIS_PAGE" },
    });
    expect(resolveVerifyMatrix(server, decision)).toBe(server);
    const { getByTestId } = render(<VerificationMatrixGrid rows={server.rows} />);
    expect(getByTestId("verify-matrix-status-public_verify_publication").textContent).toBe("VERIFIED");
  });

  it("a FAILED file-integrity, signature or custody row requires integrity review", () => {
    expect(matrixRequiresIntegrityReview(matrix, decision)).toBe(false);
    const failed: VerificationMatrix = {
      ...matrix,
      rows: matrix.rows.map((r) => (r.key === "custody_chain" ? { ...r, status: "FAILED" } : r)),
    };
    expect(matrixRequiresIntegrityReview(failed, decision)).toBe(true);
    const ots: VerificationMatrix = {
      ...matrix,
      rows: matrix.rows.map((r) => (r.key === "ots_anchoring" ? { ...r, status: "FAILED" } : r)),
    };
    expect(matrixRequiresIntegrityReview(ots, decision)).toBe(false);
  });
});

function basicData(): BasicVerification {
  return {
    schema: "PROOVRA_BASIC_VERIFICATION",
    version: 1,
    checkedAtUtc: AT,
    original: {
      state: "verified",
      basis: "SIGNATURE_AND_FINGERPRINT_AND_CUSTODY_CHAIN",
      checks: { fingerprintMatchesSignedHash: true, signatureValid: true, custodyChainValid: true },
      fileSha256: "a".repeat(64),
      fingerprintHash: "b".repeat(64),
      capturedAtUtcDeclared: null,
      finalizedAtUtc: AT,
    },
    timestamp: { state: "not_issued", basis: null, tokenTimeUtc: null },
    anchoring: { state: "not_checked", basis: "PROOF_COMMITS_TO_RECORD_CHAIN_NOT_CHECKED", anchoredAtUtc: AT, bitcoinTxid: null },
    report: { issued: false, latestVersion: null, issuedAtUtc: null, digestRecorded: false },
    package: { issued: false, certifiesReportVersion: null, assembledAtUtc: null, sealed: false, latestReportLacksPackage: false },
  } as unknown as BasicVerification;
}

describe("Public Verify — BASIC tier renders the matrix", () => {
  it("states the summary, every row's status and the limitation when the API sends a matrix", () => {
    const decision = readStoredTrustDecision(oldApiTrustDecision())!;
    const matrix = buildVerificationMatrix({
      signals: decision.signals,
      identity: null,
      acquisitionMode: null,
      packageSeal: { kind: "NONE" },
      publication: { kind: "THIS_PAGE" },
    });
    const { container, getByTestId } = render(<BasicVerificationView data={basicData()} matrix={matrix} />);
    expectNoRetiredClaims(container.textContent ?? "");
    expect(getByTestId("verify-matrix-summary").textContent).toMatch(/custody checks passed/);
    expect(getByTestId("verify-matrix-limitation").textContent).toBe(VERIFICATION_LIMITATION);
    expect(getByTestId("verify-matrix-row-ots_anchoring").textContent).toMatch(/NOT_CHECKED/);
    expect(getByTestId("verify-matrix-row-ots_anchoring").textContent).not.toMatch(/VERIFIED/);
  });

  it("renders no matrix section when an older API sent none", () => {
    const { queryByTestId } = render(<BasicVerificationView data={basicData()} />);
    expect(queryByTestId("verify-matrix")).toBeNull();
  });
});

describe("Technical Appendix — TrustDecisionSummary reads any snapshot score-free", () => {
  it("renders per-signal statuses and the bounded summary from an old snapshot", () => {
    const { container } = render(<TrustDecisionSummary trust={oldApiTrustDecision()} />);
    const text = container.textContent ?? "";
    expectNoRetiredClaims(text);
    expect(text).not.toMatch(/Verdict|Score|Weighting/);
    expect(text).toContain(VERIFICATION_LIMITATION);
    const anchoring = container.querySelector('[data-trust-signal-key="bitcoin_anchoring"]') as HTMLElement;
    expect(anchoring.getAttribute("data-trust-signal-status")).toBe("NOT_CHECKED");
    expect(anchoring.textContent).toMatch(/NOT_CHECKED/);
    const core = container.querySelector('[data-trust-signal-key="core_integrity"]') as HTMLElement;
    expect(core.getAttribute("data-trust-signal-status")).toBe("VERIFIED");
  });

  it("states that no decision is available when the snapshot carries no signals", () => {
    const { container } = render(<TrustDecisionSummary trust={{ verdictLabel: "Strongly verified", score: 96 }} />);
    expect(container.querySelector("[data-trust-summary-empty]")).not.toBeNull();
    expectNoRetiredClaims(container.textContent ?? "");
  });
});
