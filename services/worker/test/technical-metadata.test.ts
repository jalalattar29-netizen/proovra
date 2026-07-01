/**
 * Enterprise Technical Metadata layer — unit tests.
 *
 * Covers:
 *   * Capture-environment UA parsing + privacy invariants (no raw IP /
 *     raw UA leak; masked IP; UA hash).
 *   * Shared projections (media kind, EXIF summary derivation, aggregate
 *     status, GPS coordinates never surfaced).
 *   * Parser dispatcher graceful-degrade for unsupported input.
 *   * Verification-package builder: rename to advisory-signals.json +
 *     deprecated media_intelligence.json alias.
 *   * PDF report section: byte-neutral when null, no raw UA/IP/GPS.
 */

import { describe, expect, it } from "vitest";

import {
  buildCaptureEnvironment,
  parseUserAgent,
  maskIp,
  hashUserAgent,
  classifyMediaKind,
  deriveExifSummary,
  aggregateMetadataStatus,
  imageMetadataFromExif,
  toPerPartMediaSummary,
  unparsedMetadata,
  humanizeUploadSource,
  humanizeCaptureMethod,
  isMeaningfulMetadataValue,
  metadataRows,
  metadataStatusLabel,
  buildEvidenceAcquisitionContext,
  toPublicAcquisition,
  toInternalAcquisition,
  TECHNICAL_METADATA_SCHEMA_VERSION,
} from "@proovra/shared-runtime/technical-metadata";

const CHROME_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const SAFARI_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1";
const FIREFOX_ANDROID =
  "Mozilla/5.0 (Android 13; Mobile; rv:120.0) Gecko/120.0 Firefox/120.0";
const EDGE_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";

describe("UA engine + platform detection", () => {
  it("Chrome on Windows → Blink + Windows x64", () => {
    const ua = parseUserAgent(CHROME_WIN);
    expect(ua.browserName).toBe("Chrome");
    expect(ua.engine).toBe("Blink");
    expect(ua.platform).toBe("Windows x64");
  });
  it("Safari on iOS → WebKit + iOS", () => {
    const ua = parseUserAgent(SAFARI_IOS);
    expect(ua.engine).toBe("WebKit");
    expect(ua.platform).toBe("iOS");
  });
  it("Firefox on Android → Gecko + Android", () => {
    const ua = parseUserAgent(FIREFOX_ANDROID);
    expect(ua.browserName).toBe("Firefox");
    expect(ua.engine).toBe("Gecko");
    expect(ua.platform).toBe("Android");
  });
  it("Edge on Windows → Blink", () => {
    const ua = parseUserAgent(EDGE_WIN);
    expect(ua.browserName).toBe("Edge");
    expect(ua.engine).toBe("Blink");
  });
  it("never throws / null engine+platform on garbage", () => {
    const ua = parseUserAgent("garbage");
    expect(ua.engine).toBeNull();
    expect(ua.platform).toBeNull();
  });
  it("Windows NT 10.0 → osName Windows with NO fabricated version", () => {
    const ua = parseUserAgent(CHROME_WIN);
    expect(ua.osName).toBe("Windows");
    // The UA cannot prove Windows 10 vs 11, so no version is invented.
    expect(ua.osVersion).toBeNull();
  });
  it("Android keeps its provable version", () => {
    const ua = parseUserAgent(FIREFOX_ANDROID);
    expect(ua.osName).toBe("Android");
    expect(ua.osVersion).toBe("13");
  });
});

describe("EXIF original capture time — offset-aware, no fabricated UTC", () => {
  it("keeps the naive local wall-clock when no offset is present", async () => {
    const { deriveCaptureTime } = await import(
      "@proovra/shared-runtime/media-intelligence"
    );
    // exifr revives the naive EXIF time as a LOCAL Date. Local getters
    // recover the exact wall-clock regardless of the server timezone.
    const d = new Date(2024, 10, 15, 10, 22, 5); // 2024-11-15 10:22:05 local
    expect(deriveCaptureTime(d, null)).toBe("2024-11-15T10:22:05");
    // No timezone is invented and it is NOT coerced to UTC "Z".
    expect(deriveCaptureTime(d, null)).not.toMatch(/Z$/);
  });

  it("preserves the real offset when OffsetTimeOriginal is present", async () => {
    const { deriveCaptureTime } = await import(
      "@proovra/shared-runtime/media-intelligence"
    );
    const d = new Date(2024, 10, 15, 10, 22, 5);
    expect(deriveCaptureTime(d, "+09:00")).toBe("2024-11-15T10:22:05+09:00");
    expect(deriveCaptureTime(d, "-0530")).toBe("2024-11-15T10:22:05-05:30");
    expect(deriveCaptureTime(d, "Z")).toBe("2024-11-15T10:22:05+00:00");
  });

  it("parses EXIF/ISO string forms and rejects garbage", async () => {
    const { deriveCaptureTime } = await import(
      "@proovra/shared-runtime/media-intelligence"
    );
    expect(deriveCaptureTime("2024:11:15 10:22:05", "+02:00")).toBe(
      "2024-11-15T10:22:05+02:00",
    );
    expect(deriveCaptureTime("2024-11-15T10:22:05", null)).toBe(
      "2024-11-15T10:22:05",
    );
    expect(deriveCaptureTime("not a date", null)).toBeNull();
    expect(deriveCaptureTime(null, "+09:00")).toBeNull();
    // Invalid offset → naive local, never a bad suffix.
    expect(deriveCaptureTime("2024-11-15T10:22:05", "banana")).toBe(
      "2024-11-15T10:22:05",
    );
  });
});

