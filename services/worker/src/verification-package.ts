import archiver from "archiver";
import path from "node:path";
import { createHash, sign as cryptoSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { PassThrough } from "stream";
import {
  CAPTURE_LOCATION_CONTEXT_DESCRIPTION,
  CAPTURE_LOCATION_LEGAL_BOUNDARY,
  CAPTURE_LOCATION_SOURCE_LABEL,
  TRUST_DECISION_LEGAL_BOUNDARY,
  buildCaptureLocationExternalMapUrl,
  getReviewerArtifactRoleLabel,
  getReviewerEvidenceCategories,
  getReviewerEvidenceTypeLabel,
  hasCaptureLocationMetadata,
  isAccessCustodyEventType,
  serializeTrustDecisionForReviewerPackage,
} from "@proovra/shared";
import {
  PROOVRA_MULTIPART_LEGAL_BOUNDARY_NOTE,
  PROOVRA_MULTIPART_RECOMPUTATION_NOTE,
  PROOVRA_MULTIPART_REVIEWER_EXPLANATION,
} from "@proovra/shared-evidence-presentation";
import type { ReportTrustDecision } from "./report-v2/types.js";
import { renderCaptureLocationMapPreviewPng } from "./capture-location-map.js";

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
  artifactRole?: "primary_evidence" | "supporting_evidence" | "attachment" | null;
  artifactRoleSource?: string | null;
  checklistStepId?: string | null;
  checklistStepLabel?: string | null;
  sourceLabel?: string | null;
};

type VerificationPackageArtifactPresence = {
  manifestPresent: boolean;
  signedManifestPresent: boolean;
  checksumIndexPresent: boolean;
  offlineVerifierIncluded: boolean;
  auditExportIncluded: boolean;
  custodyExportIncluded: boolean;
  accessExportIncluded: boolean;
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

type AnchorMode =
  | "not_configured"
  | "pending_public_anchor"
  | "anchored"
  | "failed";

type AnchorPayload = {
  version: 1;
  evidenceId: string;
  reportVersion: number;
  fileSha256: string;
  fingerprintHash: string;
  lastEventHash: string | null;
  anchorHash: string;
  generatedAtUtc: string;
  status?: AnchorMode;
  statusLabel?: string;
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
  // Phase D Blocker 5 — multipart hash semantics in the package manifest
  // so the offline verifier and any downstream tool can interpret
  // evidence.fileSha256 correctly without out-of-band knowledge.
  hashSemantics?: string | null;
  fileSha256Label?: string | null;
  multipartManifestSha256?: string | null;
  multipartManifestRecomputationMethod?: string | null;
  rawEvidenceType?: string | null;
  rawEvidenceTypeSource?: string | null;
  reviewerEvidenceType?: string | null;
  evidenceStructure?: string | null;
  itemCount?: number | null;
  contentCategories?: string[] | null;
  fileCount: number;
  generatedAtUtc: string;
  accessSnapshotGeneratedAtUtc?: string | null;
  anchorIncluded: boolean;
  anchorMode: AnchorMode;
  anchorStatusLabel?: string | null;
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
    trustDecision: boolean;
    packageChecksums: boolean;
    signedPackageManifest: boolean;
    verificationInstructions: boolean;
    verificationScript: boolean;
    caseMetadata: boolean;
    auditAccessReport: boolean;
    captureContext: boolean;
    captureContextMapPreview: boolean;
  };
};

type VerificationPackageMetadata = {
  title?: string | null;
  rawEvidenceType?: string | null;
  rawEvidenceTypeSource?: string | null;
  reviewerEvidenceType?: string | null;
  evidenceStructure?: string | null;
  itemCount?: number | null;
  // Phase D Blocker 5 — multipart hash semantics surfaced as first-class
  // package metadata. Reviewers must be able to tell from the package
  // alone whether evidence.fileSha256 is the SHA-256 of an original file
  // (single_file) or a synthetic composite of per-part SHA-256s
  // (multipart_composite, with multipartManifestSha256 reproducible).
  hashSemantics?: string | null;
  multipartManifestSha256?: string | null;
  fileSha256Label?: string | null;
  contentCategories?: string[] | null;
  imageCount?: number | null;
  videoCount?: number | null;
  audioCount?: number | null;
  pdfCount?: number | null;
  textCount?: number | null;
  otherCount?: number | null;
  mimeType?: string | null;
  evidenceStatus?: string | null;
  verificationStatus?: string | null;
  captureMethod?: string | null;
  identityLevelSnapshot?: string | null;
  submittedByEmail?: string | null;
  submittedByAuthProvider?: string | null;
  createdAtUtc?: string | null;
  capturedAtUtc?: string | null;
  deviceTimeIso?: string | null;
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
  verificationPackageVersion?: number | null;
  recordedIntegrityVerifiedAtUtc?: string | null;
  caseId?: string | null;
  caseName?: string | null;
  matterNumber?: string | null;
  clientName?: string | null;
  reviewer?: string | null;
  jurisdiction?: string | null;
  retentionPolicy?: string | null;
  workspaceId?: string | null;
  organizationId?: string | null;
  teamId?: string | null;
  ownerUserId?: string | null;
  captureLocation?: {
    lat?: number | null;
    lng?: number | null;
    accuracyMeters?: number | null;
  } | null;
};

type CustodyEventRecord = {
  sequence?: number | null;
  atUtc?: string | null;
  eventType?: string | null;
  payload?: unknown;
  prevEventHash?: string | null;
  eventHash?: string | null;
};

type PackageEntry = {
  name: string;
  buffer: Buffer;
  contentType?: string;
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

    if (isAccessCustodyEventType(String(event.eventType ?? ""))) {
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
  const normalized =
    typeof mimeType === "string" ? mimeType.trim().toLowerCase() : "";
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

/**
 * Phase D Blocker 2 — strip directory components before exposing a filename
 * through the verification package JSON. Defensive against legacy
 * EvidencePart rows that may still carry raw "Folder/Subfolder/file.ext"
 * paths persisted before the API-side sanitization landed.
 *
 * Returns null on null/empty/path-only inputs.
 */
function stripPathForPackageExposure(
  value: string | null | undefined
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\\/g, "/");
  const segments = normalized.split("/");
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const seg = segments[i]?.trim();
    if (!seg) continue;
    if (seg === "." || seg === "..") continue;
    // Drop leading dots so ".env" / "..." don't display as hidden.
    const noLeadingDots = seg.replace(/^\.+/, "").trim();
    if (!noLeadingDots) continue;
    return noLeadingDots.length > 255
      ? noLeadingDots.slice(0, 254) + "…"
      : noLeadingDots;
  }
  return null;
}

function sanitizeFileBaseName(value: string, maxLen = 120): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
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
  const typeLabel =
    typeof params.evidenceType === "string" && params.evidenceType.trim()
      ? params.evidenceType.trim().toLowerCase()
      : params.mimeType
        ? params.mimeType.split("/")[0]
        : "evidence";

  const methodLabel =
    typeof params.captureMethod === "string"
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
  const timestamp = formatTimestampForFile(
    params.capturedAtUtc ?? params.uploadedAtUtc
  );
  const hasTitle =
    typeof params.evidenceTitle === "string" &&
    params.evidenceTitle.trim().length > 0;
  const hasOriginal =
    typeof params.originalFileName === "string" &&
    params.originalFileName.trim().length > 0;

  const originalNameBase = hasOriginal
    ? sanitizeFileBaseName(
        path.basename(
          params.originalFileName!.trim(),
          path.extname(params.originalFileName!)
        )
      )
    : null;

  const titleBase = hasTitle
    ? sanitizeFileBaseName(params.evidenceTitle!.trim())
    : null;

  const descriptor = deriveEvidenceDescriptor({
    evidenceType: params.evidenceType,
    mimeType: params.mimeType,
    captureMethod: params.captureMethod,
  });

  const partLabel =
    params.totalParts > 1
      ? `part-${String(params.partIndex ?? params.fileOrder).padStart(2, "0")}`
      : null;

  let baseName: string;

  if (params.totalParts > 1) {
    if (originalNameBase) {
      baseName = normalizeFileNameSegments([originalNameBase, timestamp]);
    } else if (titleBase) {
      baseName = normalizeFileNameSegments([titleBase, partLabel, timestamp]);
    } else {
      baseName = normalizeFileNameSegments([descriptor, partLabel, timestamp]);
    }
  } else if (titleBase) {
    baseName = normalizeFileNameSegments([titleBase, timestamp]);
  } else if (originalNameBase) {
    baseName = normalizeFileNameSegments([originalNameBase, timestamp]);
  } else {
    baseName = normalizeFileNameSegments([descriptor, timestamp]);
  }

  if (!baseName) {
    baseName = timestamp ? `evidence-${timestamp}` : "evidence-item";
  }

  if (params.totalParts > 1) {
    const orderPrefix = String(params.fileOrder).padStart(
      String(params.totalParts).length,
      "0"
    );
    baseName = `${orderPrefix}-${baseName}`;
  }

  return `${baseName}.${extension}`;
}

function normalizeAnchorMode(value: string | null | undefined): AnchorMode {
  const raw = String(value ?? "").trim().toLowerCase();
  switch (raw) {
    case "anchored":
    case "active":
      return "anchored";
    case "failed":
      return "failed";
    case "not_configured":
    case "off":
      return "not_configured";
    case "pending_public_anchor":
    case "ready":
    default:
      return "pending_public_anchor";
  }
}

