import { describe, expect, it } from "vitest";
import { buildReportViewModel, renderReportHtml } from "../src/report-v2";
import type { ReportV2Input } from "../src/report-v2";
import {
  PROOVRA_FORBIDDEN_SURFACE_PATTERNS,
  PROOVRA_MULTIPART_LEGAL_BOUNDARY_NOTE,
  PROOVRA_MULTIPART_RECOMPUTATION_NOTE,
  PROOVRA_MULTIPART_REVIEWER_EXPLANATION,
} from "@proovra/shared-evidence-presentation";

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
    // Phase 31.7 — bucket-layer model: primaryPreviewItems is always [],
    // supportingPreviewItems carries every item with a renderable
    // preview (role distinction lives in gallery rendering, not the
    // bucket layer). The default single-item input has one previewable
    // text item, so supportingPreviewItems is length 1.
    expect(vm.presentation.buckets.primaryPreviewItems).toHaveLength(0);
    expect(vm.presentation.buckets.supportingPreviewItems).toHaveLength(1);
  });

  it("renders the v2 HTML report sections in the intended order", async () => {
    const vm = await buildReportViewModel(buildInput());
    const html = renderReportHtml(vm);
    const coverStart = html.indexOf('<section class="report-cover');
    const coverEnd = html.indexOf("</section>", coverStart);
    const coverHtml =
      coverStart >= 0 && coverEnd > coverStart
        ? html.slice(coverStart, coverEnd)
        : html;

    expect(html).toContain("Evidence Title");
    // Phase D Blocker 4 — assert the truthful intent of this test against
    // the current legally-safer report structure. Section titles were
    // tightened during the Phase A/B/C wording sweep:
    //   "Integrity Proof" → "Integrity Control Checklist"
    //   "Legal Interpretation & Review Use" → "Legal Interpretation & Report Boundary"
    //   "Evidence Presentation" → broken into "Primary Evidence" / "Supporting Evidence Gallery"
    //   "Storage, Timestamping & Publication" → folded into the Technical Appendix
    // The intent — that each forensic section exists in the correct order
    // — is what this test protects.
    expect(html).toContain("Executive Summary");
    expect(html).toContain("executive-conclusion-card");
    // Redundant presentation removed (PDF cleanup): the Integrity Control
    // Checklist page, the "What this report confirms" card, and the
    // "Decision basis" card no longer render. Their underlying data remains
    // in Trust Signal Analysis, the Technical Appendix, and Chain of Custody.
    expect(html).not.toContain("Integrity Control Checklist");
    expect(html).not.toContain("What this report confirms");
    expect(html).not.toContain("Decision basis");
    // Kept surfaces that carry the same information.
    expect(html).toContain("Trust Signal Analysis");
    expect(html).toContain("Important boundary");
    expect(html).toContain("Chain of Custody");
    expect(html).toContain("Legal Interpretation");
    expect(html).toContain("Technical Appendix");
    // Phase 31.7 — cover boundary copy was tightened to safer wording
    // ("does not independently prove truth, authorship, context, intent,
    // admissibility, or evidentiary weight"). The intent — that the
    // cover advises the reader about the report's scope — is what this
    // assertion protects.
    // Phase 4 — cover boundary text now comes from the canonical
    // legal-boundary helper (packages/shared/src/canonical-evidence-materials.ts).
    // The canonical wording says "does not independently prove factual
    // truth" which is strictly more precise than the prior "truth".
    expect(coverHtml).toContain("does not independently prove factual truth");
    expect(coverHtml).not.toContain("court acceptance");
    expect(coverHtml).not.toContain("examiner-grade forensic acquisition");
    expect(html).not.toContain("Evidence Manifest");
    expect(html).not.toContain("Evidence Package Structure");
    // Defensive: no overclaim wording survived the sweep.
    expect(html).not.toContain("guarantees admissibility");
    expect(html).not.toContain("proves authorship");

    expectInOrder(html, [
      "Executive Summary",
      "executive-conclusion-card",
      "Trust Signal Analysis",
      "Chain of Custody",
      "Legal Interpretation",
      "Technical Appendix",
    ]);
  });

  it("treats txid-only anchor metadata as anchored in report-v2", async () => {
    const input = buildInput({
      evidence: {
        ...buildInput().evidence,
        anchorTransactionId:
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        anchorAnchoredAtUtc: null,
        otsStatus: "ANCHORED",
      },
    });

    const vm = await buildReportViewModel(input);

    expect(vm.anchorSummary).not.toBeNull();
    expect(vm.anchorSummary?.mode).toBe("anchored");
    expect(vm.anchorSummary?.transactionId).toBe(
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    );
    const html = renderReportHtml(vm);
    expect(html).toContain("Anchor Transaction ID");
    expect(html).toContain(
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    );
    expect(html.toLowerCase()).not.toContain("public anchoring");
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

    // Phase D Blocker 4 — assert the truthful intent of this test:
    // supporting previewable evidence MUST still be visually represented in
    // the rendered HTML. The heading wording was tightened from the
    // legacy "Supporting preview items" string to the more precise
    // "Supporting Evidence Gallery" / "Supporting evidence gallery"
    // (the legally cautious "Supporting previews are reviewer-facing
    // representations only..." callout body lives inline). The structural
    // requirement — that the supporting items render — is what this test
    // protects, not the exact pre-Phase-A heading text.
    // Phase 31.7 — bucket layer is role-agnostic: every item with a
    // renderable preview lands in supportingPreviewItems regardless of
    // artifactRole. Here the lead photo + 2 supporting items all have
    // preview content → length 3.
    expect(vm.presentation.buckets.supportingPreviewItems).toHaveLength(3);
    // Phase 31.7 — heading copy tightened from
    // "Supporting Evidence Gallery" → "Evidence Gallery" (role
    // distinction now lives in callout text + per-item badges, not
    // the section heading).
    expect(html).toContain("Evidence Gallery");
    // The Integrity Control Checklist page (which carried the
    // "reviewer-facing checklist" disclaimer) was removed as redundant
    // presentation. The same reviewer-boundary intent — that the report's
    // previews and checks are reviewer-facing aids, not substitutes for
    // the preserved original — remains in the Important boundary / Legal
    // Interpretation sections.
    expect(html).toContain("Important boundary");
    expect(html).toContain("supporting.pdf");
    expect(html).toContain("note.txt");
    expect(html).toContain(FULL_HASH_A);
    expect(html).toContain(FULL_HASH_B);
    expect(html).toContain(FULL_HASH_C);
    expect(html).not.toContain(`${FULL_HASH_A.slice(0, 8)}…`);
    expect(html).not.toContain(`${FULL_HASH_B.slice(0, 8)}...`);
    // Phase D Blocker 4 — also assert the report does not overclaim.
    // These should NEVER appear in a generated report.
    expect(html).not.toContain("guarantees admissibility");
    expect(html).not.toContain("proves authorship");
    expect(html).not.toContain("Strongly verified");
    expect(html).not.toContain("Strong recorded integrity");
    expect(html).toContain(PROOVRA_MULTIPART_REVIEWER_EXPLANATION);
    expect(html).toContain(PROOVRA_MULTIPART_RECOMPUTATION_NOTE);
    expect(html).toContain(PROOVRA_MULTIPART_LEGAL_BOUNDARY_NOTE);
    for (const pattern of PROOVRA_FORBIDDEN_SURFACE_PATTERNS) {
      expect(html).not.toMatch(pattern);
    }
  });

  it("honors explicit primary/supporting roles instead of collapsing to a single inferred lead item", async () => {
    const vm = await buildReportViewModel(
      buildInput({
        evidence: {
          ...buildInput().evidence,
          contentSummary: {
            ...buildInput().evidence.contentSummary!,
            structure: "multipart",
            itemCount: 4,
            previewableItemCount: 4,
            downloadableItemCount: 4,
            imageCount: 2,
            pdfCount: 1,
            textCount: 1,
            totalSizeBytes: "8192",
            totalSizeDisplay: "8 KB",
          },
          contentItems: [
            {
              ...buildInput().evidence.contentItems![0]!,
              id: "primary-1",
              index: 0,
              label: "Primary contract",
              originalFileName: "contract.pdf",
              mimeType: "application/pdf",
              kind: "pdf",
              previewDataUrl: TINY_PNG_DATA_URL,
              previewTextExcerpt: null,
              artifactRole: "primary_evidence",
              artifactRoleSource: "private_role",
              checklistStepId: "primary_media",
              checklistStepLabel: "Primary evidence",
            },
            {
              ...buildInput().evidence.contentItems![0]!,
              id: "primary-2",
              index: 1,
              label: "Primary photo",
              originalFileName: "photo.jpg",
              mimeType: "image/jpeg",
              kind: "image",
              previewDataUrl: TINY_PNG_DATA_URL,
              previewTextExcerpt: null,
              artifactRole: "primary_evidence",
              artifactRoleSource: "checklist_step",
              checklistStepId: "primary_media",
              checklistStepLabel: "Primary evidence",
            },
            {
              ...buildInput().evidence.contentItems![0]!,
              id: "supporting-1",
              index: 2,
              label: "Supporting note",
              originalFileName: "note.txt",
              kind: "text",
              mimeType: "text/plain",
              previewDataUrl: null,
              previewTextExcerpt: "supporting note",
              isPrimary: false,
              artifactRole: "supporting_evidence",
              artifactRoleSource: "private_role",
              checklistStepId: "supporting_context",
              checklistStepLabel: "Supporting context",
            },
            {
              ...buildInput().evidence.contentItems![0]!,
              id: "supporting-2",
              index: 3,
              label: "Supporting receipt",
              originalFileName: "receipt.pdf",
              kind: "pdf",
              mimeType: "application/pdf",
              previewDataUrl: TINY_PNG_DATA_URL,
              previewTextExcerpt: null,
              isPrimary: false,
              artifactRole: "supporting_evidence",
              artifactRoleSource: "checklist_step",
              checklistStepId: "supporting_context",
              checklistStepLabel: "Supporting context",
            },
          ],
          primaryContentItem: {
            ...buildInput().evidence.primaryContentItem!,
            id: "primary-1",
            label: "Primary contract",
            originalFileName: "contract.pdf",
            kind: "pdf",
            mimeType: "application/pdf",
            previewDataUrl: TINY_PNG_DATA_URL,
            previewTextExcerpt: null,
            artifactRole: "primary_evidence",
            artifactRoleSource: "private_role",
            checklistStepId: "primary_media",
            checklistStepLabel: "Primary evidence",
          },
          embeddedPreviewsSnapshot: [
            { id: "primary-1", previewDataUrl: TINY_PNG_DATA_URL },
            { id: "primary-2", previewDataUrl: TINY_PNG_DATA_URL },
            { id: "supporting-1", previewTextExcerpt: "supporting note" },
            { id: "supporting-2", previewDataUrl: TINY_PNG_DATA_URL },
          ],
        },
      })
    );

    const html = renderReportHtml(vm);

    // Phase 31.7 — bucket layer flattens role distinctions: all 4
    // previewable items live in supportingPreviewItems. The view model
    // still tracks the role for downstream rendering — verified by the
    // "Primary Evidence Set" executive row assertion below. The
    // primaryPreviewItems bucket is always [] in the current model.
    expect(vm.presentation.buckets.primaryPreviewItems).toHaveLength(0);
    expect(vm.presentation.buckets.supportingPreviewItems).toHaveLength(4);
    expect(
      vm.presentation.buckets.supportingPreviewItems.filter(
        (item) => item.asset.artifactRole === "primary_evidence",
      ),
    ).toHaveLength(2);
    expect(
      vm.presentation.buckets.supportingPreviewItems.filter(
        (item) => item.asset.artifactRole === "supporting_evidence",
      ),
    ).toHaveLength(2);
    expect(vm.executiveRows.some((row) => row.label === "Primary Evidence Set")).toBe(true);
    expect(html).toContain("Primary Evidence Set");
    expect(html).toContain("contract.pdf");
    expect(html).toContain("photo.jpg");
    // Phase 31.7 — heading copy tightened from
    // "Supporting Evidence Gallery" → "Evidence Gallery" (role
    // distinction now lives in callout text + per-item badges, not
    // the section heading).
    expect(html).toContain("Evidence Gallery");
    expect(html).toContain("note.txt");
    expect(html).toContain("receipt.pdf");
  });

  it("keeps the cover boundary note compact while preserving the full legal boundary later", async () => {
    const vm = await buildReportViewModel(
      buildInput({
        evidence: {
          ...buildInput().evidence,
          id: "9732eb48-15ba-4727-bf70-8f25ecfea76d-with-a-long-suffix-for-layout",
          contentSummary: {
            ...buildInput().evidence.contentSummary!,
            structure: "multipart",
            itemCount: 15,
            previewableItemCount: 5,
            downloadableItemCount: 15,
            imageCount: 4,
            videoCount: 3,
            audioCount: 2,
            pdfCount: 3,
            textCount: 2,
            otherCount: 1,
            totalSizeBytes: "49240000",
            totalSizeDisplay: "49.24 MB",
          },
          contentItems: Array.from({ length: 15 }, (_, index) => ({
            ...buildInput().evidence.contentItems![0]!,
            id: `item-${index + 1}`,
            index,
            isPrimary: index === 0,
            artifactRole: index === 0 ? "primary_evidence" : "supporting_evidence",
            originalFileName:
              index === 0
                ? "lead-item-with-a-very-long-filename-that-should-still-fit-cleanly-on-page-one-and-not-push-the-footer.pdf"
                : `supporting-item-${index + 1}.txt`,
            label:
              index === 0
                ? "Lead item with an intentionally long reviewer-facing filename"
                : `Supporting item ${index + 1}`,
            kind: index === 0 ? "pdf" : "text",
            mimeType: index === 0 ? "application/pdf" : "text/plain",
            displaySizeLabel: index === 0 ? "12 MB" : "1 KB",
            previewTextExcerpt: index === 0 ? null : `supporting excerpt ${index + 1}`,
            previewDataUrl: index === 0 ? TINY_PNG_DATA_URL : null,
            sha256: FULL_HASH_A,
          })),
          primaryContentItem: {
            ...buildInput().evidence.primaryContentItem!,
            kind: "pdf",
            mimeType: "application/pdf",
            originalFileName:
              "lead-item-with-a-very-long-filename-that-should-still-fit-cleanly-on-page-one-and-not-push-the-footer.pdf",
            label: "Lead item with an intentionally long reviewer-facing filename",
            displaySizeLabel: "12 MB",
            previewDataUrl: TINY_PNG_DATA_URL,
            previewTextExcerpt: null,
            sha256: FULL_HASH_A,
          },
        },
      })
    );
    const html = renderReportHtml(vm);
    const coverStart = html.indexOf('<section class="report-cover');
    const coverEnd = html.indexOf("</section>", coverStart);
    const coverHtml =
      coverStart >= 0 && coverEnd > coverStart
        ? html.slice(coverStart, coverEnd)
        : html;

    expect(coverHtml).toContain("Report Boundary.");
    // Phase 31.7 — cover boundary copy was tightened to safer wording
    // ("does not independently prove truth, authorship, context, intent,
    // admissibility, or evidentiary weight"). The intent — that the
    // cover advises the reader about the report's scope — is what this
    // assertion protects.
    // Phase 4 — cover boundary text now comes from the canonical
    // legal-boundary helper (packages/shared/src/canonical-evidence-materials.ts).
    // The canonical wording says "does not independently prove factual
    // truth" which is strictly more precise than the prior "truth".
    expect(coverHtml).toContain("does not independently prove factual truth");
    expect(coverHtml).not.toContain("court acceptance");
    expect(coverHtml).not.toContain("examiner-grade forensic acquisition");
    expect(html).toContain("Legal and evidentiary boundary");
    expect(html).toContain("This report does not prove");
  });
});
