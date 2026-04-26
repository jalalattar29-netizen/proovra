import { ReportEvidenceAssetKind } from "./types.js";
import { normalizeEnumText, safe } from "./formatters.js";

export function mapRecordStatusLabel(status: string | null | undefined): string {
  switch (safe(status, "").toUpperCase()) {
    case "CREATED":
      return "Created";
    case "UPLOADING":
      return "Uploading";
    case "UPLOADED":
      return "Uploaded";
    case "SIGNED":
      return "Signed";
    case "REPORTED":
      return "Reported";
    default:
      return safe(status);
  }
}

export function mapVerificationStatusLabel(
  status: string | null | undefined
): string {
  switch (safe(status, "").toUpperCase()) {
    case "MATERIALS_AVAILABLE":
      return "Technical materials available";
    case "RECORDED_INTEGRITY_VERIFIED":
      return "Recorded integrity state verified";
    case "REVIEW_REQUIRED":
      return "Review required";
    case "FAILED":
      return "Verification failed";
    default:
      return "Verification status not recorded";
  }
}

export function mapCertificationStatusLabel(
  value: string | null | undefined
): string {
  switch (safe(value, "").toUpperCase()) {
    case "ATTESTED":
      return "Attested";
    case "REQUESTED":
      return "Requested";
    case "DRAFT":
      return "Draft";
    case "REVOKED":
      return "Revoked";
    default:
      return safe(value, "Not recorded");
  }
}

export function mapCaptureMethodLabel(value: string | null | undefined): string {
  switch (safe(value, "").toUpperCase()) {
    case "SECURE_CAMERA":
      return "Captured with PROOVRA secure camera";
    case "UPLOADED_FILE":
      return "Uploaded existing file";
    case "IMPORTED_DOCUMENT":
      return "Imported document";
    case "MULTIPART_PACKAGE":
      return "Multipart package";
    default:
      return "Capture method not recorded";
  }
}

export function mapIdentityLevelLabel(value: string | null | undefined): string {
  switch (safe(value, "").toUpperCase()) {
    case "BASIC_ACCOUNT":
      return "Basic account";
    case "VERIFIED_EMAIL":
      return "Verified email";
    case "OAUTH_BACKED_IDENTITY":
      return "OAuth-backed identity";
    case "ORGANIZATION_ACCOUNT":
      return "Organization account";
    case "VERIFIED_ORGANIZATION":
      return "Verified organization";
    default:
      return "Identity level not recorded";
  }
}

export function mapAuthProviderLabel(value: string | null | undefined): string {
  switch (safe(value, "").toUpperCase()) {
    case "GOOGLE":
      return "Google";
    case "APPLE":
      return "Apple";
    case "EMAIL":
      return "Email";
    case "GUEST":
      return "Guest";
    default:
      return "Provider not recorded";
  }
}

export function mapVerificationSourceLabel(
  value: string | null | undefined
): string {
  switch (safe(value, "").toUpperCase()) {
    case "REPORT_GENERATED":
      return "Report generated";
    case "PUBLIC_VERIFY_VIEWED":
      return "Public verification page viewed";
    case "TECHNICAL_VERIFICATION_CHECKED":
      return "Technical verification checked";
    default:
      return "Verification source not recorded";
  }
}

