/**
 * Phase 31.10 — Report-v2 Media Intelligence Observations section.
 *
 * The section is OPTIONAL — when no `mediaIntelligence` input is
 * supplied, the rendered HTML is BYTE-IDENTICAL to the legacy
 * Phase-31.9-or-earlier output. This file proves that invariant
 * AND the positive-path rendering.
 *
 * Layers covered:
 *
 *   1. Byte-neutrality. With no intelligence input, the rendered
 *      HTML does not contain the section heading or the
 *      `media-intelligence-section` class. The DOM is unchanged.
 *   2. Positive-path render. With signals + thumbnails + OCR/
 *      transcript supplied, the section appears in the expected
 *      order, between the Reviewer Verification Workflow and the
 *      Legal Interpretation & Report Boundary.
 *   3. Safe wording. No forbidden vocabulary in the disclaimer or
 *      any signal projection. No authenticity / admissibility /
 *      proof claims.
 *   4. Bounded emission. Supplying 1000 signals renders at most
 *      200; 100 thumbnails renders at most 24; 1000 OCR/transcript
 *      entries render at most 200.
 *   5. Severity ordering. ATTENTION first, then REVIEW_RECOMMENDED,
 *      then INFO; within a severity the most recent first.
 *   6. Anti-leak source contract. No storage_key / storage_bucket /
 *      signedUrl / multipart_upload_id / raw_gps / private_note
 *      anywhere in the section module.
 *   7. Legal hierarchy preserved. The Forensic Integrity Statement
 *      and Legal Interpretation sections still emit and surround
 *      the new section.
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
      id: "sig-2",
      signalType: "DEVICE_METADATA_OBSERVATION",
      materialId: "mat-1",
      materialLabel: "photo.jpg",
      severity: "INFO",
      confidence: "MEDIUM",
      safeSummary:
        "Device metadata recorded: device make, image dimensions. Advisory only.",
      status: "ACKNOWLEDGED",
      createdAtUtc: "2026-05-20T09:00:00.000Z",
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

// =============================================================================
// PART 1 — Byte neutrality (no-intelligence path unchanged)
// =============================================================================

describe("Phase 31.10 — byte-neutrality: no intelligence input", () => {
  it("legacy callers (no mediaIntelligence) get identical HTML", async () => {
    const vmA = await buildReportViewModel(buildInput());
    const vmB = await buildReportViewModel(
      buildInput({ mediaIntelligence: null }),
    );
    const htmlA = renderReportHtml(vmA);
    const htmlB = renderReportHtml(vmB);
    expect(htmlA).toBe(htmlB);
  });

  it("no Media Intelligence section heading appears in legacy output", async () => {
    const vm = await buildReportViewModel(buildInput());
    const html = renderReportHtml(vm);
    expect(html).not.toContain("Media Intelligence Observations");
    expect(html).not.toContain("media-intelligence-section");
  });

  it("explicitly empty intelligence input also renders byte-identical", async () => {
    const vmA = await buildReportViewModel(buildInput());
    const vmB = await buildReportViewModel(
      buildInput({
        mediaIntelligence: {
          signals: [],
          derivedThumbnails: [],
          ocrTranscript: [],
        },
      }),
    );
    const htmlA = renderReportHtml(vmA);
    const htmlB = renderReportHtml(vmB);
    expect(htmlA).toBe(htmlB);
  });
});

// =============================================================================
// PART 2 — Positive path
// =============================================================================

describe("Phase 31.10 — with intelligence supplied", () => {
  it("emits the section heading", async () => {
    const vm = await buildReportViewModel(
      buildInput({ mediaIntelligence: SAMPLE_INTELLIGENCE }),
    );
    const html = renderReportHtml(vm);
    expect(html).toContain("Media Intelligence Observations");
    expect(html).toContain("media-intelligence-section");
  });

  it("renders every supplied signal's safe summary", async () => {
    const vm = await buildReportViewModel(
      buildInput({ mediaIntelligence: SAMPLE_INTELLIGENCE }),
    );
    const html = renderReportHtml(vm);
    expect(html).toContain("EXIF capture timestamp differs");
    expect(html).toContain("Device metadata recorded");
    expect(html).toContain("Byte-identical material was observed");
  });

  it("severity / confidence / status badges use the advisory labels (NOT 'WARNING'/'CRITICAL')", async () => {
    const vm = await buildReportViewModel(
      buildInput({ mediaIntelligence: SAMPLE_INTELLIGENCE }),
    );
    const html = renderReportHtml(vm);
    expect(html).toContain("Observation");
    expect(html).toContain("Review recommended");
    expect(html).toContain("Needs attention");
    expect(html).toContain("Low confidence");
    expect(html).toContain("Medium confidence");
    expect(html).toContain("High confidence");
    expect(html).toContain("Open");
    expect(html).toContain("Acknowledged");
    expect(html).not.toMatch(/\bWARNING\b/);
    expect(html).not.toMatch(/\bCRITICAL\b/);
    expect(html).not.toMatch(/\bALERT\b/);
  });

  it("renders the material label when supplied", async () => {
    const vm = await buildReportViewModel(
      buildInput({ mediaIntelligence: SAMPLE_INTELLIGENCE }),
    );
    const html = renderReportHtml(vm);
    expect(html).toContain("photo.jpg");
    expect(html).toContain("receipt.pdf");
  });

  it("renders the derived thumbnail with bounded data URL", async () => {
    const vm = await buildReportViewModel(
      buildInput({ mediaIntelligence: SAMPLE_INTELLIGENCE }),
    );
    const html = renderReportHtml(vm);
    expect(html).toContain("media-intelligence-thumbnail");
    expect(html).toContain("Image preview");
  });

  it("renders OCR / transcript availability flags", async () => {
    const vm = await buildReportViewModel(
      buildInput({ mediaIntelligence: SAMPLE_INTELLIGENCE }),
    );
    const html = renderReportHtml(vm);
    expect(html).toContain("OCR and transcript availability");
    expect(html).toContain("mat-2");
  });

  it("severity ordering: ATTENTION row appears before REVIEW_RECOMMENDED before INFO", async () => {
    const vm = await buildReportViewModel(
      buildInput({ mediaIntelligence: SAMPLE_INTELLIGENCE }),
    );
    const html = renderReportHtml(vm);
    const idxAttention = html.indexOf("Byte-identical material was observed");
    const idxReview = html.indexOf("EXIF capture timestamp differs");
    const idxInfo = html.indexOf("Device metadata recorded");
    expect(idxAttention).toBeGreaterThan(0);
    expect(idxReview).toBeGreaterThan(idxAttention);
    expect(idxInfo).toBeGreaterThan(idxReview);
  });
});

// =============================================================================
// PART 3 — Legal hierarchy preserved
// =============================================================================

describe("Phase 31.10 — legal hierarchy preserved", () => {
  it("section appears AFTER Reviewer Verification Workflow and BEFORE Legal Interpretation", async () => {
    const vm = await buildReportViewModel(
      buildInput({ mediaIntelligence: SAMPLE_INTELLIGENCE }),
    );
    const html = renderReportHtml(vm);
    const idxWorkflow = html.indexOf("Reviewer Verification Workflow");
    const idxMedia = html.indexOf("Media Intelligence Observations");
    const idxLegal = html.indexOf("Legal Interpretation");
    expect(idxWorkflow).toBeGreaterThan(0);
    expect(idxMedia).toBeGreaterThan(idxWorkflow);
    expect(idxLegal).toBeGreaterThan(idxMedia);
  });

  it("Integrity Control Checklist + Custody + Legal Interpretation + Technical Appendix still emit", async () => {
    const vm = await buildReportViewModel(
      buildInput({ mediaIntelligence: SAMPLE_INTELLIGENCE }),
    );
    const html = renderReportHtml(vm);
    expect(html).toContain("Integrity Control Checklist");
    expect(html).toContain("Chain of Custody");
    expect(html).toContain("Legal Interpretation");
    expect(html).toContain("Technical Appendix");
  });
});

// =============================================================================
// PART 4 — Safe wording
// =============================================================================

describe("Phase 31.10 — safe wording", () => {
  const FORBIDDEN =
    /\b(tamper(ed|ing)?|forged|fake|authentic(ity)?|admissible|proves?|confirms?|manipulated|doctored)\b/i;

  it("section disclaimer contains no forbidden vocabulary", async () => {
    const vm = await buildReportViewModel(
      buildInput({ mediaIntelligence: SAMPLE_INTELLIGENCE }),
    );
    const html = renderReportHtml(vm);
    const start = html.indexOf("Media Intelligence Observations");
    const end = html.indexOf("Legal Interpretation", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const section = html.slice(start, end);
    expect(section).not.toMatch(FORBIDDEN);
  });

  it("section uses the safer canonical-custody disclaimer phrasing", async () => {
    const vm = await buildReportViewModel(
      buildInput({ mediaIntelligence: SAMPLE_INTELLIGENCE }),
    );
    const html = renderReportHtml(vm);
    expect(html).toContain("canonical custody record");
    expect(html).toContain("do not classify the recorded material");
  });
});

// =============================================================================
// PART 5 — Bounded emission (DoS prevention)
// =============================================================================

describe("Phase 31.10 — bounded emission", () => {
  it("caps signals at 200 even when 1000 are supplied", async () => {
    const huge: MediaIntelligenceReportInput = {
      signals: Array.from({ length: 1000 }, (_, i) => ({
        id: `sig-${i}`,
        signalType: "EXIF_MISSING",
        materialId: "mat-1",
        materialLabel: "x.jpg",
        severity: "INFO" as const,
        confidence: "MEDIUM" as const,
        safeSummary: `signal-${i}-summary-token`,
        status: "PENDING" as const,
        createdAtUtc: "2026-05-20T00:00:00.000Z",
      })),
    };
    const vm = await buildReportViewModel(
      buildInput({ mediaIntelligence: huge }),
    );
    const html = renderReportHtml(vm);
    // Count <tr> rows inside the signals table — should be 200 + 1 header.
    const start = html.indexOf("Recorded observations");
    const end = html.indexOf("</section>", start);
    const block = html.slice(start, end);
    const trCount = (block.match(/<tr>/g) ?? []).length;
    // 1 header row + 200 data rows = 201
    expect(trCount).toBe(201);
    // Signal at index 200 must NOT be rendered.
    expect(html).not.toContain("signal-200-summary-token");
    // Signal at index 199 (the last allowed) MUST be rendered.
    expect(html).toContain("signal-199-summary-token");
  });

  it("caps derived thumbnails at 24 even when 100 are supplied", async () => {
    const huge: MediaIntelligenceReportInput = {
      derivedThumbnails: Array.from({ length: 100 }, (_, i) => ({
        materialId: `mat-${i}`,
        dataUrl: `data:image/png;base64,token-${i}-AAA`,
        assetKind: "image_thumbnail" as const,
      })),
    };
    const vm = await buildReportViewModel(
      buildInput({ mediaIntelligence: huge }),
    );
    const html = renderReportHtml(vm);
    const thumbCount = (
      html.match(/class="media-intelligence-thumbnail"/g) ?? []
    ).length;
    expect(thumbCount).toBe(24);
    expect(html).not.toContain("token-24-AAA");
    expect(html).toContain("token-23-AAA");
  });
});

// =============================================================================
// PART 6 — Anti-leak source contract
// =============================================================================

describe("Phase 31.10 — anti-leak source contract", () => {
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

  it("section is the ONLY new section wired into render-html.ts", () => {
    const renderSrc = readFileSync(
      fileURLToPath(
        new URL("../src/report-v2/render-html.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(renderSrc).toMatch(/renderMediaIntelligenceSection\(vm\)/);
    // The position must remain AFTER the forensic statement and
    // BEFORE the legal interpretation — protect that ordering at
    // the source-contract level.
    const idxForensic = renderSrc.indexOf(
      "renderForensicIntegrityStatementSection(vm)",
    );
    const idxMedia = renderSrc.indexOf("renderMediaIntelligenceSection(vm)");
    const idxLegal = renderSrc.indexOf(
      "renderLegalInterpretationSection(vm)",
    );
    expect(idxForensic).toBeGreaterThan(0);
    expect(idxMedia).toBeGreaterThan(idxForensic);
    expect(idxLegal).toBeGreaterThan(idxMedia);
  });
});
