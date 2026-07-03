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
import { applyFlowAwareCustodyWording } from "../src/report-v2/normalizers";
import { buildTimelineRows } from "../src/report-v2/custody-model";
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
    expect(html).toContain("Technical Summary");
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
    expect(html).toContain("Technical Summary");
    expect(html).not.toContain("Media Intelligence Observations");
  });
});

// =============================================================================
// Evidence Acquisition — compact table inside the Executive Summary
// =============================================================================

describe("Evidence Acquisition table (Executive Summary only)", () => {
  const SMS_ACQUISITION = {
    method: "Intake Link",
    deliveryChannel: "SMS",
    submissionType: "Remote Contributor",
    submissionStatus: ["Sent", "Delivered", "Opened", "Submitted"],
    identityVerification: "Anonymous",
    consentAccepted: true,
    consentVersion: "v3",
    submittedAtUtc: "2026-07-01T12:14:00.000Z",
    isIntake: true,
  };
  const WEB_ACQUISITION = {
    method: "Direct Upload",
    deliveryChannel: null,
    submissionType: "Authenticated User",
    submissionStatus: [],
    identityVerification: "Verified",
    consentAccepted: null,
    consentVersion: null,
    submittedAtUtc: null,
    isIntake: false,
  };

  it("renders a compact Evidence Acquisition table for an intake SMS", async () => {
    const vm = await buildReportViewModel(
      buildInput({ acquisition: SMS_ACQUISITION }),
    );
    const html = renderReportHtml(vm);
    expect(html).toContain("Evidence Acquisition");
    expect(html).toContain("Acquisition Method");
    expect(html).toContain("Intake Link");
    expect(html).toContain("Delivery Channel");
    expect(html).toContain("SMS");
    expect(html).toContain("Remote Contributor");
    expect(html).toContain("Accepted");
    // Role modeling: the workspace owner is NOT shown as the submitter.
    expect(html).toContain("Remote Contributor via Secure Intake Link");
    // PDF acquisition table is capped at ≤5 rows — Identity Verification +
    // Submission Time are package/internal only.
    expect(html).not.toContain("Identity Verification");
    expect(html).not.toContain("Submission Time");
    // NEVER a masked recipient, hash, or provider ID in the report.
    expect(html).not.toContain("•••");
    expect(html).not.toContain("sha256:");
    expect(html).not.toContain("hmac-sha256:");
    expect(html).not.toMatch(/\bSM[0-9a-f]{20,}/i);
  });

  it("omits the Evidence Acquisition table for a direct (non-intake) upload", async () => {
    const vm = await buildReportViewModel(buildInput({ acquisition: null }));
    const html = renderReportHtml(vm);
    expect(html).not.toContain("Evidence Acquisition");
  });

  it("report CSS protects metadata panels from splitting across pages", () => {
    const css = readFileSync(
      fileURLToPath(
        new URL("../src/report-v2/templates/report.css.ts", import.meta.url),
      ),
      "utf8",
    );
    // Acquisition/capture panels never split; the exec page may flow to a
    // second page instead of clipping under the fixed footer.
    expect(css).toContain(".evidence-acquisition-panel");
    expect(css).toMatch(/\.capture-context-panel[\s\S]{0,120}break-inside:\s*avoid/);
    expect(css).toMatch(
      /\.executive-summary-page[\s\S]{0,160}page-break-inside:\s*auto/,
    );
    // The Executive Summary map was reduced to fit one page.
    expect(css).toContain("height: 30mm");
  });

  it("does NOT render the acquisition table for a non-intake (web) context", async () => {
    const vm = await buildReportViewModel(
      buildInput({ acquisition: WEB_ACQUISITION }),
    );
    const html = renderReportHtml(vm);
    // The context is supplied (for the timestamp label) but the intake-only
    // table must not render.
    expect(html).not.toContain("Acquisition Method");
    expect(html).not.toContain("Delivery Channel");
    // Web capture keeps normal submitter modeling — not the intake role label.
    expect(html).not.toContain("Remote Contributor via Secure Intake Link");
  });

  it("shows a compact Capture Device mini-table (Exec Summary) for desktop no-EXIF, and no standalone page", async () => {
    const WEB_TECH_SUMMARY = {
      mediaFilesAnalyzed: 1,
      mediaFilesTotal: 1,
      metadataStatus: "Complete" as const,
      primaryMediaType: "Document",
      resolutionSummary: null,
      primaryMedia: null,
      exif: null,
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
      network: null,
    };
    const vm = await buildReportViewModel(
      buildInput({ technicalSummary: WEB_TECH_SUMMARY, acquisition: WEB_ACQUISITION }),
    );
    const html = renderReportHtml(vm);
    // ONE unified Executive Summary metadata grid (device + overview merged).
    expect(html).toContain("executive-unified-grid");
    // Device context appears (inside the unified grid), humanized. Web ingest
    // reads "PROOVRA Web Upload", not the misleading "Secure Browser Capture".
    expect(html).toContain("PROOVRA Web Application");
    expect(html).toContain("PROOVRA Web Upload");
    expect(html).not.toContain("Secure Browser Capture");
    // Evidence Overview fields live in the SAME grid — merged, not a second
    // key/value table.
    const gridStart = html.indexOf('class="executive-unified-grid"');
    expect(gridStart).toBeGreaterThan(-1);
    const gridSlice = html.slice(gridStart, gridStart + 4000);
    expect(gridSlice).toContain("Operating system"); // device field
    expect(gridSlice).toContain("Evidence Type"); // overview field
    // No wasteful standalone "Technical Summary" page section.
    expect(html).not.toContain("technical-summary-section");
    // Never says "intake" for web capture.
    expect(html.toLowerCase()).not.toContain("recorded at intake");
    // No duplicated broad rows.
    expect(html).not.toMatch(/Files analysed/i);
    expect(html).not.toContain("Mixed");
  });

  it("custody wording is flow-aware (Web Capture never says 'at intake')", () => {
    // Pure helper: non-intake rewrites intake wording; intake preserves it.
    expect(
      applyFlowAwareCustodyWording("Identity snapshot recorded at intake", false),
    ).toBe("Identity snapshot recorded at submission");
    expect(
      applyFlowAwareCustodyWording(
        "Mode: initial intake authorization for multipart evidence",
        false,
      ),
    ).toBe("Mode: initial upload authorization for multipart evidence");
    // Real intake keeps the correct intake wording.
    expect(
      applyFlowAwareCustodyWording("Identity snapshot recorded at intake", true),
    ).toBe("Identity snapshot recorded at intake");

    // buildTimelineRows applies it per flow (event types unchanged).
    const events = [
      {
        sequence: 1,
        atUtc: "2026-07-01T00:00:00Z",
        eventType: "IDENTITY_SNAPSHOT_RECORDED",
        payloadSummary: "Mode: initial intake authorization for multipart evidence",
        category: "forensic" as const,
      },
    ];
    const web = buildTimelineRows(events as never, false);
    expect(web[0]!.eventLabel).toBe("Identity snapshot recorded at submission");
    expect(web[0]!.summary).toContain("initial upload authorization");
    expect(web[0]!.summary).not.toContain("intake");
    // Intake identity-snapshot belongs to the link creator (owner), not the
    // contributor: it is relabeled and its owner-scoped summary is replaced
    // with role-safe text (presentation only; raw event/hash chain untouched).
    const intake = buildTimelineRows(events as never, true);
    expect(intake[0]!.eventLabel).toBe("Link creator identity recorded");
    expect(intake[0]!.summary).toContain("not independently verified");
  });

  it("intake evidence also uses the unified Executive Summary grid", async () => {
    const vm = await buildReportViewModel(
      buildInput({ acquisition: SMS_ACQUISITION }),
    );
    const html = renderReportHtml(vm);
    // Unified grid present; intake device rows suppressed (acquisition table
    // covers submission context) but Evidence Overview still merged in.
    expect(html).toContain("executive-unified-grid");
    const gridStart = html.indexOf('class="executive-unified-grid"');
    const gridSlice = html.slice(gridStart, gridStart + 4000);
    expect(gridSlice).toContain("Evidence Type");
  });

  it("intake report NEVER exposes the contributor email; Technical Appendix shows a role (Req 1/6)", async () => {
    const CONTRIB_EMAIL = "jane.contributor@example.com";
    const vm = await buildReportViewModel(
      buildInput({
        acquisition: SMS_ACQUISITION,
        evidence: {
          ...buildInput().evidence,
          submittedByEmail: CONTRIB_EMAIL,
          captureMethod: "EXTERNAL_INTAKE_UPLOAD",
        },
      }),
    );
    const html = renderReportHtml(vm);
    // The contributor email appears NOWHERE in the intake report.
    expect(html).not.toContain(CONTRIB_EMAIL);
    // Technical Appendix no longer uses the "Submitted By Email" label and
    // shows the role instead (Executive Summary + Appendix are consistent).
    expect(html).not.toContain("Submitted By Email");
    expect(html).toContain("Remote Contributor via Secure Intake Link");
    expect(html).toContain("Contributor Identity");
    // Capture Method is consistent everywhere (never "not recorded" for intake).
    expect(html).toContain("Secure Intake Link");
    expect(html).not.toContain("Capture method not recorded");
  });

  it("Web Capture STILL shows the authenticated uploader email (baseline unchanged)", async () => {
    const OWNER_EMAIL = "owner@acme-legal.example";
    const vm = await buildReportViewModel(
      buildInput({
        acquisition: WEB_ACQUISITION,
        evidence: {
          ...buildInput().evidence,
          submittedByEmail: OWNER_EMAIL,
          captureMethod: "SECURE_CAMERA",
        },
      }),
    );
    const html = renderReportHtml(vm);
    // Non-intake keeps the "Submitted By Email" label + the uploader email.
    expect(html).toContain("Submitted By Email");
    expect(html).toContain(OWNER_EMAIL);
    // Intake role wording never leaks into a Web Capture report.
    expect(html).not.toContain("Remote Contributor via Secure Intake Link");
    expect(html).not.toContain("Secure Intake Link");
  });

  it("Intake with REAL data shapes: role-safe custody + appendix + no standalone Technical Summary (issues #1/#2/#3)", async () => {
    // Reproduce the ground-truth intake shapes the previous harness missed:
    // captureMethod overwritten to MULTIPART_PACKAGE, a custody identity
    // snapshot carrying the OWNER email/provider, owner user refs, EXIF present
    // but NO capture environment recorded.
    const OWNER = "jalal.attar@proovra.com";
    const vm = await buildReportViewModel(
      buildInput({
        acquisition: SMS_ACQUISITION,
        evidence: {
          ...buildInput().evidence,
          submittedByEmail: OWNER,
          submittedByAuthProvider: "google",
          submittedByUserId: null,
          createdByUserId: "owner-user-11223344",
          uploadedByUserId: "owner-user-11223344",
          captureMethod: "MULTIPART_PACKAGE",
          identityLevelSnapshot: "BASIC_ACCOUNT",
        },
        custodyEvents: [
          { sequence: 1, atUtc: "2026-07-01T00:00:00Z", eventType: "EVIDENCE_CREATED", payloadSummary: "Evidence record created." },
          {
            sequence: 2,
            atUtc: "2026-07-01T00:00:05Z",
            eventType: "IDENTITY_SNAPSHOT_RECORDED",
            payloadSummary: `Identity snapshot recorded • Identity: Basic account • Email: ${OWNER} • Provider: Google`,
          },
        ],
        technicalSummary: {
          ...TECH_SUMMARY,
          captureEnvironment: null, // no capture environment → camera-only
        },
      }),
    );
    const html = renderReportHtml(vm);

    // #1 Custody: owner email gone; not "at intake"; role-safe wording.
    expect(html).not.toContain(OWNER);
    expect(html).not.toContain("Identity snapshot recorded at intake");
    expect(html).toContain("Link creator identity recorded");
    expect(html).toContain("not independently verified");

    // #2 Appendix: capture method is the flow label, never the raw multipart
    // enum; owner-scoped provider/submitter refs are not shown as contributor.
    expect(html).toContain("Secure Intake Link");
    expect(html).not.toContain("Multipart package");
    // Web Capture's acquisition label must never leak into an intake report.
    expect(html).not.toContain("PROOVRA Web Upload");
    expect(html).not.toContain("Submitted By Provider");
    expect(html).toContain("Link Creator User Ref");
    expect(html).toContain("Requester Identity");

    // #3 No standalone Technical Summary page (camera-only) — it moves to the
    // Technical Appendix as a compact block.
    expect(html).not.toContain("technical-summary-section");
    expect(html).toContain("Capture Device &amp; Camera Metadata");
  });

  it("Intake Technical Appendix: Contributor Identity is 'Not independently verified' even when the requester is verified; requester shown separately (Problem 1)", async () => {
    const vm = await buildReportViewModel(
      buildInput({
        // Requester-derived identityVerification is "Verified" — it must NOT be
        // shown as the contributor's identity (that contradicted custody).
        acquisition: { ...SMS_ACQUISITION, identityVerification: "Verified" },
        evidence: {
          ...buildInput().evidence,
          captureMethod: "MULTIPART_PACKAGE",
          identityLevelSnapshot: "VERIFIED_EMAIL", // requester/owner is verified
          submittedByEmail: "jalal.attar@proovra.com",
        },
      }),
    );
    const html = renderReportHtml(vm);
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    // Contributor Identity agrees with the Chain of Custody.
    expect(text).toMatch(/Contributor Identity\s+Not independently verified/);
    expect(text).not.toMatch(/Contributor Identity\s+Verified\b/);
    // The requester's verification is shown separately.
    expect(text).toMatch(/Requester Identity\s+Verified email/);
  });

  it("Web Capture: Capture Method reads 'PROOVRA Web Upload' in Exec Summary AND Technical Appendix; structure label unchanged", async () => {
    const vm = await buildReportViewModel(
      buildInput({
        acquisition: WEB_ACQUISITION,
        // Multi-file web upload — the persisted capture method is the STRUCTURE
        // enum MULTIPART_PACKAGE, which must NOT surface as the acquisition
        // "Capture Method" label.
        evidence: { ...buildInput().evidence, captureMethod: "MULTIPART_PACKAGE" },
        technicalSummary: TECH_SUMMARY, // WEB_APP capture environment → device rows
      }),
    );
    const html = renderReportHtml(vm);
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    // Rich device context → standalone Technical Summary page remains.
    expect(html).toContain("technical-summary-section");
    // Capture Method is the acquisition label EVERYWHERE it appears — never the
    // structure enum "Multipart package" (proven distinct in the generated
    // package/PDF: the structure label "Multipart evidence package" is retained
    // there while the capture method reads "PROOVRA Web Upload").
    expect(text).toMatch(/Capture method\s+PROOVRA Web Upload/i); // Technical Summary
    expect(text).toMatch(/Capture Method\s+PROOVRA Web Upload/); // Technical Appendix
    expect(text).not.toMatch(/Capture Method\s+Multipart package/i);
    // Intake labels never leak into a Web Capture report.
    expect(html).not.toContain("Secure Intake Link");
    expect(html).not.toContain("Link creator identity recorded");
  });

  describe("Executive Summary LEAD ITEM — always ONE canonical lead item", () => {
    function multipartInput(primaryCount: number, opts?: { anyPrimary?: boolean }) {
      const base = buildInput();
      const proto = base.evidence.contentItems[0];
      const total = Math.max(primaryCount, opts?.anyPrimary === false ? 2 : primaryCount);
      const items = Array.from({ length: total }, (_, i) => ({
        ...proto,
        id: `item-${i}`,
        index: i,
        originalFileName: `primary-${i}.jpg`,
        label: `Item ${i}`,
        kind: "image",
        artifactRole:
          opts?.anyPrimary === false
            ? "supporting_evidence"
            : i < primaryCount
              ? "primary_evidence"
              : "supporting_evidence",
      }));
      const firstPrimary =
        opts?.anyPrimary === false ? null : items.find((x) => x.artifactRole === "primary_evidence") ?? null;
      return buildInput({
        evidence: {
          ...base.evidence,
          contentItems: items,
          primaryContentItem: firstPrimary,
          contentSummary: {
            ...base.evidence.contentSummary,
            structure: "multipart",
            itemCount: total,
            imageCount: total,
            textCount: 0,
            primaryKind: "image",
          },
        },
      });
    }
    function leadItemValue(html: string): string {
      const m = html.match(
        /kv-label">Lead Item<\/div>\s*<div class="kv-value">([\s\S]*?)<\/div>/,
      );
      return m ? m[1] : "(lead item not found)";
    }

    it("A. multipart with 2 primary items → LEAD ITEM shows only the first filename (never the second); gallery keeps both", async () => {
      const html = renderReportHtml(await buildReportViewModel(multipartInput(2)));
      const lead = leadItemValue(html);
      expect(lead).toContain("primary-0.jpg");
      expect(lead).not.toContain("primary-1.jpg");
      expect(lead).toContain("Primary evidence set: 2 items");
      // The second primary filename is NOT removed from the report — it still
      // appears elsewhere (gallery / inventory), just not in the LEAD ITEM.
      expect(html).toContain("primary-1.jpg");
    });

    it("B. multipart with 1 primary item → LEAD ITEM shows that one item", async () => {
      const lead = leadItemValue(
        renderReportHtml(await buildReportViewModel(multipartInput(1))),
      );
      expect(lead).toContain("primary-0.jpg");
      expect(lead).not.toContain("Primary evidence set:");
    });

    it("C. multipart with NO explicit primary → falls back to lead/default item, single value", async () => {
      const lead = leadItemValue(
        renderReportHtml(
          await buildReportViewModel(multipartInput(0, { anyPrimary: false })),
        ),
      );
      expect(lead).not.toContain("Primary evidence set:");
      expect(lead.length).toBeGreaterThan(0);
    });
  });

  it("report CSS gives the unified grid accent labels + break protection", () => {
    const css = readFileSync(
      fileURLToPath(
        new URL("../src/report-v2/templates/report.css.ts", import.meta.url),
      ),
      "utf8",
    );
    expect(css).toMatch(
      /\.executive-unified-grid[\s\S]{0,120}break-inside:\s*avoid/,
    );
    expect(css).toMatch(
      /\.executive-unified-grid \.kv-label[\s\S]{0,60}color:/,
    );
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
