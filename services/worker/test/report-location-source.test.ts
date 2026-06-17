/**
 * Report-v2 — provenance-aware location source label.
 *
 * Pins the contract that the report's Context Signal block reads
 * `evidence.gps.locationSource` and dispatches to the shared
 * `evidenceLocationSourceLabel()` helper:
 *
 *   - INTAKE_LINK_GEOLOCATION         → "Contributor browser permission"
 *                                       + "Upload session location" title
 *                                       + legally-careful body copy
 *   - CAPTURE_BROWSER_GEOLOCATION     → "PROOVRA secure capture"
 *                                       + historical "Location metadata
 *                                         included" title + CAPTURE_LOCATION_
 *                                         CONTEXT_DESCRIPTION body (byte-
 *                                         identical to pre-feature output)
 *   - null                            → same as CAPTURE branch (legacy
 *                                       rows backfilled to that label by
 *                                       the schema migration)
 *   - missing coords                  → no captureContext block at all;
 *                                       MUST NOT raise any warning/failure
 *
 * Critical legal-copy invariants:
 *   - The body string for an INTAKE_LINK row MUST contain "provided by
 *     the contributor's browser during upload" (verbatim contract copy).
 *   - The body string MUST NOT contain the phrase "proves where the
 *     evidence was captured" — overclaiming.
 *   - The shared CAPTURE_LOCATION_LEGAL_BOUNDARY long-form disclaimer
 *     remains at the bottom for both branches.
 */

import { describe, expect, it } from "vitest";
import { buildReportViewModel } from "../src/report-v2";
import type { ReportV2Input } from "../src/report-v2";

const FULL_HASH_A =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FULL_HASH_B =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function baseInput(): ReportV2Input {
  return {
    evidence: {
      tsaProvider: null,
      tsaUrl: null,
      tsaSerialNumber: null,
      tsaGenTimeUtc: null,
      tsaTokenBase64: null,
      tsaMessageImprint: null,
      tsaHashAlgorithm: null,
      tsaStatus: null,
      tsaFailureReason: null,
      id: "evidence-1",
      title: "Evidence Title",
      status: "SIGNED",
      verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
      capturedAtUtc: "2026-01-01T00:00:00.000Z",
      uploadedAtUtc: "2026-01-01T00:01:00.000Z",
      signedAtUtc: "2026-01-01T00:02:00.000Z",
      reportGeneratedAtUtc: "2026-01-01T00:03:00.000Z",
      mimeType: "text/plain",
      sizeBytes: "12",
      durationSec: null,
      storageBucket: "test-bucket",
      storageKey: "evidence/evidence-1/original",
      publicUrl: null,
      gps: { lat: null, lng: null, accuracyMeters: null },
      fileSha256: FULL_HASH_A,
      fingerprintCanonicalJson: '{"a":1}',
      fingerprintHash: FULL_HASH_B,
      signatureBase64: "sig",
      signingKeyId: "proovra_ed25519",
      signingKeyVersion: 1,
      publicKeyPem:
        "-----BEGIN PUBLIC KEY-----\nTEST\n-----END PUBLIC KEY-----\n",
      contentSummary: {
        structure: "single",
        itemCount: 1,
        previewableItemCount: 1,
        downloadableItemCount: 1,
        imageCount: 0,
        videoCount: 0,
        audioCount: 0,
        documentCount: 0,
        otherCount: 0,
      },
    },
    custodyEvents: [
      {
        sequence: 1,
        atUtc: "2026-01-01T00:00:00.000Z",
        eventType: "EVIDENCE_CREATED",
        payload: { evidenceId: "evidence-1" },
        prevEventHash: null,
        eventHash:
          "1111111111111111111111111111111111111111111111111111111111111111",
        chainPosition: 1,
        chainLength: 1,
      },
    ],
    publication: null,
  } as unknown as ReportV2Input;
}

function withCoords(
  input: ReportV2Input,
  locationSource: string | null,
): ReportV2Input {
  return {
    ...input,
    evidence: {
      ...input.evidence,
      gps: {
        lat: "40.7128",
        lng: "-74.0060",
        accuracyMeters: "12",
        locationSource,
      },
    },
  } as ReportV2Input;
}

describe("Report-v2 — location source provenance", () => {
  it("INTAKE_LINK_GEOLOCATION renders contributor-attributed labels + legally careful copy", async () => {
    const vm = await buildReportViewModel(
      withCoords(baseInput(), "INTAKE_LINK_GEOLOCATION"),
    );
    const ctx = vm.meta?.captureContext;
    expect(ctx).toBeTruthy();
    expect(ctx?.sourceLabel).toBe("Contributor browser permission");
    expect(ctx?.statusLabel).toBe("Upload session location");
    expect(ctx?.description).toMatch(
      /provided by the contributor['’]s browser during upload/i,
    );
    // Legal honesty: must NOT claim the report proves where capture
    // happened. This phrase is the brief's named anti-pattern.
    expect(ctx?.description).not.toMatch(/proves where the evidence was/i);
    // Long-form legal disclaimer remains attached.
    expect(ctx?.legalBoundary).toMatch(
      /does not independently prove physical presence/i,
    );
  });

  it("CAPTURE_BROWSER_GEOLOCATION renders the historical PROOVRA secure capture label", async () => {
    const vm = await buildReportViewModel(
      withCoords(baseInput(), "CAPTURE_BROWSER_GEOLOCATION"),
    );
    const ctx = vm.meta?.captureContext;
    expect(ctx).toBeTruthy();
    expect(ctx?.sourceLabel).toBe("PROOVRA secure capture");
    expect(ctx?.statusLabel).toBe("Location metadata included");
  });

  it("null locationSource defaults to the historical CAPTURE label (byte-identical legacy rows)", async () => {
    // Pre-migration rows have null locationSource. The shared helper's
    // defensive default must keep them rendering exactly as they did
    // before this feature shipped, even if the migration's backfill
    // somehow missed a row.
    const vm = await buildReportViewModel(withCoords(baseInput(), null));
    const ctx = vm.meta?.captureContext;
    expect(ctx).toBeTruthy();
    expect(ctx?.sourceLabel).toBe("PROOVRA secure capture");
    expect(ctx?.statusLabel).toBe("Location metadata included");
  });

  it("missing coordinates render NO captureContext block and raise no warning", async () => {
    const vm = await buildReportViewModel(baseInput());
    // The block is null when lat/lng are null. The brief explicitly
    // requires this to NOT be treated as integrity failure / warning.
    expect(vm.meta?.captureContext ?? null).toBeNull();
    // Spot-check: no warning callout in the model mentions location.
    const calloutText = JSON.stringify(vm.meta ?? {}).toLowerCase();
    expect(calloutText).not.toContain("location missing");
    expect(calloutText).not.toContain("location not provided");
    expect(calloutText).not.toContain("location_missing");
  });
});
