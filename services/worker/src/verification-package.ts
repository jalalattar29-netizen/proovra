import archiver from "archiver";
import { PassThrough } from "stream";

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
};

type CustodyEventRecord = {
  sequence?: number | null;
  atUtc?: string | null;
  eventType?: string | null;
  payload?: unknown;
  prevEventHash?: string | null;
  eventHash?: string | null;
};

const ACCESS_EVENT_TYPES = new Set([
  "EVIDENCE_VIEWED",
  "EVIDENCE_DOWNLOADED",
  "VERIFY_VIEWED",
  "REPORT_DOWNLOADED",
  "VERIFICATION_PACKAGE_DOWNLOADED",
  "TECHNICAL_VERIFICATION_CHECKED",
]);

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

    if (ACCESS_EVENT_TYPES.has(String(event.eventType ?? "").trim())) {
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
  anchorProvider?: string | null;
  anchorPublicBaseUrl?: string | null;
}): string {
  const providerLine = params.anchorProvider
    ? `Provider: ${params.anchorProvider}`
    : "Provider: Not configured";

  const publicBaseLine = params.anchorPublicBaseUrl
    ? `Public base URL: ${params.anchorPublicBaseUrl}`
    : "Public base URL: Not configured";

  if (params.anchorMode === "off") {
    return `ANCHOR STATUS

Anchor publication is disabled for this environment.
No external publication claim is made for this package.
${providerLine}
${publicBaseLine}`;
  }

  if (params.anchorMode === "active") {
    return `ANCHOR STATUS

External anchor mode is enabled for this environment.
${
  params.hasAnchorPayload
    ? "This package includes anchor-ready payload material."
    : "This package does not include anchor payload material."
}
No external publication receipt or transaction identifier is attached inside this package yet.
${providerLine}
${publicBaseLine}`;
  }

  return `ANCHOR STATUS

Anchor-ready mode is enabled for this environment.
${
  params.hasAnchorPayload
    ? "This package includes anchor-ready integrity material."
    : "This package does not include anchor-ready integrity material."
}
No external publication receipt or transaction identifier is attached to this record yet.
${providerLine}
${publicBaseLine}`;
}

function buildEvidenceManifest(
  evidenceFiles: VerificationEvidenceFile[]
): Record<string, unknown> {
  return {
    multipart: evidenceFiles.length > 1,
    partCount: evidenceFiles.length,
    files: evidenceFiles.map((file, index) => ({
      index: index + 1,
      name: normalizeFileName(file.name, `part-${index + 1}`),
      sizeBytes: file.buffer.length,
    })),
  };
}

