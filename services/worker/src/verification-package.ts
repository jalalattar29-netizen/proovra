import archiver from "archiver";
import path from "node:path";
import { PassThrough } from "stream";
import { isAccessCustodyEventType } from "@proovra/shared";

type VerificationEvidenceFile = {
  name: string;
  buffer: Buffer;
  sha256?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  originalFileName?: string | null;
  partIndex?: number | null;
  storageBucket?: string | null;
  storageKey?: string | null;
  storageRegion?: string | null;
  storageObjectLockMode?: string | null;
  storageObjectLockRetainUntilUtc?: string | null;
  storageObjectLockLegalHoldStatus?: string | null;
};

type VerificationCertificationRecord = {
  declarationType: "CUSTODIAN" | "QUALIFIED_PERSON";
  status: "DRAFT" | "REQUESTED" | "ATTESTED" | "REVOKED";
  version: number;
  requestedAtUtc: string | null;
  requestedByUserId: string | null;
  attestedAtUtc: string | null;
  attestedByUserId: string | null;
  attestorName: string | null;
  attestorTitle: string | null;
  attestorEmail: string | null;
  attestorOrganization: string | null;
  statementMarkdown: string | null;
  statementSnapshot: unknown;
  signatureText: string | null;
  certificationHash: string | null;
  revokedAtUtc: string | null;
  revokedByUserId: string | null;
  revokeReason: string | null;
};

type AnchorMode = "off" | "ready" | "active";

type AnchorPayload = {
  version: 1;
  evidenceId: string;
  reportVersion: number;
  fileSha256: string;
  fingerprintHash: string;
  lastEventHash: string | null;
  anchorHash: string;
  generatedAtUtc: string;
  published?: boolean;
  receiptId?: string | null;
  transactionId?: string | null;
  publicUrl?: string | null;
  anchoredAtUtc?: string | null;
};

type PackageManifest = {
  packageType: "PROOVRA_VERIFICATION_PACKAGE";
  version: number;
  evidenceId: string | null;
  reportVersion: number | null;
  signingKeyId: string | null;
  signingKeyVersion: string | null;
  multipart: boolean;
  fileCount: number;
  generatedAtUtc: string;
  anchorIncluded: boolean;
  anchorMode: AnchorMode;
  anchorProvider: string | null;
  anchorPublicBaseUrl: string | null;
  externalPublicationAttached: boolean;
  verificationProfile: "FORENSIC_INTEGRITY";
  contents: {
    evidenceFiles: boolean;
    fingerprint: boolean;
    signature: boolean;
    publicKey: boolean;
    custody: boolean;
    timestampToken: boolean;
    anchor: boolean;
    evidenceManifest: boolean;
    originalLinkage: boolean;
    forensicCustody: boolean;
    accessActivity: boolean;
    reportArtifact: boolean;
    courtReadiness: boolean;
    certificationTemplates: boolean;
    verifyHtml: boolean;
    readme: boolean;
    actualCertifications: boolean;
    duplicateDigests: boolean;
  };
};

type VerificationPackageMetadata = {
  title?: string | null;
  evidenceType?: string | null;
  evidenceStatus?: string | null;
  verificationStatus?: string | null;
  captureMethod?: string | null;
  identityLevelSnapshot?: string | null;
  submittedByEmail?: string | null;
  submittedByAuthProvider?: string | null;
  createdAtUtc?: string | null;
  capturedAtUtc?: string | null;
  uploadedAtUtc?: string | null;
  signedAtUtc?: string | null;
  reportGeneratedAtUtc?: string | null;
  storageRegion?: string | null;
  storageObjectLockMode?: string | null;
  storageObjectLockRetainUntilUtc?: string | null;
  storageObjectLockLegalHoldStatus?: string | null;
  storageImmutable?: boolean | null;
  tsaStatus?: string | null;
  otsStatus?: string | null;
};

type CustodyEventRecord = {
  sequence?: number | null;
  atUtc?: string | null;
  eventType?: string | null;
  payload?: unknown;
  prevEventHash?: string | null;
  eventHash?: string | null;
};

function splitCustodyEvents(
  custody: unknown
): { forensic: CustodyEventRecord[]; access: CustodyEventRecord[] } {
  if (!Array.isArray(custody)) {
    return { forensic: [], access: [] };
  }

  const forensic: CustodyEventRecord[] = [];
  const access: CustodyEventRecord[] = [];

  for (const item of custody) {
    const event =
      item && typeof item === "object" ? (item as CustodyEventRecord) : null;
    if (!event) continue;

    if (isAccessCustodyEventType(event.eventType)) {
      access.push(event);
    } else {
      forensic.push(event);
    }
  }

  return { forensic, access };
}

function normalizeFileName(name: string, fallback: string): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) return fallback;

  const normalized = trimmed
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);

  return normalized || fallback;
}

function formatTimestampForFile(value: string | null | undefined): string | null {
  if (!value || typeof value !== "string") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace(/:\d{2}\.\d{3}Z$/, "Z").replace(/:/g, "-");
}

function mapMimeTypeToExtension(mimeType: string | null | undefined): string {
  const normalized = typeof mimeType === "string" ? mimeType.trim().toLowerCase() : "";
  switch (normalized) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
    case "photo":
      return "jpg";
    case "image/webp":
      return "webp";
    case "video/mp4":
    case "video":
      return "mp4";
    case "video/quicktime":
      return "mov";
    case "audio/mpeg":
    case "audio":
      return "mp3";
    case "audio/wav":
      return "wav";
    case "application/pdf":
    case "document":
    case "pdf":
      return "pdf";
    case "text/plain":
      return "txt";
    case "application/json":
      return "json";
    default:
      return "bin";
  }
}

function sanitizeFileBaseName(value: string, maxLen = 120): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-\.]+|[-\.]+$/g, "")
    .toLowerCase()
    .slice(0, maxLen)
    .replace(/-+/g, "-");

  return normalized || "evidence";
}