export function mapCustodyEventLabel(eventType: string | null | undefined): string {
  switch (safe(eventType, "").toUpperCase()) {
    case "EVIDENCE_CREATED":
      return "Evidence created";
    case "IDENTITY_SNAPSHOT_RECORDED":
      return "Identity snapshot recorded";
    case "UPLOAD_STARTED":
      return "Upload started";
    case "UPLOAD_COMPLETED":
      return "Upload completed";
    case "SIGNATURE_APPLIED":
      return "Digital signature applied";
    case "TIMESTAMP_APPLIED":
      return "Trusted timestamp applied";
    case "TIMESTAMP_FAILED":
      return "Trusted timestamp failed";
    case "REPORT_GENERATED":
      return "Report generated";
    case "REVIEW_READY":
      return "Review-ready state recorded";
    case "VERIFICATION_PACKAGE_GENERATED":
      return "Verification package generated";
    case "CERTIFICATION_REQUESTED":
      return "Certification requested";
    case "CERTIFICATION_ATTESTED":
      return "Certification attested";
    case "CERTIFICATION_REVOKED":
      return "Certification revoked";
    case "EVIDENCE_PURGED":
      return "Evidence purged";
    case "OTS_APPLIED":
      return "OpenTimestamps update";
    case "OTS_FAILED":
      return "OpenTimestamps failure";
    case "TECHNICAL_VERIFICATION_CHECKED":
      return "Technical verification checked";
    case "VERIFY_VIEWED":
      return "Verification page viewed";
    case "EVIDENCE_VIEWED":
      return "Evidence viewed";
    case "REPORT_DOWNLOADED":
      return "Report downloaded";
    case "VERIFICATION_PACKAGE_DOWNLOADED":
      return "Verification package downloaded";
    case "EVIDENCE_LOCKED":
      return "Evidence locked";
    case "EVIDENCE_ARCHIVED":
      return "Evidence archived";
    case "EVIDENCE_RESTORED":
      return "Evidence restored";
    case "ANCHOR_PUBLISHED":
      return "External anchor published";
    case "ANCHOR_FAILED":
      return "External anchor failed";
    default:
      return normalizeEnumText(eventType);
  }
}

export function mapTimestampStatusPublicLabel(
  status: string | null | undefined
): string {
  switch (safe(status, "").toUpperCase()) {
    case "STAMPED":
    case "GRANTED":
    case "VERIFIED":
    case "SUCCEEDED":
      return "Trusted timestamp recorded";
    case "PENDING":
    case "UNAVAILABLE":
      return "Timestamp pending";
    case "FAILED":
      return "Timestamp failed";
    default:
      return "Timestamp not recorded";
  }
}

export function mapOtsStatusPublicLabel(status: string | null | undefined): string {
  switch (safe(status, "").toUpperCase()) {
    case "ANCHORED":
      return "Public anchoring recorded";
    case "PENDING":
      return "Anchoring pending";
    case "FAILED":
      return "Anchoring failed";
    case "DISABLED":
      return "Anchoring disabled";
    default:
      return "Anchoring not recorded";
  }
}

export function mapObjectLockModePublicLabel(
  mode: string | null | undefined
): string {
  switch (safe(mode, "").toUpperCase()) {
    case "COMPLIANCE":
      return "Compliance retention lock";
    case "GOVERNANCE":
      return "Governance retention lock";
    default:
      return "Not recorded";
  }
}

export function mapAnchorModePublicLabel(mode: string | null | undefined): string {
  switch (safe(mode, "").toUpperCase()) {
    case "ACTIVE":
      return "Active anchoring";
    case "READY":
      return "Anchor configured";
    case "OFF":
      return "Anchoring off";
    case "PUBLIC":
      return "Public anchoring";
    case "PRIVATE":
      return "Private anchoring";
    case "HASH_ONLY":
      return "Digest anchoring";
    default:
      return "Not recorded";
  }
}

export function mapEvidenceAssetKindLabel(
  kind: ReportEvidenceAssetKind | null | undefined
): string {
  switch (kind) {
    case "image":
      return "Image";
    case "video":
      return "Video";
    case "audio":
      return "Audio";
    case "pdf":
      return "PDF";
    case "text":
      return "Text";
    case "other":
      return "Other";
    default:
      return "Not recorded";
  }
}

export function normalizeReviewerText(value: string | null | undefined): string {
  return safe(value, "")
    .replace(/\bOAUTH_BACKED_IDENTITY\b/g, "OAuth-backed identity")
    .replace(/\bMULTIPART_PACKAGE\b/g, "Multipart package")
    .replace(/\bSECURE_CAMERA\b/g, "PROOVRA secure camera")
    .replace(/\bUPLOADED_FILE\b/g, "Uploaded existing file")
    .replace(/\bIMPORTED_DOCUMENT\b/g, "Imported document")
    .replace(/\bBASIC_ACCOUNT\b/g, "Basic account")
    .replace(/\bVERIFIED_EMAIL\b/g, "Verified email")
    .replace(/\bORGANIZATION_ACCOUNT\b/g, "Organization account")
    .replace(/\bVERIFIED_ORGANIZATION\b/g, "Verified organization")
    .replace(/_/g, " ");
}