describe("Evidence Acquisition mapper (channels + privacy)", () => {
  it("maps SMS / WhatsApp / Email delivery channels to product labels", () => {
    for (const [raw, label, type] of [
      ["SMS", "SMS", "phone"],
      ["WHATSAPP", "WhatsApp", "phone"],
      ["EMAIL", "Email", "email"],
    ] as const) {
      const ctx = buildEvidenceAcquisitionContext({
        intakeMode: "EXTERNAL_ONE_TIME",
        deliveryChannelRaw: raw,
        recipientMasked: type === "email" ? "j***@x.com" : "+49 ••• 1234",
        recipientType: type,
      })!;
      expect(ctx.method).toBe("Intake Link");
      expect(ctx.deliveryChannel).toBe(label);
      expect(ctx.recipientType).toBe(type);
    }
  });

  it("treats a reusable link with no messaging as a Public Secure Link (no recipient)", () => {
    const ctx = buildEvidenceAcquisitionContext({
      captureMethod: "EXTERNAL_INTAKE_UPLOAD",
      intakeMode: "EXTERNAL_REUSABLE",
    })!;
    expect(ctx.method).toBe("Public Secure Link");
    expect(ctx.deliveryChannel).toBe("Public Secure Link");
    expect(ctx.recipientMasked).toBeNull();
  });

  it("maps mobile-app and API and web uploads (non-intake)", () => {
    const mobile = buildEvidenceAcquisitionContext({ uploadSource: "MOBILE_APP" })!;
    expect(mobile.method).toBe("Mobile Capture");
    expect(mobile.deliveryChannel).toBe("PROOVRA Mobile");
    expect(mobile.isIntake).toBe(false);
    expect(buildEvidenceAcquisitionContext({ uploadSource: "API" })!.method).toBe(
      "API Submission",
    );
    expect(
      buildEvidenceAcquisitionContext({ uploadSource: "WEB_APP" })!.method,
    ).toBe("Direct Upload");
  });

  it("returns null when there is no acquisition signal at all", () => {
    expect(buildEvidenceAcquisitionContext({})).toBeNull();
  });

  it("public view NEVER carries a recipient; internal view carries the masked one", () => {
    const ctx = buildEvidenceAcquisitionContext({
      intakeMode: "EXTERNAL_ONE_TIME",
      deliveryChannelRaw: "SMS",
      deliveryStatusRaw: "DELIVERED",
      sentAtUtc: "2026-07-01T00:00:00Z",
      recipientMasked: "+49 ••• ••• 1234",
      recipientType: "phone",
      recipientHash: "abc",
      consentAcceptedAtUtc: "2026-07-01T00:00:00Z",
      consentVersion: "v3",
    })!;
    const pub = toPublicAcquisition(ctx) as Record<string, unknown>;
    expect("recipientMasked" in pub).toBe(false);
    expect("recipientType" in pub).toBe(false);
    expect(pub.deliveryChannel).toBe("SMS");
    expect(pub.consentAccepted).toBe(true);

    const int = toInternalAcquisition(ctx);
    expect(int.recipientMasked).toBe("+49 ••• ••• 1234");
    expect(int.recipientType).toBe("phone");
    // Even internal never carries a hash or the raw value.
    expect(JSON.stringify(int)).not.toContain("abc");
  });
});

