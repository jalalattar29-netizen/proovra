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
    expect(text).not.toMatch(/Anchored|attestation recorded/i);
  });

  it("ANCHORED without a chain check is 'Bitcoin attestation recorded', not independently checked — no ✓", () => {
    const text = otsLayerText(
      chain({
        rfc3161: {},
        ots: {
          applied: true,
          status: "ANCHORED",
          verification: "ATTESTATION_RECORDED",
          statusLabel: "Bitcoin attestation recorded",
          bitcoinBlockHeight: 812345,
          appliedAtUtc: "2026-09-01T00:00:00Z",
        },
      }),
      fmt,
    );
    expect(text).toBe(
      "Bitcoin attestation recorded · Not independently checked against Bitcoin · The proof names Bitcoin block 812345; PROOVRA has not checked it against the Bitcoin main chain · attestation recorded by PROOVRA 2026-09-01T00:00:00Z",
    );
    expect(text).not.toMatch(/✓|Verified|Anchored/);
  });

  it("a CHAIN_VERIFIED claim without its chain fact is not believed; with it, it is the only ✓", () => {
    const ots = { applied: true, status: "ANCHORED", verification: "CHAIN_VERIFIED", bitcoinBlockHeight: 812345, appliedAtUtc: null };
    expect(otsLayerText(chain({ rfc3161: {}, ots }), fmt)).toMatch(/^Bitcoin attestation recorded · Not independently checked/);
    const verified = otsLayerText(
      chain({
        rfc3161: {},
        ots: {
          ...ots,
          chain: {
            status: "VERIFIED",
            blockHeight: 812345,
            blockHash: "f".repeat(64),
            confirmations: 9,
            minConfirmations: 6,
            checkedAtUtc: "2026-09-02T10:00:00Z",
          },
        },
      }),
      fmt,
    );
    expect(verified).toMatch(/^✓ Independently verified against the Bitcoin main chain · Merkle root matches Bitcoin block 812345; 9 confirmations at 2026-09-02/);
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
    // AUD-17: its time is the token's claim, qualified.
    expect(text).toContain("token time");
    expect(text).toContain("claimed by the token; not validated");
  });

  it("AUD-14: a provider outage reads Not obtained, never Timestamp failed", () => {
    const text = rfc3161LayerText(chain({ rfc3161: { applied: false, status: "NOT_OBTAINED", appliedAtUtc: null }, ots: {} }), fmt);
    expect(text).toBe("Not obtained");
    expect(rfc3161LayerText(chain({ rfc3161: { applied: false, status: "FAILED", appliedAtUtc: null }, ots: {} }), fmt)).toBe("Validation failed");
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

// AUD-017 — a continuous capture's completeness is the client's statement: the
// owner section and Public Verify state delivered of recorded segments and the
// boundary the server cannot cross, in THE shared wording.
import { captureManifestItems } from "../../app/(app)/evidence/[id]/_tabs/EvidenceProvenanceChainSection";

const continuousFacts = (complete: boolean, screen: Record<string, unknown>) => ({
  schema: "PROOVRA_CAPTURE_MANIFEST_FACTS_V1",
  kind: "SCREEN_CONTINUOUS",
  reportedBy: "CAPTURE_CLIENT",
  manifestSchemaVersion: "PROOVRA_SCREEN_CAPTURE_CONTINUOUS_MANIFEST_V2",
  manifestSha256: "e".repeat(64),
  manifestPartIndex: 2,
  clientCaptureWindow: { startedAtUtc: "2026-10-01T10:00:00.000Z", endedAtUtc: "2026-10-01T10:00:12.000Z" },
  completeness: complete ? "COMPLETE_SESSION" : "INTERRUPTED_SESSION",
  reportedComplete: complete,
  limitations: complete ? [] : ["SEGMENT_UPLOAD_LOST"],
  client: { kind: "MOBILE_APP", appVersion: "1.0.0", platform: "android", osVersion: "14", model: "Pixel 7", browserName: null, browserVersion: null },
  web: null,
  screen: { endReason: complete ? "USER_STOPPED" : "INTERRUPTED", totalDurationMs: 12000, ...screen },
});

describe("AUD-017 — continuous completeness is client-reported on owner and public surfaces", () => {
  it("owner provenance: delivered of recorded, labelled client-reported (legacy facts without recordedThrough)", () => {
    const items = captureManifestItems(continuousFacts(true, { artifactCount: 2, recordedSegmentCount: 2 }) as never, (iso) => iso);
    expect(items).toContainEqual({ label: "Completeness (client-reported)", value: "Reported complete by the capture client" });
    expect(items).toContainEqual({ label: "Segments (client-reported)", value: "Segments delivered 2 of 2 recorded (client-reported)" });
    expect(items.map((i) => i.label)).not.toContain("Completeness (reported)");
  });

  it("Public Verify: segment line and the boundary note", () => {
    const facts = readPublicCaptureManifest({
      captureManifest: continuousFacts(false, { artifactCount: 2, recordedSegmentCount: 5, declaredRecordedThroughMax: 5 }),
    });
    const { container } = render(<VerifyCaptureManifestSection facts={facts} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Segments delivered 2 of 5 recorded (client-reported)");
    expect(text).toContain("Reported not complete by the capture client (Interrupted session)");
    expect(container.querySelector("[data-verify-capture-completeness-note]")?.textContent).toMatch(
      /cannot verify segments the client never declared/,
    );
  });
});
