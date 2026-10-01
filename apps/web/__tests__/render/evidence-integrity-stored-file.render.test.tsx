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

const NOW = new Date("2026-10-01T12:00:00.000Z");
const HOUR = 3600_000;
const base = { rejected: false, lastFailureCode: null, recheckRequestedAtUtc: null, recordedDigest: "a".repeat(64) };
function stored(facts: Record<string, unknown>, versionPinned: boolean) {
  return { ...resolveStoredBytesIntegrity({ ...base, ...facts } as never, NOW), versionPinned };
}

function ctx(storedBytes: unknown): never {
  return {
    evidenceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    otsStatusPresentation: null,
    showManualLatestStatusCheck: false,
    loadWorkspace: () => {},
    workspaceCaps: { verificationPackageIncluded: false },
    preservation: {
      verificationStatus: "RECORDED_INTEGRITY_VERIFIED", verificationStatusLabel: "Recorded integrity state verified",
      sha256Recorded: true, fingerprintHashRecorded: true, fingerprintCanonicalHashMatches: true,
      signature: { recorded: true, valid: true }, tsa: { timestampAvailable: false, status: null },
      ots: { effectiveStatus: null, lastUpdatedAtUtc: null }, storage: null,
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
