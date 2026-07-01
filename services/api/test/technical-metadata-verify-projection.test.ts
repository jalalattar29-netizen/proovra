/**
 * Enterprise Technical Metadata — verify/internal projection privacy
 * contract.
 *
 * Pins:
 *   * Public projection (internal:false) NEVER carries userAgentHash /
 *     ipAddressMasked / locale.
 *   * Internal projection (internal:true) DOES carry the privacy-safe
 *     masked IP + UA hash + locale.
 *   * Neither projection — public or internal — ever carries the raw IP,
 *     the raw User-Agent, or EXIF GPS coordinates.
 *   * EXIF GPS is a boolean flag only.
 */

import { describe, expect, it } from "vitest";

import { projectVerifyTechnicalMetadata } from "../src/services/technical-metadata/verify-projection.service.js";

const RAW_IP = "203.0.113.42";
const RAW_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";

// Fake prisma returning one image part with EXIF + GPS and a capture
// environment that already stored ONLY the privacy-safe fields (masked
// IP + UA hash) — i.e. the shape the create route actually persists.
function fakePrisma() {
  return {
    $queryRawUnsafe: async (q: string) => {
      if (q.includes("evidence_parts")) {
        return [
          {
            id: "part-1",
            original_file_name: "photo.jpg",
            mime_type: "image/jpeg",
            size_bytes: 4_234_567,
            sha256: "a".repeat(64),
            technical_metadata: {
              schemaVersion: "1.0",
              mediaKind: "IMAGE",
              mimeType: "image/jpeg",
              parseResult: "OK",
              metadataStatus: "PRESENT",
              parserName: "exifr",
              parserVersion: "test",
              widthPx: 4032,
              heightPx: 3024,
              exifPresent: true,
              cameraMake: "Apple",
              cameraModel: "iPhone 14 Pro",
              originalCaptureTime: "2024-11-15T10:22:05Z",
              gpsPresent: true,
              orientation: 1,
            },
          },
        ];
      }
      // evidence capture_environment row
      return [
        {
          capture_environment: {
            schemaVersion: "1.0",
            captureMethod: "SECURE_CAPTURE",
            uploadSource: "WEB_APP",
            browserName: "Chrome",
            osName: "Windows",
            deviceClass: "DESKTOP",
            timezone: "Europe/London",
            locale: "en-GB",
            userAgentHash: "sha256:deadbeef",
            ipAddressMasked: "203.0.x.x",
            attestationAttempted: false,
            attestationResult: null,
          },
        },
      ];
    },
  } as never;
}

describe("technical-metadata verify projection — privacy boundary", () => {
  it("public projection omits userAgentHash / ipAddressMasked / locale", async () => {
    const result = await projectVerifyTechnicalMetadata({
      teamId: "team-1",
      evidenceId: "ev-1",
      prisma: fakePrisma(),
      internal: false,
    });
    expect(result).not.toBeNull();
    const ce = result!.captureEnvironment!;
    expect(ce.browserName).toBe("Chrome");
    expect("userAgentHash" in ce).toBe(false);
    expect("ipAddressMasked" in ce).toBe(false);
    expect("locale" in ce).toBe(false);
    // engine / platform / network are package/internal-only — never public.
    expect(ce.engine).toBeNull();
    expect(ce.platform).toBeNull();
    expect(result!.network).toBeNull();
  });

  it("internal projection includes masked IP + UA hash + locale", async () => {
    const result = await projectVerifyTechnicalMetadata({
      teamId: "team-1",
      evidenceId: "ev-1",
      prisma: fakePrisma(),
      internal: true,
    });
    const ce = result!.captureEnvironment!;
    expect(ce.userAgentHash).toBe("sha256:deadbeef");
    expect(ce.ipAddressMasked).toBe("203.0.x.x");
    expect(ce.locale).toBe("en-GB");
  });

  // Fake prisma that also returns an intake-link SMS delivery row.
  function fakePrismaWithDelivery() {
    return {
      $queryRawUnsafe: async (q: string) => {
        if (q.includes("evidence_parts")) {
          return [
            {
              id: "part-1",
              original_file_name: "photo.jpg",
              mime_type: "image/jpeg",
              size_bytes: 100,
              sha256: "a".repeat(64),
              technical_metadata: {
                schemaVersion: "1.0",
                mediaKind: "IMAGE",
                mimeType: "image/jpeg",
                parseResult: "OK",
                metadataStatus: "PRESENT",
                parserName: "exifr",
                parserVersion: "test",
                exifPresent: true,
                cameraMake: "Apple",
                cameraModel: "iPhone 14 Pro",
              },
            },
          ];
        }
        if (q.includes("communication_messages")) {
          return [
            {
              intake_mode: "EXTERNAL_ONE_TIME",
              recipient_preview: "+49 ••• ••• 1234",
              recipient_hash: "beef",
              channel: "SMS",
              delivery_status: "DELIVERED",
              sent_at_utc: "2026-06-30T10:00:00.000Z",
              delivered_at_utc: "2026-06-30T10:00:05.000Z",
            },
          ];
        }
        return [{ capture_environment: { schemaVersion: "1.0" } }];
      },
    } as never;
  }

  it("internal projection includes masked intake delivery; public never does", async () => {
    const internalResult = await projectVerifyTechnicalMetadata({
      teamId: "team-1",
      evidenceId: "ev-1",
      prisma: fakePrismaWithDelivery(),
      internal: true,
    });
    // Internal acquisition carries the MASKED recipient (never raw).
    expect(internalResult!.acquisition).toBeTruthy();
    expect(internalResult!.acquisition!.deliveryChannel).toBe("SMS");
    expect(internalResult!.acquisition!.method).toBe("Intake Link");
    expect(internalResult!.acquisition!.recipientMasked).toBe(
      "+49 ••• ••• 1234",
    );
    expect(internalResult!.acquisition!.submissionStatus).toContain("Delivered");

    // Richer photographic EXIF is internal-only, never on the public page.
    expect(internalResult!.exifExtended ?? null).not.toBeNull();

    const publicResult = await projectVerifyTechnicalMetadata({
      teamId: "team-1",
      evidenceId: "ev-1",
      prisma: fakePrismaWithDelivery(),
      internal: false,
    });
    // Public acquisition is present (method/channel) but NEVER the recipient.
    expect(publicResult!.acquisition).toBeTruthy();
    expect(publicResult!.acquisition!.deliveryChannel).toBe("SMS");
    expect(
      (publicResult!.acquisition as { recipientMasked?: string }).recipientMasked ??
        null,
    ).toBeNull();
    expect(publicResult!.exifExtended ?? null).toBeNull();

    // No full phone digit-run on either projection.
    expect(JSON.stringify(internalResult)).not.toMatch(/\d{7,}/);
    expect(JSON.stringify(publicResult)).not.toMatch(/\d{7,}/);
  });

  it("neither projection exposes raw IP, raw UA, or GPS coordinates", async () => {
    for (const internal of [false, true]) {
      const result = await projectVerifyTechnicalMetadata({
        teamId: "team-1",
        evidenceId: "ev-1",
        prisma: fakePrisma(),
        internal,
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(RAW_IP);
      expect(serialized).not.toContain(RAW_UA);
      // No decimal coordinate-like values anywhere.
      expect(serialized).not.toMatch(/-?\d+\.\d{4,}/);
      // EXIF GPS is a boolean presence flag only.
      expect(result!.exif!.gpsPresent).toBe(true);
    }
  });
});