function getAnchorStatusLabel(
  mode: AnchorMode,
  options?: { bitcoinTxid?: string | null }
): string {
  // Truthful Bitcoin-anchoring label: only say "Bitcoin anchoring verified"
  // when the OTS proof has progressed to ANCHORED AND a valid Bitcoin
  // transaction id is recorded. The previous label "Public anchoring verified"
  // could appear before the Bitcoin upgrade pass attached a txid.
  const hasTxid =
    typeof options?.bitcoinTxid === "string" &&
    /^[a-f0-9]{64}$/i.test(options.bitcoinTxid.trim());

  switch (mode) {
    case "anchored":
      return hasTxid
        ? "Bitcoin anchoring verified"
        : "OpenTimestamps proof present; public anchoring pending";
    case "failed":
      return "OpenTimestamps anchoring failed";
    case "not_configured":
      return "OpenTimestamps not configured";
    case "pending_public_anchor":
    default:
      return "OpenTimestamps proof present; public anchoring pending";
  }
}

function derivePackageAnchorMode(params: {
  rawMode?: string | null;
  anchor?: AnchorPayload | null;
  trustDecision: ReportTrustDecision;
}): AnchorMode {
  const normalizedRawMode = normalizeAnchorMode(params.rawMode);
  const anchoringSignal = params.trustDecision.signals.find(
    (signal) => signal.key === "public_anchoring"
  );
  const hasPublicAnchorMaterial = Boolean(
    params.anchor?.receiptId ||
      params.anchor?.transactionId ||
      params.anchor?.publicUrl ||
      params.anchor?.anchoredAtUtc
  );

  if (anchoringSignal?.status === "failed") {
    return "failed";
  }

  if (anchoringSignal?.status === "passed") {
    return "anchored";
  }

  if (
    anchoringSignal?.status === "pending" ||
    anchoringSignal?.status === "partial" ||
    normalizedRawMode === "pending_public_anchor"
  ) {
    return "pending_public_anchor";
  }

  if (normalizedRawMode === "failed") {
    return "failed";
  }

  if (normalizedRawMode === "anchored") {
    return hasPublicAnchorMaterial ? "anchored" : "pending_public_anchor";
  }

  return "not_configured";
}

function safeText(value: string | null | undefined, fallback = "N/A"): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

function buildReviewerEvidenceMetadata(metadata: VerificationPackageMetadata) {
  return {
    rawEvidenceType: metadata.rawEvidenceType ?? null,
    rawEvidenceTypeSource: metadata.rawEvidenceTypeSource ?? null,
    reviewerEvidenceType:
      metadata.reviewerEvidenceType ??
      getReviewerEvidenceTypeLabel({
        itemCount: metadata.itemCount ?? null,
        structure:
          metadata.evidenceStructure === "Multipart evidence package"
            ? "multipart"
            : metadata.evidenceStructure === "Single evidence item"
              ? "single"
              : null,
        imageCount: metadata.imageCount ?? null,
        videoCount: metadata.videoCount ?? null,
        audioCount: metadata.audioCount ?? null,
        pdfCount: metadata.pdfCount ?? null,
        textCount: metadata.textCount ?? null,
        otherCount: metadata.otherCount ?? null,
        evidenceType: metadata.rawEvidenceType ?? null,
        mimeType: metadata.mimeType ?? null,
      }),
    evidenceStructure:
      metadata.evidenceStructure ??
      ((metadata.itemCount ?? 0) > 1
        ? "Multipart evidence package"
        : "Single evidence item"),
    itemCount: metadata.itemCount ?? null,
    contentCategories:
      metadata.contentCategories ??
      getReviewerEvidenceCategories({
        itemCount: metadata.itemCount ?? null,
        structure:
          metadata.evidenceStructure === "Multipart evidence package"
            ? "multipart"
            : metadata.evidenceStructure === "Single evidence item"
              ? "single"
              : null,
        imageCount: metadata.imageCount ?? null,
        videoCount: metadata.videoCount ?? null,
        audioCount: metadata.audioCount ?? null,
        pdfCount: metadata.pdfCount ?? null,
        textCount: metadata.textCount ?? null,
        otherCount: metadata.otherCount ?? null,
        evidenceType: metadata.rawEvidenceType ?? null,
        mimeType: metadata.mimeType ?? null,
      }),
    imageCount: metadata.imageCount ?? null,
    videoCount: metadata.videoCount ?? null,
    audioCount: metadata.audioCount ?? null,
    pdfCount: metadata.pdfCount ?? null,
    textCount: metadata.textCount ?? null,
    otherCount: metadata.otherCount ?? null,
  };
}

function sha256Hex(bufferOrText: Buffer | string): string {
  return createHash("sha256").update(bufferOrText).digest("hex");
}

function readPackageSigningPrivateKeyPem(): string {
  const privateKeyPath =
    process.env.PACKAGE_SIGNING_PRIVATE_KEY_PATH?.trim() ||
    process.env.SIGNING_PRIVATE_KEY_PATH?.trim();

  if (!privateKeyPath) {
    throw new Error("PACKAGE_SIGNING_PRIVATE_KEY_PATH or SIGNING_PRIVATE_KEY_PATH is not set");
  }

  const resolvedPath = path.isAbsolute(privateKeyPath)
    ? privateKeyPath
    : path.resolve(process.cwd(), privateKeyPath);

  return readFileSync(resolvedPath, "utf8");
}

function readPackageSigningPublicKeyPem(): string {
  const publicKeyPath =
    process.env.PACKAGE_SIGNING_PUBLIC_KEY_PATH?.trim() ||
    process.env.SIGNING_PUBLIC_KEY_PATH?.trim();

  if (!publicKeyPath) {
    throw new Error("PACKAGE_SIGNING_PUBLIC_KEY_PATH or SIGNING_PUBLIC_KEY_PATH is not set");
  }

  const resolvedPath = path.isAbsolute(publicKeyPath)
    ? publicKeyPath
    : path.resolve(process.cwd(), publicKeyPath);

  return readFileSync(resolvedPath, "utf8");
}

function signPackageManifestDigest(digestHex: string) {
  if (!/^[a-f0-9]{64}$/i.test(digestHex)) {
    throw new Error("Package manifest digest must be a SHA-256 hex digest");
  }

const privateKeyPem = readPackageSigningPrivateKeyPem();
  const signature = cryptoSign(null, Buffer.from(digestHex, "hex"), privateKeyPem);

  return {
    signatureBase64: signature.toString("base64"),
    signingKeyId:
      process.env.PACKAGE_SIGNING_KEY_ID?.trim() ||
      process.env.SIGNING_KEY_ID?.trim() ||
      "dw_ed25519",
    signingKeyVersion:
      process.env.PACKAGE_SIGNING_KEY_VERSION?.trim() ||
      process.env.SIGNING_KEY_VERSION?.trim() ||
      "1",
  };
}

function jsonBuffer(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2), "utf8");
}