function deriveEvidenceDescriptor(params: {
  evidenceType?: string | null;
  mimeType?: string | null;
  captureMethod?: string | null;
}): string {
  const typeLabel = typeof params.evidenceType === "string" && params.evidenceType.trim()
    ? params.evidenceType.trim().toLowerCase()
    : params.mimeType
      ? params.mimeType.split("/")[0]
      : "evidence";

  const methodLabel = typeof params.captureMethod === "string"
    ? params.captureMethod.trim().toLowerCase()
    : "captured";

  if (typeLabel === "document" || typeLabel === "pdf") {
    return `${methodLabel}-document`;
  }
  if (typeLabel === "photo" || typeLabel === "image") {
    return `${methodLabel}-image`;
  }
  if (typeLabel === "video") {
    return `${methodLabel}-video`;
  }
  if (typeLabel === "audio") {
    return `${methodLabel}-audio`;
  }

  return `${methodLabel}-evidence`;
}

function normalizeFileNameSegments(parts: Array<string | null | undefined>): string {
  return parts
    .filter(
      (part): part is string => typeof part === "string" && part.trim().length > 0
    )
    .map((part) => sanitizeFileBaseName(part))
    .filter((part) => part !== "")
    .join("-");
}

function buildEvidencePackageFileName(params: {
  evidenceTitle?: string | null;
  originalFileName?: string | null;
  evidenceType?: string | null;
  mimeType?: string | null;
  captureMethod?: string | null;
  capturedAtUtc?: string | null;
  uploadedAtUtc?: string | null;
  partIndex?: number | null;
  totalParts: number;
  fileOrder: number;
}): string {
  const extension = mapMimeTypeToExtension(params.mimeType);
  const timestamp = formatTimestampForFile(params.capturedAtUtc ?? params.uploadedAtUtc);
  const hasTitle = typeof params.evidenceTitle === "string" && params.evidenceTitle.trim().length > 0;
  const hasOriginal = typeof params.originalFileName === "string" && params.originalFileName.trim().length > 0;

  const originalNameBase = hasOriginal
    ? sanitizeFileBaseName(path.basename(params.originalFileName!.trim(), path.extname(params.originalFileName!)))
    : null;

  const titleBase = hasTitle
    ? sanitizeFileBaseName(params.evidenceTitle!.trim())
    : null;

  const descriptor = deriveEvidenceDescriptor({
    evidenceType: params.evidenceType,
    mimeType: params.mimeType,
    captureMethod: params.captureMethod,
  });

  const partLabel = params.totalParts > 1 ? `part-${String(params.partIndex ?? params.fileOrder).padStart(2, "0")}` : null;

  let baseName: string;

  if (params.totalParts > 1) {
    if (originalNameBase) {
      baseName = normalizeFileNameSegments([originalNameBase, timestamp]);
    } else if (titleBase) {
      baseName = normalizeFileNameSegments([titleBase, partLabel, timestamp]);
    } else {
      baseName = normalizeFileNameSegments([descriptor, partLabel, timestamp]);
    }
  } else {
    if (titleBase) {
      baseName = normalizeFileNameSegments([titleBase, timestamp]);
    } else if (originalNameBase) {
      baseName = normalizeFileNameSegments([originalNameBase, timestamp]);
    } else {
      baseName = normalizeFileNameSegments([descriptor, timestamp]);
    }
  }

  if (!baseName) {
    baseName = timestamp ? `evidence-${timestamp}` : "evidence-item";
  }

  if (params.totalParts > 1) {
    const orderPrefix = String(params.fileOrder).padStart(String(params.totalParts).length, "0");
    baseName = `${orderPrefix}-${baseName}`;
  }

  return `${baseName}.${extension}`;
}

function normalizeAnchorMode(value: string | null | undefined): AnchorMode {
  const raw = String(value ?? "ready").trim().toLowerCase();
  if (raw === "off" || raw === "active") return raw;
  return "ready";
}

function safeText(value: string | null | undefined, fallback = "N/A"): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

function buildAnchorReadmeSection(params: {
  anchorMode: AnchorMode;
  hasAnchorPayload: boolean;
  anchorPublished: boolean;
  otsStatus?: string | null;
  anchorProvider?: string | null;
  anchorPublicBaseUrl?: string | null;
}): string {
  const providerLine = params.anchorProvider
    ? `Provider: ${params.anchorProvider}`
    : "Provider: Not configured";

  const publicBaseLine = params.anchorPublicBaseUrl
    ? `Public base URL: ${params.anchorPublicBaseUrl}`
    : "Public base URL: Not configured";

  const otsStatus = String(params.otsStatus ?? "").toUpperCase();

  if (params.anchorMode === "off") {
    return `ANCHOR STATUS

Anchor publication is disabled for this environment.
No external anchoring claim is made for this package.
${providerLine}
${publicBaseLine}`;
  }

  if (!params.hasAnchorPayload) {
    return `ANCHOR STATUS

No anchor.json file is included in this package.
Public anchoring status: ${otsStatus || "NOT_RECORDED"}.
${providerLine}
${publicBaseLine}`;
  }

  if (params.anchorPublished || otsStatus === "ANCHORED") {
    return `ANCHOR STATUS

anchor.json is included in this package.
Public anchoring is confirmed for this record.
This anchoring layer is independent from RFC 3161 timestamping.
${providerLine}
${publicBaseLine}`;
  }

  if (otsStatus === "PENDING") {
    return `ANCHOR STATUS

anchor.json is included in this package.
Public anchoring is pending confirmation and should not be treated as fully confirmed yet.
This anchoring layer is independent from RFC 3161 timestamping.
${providerLine}
${publicBaseLine}`;
  }

  if (otsStatus === "FAILED") {
    return `ANCHOR STATUS

anchor.json is included in this package, but public anchoring failed or could not be completed.
Reviewers should rely on preserved originals, hashes, signature, custody continuity, and any available timestamp material.
${providerLine}
${publicBaseLine}`;
  }

  return `ANCHOR STATUS

anchor.json is included in this package as anchor-ready integrity material.
No external publication receipt or transaction identifier is attached yet.
This anchoring layer is independent from RFC 3161 timestamping.
${providerLine}
${publicBaseLine}`;
}

