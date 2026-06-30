/**
 * Report-v2 — Media Intelligence Observations REMOVAL.
 *
 * Product decision: the "Media Intelligence Observations" report section
 * (advisory / workspace-correlation signals — duplicate/similar material
 * without hashes or reviewer-actionable proof) was removed from the PDF
 * report. It added no forensic value to public-facing output. This file
 * pins the REMOVAL:
 *
 *   1. The section never renders, even when a `mediaIntelligence`
 *      projection is supplied to the view model.
 *   2. The report HTML is byte-identical with and without the
 *      `mediaIntelligence` input (it is ignored by the renderer).
 *   3. The deterministic "Media Technical Summary" section (EXIF +
 *      capture environment + media facts) — the forensic metadata that
 *      remains — still renders independently.
 *   4. render-html.ts no longer wires renderMediaIntelligenceSection.
 *   5. The dormant media-intelligence section module is still anti-leak
 *      safe (no storage internals / signed URLs / private notes / raw
 *      GPS) — it is retained but unwired, so the contract still holds.
 */

import { describe, expect, it } from "vitest";
import { buildReportViewModel, renderReportHtml } from "../src/report-v2";
import type {
  MediaIntelligenceReportInput,
  ReportV2Input,
} from "../src/report-v2";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FULL_HASH_A =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FULL_HASH_B =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function buildInput(overrides?: Partial<ReportV2Input>): ReportV2Input {
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
      fingerprintCanonicalJson: "{\"a\":1}",
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
        pdfCount: 0,
        textCount: 1,
        otherCount: 0,
        primaryKind: "text",
        primaryMimeType: "text/plain",
        totalSizeBytes: "12",
        totalSizeDisplay: "12 B",
      },
      contentItems: [
        {
          id: "evidence-1",
          index: 0,
          label: "Primary evidence",
          originalFileName: "evidence.txt",
          mimeType: "text/plain",
          kind: "text",
          sizeBytes: "12",
          durationMs: null,
          sha256: FULL_HASH_A,
          isPrimary: true,
          previewable: true,
          downloadable: true,
          viewUrl: "https://example.com/evidence.txt",
          displaySizeLabel: "12 B",
          previewRole: "primary_preview",
          embedPreference: "text_excerpt",
          artifactRole: "primary_evidence",
          originalPreservationNote: "Original preserved.",
          reviewerRepresentationLabel: "Rendered excerpt",
          reviewerRepresentationNote: "Reviewer-facing excerpt only.",
          verificationMaterialsNote: "See technical appendix.",
          previewTextExcerpt: "hello world",
          previewCaption: "Text excerpt",
          previewDataUrl: null,
        },
      ],
      primaryContentItem: {
        id: "evidence-1",
        index: 0,
        label: "Primary evidence",
        originalFileName: "evidence.txt",
        mimeType: "text/plain",
        kind: "text",
        sizeBytes: "12",
        durationMs: null,
        sha256: FULL_HASH_A,
        isPrimary: true,
        previewable: true,
        downloadable: true,
        viewUrl: "https://example.com/evidence.txt",
        displaySizeLabel: "12 B",
        previewRole: "primary_preview",
        embedPreference: "text_excerpt",
        artifactRole: "primary_evidence",
        originalPreservationNote: "Original preserved.",
        reviewerRepresentationLabel: "Rendered excerpt",
        reviewerRepresentationNote: "Reviewer-facing excerpt only.",
        verificationMaterialsNote: "See technical appendix.",
        previewTextExcerpt: "hello world",
        previewCaption: "Text excerpt",
        previewDataUrl: null,
      },
      defaultPreviewItemId: "evidence-1",
      previewPolicy: {
        contentVisible: true,
        previewEnabled: true,
        downloadableFromVerify: true,
        rationale: "Preview enabled.",
        privacyNotice: "Preview is reviewer-facing only.",
      },
      reviewGuidance: {
        reviewerWorkflow: ["Review content", "Review integrity"],
        contentReviewNote: "Review content.",
        legalAssessmentNote: "Assess legal context separately.",
        integrityAssessmentNote: "Integrity verified.",
        multipartReviewNote: "Single-item record.",
      },
      limitations: {
        short: "Integrity only.",
        detailed: "Does not prove factual truth or admissibility.",
      },
      contentAccessPolicy: {
        mode: "full_access",
        allowContentView: true,
        allowDownload: true,
      },
      embeddedPreviewsSnapshot: [
        {
          id: "evidence-1",
          previewTextExcerpt: "hello world",
          previewCaption: "Text excerpt",
        },
      ],
    },
    custodyEvents: [
      {
        sequence: 1,
        atUtc: "2026-01-01T00:00:00.000Z",
        eventType: "EVIDENCE_CREATED",
        payloadSummary: "{\"type\":\"PHOTO\"}",
      },
    ],
    version: 1,
    generatedAtUtc: "2026-01-01T00:03:00.000Z",
    buildInfo: "build-123",
    ...overrides,
  };
}

