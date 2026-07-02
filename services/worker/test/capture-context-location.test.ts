/**
 * Verification package capture-context.json — location emission contract.
 *
 * Pins that the package's capture-context.json (a) carries the raw
 * capture-location coordinates + intake-attributed source label when a
 * capture location is present, and (b) is NOT emitted at all when there is
 * no location (no fake location). This is the package-side counterpart to
 * the intake geolocation ordering fix: once Evidence.lat/lng are persisted
 * before completeEvidence, the worker's captureLocation metadata is
 * populated and this builder emits the file.
 */
import { describe, it, expect } from "vitest";
import { buildCaptureContext } from "../src/verification-package";

describe("verification package — capture-context.json location", () => {
  it("emits location + intake source label when a capture location is present", () => {
    const cc = buildCaptureContext(
      {
        capturedAtUtc: "2026-06-30T10:05:00.000Z",
        deviceTimeIso: null,
        captureLocation: {
          lat: 52.520008,
          lng: 13.404954,
          accuracyMeters: 12,
          locationSource: "INTAKE_LINK_GEOLOCATION",
        },
      } as never,
      "ev-1",
    ) as {
      location: { lat: number; lng: number; accuracyMeters: number };
      source: string;
      title: string;
    } | null;

    expect(cc).toBeTruthy();
    expect(cc!.location).toEqual({
      lat: 52.520008,
      lng: 13.404954,
      accuracyMeters: 12,
    });
    // Intake-attributed provenance (not the PROOVRA-secure-capture label).
    expect(cc!.source).toBe("Contributor browser permission");
    expect(cc!.title).toBe("Upload Session Location");
    // Never any recipient / phone / email / provider id in this file.
    const serialized = JSON.stringify(cc);
    expect(serialized).not.toMatch(/@|phone|recipient|twilio|whatsapp/i);
  });

  it("emits NOTHING (null) when there is no capture location — never a fake", () => {
    const cc = buildCaptureContext(
      { capturedAtUtc: null, deviceTimeIso: null, captureLocation: null } as never,
      "ev-1",
    );
    expect(cc).toBeNull();
  });
});