describe("humanization + smart rows", () => {
  it("humanizes upload source enums (never raw)", () => {
    expect(humanizeUploadSource("WEB_APP")).toBe("PROOVRA Web Application");
    expect(humanizeUploadSource("INTAKE_LINK")).toBe("Intake Link Submission");
    expect(humanizeUploadSource("MOBILE_APP")).toBe("Mobile Capture");
    expect(humanizeUploadSource("API")).toBe("API Submission");
    expect(humanizeUploadSource(null)).toBe("Unknown");
    expect(humanizeUploadSource("UNKNOWN")).toBe("Unknown");
  });
  it("humanizes capture method enums", () => {
    expect(humanizeCaptureMethod("SECURE_CAPTURE")).toBe("Secure Browser Capture");
    expect(humanizeCaptureMethod("UPLOAD")).toBe("Direct Upload");
    expect(humanizeCaptureMethod("MOBILE")).toBe("Mobile Capture");
  });
  it("metadataStatusLabel reads as plain English", () => {
    expect(metadataStatusLabel("MISSING")).toBe("No embedded metadata detected");
    expect(metadataStatusLabel("PRESENT")).toBe("Embedded metadata available");
    expect(metadataStatusLabel("FAILED")).toBe("Metadata parsing failed");
  });
  it("isMeaningfulMetadataValue hides null/empty/unknown/zero", () => {
    expect(isMeaningfulMetadataValue(null)).toBe(false);
    expect(isMeaningfulMetadataValue("")).toBe(false);
    expect(isMeaningfulMetadataValue("Unknown")).toBe(false);
    expect(isMeaningfulMetadataValue("N/A")).toBe(false);
    expect(isMeaningfulMetadataValue(0)).toBe(false);
    expect(isMeaningfulMetadataValue([])).toBe(false);
    expect(isMeaningfulMetadataValue("Chrome")).toBe(true);
    expect(isMeaningfulMetadataValue(138)).toBe(true);
    expect(isMeaningfulMetadataValue(0, { zeroIsMeaningful: true })).toBe(true);
  });
  it("metadataRows filters out non-meaningful rows", () => {
    const rows = metadataRows([
      { label: "Browser", value: "Chrome 138" },
      { label: "Engine", value: null },
      { label: "Platform", value: "UNKNOWN" },
      { label: "ISO", value: 0 },
      { label: "Camera", value: "Apple iPhone" },
    ]);
    expect(rows.map((r) => r.label)).toEqual(["Browser", "Camera"]);
  });
});

describe("capture-environment: UA parsing", () => {
  it("parses Chrome on Windows desktop", () => {
    const ua = parseUserAgent(CHROME_WIN);
    expect(ua.browserName).toBe("Chrome");
    expect(ua.osName).toBe("Windows");
    expect(ua.deviceClass).toBe("DESKTOP");
  });

  it("parses Safari on iOS mobile", () => {
    const ua = parseUserAgent(SAFARI_IOS);
    expect(ua.browserName).toBe("Safari");
    expect(ua.osName).toBe("iOS");
    expect(ua.deviceClass).toBe("MOBILE");
  });

  it("never throws on garbage / empty UA", () => {
    expect(() => parseUserAgent(null)).not.toThrow();
    expect(parseUserAgent("").deviceClass).toBe("UNKNOWN");
  });
});

describe("capture-environment: privacy invariants", () => {
  it("masks IPv4 to first two octets", () => {
    expect(maskIp("203.0.113.42")).toBe("203.0.x.x");
  });

  it("masks IPv6 to first two hextets", () => {
    expect(maskIp("2001:db8:85a3::8a2e:370:7334")).toBe("2001:db8:…");
  });

  it("hashes the UA and never returns the raw string", () => {
    const h = hashUserAgent(CHROME_WIN);
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(h).not.toContain("Chrome");
  });

  it("buildCaptureEnvironment never carries raw IP or raw UA", () => {
    const env = buildCaptureEnvironment({
      rawUserAgent: CHROME_WIN,
      rawIp: "203.0.113.42",
      timezone: "Europe/London",
      locale: "en-GB",
      captureMethod: "SECURE_CAPTURE",
      uploadSource: "WEB_APP",
    });
    const serialized = JSON.stringify(env);
    expect(serialized).not.toContain("203.0.113.42");
    expect(serialized).not.toContain(CHROME_WIN);
    expect(env.ipAddressMasked).toBe("203.0.x.x");
    expect(env.browserName).toBe("Chrome");
    expect(env.engine).toBe("Blink");
    expect(env.platform).toBe("Windows x64");
    expect(env.networkType).toBe("UNKNOWN");
    expect(env.timezone).toBe("Europe/London");
    expect(env.uploadSource).toBe("WEB_APP");
  });
});

