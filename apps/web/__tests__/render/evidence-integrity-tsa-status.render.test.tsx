/**
 * AUD-14 (2026-10-20) — the owner Integrity tab states the canonical TSA proof status:
 * a provider outage is never "failed", a kept token never validated is never an
 * amber "pending", and the raw stored word ("Status: FAILED") is never printed.
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("../../lib/api", () => ({ apiFetch: vi.fn(async () => ({ evidenceId: "e", certifications: [] })) }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: vi.fn() }) }));
vi.mock("../../app/(app)/evidence/[id]/_tabs/EvidenceProvenanceChainSection", () => ({ EvidenceProvenanceChainSection: () => null }));
vi.mock("../../components/capture-location/CaptureLocationMapPanel", () => ({ default: () => null }));

import { EvidenceIntegrityTab } from "../../app/(app)/evidence/[id]/_tabs/EvidenceIntegrityTab";
import { describeOtsStatus } from "../../app/(app)/evidence/[id]/_tabs/_lib";


function ctx(storedBytes: unknown, ots: unknown = { state: "PENDING" }, tsa: unknown = { timestampAvailable: false, status: null }): never {
  return {
    evidenceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    otsStatusPresentation: describeOtsStatus({ preservationMatrix: { ots } } as never),
    showManualLatestStatusCheck: false,
    loadWorkspace: () => {},
    workspaceCaps: { verificationPackageIncluded: false },
    preservation: {
      verificationStatus: "RECORDED_INTEGRITY_VERIFIED", verificationStatusLabel: "Recorded integrity state verified",
      sha256Recorded: true, fingerprintHashRecorded: true, fingerprintCanonicalHashMatches: true,
      signature: { recorded: true, valid: true }, tsa,
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

function tsaRow(): HTMLElement {
  return document.querySelector('[data-evidence-matrix-row="Timestamp proof (TSA)"]') as HTMLElement;
}
const cell = () => tsaRow().querySelector(".evidence-detail-matrix-cell__state");

describe("Integrity tab — Timestamp proof (TSA), one presenter (AUD-14)", () => {
  it("a provider outage reads Not obtained — not failed, not the raw word", () => {
    render(<EvidenceIntegrityTab ctx={ctx(undefined, undefined, { timestampAvailable: false, status: "FAILED", proofStatus: "NOT_OBTAINED" })} />);
    expect(tsaRow().textContent).toContain("Not obtained");
    expect(tsaRow().textContent).not.toMatch(/Status: FAILED|Timestamp failed/);
    expect(cell()?.getAttribute("data-tone")).not.toBe("red");
  });

  it("a kept token never validated reads Recorded, not validated — never amber pending", () => {
    render(<EvidenceIntegrityTab ctx={ctx(undefined, undefined, { timestampAvailable: false, status: "RECORDED_NOT_VALIDATED", proofStatus: "RECORDED_NOT_VALIDATED" })} />);
    expect(tsaRow().textContent).toContain("Recorded, not validated");
    expect(tsaRow().textContent).not.toMatch(/Status: /);
    expect(cell()?.textContent).not.toMatch(/Pending/i);
  });

  it("only a refused token is failed; a validated one says so", () => {
    render(<EvidenceIntegrityTab ctx={ctx(undefined, undefined, { timestampAvailable: false, status: "FAILED", proofStatus: "FAILED" })} />);
    expect(tsaRow().textContent).toContain("Validation failed");
    cleanup();
    render(<EvidenceIntegrityTab ctx={ctx(undefined, undefined, { timestampAvailable: true, status: "STAMPED", proofStatus: "VALIDATED" })} />);
    expect(tsaRow().textContent).toContain("RFC 3161 timestamp validated");
  });
});