function textBuffer(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

function appendPackageEntry(
  archive: archiver.Archiver,
  entries: PackageEntry[],
  name: string,
  buffer: Buffer,
  contentType?: string
): void {
  entries.push(
    contentType === undefined ? { name, buffer } : { name, buffer, contentType }
  );
  archive.append(buffer, { name });
}

function buildPackageChecksums(entries: PackageEntry[]) {
  return {
    schema: "PROOVRA_PACKAGE_CHECKSUMS",
    version: 1,
    generatedAtUtc: new Date().toISOString(),
    algorithm: "SHA-256",
    fileCount: entries.length,
    files: entries
      .map((entry) => ({
        path: entry.name,
        sizeBytes: entry.buffer.length,
        sha256: sha256Hex(entry.buffer),
        contentType: entry.contentType ?? null,
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function buildSignedManifest(params: {
  manifestBuffer: Buffer;
  signingKeyId?: string | null;
  signingKeyVersion?: number | null;
}) {
  const manifestSha256 = sha256Hex(params.manifestBuffer);
  const signature = signPackageManifestDigest(manifestSha256);

  return {
    schema: "PROOVRA_SIGNED_PACKAGE_MANIFEST",
    version: 2,
    generatedAtUtc: new Date().toISOString(),
    signatureAlgorithm: "ED25519",
    digestAlgorithm: "SHA-256",
    signingKeyId: signature.signingKeyId ?? params.signingKeyId ?? null,
    signingKeyVersion:
      signature.signingKeyVersion ??
      (params.signingKeyVersion != null ? String(params.signingKeyVersion) : null),
    manifestFile: "package-manifest.json",
    manifestSha256,
    publicKeyFile: "package-manifest-public-key.pem",
    signatureBase64: signature.signatureBase64,
    signatureInput:
      "SHA-256 digest bytes of package-manifest.json signed with Ed25519 private key",
    note:
      "This is a private-key Ed25519 cryptographic signature over the SHA-256 digest of package-manifest.json.",
  };
}

function buildCaseMetadata(
  metadata: VerificationPackageMetadata,
  evidenceId?: string | null
) {
  const reviewerEvidence = buildReviewerEvidenceMetadata(metadata);

  return {
    schema: "PROOVRA_CASE_METADATA",
    version: 1,
    generatedAtUtc: new Date().toISOString(),
    evidence: {
      evidenceId: evidenceId ?? null,
      title: metadata.title ?? null,
      rawEvidenceType: reviewerEvidence.rawEvidenceType,
      rawEvidenceTypeSource: reviewerEvidence.rawEvidenceTypeSource,
      reviewerEvidenceType: reviewerEvidence.reviewerEvidenceType,
      evidenceStructure: reviewerEvidence.evidenceStructure,
      itemCount: reviewerEvidence.itemCount,
      contentCategories: reviewerEvidence.contentCategories,
      imageCount: reviewerEvidence.imageCount,
      videoCount: reviewerEvidence.videoCount,
      audioCount: reviewerEvidence.audioCount,
      pdfCount: reviewerEvidence.pdfCount,
      textCount: reviewerEvidence.textCount,
      otherCount: reviewerEvidence.otherCount,
      mimeType: metadata.mimeType ?? null,
      evidenceStatus: metadata.evidenceStatus ?? null,
      verificationStatus: metadata.verificationStatus ?? null,
      captureMethod: metadata.captureMethod ?? null,
    },
    case: {
      caseId: metadata.caseId ?? null,
      caseName: metadata.caseName ?? null,
      matterNumber: metadata.matterNumber ?? null,
      clientName: metadata.clientName ?? null,
      reviewer: metadata.reviewer ?? null,
      jurisdiction: metadata.jurisdiction ?? null,
    },
    workspace: {
      ownerUserId: metadata.ownerUserId ?? null,
      teamId: metadata.teamId ?? null,
      workspaceId: metadata.workspaceId ?? null,
      organizationId: metadata.organizationId ?? null,
      retentionPolicy: metadata.retentionPolicy ?? null,
    },
    submitter: {
      submittedByEmail: metadata.submittedByEmail ?? null,
      submittedByAuthProvider: metadata.submittedByAuthProvider ?? null,
      identityLevelSnapshot: metadata.identityLevelSnapshot ?? null,
    },
    timestamps: {
      createdAtUtc: metadata.createdAtUtc ?? null,
      capturedAtUtc: metadata.capturedAtUtc ?? null,
      deviceTimeIso: metadata.deviceTimeIso ?? null,
      uploadedAtUtc: metadata.uploadedAtUtc ?? null,
      signedAtUtc: metadata.signedAtUtc ?? null,
      reportGeneratedAtUtc: metadata.reportGeneratedAtUtc ?? null,
      accessSnapshotGeneratedAtUtc: new Date().toISOString(),
      recordedIntegrityVerifiedAtUtc:
        metadata.recordedIntegrityVerifiedAtUtc ?? null,
    },
    captureLocation: metadata.captureLocation
      ? {
          lat: metadata.captureLocation.lat ?? null,
          lng: metadata.captureLocation.lng ?? null,
          accuracyMeters: metadata.captureLocation.accuracyMeters ?? null,
          legalBoundary: CAPTURE_LOCATION_LEGAL_BOUNDARY,
        }
      : null,
    retention: {
      policy: metadata.retentionPolicy ?? null,
      storageRegion: metadata.storageRegion ?? null,
      storageImmutable: metadata.storageImmutable ?? null,
      objectLockMode: metadata.storageObjectLockMode ?? null,
      retainUntilUtc: metadata.storageObjectLockRetainUntilUtc ?? null,
      legalHoldStatus: metadata.storageObjectLockLegalHoldStatus ?? null,
    },
  };
}

function buildAuditAccessReport(params: {
  custody: CustodyEventRecord[];
  forensic: CustodyEventRecord[];
  access: CustodyEventRecord[];
}) {
  const accessTypes = new Map<string, number>();

  for (const ev of params.access) {
    const key = String(ev.eventType ?? "UNKNOWN");
    accessTypes.set(key, (accessTypes.get(key) ?? 0) + 1);
  }

  return {
    schema: "PROOVRA_AUDIT_ACCESS_REPORT",
    version: 1,
    generatedAtUtc: new Date().toISOString(),
    accessSnapshotGeneratedAtUtc: new Date().toISOString(),
    summary: {
      totalCustodyEvents: params.custody.length,
      forensicCustodyEvents: params.forensic.length,
      accessActivityEvents: params.access.length,
      accessTypes: Object.fromEntries(accessTypes.entries()),
    },
    boundary:
      "Access activity records later viewing, download, verification, or package access events. It is separate from forensic custody and does not by itself prove authenticity, admissibility, authorship, or factual truth.",
    accessActivity:
      params.access.length > 0
        ? params.access
        : [
            {
              note:
                "No access activity events were present at package generation time. This does not mean no future access occurred after this package was generated.",
            },
          ],
  };
}

function buildCaptureContext(
  metadata: VerificationPackageMetadata,
  evidenceId?: string | null
) {
  if (!hasCaptureLocationMetadata(metadata.captureLocation ?? null)) {
    return null;
  }

  return {
    schema: "PROOVRA_CAPTURE_CONTEXT",
    version: 1,
    evidenceId: evidenceId ?? null,
    capturedAtUtc: metadata.capturedAtUtc ?? null,
    deviceTimeIso: metadata.deviceTimeIso ?? null,
    source: CAPTURE_LOCATION_SOURCE_LABEL,
    title: "Capture Context",
    statusLabel: "Location metadata included",
    subtitle: CAPTURE_LOCATION_CONTEXT_DESCRIPTION,
    integrityContext:
      "Device/browser-reported capture-location metadata was included in the signed integrity state for this evidence record.",
    custodyReference: {
      initialEventType: "EVIDENCE_CREATED",
      note: "The initial evidence-creation custody event records whether capture-location metadata was present at session creation time.",
    },
    location: {
      lat: metadata.captureLocation?.lat ?? null,
      lng: metadata.captureLocation?.lng ?? null,
      accuracyMeters: metadata.captureLocation?.accuracyMeters ?? null,
    },
    externalMapUrl:
      buildCaptureLocationExternalMapUrl(metadata.captureLocation ?? null) ??
      null,
    legalBoundary: CAPTURE_LOCATION_LEGAL_BOUNDARY,
  };
}

async function buildCaptureContextMapPreview(
  metadata: VerificationPackageMetadata
): Promise<Buffer | null> {
  if (!hasCaptureLocationMetadata(metadata.captureLocation ?? null)) {
    return null;
  }

  try {
    return await renderCaptureLocationMapPreviewPng({
      lat: metadata.captureLocation?.lat ?? 0,
      lng: metadata.captureLocation?.lng ?? 0,
      accuracyMeters: metadata.captureLocation?.accuracyMeters ?? null,
      width: 1200,
      height: 720,
    });
  } catch (error) {
    console.warn("[verification-package] Failed to build capture map preview:", error);
    return null;
  }
}

function buildVerificationInstructions(params: {
  evidenceFiles: Array<VerificationEvidenceFile & { finalName: string }>;
  hasTimestampToken: boolean;
  hasAnchor: boolean;
  anchorStatusLabel: string;
}) {
  const evidencePaths =
    params.evidenceFiles.length === 1
      ? [params.evidenceFiles[0].finalName]
      : params.evidenceFiles.map((file) => `evidence-parts/${file.finalName}`);

  return `# PROOVRA Verification Instructions

This package is designed for independent technical review.

## 1. Verify package checksums

Run from the extracted package root:

\`\`\`bash
node verify-package.mjs
\`\`\`

This checks every file listed in \`package-checksums.json\`.

## 2. Verify evidence file SHA-256

${evidencePaths
  .map(
    (filePath) => `\`\`\`bash
sha256sum "${filePath}"
\`\`\``
  )
  .join("\n\n")}

Compare the result with:

- \`original-linkage.json\`
- \`fingerprint.json\`
- \`package-checksums.json\`
- the PDF report

For multipart evidence, also inspect \`evidence-manifest.json\` to confirm each packaged part's
role assignment, checklist mapping, and ordered part hash before recomputing the canonical
multipart manifest digest.

## 3. Verify package manifest digest

\`\`\`bash
sha256sum package-manifest.json
cat package-manifest.sig
\`\`\`

The SHA-256 digest of \`package-manifest.json\` should match \`manifestSha256\` in \`package-manifest.sig\`, and \`signatureBase64\` is the Ed25519 signature over that digest.

## 4. Verify signature material

The package includes:

- \`fingerprint.json\`
- \`signature.txt\`
- \`public-key.pem\`

The signature is generated against PROOVRA fingerprint material. \`fingerprint.json\` is the raw canonical technical record and may retain low-level source enums such as the primary record evidence type. Use \`case-metadata.json\` and \`original-linkage.json\` for reviewer-facing normalized evidence classification. Depending on the exact signing mode, independent verification may require the platform canonicalization rule or a verifier matched to the production signing scheme.

## 5. Verify timestamp material

${
  params.hasTimestampToken
    ? `\`timestamp.tsr\` is included as RFC 3161 DER-encoded timestamp data. Example:

\`\`\`bash
openssl ts -reply -in timestamp.tsr -text
\`\`\`

Use it together with the original digest and TSA certificate chain available from the timestamp provider.`
    : `No \`timestamp.tsr\` is included. Review \`trust-decision.json\`, \`integrity-summary.json\`, and the PDF timestamp section for the timestamp status.`
}

## 6. Verify anchoring material

${
  params.hasAnchor
    ? `\`anchor.json\` is included. Status: ${params.anchorStatusLabel}. Review its anchor hash, receipt, transaction ID, public URL, and anchored timestamp when present.`
    : `No \`anchor.json\` is included. Status: ${params.anchorStatusLabel}. Public anchoring should be rechecked on the verification page if independent public anchoring is required.`
}

## 7. Review custody and access

- \`custody.json\`: complete custody event chain included in the package.
- \`forensic-custody.json\`: integrity-relevant custody events.
- \`access-activity.json\`: package access snapshot at generation time.
- \`audit-access-report.json\`: reviewer-friendly access/audit summary.

Package access snapshot at generation may show zero events even when later live access activity appears on the verification page after reviewers open, download, or verify materials.

## 8. Review capture context, if present

- \`capture-context.json\`: signed device/browser-reported capture-location context.
- \`map-preview.png\`: deterministic reviewer-facing location preview derived from the signed capture context.

## Legal boundary

This package supports technical integrity review only. It does not independently prove factual truth, authorship, legal admissibility, relevance, intent, or evidentiary weight.
`;
}

function buildVerifyPackageScript() {
  return [
    "#!/usr/bin/env node",
    'import { createHash, verify } from "node:crypto";',
    'import { readFileSync, existsSync } from "node:fs";',
    "",
    "function sha256(filePath) {",
    '  return createHash("sha256").update(readFileSync(filePath)).digest("hex");',
    "}",
    "",
    "function fail(message) {",
    '  console.error("FAIL:", message);',
    "  process.exitCode = 1;",
    "}",
    "",
    "// ------------------------------",
    "// 1. CHECKSUM VALIDATION",
    "// ------------------------------",
    'const checksumsPath = "package-checksums.json";',
    "",
    "if (!existsSync(checksumsPath)) {",
    '  fail("package-checksums.json not found.");',
    "  process.exit();",
    "}",
    "",
    'const checksums = JSON.parse(readFileSync(checksumsPath, "utf8"));',
    "const files = Array.isArray(checksums.files) ? checksums.files : [];",
    "",
    "let checked = 0;",
    "",
    "for (const item of files) {",
    '  if (!item || typeof item.path !== "string") continue;',
    "",
    '  if (item.path === "package-checksums.json") continue;',
    "",
    "  if (!existsSync(item.path)) {",
    '    fail("Missing file: " + item.path);',
    "    continue;",
    "  }",
    "",
    "  const actual = sha256(item.path);",
    "  checked++;",
    "",
    "  if (actual !== item.sha256) {",
    '    fail("Checksum mismatch: " + item.path);',
    "  }",
    "}",
    "",
    'console.log("✔ Checksums OK:", checked, "files");',
    "",
    "// ------------------------------",
    "// 2. MANIFEST SIGNATURE VERIFY",
    "// ------------------------------",
    "",
    'const manifestPath = "package-manifest.json";',
    'const sigPath = "package-manifest.sig";',
    'const pubKeyPath = "package-manifest-public-key.pem";',
    "",
    "if (!existsSync(manifestPath) || !existsSync(sigPath) || !existsSync(pubKeyPath)) {",
    '  fail("Missing manifest signature files");',
    "  process.exit();",
    "}",
    "",
    "const manifestBuffer = readFileSync(manifestPath);",
    "const manifestSha256 = createHash('sha256').update(manifestBuffer).digest();",
    "",
    'const sigJson = JSON.parse(readFileSync(sigPath, "utf8"));',
    "const signature = Buffer.from(sigJson.signatureBase64, 'base64');",
    "",
    "const publicKey = readFileSync(pubKeyPath);",
    "",
    "const verified = verify(null, manifestSha256, publicKey, signature);",
    "",
    "if (!verified) {",
    '  fail("Manifest signature INVALID");',
    "} else {",
    '  console.log("✔ Manifest signature VALID");',
    "}",
    "",
    "// ------------------------------",
    "// 3. OPTIONAL MATERIAL STATUS",
    "// ------------------------------",
    "",
    'if (existsSync("timestamp.tsr")) {',
    '  console.log("ℹ RFC3161 TOKEN PRESENT");',
    "} else {",
    '  console.log("ℹ RFC3161 TOKEN NOT INCLUDED");',
    "}",
    "",
    'if (existsSync("anchor.json")) {',
    '  const anchor = JSON.parse(readFileSync("anchor.json", "utf8"));',
    '  const anchorStatus = String(anchor.status || "").trim().toLowerCase();',
    '  const anchorBitcoinTxid = typeof anchor.transactionId === "string" ? anchor.transactionId : typeof anchor.bitcoinTxid === "string" ? anchor.bitcoinTxid : "";',
    '  const anchorHasValidBitcoinTxid = /^[a-f0-9]{64}$/i.test(String(anchorBitcoinTxid).trim());',
    '  const anchorLabel = anchorStatus === "pending_public_anchor"',
    '    ? "OTS PROOF PRESENT - PUBLIC ANCHORING PENDING"',
    '    : anchorStatus === "anchored"',
    '      ? anchorHasValidBitcoinTxid ? "PUBLIC ANCHORING VERIFIED" : "OTS PROOF PRESENT - PUBLIC ANCHORING PENDING"',
    '      : anchorStatus === "failed"',
    '        ? "PUBLIC ANCHORING FAILED"',
    '        : anchorStatus === "not_configured"',
    '          ? "PUBLIC ANCHORING UNAVAILABLE"',
    '          : String(anchor.statusLabel || "ANCHOR STATUS RECORDED").toUpperCase();',
    '  console.log("ℹ " + anchorLabel);',
    "} else {",
    '  let manifestAnchorMode = "";',
    '  if (existsSync(manifestPath)) {',
    '    const manifestJson = JSON.parse(readFileSync(manifestPath, "utf8"));',
    '    manifestAnchorMode = String(manifestJson.anchorMode || "").trim().toLowerCase();',
    "  }",
    '  if (manifestAnchorMode === "pending_public_anchor") {',
    '    console.log("ℹ OTS PROOF PRESENT - PUBLIC ANCHORING PENDING");',
    '  } else if (manifestAnchorMode === "not_configured") {',
    '    console.log("ℹ PUBLIC ANCHORING UNAVAILABLE");',
    '  } else {',
    '    console.log("ℹ PUBLIC ANCHORING MATERIAL NOT INCLUDED");',
    "  }",
    "}",
    "",
    "// ------------------------------",
    "// 4. MULTIPART HASH SEMANTICS (Phase D Blocker 5)",
    "// ------------------------------",
    "",
    "if (existsSync(manifestPath)) {",
    '  const manifestJson = JSON.parse(readFileSync(manifestPath, "utf8"));',
    '  const hashSemantics = String(manifestJson.hashSemantics || "single_file");',
    '  const fileSha256Label = String(manifestJson.fileSha256Label || "");',
    '  const claimedManifestDigest = manifestJson.multipartManifestSha256;',
    '  console.log("ℹ HASH SEMANTICS: " + hashSemantics);',
    '  if (fileSha256Label) console.log("  - " + fileSha256Label);',
    '  if (hashSemantics === "multipart_composite") {',
    '    if (typeof claimedManifestDigest === "string" && /^[a-f0-9]{64}$/i.test(claimedManifestDigest)) {',
    '      const evidenceManifestPath = "evidence-manifest.json";',
    '      if (!existsSync(evidenceManifestPath)) {',
    '        fail("Multipart verification requires evidence-manifest.json");',
    '      }',
    '      const evidenceManifest = existsSync(evidenceManifestPath)',
    '        ? JSON.parse(readFileSync(evidenceManifestPath, "utf8"))',
    '        : null;',
    '      const manifestFiles = Array.isArray(evidenceManifest?.files) ? evidenceManifest.files : [];',
    '      const partFiles = manifestFiles',
    '        .filter((file) => file && typeof file.packagePath === "string" && typeof file.sha256 === "string")',
    '        .map((file, index) => ({',
    '          partIndex: Number.isFinite(Number(file.partIndex)) ? Number(file.partIndex) : index + 1,',
    '          packagePath: String(file.packagePath),',
    '          claimedSha256: String(file.sha256).toLowerCase(),',
    '        }))',
    '        .sort((a, b) => a.partIndex - b.partIndex);',
    '      if (partFiles.length > 1) {',
    '        for (const part of partFiles) {',
    '          const checksumEntry = files.find((item) => item && item.path === part.packagePath);',
    '          if (!checksumEntry || typeof checksumEntry.sha256 !== "string") {',
    '            fail("Missing checksum entry for multipart part: " + part.packagePath);',
    '            continue;',
    '          }',
    '          if (!existsSync(part.packagePath)) {',
    '            fail("Missing multipart part file: " + part.packagePath);',
    '            continue;',
    '          }',
    '          const actualPartSha256 = sha256(part.packagePath);',
    '          if (actualPartSha256 !== String(checksumEntry.sha256).toLowerCase()) {',
    '            fail("Multipart part checksum mismatch: " + part.packagePath);',
    '          }',
    '          if (actualPartSha256 !== part.claimedSha256) {',
    '            fail("Multipart manifest sha256 mismatch for part " + part.partIndex + ": " + part.packagePath);',
    '          }',
    '        }',
    '        const recomputed = createHash("sha256")',
    '          .update(partFiles.map((p) => p.claimedSha256).join("\\n"))',
    '          .digest("hex");',
    '        if (recomputed === claimedManifestDigest.toLowerCase()) {',
    '          console.log("✔ multipartManifestSha256 RECOMPUTED OK (" + partFiles.length + " parts)");',
    '        } else {',
    '          fail("multipartManifestSha256 RECOMPUTE MISMATCH (claimed=" + claimedManifestDigest + ", recomputed=" + recomputed + ")");',
    '        }',
    '      } else {',
    '        fail("multipartManifestSha256 present but multipart parts were not fully enumerable from evidence-manifest.json");',
    '      }',
    '    } else {',
    '      console.log("ℹ multipartManifestSha256 not recorded in package manifest");',
    '    }',
    '  }',
    "}",
    "",
    "// ------------------------------",
    "// FINAL RESULT",
    "// ------------------------------",
    "",
    "if (process.exitCode) process.exit();",
    "",
    'console.log("✅ PACKAGE FILES AND MANIFEST VERIFIED");',
    'console.log("  - Checksums OK");',
    'console.log("  - Manifest signature VALID");',
    'console.log("  - Preserved package files match the signed manifest");',
    'console.log("  - Multipart hash semantics inspected (see HASH SEMANTICS line above)");',
    'console.log("  - This does not independently prove factual truth, authorship, legal admissibility, or completed public anchoring");',
    'console.log("  - Review RFC3161 timestamp, OpenTimestamps/public anchoring, custody, and legal context separately");',
    "",
  ].join("\n");
}

function buildAnchorReadmeSection(params: {
  anchorMode: AnchorMode;
  anchorStatusLabel: string;
  hasAnchorPayload: boolean;
  anchorPublished: boolean;
  otsStatus?: string | null;
  anchorProvider?: string | null;
  anchorPublicBaseUrl?: string | null;
  bitcoinTxid?: string | null;
}): string {
  const providerLine = params.anchorProvider
    ? `Provider: ${params.anchorProvider}`
    : "Provider: Not configured";

  const publicBaseLine = params.anchorPublicBaseUrl
    ? `Public base URL: ${params.anchorPublicBaseUrl}`
    : "Public base URL: Not configured";

  const otsStatus = String(params.otsStatus ?? "").toUpperCase();

  if (params.anchorMode === "not_configured") {
    return `ANCHOR STATUS

Anchor publication is disabled for this environment.
No external anchoring claim is made for this package.
${providerLine}
${publicBaseLine}`;
  }

  if (!params.hasAnchorPayload) {
    return `ANCHOR STATUS

No anchor.json file is included in this package.
Public anchoring status: ${params.anchorStatusLabel}.
${providerLine}
${publicBaseLine}`;
  }

  // Truthful Bitcoin-anchoring section: only assert "Bitcoin anchoring verified"
  // when a valid Bitcoin transaction id is recorded for the OTS proof.
  const hasBitcoinTxid =
    typeof params.bitcoinTxid === "string" &&
    /^[a-f0-9]{64}$/i.test(params.bitcoinTxid.trim());

  if (params.anchorMode === "anchored") {
    if (hasBitcoinTxid) {
      return `ANCHOR STATUS

anchor.json is included in this package.
Bitcoin anchoring verified (transaction reference recorded).
This anchoring layer is independent from RFC 3161 timestamping.
${providerLine}
${publicBaseLine}`;
    }
    return `ANCHOR STATUS

anchor.json is included in this package.
OpenTimestamps proof present; public anchoring pending.
A Bitcoin transaction reference has not yet been attached to the OpenTimestamps proof. Re-check this package after the OTS upgrade pass for confirmed Bitcoin anchoring.
This anchoring layer is independent from RFC 3161 timestamping.
${providerLine}
${publicBaseLine}`;
  }

  if (params.anchorMode === "pending_public_anchor" || otsStatus === "PENDING") {
    return `ANCHOR STATUS

anchor.json is included in this package.
OpenTimestamps proof present; public anchoring pending.
Public anchoring should be rechecked later if independent public anchoring is required.
This anchoring layer is independent from RFC 3161 timestamping.
${providerLine}
${publicBaseLine}`;
  }

  if (params.anchorMode === "failed" || otsStatus === "FAILED") {
    return `ANCHOR STATUS

anchor.json is included in this package, but public anchoring failed or could not be completed.
Reviewers should rely on preserved originals, hashes, signature, custody continuity, and any available timestamp material.
${providerLine}
${publicBaseLine}`;
  }

  return `ANCHOR STATUS

anchor.json is included in this package as anchoring material.
No external publication receipt or transaction identifier is attached yet.
Public anchoring should be treated as pending unless a receipt, transaction ID, public URL, or anchored timestamp is present.
This anchoring layer is independent from RFC 3161 timestamping.
${providerLine}
${publicBaseLine}`;
}

function buildEvidenceManifest(
  evidenceFiles: Array<VerificationEvidenceFile & { finalName: string }>
): Record<string, unknown> {
  const multipart = evidenceFiles.length > 1;

  return {
    multipart,
    partCount: evidenceFiles.length,
    files: evidenceFiles.map((file, index) => ({
      index: index + 1,
      partIndex: file.partIndex ?? index + 1,
      name: file.finalName,
      packagePath: multipart ? `evidence-parts/${file.finalName}` : file.finalName,
      artifactRole: file.artifactRole ?? null,
      artifactRoleLabel: file.artifactRole
        ? getReviewerArtifactRoleLabel(file.artifactRole)
        : null,
      artifactRoleSource: file.artifactRoleSource ?? null,
      checklistStepId: file.checklistStepId ?? null,
      checklistStepLabel: file.checklistStepLabel ?? null,
      sourceLabel: file.sourceLabel ?? null,
      sizeBytes: file.buffer.length,
      mimeType: file.mimeType ?? null,
      sha256:
        typeof file.sha256 === "string" && /^[a-f0-9]{64}$/i.test(file.sha256)
          ? file.sha256.toLowerCase()
          : null,
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
      // Phase D Blocker 2 — strip directory components before exposing
      // through the verification package JSON. file.originalFileName comes
      // from EvidencePart.originalFileName which has already been
      // sanitized at the API layer for new records, but legacy records may
      // still carry raw paths; defensive strip here protects them too.
      originalFileName: stripPathForPackageExposure(file.originalFileName),
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
  const reviewerEvidence = buildReviewerEvidenceMetadata(metadata);

  return {
    evidenceTitle: metadata.title ?? null,
    rawEvidenceType: reviewerEvidence.rawEvidenceType,
    rawEvidenceTypeSource: reviewerEvidence.rawEvidenceTypeSource,
    reviewerEvidenceType: reviewerEvidence.reviewerEvidenceType,
    evidenceStructure: reviewerEvidence.evidenceStructure,
    itemCount: reviewerEvidence.itemCount,
    contentCategories: reviewerEvidence.contentCategories,
    imageCount: reviewerEvidence.imageCount,
    videoCount: reviewerEvidence.videoCount,
    audioCount: reviewerEvidence.audioCount,
    pdfCount: reviewerEvidence.pdfCount,
    textCount: reviewerEvidence.textCount,
    otherCount: reviewerEvidence.otherCount,
    mimeType: metadata.mimeType ?? null,
    evidenceStatus: metadata.evidenceStatus ?? null,
    verificationStatus: metadata.verificationStatus ?? null,
    captureMethod: metadata.captureMethod ?? null,
    identityLevelSnapshot: metadata.identityLevelSnapshot ?? null,
    submittedByEmail: metadata.submittedByEmail ?? null,
    submittedByAuthProvider: metadata.submittedByAuthProvider ?? null,
    createdAtUtc: metadata.createdAtUtc ?? null,
    capturedAtUtc: metadata.capturedAtUtc ?? null,
    deviceTimeIso: metadata.deviceTimeIso ?? null,
    uploadedAtUtc: metadata.uploadedAtUtc ?? null,
    signedAtUtc: metadata.signedAtUtc ?? null,
    reportGeneratedAtUtc: metadata.reportGeneratedAtUtc ?? null,
    captureLocation: metadata.captureLocation
      ? {
          lat: metadata.captureLocation.lat ?? null,
          lng: metadata.captureLocation.lng ?? null,
          accuracyMeters: metadata.captureLocation.accuracyMeters ?? null,
          legalBoundary: CAPTURE_LOCATION_LEGAL_BOUNDARY,
        }
      : null,
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
      artifactRole: file.artifactRole ?? null,
      artifactRoleLabel: file.artifactRole
        ? getReviewerArtifactRoleLabel(file.artifactRole)
        : null,
      artifactRoleSource: file.artifactRoleSource ?? null,
      checklistStepId: file.checklistStepId ?? null,
      checklistStepLabel: file.checklistStepLabel ?? null,
      sourceLabel: file.sourceLabel ?? null,
      // Phase D Blocker 2 — strip path components before exposing.
      originalFileName: stripPathForPackageExposure(file.originalFileName),
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
  anchorStatusLabel: string;
  anchorProvider?: string | null;
  anchorPublicBaseUrl?: string | null;
  anchor?: AnchorPayload | null;
  hasTimestampToken: boolean;
  hasActualCertifications: boolean;
  hasReportArtifact: boolean;
  hasCaptureContext: boolean;
  hasCaptureContextMapPreview: boolean;
  metadata: VerificationPackageMetadata;
}): PackageManifest {
  const reviewerEvidence = buildReviewerEvidenceMetadata(params.metadata);

  // Phase D Blocker 5 — derive a reproducible multipart manifest digest
  // from the per-part SHA-256 hashes when the API did not persist one
  // (legacy records). This guarantees the package always carries either
  // the persisted manifest digest or one independently computable from
  // the contents of package-checksums.json.
  const isMultipartPackage = params.evidenceFiles.length > 1;
  const partsForManifest = isMultipartPackage
    ? params.evidenceFiles
        .filter(
          (file): file is typeof file & { sha256: string } =>
            typeof file.sha256 === "string" && /^[a-f0-9]{64}$/i.test(file.sha256)
        )
        .slice()
        .sort((a, b) => (a.partIndex ?? 0) - (b.partIndex ?? 0))
    : [];
  const derivedMultipartManifestSha256 =
    isMultipartPackage && partsForManifest.length === params.evidenceFiles.length
      ? createHash("sha256")
          .update(partsForManifest.map((p) => p.sha256.toLowerCase()).join("\n"))
          .digest("hex")
      : null;

  return {
    packageType: "PROOVRA_VERIFICATION_PACKAGE",
    version: 4,
    evidenceId: params.evidenceId ?? null,
    reportVersion: params.reportVersion ?? null,
    signingKeyId: params.signingKeyId ?? null,
    signingKeyVersion:
      params.signingKeyVersion != null ? String(params.signingKeyVersion) : null,
    multipart: isMultipartPackage,
    // Phase D Blocker 5 — first-class multipart hash semantics in the
    // package manifest. Surfaced from VerificationPackageMetadata when
    // present (Phase C+ records) and derived from per-part hashes
    // otherwise (legacy records). Either way the package is honest about
    // what evidence.fileSha256 represents.
    hashSemantics:
      params.metadata.hashSemantics ??
      (isMultipartPackage ? "multipart_composite" : "single_file"),
    fileSha256Label:
      params.metadata.fileSha256Label ??
      (isMultipartPackage
        ? "Synthetic composite SHA-256 of per-part SHA-256s. The reproducible canonical multipart digest is multipartManifestSha256."
        : "SHA-256 of the original file"),
    multipartManifestSha256:
      params.metadata.multipartManifestSha256 ??
      derivedMultipartManifestSha256,
    multipartManifestRecomputationMethod: isMultipartPackage
      ? "Sort per-part hex SHA-256 digests by partIndex ascending, lowercase them, join with a single '\\n' (LF), and SHA-256 the resulting UTF-8 string. Per-part SHA-256s are also recorded in package-checksums.json."
      : null,
    rawEvidenceType: reviewerEvidence.rawEvidenceType,
    rawEvidenceTypeSource: reviewerEvidence.rawEvidenceTypeSource,
    reviewerEvidenceType: reviewerEvidence.reviewerEvidenceType,
    evidenceStructure: reviewerEvidence.evidenceStructure,
    itemCount: reviewerEvidence.itemCount,
    contentCategories: reviewerEvidence.contentCategories,
    fileCount: params.evidenceFiles.length,
    generatedAtUtc: new Date().toISOString(),
    accessSnapshotGeneratedAtUtc: new Date().toISOString(),
    anchorIncluded: params.anchorIncluded,
    anchorMode: params.anchorMode,
    anchorStatusLabel: params.anchorStatusLabel,
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
      trustDecision: true,
      forensicCustody: true,
      accessActivity: true,
      reportArtifact: params.hasReportArtifact,
      courtReadiness: true,
      certificationTemplates: true,
      verifyHtml: true,
      readme: true,
      actualCertifications: params.hasActualCertifications,
      packageChecksums: true,
      signedPackageManifest: true,
      verificationInstructions: true,
      verificationScript: true,
      caseMetadata: true,
      auditAccessReport: true,
      captureContext: params.hasCaptureContext,
      captureContextMapPreview: params.hasCaptureContextMapPreview,
    },
  };
}

function buildIntegritySummary(params: {
  evidenceFiles: VerificationEvidenceFile[];
  hasTimestampToken: boolean;
  anchorIncluded: boolean;
  anchorMode: AnchorMode;
  anchorStatusLabel: string;
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
    anchorStatusLabel: params.anchorStatusLabel,
    multipart: params.evidenceFiles.length > 1,
    fileCount: params.evidenceFiles.length,
  };
}

function buildReadme(params: {
  evidenceFiles: VerificationEvidenceFile[];
  anchorMode: AnchorMode;
  anchorStatusLabel: string;
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
  bitcoinTxid?: string | null;
  metadata: VerificationPackageMetadata;
}): string {
  const multipart = params.evidenceFiles.length > 1;
  const reviewerEvidence = buildReviewerEvidenceMetadata(params.metadata);
  const timestampStatus = String(params.timestampStatus ?? "").toUpperCase();
  const otsStatus = String(params.otsStatus ?? "").toUpperCase();

  const timestampReadmeLine = params.hasTimestampToken
    ? `timestamp.tsr
Included in this package as RFC 3161 DER-encoded timestamp data. Example: openssl ts -reply -in timestamp.tsr -text`
    : `timestamp.tsr
Not included in this package. RFC3161 timestamp status: ${
        timestampStatus || "NOT_RECORDED"
      }. Integrity verification still relies on hashes, digital signature, preserved originals, custody continuity, and any available anchoring material.`;

  const anchorReadmeLine = params.anchorIncluded
    ? `anchor.json
Included in this package. Status: ${params.anchorStatusLabel}.`
    : `anchor.json
Not included in this package. Public anchoring status: ${params.anchorStatusLabel}.`;

  return `PROOVRA Evidence Verification Package

PACKAGE OVERVIEW

This package allows independent verification of the recorded digital evidence state.

Evidence ID: ${safeText(params.evidenceId, "Not included")}
Report Version: ${
    typeof params.reportVersion === "number"
      ? String(params.reportVersion)
      : "Not included"
  }
Signing Key ID: ${safeText(params.signingKeyId, "Not included")}
Signing Key Version: ${
    typeof params.signingKeyVersion === "number"
      ? String(params.signingKeyVersion)
      : "Not included"
  }
Reviewer Evidence Type: ${safeText(reviewerEvidence.reviewerEvidenceType, "Not included")}
Raw Evidence Type Enum: ${safeText(reviewerEvidence.rawEvidenceType, "Not included")}
Evidence Structure: ${safeText(reviewerEvidence.evidenceStructure, multipart ? "Multipart evidence package" : "Single evidence item")}

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
Canonical fingerprint used to generate the signature. This is raw signed technical material and may retain the primary record enum rather than the reviewer-facing evidence classification.

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

package-manifest.sig
Ed25519 signature record for package-manifest.json.

package-checksums.json
SHA-256 checksum manifest for packaged files.

verification-instructions.md
Executable-style verification guide with shell commands.

verify-package.mjs
Node.js script for checking package file checksums.

case-metadata.json
Case, matter, workspace, retention, and reviewer context when available.

capture-context.json
Included when signed capture-location metadata exists for the evidence record.

map-preview.png
Optional deterministic location preview derived from capture-context.json for reviewer-facing context only.

audit-access-report.json
Reviewer-friendly access and audit activity summary.

integrity-summary.json
High-level package integrity profile.

trust-decision.json
Enterprise trust decision summary aligned with the PDF report decision model.

original-linkage.json
Links the included file(s), storage preservation details, and report artifact back to the preserved original record.

duplicate-digests.json
Lists any packaged evidence files that share the same SHA-256 digest.

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

custody.json contains the complete immutable sequence of all recorded system events.
forensic-custody.json contains a curated subset of integrity-relevant events used for forensic review.
access-activity.json contains access, viewing, download, and verification activity that is not part of the forensic custody chronology shown in the PDF report.
It is a package access snapshot at generation time. Current live access activity may increase later on the verification page.

Sequence numbers reflect the original immutable event log. Gaps in forensic views may appear where non-forensic events are excluded.

HOW TO VERIFY

1) Extract the package.
2) Run: node verify-package.mjs
   This verifies package file checksums and the signed package manifest only.
3) Review fingerprint.json.
4) Calculate SHA-256 hash of the included evidence file(s).
5) Compare computed hashes against original-linkage.json, fingerprint.json, and package-checksums.json.
${params.evidenceFiles.length > 1 ? `   ${PROOVRA_MULTIPART_REVIEWER_EXPLANATION}
   ${PROOVRA_MULTIPART_RECOMPUTATION_NOTE}
   ${PROOVRA_MULTIPART_LEGAL_BOUNDARY_NOTE}` : ""}
6) Verify the Ed25519 signature using public-key.pem and the platform signing rules.
7) Verify the RFC3161 timestamp token using timestamp verification tools, if included.
8) Review custody.json and, where present, anchor.json.
9) Review capture-context.json and map-preview.png, if present, as contextual device/browser-reported metadata only.
10) Use original-linkage.json to tie every included file and the bundled report back to the preserved record.
11) Complete the certification templates inside certifications/ before using this package as a court-facing packet.

${buildAnchorReadmeSection({
  anchorMode: params.anchorMode,
  anchorStatusLabel: params.anchorStatusLabel,
  hasAnchorPayload: params.anchorIncluded,
  anchorPublished: params.anchorPublished,
  otsStatus: params.otsStatus,
  anchorProvider: params.anchorProvider,
  anchorPublicBaseUrl: params.anchorPublicBaseUrl,
  bitcoinTxid: params.bitcoinTxid,
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
  const reviewerEvidence = buildReviewerEvidenceMetadata(params.metadata);

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
      auditAccessReportIncluded: true,
      packageChecksumManifestIncluded: true,
      packageManifestDigestIncluded: true,
      verificationInstructionsIncluded: true,
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
      caseMetadataIncluded: true,
    },
    remainingHumanRequirements: [
      "Custodian declaration or qualified-person certification must be completed for court-facing use.",
      "Applicable business-record, electronic-process, notice, and jurisdiction-specific admissibility requirements must be assessed by counsel.",
      "The preserved original should remain available for deeper inspection, comparison, and evidentiary challenge.",
    ],
    context: {
      rawEvidenceType: reviewerEvidence.rawEvidenceType,
      rawEvidenceTypeSource: reviewerEvidence.rawEvidenceTypeSource,
      reviewerEvidenceType: reviewerEvidence.reviewerEvidenceType,
      evidenceStructure: reviewerEvidence.evidenceStructure,
      itemCount: reviewerEvidence.itemCount,
      contentCategories: reviewerEvidence.contentCategories,
      verificationStatus: params.metadata.verificationStatus ?? null,
      captureMethod: params.metadata.captureMethod ?? null,
      forensicCustodyEventCount: params.forensicCustodyCount,
      accessActivityEventCount: params.accessActivityCount,
      caseId: params.metadata.caseId ?? null,
      caseName: params.metadata.caseName ?? null,
      jurisdiction: params.metadata.jurisdiction ?? null,
      retentionPolicy: params.metadata.retentionPolicy ?? null,
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
- Case ID: ${safeText(params.metadata.caseId, "Not included")}
- Jurisdiction: ${safeText(params.metadata.jurisdiction, "Not included")}

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
  const reviewerEvidence = buildReviewerEvidenceMetadata(params.metadata);

  return `# PROOVRA System Process Declaration

This package documents a PROOVRA evidence record and the integrity-verification materials generated around it.

## Preserved originals

- Included preserved item count: ${params.evidenceFiles.length}
- Reviewer evidence type: ${safeText(reviewerEvidence.reviewerEvidenceType, "Not included")}
- Raw evidence type enum: ${safeText(reviewerEvidence.rawEvidenceType, "Not included")}
- Capture method snapshot: ${safeText(params.metadata.captureMethod, "Not included")}

## Integrity process

1. The preserved original file(s) are stored and referenced as the source evidence.
2. SHA-256 values are recorded for the preserved file or package parts.
3. A canonical fingerprint record is generated to describe the evidence state and package structure.
4. The fingerprint-derived material is digitally signed.
5. Timestamp and public anchoring records are attached where available.
6. System custody events are recorded separately from later access activity.
7. Reviewer-facing artifacts such as reports or previews are generated from, and linked back to, the preserved record.
8. The verification package includes package-checksums.json and package-manifest.sig so reviewers can detect package artifact changes after export.

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
  bitcoinTxid?: string | null;
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
    const hasBitcoinTxid =
      typeof params.bitcoinTxid === "string" &&
      /^[a-f0-9]{64}$/i.test(params.bitcoinTxid.trim());

    if (status === "ANCHORED") {
      return hasBitcoinTxid
        ? "Bitcoin anchoring verified (transaction reference recorded)."
        : "OpenTimestamps proof present; public anchoring pending. A Bitcoin transaction reference has not yet been attached to the OpenTimestamps proof.";
    }

    if (status === "PENDING") {
      return "OpenTimestamps proof present; public anchoring pending.";
    }

    if (status === "FAILED") {
      return "OpenTimestamps anchoring failed or could not be completed.";
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
    ${
      multipart
        ? `<p>${safeText(PROOVRA_MULTIPART_REVIEWER_EXPLANATION)}</p>
    <p>${safeText(PROOVRA_MULTIPART_RECOMPUTATION_NOTE)} ${safeText(
            PROOVRA_MULTIPART_LEGAL_BOUNDARY_NOTE
          )}</p>`
        : ""
    }
  </div>

  <div class="card">
    <h2>2. Package Integrity</h2>
    <p>
      Run <code>node verify-package.mjs</code> from the extracted package root to verify files against <code>package-checksums.json</code>.
      Review <code>package-manifest.sig</code> to confirm the SHA-256 digest of <code>package-manifest.json</code>.
    </p>
  </div>

  <div class="card">
    <h2>3. Original vs Report Artifact</h2>
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
    <h2>4. How to Verify</h2>
    <ol>
      <li>Review <code>verification-instructions.md</code>.</li>
      <li>Run <code>node verify-package.mjs</code>.</li>
      <li>Review <code>package-manifest.json</code>, <code>package-manifest.sig</code>, <code>integrity-summary.json</code>, and <code>trust-decision.json</code>.</li>
      <li>Hash the included evidence file(s) with SHA-256.</li>
      <li>Compare computed hashes against <code>original-linkage.json</code>, <code>fingerprint.json</code>, and <code>package-checksums.json</code>.</li>
      ${
        multipart
          ? `<li>${safeText(
              PROOVRA_MULTIPART_RECOMPUTATION_NOTE
            )} ${safeText(PROOVRA_MULTIPART_LEGAL_BOUNDARY_NOTE)}</li>`
          : ""
      }
      <li>Verify <code>signature.txt</code> using <code>public-key.pem</code>.</li>
      <li>If present, verify <code>timestamp.tsr</code> as RFC 3161 DER data, for example with <code>openssl ts -reply -in timestamp.tsr -text</code>.</li>
      <li>If present, review <code>anchor.json</code> as anchoring material only; pending status is not the same as verified public publication.</li>
    </ol>
  </div>

  <div class="card">
    <h2>5. Custody and Access Explanation</h2>
    <p>
      <code>custody.json</code> contains the complete system event chain.
      <code>forensic-custody.json</code> contains a filtered subset used for forensic review.
      <code>access-activity.json</code> contains later access, viewing, download, or verification activity.
      <code>audit-access-report.json</code> summarizes access activity for reviewers.
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
  trustDecision: ReportTrustDecision;
  reportVersion?: number;
  signingKeyId?: string;
  signingKeyVersion?: number;
  anchor?: AnchorPayload | null;
  anchorMode?: string | null;
  anchorProvider?: string | null;
  anchorPublicBaseUrl?: string | null;
  certifications?: {
    custodian?: VerificationCertificationRecord | null;
    qualifiedPerson?: VerificationCertificationRecord | null;
  };
  reportPdf?: Buffer | null;
  reportFileName?: string | null;
  metadata?: VerificationPackageMetadata;
}): Promise<{ buffer: Buffer; artifactPresence: VerificationPackageArtifactPresence }> {
  return new Promise((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 9 } });
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    const packageEntries: PackageEntry[] = [];
    const artifactPresence: VerificationPackageArtifactPresence = {
      manifestPresent: false,
      signedManifestPresent: false,
      checksumIndexPresent: false,
      offlineVerifierIncluded: false,
      auditExportIncluded: false,
      custodyExportIncluded: false,
      accessExportIncluded: false,
    };

    let settled = false;

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const succeed = () => {
      if (settled) return;
      settled = true;
      resolve({ buffer: Buffer.concat(chunks), artifactPresence });
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
    void (async () => {
  try {

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
    const captureContextData = buildCaptureContext(
      metadata,
      data.evidenceId ?? null
    );
    const captureContextMapPreview = await buildCaptureContextMapPreview(
      metadata
    );
    const evidenceFilesWithFinalName = evidenceFiles.map((file, index) => {
      const fileOrder = index + 1;
      const totalParts = evidenceFiles.length;
      const finalName = buildEvidencePackageFileName({
        evidenceTitle: metadata.title ?? null,
        originalFileName: file.originalFileName ?? file.name,
        evidenceType: metadata.rawEvidenceType ?? null,
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

    const anchorMode = derivePackageAnchorMode({
      rawMode: data.anchorMode,
      anchor: data.anchor ?? null,
      trustDecision: data.trustDecision,
    });
    const anchorStatusLabel = getAnchorStatusLabel(anchorMode, {
      bitcoinTxid: data.anchor?.transactionId ?? null,
    });
    const anchorIncluded = Boolean(data.anchor);
    const hasTimestampToken = Boolean(data.timestampToken);
    const certificationSummary = buildCertificationSummary({
      custodian: data.certifications?.custodian ?? null,
      qualifiedPerson: data.certifications?.qualifiedPerson ?? null,
    });
    const custodySplit = splitCustodyEvents(data.custody);
    const custodyArray = Array.isArray(data.custody)
      ? (data.custody as CustodyEventRecord[])
      : [];

    const anchorPublished = Boolean(
      data.anchor?.published ||
        data.anchor?.receiptId ||
        data.anchor?.transactionId ||
        data.anchor?.publicUrl ||
        data.anchor?.anchoredAtUtc
    );

    if (evidenceFilesWithFinalName.length === 1) {
      const file = evidenceFilesWithFinalName[0];
      appendPackageEntry(
        archive,
        packageEntries,
        file.finalName,
        file.buffer,
        file.mimeType ?? "application/octet-stream"
      );
    } else {
      evidenceFilesWithFinalName.forEach((file) => {
        appendPackageEntry(
          archive,
          packageEntries,
          `evidence-parts/${file.finalName}`,
          file.buffer,
          file.mimeType ?? "application/octet-stream"
        );
      });

      appendPackageEntry(
        archive,
        packageEntries,
        "evidence-manifest.json",
        jsonBuffer(buildEvidenceManifest(evidenceFilesWithFinalName)),
        "application/json"
      );
    }

    appendPackageEntry(
      archive,
      packageEntries,
      "fingerprint.json",
      textBuffer(data.fingerprint),
      "application/json"
    );

    appendPackageEntry(
      archive,
      packageEntries,
      "signature.txt",
      textBuffer(data.signature),
      "text/plain"
    );

    if (data.timestampToken) {
      appendPackageEntry(
        archive,
        packageEntries,
        "timestamp.tsr",
        Buffer.from(data.timestampToken, "base64"),
        "application/octet-stream"
      );
    }

    appendPackageEntry(
      archive,
      packageEntries,
      "public-key.pem",
      textBuffer(data.publicKey),
      "application/x-pem-file"
    );

    appendPackageEntry(
      archive,
      packageEntries,
      "custody.json",
      jsonBuffer(data.custody),
      "application/json"
    );
    artifactPresence.custodyExportIncluded = true;

    appendPackageEntry(
      archive,
      packageEntries,
      "forensic-custody.json",
      jsonBuffer(custodySplit.forensic),
      "application/json"
    );

    appendPackageEntry(
      archive,
      packageEntries,
      "access-activity.json",
      jsonBuffer(custodySplit.access),
      "application/json"
    );
    artifactPresence.accessExportIncluded = true;

    if (data.anchor) {
      appendPackageEntry(
        archive,
        packageEntries,
        "anchor.json",
        jsonBuffer({
          ...data.anchor,
          status: anchorMode,
          statusLabel: anchorStatusLabel,
        }),
        "application/json"
      );
    }

    const packageManifest = buildPackageManifest({
      evidenceId: data.evidenceId,
      reportVersion: data.reportVersion,
      signingKeyId: data.signingKeyId,
      signingKeyVersion: data.signingKeyVersion,
      evidenceFiles: evidenceFilesWithFinalName,
      anchorIncluded,
      anchorMode,
      anchorStatusLabel,
      anchorProvider: data.anchorProvider,
      anchorPublicBaseUrl: data.anchorPublicBaseUrl,
      anchor: data.anchor ?? null,
      hasTimestampToken,
      hasActualCertifications: certificationSummary.hasActualCertifications,
      hasReportArtifact: Boolean(data.reportPdf),
      hasCaptureContext: Boolean(captureContextData),
      hasCaptureContextMapPreview: Boolean(captureContextMapPreview),
      metadata,
    });

    const packageManifestBuffer = jsonBuffer(packageManifest);

    appendPackageEntry(
      archive,
      packageEntries,
      "package-manifest.json",
      packageManifestBuffer,
      "application/json"
    );
    artifactPresence.manifestPresent = true;

    appendPackageEntry(
  archive,
  packageEntries,
  "package-manifest-public-key.pem",
  textBuffer(readPackageSigningPublicKeyPem()),
  "application/x-pem-file"
);

appendPackageEntry(
  archive,
  packageEntries,
  "package-manifest.sig",
  jsonBuffer(
    buildSignedManifest({
      manifestBuffer: packageManifestBuffer,
      signingKeyId: data.signingKeyId ?? null,
      signingKeyVersion: data.signingKeyVersion ?? null,
    })
  ),
  "application/json"
);
    artifactPresence.signedManifestPresent = true;

    appendPackageEntry(
      archive,
      packageEntries,
      "package-manifest.verify.txt",
      textBuffer(
        `PROOVRA package manifest verification

Manifest file:
package-manifest.json

Expected SHA-256:
${sha256Hex(packageManifestBuffer)}

Verify with:
sha256sum package-manifest.json

The result must match the expected SHA-256 above and the manifestSha256 field in package-manifest.sig.
`
      ),
      "text/plain"
    );

    appendPackageEntry(
      archive,
      packageEntries,
      "integrity-summary.json",
      jsonBuffer(
        buildIntegritySummary({
          evidenceFiles: evidenceFilesWithFinalName,
          hasTimestampToken,
          anchorIncluded,
          anchorMode,
          anchorStatusLabel,
        })
      ),
      "application/json"
    );

    appendPackageEntry(
      archive,
      packageEntries,
      "trust-decision.json",
      jsonBuffer(
        serializeTrustDecisionForReviewerPackage(data.trustDecision, {
          includeInternalDebug:
            String(process.env.PROOVRA_INCLUDE_INTERNAL_TRUST_DEBUG ?? "")
              .trim()
              .toLowerCase() === "true",
        })
      ),
      "application/json"
    );

    appendPackageEntry(
      archive,
      packageEntries,
      "original-linkage.json",
      jsonBuffer(buildOriginalLinkage(evidenceFilesWithFinalName, metadata)),
      "application/json"
    );

    appendPackageEntry(
      archive,
      packageEntries,
      "case-metadata.json",
      jsonBuffer(buildCaseMetadata(metadata, data.evidenceId ?? null)),
      "application/json"
    );

    if (captureContextData) {
      appendPackageEntry(
        archive,
        packageEntries,
        "capture-context.json",
        jsonBuffer(captureContextData),
        "application/json"
      );
    }

    if (captureContextMapPreview) {
      appendPackageEntry(
        archive,
        packageEntries,
        "map-preview.png",
        captureContextMapPreview,
        "image/png"
      );
    }

    appendPackageEntry(
      archive,
      packageEntries,
      "audit-access-report.json",
      jsonBuffer(
        buildAuditAccessReport({
          custody: custodyArray,
          forensic: custodySplit.forensic,
          access: custodySplit.access,
        })
      ),
      "application/json"
    );
    artifactPresence.auditExportIncluded = true;

    appendPackageEntry(
      archive,
      packageEntries,
      "verification-instructions.md",
      textBuffer(
        buildVerificationInstructions({
          evidenceFiles: evidenceFilesWithFinalName,
          hasTimestampToken,
          hasAnchor: anchorIncluded,
          anchorStatusLabel,
        })
      ),
      "text/markdown"
    );

    appendPackageEntry(
      archive,
      packageEntries,
      "verify-package.mjs",
      textBuffer(buildVerifyPackageScript()),
      "text/javascript"
    );
    artifactPresence.offlineVerifierIncluded = true;

    appendPackageEntry(
      archive,
      packageEntries,
      "duplicate-digests.json",
      jsonBuffer(buildDuplicateDigests(evidenceFilesWithFinalName)),
      "application/json"
    );

    appendPackageEntry(
      archive,
      packageEntries,
      "review-artifact-boundaries.json",
      jsonBuffer(
        buildArtifactBoundaries({
          evidenceFiles: evidenceFilesWithFinalName,
          reportIncluded: Boolean(data.reportPdf),
        })
      ),
      "application/json"
    );

    appendPackageEntry(
      archive,
      packageEntries,
      "court-admissibility-checklist.json",
      jsonBuffer(
        buildCourtReadinessChecklist({
          evidenceFiles: evidenceFilesWithFinalName,
          hasTimestampToken,
          anchorIncluded,
          forensicCustodyCount: custodySplit.forensic.length,
          accessActivityCount: custodySplit.access.length,
          metadata,
          certifications: data.certifications,
        })
      ),
      "application/json"
    );

    appendPackageEntry(
      archive,
      packageEntries,
      "README.txt",
      textBuffer(
        buildReadme({
          evidenceFiles,
          anchorMode,
          anchorStatusLabel,
          anchorIncluded,
          anchorPublished,
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
          bitcoinTxid: data.anchor?.transactionId ?? null,
          metadata,
        })
      ),
      "text/plain"
    );

    appendPackageEntry(
      archive,
      packageEntries,
      "certifications/custodian-declaration-template.md",
      textBuffer(
        buildCustodianDeclarationTemplate({
          evidenceId: data.evidenceId,
          reportVersion: data.reportVersion,
          metadata,
        })
      ),
      "text/markdown"
    );

    appendPackageEntry(
      archive,
      packageEntries,
      "certifications/qualified-person-certification-template.md",
      textBuffer(
        buildQualifiedPersonTemplate({
          evidenceId: data.evidenceId,
          reportVersion: data.reportVersion,
        })
      ),
      "text/markdown"
    );

    appendPackageEntry(
      archive,
      packageEntries,
      "certifications/system-process-declaration.md",
      textBuffer(
        buildSystemProcessDeclaration({
          evidenceFiles,
          metadata,
        })
      ),
      "text/markdown"
    );

    if (data.certifications?.custodian) {
      appendPackageEntry(
        archive,
        packageEntries,
        "certifications/custodian-record.json",
        jsonBuffer(data.certifications.custodian),
        "application/json"
      );
    }

    if (data.certifications?.qualifiedPerson) {
      appendPackageEntry(
        archive,
        packageEntries,
        "certifications/qualified-person-record.json",
        jsonBuffer(data.certifications.qualifiedPerson),
        "application/json"
      );
    }

    if (certificationSummary.hasActualCertifications) {
      appendPackageEntry(
        archive,
        packageEntries,
        "certifications/certification-summary.json",
        jsonBuffer(certificationSummary),
        "application/json"
      );
    }

    appendPackageEntry(
      archive,
      packageEntries,
      "verify.html",
      textBuffer(
        buildVerifyHtml({
          evidenceFiles,
          anchorIncluded,
          hasTimestampToken,
          timestampStatus: metadata.tsaStatus ?? null,
          otsStatus: metadata.otsStatus ?? null,
          bitcoinTxid: data.anchor?.transactionId ?? null,
          evidenceId: data.evidenceId,
          reportVersion: data.reportVersion,
        })
      ),
      "text/html"
    );

    if (data.reportPdf) {
      appendPackageEntry(
        archive,
        packageEntries,
        `reports/${normalizeFileName(
          data.reportFileName ??
            `proovra-report-v${data.reportVersion ?? "latest"}.pdf`,
          "proovra-report.pdf"
        )}`,
        data.reportPdf,
        "application/pdf"
      );
    }

    appendPackageEntry(
      archive,
      packageEntries,
      "package-checksums.json",
      jsonBuffer(buildPackageChecksums(packageEntries)),
      "application/json"
    );
    artifactPresence.checksumIndexPresent = true;

    await archive.finalize();
  } catch (error) {
    fail(error);
  }
})();
  });
}