describe("projections: media kind + EXIF derivation", () => {
  it("classifies MIME types", () => {
    expect(classifyMediaKind("image/jpeg")).toBe("IMAGE");
    expect(classifyMediaKind("video/mp4")).toBe("VIDEO");
    expect(classifyMediaKind("application/pdf")).toBe("PDF");
    expect(classifyMediaKind("text/plain")).toBe("OTHER");
    expect(classifyMediaKind(null)).toBe("OTHER");
  });

  it("derives an applicable EXIF summary and never leaks GPS coordinates", () => {
    const tm = imageMetadataFromExif(
      "image/jpeg",
      {
        exifPresent: true,
        dateTimeOriginalUtc: "2024-11-15T10:22:05Z",
        createDateUtc: null,
        dimensions: { width: 4032, height: 3024 },
        cameraMake: "Apple",
        cameraModel: "iPhone 14 Pro",
        hasGps: true,
        orientation: 1,
        software: null,
        lensModel: "iPhone 14 Pro back camera 6.86mm f/1.78",
        iso: 80,
        aperture: "f/1.8",
        exposureTime: "1/120s",
        shutterSpeed: "1/120s",
        whiteBalance: "Auto",
        compression: null,
        flash: "No flash",
        meteringMode: "Pattern",
        exposureMode: "Auto",
        colorSpace: "sRGB",
        focalLength: "6.9mm",
        focalLength35mm: "26mm",
        imageUniqueId: "ABC123DEF456",
      },
      "exifr-test",
    );
    const exif = deriveExifSummary(tm);
    expect(exif.applicable).toBe(true);
    expect(exif.gpsPresent).toBe(true);
    expect(exif.resolution).toBe("4032x3024");
    // Rich EXIF flows through to the summary.
    expect(exif.iso).toBe(80);
    expect(exif.aperture).toBe("f/1.8");
    expect(exif.exposureTime).toBe("1/120s");
    expect(exif.lensModel).toContain("iPhone 14 Pro");
    expect(exif.orientation).toBe(1);
    // Extended photographic EXIF also flows through.
    expect(exif.flash).toBe("No flash");
    expect(exif.meteringMode).toBe("Pattern");
    expect(exif.colorSpace).toBe("sRGB");
    expect(exif.focalLength).toBe("6.9mm");
    expect(exif.focalLength35mm).toBe("26mm");
    expect(exif.imageUniqueId).toBe("ABC123DEF456");
    // GPS is a boolean only — no numeric coordinates anywhere.
    const serialized = JSON.stringify(exif);
    expect(serialized).not.toMatch(/-?\d+\.\d{4,}/);
  });

  it("marks EXIF not applicable when metadata is missing", () => {
    const tm = unparsedMetadata("application/pdf", "UNSUPPORTED");
    expect(deriveExifSummary(tm).applicable).toBe(false);
  });

  it("aggregates metadata status across parts", () => {
    const part = (status: "PRESENT" | "MISSING") =>
      toPerPartMediaSummary({
        id: "p",
        filename: "f",
        sizeBytes: 1,
        sha256: "x",
        mimeType: "image/jpeg",
        technicalMetadata: {
          schemaVersion: TECHNICAL_METADATA_SCHEMA_VERSION,
          mediaKind: "IMAGE",
          mimeType: "image/jpeg",
          parseResult: "OK",
          metadataStatus: status,
          parserName: "x",
          parserVersion: "1",
        },
      });
    expect(aggregateMetadataStatus([part("PRESENT"), part("PRESENT")])).toBe(
      "Complete",
    );
    expect(aggregateMetadataStatus([part("PRESENT"), part("MISSING")])).toBe(
      "Partial",
    );
    expect(aggregateMetadataStatus([])).toBe("Unavailable");
  });
});

describe("parser dispatcher: graceful-degrade", () => {
  it("returns UNSUPPORTED for an unknown MIME without throwing", async () => {
    const { dispatchTechnicalMetadata } = await import(
      "../src/technical-metadata/dispatch.js"
    );
    const tm = await dispatchTechnicalMetadata(Buffer.from("hello"), "text/plain");
    expect(tm.parseResult).toBe("UNSUPPORTED");
    expect(tm.mediaKind).toBe("OTHER");
  });

  it("returns FAILED (not throw) for corrupt image bytes", async () => {
    const { dispatchTechnicalMetadata } = await import(
      "../src/technical-metadata/dispatch.js"
    );
    const tm = await dispatchTechnicalMetadata(
      Buffer.from([0x00, 0x01, 0x02, 0x03]),
      "image/jpeg",
    );
    // exifr returns parse_failed → still produces a bounded record.
    expect(["OK", "FAILED"]).toContain(tm.parseResult);
    expect(tm.mediaKind).toBe("IMAGE");
  });
});