function buildEvidenceManifest(
  evidenceFiles: Array<VerificationEvidenceFile & { finalName: string }>
): Record<string, unknown> {
  return {
    multipart: evidenceFiles.length > 1,
    partCount: evidenceFiles.length,
    files: evidenceFiles.map((file, index) => ({
      index: index + 1,
      name: file.finalName,
      sizeBytes: file.buffer.length,
      mimeType: file.mimeType ?? null,
    })),
  };
}

function buildDuplicateDigests(
  evidenceFiles: Array<VerificationEvidenceFile & { finalName: string }>
): Record<string, unknown> {
  const groups = new Map<
    string,
    Array<{
      packageIndex: number;
      partIndex: number | null;
      name: string;
      originalFileName: string | null;
      mimeType: string | null;
      sizeBytes: number;
    }>
  >();

  evidenceFiles.forEach((file, index) => {
    const sha256 =
      typeof file.sha256 === "string" && file.sha256.trim()
        ? file.sha256.trim().toLowerCase()
        : null;

    if (!sha256) return;

    const existing = groups.get(sha256) ?? [];
    existing.push({
      packageIndex: index + 1,
      partIndex: file.partIndex ?? null,
      name: file.finalName,
      originalFileName: file.originalFileName ?? null,
      mimeType: file.mimeType ?? null,
      sizeBytes: file.sizeBytes ?? file.buffer.length,
    });
    groups.set(sha256, existing);
  });

  const duplicateGroups = Array.from(groups.entries())
    .filter(([, files]) => files.length > 1)
    .map(([sha256, files]) => ({
      sha256,
      count: files.length,
      files,
    }));

  return {
    duplicatesDetected: duplicateGroups.length > 0,
    duplicateGroupCount: duplicateGroups.length,
    groups: duplicateGroups,
    note:
      duplicateGroups.length > 0
        ? "One or more packaged evidence files have identical SHA-256 digests. This may be legitimate duplicate content, but reviewers should confirm whether the duplication is expected."
        : "No duplicate SHA-256 digests were detected among packaged evidence files with available hashes.",
  };
}

function buildOriginalLinkage(
  evidenceFiles: Array<VerificationEvidenceFile & { finalName: string }>,
  metadata: VerificationPackageMetadata
): Record<string, unknown> {
  return {
    evidenceTitle: metadata.title ?? null,
    evidenceType: metadata.evidenceType ?? null,
    evidenceStatus: metadata.evidenceStatus ?? null,
    verificationStatus: metadata.verificationStatus ?? null,
    captureMethod: metadata.captureMethod ?? null,
    identityLevelSnapshot: metadata.identityLevelSnapshot ?? null,
    submittedByEmail: metadata.submittedByEmail ?? null,
    submittedByAuthProvider: metadata.submittedByAuthProvider ?? null,
    createdAtUtc: metadata.createdAtUtc ?? null,
    capturedAtUtc: metadata.capturedAtUtc ?? null,
    uploadedAtUtc: metadata.uploadedAtUtc ?? null,
    signedAtUtc: metadata.signedAtUtc ?? null,
    reportGeneratedAtUtc: metadata.reportGeneratedAtUtc ?? null,
    storageProtection: {
      region: metadata.storageRegion ?? null,
      immutable: metadata.storageImmutable ?? null,
      objectLockMode: metadata.storageObjectLockMode ?? null,
      retainUntilUtc: metadata.storageObjectLockRetainUntilUtc ?? null,
      legalHoldStatus: metadata.storageObjectLockLegalHoldStatus ?? null,
    },
    preservedOriginals: evidenceFiles.map((file, index) => ({
      packageIndex: index + 1,
      partIndex: file.partIndex ?? null,
      packageName: file.finalName,
      originalFileName: file.originalFileName ?? null,
      mimeType: file.mimeType ?? null,
      sizeBytes: file.sizeBytes ?? file.buffer.length,
      sha256: file.sha256 ?? null,
      storageBucket: file.storageBucket ?? null,
      storageKey: file.storageKey ?? null,
      storageRegion: file.storageRegion ?? metadata.storageRegion ?? null,
      objectLockMode:
        file.storageObjectLockMode ?? metadata.storageObjectLockMode ?? null,
      objectLockRetainUntilUtc:
        file.storageObjectLockRetainUntilUtc ??
        metadata.storageObjectLockRetainUntilUtc ??
        null,
      legalHoldStatus:
        file.storageObjectLockLegalHoldStatus ??
        metadata.storageObjectLockLegalHoldStatus ??
        null,
    })),
  };
}

function buildPackageManifest(params: {
  evidenceId?: string;
  reportVersion?: number;
  signingKeyId?: string;
  signingKeyVersion?: number;
  evidenceFiles: VerificationEvidenceFile[];
  anchorIncluded: boolean;
  anchorMode: AnchorMode;
  anchorProvider?: string | null;
  anchorPublicBaseUrl?: string | null;
  anchor?: AnchorPayload | null;
  hasTimestampToken: boolean;
  hasActualCertifications: boolean;
}): PackageManifest {
  return {
    packageType: "PROOVRA_VERIFICATION_PACKAGE",
    version: 3,
    evidenceId: params.evidenceId ?? null,
    reportVersion: params.reportVersion ?? null,
    signingKeyId: params.signingKeyId ?? null,
    signingKeyVersion:
      params.signingKeyVersion != null ? String(params.signingKeyVersion) : null,
    multipart: params.evidenceFiles.length > 1,
    fileCount: params.evidenceFiles.length,
    generatedAtUtc: new Date().toISOString(),
    anchorIncluded: params.anchorIncluded,
    anchorMode: params.anchorMode,
    anchorProvider: params.anchorProvider ?? null,
    anchorPublicBaseUrl: params.anchorPublicBaseUrl ?? null,
    externalPublicationAttached: Boolean(
      params.anchor?.published ||
        params.anchor?.receiptId ||
        params.anchor?.transactionId ||
        params.anchor?.publicUrl
    ),
    verificationProfile: "FORENSIC_INTEGRITY",
    contents: {
      evidenceFiles: true,
      fingerprint: true,
      signature: true,
      publicKey: true,
      custody: true,
      timestampToken: params.hasTimestampToken,
      anchor: params.anchorIncluded,
      evidenceManifest: params.evidenceFiles.length > 1,
      originalLinkage: true,
      duplicateDigests: true,
      forensicCustody: true,
      accessActivity: true,
      reportArtifact: true,
      courtReadiness: true,
      certificationTemplates: true,
      verifyHtml: true,
      readme: true,
      actualCertifications: params.hasActualCertifications,
    },
  };
}

