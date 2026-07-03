/**
 * TEMPORARY validation harness — six-issue audit. Reproduces the REAL intake
 * data shapes that the previous harness got wrong:
 *   - captureMethod = MULTIPART_PACKAGE (overwritten by completeEvidence), NOT
 *     EXTERNAL_INTAKE_UPLOAD.
 *   - a custody IDENTITY_SNAPSHOT_RECORDED event whose payload summary embeds
 *     the workspace OWNER's email/provider.
 *   - owner-scoped createdBy/uploadedBy/submittedByAuthProvider.
 *   - NO capture_environment recorded (so capture-environment.json is absent
 *     and the Technical Summary would be camera-only / mostly-empty).
 *
 * Scenarios:
 *   intake — Intake SMS, location + EXIF, NO capture_environment (issues 1,2,3,5,6)
 *   web    — Web Capture, location + EXIF, WITH capture_environment (baseline)
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
import { buildCaseMetadata, buildOriginalLinkage } from "../src/verification-package.js";
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
const OWNER_EMAIL = "jalal.attar@proovra.com";

const TM_IMAGE = {
  schemaVersion: 1, mediaKind: "IMAGE", mimeType: "image/jpeg", parseResult: "OK",
  metadataStatus: "PRESENT", parserName: "exifr", parserVersion: "7.1.3",
  widthPx: 4032, heightPx: 3024, exifPresent: true, cameraMake: "samsung",
  cameraModel: "Galaxy S25 FE", originalCaptureTime: "2026-06-30T09:58:11Z",
  iso: 50, aperture: "f/1.8", exposureTime: "1/100s", orientation: 1, gpsPresent: true,
};

const WEB_CAPTURE_ENV = {
  uploadSource: "WEB_APP", captureMethod: "SECURE_CAPTURE",
  browserName: "Chrome", browserVersion: "138", osName: "Windows", osVersion: null,
  deviceClass: "DESKTOP", engine: "Blink", platform: "Windows x64", timezone: "Europe/London",
  locale: "en-GB", userAgentHash: "sha256:deadbeefcafe", ipAddressMasked: "203.0.113.x",
  country: "GB", region: null, networkType: null, attestationAttempted: false, attestationResult: null,
};

// Intake capture environment (contributor's mobile browser), as recorded by
// recordCaptureEnvironment on the intake path.
const INTAKE_CAPTURE_ENV = {
  uploadSource: "INTAKE_LINK", captureMethod: "INTAKE_LINK",
  browserName: "Samsung Internet", browserVersion: "25", osName: "Android", osVersion: "15",
  deviceClass: "MOBILE", engine: "Blink", platform: "Android", timezone: "Europe/Berlin",
  locale: "de-DE", userAgentHash: "sha256:cafef00dbaad", ipAddressMasked: "203.0.113.x",
  country: "DE", region: null, networkType: null, attestationAttempted: false, attestationResult: null,
};

function techSummary(captureEnv: Record<string, unknown> | null) {
  return {
    mediaFilesAnalyzed: 2, mediaFilesTotal: 2, metadataStatus: "Complete" as const,
    primaryMediaType: "Image", resolutionSummary: "4032×3024",
    primaryMedia: { mediaKind: "IMAGE", durationMs: null, videoCodec: null, frameRate: null, pageCount: null },
    exif: {
      exifPresent: true, camera: "samsung Galaxy S25 FE", cameraMake: "samsung", cameraModel: "Galaxy S25 FE",
      lensModel: null, originalCaptureTime: "2026-06-30T09:58:11Z", iso: 50, aperture: "f/1.8",
      exposureTime: "1/100s", shutterSpeed: null, whiteBalance: null, orientation: 1, gpsPresent: true,
      resolution: "4032×3024", softwareTag: null, metadataStatus: "PRESENT" as const,
    },
    network: { maskedIp: "203.0.113.x", country: "GB", region: null, networkType: null },
    // Intake has NO capture environment recorded → camera-only → the Technical
    // Summary must NOT be a standalone page (it moves to the Appendix).
    captureEnvironment: captureEnv,
  };
}

type Scenario = {
  key: string;
  isIntake: boolean;
  env: Record<string, unknown> | null;
  contributorOrOwnerEmail: string;
  raw: AcquisitionRawInput;
  acqRow: Record<string, unknown>;
};

const LOC = { lat: 52.520008, lng: 13.404954, accuracyMeters: 12 };

const SCENARIOS: Scenario[] = [
  {
    key: "intake", isIntake: true, env: INTAKE_CAPTURE_ENV,
    contributorOrOwnerEmail: OWNER_EMAIL, // owner email lands in custody payload
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
      submitter_email: OWNER_EMAIL, intake_mode: "EXTERNAL_ONE_TIME",
      consent_policy_version: "v3", recipient_email: null, recipient_preview: "+49 ••• ••• 1234",
      recipient_hash: "9f2c1e77deadbeef", channel: "SMS", delivery_status: "DELIVERED",
      sent_at_utc: "2026-06-30T10:00:00.000Z", delivered_at_utc: "2026-06-30T10:00:05.000Z",
    },
  },
  {
    // Intake WITHOUT any recorded capture environment — proves honest
    // camera-only device-enrichment.json + no capture-environment.json.
    key: "intake-noenv", isIntake: true, env: null,
    contributorOrOwnerEmail: OWNER_EMAIL,
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
      consent_snapshot_json: { policyVersion: "v3" }, submitter_email: OWNER_EMAIL,
      intake_mode: "EXTERNAL_ONE_TIME", consent_policy_version: "v3", recipient_email: null,
      recipient_preview: "+49 ••• ••• 9999", recipient_hash: "beefbeef", channel: "SMS",
      delivery_status: "DELIVERED", sent_at_utc: "2026-06-30T10:00:00.000Z",
    },
  },
  {
    key: "web", isIntake: false, env: WEB_CAPTURE_ENV,
    contributorOrOwnerEmail: "owner@acme-legal.example",
    raw: { uploadSource: "WEB_APP", captureMethod: "SECURE_CAPTURE", identityLevel: "VERIFIED_EMAIL" },
    acqRow: { capture_method: "UPLOADED_FILE" },
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
    gps: { lat: String(LOC.lat), lng: String(LOC.lng), accuracyMeters: String(LOC.accuracyMeters), locationSource: locSource },
    fileSha256: FULL_HASH_A, fingerprintCanonicalJson: '{"a":1}', fingerprintHash: FULL_HASH_B,
    signatureBase64: "sig", signingKeyId: "proovra_ed25519", signingKeyVersion: 1,
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\nTEST\n-----END PUBLIC KEY-----\n",
    // For intake the DB carries the OWNER's identity here (the contributor has
    // no User row) — the report must NOT surface it as the contributor.
    submittedByEmail: s.contributorOrOwnerEmail, submittedByAuthProvider: "google",
    submittedByUserId: s.isIntake ? null : "submitter-user-55",
    createdByUserId: "owner-user-11223344", uploadedByUserId: "owner-user-11223344",
    lastAccessedByUserId: null, lastAccessedAtUtc: null,
    // The REAL value after completeEvidence for a multi-file intake upload.
    captureMethod: "MULTIPART_PACKAGE",
    identityLevelSnapshot: "VERIFIED_EMAIL", // requester/owner is verified
    workspaceNameSnapshot: "Jalal Attar's personal workspace", organizationNameSnapshot: null,
    organizationVerifiedSnapshot: false, verificationPackageVersion: 2, reviewerSummaryVersion: 1,
    lastVerifiedSource: "SCHEDULED", otsStatus: "PENDING", otsFailureReason: null, otsBitcoinTxid: null,
    otsAnchoredAtUtc: null, tsaInputKind: "FILE_SHA256",
    contentSummary: {
      structure: "multipart", itemCount: 2, previewableItemCount: 2, downloadableItemCount: 2,
      imageCount: 2, videoCount: 0, audioCount: 0, pdfCount: 0, textCount: 0, otherCount: 0,
      primaryKind: "image", primaryMimeType: "image/jpeg", totalSizeBytes: "2508112", totalSizeDisplay: "2.4 MB",
    },
    contentItems: [0, 1].map((i) => ({
      id: "ev-" + s.key + "-00" + (i + 1), index: i, label: "Primary evidence " + (i + 1),
      originalFileName: "IMG_482" + (i + 1) + ".jpg",
      mimeType: "image/jpeg", kind: "image", sizeBytes: "2508112", durationMs: null, sha256: FULL_HASH_A,
      isPrimary: true, previewable: true, downloadable: true, viewUrl: "https://example.com/IMG_482" + (i + 1) + ".jpg",
      displaySizeLabel: "2.4 MB", previewRole: "primary_preview", embedPreference: "image",
      artifactRole: "primary_evidence", originalPreservationNote: "Original preserved.",
      reviewerRepresentationLabel: "Rendered preview", reviewerRepresentationNote: "Reviewer-facing preview only.",
      verificationMaterialsNote: "See technical appendix.", previewTextExcerpt: null,
      previewCaption: "Photo preview", previewDataUrl: null,
    })),
    primaryContentItem: null as unknown,
    defaultPreviewItemId: "ev-" + s.key + "-001",
    previewPolicy: { contentVisible: true, previewEnabled: true, downloadableFromVerify: true, rationale: "Preview enabled.", privacyNotice: "Reviewer-facing only." },
    reviewGuidance: { reviewerWorkflow: ["Review content"], contentReviewNote: "Review content.", legalAssessmentNote: "Assess legal context separately.", integrityAssessmentNote: "Integrity verified.", multipartReviewNote: "Multi-item record." },
    limitations: { short: "Integrity only.", detailed: "Does not prove factual truth or admissibility." },
    contentAccessPolicy: { mode: "full_access", allowContentView: true, allowDownload: true },
    embeddedPreviewsSnapshot: [],
  };
}

// Custody events — INCLUDING the identity-snapshot event whose real payload
// summary embeds the owner email/provider (built by summarizePayloadForReport).
function custodyEvents(s: Scenario) {
  return [
    { sequence: 1, atUtc: "2026-06-30T10:03:00.000Z", eventType: "EVIDENCE_CREATED", payloadSummary: "Evidence record created." },
    {
      sequence: 2, atUtc: "2026-06-30T10:03:05.000Z", eventType: "IDENTITY_SNAPSHOT_RECORDED",
      payloadSummary: `Identity snapshot recorded • Identity: ${s.isIntake ? "Basic account" : "Verified email"} • Email: ${s.contributorOrOwnerEmail} • Provider: Google`,
    },
    { sequence: 3, atUtc: "2026-06-30T10:05:02.000Z", eventType: "EVIDENCE_COMPLETED", payloadSummary: "Evidence completed and signed." },
  ];
}

function fakePrisma(s: Scenario) {
  const captureEnv = s.env;
  return {
    $queryRawUnsafe: async (q: string) => {
      if (q.includes("evidence_parts")) {
        return [{ id: "part-1", original_file_name: "IMG_4821.jpg", mime_type: "image/jpeg", sha256: FULL_HASH_A, technical_metadata: TM_IMAGE }];
      }
      if (q.includes("communication_messages")) return [{ ...s.acqRow, capture_environment: captureEnv }];
      return [{ capture_environment: captureEnv }];
    },
  };
}

async function generate(s: Scenario) {
  const ev = baseEvidence(s);
  ev.primaryContentItem = ev.contentItems[0];
  const ctx = buildEvidenceAcquisitionContext(s.raw);
  const acquisition = ctx ? toPublicAcquisition(ctx) : null;
  const captureEnv = s.env;

  const input: ReportV2Input = {
    evidence: ev as never,
    custodyEvents: custodyEvents(s) as never,
    version: 2, generatedAtUtc: "2026-06-30T10:06:00.000Z", buildInfo: "audit-harness",
    acquisition: acquisition as never,
    technicalSummary: techSummary(captureEnv) as never,
  };

  const vm = await buildReportViewModel(input);
  const html = renderReportHtml(vm);
  writeFileSync(path.join(OUT, `report-${s.key}.html`), html, "utf8");
  const pdf = await renderPdfFromHtml(html);
  writeFileSync(path.join(OUT, `report-${s.key}.pdf`), pdf);

  const files = await buildTechnicalMetadataPackageFiles({ prisma: fakePrisma(s) as never, teamId: "team-1", evidenceId: ev.id });
  const emitted: string[] = [];
  for (const f of files) {
    emitted.push(f.path.split("/").pop()!);
    writeFileSync(path.join(OUT, `${s.key}__${f.path.replace(/[\/]/g, "__")}`), JSON.stringify(f.json, null, 2), "utf8");
  }
  // case-metadata.json + original-linkage.json (real builders). The package
  // metadata's submittedByEmail is the identity-snapshot email = the LINK
  // CREATOR / workspace owner for intake; captureMethod is the raw structure
  // enum MULTIPART_PACKAGE (as after completion).
  const pkgMetadata = {
    title: "Roadside incident photo",
    rawEvidenceType: "PHOTO",
    reviewerEvidenceType: "Photo Evidence",
    evidenceStructure: "Multipart evidence package",
    itemCount: 2,
    imageCount: 2,
    mimeType: "image/jpeg",
    evidenceStatus: "SIGNED",
    verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
    captureMethod: "MULTIPART_PACKAGE",
    identityLevelSnapshot: "VERIFIED_EMAIL",
    submittedByEmail: s.contributorOrOwnerEmail,
    submittedByAuthProvider: "google",
    isIntake: s.isIntake,
    createdAtUtc: "2026-06-30T10:03:00.000Z",
    capturedAtUtc: "2026-06-30T10:05:00.000Z",
    uploadedAtUtc: "2026-06-30T10:04:00.000Z",
    signedAtUtc: "2026-06-30T10:05:02.000Z",
    reportGeneratedAtUtc: "2026-06-30T10:06:00.000Z",
  };
  writeFileSync(path.join(OUT, `${s.key}__case-metadata.json`), JSON.stringify(buildCaseMetadata(pkgMetadata as never, ev.id), null, 2), "utf8");
  writeFileSync(path.join(OUT, `${s.key}__original-linkage.json`), JSON.stringify(buildOriginalLinkage([] as never, pkgMetadata as never), null, 2), "utf8");

  console.log(`[${s.key}] pdf=${pdf.length}B pkg=[${emitted.join(",")}]+case-metadata+original-linkage`);
}

for (const s of SCENARIOS) await generate(s);
console.log("DONE ->", OUT);
