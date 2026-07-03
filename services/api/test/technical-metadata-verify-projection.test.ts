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

// ---------------------------------------------------------------------------
// Per-part technical metadata (Section 8 of the Technical Appendix).
// ---------------------------------------------------------------------------
describe("technical-metadata verify projection — perParts (internal only)", () => {
  // Multipart: a PRIMARY video part + a SUPPORTING pdf part.
  function fakePrismaMultipart() {
    return {
      $queryRawUnsafe: async (q: string) => {
        if (q.includes("evidence_parts")) {
          return [
            {
              id: "part-1",
              part_index: 0,
              original_file_name: "clip.mp4",
              mime_type: "video/mp4",
              size_bytes: 12_000_000,
              sha256: "a".repeat(64),
              private_role: "PRIMARY",
              source_label: "Primary media",
              technical_metadata: {
                schemaVersion: "1.0",
                mediaKind: "VIDEO",
                mimeType: "video/mp4",
                parseResult: "OK",
                metadataStatus: "PRESENT",
                widthPx: 1920,
                heightPx: 1080,
                durationMs: 42_000,
                videoCodec: "h264",
                container: "mp4",
              },
            },
            {
              id: "part-2",
              part_index: 1,
              original_file_name: "statement.pdf",
              mime_type: "application/pdf",
              size_bytes: 240_000,
              sha256: "b".repeat(64),
              private_role: "SUPPORTING",
              source_label: "Witness statement",
              technical_metadata: {
                schemaVersion: "1.0",
                mediaKind: "PDF",
                mimeType: "application/pdf",
                parseResult: "OK",
                metadataStatus: "PRESENT",
                pageCount: 3,
              },
            },
          ];
        }
        return [{ capture_environment: { schemaVersion: "1.0", uploadSource: "WEB_APP" } }];
      },
    } as never;
  }

  it("internal projection emits per-part rows with humanized role + mapping + sha256", async () => {
    const result = await projectVerifyTechnicalMetadata({
      teamId: "team-1",
      evidenceId: "ev-1",
      prisma: fakePrismaMultipart(),
      internal: true,
    });
    expect(result!.perParts).toBeTruthy();
    expect(result!.perParts!).toHaveLength(2);

    const [primary, supporting] = result!.perParts!;
    // Role + reviewer mapping label are humanized (never the raw enum).
    expect(primary.role).toBe("Primary");
    expect(primary.mappingLabel).toBe("Primary video reviewer representation");
    expect(primary.sha256).toBe("a".repeat(64));
    expect(primary.width).toBe(1920);
    expect(primary.height).toBe(1080);
    expect(primary.durationMs).toBe(42_000);
    expect(primary.codec).toBe("h264");

    expect(supporting.role).toBe("Supporting");
    expect(supporting.sha256).toBe("b".repeat(64));
    expect(supporting.pageCount).toBe(3);

    // Raw role enum must never surface anywhere in the payload.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("PRIMARY");
    expect(serialized).not.toContain("SUPPORTING");
    expect(serialized).not.toContain("MULTIPART_PACKAGE");
    expect(serialized).not.toContain("BULK_IMPORT");
  });

  it("public projection never carries perParts", async () => {
    const result = await projectVerifyTechnicalMetadata({
      teamId: "team-1",
      evidenceId: "ev-1",
      prisma: fakePrismaMultipart(),
      internal: false,
    });
    expect((result as { perParts?: unknown }).perParts ?? null).toBeNull();
  });
});