function buildIntegritySummary(params: {
  evidenceFiles: VerificationEvidenceFile[];
  hasTimestampToken: boolean;
  anchorIncluded: boolean;
  anchorMode: AnchorMode;
}) {
  return {
    verificationProfile: "FORENSIC_INTEGRITY",
    containsFingerprint: true,
    containsSignature: true,
    containsPublicKey: true,
    containsCustody: true,
    containsTimestamp: params.hasTimestampToken,
    containsAnchor: params.anchorIncluded,
    anchorMode: params.anchorMode,
    multipart: params.evidenceFiles.length > 1,
    fileCount: params.evidenceFiles.length,
  };
}

function buildReadme(params: {
  evidenceFiles: VerificationEvidenceFile[];
  anchorMode: AnchorMode;
  anchorIncluded: boolean;
  anchorPublished: boolean;
  anchorProvider?: string | null;
  anchorPublicBaseUrl?: string | null;
  evidenceId?: string;
  reportVersion?: number;
  signingKeyId?: string;
  signingKeyVersion?: number;
hasReportArtifact: boolean;
hasTimestampToken: boolean;
timestampStatus?: string | null;
otsStatus?: string | null;
}): string {
  const multipart = params.evidenceFiles.length > 1;

    const timestampStatus = String(params.timestampStatus ?? "").toUpperCase();
  const otsStatus = String(params.otsStatus ?? "").toUpperCase();

  const timestampReadmeLine = params.hasTimestampToken
    ? `timestamp.tsr
Included in this package. RFC3161 timestamping material was attached for independent timestamp verification.`
    : `timestamp.tsr
Not included in this package. RFC3161 timestamp status: ${
        timestampStatus || "NOT_RECORDED"
      }. Integrity verification still relies on hashes, digital signature, preserved originals, custody continuity, and any available anchoring material.`;

  const anchorReadmeLine = params.anchorIncluded
    ? `anchor.json
Included in this package. This is anchor-ready or publication material depending on the configured anchoring mode.`
    : `anchor.json
Not included in this package. Public anchoring status: ${
        otsStatus || "NOT_RECORDED"
      }.`;

  return `PROOVRA Evidence Verification Package

PACKAGE OVERVIEW

This package allows independent verification of the recorded digital evidence state.

Evidence ID: ${safeText(params.evidenceId, "Not included")}
Report Version: ${
    typeof params.reportVersion === "number" ? String(params.reportVersion) : "Not included"
  }
Signing Key ID: ${safeText(params.signingKeyId, "Not included")}
Signing Key Version: ${
    typeof params.signingKeyVersion === "number"
      ? String(params.signingKeyVersion)
      : "Not included"
  }
Evidence Structure: ${multipart ? "Multipart evidence package" : "Single evidence item"}

Verification Profile: FORENSIC_INTEGRITY
Verification Status Note: Integrity materials may be present even when the record still requires legal or reviewer assessment.

FILES INCLUDED

${
  multipart
    ? `evidence-parts/
All evidence parts included in this multipart evidence set.

evidence-manifest.json
Lists all included evidence parts and sizes.`
    : `Original evidence file
The original uploaded evidence item is included at the root of this package.`
}

fingerprint.json
Canonical fingerprint used to generate the signature.

signature.txt
Ed25519 signature of the fingerprint hash material.

${timestampReadmeLine}

public-key.pem
Public key used to verify the signature.

custody.json
Chain of custody events recorded by the system.

${anchorReadmeLine}

package-manifest.json
Package metadata describing the verification bundle.

integrity-summary.json
High-level package integrity profile.

original-linkage.json
Links the included file(s), storage preservation details, and report artifact back to the preserved original record.

duplicate-digests.json
Lists any packaged evidence files that share the same SHA-256 digest. Duplicate digests do not automatically indicate tampering, but they should be reviewed when evaluating multipart evidence.

forensic-custody.json
Integrity-relevant system lifecycle events separated from later reviewer access activity.

access-activity.json
Viewer and package-access activity that should not be confused with forensic custody.

review-artifact-boundaries.json
Explains which artifact is the preserved original, which is the court/report artifact, and which files are reviewer representations.

court-admissibility-checklist.json
Structured readiness checklist describing what is present versus what still requires human/legal completion.

certifications/
Templates and declarations to support custodian or qualified-person certification workflows.

verify.html
Offline explanatory page describing package contents.

reports/
${params.hasReportArtifact ? "Includes the generated PROOVRA verification report bundled with this package." : "No embedded report artifact was attached."}

CUSTODY CHAIN INTERPRETATION

VERIFICATION STATUS INTERPRETATION

FORENSIC_INTEGRITY means the package contains technical integrity materials such as hashes, signatures, custody records, and available timestamp or anchoring materials.

The evidence verification status describes whether the record is ready for reliance or still requires review.

Technical integrity support does not by itself establish legal admissibility, authorship, factual truth, relevance, or evidentiary weight.

custody.json
Contains the complete immutable sequence of all recorded system events.

forensic-custody.json
Contains a curated subset of integrity-relevant events used for forensic review.

access-activity.json
Contains access, viewing, download, and verification activity that is not part of the forensic custody chronology shown in the PDF report.

Sequence numbers reflect the original immutable event log. Gaps in forensic views may appear where non-forensic events are excluded.

The complete custody-event chain can be independently inspected in custody.json and through the PROOVRA verification page.

HOW TO VERIFY

1) Extract the package.
2) Review fingerprint.json.
3) If this is a single-file evidence item:
   - Calculate SHA256 hash of the included evidence file.
   - Compare it with the fingerprint content and report materials.
4) If this is a multipart evidence item:
   - Review fingerprint.json and evidence-manifest.json.
   - Calculate SHA256 hash for each included evidence part.
   - Rebuild the multipart integrity state according to the platform rules.
5) Verify the Ed25519 signature using public-key.pem.
6) Verify the RFC3161 timestamp token using timestamp verification tools, if included.
7) Review custody.json and, where present, anchor.json.
8) Use original-linkage.json to tie every included file and the bundled report back to the preserved record.
9) Complete the certification templates inside certifications/ before using this package as a court-facing packet.

${buildAnchorReadmeSection({
  anchorMode: params.anchorMode,
  hasAnchorPayload: params.anchorIncluded,
  anchorPublished: params.anchorPublished,
  otsStatus: params.otsStatus,
  anchorProvider: params.anchorProvider,
  anchorPublicBaseUrl: params.anchorPublicBaseUrl,
})}

LEGAL NOTE

This package supports integrity verification of the recorded evidence state.
It does not independently establish authorship, truthfulness, legal admissibility,
or probative weight. Court-facing use typically also requires a custodian or qualified-person declaration.
`;
}

