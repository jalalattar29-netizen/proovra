/**
 * AUD-26 (2026-10-20) — the owner Integrity tab says which verdict it shows:
 * as issued with report vN at its time (Public Verify states the record now),
 * or the current state. Before, the page stated the issue-time verdict with no
 * boundary while Public Verify stated the live one.
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("../../lib/api", () => ({ apiFetch: vi.fn(async () => ({ evidenceId: "e", certifications: [] })) }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: vi.fn() }) }));
vi.mock("../../app/(app)/evidence/[id]/_tabs/EvidenceProvenanceChainSection", () => ({ EvidenceProvenanceChainSection: () => null }));
vi.mock("../../components/capture-location/CaptureLocationMapPanel", () => ({ default: () => null }));

import { EvidenceIntegrityTab } from "../../app/(app)/evidence/[id]/_tabs/EvidenceIntegrityTab";
import { describeOtsStatus } from "../../app/(app)/evidence/[id]/_tabs/_lib";

function ctx(consistency: unknown): never {
  return {
    evidenceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    otsStatusPresentation: describeOtsStatus({ preservationMatrix: { ots: { state: "PENDING" } } } as never),
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
      artifactVersions: { trustDecisionConsistency: consistency },
    },
  } as never;
}

const basisLine = () => document.querySelector("[data-evidence-verdict-basis]");

describe("Integrity tab — which verdict the page shows (AUD-26)", () => {
  it("as issued: names the report version and time, and points to Public Verify for now", () => {
    render(
      <EvidenceIntegrityTab
        ctx={ctx({
          source: "REPORT_SNAPSHOT",
          consistentWithSnapshot: true,
          basis: { kind: "AS_ISSUED", artifact: "REPORT", version: 2, issuedAtUtc: "2026-10-01T09:30:00.000Z" },
        })}
      />,
    );
    expect(basisLine()?.getAttribute("data-evidence-verdict-basis")).toBe("AS_ISSUED");
    expect(basisLine()?.textContent).toBe(
      "The verification statuses on this page are as issued with report v2 on 2026-10-01 09:30 UTC. Public Verify states the record as it is now.",
    );
  });

  it("live: says it is the current state", () => {
    render(<EvidenceIntegrityTab ctx={ctx({ source: "LIVE_SHARED_FALLBACK", consistentWithSnapshot: null, basis: { kind: "LIVE" } })} />);
    expect(basisLine()?.textContent).toBe("The verification statuses on this page are the record's current state.");
  });
});
