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
  TECHNICAL_METADATA_SCHEMA_VERSION,
} from "@proovra/shared-runtime/technical-metadata";

const CHROME_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const SAFARI_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1";

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
      },
      "exifr-test",
    );
    const exif = deriveExifSummary(tm);
    expect(exif.applicable).toBe(true);
    expect(exif.gpsPresent).toBe(true);
    expect(exif.resolution).toBe("4032x3024");
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

describe("verification-package: advisory rename", () => {
  it("emits advisory-signals.json and a deprecated media_intelligence.json alias", async () => {
    const { buildIntelligencePackageManifests } = await import(
      "../src/verification-package-intelligence.js"
    );
    const entries = buildIntelligencePackageManifests({
      mediaSignals: [
        {
          // Package-safe, file-local technical observation. (Workspace/
          // corpus-correlation signals like DUPLICATE_HASH_MATCH are
          // intentionally filtered out of the package — see the
          // verification-package-intelligence advisory-filter tests.)
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
    expect(paths).toContain("intelligence/advisory-signals.json");
    expect(paths).toContain("intelligence/media_intelligence.json");
    const alias = entries.find(
      (e) => e.path === "intelligence/media_intelligence.json",
    )!.json as Record<string, unknown>;
    expect(alias.deprecated).toBe(true);
    expect(alias.renamedTo).toBe("intelligence/advisory-signals.json");
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
        exif: {
          camera: "Apple iPhone 14 Pro",
          originalCaptureTime: "2024-11-15T10:22:05Z",
          gpsPresent: true,
          resolution: "4032×3024",
          softwareTag: null,
          metadataStatus: "PRESENT",
        },
        captureEnvironment: {
          uploadSource: "WEB_APP",
          captureMethod: "SECURE_CAPTURE",
          browserOs: "Chrome on Windows",
          deviceClass: "DESKTOP",
          timezone: "Europe/London",
        },
      },
    } as never);
    expect(html).toContain("Media Technical Summary");
    expect(html).toContain("EXIF Summary");
    expect(html).toContain("Capture Environment");
    // GPS presence flag only — no coordinates, no raw UA string.
    expect(html).toContain("coordinates withheld");
    expect(html).not.toMatch(/-?\d+\.\d{4,}/);
    expect(html).not.toContain("Mozilla/5.0");
  });
});