function buildArtifactBoundaries(params: {
  evidenceFiles: VerificationEvidenceFile[];
  reportIncluded: boolean;
}): Record<string, unknown> {
  return {
    preservedOriginal: {
      role: "primary evidentiary source",
      description:
        "The included evidence file(s) are the preserved original binary content used to compute the recorded hashes and fingerprint state.",
      fileCount: params.evidenceFiles.length,
    },
    reportArtifact: {
      included: params.reportIncluded,
      role: "review and court presentation artifact",
      description:
        "The bundled PDF report is a presentation artifact that summarizes the preserved evidence record and integrity materials. It is not a substitute for the preserved original binaries.",
    },
    reviewerRepresentations: {
      description:
        "Any preview image, PDF first-page render, text excerpt, or verify-page representation is reviewer-facing only and should not be treated as the preserved original.",
    },
  };
}

function buildCertificationSummary(params: {
  custodian?: VerificationCertificationRecord | null;
  qualifiedPerson?: VerificationCertificationRecord | null;
}) {
  return {
    custodian: params.custodian ?? null,
    qualifiedPerson: params.qualifiedPerson ?? null,
    hasActualCertifications:
      Boolean(params.custodian) || Boolean(params.qualifiedPerson),
  };
}

function buildCourtReadinessChecklist(params: {
  evidenceFiles: VerificationEvidenceFile[];
  hasTimestampToken: boolean;
  anchorIncluded: boolean;
  forensicCustodyCount: number;
  accessActivityCount: number;
  metadata: VerificationPackageMetadata;
  certifications?: {
    custodian?: VerificationCertificationRecord | null;
    qualifiedPerson?: VerificationCertificationRecord | null;
  };
}): Record<string, unknown> {
  return {
    packetProfile: "COURT_READY_SUPPORTING_PACKET",
    status: {
      preservedOriginalIncluded: params.evidenceFiles.length > 0,
      hashMaterialIncluded: true,
      signatureMaterialIncluded: true,
      publicKeyIncluded: true,
      timestampIncluded: params.hasTimestampToken,
      anchorIncluded: params.anchorIncluded,
      forensicCustodySeparated: true,
      accessActivitySeparated: true,
      reportArtifactIncluded: true,
      certificationTemplateIncluded: true,
      actualCustodianCertificationIncluded: Boolean(
        params.certifications?.custodian
      ),
      actualQualifiedPersonCertificationIncluded: Boolean(
        params.certifications?.qualifiedPerson
      ),
      systemProcessDeclarationIncluded: true,
      originalLinkageIncluded: true,
    },
    remainingHumanRequirements: [
      "Custodian declaration or qualified-person certification must be completed for court-facing use.",
      "Applicable business-record, electronic-process, notice, and jurisdiction-specific admissibility requirements must be assessed by counsel.",
      "The preserved original should remain available for deeper inspection, comparison, and evidentiary challenge.",
    ],
    context: {
      evidenceType: params.metadata.evidenceType ?? null,
      verificationStatus: params.metadata.verificationStatus ?? null,
      captureMethod: params.metadata.captureMethod ?? null,
      forensicCustodyEventCount: params.forensicCustodyCount,
      accessActivityEventCount: params.accessActivityCount,
    },
  };
}

function buildCustodianDeclarationTemplate(params: {
  evidenceId?: string;
  reportVersion?: number;
  metadata: VerificationPackageMetadata;
}): string {
  return `# PROOVRA Custodian Declaration Template

Use this template with counsel review before court-facing submission.

- Evidence ID: ${safeText(params.evidenceId, "Not included")}
- Report Version: ${
    typeof params.reportVersion === "number" ? String(params.reportVersion) : "Not included"
  }
- Evidence Title: ${safeText(params.metadata.title, "Not included")}

## Declarant

I, ________________________, declare under penalty of perjury that:

1. I am a records custodian or otherwise qualified person for the PROOVRA evidence record identified above.
2. The attached package was produced from the PROOVRA system in the regular course of the system's operation.
3. The preserved original evidence item(s), cryptographic hash material, signature record, timestamping records, and custody-event records were maintained by the system as part of its regular evidence-preservation workflow.
4. The included report artifact is a reviewer/court presentation summary derived from the preserved record and should be read together with the preserved original and technical materials.
5. The original evidence file(s) referenced in original-linkage.json are the same preserved item(s) used to compute the recorded integrity state reflected in this package.
6. The PROOVRA system is regularly used to preserve digital evidence and generate integrity records as part of a consistent and repeatable process.

Executed on: ________________________
Name: ________________________
Title/Role: ________________________
Signature: ________________________
`;
}

