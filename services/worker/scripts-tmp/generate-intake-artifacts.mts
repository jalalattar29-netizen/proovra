/**
 * TEMPORARY validation harness — Intake geolocation + unified grid layout.
 * Drives the REAL production builders and writes artifacts to tmp-artifacts/.
 *
 * Scenarios:
 *   web       — Web Capture, WITH location + EXIF (baseline; must be unchanged)
 *   sms-loc   — Intake SMS, WITH location + EXIF (location must appear everywhere)
 *   sms-exif  — Intake SMS, EXIF, NO location (Technical Summary grid, no fake loc)
 *   sms-noloc — Intake SMS, NO location, NO EXIF (no fake loc, no empty page)
 *
 * Real builders exercised:
 *   buildReportViewModel → renderReportHtml → renderPdfFromHtml   (PDF + captureContext)
 *   buildTechnicalMetadataPackageFiles                            (intake-delivery.json — NO location)
 *   buildCaptureContext                                           (capture-context.json — WITH location)
 *   buildEvidenceAcquisitionContext → toPublicAcquisition         (verify-page acquisition data)
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
import { buildCaptureContext } from "../src/verification-package.js";
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
  widthPx: 4032, heightPx: 3024, exifPresent: true, cameraMake: "samsung",
  cameraModel: "Galaxy S25 FE", originalCaptureTime: "2026-06-30T09:58:11Z",
  iso: 50, aperture: "f/1.8", exposureTime: "1/100s", orientation: 1, gpsPresent: true,
};

const INTAKE_CAPTURE_ENV = {
  uploadSource: "INTAKE_LINK", captureMethod: "EXTERNAL_INTAKE_UPLOAD",
  browserName: "Samsung Internet", browserVersion: "25", osName: "Android", osVersion: "15",
  deviceClass: "MOBILE", engine: "Blink", platform: "Android", timezone: "Europe/Berlin",
  locale: "de-DE", userAgentHash: "sha256:deadbeefcafe", ipAddressMasked: "203.0.113.x",
  country: "DE", region: null, networkType: null, attestationAttempted: false, attestationResult: null,
};
const WEB_CAPTURE_ENV = {
  ...INTAKE_CAPTURE_ENV, uploadSource: "WEB_APP", captureMethod: "SECURE_CAPTURE",
  browserName: "Chrome", browserVersion: "138", osName: "Windows", deviceClass: "DESKTOP",
  engine: "Blink", platform: "Windows x64", timezone: "Europe/London", locale: "en-GB",
};

function techSummary(captureEnv: Record<string, unknown>) {
  return {
    mediaFilesAnalyzed: 1, mediaFilesTotal: 1, metadataStatus: "Complete" as const,
    primaryMediaType: "Image", resolutionSummary: "4032×3024",
    primaryMedia: { mediaKind: "IMAGE", durationMs: null, videoCodec: null, frameRate: null, pageCount: null },
    exif: {
      exifPresent: true, camera: "samsung Galaxy S25 FE", cameraMake: "samsung", cameraModel: "Galaxy S25 FE",
      lensModel: null, originalCaptureTime: "2026-06-30T09:58:11Z", iso: 50, aperture: "f/1.8",
      exposureTime: "1/100s", shutterSpeed: null, whiteBalance: null, orientation: 1, gpsPresent: true,
      resolution: "4032×3024", softwareTag: null, metadataStatus: "PRESENT" as const,
    },
    network: { maskedIp: "203.0.113.x", country: "DE", region: null, networkType: null },
    captureEnvironment: captureEnv,
  };
}

type Scenario = {
  key: string;
  isIntake: boolean;
  hasLocation: boolean;
  hasExif: boolean;
  contributorEmail: string;
  raw: AcquisitionRawInput;
  acqRow: Record<string, unknown>;
  captureEnv: Record<string, unknown>;
  evidenceCaptureMethod: string;
};

const LOC = { lat: 52.520008, lng: 13.404954, accuracyMeters: 12 };

const SCENARIOS: Scenario[] = [
  {
    key: "web", isIntake: false, hasLocation: true, hasExif: true,
    contributorEmail: "owner@acme-legal.example", evidenceCaptureMethod: "SECURE_CAMERA",
    captureEnv: WEB_CAPTURE_ENV,
    raw: { uploadSource: "WEB_APP", captureMethod: "SECURE_CAPTURE", identityLevel: "VERIFIED_EMAIL" },
    acqRow: { capture_method: "UPLOADED_FILE" },
  },
  {
    key: "sms-loc", isIntake: true, hasLocation: true, hasExif: true,
    contributorEmail: "jane.contributor@gmail.com", evidenceCaptureMethod: "EXTERNAL_INTAKE_UPLOAD",
    captureEnv: INTAKE_CAPTURE_ENV,
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
    key: "sms-exif", isIntake: true, hasLocation: false, hasExif: true,
    contributorEmail: "tipster@proton.me", evidenceCaptureMethod: "EXTERNAL_INTAKE_UPLOAD",
    captureEnv: INTAKE_CAPTURE_ENV,
    raw: {
      uploadSource: "INTAKE_LINK", captureMethod: "EXTERNAL_INTAKE_UPLOAD", intakeMode: "EXTERNAL_ONE_TIME",
      identityLevel: "BASIC_ACCOUNT", deliveryChannelRaw: "SMS", deliveryStatusRaw: "DELIVERED",
      sentAtUtc: "2026-06-30T10:00:00.000Z", submittedAtUtc: "2026-06-30T10:04:00.000Z",
      consentAcceptedAtUtc: "2026-06-30T10:02:30.000Z", consentVersion: "v3",
      recipientMasked: "+49 ••• ••• 9999", recipientHash: "beefbeef", recipientType: "phone",
    },
    acqRow: {
      capture_method: "EXTERNAL_INTAKE_UPLOAD", identity_level: "BASIC_ACCOUNT",
      submitted_at_utc: "2026-06-30T10:04:00.000Z", consent_accepted_at_utc: "2026-06-30T10:02:30.000Z",
      consent_snapshot_json: { policyVersion: "v3" }, submitter_email: "tipster@proton.me",
      intake_mode: "EXTERNAL_ONE_TIME", consent_policy_version: "v3", recipient_email: null,
      recipient_preview: "+49 ••• ••• 9999", recipient_hash: "beefbeef", channel: "SMS",
      delivery_status: "DELIVERED", sent_at_utc: "2026-06-30T10:00:00.000Z",
    },
  },
  {
    key: "sms-noloc", isIntake: true, hasLocation: false, hasExif: false,
    contributorEmail: "anon.tipster@gmail.com", evidenceCaptureMethod: "EXTERNAL_INTAKE_UPLOAD",
    captureEnv: INTAKE_CAPTURE_ENV,
    raw: {
      uploadSource: "INTAKE_LINK", captureMethod: "EXTERNAL_INTAKE_UPLOAD", intakeMode: "EXTERNAL_ONE_TIME",
      identityLevel: "BASIC_ACCOUNT", deliveryChannelRaw: "SMS", deliveryStatusRaw: "DELIVERED",
      sentAtUtc: "2026-06-30T10:00:00.000Z", submittedAtUtc: "2026-06-30T10:04:00.000Z",
      consentAcceptedAtUtc: "2026-06-30T10:02:30.000Z", consentVersion: "v3",
    },
    acqRow: {
      capture_method: "EXTERNAL_INTAKE_UPLOAD", identity_level: "BASIC_ACCOUNT",
      submitted_at_utc: "2026-06-30T10:04:00.000Z", consent_accepted_at_utc: "2026-06-30T10:02:30.000Z",
      consent_snapshot_json: { policyVersion: "v3" }, submitter_email: null,
      intake_mode: "EXTERNAL_ONE_TIME", consent_policy_version: "v3", recipient_email: null,
      recipient_preview: null, recipient_hash: null, channel: "SMS", delivery_status: "DELIVERED",
      sent_at_utc: "2026-06-30T10:00:00.000Z",
    },
  },
];

function baseEvidence(s: Scenario) {
  const locSource = s.isIntake ? "INTAKE_LINK_GEOLOCATION" : "CAPTURE_BROWSER_GEOLOCATION";
  return {
    tsaProvider: "freetsa.org", tsaUrl: "https://freetsa.org/tsr", tsaSerialNumber: "0x1A2B",
    tsaGenTimeUtc: "2026-06-30T10:05:03.000Z", tsaTokenBase64: "dGVzdA==", tsaMessageImprint: FULL_HASH_A,
    tsaHashAlgorithm: "SHA-256", tsaStatus: "VERIFIED", tsaFailureReason: null,
    id: "ev-" + s.key + "-001", title: "Roadside incident photo", status: "SIGNED",
    verificationStatus: "RECORDED_INTEGRITY_VERIFIED", capturedAtUtc: "2026-06-30T10:05:00.000Z",
    uploadedAtUtc: "2026-06-30T10:04:00.000Z", signedAtUtc: "2026-06-30T10:05:02.000Z",
    reportGeneratedAtUtc: "2026-06-30T10:06:00.000Z", mimeType: "image/jpeg", sizeBytes: "2508112",
    durationSec: null, storageBucket: "proovra-audit-bucket", storageKey: "evidence/x/original",
    publicUrl: null,
    gps: s.hasLocation
      ? { lat: String(LOC.lat), lng: String(LOC.lng), accuracyMeters: String(LOC.accuracyMeters), locationSource: locSource }
      : { lat: null, lng: null, accuracyMeters: null, locationSource: null },
    fileSha256: FULL_HASH_A, fingerprintCanonicalJson: '{"a":1}', fingerprintHash: FULL_HASH_B,
    signatureBase64: "sig", signingKeyId: "proovra_ed25519", signingKeyVersion: 1,
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
        return s.hasExif
          ? [{ id: "part-1", original_file_name: "IMG_4821.jpg", mime_type: "image/jpeg", sha256: FULL_HASH_A, technical_metadata: TM_IMAGE }]
          : [{ id: "part-1", original_file_name: "note.txt", mime_type: "text/plain", sha256: FULL_HASH_A, technical_metadata: null }];
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
    ] as never,
    version: 2, generatedAtUtc: "2026-06-30T10:06:00.000Z", buildInfo: "audit-harness",
    acquisition: acquisition as never,
    technicalSummary: s.hasExif ? (techSummary(s.captureEnv) as never) : null,
  };

  const vm = await buildReportViewModel(input);
  const html = renderReportHtml(vm);
  writeFileSync(path.join(OUT, `report-${s.key}.html`), html, "utf8");
  const pdf = await renderPdfFromHtml(html);
  writeFileSync(path.join(OUT, `report-${s.key}.pdf`), pdf);

  // Verification package — technical-metadata files (intake-delivery.json etc).
  const files = await buildTechnicalMetadataPackageFiles({ prisma: fakePrisma(s) as never, teamId: "team-1", evidenceId: ev.id });
  for (const f of files) {
    writeFileSync(path.join(OUT, `${s.key}__${f.path.replace(/[\/]/g, "__")}`), JSON.stringify(f.json, null, 2), "utf8");
  }

  // Verification package — capture-context.json (real builder). Emits only
  // when capture-location metadata is present (same gate as the live package).
  const captureCtx = buildCaptureContext(
    {
      capturedAtUtc: ev.capturedAtUtc,
      deviceTimeIso: null,
      captureLocation: s.hasLocation
        ? { lat: LOC.lat, lng: LOC.lng, accuracyMeters: LOC.accuracyMeters, locationSource: ev.gps.locationSource }
        : null,
    } as never,
    ev.id,
  );
  writeFileSync(
    path.join(OUT, `${s.key}__technical-metadata__capture-context.json`),
    captureCtx ? JSON.stringify(captureCtx, null, 2) : "null (no capture-context.json emitted — no location)",
    "utf8",
  );

  // Verify-page acquisition data (technicalMetadata.acquisition).
  writeFileSync(path.join(OUT, `${s.key}__verify-acquisition.json`), JSON.stringify(acquisition, null, 2), "utf8");

  const cc = vm.meta.captureContext;
  console.log(`[${s.key}] pdf=${pdf.length}B reportCaptureContext=${cc ? `${cc.lat},${cc.lng} (${cc.sourceLabel})` : "NONE"} pkgCaptureContext=${captureCtx ? "EMITTED" : "none"} channel=${acquisition?.deliveryChannel ?? "-"}`);
}

for (const s of SCENARIOS) await generate(s);
console.log("DONE ->", OUT);