const SAMPLE_INTELLIGENCE: MediaIntelligenceReportInput = {
  signals: [
    {
      id: "sig-1",
      signalType: "EXIF_TIMESTAMP_MISMATCH",
      materialId: "mat-1",
      materialLabel: "photo.jpg",
      severity: "REVIEW_RECOMMENDED",
      confidence: "LOW",
      safeSummary:
        "EXIF capture timestamp differs from server receipt time by approximately 2h 13m. Review recommended; device clock skew is common.",
      status: "PENDING",
      createdAtUtc: "2026-05-20T10:00:00.000Z",
    },
    {
      id: "sig-3",
      signalType: "DUPLICATE_HASH_MATCH",
      materialId: "mat-2",
      materialLabel: "receipt.pdf",
      severity: "ATTENTION",
      confidence: "HIGH",
      safeSummary:
        "Byte-identical material was observed elsewhere in this workspace (3 other record(s)). Review recommended.",
      status: "PENDING",
      createdAtUtc: "2026-05-20T11:00:00.000Z",
    },
  ],
  derivedThumbnails: [
    {
      materialId: "mat-1",
      dataUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      assetKind: "image_thumbnail",
    },
  ],
  ocrTranscript: [
    {
      materialId: "mat-2",
      ocrAvailable: true,
      transcriptAvailable: false,
      ocrIndexed: true,
      transcriptIndexed: false,
    },
  ],
};

const TECH_SUMMARY = {
  mediaFilesAnalyzed: 1,
  mediaFilesTotal: 1,
  metadataStatus: "Complete" as const,
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
    whiteBalance: null,
    orientation: 1,
    gpsPresent: true,
    resolution: "4032×3024",
    softwareTag: null,
    metadataStatus: "PRESENT" as const,
  },
  captureEnvironment: {
    uploadSource: "WEB_APP",
    captureMethod: "SECURE_CAPTURE",
    browserName: "Chrome",
    browserVersion: "138",
    osName: "Windows",
    osVersion: null,
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
};

// =============================================================================
// Removal — Media Intelligence Observations never renders
// =============================================================================

