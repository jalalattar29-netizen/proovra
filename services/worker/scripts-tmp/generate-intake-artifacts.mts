/**
 * TEMPORARY generation harness (Intake channel scope + verify role label).
 * Drives the REAL production functions for 4 scenarios and writes artifacts to
 * tmp-artifacts/ for manual inspection:
 *   - Web Capture   (non-intake baseline — must be unchanged)
 *   - Intake SMS
 *   - Intake Email
 *   - Public Secure Link (reusable, no messaging)
 *
 * Uses the REAL acquisition mapper (buildEvidenceAcquisitionContext) so the
 * PDF/package reflect the actual Public-Secure-Link / no-QR / never-Unknown
 * behaviour. NOT a unit test — produces the actual artifacts to inspect.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  buildReportViewModel,
  renderReportHtml,
  renderPdfFromHtml,
  type ReportV2Input,
} from "../src/report-v2/index.js";
import { buildTechnicalMetadataPackageFiles } from "../src/verification-package-technical-metadata.js";
import {
  buildEvidenceAcquisitionContext,
  toPublicAcquisition,
  type AcquisitionRawInput,
} from "@proovra/shared-runtime/technical-metadata";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "../../../tmp-artifacts");
mkdirSync(OUT, { recursive: true });

const FULL_HASH_A = "a".repeat(64);
const FULL_HASH_B = "b".repeat(64);

const TM_IMAGE = {
  schemaVersion: 1, mediaKind: "IMAGE", mimeType: "image/jpeg", parseResult: "OK",
  metadataStatus: "PRESENT", parserName: "exifr", parserVersion: "7.1.3",
  widthPx: 4032, heightPx: 3024, exifPresent: true, cameraMake: "Apple",
  cameraModel: "iPhone 14 Pro", originalCaptureTime: "2026-06-30T09:58:11Z",
  iso: 80, aperture: "f/1.8", exposureTime: "1/120s", orientation: 1, gpsPresent: true,
};

const INTAKE_CAPTURE_ENV = {
  uploadSource: "INTAKE_LINK", captureMethod: "EXTERNAL_INTAKE_UPLOAD",
  browserName: "Safari", browserVersion: "17.5", osName: "iOS", osVersion: "17.5",
  deviceClass: "MOBILE", engine: "WebKit", platform: "iPhone", timezone: "Europe/Berlin",
  locale: "de-DE", userAgentHash: "sha256:deadbeefcafe", ipAddressMasked: "203.0.113.x",
  country: "DE", region: null, networkType: null, attestationAttempted: false, attestationResult: null,
};
const WEB_CAPTURE_ENV = {
  ...INTAKE_CAPTURE_ENV, uploadSource: "WEB_APP", captureMethod: "SECURE_CAPTURE",
  browserName: "Chrome", browserVersion: "138", osName: "Windows", deviceClass: "DESKTOP",
  engine: "Blink", platform: "Windows x64", timezone: "Europe/London", locale: "en-GB",
};

const TECH_SUMMARY = {
  mediaFilesAnalyzed: 1, mediaFilesTotal: 1, metadataStatus: "Complete" as const,
  primaryMediaType: "Image", resolutionSummary: "4032×3024",
  primaryMedia: { mediaKind: "IMAGE", durationMs: null, videoCodec: null, frameRate: null, pageCount: null },
  exif: {
    exifPresent: true, camera: "Apple iPhone 14 Pro", cameraMake: "Apple", cameraModel: "iPhone 14 Pro",
    lensModel: null, originalCaptureTime: "2026-06-30T09:58:11Z", iso: 80, aperture: "f/1.8",
    exposureTime: "1/120s", shutterSpeed: null, whiteBalance: null, orientation: 1, gpsPresent: true,
    resolution: "4032×3024", softwareTag: null, metadataStatus: "PRESENT" as const,
  },
  network: { maskedIp: "203.0.113.x", country: "DE", region: null, networkType: null },
};

type Scenario = {
  key: string;
  isIntake: boolean;
  contributorEmail: string;
  raw: AcquisitionRawInput;
  acqRow: Record<string, unknown>;
  captureEnv: Record<string, unknown>;
  evidenceCaptureMethod: string;
};

const SCENARIOS: Scenario[] = [
  {
    key: "web", isIntake: false, contributorEmail: "owner@acme-legal.example",
    evidenceCaptureMethod: "SECURE_CAMERA", captureEnv: WEB_CAPTURE_ENV,
    raw: { uploadSource: "WEB_APP", captureMethod: "SECURE_CAPTURE", identityLevel: "VERIFIED_EMAIL" },
    acqRow: { capture_method: "UPLOADED_FILE" },
  },
  {
    key: "sms", isIntake: true, contributorEmail: "jane.contributor@gmail.com",
    evidenceCaptureMethod: "EXTERNAL_INTAKE_UPLOAD", captureEnv: INTAKE_CAPTURE_ENV,
    raw: {
      uploadSource: "INTAKE_LINK", captureMethod: "EXTERNAL_INTAKE_UPLOAD", intakeMode: "EXTERNAL_ONE_TIME",
      identityLevel: "BASIC_ACCOUNT", deliveryChannelRaw: "SMS", deliveryStatusRaw: "DELIVERED",
      sentAtUtc: "2026-06-30T10:00:00.000Z", deliveredAtUtc: "2026-06-30T10:00:05.000Z",
      openedAtUtc: "2026-06-30T10:03:00.000Z", submittedAtUtc: "2026-06-30T10:04:00.000Z",
      consentAcceptedAtUtc: "2026-06-30T10:02:30.000Z", consentVersion: "v3",
      recipientMasked: "+49 ••• ••• 1234", recipientHash: "9f2c1e77deadbeef", recipientType: "phone",
    },
    acqRow: {
      capture_method: "EXTERNAL_INTAKE_UPLOAD", identity_level: "BASIC_ACCOUNT",
      opened_at_utc: "2026-06-30T10:03:00.000Z", submitted_at_utc: "2026-06-30T10:04:00.000Z",
      consent_accepted_at_utc: "2026-06-30T10:02:30.000Z", consent_snapshot_json: { policyVersion: "v3" },
      submitter_email: "jane.contributor@gmail.com", intake_mode: "EXTERNAL_ONE_TIME",
      consent_policy_version: "v3", recipient_email: null, recipient_preview: "+49 ••• ••• 1234",
      recipient_hash: "9f2c1e77deadbeef", channel: "SMS", delivery_status: "DELIVERED",
      sent_at_utc: "2026-06-30T10:00:00.000Z", delivered_at_utc: "2026-06-30T10:00:05.000Z",
    },
  },
  {
    key: "email", isIntake: true, contributorEmail: "witness@protonmail.com",
    evidenceCaptureMethod: "EXTERNAL_INTAKE_UPLOAD", captureEnv: INTAKE_CAPTURE_ENV,
    raw: {
      uploadSource: "INTAKE_LINK", captureMethod: "EXTERNAL_INTAKE_UPLOAD", intakeMode: "EXTERNAL_ONE_TIME",
      identityLevel: "BASIC_ACCOUNT", deliveryChannelRaw: "EMAIL", deliveryStatusRaw: "SENT",
      sentAtUtc: "2026-06-30T10:00:00.000Z", submittedAtUtc: "2026-06-30T10:04:00.000Z",
      consentAcceptedAtUtc: "2026-06-30T10:02:30.000Z", consentVersion: "v3",
      recipientMasked: "wi***@protonmail.com", recipientHash: "aa11bb22", recipientType: "email",
    },
    acqRow: {
      capture_method: "EXTERNAL_INTAKE_UPLOAD", identity_level: "BASIC_ACCOUNT",
      submitted_at_utc: "2026-06-30T10:04:00.000Z", consent_accepted_at_utc: "2026-06-30T10:02:30.000Z",
      consent_snapshot_json: { policyVersion: "v3" }, submitter_email: "witness@protonmail.com",
      intake_mode: "EXTERNAL_ONE_TIME", consent_policy_version: "v3",
      recipient_email: "witness@protonmail.com", recipient_preview: null, recipient_hash: "aa11bb22",
      channel: "EMAIL", delivery_status: "SENT", sent_at_utc: "2026-06-30T10:00:00.000Z",
    },
  },
  {
    key: "psl", isIntake: true, contributorEmail: "anon.tipster@gmail.com",
    evidenceCaptureMethod: "EXTERNAL_INTAKE_UPLOAD", captureEnv: INTAKE_CAPTURE_ENV,
    raw: {
      uploadSource: "INTAKE_LINK", captureMethod: "EXTERNAL_INTAKE_UPLOAD", intakeMode: "EXTERNAL_REUSABLE",
      identityLevel: "BASIC_ACCOUNT", submittedAtUtc: "2026-06-30T10:04:00.000Z",
      consentAcceptedAtUtc: "2026-06-30T10:02:30.000Z", consentVersion: "v3",
    },
    acqRow: {
      capture_method: "EXTERNAL_INTAKE_UPLOAD", identity_level: "BASIC_ACCOUNT",
      submitted_at_utc: "2026-06-30T10:04:00.000Z", consent_accepted_at_utc: "2026-06-30T10:02:30.000Z",
      consent_snapshot_json: { policyVersion: "v3" }, submitter_email: null,
      intake_mode: "EXTERNAL_REUSABLE", consent_policy_version: "v3", recipient_email: null,
      recipient_preview: null, recipient_hash: null, channel: null, delivery_status: null,
    },
  },
];

function baseEvidence(s: Scenario) {
  return {
    tsaProvider: "freetsa.org", tsaUrl: "https://freetsa.org/tsr", tsaSerialNumber: "0x1A2B",
    tsaGenTimeUtc: "2026-06-30T10:05:03.000Z", tsaTokenBase64: "dGVzdA==", tsaMessageImprint: FULL_HASH_A,
    tsaHashAlgorithm: "SHA-256", tsaStatus: "VERIFIED", tsaFailureReason: null,
    id: "ev-" + s.key + "-001", title: "Roadside incident photo", status: "SIGNED",
    verificationStatus: "RECORDED_INTEGRITY_VERIFIED", capturedAtUtc: "2026-06-30T10:05:00.000Z",
    uploadedAtUtc: "2026-06-30T10:04:00.000Z", signedAtUtc: "2026-06-30T10:05:02.000Z",
    reportGeneratedAtUtc: "2026-06-30T10:06:00.000Z", mimeType: "image/jpeg", sizeBytes: "2508112",
    durationSec: null, storageBucket: "proovra-audit-bucket", storageKey: "evidence/x/original",
    publicUrl: null, gps: { lat: null, lng: null, accuracyMeters: null }, fileSha256: FULL_HASH_A,
    fingerprintCanonicalJson: '{"a":1}', fingerprintHash: FULL_HASH_B, signatureBase64: "sig",
    signingKeyId: "proovra_ed25519", signingKeyVersion: 1,
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\nTEST\n-----END PUBLIC KEY-----\n",
    submittedByEmail: s.contributorEmail, submittedByAuthProvider: "google",
    submittedByUserId: "contrib-user-99887766", createdByUserId: "owner-user-11223344",
    uploadedByUserId: "owner-user-11223344", lastAccessedByUserId: null, lastAccessedAtUtc: null,
    captureMethod: s.evidenceCaptureMethod,
    identityLevelSnapshot: s.isIntake ? "BASIC_ACCOUNT" : "VERIFIED_EMAIL",
    workspaceNameSnapshot: "Acme Legal Workspace", organizationNameSnapshot: "Acme Legal LLP",
    organizationVerifiedSnapshot: false, verificationPackageVersion: 2, reviewerSummaryVersion: 1,
    lastVerifiedSource: "SCHEDULED", otsStatus: "PENDING", otsFailureReason: null, otsBitcoinTxid: null,
    otsAnchoredAtUtc: null, tsaInputKind: "FILE_SHA256",
    contentSummary: {
      structure: "single", itemCount: 1, previewableItemCount: 1, downloadableItemCount: 1,
      imageCount: 1, videoCount: 0, audioCount: 0, pdfCount: 0, textCount: 0, otherCount: 0,
      primaryKind: "image", primaryMimeType: "image/jpeg", totalSizeBytes: "2508112", totalSizeDisplay: "2.4 MB",
    },
    contentItems: [{
      id: "ev-" + s.key + "-001", index: 0, label: "Primary evidence", originalFileName: "IMG_4821.jpg",
      mimeType: "image/jpeg", kind: "image", sizeBytes: "2508112", durationMs: null, sha256: FULL_HASH_A,
      isPrimary: true, previewable: true, downloadable: true, viewUrl: "https://example.com/IMG_4821.jpg",
      displaySizeLabel: "2.4 MB", previewRole: "primary_preview", embedPreference: "image",
      artifactRole: "primary_evidence", originalPreservationNote: "Original preserved.",
      reviewerRepresentationLabel: "Rendered preview", reviewerRepresentationNote: "Reviewer-facing preview only.",
      verificationMaterialsNote: "See technical appendix.", previewTextExcerpt: null,
      previewCaption: "Photo preview", previewDataUrl: null,
    }],
    primaryContentItem: null as unknown,
    defaultPreviewItemId: "ev-" + s.key + "-001",
    previewPolicy: { contentVisible: true, previewEnabled: true, downloadableFromVerify: true, rationale: "Preview enabled.", privacyNotice: "Reviewer-facing only." },
    reviewGuidance: { reviewerWorkflow: ["Review content"], contentReviewNote: "Review content.", legalAssessmentNote: "Assess legal context separately.", integrityAssessmentNote: "Integrity verified.", multipartReviewNote: "Single-item record." },
    limitations: { short: "Integrity only.", detailed: "Does not prove factual truth or admissibility." },
    contentAccessPolicy: { mode: "full_access", allowContentView: true, allowDownload: true },
    embeddedPreviewsSnapshot: [],
  };
}

function fakePrisma(s: Scenario) {
  return {
    $queryRawUnsafe: async (q: string) => {
      if (q.includes("evidence_parts")) {
        return [{ id: "part-1", original_file_name: "IMG_4821.jpg", mime_type: "image/jpeg", sha256: FULL_HASH_A, technical_metadata: TM_IMAGE }];
      }
      if (q.includes("communication_messages")) return [{ ...s.acqRow, capture_environment: s.captureEnv }];
      return [{ capture_environment: s.captureEnv }];
    },
  };
}

async function generate(s: Scenario) {
  const ev = baseEvidence(s);
  ev.primaryContentItem = ev.contentItems[0];
  const ctx = buildEvidenceAcquisitionContext(s.raw);
  const acquisition = ctx ? toPublicAcquisition(ctx) : null;

  const input: ReportV2Input = {
    evidence: ev as never,
    custodyEvents: [
      { sequence: 1, atUtc: "2026-06-30T10:04:00.000Z", eventType: "EVIDENCE_CREATED", payloadSummary: '{"type":"PHOTO"}' },
      { sequence: 2, atUtc: "2026-06-30T10:04:30.000Z", eventType: "IDENTITY_SNAPSHOT_RECORDED", payloadSummary: "Mode: initial intake authorization for evidence" },
    ] as never,
    version: 2, generatedAtUtc: "2026-06-30T10:06:00.000Z", buildInfo: "audit-harness",
    acquisition: acquisition as never,
    technicalSummary: { ...TECH_SUMMARY, captureEnvironment: s.captureEnv as never } as never,
  };

  const vm = await buildReportViewModel(input);
  const html = renderReportHtml(vm);
  writeFileSync(path.join(OUT, `report-${s.key}.html`), html, "utf8");
  const pdf = await renderPdfFromHtml(html);
  writeFileSync(path.join(OUT, `report-${s.key}.pdf`), pdf);

  const files = await buildTechnicalMetadataPackageFiles({ prisma: fakePrisma(s) as never, teamId: "team-1", evidenceId: ev.id });
  for (const f of files) {
    writeFileSync(path.join(OUT, `${s.key}__${f.path.replace(/[\/]/g, "__")}`), JSON.stringify(f.json, null, 2), "utf8");
  }
  // The public acquisition object is exactly what the verify page consumes
  // (technicalMetadata.acquisition) — write it as the verify-page data artifact.
  writeFileSync(path.join(OUT, `${s.key}__verify-acquisition.json`), JSON.stringify(acquisition, null, 2), "utf8");
  console.log(`[${s.key}] pdf=${pdf.length}B channel=${acquisition?.deliveryChannel ?? "(none)"} method=${acquisition?.method ?? "(none)"} pkg=[${files.map((f) => f.path.split("/").pop()).join(",")}]`);
}

for (const s of SCENARIOS) await generate(s);
console.log("DONE ->", OUT);
