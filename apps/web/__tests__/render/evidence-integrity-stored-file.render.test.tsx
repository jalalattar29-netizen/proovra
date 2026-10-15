/**
 * UC-TRUST-008 — the owner's Integrity tab states the CURRENT stored file exactly as
 * Public Verify does: one resolver, one wording. A past match is never shown as a
 * plain green "Verified" once it is not current (unpinned object, outside the
 * window); a mismatch is red; an API that sends no state shows no row.
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { resolveStoredBytesIntegrity } from "@proovra/shared";

vi.mock("../../lib/api", () => ({ apiFetch: vi.fn(async () => ({ evidenceId: "e", certifications: [] })) }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: vi.fn() }) }));
vi.mock("../../app/(app)/evidence/[id]/_tabs/EvidenceProvenanceChainSection", () => ({ EvidenceProvenanceChainSection: () => null }));
vi.mock("../../components/capture-location/CaptureLocationMapPanel", () => ({ default: () => null }));

import { EvidenceIntegrityTab } from "../../app/(app)/evidence/[id]/_tabs/EvidenceIntegrityTab";
import { describeOtsStatus } from "../../app/(app)/evidence/[id]/_tabs/_lib";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const HOUR = 3600_000;
const base = { rejected: false, lastFailureCode: null, recheckRequestedAtUtc: null, recordedDigest: "a".repeat(64) };
function stored(facts: Record<string, unknown>, versionPinned: boolean) {
  return { ...resolveStoredBytesIntegrity({ ...base, ...facts } as never, NOW), versionPinned };
}

function ctx(storedBytes: unknown, ots: unknown = { state: "PENDING" }): never {
  return {
    evidenceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    otsStatusPresentation: describeOtsStatus({ preservationMatrix: { ots } } as never),
    showManualLatestStatusCheck: false,
    loadWorkspace: () => {},
    workspaceCaps: { verificationPackageIncluded: false },
    preservation: {
      verificationStatus: "RECORDED_INTEGRITY_VERIFIED", verificationStatusLabel: "Recorded integrity state verified",
      sha256Recorded: true, fingerprintHashRecorded: true, fingerprintCanonicalHashMatches: true,
      signature: { recorded: true, valid: true }, tsa: { timestampAvailable: false, status: null },
      ots: { state: "PENDING", lastUpdatedAtUtc: null }, storage: null,
      report: { available: false, version: null }, verificationPackage: { available: false, version: null },
      custodyChain: { valid: true, mode: "full", reason: null },
      ...(storedBytes === undefined ? {} : { storedBytes }),
    },
    workspace: {
      sourceContext: {
        sourceType: null, captureMethod: null, capturedAtUtc: null, uploadedAtUtc: null, deviceTimeIso: null,
        locationIncluded: false, clientSignalsSummary: { screenshotLikeStatus: "NOT_COLLECTED", folderPathStatus: "NOT_COLLECTED" },
        limitations: ["Boundary text."],
      },
      sourceCaptureLocation: null,
      artifactStatus: {
        report: { available: false, pending: false, pdfSignature: null },
        verificationPackage: { available: false, pending: false, blocked: false, manifestSignature: null },
        outputs: { report: { state: "NOT_REQUESTED" }, verificationPackage: { state: "NOT_REQUESTED" } },
      },
      evidence: {},
      snapshot: { reportGeneratedAtUtc: null, verificationPackageGeneratedAtUtc: null, currentStatus: "READY", fixedArtifactNote: "Note." },
      artifactVersions: { trustDecisionConsistency: null },
    },
  } as never;
}

function storedFileRow(): HTMLElement {
  return document.querySelector('[data-evidence-matrix-row="Stored file (current)"]') as HTMLElement;
}
const stateWord = () => storedFileRow().querySelector(".evidence-detail-matrix-cell__state")?.textContent;
const tone = () => storedFileRow().querySelector(".evidence-detail-matrix-cell__state")?.getAttribute("data-tone");

describe("Integrity tab — Stored file (current)", () => {
  it("an UNPINNED object checked a minute ago is Stale with its last-verified time, never Verified", () => {
    const at = new Date(NOW.getTime() - 60_000);
    render(<EvidenceIntegrityTab ctx={ctx(stored({ lastVerifiedAtUtc: at, lastCheckedAtUtc: at, lastOutcome: "VERIFIED", pinnedVersionId: null }, false))} />);
    expect(stateWord()).toBe("Stale");
    expect(tone()).not.toBe("green");
    expect(storedFileRow().textContent).toMatch(/last verified 2026-10-01 11:59 UTC/i);
  });

  it("a pinned pass older than the window is Stale, not Verified", () => {
    const at = new Date(NOW.getTime() - 30 * HOUR);
    render(<EvidenceIntegrityTab ctx={ctx(stored({ lastVerifiedAtUtc: at, lastCheckedAtUtc: at, lastOutcome: "VERIFIED", pinnedVersionId: "v1" }, true))} />);
    expect(stateWord()).toBe("Stale");
    expect(tone()).not.toBe("green");
  });

  it("a fresh pass over a pinned version is the only Verified", () => {
    const at = new Date(NOW.getTime() - 60_000);
    render(<EvidenceIntegrityTab ctx={ctx(stored({ lastVerifiedAtUtc: at, lastCheckedAtUtc: at, lastOutcome: "VERIFIED", pinnedVersionId: "v1" }, true))} />);
    expect(stateWord()).toBe("Verified");
    expect(storedFileRow().textContent).toMatch(/Stored file rechecked/);
  });

  it("substituted bytes after the authoritative re-read are a Mismatch", () => {
    const at = new Date(NOW.getTime() - 60_000);
    render(<EvidenceIntegrityTab ctx={ctx(stored({ lastVerifiedAtUtc: at, lastCheckedAtUtc: at, lastOutcome: "FAILED", lastFailureCode: "DIGEST_MISMATCH", pinnedVersionId: "v1" }, true))} />);
    expect(stateWord()).toBe("Mismatch");
    expect(storedFileRow().textContent).toMatch(/Stored file does not match/);
  });

  it("an API that sends no stored-file state shows no row (no invented claim)", () => {
    render(<EvidenceIntegrityTab ctx={ctx(undefined)} />);
    expect(screen.queryByText("Stored file (current)")).toBeNull();
  });
});

describe("Integrity tab — Bitcoin anchoring is the server's verification (2026-10-15)", () => {
  const otsRow = () => document.querySelector('[data-evidence-matrix-row="Bitcoin anchoring"]') as HTMLElement;
  const otsWord = () => otsRow().querySelector(".evidence-detail-matrix-cell__state");
  const detail = () => (document.querySelector('[data-evidence-matrix-row="Bitcoin anchoring detail"]') as HTMLElement).textContent ?? "";
  const chain = (over: Record<string, unknown>) => ({
    status: "VERIFIED",
    failureCode: null,
    blockHeight: 812345,
    blockHash: "0".repeat(8) + "f".repeat(56),
    blockTimeUtc: "2026-09-01T00:00:00Z",
    confirmations: 12,
    minConfirmations: 6,
    checkedAtUtc: "2026-09-02T10:00:00Z",
    verifiedAtUtc: "2026-09-02T10:00:00Z",
    verifier: "bitcoin-core",
    ...over,
  });

  it("ANCHORED without a chain check is 'Bitcoin attestation recorded', not independently checked, neutral — never Verified", () => {
    render(<EvidenceIntegrityTab ctx={ctx(undefined, { state: "ANCHORED", bitcoinBlockHeight: 812345 })} />);
    expect(otsWord()?.textContent).toBe("Attestation recorded");
    expect(otsWord()?.getAttribute("data-tone")).toBe("slate");
    expect(otsRow().getAttribute("data-evidence-matrix-state")).toBe("recorded");
    expect(otsRow().textContent).toContain("Bitcoin attestation recorded");
    expect(otsRow().textContent).toContain("Not independently checked against Bitcoin");
    expect(detail()).toContain("The proof names Bitcoin block 812345; PROOVRA has not checked it against the Bitcoin main chain.");
    expect(otsRow().textContent).not.toMatch(/✓|Verified/);
  });

  it("an ANCHORED payload that CLAIMS CHAIN_VERIFIED without a chain fact is still only an attestation recorded", () => {
    render(<EvidenceIntegrityTab ctx={ctx(undefined, { state: "ANCHORED", verification: "CHAIN_VERIFIED", bitcoinBlockHeight: 812345 })} />);
    expect(otsWord()?.textContent).toBe("Attestation recorded");
    expect(otsWord()?.getAttribute("data-tone")).toBe("slate");
  });

  it("CHAIN_VERIFIED is the only green ✓: independently verified with height, confirmations and check time", () => {
    render(
      <EvidenceIntegrityTab
        ctx={ctx(undefined, { state: "ANCHORED", verification: "CHAIN_VERIFIED", bitcoinBlockHeight: 812345, chain: chain({}) })}
      />,
    );
    expect(otsWord()?.textContent).toBe("✓ Independently verified");
    expect(otsWord()?.getAttribute("data-tone")).toBe("green");
    expect(otsRow().getAttribute("data-evidence-matrix-state")).toBe("verified");
    expect(otsRow().textContent).toContain("Independently verified against the Bitcoin main chain");
    expect(otsRow().textContent).not.toContain("Not independently checked");
    expect(detail()).toMatch(/Merkle root matches Bitcoin block 812345; 12 confirmations at 2026-09-02/);
  });

  it("insufficient confirmations is a neutral 'Bitcoin verification pending' with m of n", () => {
    render(
      <EvidenceIntegrityTab
        ctx={ctx(undefined, {
          state: "ANCHORED",
          verification: "CHAIN_CONFIRMATIONS_PENDING",
          bitcoinBlockHeight: 812345,
          chain: chain({ status: "INSUFFICIENT_CONFIRMATIONS", confirmations: 2, verifiedAtUtc: null }),
        })}
      />,
    );
    expect(otsWord()?.getAttribute("data-tone")).toBe("slate");
    expect(otsRow().textContent).toContain("Bitcoin verification pending");
    expect(detail()).toContain("The proof matches Bitcoin block 812345; 2 of 6 confirmations recorded.");
  });

  it("CHAIN_FAILED is danger: 'Bitcoin verification failed'", () => {
    render(
      <EvidenceIntegrityTab
        ctx={ctx(undefined, {
          state: "ANCHORED",
          verification: "CHAIN_FAILED",
          bitcoinBlockHeight: 812345,
          chain: chain({ status: "FAILED", failureCode: "ROOT_MISMATCH", verifiedAtUtc: null }),
        })}
      />,
    );
    expect(otsWord()?.getAttribute("data-tone")).toBe("red");
    expect(otsRow().getAttribute("data-evidence-matrix-state")).toBe("failed");
    expect(otsRow().textContent).toContain("Bitcoin verification failed");
    expect(detail()).toContain("The OpenTimestamps proof does not match the referenced block in the active Bitcoin main chain.");
  });

  it("CHAIN_UNAVAILABLE is neutral: the attestation remains recorded", () => {
    render(
      <EvidenceIntegrityTab
        ctx={ctx(undefined, {
          state: "ANCHORED",
          verification: "CHAIN_UNAVAILABLE",
          chain: chain({ status: "UNAVAILABLE", failureCode: "BTC_RPC_TIMEOUT", verifiedAtUtc: null }),
        })}
      />,
    );
    expect(otsWord()?.getAttribute("data-tone")).toBe("slate");
    expect(otsRow().textContent).toContain("Bitcoin verification temporarily unavailable");
    expect(detail()).toContain("The Bitcoin attestation remains recorded but could not be independently checked.");
  });

  it("FAILED is danger", () => {
    render(<EvidenceIntegrityTab ctx={ctx(undefined, { state: "FAILED", failureCode: "PROOF_HASH_MISMATCH" })} />);
    expect(otsWord()?.getAttribute("data-tone")).toBe("red");
    expect(otsRow().getAttribute("data-evidence-matrix-state")).toBe("failed");
  });

  it("PENDING is a neutral 'Pending' — never danger", () => {
    render(<EvidenceIntegrityTab ctx={ctx(undefined, { state: "PENDING" })} />);
    expect(otsWord()?.textContent).toBe("Pending");
    expect(otsWord()?.getAttribute("data-tone")).toBe("slate");
    expect(otsRow().textContent).toContain("OpenTimestamps proof pending");
    expect(detail()).toContain("Submitted to OpenTimestamps calendars; no Bitcoin attestation yet.");
  });

  it("an unknown state from the server renders 'Unavailable' — never anchored", () => {
    render(<EvidenceIntegrityTab ctx={ctx(undefined, { state: "CHAIN_VERIFIED", effectiveStatus: "ANCHORED", bitcoinTxid: "c".repeat(64) })} />);
    expect(otsWord()?.textContent).toBe("Unavailable");
    expect(otsWord()?.getAttribute("data-tone")).toBe("slate");
    expect(otsRow().textContent).toContain("Bitcoin anchoring unavailable");
  });
});