describe("verification package technical-metadata files", () => {
  const TM_IMAGE = {
    schemaVersion: TECHNICAL_METADATA_SCHEMA_VERSION,
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
    iso: 80,
    aperture: "f/1.8",
    exposureTime: "1/120s",
    orientation: 1,
    gpsPresent: true,
  };

  function fakePrisma(captureEnv: Record<string, unknown> | null) {
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
              technical_metadata: TM_IMAGE,
            },
          ];
        }
        return [{ capture_environment: captureEnv }];
      },
    };
  }

  it("emits exif-details/device-enrichment/capture-environment and never a full IP", async () => {
    const { buildTechnicalMetadataPackageFiles } = await import(
      "../src/verification-package-technical-metadata.js"
    );
    const captureEnv = {
      schemaVersion: "1.0",
      captureMethod: "UPLOAD",
      uploadSource: "WEB_APP",
      browserName: "Chrome",
      osName: "Windows",
      osVersion: null,
      deviceClass: "DESKTOP",
      engine: "Blink",
      platform: "Windows x64",
      timezone: "Europe/London",
      locale: "en-GB",
      userAgentHash: "sha256:abc",
      ipAddressMasked: "203.0.x.x",
      country: "GB",
      region: null,
      networkType: "UNKNOWN",
      ipSourceHeader: "req.ip",
    };
    const files = await buildTechnicalMetadataPackageFiles({
      prisma: fakePrisma(captureEnv) as never,
      teamId: "team-1",
      evidenceId: "ev-1",
    });
    const byPath = new Map(files.map((f) => [f.path, f.json]));
    // The slimmed package: deep EXIF + device roll-up + capture env.
    expect(byPath.has("technical-metadata/exif-details.json")).toBe(true);
    expect(byPath.has("technical-metadata/device-enrichment.json")).toBe(true);
    expect(byPath.has("technical-metadata/capture-environment.json")).toBe(true);
    // The duplicative manifest-style files are gone.
    expect(byPath.has("technical-metadata/media-summary.json")).toBe(false);
    expect(byPath.has("technical-metadata/network-summary.json")).toBe(false);
    expect(byPath.has("technical-metadata/exif-summary.json")).toBe(false);

    const exif = byPath.get("technical-metadata/exif-details.json") as {
      source: string;
      parts: Array<{
        partId: string;
        source: string;
        extractedAt: string;
        fieldsPresent: string[];
        camera?: Record<string, unknown>;
        capture?: Record<string, unknown>;
        exposure?: Record<string, unknown>;
        image?: Record<string, unknown>;
        software?: Record<string, unknown>;
      }>;
    };
    expect(exif.source).toBe("exif");
    const part0 = exif.parts[0]!;
    expect(part0.source).toBe("exif");
    expect(part0.partId).toBe("part-1");
    expect(typeof part0.extractedAt).toBe("string");
    expect(Array.isArray(part0.fieldsPresent)).toBe(true);
    // Grouped, forensic layout.
    expect(part0.camera!.make).toBe("Apple");
    expect(part0.camera!.model).toBe("iPhone 14 Pro");
    expect(part0.exposure!.iso).toBe(80);
    expect(part0.exposure!.aperture).toBe("f/1.8");
    // Orientation is preserved (was reportedly dropped to null) under capture.
    expect(part0.capture!.orientation).toBe(1);
    expect(part0.capture!.gpsPresent).toBe(true);
    // NEVER emit null/empty fields anywhere in exif-details.
    const exifSerialized = JSON.stringify(exif);
    expect(exifSerialized).not.toContain(":null");
    expect(exifSerialized).not.toContain('""');

    const device = byPath.get(
      "technical-metadata/device-enrichment.json",
    ) as {
      fields: Record<
        string,
        { value: string; source: string; confidence: string }
      >;
    };
    // Field-level source/confidence per the enterprise schema.
    expect(device.fields.operatingSystem!.value).toBe("Windows");
    expect(device.fields.operatingSystem!.source).toBe("capture_environment");
    expect(device.fields.operatingSystem!.confidence).toBe("medium");
    expect(device.fields.captureDevice!.value).toBe("Apple iPhone 14 Pro");
    expect(device.fields.captureDevice!.source).toBe("exif");
    expect(device.fields.cameraMake!.value).toBe("Apple");
    expect(device.fields.cameraModel!.value).toBe("iPhone 14 Pro");

    const env = byPath.get(
      "technical-metadata/capture-environment.json",
    ) as Record<string, unknown>;
    expect(env.ipAddressMasked).toBe("203.0.x.x");
    expect(env.country).toBe("GB");

    // No full IP / raw UA anywhere in the whole package payload.
    const serialized = JSON.stringify(files);
    expect(serialized).not.toContain("203.0.113");
    expect(serialized).not.toMatch(/Mozilla\/5\.0/);
  });

  it("omits capture-environment.json when no capture environment was recorded", async () => {
    const { buildTechnicalMetadataPackageFiles } = await import(
      "../src/verification-package-technical-metadata.js"
    );
    const files = await buildTechnicalMetadataPackageFiles({
      prisma: fakePrisma(null) as never,
      teamId: "team-1",
      evidenceId: "ev-1",
    });
    expect(
      files.find(
        (f) => f.path === "technical-metadata/capture-environment.json",
      ),
    ).toBeUndefined();
    // EXIF still emits from the part itself, independent of capture env.
    expect(
      files.find((f) => f.path === "technical-metadata/exif-details.json"),
    ).toBeDefined();
  });

  // ---- intake-delivery.json (Evidence Acquisition, masked recipient) ----
  // `acq` is the single flattened acquisition row (evidence + session + link
  // + latest comm message). null → no intake acquisition.
  function fakePrismaWithAcquisition(acq: Record<string, unknown> | null) {
    return {
      $queryRawUnsafe: async (q: string) => {
        if (q.includes("evidence_parts")) {
          return [
            {
              id: "part-1",
              original_file_name: "photo.jpg",
              mime_type: "image/jpeg",
              sha256: "a".repeat(64),
              technical_metadata: TM_IMAGE,
            },
          ];
        }
        // The acquisition query joins evidence + communication_messages.
        if (q.includes("communication_messages")) {
          return acq ? [acq] : [{ capture_method: "UPLOADED_FILE" }];
        }
        return [{ capture_environment: null }];
      },
    };
  }

  function intakeDeliveryEntry(files: ReadonlyArray<{ path: string; json: unknown }>) {
    return files.find(
      (f) => f.path === "technical-metadata/intake-delivery.json",
    );
  }

  it("emits a masked intake-delivery.json for SMS (never the full phone)", async () => {
    const { buildTechnicalMetadataPackageFiles } = await import(
      "../src/verification-package-technical-metadata.js"
    );
    const files = await buildTechnicalMetadataPackageFiles({
      prisma: fakePrismaWithAcquisition({
        intake_mode: "EXTERNAL_ONE_TIME",
        recipient_preview: "+49 ••• ••• 1234",
        recipient_hash: "deadbeef",
        channel: "SMS",
        delivery_status: "DELIVERED",
        sent_at_utc: "2026-06-30T10:00:00.000Z",
        delivered_at_utc: "2026-06-30T10:00:05.000Z",
        submitted_at_utc: "2026-06-30T10:05:00.000Z",
        consent_accepted_at_utc: "2026-06-30T09:59:00.000Z",
        consent_policy_version: "v3",
      }) as never,
      teamId: "team-1",
      evidenceId: "ev-1",
    });
    const entry = intakeDeliveryEntry(files);
    expect(entry).toBeDefined();
    const json = entry!.json as {
      source: string;
      acquisition: { method: string; deliveryChannel: string; submissionStatus: string[] };
      recipient: { type: string; masked: string; hash: string; fullValueIncluded: boolean };
      consent: { accepted: boolean; version: string };
      privacy: Record<string, string>;
    };
    expect(json.source).toBe("intake_link_delivery");
    expect(json.acquisition.method).toBe("Intake Link");
    expect(json.acquisition.deliveryChannel).toBe("SMS");
    expect(json.acquisition.submissionStatus).toContain("Submitted");
    expect(json.recipient.type).toBe("phone");
    expect(json.recipient.masked).toBe("+49 ••• ••• 1234");
    expect(json.recipient.hash).toBe("sha256:deadbeef");
    expect(json.recipient.fullValueIncluded).toBe(false);
    expect(json.consent.accepted).toBe(true);
    expect(json.consent.version).toBe("v3");
    expect(json.privacy.publicReport).toBe("recipient_not_included");
    expect(json.privacy.package).toBe("masked_and_hashed_only");

    // No full phone / provider IDs / raw payloads anywhere.
    const serialized = JSON.stringify(files);
    expect(serialized).not.toMatch(/\+49\d{6,}/);
    expect(serialized).not.toMatch(/\b\d{10,}\b/);
    // No Twilio SID / provider message ID shape (SM… / MM…) leaks.
    expect(serialized).not.toMatch(/\bSM[0-9a-f]{20,}/i);
    expect(serialized).not.toMatch(/\bMM[0-9a-f]{20,}/i);
  });

  it("masks the email recipient for EMAIL delivery (never the raw email)", async () => {
    const { buildTechnicalMetadataPackageFiles } = await import(
      "../src/verification-package-technical-metadata.js"
    );
    const files = await buildTechnicalMetadataPackageFiles({
      prisma: fakePrismaWithAcquisition({
        intake_mode: "EXTERNAL_ONE_TIME",
        recipient_preview: null,
        recipient_hash: "beef",
        recipient_email: "jalal@gmail.com",
        channel: "EMAIL",
        delivery_status: "SENT",
        sent_at_utc: "2026-06-30T10:00:00.000Z",
      }) as never,
      teamId: "team-1",
      evidenceId: "ev-1",
    });
    const entry = intakeDeliveryEntry(files);
    expect(entry).toBeDefined();
    const json = entry!.json as {
      acquisition: { deliveryChannel: string };
      recipient: { type: string; masked: string };
    };
    expect(json.acquisition.deliveryChannel).toBe("Email");
    expect(json.recipient.type).toBe("email");
    expect(json.recipient.masked).toContain("@gmail.com");
    expect(json.recipient.masked).toContain("*");
    // Raw email never present anywhere in the package.
    expect(JSON.stringify(files)).not.toContain("jalal@gmail.com");
  });

  it("omits the recipient for a Public Secure Link (reusable, no messaging)", async () => {
    const { buildTechnicalMetadataPackageFiles } = await import(
      "../src/verification-package-technical-metadata.js"
    );
    const files = await buildTechnicalMetadataPackageFiles({
      prisma: fakePrismaWithAcquisition({
        intake_mode: "EXTERNAL_REUSABLE",
        capture_method: "EXTERNAL_INTAKE_UPLOAD",
        channel: null,
      }) as never,
      teamId: "team-1",
      evidenceId: "ev-1",
    });
    const entry = intakeDeliveryEntry(files);
    expect(entry).toBeDefined();
    const json = entry!.json as {
      acquisition: { method: string; deliveryChannel: string | null };
      recipient?: unknown;
    };
    expect(json.acquisition.method).toBe("Public Secure Link");
    expect(json.recipient).toBeUndefined();
  });

  it("does NOT emit intake-delivery.json for a direct (non-intake) upload", async () => {
    const { buildTechnicalMetadataPackageFiles } = await import(
      "../src/verification-package-technical-metadata.js"
    );
    const files = await buildTechnicalMetadataPackageFiles({
      prisma: fakePrismaWithAcquisition(null) as never,
      teamId: "team-1",
      evidenceId: "ev-1",
    });
    expect(intakeDeliveryEntry(files)).toBeUndefined();
    // The old recipient-context filename must never reappear.
    expect(
      files.find(
        (f) => f.path === "technical-metadata/intake-recipient-context.json",
      ),
    ).toBeUndefined();
  });
});