describe("Media Intelligence Observations — removed from the report", () => {
  it("does NOT render the section even when a mediaIntelligence projection is supplied", async () => {
    const vm = await buildReportViewModel(
      buildInput({ mediaIntelligence: SAMPLE_INTELLIGENCE }),
    );
    const html = renderReportHtml(vm);
    expect(html).not.toContain("Media Intelligence Observations");
    expect(html).not.toContain("media-intelligence-section");
    // None of the low-value advisory/correlation content leaks in.
    expect(html).not.toContain("Byte-identical material was observed");
    expect(html).not.toContain("Recorded observations");
  });

  it("report HTML is byte-identical with and without the mediaIntelligence input", async () => {
    const vmA = await buildReportViewModel(buildInput());
    const vmB = await buildReportViewModel(
      buildInput({ mediaIntelligence: SAMPLE_INTELLIGENCE }),
    );
    const vmC = await buildReportViewModel(
      buildInput({ mediaIntelligence: null }),
    );
    const a = renderReportHtml(vmA);
    const b = renderReportHtml(vmB);
    const c = renderReportHtml(vmC);
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it("legacy output never contained the section heading either", async () => {
    const vm = await buildReportViewModel(buildInput());
    const html = renderReportHtml(vm);
    expect(html).not.toContain("Media Intelligence Observations");
  });
});

// =============================================================================
// The deterministic "Media Technical Summary" remains
// =============================================================================

describe("Capture Device & Camera Metadata still renders (device enrichment remains)", () => {
  it("renders the technical summary section independently", async () => {
    const vm = await buildReportViewModel(
      buildInput({ technicalSummary: TECH_SUMMARY }),
    );
    const html = renderReportHtml(vm);
    expect(html).toContain("Capture Device &amp; Camera Metadata");
    expect(html).toContain("technical-summary-section");
    // No EXIF GPS exposure — location lives in Capture Context only.
    expect(html).not.toContain("coordinates withheld");
    expect(html).not.toMatch(/-?\d+\.\d{4,}/);
  });

  it("does not render the removed advisory section alongside it", async () => {
    const vm = await buildReportViewModel(
      buildInput({
        mediaIntelligence: SAMPLE_INTELLIGENCE,
        technicalSummary: TECH_SUMMARY,
      }),
    );
    const html = renderReportHtml(vm);
    expect(html).toContain("Capture Device &amp; Camera Metadata");
    expect(html).not.toContain("Media Intelligence Observations");
  });
});

// =============================================================================
// Source contract — render-html no longer wires the section
// =============================================================================

describe("render-html.ts no longer wires the Media Intelligence section", () => {
  const renderSrc = readFileSync(
    fileURLToPath(
      new URL("../src/report-v2/render-html.ts", import.meta.url),
    ),
    "utf8",
  );

  it("does not call renderMediaIntelligenceSection", () => {
    expect(renderSrc).not.toMatch(/renderMediaIntelligenceSection\(/);
  });

  it("does not import the media-intelligence section module", () => {
    expect(renderSrc).not.toMatch(/sections\/media-intelligence/);
  });

  it("still wires the deterministic technical-summary section", () => {
    expect(renderSrc).toMatch(/renderTechnicalSummarySection\(vm\)/);
  });
});

// =============================================================================
// The dormant section module remains anti-leak safe (retained, unwired)
// =============================================================================

describe("dormant media-intelligence section module — anti-leak contract", () => {
  const src = readFileSync(
    fileURLToPath(
      new URL("../src/report-v2/sections/media-intelligence.ts", import.meta.url),
    ),
    "utf8",
  );

  it("no storage internals / signed URLs / private notes / raw GPS referenced", () => {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const banned of [
      "storageKey",
      "storage_key",
      "storageBucket",
      "storage_bucket",
      "multipartUploadId",
      "multipart_upload_id",
      "signedUrl",
      "signed_url",
      "presignedUrl",
      "rawGps",
      "raw_gps",
      "privateNote",
      "private_note",
      "legalNote",
      "legalNoteBody",
    ]) {
      expect(noComments, `section leaks ${banned}`).not.toContain(banned);
    }
  });

  it("no forbidden truth-claim vocabulary in any source literal", () => {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const literals = noComments.match(/"[^"\n]+"/g) ?? [];
    const forbidden =
      /\b(tamper(ed|ing)?|forged|fake|authentic(ity)?|admissible|proves?|confirms?|manipulated|doctored)\b/i;
    for (const lit of literals) {
      expect(lit, `section uses forbidden wording: ${lit}`).not.toMatch(
        forbidden,
      );
    }
  });
});
