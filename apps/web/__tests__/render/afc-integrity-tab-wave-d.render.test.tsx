/**
 * Independent forward audit closure — Wave D on the owner Integrity tab.
 *
 * F-12: the Signature row is THE presentation of the record's validity state.
 *       A revoked, mismatched or invalid signature read "Recorded" (neutral).
 * F-13: "Current status" is the record-status label, never the raw enum.
 * F-28: the custody chain verdict is stated in words, never the verifier's
 *       codes ("Review required (prev_hash_mismatch)").
 * F-32: a package whose manifest signature was never inspected is not
 *       "Signed manifest present".
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("../../lib/api", () => ({ apiFetch: vi.fn(async () => ({ evidenceId: "e", certifications: [] })) }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: vi.fn() }) }));
vi.mock("../../app/(app)/evidence/[id]/_tabs/EvidenceProvenanceChainSection", () => ({ EvidenceProvenanceChainSection: () => null }));
vi.mock("../../components/capture-location/CaptureLocationMapPanel", () => ({ default: () => null }));

import { EvidenceIntegrityTab } from "../../app/(app)/evidence/[id]/_tabs/EvidenceIntegrityTab";
import { describeOtsStatus, describePackageManifestStatus } from "../../app/(app)/evidence/[id]/_tabs/_lib";

afterEach(() => cleanup());

function ctx(over: { signature?: unknown; currentStatus?: string; custodyChain?: unknown } = {}): never {
  return {
    evidenceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    otsStatusPresentation: describeOtsStatus({ preservationMatrix: { ots: { state: "PENDING" } } } as never),
    showManualLatestStatusCheck: false,
    loadWorkspace: () => {},
    workspaceCaps: { verificationPackageIncluded: false },
    preservation: {
      verificationStatus: "RECORDED_INTEGRITY_VERIFIED", verificationStatusLabel: "Recorded integrity state verified",
      sha256Recorded: true, fingerprintHashRecorded: true, fingerprintCanonicalHashMatches: true,
      signature: over.signature ?? { recorded: true, valid: true, validityState: "VALID" },
      tsa: { timestampAvailable: false, status: null },
      ots: { state: "PENDING", lastUpdatedAtUtc: null }, storage: null,
      report: { available: false, version: null }, verificationPackage: { available: false, version: null },
      custodyChain: over.custodyChain ?? { valid: true, mode: "full", reason: null },
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
      snapshot: { reportGeneratedAtUtc: null, verificationPackageGeneratedAtUtc: null, currentStatus: over.currentStatus ?? "SIGNED", fixedArtifactNote: "Note." },
      artifactVersions: { trustDecisionConsistency: null },
    },
  } as never;
}

const matrixRow = (label: string) => document.querySelector(`[data-evidence-matrix-row="${label}"]`) as HTMLElement;
const stateCell = (label: string) => matrixRow(label).querySelector(".evidence-detail-matrix-cell__state");

describe("Integrity tab — Wave D presentation authorities", () => {
  it("F-12: a revoked signing key is a failed signature, never a neutral 'Recorded'", () => {
    render(
      <EvidenceIntegrityTab
        ctx={ctx({ signature: { recorded: true, valid: true, validityState: "REVOKED_KEY", signingKeyRevokedAtUtc: "2026-10-01T00:00:00.000Z" } })}
      />,
    );
    expect(matrixRow("Signature").textContent).toMatch(/Signing key revoked at /);
    expect(matrixRow("Signature").textContent).not.toMatch(/^Signature\s*Recorded/);
    expect(stateCell("Signature")?.getAttribute("data-tone")).toBe("red");
  });

  it("F-12: a mismatched key and an invalid signature are failures too", () => {
    for (const validityState of ["KEY_MISMATCH", "INVALID"]) {
      render(<EvidenceIntegrityTab ctx={ctx({ signature: { recorded: true, valid: false, validityState } })} />);
      expect(stateCell("Signature")?.getAttribute("data-tone"), validityState).toBe("red");
      cleanup();
    }
  });

  it("F-12: a valid signature is verified; one with no stated validity is not", () => {
    render(<EvidenceIntegrityTab ctx={ctx()} />);
    expect(matrixRow("Signature").textContent).toContain("Signature verified");
    cleanup();
    render(<EvidenceIntegrityTab ctx={ctx({ signature: { recorded: true, valid: true } })} />);
    expect(matrixRow("Signature").textContent).toContain("Signature validity not stated");
    expect(stateCell("Signature")?.getAttribute("data-tone")).not.toBe("green");
  });

  it("F-13: Current status is the record-status label, never the raw enum", () => {
    render(<EvidenceIntegrityTab ctx={ctx({ currentStatus: "FAILED_HASH_MISMATCH" })} />);
    expect(document.body.textContent).toContain("Integrity check failed");
    expect(document.body.textContent).not.toContain("FAILED HASH MISMATCH");
  });

  it("F-28: a broken custody chain is stated in words, never the verifier's code", () => {
    render(<EvidenceIntegrityTab ctx={ctx({ custodyChain: { valid: false, mode: "full", reason: "prev_hash_mismatch" } })} />);
    expect(document.body.textContent).toContain("Review required — an event does not link to the one before it");
    expect(document.body.textContent).not.toContain("prev_hash_mismatch");
  });

  it("F-32: a package whose manifest signature was never inspected is not 'Signed manifest present'", () => {
    const status = (manifestSignature: unknown) =>
      describePackageManifestStatus({ verificationPackage: { available: true, manifestSignature } } as never, true);
    expect(status({ status: "SIGNED", signerKeyId: null })).toBe("Signed manifest present");
    expect(status({ status: "NOT_INSPECTED", signerKeyId: null })).toBe("Unknown");
    expect(status({ status: "UNSIGNED", signerKeyId: null })).toBe("Unknown");
  });
});