describe("ffprobe capability + video parser graceful-degrade", () => {
  it("detectFfmpegCapability never throws and reports ffprobe availability", async () => {
    const { detectFfmpegCapability, __resetFfmpegCapabilityForTests } =
      await import("../src/ffmpeg-capability.js");
    __resetFfmpegCapabilityForTests();
    let threw = false;
    let cap: Awaited<ReturnType<typeof detectFfmpegCapability>> | null = null;
    try {
      cap = await detectFfmpegCapability();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(cap).not.toBeNull();
    if (cap!.ok) {
      // ffprobePath is either a usable string or explicitly null — the
      // contract the video parser branches on. Never undefined.
      expect(
        cap!.ffprobePath === null || typeof cap!.ffprobePath === "string",
      ).toBe(true);
    } else {
      expect(typeof cap!.reason).toBe("string");
    }
  });

  it("video parser never throws and degrades to FAILED/UNSUPPORTED on garbage", async () => {
    const { parseVideoMetadata } = await import(
      "../src/technical-metadata/video-parser.js"
    );
    const tm = await parseVideoMetadata(
      Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]),
      "video/mp4",
    );
    expect(["VIDEO", "AUDIO"]).toContain(tm.mediaKind);
    // With no ffprobe → UNSUPPORTED; with ffprobe present but garbage
    // bytes → FAILED. Either way it is a bounded, non-throwing record.
    expect(["UNSUPPORTED", "FAILED"]).toContain(tm.parseResult);
  });
});