function buildOriginalLinkage(
  evidenceFiles: VerificationEvidenceFile[],
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
      packageName: normalizeFileName(file.name, `part-${index + 1}`),
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
  anchorProvider?: string | null;
  anchorPublicBaseUrl?: string | null;
  evidenceId?: string;
  reportVersion?: number;
  signingKeyId?: string;
  signingKeyVersion?: number;
  hasReportArtifact: boolean;
}): string {
  const multipart = params.evidenceFiles.length > 1;

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

timestamp.tsr
RFC3161 timestamp token issued by a trusted timestamp authority, when available.

public-key.pem
Public key used to verify the signature.

custody.json
Chain of custody events recorded by the system.

anchor.json
Anchor-ready integrity payload that binds the fingerprint hash to the latest hashed custody event, when available.

package-manifest.json
Package metadata describing the verification bundle.

integrity-summary.json
High-level package integrity profile.

original-linkage.json
Links the included file(s), storage preservation details, and report artifact back to the preserved original record.

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

## Review posture

This declaration describes the process and artifact boundaries. It does not independently determine legal admissibility, authenticity disputes, authorship, or factual truth.
`;
}

function buildVerifyHtml(params: {
  evidenceFiles: VerificationEvidenceFile[];
  anchorIncluded: boolean;
  hasTimestampToken: boolean;
  evidenceId?: string;
  reportVersion?: number;
}): string {
  const multipart = params.evidenceFiles.length > 1;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>PROOVRA Evidence Verifier</title>
<style>
body{font-family:Arial,sans-serif;padding:40px;background:#f8fafc;color:#0f172a;line-height:1.6}
h1{color:#1f3a5f}
.box{padding:20px;border:1px solid #cbd5e1;border-radius:12px;background:#ffffff;max-width:960px}
code{background:#eef2ff;padding:2px 6px;border-radius:6px}
ul{margin-top:8px}
.meta{margin-bottom:18px;color:#475569}
</style>
</head>
<body>
<h1>PROOVRA Evidence Verification</h1>
<div class="box">
  <div class="meta">
    <div><strong>Evidence ID:</strong> ${safeText(params.evidenceId, "Not included")}</div>
    <div><strong>Report Version:</strong> ${
      typeof params.reportVersion === "number"
        ? String(params.reportVersion)
        : "Not included"
    }</div>
    <div><strong>Structure:</strong> ${
      multipart ? "Multipart evidence package" : "Single evidence item"
    }</div>
  </div>

  <p>This package contains the material required to review and verify the recorded evidence state.</p>

  <p><strong>Included files:</strong></p>
  <ul>
    <li>Evidence file(s)</li>
    <li>fingerprint.json</li>
    <li>signature.txt</li>
    ${params.hasTimestampToken ? "<li>timestamp.tsr</li>" : ""}
    <li>public-key.pem</li>
    <li>custody.json</li>
    ${params.anchorIncluded ? "<li>anchor.json</li>" : ""}
    ${multipart ? "<li>evidence-manifest.json</li>" : ""}
    <li>package-manifest.json</li>
    <li>integrity-summary.json</li>
    <li>README.txt</li>
  </ul>

  ${
    multipart
      ? "<p>For multipart evidence, open <code>evidence-manifest.json</code> and review the files inside <code>evidence-parts/</code>.</p>"
      : "<p>For single-file evidence, review the included original evidence file at the root of the package.</p>"
  }

  <p>Use cryptographic tools to verify the signature and timestamp where available.</p>
  <p>This verification package is intended to support independent technical review and does not require live access to PROOVRA servers.</p>
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

    const anchorMode = normalizeAnchorMode(data.anchorMode);
    const anchorIncluded = Boolean(data.anchor);
    const hasTimestampToken = Boolean(data.timestampToken);
    const metadata = data.metadata ?? {};
    const certificationSummary = buildCertificationSummary({
      custodian: data.certifications?.custodian ?? null,
      qualifiedPerson: data.certifications?.qualifiedPerson ?? null,
    });
    const custodySplit = splitCustodyEvents(data.custody);

    if (evidenceFiles.length === 1) {
      const file = evidenceFiles[0];
      archive.append(file.buffer, {
        name: normalizeFileName(file.name, "evidence-file"),
      });
    } else {
      evidenceFiles.forEach((file, index) => {
        archive.append(file.buffer, {
          name: `evidence-parts/${String(index + 1).padStart(4, "0")}-${normalizeFileName(
            file.name,
            `part-${index + 1}`
          )}`,
        });
      });

      archive.append(
        JSON.stringify(buildEvidenceManifest(evidenceFiles), null, 2),
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
      evidenceFiles,
      anchorIncluded,
      anchorMode,
      anchorProvider: data.anchorProvider,
      anchorPublicBaseUrl: data.anchorPublicBaseUrl,
      hasTimestampToken,
      hasActualCertifications: certificationSummary.hasActualCertifications,
    });

    archive.append(JSON.stringify(packageManifest, null, 2), {
      name: "package-manifest.json",
    });

    archive.append(
      JSON.stringify(
        buildIntegritySummary({
          evidenceFiles,
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
      JSON.stringify(buildOriginalLinkage(evidenceFiles, metadata), null, 2),
      {
        name: "original-linkage.json",
      }
    );

    archive.append(
      JSON.stringify(
        buildArtifactBoundaries({
          evidenceFiles,
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
          evidenceFiles,
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
        anchorProvider: data.anchorProvider,
        anchorPublicBaseUrl: data.anchorPublicBaseUrl,
        evidenceId: data.evidenceId,
        reportVersion: data.reportVersion,
        signingKeyId: data.signingKeyId,
        signingKeyVersion: data.signingKeyVersion,
        hasReportArtifact: Boolean(data.reportPdf),
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
