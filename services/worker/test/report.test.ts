import { describe, expect, it } from "vitest";
import { buildReportViewModel, renderReportHtml } from "../src/pdf/report";

function expectInOrder(text: string, tokens: string[]) {
  let lastIndex = -1;
  for (const token of tokens) {
    const next = text.indexOf(token);
    expect(next).toBeGreaterThan(lastIndex);
    lastIndex = next;
  }
}

function buildInput(overrides?: Partial<Parameters<typeof buildReportViewModel>[0]>) {
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
      fileSha256: "abc",
      fingerprintCanonicalJson: "{\"a\":1}",
      fingerprintHash: "def",
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
          sha256: "abc",
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
        sha256: "abc",
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
  it("builds a view model with inventory and certification-aware sections", () => {
    const vm = buildReportViewModel(buildInput());

    expect(vm.title).toBe("Evidence Title");
    expect(vm.structureLabel).toBe("Single evidence item");
    expect(vm.inventoryRows).toHaveLength(1);
    expect(vm.contentItems[0]?.previewTextExcerpt).toBe("hello world");
    expect(vm.certifications.hasAny).toBe(false);
    expect(vm.forensicRows).toHaveLength(1);
  });

  it("renders the v2 HTML report sections in the intended order", () => {
    const vm = buildReportViewModel(buildInput());
    const html = renderReportHtml(vm);

    expect(html).toContain("Evidence Title");
    expect(html).toContain("Executive conclusion");
    expect(html).toContain("Evidence Inventory");
    expect(html).toContain("Integrity Proof");
    expect(html).toContain("Storage & Timestamping");
    expect(html).toContain("Forensic Integrity Statement");
    expect(html).toContain("Technical Appendix");

    expectInOrder(html, [
      "Executive conclusion",
      "Evidence Content",
      "Primary Evidence Review",
      "Evidence Inventory",
      "Integrity Proof",
      "Storage & Timestamping",
      "Chain of Custody",
      "Legal Limitations",
      "Forensic Integrity Statement",
      "Technical Appendix",
    ]);
  });
});