describe("verification-package: advisory output removed", () => {
  it("does NOT emit advisory-signals.json or media_intelligence.json (product removal)", async () => {
    const { buildIntelligencePackageManifests } = await import(
      "../src/verification-package-intelligence.js"
    );
    const entries = buildIntelligencePackageManifests({
      mediaSignals: [
        {
          id: "s1",
          signalType: "EXIF_MISSING",
          materialId: null,
          severity: "INFO",
          confidence: "LOW",
          safeSummary: "An observation.",
          status: "PENDING",
          createdAtUtc: "2026-01-01T00:00:00Z",
        },
      ],
    });
    const paths = entries.map((e) => e.path);
    // The low-value advisory section was removed from the default
    // verification package; deterministic technical metadata lives under
    // technical-metadata/ instead.
    expect(paths).not.toContain("intelligence/advisory-signals.json");
    expect(paths).not.toContain("intelligence/media_intelligence.json");
  });
});

describe("PDF report: Capture Device & Camera Metadata section", () => {
  it("is byte-neutral when technicalSummary is null", async () => {
    const { renderTechnicalSummarySection } = await import(
      "../src/report-v2/sections/technical-summary.js"
    );
    expect(
      renderTechnicalSummarySection({ technicalSummary: null } as never),
    ).toBe("");
  });

  it("renders without raw UA / IP / GPS coordinates", async () => {
    const { renderTechnicalSummarySection } = await import(
      "../src/report-v2/sections/technical-summary.js"
    );
    const html = renderTechnicalSummarySection({
      technicalSummary: {
        mediaFilesAnalyzed: 1,
        mediaFilesTotal: 1,
        metadataStatus: "Complete",
        primaryMediaType: "Image",
        resolutionSummary: "4032×3024",
        primaryMedia: {
          mediaKind: "IMAGE",
          durationMs: null,
          videoCodec: null,
          frameRate: null,
          pageCount: null,
        },
        exif: {
          exifPresent: true,
          camera: "Apple iPhone 14 Pro",
          cameraMake: "Apple",
          cameraModel: "iPhone 14 Pro",
          lensModel: null,
          originalCaptureTime: "2024-11-15T10:22:05Z",
          iso: 80,
          aperture: "f/1.8",
          exposureTime: "1/120s",
          shutterSpeed: null,
          // Auto white balance + normal (landscape) orientation must be
          // hidden from the PDF.
          whiteBalance: "Auto",
          orientation: 1,
          gpsPresent: true,
          resolution: "4032×3024",
          softwareTag: "S731BXXS7BZF3",
          metadataStatus: "PRESENT",
        },
        captureEnvironment: {
          uploadSource: "WEB_APP",
          captureMethod: "SECURE_CAPTURE",
          browserName: "Chrome",
          browserVersion: "138",
          osName: "Windows",
          // Exact Windows version is unprovable → no version, renders "Windows".
          osVersion: null,
          // Mobile device-class → browser is shown even with a camera.
          deviceClass: "MOBILE",
          engine: "Blink",
          platform: "Windows x64",
          timezone: "Europe/London",
          locale: "en-GB",
        },
        network: {
          maskedIp: "203.0.x.x",
          country: "GB",
          region: null,
          networkType: null,
        },
      },
    } as never);
    // Integrated Technical Summary — grouped compact tables, not a
    // standalone near-empty "Camera Metadata" page.
    expect(html).toContain("Technical Summary");
    expect(html).toContain("Capture Device");
    expect(html).toContain("Camera");
    expect(html).toContain("Exposure");
    // Humanized labels — never the raw enum.
    expect(html).toContain("PROOVRA Web Application");
    expect(html).toContain("Secure Browser Capture");
    expect(html).not.toContain("WEB_APP");
    expect(html).not.toContain("SECURE_CAPTURE");
    // Camera make/model are split when both are reliably available.
    expect(html).toContain("Camera Make");
    expect(html).toContain("Camera Model");
    expect(html).toContain("iPhone 14 Pro");
    expect(html).toContain("f/1.8");
    // EXIF Original Capture Time label (distinct from PROOVRA timestamps).
    expect(html).toContain("EXIF Original Capture Time");
    // OS renders as "Windows" — never the fabricated "10/11".
    expect(html).toContain("Windows");
    expect(html).not.toContain("10/11");
    // Browser shown for mobile device-class even alongside a camera.
    expect(html).toContain("Chrome");
    // Auto white balance + normal orientation are hidden from the PDF.
    expect(html).not.toContain("White balance");
    expect(html).not.toContain("Orientation");
    // Raw firmware/software build id never reaches the PDF.
    expect(html).not.toContain("S731BXXS7BZF3");
    // Duplicative / privacy-sensitive blocks are gone from the PDF.
    expect(html).not.toContain("EXIF Summary");
    expect(html).not.toContain("203.0.x.x"); // no network block in PDF
    expect(html).not.toContain("Blink"); // engine is package-only
    expect(html).not.toContain("Windows x64"); // platform is package-only
    expect(html).not.toMatch(/Files analysed/i);
    // No coordinates, no raw UA string.
    expect(html).not.toMatch(/-?\d+\.\d{4,}/);
    expect(html).not.toContain("Mozilla/5.0");
  });
});
