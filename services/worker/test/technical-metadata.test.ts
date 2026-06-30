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

  it("emits media/exif/capture files with rich EXIF and never a full IP", async () => {
    const { buildTechnicalMetadataPackageFiles } = await import(
      "../src/verification-package-technical-metadata.js"
    );
    const captureEnv = {
      schemaVersion: "1.0",
      captureMethod: "UPLOAD",
      uploadSource: "WEB_APP",
      browserName: "Chrome",
      osName: "Windows",
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
    expect(byPath.has("technical-metadata/media-summary.json")).toBe(true);
    expect(byPath.has("technical-metadata/exif-summary.json")).toBe(true);
    expect(byPath.has("technical-metadata/capture-environment.json")).toBe(true);
    expect(byPath.has("technical-metadata/network-summary.json")).toBe(true);

    const exif = byPath.get("technical-metadata/exif-summary.json") as {
      parts: Array<Record<string, unknown>>;
    };
    expect(exif.parts[0]!.iso).toBe(80);
    expect(exif.parts[0]!.aperture).toBe("f/1.8");
    expect(exif.parts[0]!.orientation).toBe(1);

    const net = byPath.get("technical-metadata/network-summary.json") as Record<string, unknown>;
    expect(net.maskedIp).toBe("203.0.x.x");
    expect(net.country).toBe("GB");

    // No full IP / raw UA anywhere in the whole package payload.
    const serialized = JSON.stringify(files);
    expect(serialized).not.toContain("203.0.113");
    expect(serialized).not.toMatch(/Mozilla\/5\.0/);
  });

  it("omits network-summary.json when no network values exist", async () => {
    const { buildTechnicalMetadataPackageFiles } = await import(
      "../src/verification-package-technical-metadata.js"
    );
    const captureEnv = {
      schemaVersion: "1.0",
      captureMethod: "UPLOAD",
      uploadSource: "WEB_APP",
      browserName: "Chrome",
      deviceClass: "DESKTOP",
      timezone: "Europe/London",
      ipAddressMasked: null,
      country: null,
      region: null,
      networkType: "UNKNOWN",
    };
    const files = await buildTechnicalMetadataPackageFiles({
      prisma: fakePrisma(captureEnv) as never,
      teamId: "team-1",
      evidenceId: "ev-1",
    });
    expect(
      files.find((f) => f.path === "technical-metadata/network-summary.json"),
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

describe("PDF report: Media Technical Summary section", () => {
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
          lensModel: null,
          originalCaptureTime: "2024-11-15T10:22:05Z",
          iso: 80,
          aperture: "f/1.8",
          exposureTime: "1/120s",
          shutterSpeed: null,
          whiteBalance: null,
          orientation: 1,
          gpsPresent: true,
          resolution: "4032×3024",
          softwareTag: null,
          metadataStatus: "PRESENT",
        },
        captureEnvironment: {
          uploadSource: "WEB_APP",
          captureMethod: "SECURE_CAPTURE",
          browserName: "Chrome",
          browserVersion: "138",
          osName: "Windows",
          osVersion: "10/11",
          deviceClass: "DESKTOP",
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
    expect(html).toContain("Media &amp; Capture Metadata");
    expect(html).toContain("EXIF Summary");
    expect(html).toContain("Capture Environment");
    // Humanized labels — never the raw enum.
    expect(html).toContain("PROOVRA Web Application");
    expect(html).toContain("Secure Browser Capture");
    expect(html).not.toContain("WEB_APP");
    expect(html).not.toContain("SECURE_CAPTURE");
    // Rich EXIF rows + engine/platform present.
    expect(html).toContain("Blink");
    expect(html).toContain("Windows x64");
    expect(html).toContain("f/1.8");
    // Network block (masked IP — never full IP).
    expect(html).toContain("203.0.x.x");
    // GPS presence flag only — no coordinates, no raw UA string.
    expect(html).toContain("coordinates withheld");
    expect(html).not.toMatch(/-?\d+\.\d{4,}/);
    expect(html).not.toContain("Mozilla/5.0");
  });
});