function buildQualifiedPersonTemplate(params: {
  evidenceId?: string;
  reportVersion?: number;
}): string {
  return `# PROOVRA Qualified-Person Certification Template

Use this template where a jurisdiction or evidentiary posture requires a qualified-person certification for electronic process or system-generated integrity records.

- Evidence ID: ${safeText(params.evidenceId, "Not included")}
- Report Version: ${
    typeof params.reportVersion === "number" ? String(params.reportVersion) : "Not included"
  }

## Certification

I, ________________________, certify that:

1. I am qualified to describe the PROOVRA evidence-preservation and integrity-verification process.
2. The accompanying package contains the preserved original evidence item(s) or parts, the recorded fingerprint and hash materials, signature verification materials, custody-event records, and associated timestamp/anchoring materials where available.
3. The process used to generate these materials operates in a consistent and documented manner designed to preserve and verify the recorded integrity state of the evidence.
4. The attached report is a presentation artifact and does not replace the preserved originals or the underlying technical materials.
5. The cryptographic methods used, including hashing and digital signatures, are standard publicly verifiable mechanisms designed to support integrity verification.
6. Independent verification of the integrity materials can be performed using the contents of the verification package without reliance on the PROOVRA platform.

Executed on: ________________________
Name: ________________________
Title/Role: ________________________
Signature: ________________________
`;
}

function buildSystemProcessDeclaration(params: {
  evidenceFiles: VerificationEvidenceFile[];
  metadata: VerificationPackageMetadata;
}): string {
  return `# PROOVRA System Process Declaration

This package documents a PROOVRA evidence record and the integrity-verification materials generated around it.

## Preserved originals

- Included preserved item count: ${params.evidenceFiles.length}
- Evidence type: ${safeText(params.metadata.evidenceType, "Not included")}
- Capture method snapshot: ${safeText(params.metadata.captureMethod, "Not included")}

## Integrity process

1. The preserved original file(s) are stored and referenced as the source evidence.
2. SHA-256 values are recorded for the preserved file or package parts.
3. A canonical fingerprint record is generated to describe the evidence state and package structure.
4. The fingerprint-derived material is digitally signed.
5. Timestamp and public anchoring records are attached where available.
6. System custody events are recorded separately from later access activity.
7. Reviewer-facing artifacts such as reports or previews are generated from, and linked back to, the preserved record.

## Timestamping and anchoring availability

Timestamping may not be present in all records depending on external provider availability. In such cases, integrity verification relies on recorded hashes, digital signatures, preserved original files, and custody-chain continuity.

Public anchoring may also be pending, unavailable, or completed after initial report generation depending on external network and calendar availability.

## Review posture

This declaration describes the process and artifact boundaries. It does not independently determine legal admissibility, authenticity disputes, authorship, or factual truth.
`;
}

