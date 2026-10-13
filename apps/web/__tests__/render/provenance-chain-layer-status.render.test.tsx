/**
 * UC-TRUST-002 — the web provenance section states the canonical proof
 * status: Bitcoin anchoring is the server's OtsState (a PENDING proof is
 * never "Anchored", an unknown state is "Unavailable"), a legacy token never
 * validated is never "Applied".
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/api", () => ({ apiFetch: async () => ({}) }));

import {
  otsLayerText,
  rfc3161LayerText,
} from "../../app/(app)/evidence/[id]/_tabs/EvidenceProvenanceChainSection";

const fmt = (iso: string) => iso;
function chain(time: Record<string, unknown>) {
  return { time } as never;
}

describe("provenance time layers (UC-TRUST-002)", () => {
  it("a pending OTS proof is 'Pending', never anchored", () => {
    const text = otsLayerText(chain({ rfc3161: {}, ots: { applied: false, status: "PENDING", anchorTxId: null } }), fmt);
    expect(text).toBe("Pending");
    expect(text).not.toMatch(/Anchored/);
  });

  it("ANCHORED reads ✓ Anchored with the proof's block height and PROOVRA's recording time", () => {
    const text = otsLayerText(
      chain({
        rfc3161: {},
        ots: { applied: true, status: "ANCHORED", statusLabel: "Anchored", bitcoinBlockHeight: 812345, appliedAtUtc: "2026-09-01T00:00:00Z" },
      }),
      fmt,
    );
    expect(text).toBe("✓ Anchored · block 812345 · recorded by PROOVRA 2026-09-01T00:00:00Z");
  });

  it("the removed vocabulary and unknown states read as Unavailable; not requested / failed say so", () => {
    for (const status of ["SUBMITTED", "ANCHORED_UNVERIFIED", "VERIFIED", "CHAIN_VERIFIED", undefined]) {
      expect(otsLayerText(chain({ rfc3161: {}, ots: { applied: true, status } }), fmt)).toBe("Unavailable");
    }
    expect(otsLayerText(chain({ rfc3161: {}, ots: { applied: false, status: "NOT_REQUESTED" } }), fmt)).toBe("Not requested");
    expect(otsLayerText(chain({ rfc3161: {}, ots: { applied: false, status: "FAILED" } }), fmt)).toBe("Failed");
  });

  it("a legacy STAMPED token never validated is 'Recorded, not validated', never 'Applied'", () => {
    const text = rfc3161LayerText(
      chain({ rfc3161: { applied: false, status: "RECORDED_NOT_VALIDATED", appliedAtUtc: "2026-09-01T00:00:00Z" }, ots: {} }),
      fmt,
    );
    expect(text).toMatch(/^Recorded, not validated/);
    expect(text).not.toMatch(/Applied/);
  });
});

import React from "react";
import { render } from "@testing-library/react";
import { VerifyCaptureManifestSection, readPublicCaptureManifest } from "../../app/verify/[token]/VerifyCaptureManifestSection";

describe("UC-PROV-003 — Public Verify shows the reported capture facts, data-minimized", () => {
  it("domain only (never the private URL), PARTIAL banner, limitations, labelled as client-reported", () => {
    const facts = readPublicCaptureManifest({
      captureManifest: {
        schema: "PROOVRA_CAPTURE_MANIFEST_FACTS_V1",
        kind: "WEB",
        reportedBy: "CAPTURE_CLIENT",
        manifestSchemaVersion: "1",
        manifestSha256: "e".repeat(64),
        manifestPartIndex: 1,
        clientCaptureWindow: { startedAtUtc: "2026-09-30T10:00:00.000Z", endedAtUtc: "2026-09-30T10:00:05.000Z" },
        completeness: "PARTIAL",
        reportedComplete: false,
        limitations: ["PAGE_MUTATED_DURING_CAPTURE"],
        client: { kind: "BROWSER_EXTENSION", appVersion: "1.2.3", platform: null, osVersion: null, model: null, browserName: "Chrome", browserVersion: "140" },
        web: { domain: "example.com", captureMode: "VISIBLE", pageMutatedDuringCapture: true },
        screen: null,
      },
    });
    const { container } = render(<VerifyCaptureManifestSection facts={facts} />);
    const text = container.textContent ?? "";
    expect(text).toContain("example.com");
    expect(text).not.toContain("https://");
    expect(text).toContain("reported by the capture client");
    expect(container.querySelector("[data-verify-capture-partial]")).not.toBeNull();
    expect(text).toContain("Page mutated during capture");
  });
});
