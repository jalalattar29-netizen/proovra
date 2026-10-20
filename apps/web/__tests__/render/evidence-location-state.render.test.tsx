/**
 * THE CANONICAL LOCATION STATE (2026-10-16) on the owner web and Public Verify.
 *
 * One label and tone per state from resolveEvidenceLocation (packages/shared):
 * "Location recorded" draws the map; "Location not recorded" is neutral with
 * no detail, no warning tone and no map; a declined / unavailable request and
 * invalid stored coordinates say so without a map; a plan's requirement is a
 * separate line. Nothing reads "Blocked".
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { EVIDENCE_LOCATION_STATE_PRESENTATION, resolveEvidenceLocation } from "@proovra/shared";

vi.mock("../../lib/api", () => ({ apiFetch: vi.fn(async () => ({ evidenceId: "e", certifications: [] })) }));
vi.mock("../../components/ui/ConfirmActionModal", () => ({ useConfirmAction: () => ({ confirm: vi.fn() }) }));
vi.mock("../../app/(app)/evidence/[id]/_tabs/EvidenceProvenanceChainSection", () => ({ EvidenceProvenanceChainSection: () => null }));
vi.mock("../../components/capture-location/CaptureLocationMapPanel", () => ({
  default: (p: { lat: number; lng: number }) => <div data-testid="map" data-lat={p.lat} />,
}));

import { EvidenceIntegrityTab } from "../../app/(app)/evidence/[id]/_tabs/EvidenceIntegrityTab";
import { describeOtsStatus } from "../../app/(app)/evidence/[id]/_tabs/_lib";
import { LocationContextCard } from "../../app/(app)/evidence/[id]/_tabs/technical-appendix/LocationContextCard";
import { VerifyLocationStateSection, readVerifyLocationState } from "../../app/verify/[token]/VerifyLocationStateSection";

const RECORDED_BLOCK = {
  statusLabel: "Location recorded",
  description: "d",
  lat: 52.52,
  lng: 13.405,
  accuracyMeters: 9,
  capturedAtUtc: "2026-10-16T10:00:00.000Z",
  deviceTimeIso: null,
  source: "Reported by the submitting app from its device",
  externalMapUrl: null,
  legalBoundary: "Boundary.",
};

function served(facts: Parameters<typeof resolveEvidenceLocation>[0]) {
  const r = resolveEvidenceLocation(facts);
  return { state: r.state, label: r.label, tone: r.tone, detail: r.detail, requirement: r.requirement };
}

function ctx(locationState: unknown, sourceCaptureLocation: unknown): never {
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
      locationState,
      sourceCaptureLocation,
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

const CASES = [
  { name: "valid recorded coordinates (mobile capture)", state: served({ lat: 52.52, lng: 13.405, locationSource: "CLIENT_APP_DEVICE_LOCATION" }), block: RECORDED_BLOCK, map: true, tone: "blue" },
  { name: "legacy record with no location facts", state: served({}), block: null, map: false, tone: "slate" },
  { name: "uploaded evidence / not requested", state: served({ requestOutcome: "NOT_REQUESTED" }), block: null, map: false, tone: "slate" },
  { name: "intake / web capture declined", state: served({ requestOutcome: "DENIED" }), block: null, map: false, tone: "slate" },
  { name: "technical unavailability", state: served({ requestOutcome: "UNAVAILABLE" }), block: null, map: false, tone: "slate" },
  { name: "invalid stored coordinates", state: served({ lat: 123, lng: 1 }), block: null, map: false, tone: "amber" },
  { name: "required plan, nothing recorded", state: served({ requirement: "required" }), block: null, map: false, tone: "slate" },
];

describe("owner web Integrity tab — the canonical location state", () => {
  for (const c of CASES) {
    it(`${c.name} → ${c.state.label}`, () => {
      const { container } = render(<EvidenceIntegrityTab ctx={ctx(c.state, c.block)} />);
      const text = container.textContent ?? "";
      expect(text).toContain(c.state.label);
      expect(text).not.toMatch(/Blocked/);
      expect(container.querySelectorAll('[data-testid="map"]').length).toBe(c.map ? 1 : 0);
      if (c.state.state === "NOT_RECORDED" && !c.state.requirement?.unmet) {
        // Plain absence: the facts row only — no section, no detail, no badge tone beyond neutral.
        expect(container.querySelector('[data-evidence-section="capture-location"]')).toBeNull();
      } else {
        const badge = container.querySelector("[data-location-state-label]");
        expect(badge?.textContent).toBe(c.state.label);
        expect(badge?.getAttribute("data-tone")).toBe(c.tone);
      }
      if (c.state.detail) expect(text).toContain(c.state.detail);
      if (c.state.requirement?.unmet) {
        expect(container.querySelector('[data-location-requirement="unmet"]')?.textContent).toBe("Required by the collection plan");
      }
    });
  }

  it("an older response without locationState is read from the coordinates alone", () => {
    const { container } = render(<EvidenceIntegrityTab ctx={ctx(undefined, null)} />);
    expect(container.textContent).toContain("Location not recorded");
  });
});

describe("technical appendix Location card", () => {
  it("states the canonical label and shows coordinates only when recorded", () => {
    const a = render(<LocationContextCard location={RECORDED_BLOCK as never} locationState={served({ lat: 52.52, lng: 13.405 })} />);
    expect(a.container.textContent).toContain("Location recorded");
    // AUD-47 (2026-10-20) — THE shared coordinate format (six places, trailing zeros trimmed).
    expect(a.container.textContent).toContain("52.52");
    expect(a.container.textContent).not.toContain("52.520000");
    a.unmount();
    const b = render(<LocationContextCard location={null} locationState={served({ requestOutcome: "DENIED" })} />);
    expect(b.container.textContent).toContain("Location not shared");
    expect(b.container.textContent).not.toMatch(/Latitude|Blocked|not provided/);
  });
});

describe("Public Verify — no-coordinates location section", () => {
  it("states every non-recorded state in the canonical label; recorded and absent responses render nothing here", () => {
    for (const state of ["NOT_RECORDED", "NOT_SHARED", "UNAVAILABLE", "INVALID"] as const) {
      const p = EVIDENCE_LOCATION_STATE_PRESENTATION[state];
      const loc = readVerifyLocationState({ locationState: { state, label: p.label, tone: p.tone, detail: p.detail } });
      const { container, unmount } = render(<VerifyLocationStateSection location={loc} />);
      expect(container.querySelector(`[data-verify-location-state="${state}"]`)).not.toBeNull();
      expect(container.querySelector("[data-verify-location-label]")?.textContent).toBe(p.label);
      expect(container.textContent).not.toMatch(/Blocked/);
      expect(container.querySelector("img")).toBeNull();
      unmount();
    }
    const rec = render(<VerifyLocationStateSection location={readVerifyLocationState({ locationState: { state: "RECORDED", label: "Location recorded", tone: "info", detail: null } })} />);
    expect(rec.container.innerHTML).toBe("");
    rec.unmount();
    expect(readVerifyLocationState({})).toBeNull();
  });
});