function buildVerifyHtml(params: {
  evidenceFiles: VerificationEvidenceFile[];
  anchorIncluded: boolean;
  hasTimestampToken: boolean;
  timestampStatus?: string | null;
  otsStatus?: string | null;
  evidenceId?: string;
  reportVersion?: number;
}): string {
    const timestampText = (() => {
    const status = String(params.timestampStatus ?? "").toUpperCase();

    if (params.hasTimestampToken && status !== "FAILED") {
      return "RFC 3161 trusted timestamp token included.";
    }

    if (status === "FAILED") {
      return "RFC 3161 timestamping failed or was unavailable. No timestamp.tsr file is attached.";
    }

    return "No RFC 3161 timestamp token is attached.";
  })();

  const anchoringText = (() => {
    const status = String(params.otsStatus ?? "").toUpperCase();

    if (status === "ANCHORED") {
      return "Public anchoring is confirmed.";
    }

    if (status === "PENDING") {
      return "Public anchoring is pending confirmation.";
    }

    if (status === "FAILED") {
      return "Public anchoring failed or could not be completed.";
    }

    return params.anchorIncluded
      ? "Anchor material is included for review."
      : "No anchor material is attached.";
  })();
  const multipart = params.evidenceFiles.length > 1;
  const verificationUrl = params.evidenceId
    ? `https://app.proovra.com/verify/${params.evidenceId}`
    : null;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>PROOVRA Offline Verification Guide</title>
<style>
body{font-family:Arial,sans-serif;margin:0;background:#f4f6f5;color:#10201d;line-height:1.6}
.page{max-width:980px;margin:0 auto;padding:40px}
.header{border-left:6px solid #0b2e27;background:#fff;padding:22px 24px;border-radius:12px;margin-bottom:18px}
h1{margin:0 0 8px;color:#0b2e27;font-size:28px}
h2{margin:0 0 10px;color:#0b2e27;font-size:18px}
.card{background:#fff;border:1px solid rgba(12,28,25,.18);border-radius:12px;padding:18px 20px;margin-bottom:14px}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.kv{background:#f8faf9;border:1px solid rgba(12,28,25,.12);border-radius:10px;padding:12px}
.label{font-size:11px;font-weight:800;color:#56706a;text-transform:uppercase;letter-spacing:.06em}
.value{font-size:14px;font-weight:700;word-break:break-word}
code{background:#eef2f1;padding:2px 6px;border-radius:6px}
ol,ul{margin-top:8px}
.notice{border-left:5px solid rgba(96,66,24,.95);background:#fff;padding:16px 18px;border-radius:10px}
.small{color:#56706a;font-size:13px}
a{color:#0b2e27;font-weight:700}
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <h1>PROOVRA Offline Verification Guide</h1>
    <div class="small">
      This file explains how to interpret and verify the contents of this verification package without relying on live PROOVRA platform access.
    </div>
  </div>

  <div class="grid">
    <div class="kv">
      <div class="label">Evidence ID</div>
      <div class="value">${safeText(params.evidenceId, "Not included")}</div>
    </div>
    <div class="kv">
      <div class="label">Report Version</div>
      <div class="value">${
        typeof params.reportVersion === "number"
          ? String(params.reportVersion)
          : "Not included"
      }</div>
    </div>
    <div class="kv">
      <div class="label">Integrity Status</div>
      <div class="value">Materials Available</div>
    </div>
  </div>

  <div class="card">
    <h2>1. Package Summary</h2>
    <ul>
      <li>Structure: ${multipart ? "Multipart evidence package" : "Single evidence item"}</li>
      <li>Evidence file count: ${params.evidenceFiles.length}</li>
<li>Timestamp: ${timestampText}</li>
<li>Anchoring: ${anchoringText}</li>
    </ul>
  </div>

  <div class="card">
    <h2>2. Original vs Report Artifact</h2>
    <p>
      The preserved original evidence file(s) are the primary evidentiary source.
      The PDF report, previews, and this HTML guide are reviewer-facing artifacts.
    </p>
    <p>
      Open <code>original-linkage.json</code> to map each packaged file to its original filename,
      storage reference, SHA-256 digest, and preservation metadata.
    </p>
  </div>

  <div class="card">
    <h2>3. How to Verify</h2>
    <ol>
      <li>Review <code>package-manifest.json</code> and <code>integrity-summary.json</code>.</li>
      <li>Hash the included evidence file(s) with SHA-256.</li>
      <li>Compare computed hashes against <code>original-linkage.json</code> and <code>fingerprint.json</code>.</li>
      <li>Verify <code>signature.txt</code> using <code>public-key.pem</code>.</li>
      <li>If present, verify <code>timestamp.tsr</code> with RFC3161 timestamp verification tools.</li>
      <li>If present, review <code>anchor.json</code> for anchoring or publication material.</li>
    </ol>
  </div>

    <div class="card">
    <h2>4. Timestamping and Anchoring Interpretation</h2>
    <p>
      RFC 3161 timestamping and public anchoring are independent integrity-support layers.
      A missing or failed RFC 3161 timestamp does not invalidate recorded hashes, digital signatures,
      custody-chain continuity, or confirmed anchoring material.
    </p>
    <p>
      If public anchoring is pending, reviewers should treat the anchoring layer as not yet fully confirmed
      until the verification page or package materials show completion.
    </p>
  </div>

  <div class="card">
    <h2>5. Custody Explanation</h2>
    <p>
      <code>custody.json</code> contains the complete system event chain.
      <code>forensic-custody.json</code> contains a filtered subset used for forensic review.
      <code>access-activity.json</code> contains later access, viewing, download, or verification activity.
    </p>
    <p>
      Full event continuity can be checked by verifying that each event's <code>eventHash</code>
      matches the next event's <code>prevEventHash</code>.
    </p>
  </div>

  <div class="notice">
    <h2>6. Legal Boundary</h2>
    <p>
      This package supports technical verification of recorded integrity, preservation state,
      signatures, hashes, custody continuity, and available timestamp or anchoring materials.
    </p>
    <p>
      It does not independently establish factual truth, authorship, intent, legal admissibility,
      relevance, or evidentiary weight.
    </p>
  </div>

  ${
    verificationUrl
      ? `<div class="card">
          <h2>Interactive Verification</h2>
          <p>For the live reviewer interface, visit:</p>
          <p><a href="${verificationUrl}">${verificationUrl}</a></p>
        </div>`
      : ""
  }
</div>
</body>
</html>`;
}

export async function createVerificationPackage(data: {
  evidenceBuffer?: Buffer;
  evidenceFiles?: VerificationEvidenceFile[];
  fingerprint: string;
  signature: string;
  timestampToken: string | null;
  publicKey: string;
  custody: unknown;
  evidenceId?: string;
  reportVersion?: number;
  signingKeyId?: string;
  signingKeyVersion?: number;
  anchor?: AnchorPayload | null;
  anchorMode?: AnchorMode | null;
  anchorProvider?: string | null;
  anchorPublicBaseUrl?: string | null;
  certifications?: {
    custodian?: VerificationCertificationRecord | null;
    qualifiedPerson?: VerificationCertificationRecord | null;
  };
  reportPdf?: Buffer | null;
  reportFileName?: string | null;
  metadata?: VerificationPackageMetadata;
}) {
  return new Promise<Buffer>((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 9 } });
    const stream = new PassThrough();
    const chunks: Buffer[] = [];

    let settled = false;

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const succeed = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    };

    stream.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    stream.on("end", succeed);
    stream.on("error", fail);
    archive.on("error", fail);
    archive.on("warning", (warning) => {
      const code = (warning as Error & { code?: string }).code;
      if (code === "ENOENT") {
        console.warn("[ZIP] Non-fatal archiver warning:", warning);
        return;
      }
      fail(warning);
    });

    archive.pipe(stream);

    const evidenceFiles: VerificationEvidenceFile[] =
      Array.isArray(data.evidenceFiles) && data.evidenceFiles.length > 0
        ? data.evidenceFiles.filter(
            (file): file is VerificationEvidenceFile =>
              Boolean(file) &&
              typeof file.name === "string" &&
              Buffer.isBuffer(file.buffer)
          )
        : data.evidenceBuffer
          ? [{ name: "evidence-file", buffer: data.evidenceBuffer }]
          : [];

    if (evidenceFiles.length === 0) {
      fail(new Error("Verification package requires at least one evidence file"));
      return;
    }

    const metadata = data.metadata ?? {};
    const evidenceFilesWithFinalName = evidenceFiles.map((file, index) => {
      const fileOrder = index + 1;
      const totalParts = evidenceFiles.length;
      const finalName = buildEvidencePackageFileName({
        evidenceTitle: metadata.title ?? null,
        originalFileName: file.originalFileName ?? file.name,
        evidenceType: metadata.evidenceType ?? null,
        mimeType: file.mimeType ?? null,
        captureMethod: metadata.captureMethod ?? null,
        capturedAtUtc: metadata.capturedAtUtc ?? null,
        uploadedAtUtc: metadata.uploadedAtUtc ?? null,
        partIndex: file.partIndex ?? null,
        totalParts,
        fileOrder,
      });

      return {
        ...file,
        finalName,
      };
    });

    const anchorMode = normalizeAnchorMode(data.anchorMode);
    const anchorIncluded = Boolean(data.anchor);
    const hasTimestampToken = Boolean(data.timestampToken);
    const certificationSummary = buildCertificationSummary({
      custodian: data.certifications?.custodian ?? null,
      qualifiedPerson: data.certifications?.qualifiedPerson ?? null,
    });
    const custodySplit = splitCustodyEvents(data.custody);

    if (evidenceFilesWithFinalName.length === 1) {
      const file = evidenceFilesWithFinalName[0];
      archive.append(file.buffer, {
        name: file.finalName,
      });
    } else {
      evidenceFilesWithFinalName.forEach((file) => {
        archive.append(file.buffer, {
          name: `evidence-parts/${file.finalName}`,
        });
      });

      archive.append(
        JSON.stringify(buildEvidenceManifest(evidenceFilesWithFinalName), null, 2),
        {
          name: "evidence-manifest.json",
        }
      );
    }

    archive.append(data.fingerprint, {
      name: "fingerprint.json",
    });

    archive.append(data.signature, {
      name: "signature.txt",
    });

    if (data.timestampToken) {
      archive.append(data.timestampToken, {
        name: "timestamp.tsr",
      });
    }

    archive.append(data.publicKey, {
      name: "public-key.pem",
    });

    archive.append(JSON.stringify(data.custody, null, 2), {
      name: "custody.json",
    });

    archive.append(JSON.stringify(custodySplit.forensic, null, 2), {
      name: "forensic-custody.json",
    });

    archive.append(JSON.stringify(custodySplit.access, null, 2), {
      name: "access-activity.json",
    });

    if (data.anchor) {
      archive.append(JSON.stringify(data.anchor, null, 2), {
        name: "anchor.json",
      });
    }

const packageManifest = buildPackageManifest({
  evidenceId: data.evidenceId,
  reportVersion: data.reportVersion,
  signingKeyId: data.signingKeyId,
  signingKeyVersion: data.signingKeyVersion,
  evidenceFiles: evidenceFilesWithFinalName,
  anchorIncluded,
  anchorMode,
  anchorProvider: data.anchorProvider,
  anchorPublicBaseUrl: data.anchorPublicBaseUrl,
  anchor: data.anchor ?? null,
  hasTimestampToken,
  hasActualCertifications: certificationSummary.hasActualCertifications,
});

    archive.append(JSON.stringify(packageManifest, null, 2), {
      name: "package-manifest.json",
    });

    archive.append(
      JSON.stringify(
        buildIntegritySummary({
          evidenceFiles: evidenceFilesWithFinalName,
          hasTimestampToken,
          anchorIncluded,
          anchorMode,
        }),
        null,
        2
      ),
      {
        name: "integrity-summary.json",
      }
    );

    archive.append(
      JSON.stringify(buildOriginalLinkage(evidenceFilesWithFinalName, metadata), null, 2),
      {
        name: "original-linkage.json",
      }
    );

    archive.append(
  JSON.stringify(buildDuplicateDigests(evidenceFilesWithFinalName), null, 2),
  {
    name: "duplicate-digests.json",
  }
);

    archive.append(
      JSON.stringify(
        buildArtifactBoundaries({
          evidenceFiles: evidenceFilesWithFinalName,
          reportIncluded: Boolean(data.reportPdf),
        }),
        null,
        2
      ),
      {
        name: "review-artifact-boundaries.json",
      }
    );

    archive.append(
      JSON.stringify(
        buildCourtReadinessChecklist({
          evidenceFiles: evidenceFilesWithFinalName,
          hasTimestampToken,
          anchorIncluded,
          forensicCustodyCount: custodySplit.forensic.length,
          accessActivityCount: custodySplit.access.length,
          metadata,
          certifications: data.certifications,
        }),
        null,
        2
      ),
      {
        name: "court-admissibility-checklist.json",
      }
    );

    archive.append(
buildReadme({
  evidenceFiles,
  anchorMode,
  anchorIncluded,
  anchorPublished: Boolean(
    data.anchor?.published ||
      data.anchor?.receiptId ||
      data.anchor?.transactionId ||
      data.anchor?.publicUrl ||
      data.anchor?.anchoredAtUtc
  ),
  anchorProvider: data.anchorProvider,
  anchorPublicBaseUrl: data.anchorPublicBaseUrl,
  evidenceId: data.evidenceId,
  reportVersion: data.reportVersion,
  signingKeyId: data.signingKeyId,
  signingKeyVersion: data.signingKeyVersion,
  hasReportArtifact: Boolean(data.reportPdf),
  hasTimestampToken,
  timestampStatus: metadata.tsaStatus ?? null,
  otsStatus: metadata.otsStatus ?? null,
}),
      {
        name: "README.txt",
      }
    );

    archive.append(
      buildCustodianDeclarationTemplate({
        evidenceId: data.evidenceId,
        reportVersion: data.reportVersion,
        metadata,
      }),
      { name: "certifications/custodian-declaration-template.md" }
    );

    archive.append(
      buildQualifiedPersonTemplate({
        evidenceId: data.evidenceId,
        reportVersion: data.reportVersion,
      }),
      { name: "certifications/qualified-person-certification-template.md" }
    );

    archive.append(
      buildSystemProcessDeclaration({
        evidenceFiles,
        metadata,
      }),
      { name: "certifications/system-process-declaration.md" }
    );

    if (data.certifications?.custodian) {
      archive.append(
        JSON.stringify(data.certifications.custodian, null, 2),
        {
          name: "certifications/custodian-record.json",
        }
      );
    }

    if (data.certifications?.qualifiedPerson) {
      archive.append(
        JSON.stringify(data.certifications.qualifiedPerson, null, 2),
        {
          name: "certifications/qualified-person-record.json",
        }
      );
    }

    if (certificationSummary.hasActualCertifications) {
      archive.append(JSON.stringify(certificationSummary, null, 2), {
        name: "certifications/certification-summary.json",
      });
    }

    archive.append(
      buildVerifyHtml({
        evidenceFiles,
        anchorIncluded,
        hasTimestampToken,
        timestampStatus: metadata.tsaStatus ?? null,
        otsStatus: metadata.otsStatus ?? null,
        evidenceId: data.evidenceId,
        reportVersion: data.reportVersion,
      }),
            {
        name: "verify.html",
      }
    );

    if (data.reportPdf) {
      archive.append(data.reportPdf, {
        name: `reports/${normalizeFileName(
          data.reportFileName ?? `proovra-report-v${data.reportVersion ?? "latest"}.pdf`,
          "proovra-report.pdf"
        )}`,
      });
    }

    archive.finalize().catch(fail);
  });
}
