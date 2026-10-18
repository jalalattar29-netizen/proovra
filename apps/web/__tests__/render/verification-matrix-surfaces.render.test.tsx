/**
 * EVIDENCE-CLAIMS CORRECTION (2026-10-08) — every web surface states a record
 * signal by signal through the verification matrix: no numeric trust score,
 * no weighted points, no overall verdict ("strongly verified"), no reliance or
 * confidence level. Bitcoin anchoring is the canonical OTS state (2026-10-13):
 * a legacy "passed" anchoring signal cannot be re-validated from a snapshot
 * and reads as Unavailable — never anchored — and the bounded summary and the
 * fixed limitation are always stated.
 *
 * The old response shape (score, verdict, relianceLevel, points …) is fed
 * through each surface here: none of it may reach the page. Public Verify
 * (2026-10-18) states the API's matrix only — a response without one says
 * "Verification matrix unavailable"; the client never rebuilds rows.
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  VERIFICATION_LIMITATION,
  buildVerificationMatrix,
  findForbiddenCustomerClaims,
  parseVerificationMatrix,
  readStoredTrustDecision,
  type BasicVerification,
} from "@proovra/shared";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  VerificationMatrixGrid,
  VerificationSummaryCard,
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
      // never read as anchored.
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

describe("Public Verify — matrix panels (the API's matrix is the only source)", () => {
  const fixture = JSON.parse(
    readFileSync(join(__dirname, "fixtures", "public-verify-verification-only.json"), "utf8"),
  ) as { verificationMatrix: unknown; trustDecision: unknown };
  const matrix = parseVerificationMatrix(fixture.verificationMatrix)!;
  const decision = readStoredTrustDecision(fixture.trustDecision)!;

  it("renders the bounded summary, the limitation and each row's status (icon + word) — never a score or verdict", () => {
    const { container, getByTestId } = render(
      <div>
        <VerificationSummaryCard matrix={matrix} decision={decision} />
        <VerificationMatrixGrid rows={matrix.rows} />
      </div>,
    );
    const text = container.textContent ?? "";
    expectNoRetiredClaims(text);
    expect(getByTestId("verify-matrix-summary").textContent).toMatch(/“Not checked” was not independently verified/);
    expect(getByTestId("verify-matrix-limitation").textContent).toBe(matrix.limitation);
    // The summary sentence never repeats the limitation: one legal boundary.
    expect(text.match(/does not by itself establish authorship/g)).toHaveLength(1);
    // The server's statusLabel, with its icon.
    expect(getByTestId("verify-matrix-status-ots_anchoring").textContent).toBe("✓Independently verified");
    expect(getByTestId("verify-matrix-status-file_integrity").textContent).toBe("○Not checked");
    expect(getByTestId("verify-matrix-status-file_integrity").getAttribute("data-status")).toBe("NOT_CHECKED");
    expect(getByTestId("verify-matrix-status-record_signature").textContent).toBe("✓Verified");
  });

  it("states every row verbatim, with its qualifiers", () => {
    const rows = matrix.rows.map((r) =>
      r.key === "package_signature" ? { ...r, status: "NOT_CHECKED" as const, qualifiers: ["LEGACY_SEAL" as const] } : r,
    );
    const { getByTestId } = render(<VerificationMatrixGrid rows={rows} />);
    for (const row of matrix.rows) {
      expect(getByTestId(`verify-matrix-row-${row.key}`).textContent).toContain(row.statement);
    }
    expect(getByTestId("verify-matrix-row-package_signature").textContent).toContain("Legacy seal");
  });

  it("without the API's matrix the summary says so — no client rebuild", () => {
    const { getByTestId, queryByTestId } = render(<VerificationSummaryCard matrix={null} decision={decision} />);
    expect(getByTestId("verify-matrix-unavailable").textContent).toBe("Verification matrix unavailable");
    expect(queryByTestId("verify-matrix-summary")).toBeNull();
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
    anchoring: { state: "pending", otsState: "PENDING", anchoredAtUtc: null, bitcoinTxid: null },
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
      publication: { kind: "CANONICAL", disclosure: "VERIFICATION_ONLY" },
    });
    const { container, getByTestId } = render(<BasicVerificationView data={basicData()} matrix={matrix} />);
    expectNoRetiredClaims(container.textContent ?? "");
    expect(getByTestId("verify-matrix-summary").textContent).toMatch(/custody checks passed/);
    expect(getByTestId("verify-matrix-limitation").textContent).toBe(VERIFICATION_LIMITATION);
    // The anchoring row is stated as the shared matrix built it — a legacy
    // anchoring "passed" is never "Verified" / "Independently verified".
    const ots = matrix.rows.find((r) => r.key === "ots_anchoring")!;
    expect(ots.status).not.toBe("VERIFIED");
    expect(getByTestId("verify-matrix-row-ots_anchoring").textContent).toContain(ots.statement);
    expect(getByTestId("verify-matrix-row-ots_anchoring").textContent).not.toMatch(/Independently verified/);
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
    expect(anchoring.getAttribute("data-trust-signal-status")).toBe("UNAVAILABLE");
    // The machine status stays in the data attribute; the reader sees words.
    expect(anchoring.textContent).toMatch(/Unavailable/);
    expect(anchoring.textContent).not.toMatch(/UNAVAILABLE|Not checked|Attestation recorded/);
    const core = container.querySelector('[data-trust-signal-key="core_integrity"]') as HTMLElement;
    expect(core.getAttribute("data-trust-signal-status")).toBe("VERIFIED");
  });

  it("states that no decision is available when the snapshot carries no signals", () => {
    const { container } = render(<TrustDecisionSummary trust={{ verdictLabel: "Strongly verified", score: 96 }} />);
    expect(container.querySelector("[data-trust-summary-empty]")).not.toBeNull();
    expectNoRetiredClaims(container.textContent ?? "");
  });
});
