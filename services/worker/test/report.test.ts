import { describe, expect, it } from "vitest";
import { buildReportViewModel, renderReportHtml } from "../src/report-v2";
import type { ReportV2Input } from "../src/report-v2";

const FULL_HASH_A =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FULL_HASH_B =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FULL_HASH_C =
  "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function expectInOrder(text: string, tokens: string[]) {
  let lastIndex = -1;
  for (const token of tokens) {
    const next = text.indexOf(token, lastIndex + 1);
    expect(next).toBeGreaterThan(lastIndex);
    lastIndex = next;
  }
}

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

describe("report v2 pipeline", () => {
  it("builds a view model with inventory and certification-aware sections", async () => {
    const vm = await buildReportViewModel(buildInput());

    expect(vm.title).toBe("Evidence Title");
    expect(vm.structureLabel).toBe("Single evidence item");
    expect(vm.inventoryRows).toHaveLength(1);
    expect(vm.contentItems[0]?.previewTextExcerpt).toBe("hello world");
    expect(vm.certifications.hasAny).toBe(false);
    expect(vm.forensicRows).toHaveLength(1);
    expect(vm.presentationMode).toBe("simple");
    expect(vm.presentation.buckets.supportingPreviewItems).toHaveLength(0);
  });

  it("renders the v2 HTML report sections in the intended order", async () => {
    const vm = await buildReportViewModel(buildInput());
    const html = renderReportHtml(vm);

    expect(html).toContain("Evidence Title");
    expect(html).toContain("Executive conclusion");
    expect(html).toContain("Integrity Proof");
    expect(html).toContain("Storage, Timestamping &amp; Publication");
    expect(html).toContain("Technical Appendix");
    expect(html).not.toContain("Evidence Manifest");
    expect(html).not.toContain("Evidence Package Structure");

    expectInOrder(html, [
      "Executive conclusion",
      "Evidence Presentation",
      "Integrity Proof",
      "Storage, Timestamping &amp; Publication",
      "Chain of Custody",
      "Legal Interpretation &amp; Review Use",
      "Technical Appendix",
    ]);
  });

  it("keeps full hashes and supporting previewable evidence visually represented", async () => {
    const vm = await buildReportViewModel(
      buildInput({
        evidence: {
          ...buildInput().evidence,
          sizeBytes: "4096",
          fingerprintHash: FULL_HASH_B,
          contentSummary: {
            ...buildInput().evidence.contentSummary!,
            structure: "multipart",
            itemCount: 3,
            previewableItemCount: 3,
            downloadableItemCount: 3,
            imageCount: 1,
            pdfCount: 1,
            textCount: 1,
            totalSizeBytes: "4096",
            totalSizeDisplay: "4 KB",
          },
          contentItems: [
            {
              ...buildInput().evidence.contentItems![0]!,
              kind: "image",
              originalFileName: "lead-photo.jpg",
              mimeType: "image/jpeg",
              previewDataUrl: TINY_PNG_DATA_URL,
              previewTextExcerpt: null,
              displaySizeLabel: "2 KB",
              sha256: FULL_HASH_A,
            },
            {
              ...buildInput().evidence.contentItems![0]!,
              id: "evidence-2",
              index: 1,
              label: "Supporting pdf",
              originalFileName: "supporting.pdf",
              mimeType: "application/pdf",
              kind: "pdf",
              previewDataUrl: TINY_PNG_DATA_URL,
              previewTextExcerpt: null,
              displaySizeLabel: "1 KB",
              sha256: FULL_HASH_B,
              isPrimary: false,
              artifactRole: "supporting_evidence",
            },
            {
              ...buildInput().evidence.contentItems![0]!,
              id: "evidence-3",
              index: 2,
              label: "Supporting note",
              originalFileName: "note.txt",
              mimeType: "text/plain",
              kind: "text",
              previewDataUrl: null,
              previewTextExcerpt: "secondary excerpt",
              displaySizeLabel: "1 KB",
              sha256: FULL_HASH_C,
              isPrimary: false,
              artifactRole: "supporting_evidence",
            },
          ],
          primaryContentItem: {
            ...buildInput().evidence.primaryContentItem!,
            kind: "image",
            originalFileName: "lead-photo.jpg",
            mimeType: "image/jpeg",
            previewDataUrl: TINY_PNG_DATA_URL,
            previewTextExcerpt: null,
            displaySizeLabel: "2 KB",
            sha256: FULL_HASH_A,
          },
          embeddedPreviewsSnapshot: [
            {
              id: "evidence-2",
              previewDataUrl: TINY_PNG_DATA_URL,
            },
            {
              id: "evidence-3",
              previewTextExcerpt: "secondary excerpt",
            },
          ],
        },
      })
    );

    const html = renderReportHtml(vm);

    expect(vm.presentation.buckets.supportingPreviewItems).toHaveLength(2);
    expect(html).toContain("Supporting preview items");
    expect(html).toContain("supporting.pdf");
    expect(html).toContain("note.txt");
    expect(html).toContain(FULL_HASH_A);
    expect(html).toContain(FULL_HASH_B);
    expect(html).toContain(FULL_HASH_C);
    expect(html).not.toContain(`${FULL_HASH_A.slice(0, 8)}…`);
    expect(html).not.toContain(`${FULL_HASH_B.slice(0, 8)}...`);
  });
});
