import QRCode from "qrcode";
import sharp from "sharp";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CAPTURE_LOCATION_CONTEXT_DESCRIPTION,
  CAPTURE_LOCATION_LEGAL_BOUNDARY,
  CAPTURE_LOCATION_SOURCE_LABEL,
  CAPTURE_LOCATION_STATUS_LABEL,
  buildCaptureLocationDisplayModel,
  buildCaptureLocationPdfFallbackSvg,
  formatCaptureLocationAccuracy,
  formatCaptureLocationCoordinate,
  getReviewerEvidenceTypeLabel,
  hasCaptureLocationMetadata,
  isCompleteOtsAnchor,
} from "@proovra/shared";
import type {
  CalloutModel,
  CustodyHashRow,
  InfoCard,
  KeyValueRow,
  PresentationMode,
  ReportAnchorSummary,
  ReportArtifactMode,
  ReportCertificationSnapshot,
  ReportCustodyEvent,
  ReportEvidence,
  ReportEvidenceAsset,
  ReportEvidenceContentSummary,
  ReportPresentationBuckets,
  ReportPresentationDecisions,
  ReportPreviewPolicy,
  ReportReviewGuidance,
  ReportV2Input,
  ReportViewModel,
  ReportVariant,
} from "./types.js";
import {
  buildPublicEvidenceReference,
  buildPublicSigningKeyReference,
  formatBytesHuman,
  maskEmail,
  safe,
  safeBooleanLabel,
} from "./formatters.js";
import {
  mapAnchorModePublicLabel,
  mapCaptureMethodLabel,
  mapCertificationStatusLabel,
  mapEvidenceAssetKindLabel,
  mapIdentityLevelLabel,
  mapObjectLockModePublicLabel,
  mapOtsStatusPublicLabel,
  mapOtsStatusPublicLabelWithTxid,
  mapRecordStatusLabel,
  mapTimestampStatusPublicLabel,
  mapCustodyEventLabel,
  mapVerificationSourceLabel,
  mapVerificationStatusLabel,
} from "./normalizers.js";
import {
  buildFingerprintNarrative,
  buildPresentationBuckets,
  buildInventoryRows,
  evidenceStructureLabel,
  isPreviewRenderable,
  parseFingerprintSummary,
  resolveContentItems,
  resolveContentSummary,
  resolvePrimaryContentItem,
} from "./content-model.js";
import {
  buildMismatchNarrative,
  buildTimelineRows,
  splitCustodyEvents,
} from "./custody-model.js";
import {
  buildExecutiveConclusion,
  buildIntegrityReadinessSummary,
  buildLegalLimitationShort,
  buildOtsCallout,
  buildReviewSequence,
  buildStorageCallout,
  buildTimestampCallout,
  buildTrustDecision,
  hasCoreCryptoMaterials,
  isIntegrityVerified,
  normalizeStorageTone,
  normalizeTimestampTone,
} from "./truth-model.js";
import {
  buildOrganizationDisplay,
  buildTechnicalAppendixModel,
  buildTechnicalIdentityRows,
  buildTimestampRows,
  buildOtsRows,
  buildAnchorRows,
  resolveAnchorSummary,
} from "./technical-model.js";
import { renderCaptureLocationMapPreviewDataUrl } from "../capture-location-map.js";

type DisplayDescriptor = {
  displayTitle: string;
  displayDescription: string | null;
};

const PREVIEW_DATA_URL_RE = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i;

function buildVerifyUrl(evidenceId: string, provided?: string | null): string {
  const base = (
    process.env.REPORT_VERIFY_BASE_URL ?? "https://app.proovra.com/verify"
  )
    .trim()
    .replace(/\/+$/, "");

  const fallback = `${base}/${encodeURIComponent(evidenceId)}`;

  const v = typeof provided === "string" ? provided.trim() : "";
  if (!v) return fallback;

  try {
    const url = new URL(v);
    const token = url.pathname.split("/").filter(Boolean).at(-1) ?? "";

    // reject broken/short verify tokens like /verify/814c5
    if (token.length < 12) return fallback;

    return url.toString();
  } catch {
    return fallback;
  }
}

async function generateQrDataUrl(value: string): Promise<string | null> {
  const text = safe(value, "");
  if (!text) return null;

  try {
    return await QRCode.toDataURL(text, {
      margin: 1,
      width: 256,
      errorCorrectionLevel: "M",
    });
  } catch (error) {
    console.error("[report-v2] Failed to generate QR data URL:", error);
    return null;
  }
}

function resolveDisplayDescriptor(
  evidence: ReportEvidence,
  contentSummary: ReportEvidenceContentSummary
): DisplayDescriptor {
  if (evidence.display?.displayTitle) {
    return {
      displayTitle: evidence.display.displayTitle,
      displayDescription: evidence.display.displayDescription ?? null,
    };
  }

  const displayTitle =
    safe(evidence.displayTitle, "") ||
    safe(evidence.title, "") ||
    "Digital Evidence Record";

  const displayDescription =
    safe(evidence.displayDescription, "") ||
    safe(evidence.contentCompositionSummary, "") ||
    (contentSummary.totalSizeDisplay
      ? `${evidenceStructureLabel(contentSummary)} • ${contentSummary.totalSizeDisplay}`
      : evidenceStructureLabel(contentSummary));

  return {
    displayTitle,
    displayDescription: displayDescription || null,
  };
}

function resolvePreviewPolicy(evidence: ReportEvidence): ReportPreviewPolicy {
  return (
    evidence.previewPolicy ?? {
      contentVisible: false,
      previewEnabled: false,
      downloadableFromVerify: false,
      rationale:
        "Evidence content may be described in the report while technical verification separately validates the recorded integrity state.",
      privacyNotice:
        "Anyone with access to the report or verification page may be able to inspect evidence-related materials exposed there.",
    }
  );
}

function resolveReviewGuidance(
  evidence: ReportEvidence,
  itemCount: number,
  previewableItemCount: number,
  integrityVerified: boolean
): ReportReviewGuidance {
  return (
    evidence.reviewGuidance ?? {
      reviewerWorkflow: [
        "First review the evidence content and item structure.",
        "Then review the recorded integrity outcome and custody chronology.",
        "Finally evaluate relevance, context, authorship, and admissibility separately.",
      ],
      contentReviewNote:
        previewableItemCount > 0
          ? "The report includes a structured evidence inventory and supports direct review of recorded evidence content where preview is appropriate."
          : "The recorded evidence content is not directly previewable in a standard way, but its structure and recorded integrity state remain reviewable.",
      legalAssessmentNote:
        "Use the evidence content together with the technical verification record; neither should be treated as a substitute for the other.",
      integrityAssessmentNote: integrityVerified
        ? "The recorded technical integrity checks passed for the available materials at report generation time."
        : "One or more recorded technical integrity checks require manual review before relying on this record.",
      multipartReviewNote:
        itemCount > 1
          ? "This record contains multiple items and should be reviewed as a package, including the role of the primary item."
          : "This record contains a single primary evidence item.",
    }
  );
}

function resolveLegalLimitations(evidence: ReportEvidence) {
  return (
    evidence.limitations ?? {
      short:
        "This report verifies the recorded integrity state of the evidence record. It does not independently prove factual truth, authorship, context, or legal admissibility.",
      detailed:
        "Technical verification supports detection of post-completion changes to the recorded evidence state. It does not by itself establish who created the content, whether the depicted events are true, or whether any court, insurer, regulator, employer, or authority must accept the material. Admissibility, evidentiary weight, authenticity disputes, and procedural acceptance remain matters for the competent decision-maker under applicable law.",
    }
  );
}

function mapPublicEvidenceTypeLabel(
  evidence: ReportEvidence,
  summary: ReportEvidenceContentSummary
): string {
  return getReviewerEvidenceTypeLabel({
    itemCount: summary.itemCount,
    structure: summary.structure,
    imageCount: summary.imageCount,
    videoCount: summary.videoCount,
    audioCount: summary.audioCount,
    pdfCount: summary.pdfCount,
    textCount: summary.textCount,
    otherCount: summary.otherCount,
    evidenceType: evidence.type,
    mimeType: evidence.mimeType,
  });
}

function normalizeProviderFailure(value: string | null | undefined): string {
  const raw = safe(value, "");
  const lower = raw.toLowerCase();

  if (!raw) return "";

  if (
    lower.includes("403") ||
    lower.includes("kontingent") ||
    lower.includes("quota") ||
    lower.includes("verbrauch")
  ) {
    return "Trusted timestamp could not be obtained because the provider quota is exhausted.";
  }

  return raw;
}

function buildExecutiveRows(
  evidence: ReportEvidence,
  structureLabel: string,
  contentSummary: ReportEvidenceContentSummary,
  primaryContentItem: ReportEvidenceAsset | null,
  externalMode: boolean
): KeyValueRow[] {
  const explicitPrimaryItems =
    evidence.contentItems?.filter(
      (item) => item.artifactRole === "primary_evidence"
    ) ?? [];
  const multipleExplicitPrimary = explicitPrimaryItems.length > 1;
  const rows: KeyValueRow[] = [];
  const add = (label: string, value: string | null | undefined) => {
    if (value === null || value === undefined || value === "") return;
    rows.push({ label, value: String(value) });
  };

  add("Evidence Reference", buildPublicEvidenceReference(evidence.id));
  add("Evidence Type", mapPublicEvidenceTypeLabel(evidence, contentSummary));
  add(
    "Verification Status",
    mapVerificationStatusLabel(evidence.verificationStatus)
  );
  add("Evidence Structure", structureLabel);
  add("Item Count", String(contentSummary.itemCount));
  add(
    multipleExplicitPrimary ? "Primary Evidence Set" : "Lead Review Item",
    multipleExplicitPrimary
      ? `${explicitPrimaryItems.length} items explicitly marked primary`
      : primaryContentItem
        ? safe(primaryContentItem.originalFileName || primaryContentItem.label)
        : "No identified lead item"
  );
  add(
    multipleExplicitPrimary ? "Primary Evidence Coverage" : "Lead Item Type",
    multipleExplicitPrimary
      ? explicitPrimaryItems
          .map((item) => safe(item.originalFileName || item.label))
          .filter(Boolean)
          .slice(0, 3)
          .join(" • ")
      : primaryContentItem
        ? mapEvidenceAssetKindLabel(primaryContentItem.kind)
        : null
  );
  add("Total Content Size", safe(contentSummary.totalSizeDisplay));
  // Issue #6: be precise about timestamp provenance. capturedAtUtc / signedAtUtc
  // are SERVER clocks recorded at intake / signing — not device-witnessed times.
  add("Recorded at intake (server UTC)", safe(evidence.capturedAtUtc));
  add("Signed (server UTC)", safe(evidence.signedAtUtc));
  add(
    "Submitted By",
    externalMode
      ? maskEmail(evidence.submittedByEmail)
      : safe(evidence.submittedByEmail)
  );
  add("Organization / Workspace", buildOrganizationDisplay(evidence));
  add(
    "Integrity Verified At (UTC)",
    safe(evidence.recordedIntegrityVerifiedAtUtc)
  );

  return rows;
}

function formatReportTimestamp(value: string | null | undefined): string {
  const raw = safe(value, "");
  if (!raw) return "Not recorded";

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return raw;
  }

  return parsed.toISOString().replace(".000Z", " UTC").replace("T", " ");
}

async function writeCaptureContextDebugArtifact(
  dataUrl: string,
  evidenceId: string
): Promise<void> {
  if (process.env.PROOVRA_CAPTURE_MAP_DEBUG !== "true") {
    return;
  }

  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match?.[1] || !match[2]) {
    console.warn("[report-v2] capture-context debug artifact skipped: unsupported data URL");
    return;
  }

  const extension = match[1].includes("png") ? "png" : match[1].includes("svg") ? "svg" : "bin";
  const outputPath = path.join(
    os.tmpdir(),
    `proovra-capture-location-map-debug-${evidenceId}.${extension}`
  );

  await fs.writeFile(outputPath, Buffer.from(match[2], "base64"));
  console.info("[report-v2] capture-context debug artifact written", {
    outputPath,
    mimeType: match[1],
    bytes: Buffer.byteLength(match[2], "base64"),
  });
}

async function optimizePreviewDataUrl(
  value: string | null | undefined,
  presentationMode: PresentationMode
): Promise<string | null | undefined> {
  const dataUrl = safe(value, "");
  if (!dataUrl) return value;

  const match = dataUrl.match(PREVIEW_DATA_URL_RE);
  if (!match?.[1]) return value;

  const source = Buffer.from(match[1], "base64");
  const shouldProcess = source.length > 80_000 || presentationMode !== "heavy";
  if (!shouldProcess) return value;

  const maxEdge =
    presentationMode === "simple"
      ? 820
      : presentationMode === "medium"
        ? 880
        : 940;

  try {
    const optimized = await sharp(source, { limitInputPixels: 24_000_000 })
      .rotate()
      .resize({
        width: maxEdge,
        height: maxEdge,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 70, mozjpeg: true })
      .toBuffer();

    return `data:image/jpeg;base64,${optimized.toString("base64")}`;
  } catch (error) {
    console.warn("[report-v2] Failed to optimize preview image:", error);
    return value;
  }
}

async function optimizeEvidencePreviews(
  items: ReportEvidenceAsset[],
  presentationMode: PresentationMode
): Promise<ReportEvidenceAsset[]> {
  return Promise.all(
    items.map(async (item) =>
      Object.assign({}, item, {
        previewDataUrl: await optimizePreviewDataUrl(
          item.previewDataUrl,
          presentationMode
        ),
      })
    )
  );
}

function buildVerificationSummaryRows(
  evidence: ReportEvidence,
  custody: ReturnType<typeof splitCustodyEvents>,
  structureLabel: string,
  contentSummary: ReportEvidenceContentSummary,
  primaryContentItem: ReportEvidenceAsset | null,
  externalMode: boolean
): KeyValueRow[] {
  const explicitPrimaryItems =
    evidence.contentItems?.filter(
      (item) => item.artifactRole === "primary_evidence"
    ) ?? [];
  const multipleExplicitPrimary = explicitPrimaryItems.length > 1;
  const rows: KeyValueRow[] = [];
  const add = (label: string, value: string | null | undefined) => {
    if (value === null || value === undefined || value === "") return;
    rows.push({ label, value: String(value) });
  };

  add("Evidence Reference", buildPublicEvidenceReference(evidence.id));
  add("Integrity State", mapVerificationStatusLabel(evidence.verificationStatus));

  const recordedDigestLabel =
    contentSummary.itemCount > 1
      ? "Canonical Package Digest (SHA-256)"
      : "Original File SHA-256";

  add(recordedDigestLabel, safe(evidence.fileSha256));
  add("Canonical Fingerprint Hash", safe(evidence.fingerprintHash));

  if (contentSummary.itemCount > 1 && primaryContentItem?.sha256) {
    add(
      multipleExplicitPrimary
        ? "Representative Primary Item SHA-256"
        : "Lead Item SHA-256",
      safe(primaryContentItem.sha256)
    );
  }

  add("Primary MIME Type", safe(contentSummary.primaryMimeType));
    add("Content Size", formatBytesHuman(evidence.sizeBytes));
  add("Forensic Custody Events", String(custody.forensic.length));
  add(
    "Signature Materials",
    evidence.signatureBase64 && evidence.signingKeyId
      ? "Recorded"
      : "Incomplete"
  );
  add(
    "Timestamp Status",
    mapTimestampStatusPublicLabel(evidence.tsaStatus)
  );
add(
  "Anchoring Status",
  mapOtsStatusPublicLabelWithTxid({
    status: evidence.otsStatus,
    bitcoinTxid: evidence.otsBitcoinTxid,
  })
);
  add("Last Verified At (UTC)", safe(evidence.lastVerifiedAtUtc));
  add(
    "Last Verified Source",
    mapVerificationSourceLabel(evidence.lastVerifiedSource)
  );
  add("Storage Lock Mode", mapObjectLockModePublicLabel(evidence.storageObjectLockMode));
  add("Retention Until (UTC)", safe(evidence.storageObjectLockRetainUntilUtc));
  add("Report Generated At (UTC)", safe(evidence.reportGeneratedAtUtc));
  add("Evidence Structure", structureLabel);
  add("Previewable Items", String(contentSummary.previewableItemCount));
  add("Downloadable Items", String(contentSummary.downloadableItemCount));
  add(
    "Verification Package Version",
    !externalMode && evidence.verificationPackageVersion
      ? String(evidence.verificationPackageVersion)
      : null
  );

  return rows;
}

function resolveOtsPresentationEvidence(evidence: ReportEvidence): ReportEvidence {
  const complete = isCompleteOtsAnchor({
    status: evidence.otsStatus,
    bitcoinTxid: evidence.otsBitcoinTxid,
    anchoredAtUtc: evidence.otsAnchoredAtUtc,
  });

  if (complete) {
    return Object.assign({}, evidence, {
      otsStatus: "ANCHORED",
      otsFailureReason: null,
    });
  }

  if (safe(evidence.otsStatus, "").toUpperCase() === "ANCHORED") {
    return Object.assign({}, evidence, {
      otsStatus: "PENDING",
      otsAnchoredAtUtc: null,
      otsFailureReason: null,
    });
  }

  return evidence;
}

function buildReviewReadinessRows(
  evidence: ReportEvidence,
  custody: ReturnType<typeof splitCustodyEvents>,
  externalMode: boolean
): KeyValueRow[] {
  return [
    {
      label: "Human Summary Ready",
      value: evidence.reviewReadyAtUtc ? "Yes" : "Not recorded",
    },
    {
      label: "Verification Status",
      value: mapVerificationStatusLabel(evidence.verificationStatus),
    },
    {
      label: "Timestamp Status",
      value: mapTimestampStatusPublicLabel(evidence.tsaStatus),
    },

{
  label: "RFC 3161 Note",
  value: normalizeProviderFailure(evidence.tsaFailureReason),
},

{
  label: "Public Anchoring Status",
  value: mapOtsStatusPublicLabelWithTxid({
    status: evidence.otsStatus,
    bitcoinTxid: evidence.otsBitcoinTxid,
  }),
},
    {
      label: "Immutable Storage",
      value: safeBooleanLabel(
        evidence.storageImmutable,
        "Verified",
        "Recorded with limitations",
        "Not reported"
      ),
    },
    {
      label: "Chain of Custody Present",
      value: custody.forensic.length > 0 ? "Yes" : "No",
    },
    {
      label: "Technical Materials Available",
      value:
        evidence.fileSha256 &&
        evidence.fingerprintHash &&
        evidence.signatureBase64 &&
        evidence.signingKeyId
          ? "Yes"
          : "Incomplete",
    },
    {
      label: "Submitted By",
      value: externalMode
        ? maskEmail(evidence.submittedByEmail)
        : safe(evidence.submittedByEmail),
    },
    {
      label: "Identity Level",
      value: mapIdentityLevelLabel(evidence.identityLevelSnapshot),
    },
    {
      label: "Capture Method",
      value: mapCaptureMethodLabel(evidence.captureMethod),
    },
    {
      label: "Organization / Workspace",
      value: buildOrganizationDisplay(evidence),
    },
  ];
}

function buildEvidenceContentSummaryRows(
  contentSummary: ReportEvidenceContentSummary,
  primaryItem: ReportEvidenceAsset | null,
  evidence?: ReportEvidence
): KeyValueRow[] {
  const explicitPrimaryItems =
    evidence?.contentItems?.filter(
      (item) => item.artifactRole === "primary_evidence"
    ) ?? [];
  const multipleExplicitPrimary = explicitPrimaryItems.length > 1;
  const rows: KeyValueRow[] = [];
  const add = (label: string, value: string | null | undefined) => {
    if (value === null || value === undefined || value === "") return;
    rows.push({ label, value: String(value) });
  };

  add(
    "Structure",
    contentSummary.structure === "multipart"
      ? "Multipart evidence package"
      : "Single evidence item"
  );
  add("Total Items", String(contentSummary.itemCount));
  add("Previewable Items", String(contentSummary.previewableItemCount));
  add("Downloadable Items", String(contentSummary.downloadableItemCount));
  add(
    "Images",
    contentSummary.imageCount > 0 ? String(contentSummary.imageCount) : null
  );
  add(
    "Videos",
    contentSummary.videoCount > 0 ? String(contentSummary.videoCount) : null
  );
  add(
    "Audio",
    contentSummary.audioCount > 0 ? String(contentSummary.audioCount) : null
  );
  add(
    "PDF",
    contentSummary.pdfCount > 0 ? String(contentSummary.pdfCount) : null
  );
  add(
    "Text",
    contentSummary.textCount > 0 ? String(contentSummary.textCount) : null
  );
  add(
    "Other",
    contentSummary.otherCount > 0 ? String(contentSummary.otherCount) : null
  );
  add(
    multipleExplicitPrimary ? "Primary Evidence Set" : "Lead Review Item",
    multipleExplicitPrimary
      ? `${explicitPrimaryItems.length} items explicitly marked primary`
      : primaryItem
        ? safe(primaryItem.originalFileName || primaryItem.label)
        : null
  );
  add(
    multipleExplicitPrimary ? "Primary Evidence Coverage" : "Lead Item Type",
    multipleExplicitPrimary
      ? explicitPrimaryItems
          .map((item) => mapEvidenceAssetKindLabel(item.kind))
          .filter(Boolean)
          .slice(0, 3)
          .join(" • ")
      : primaryItem
        ? mapEvidenceAssetKindLabel(primaryItem.kind)
        : null
  );
  add("Primary MIME Type", safe(contentSummary.primaryMimeType));
  add("Total Size", safe(contentSummary.totalSizeDisplay));
  add("Composition Summary", safe(evidence?.contentCompositionSummary));
  add("Content Access Mode", safe(evidence?.contentAccessPolicy?.mode));
  add(
    "Content View Allowed",
    evidence?.contentAccessPolicy
      ? safeBooleanLabel(
          evidence.contentAccessPolicy.allowContentView,
          "Yes",
          "No",
          "Not recorded"
        )
      : null
  );
  add(
    "Download Allowed",
    evidence?.contentAccessPolicy
      ? safeBooleanLabel(
          evidence.contentAccessPolicy.allowDownload,
          "Yes",
          "No",
          "Not recorded"
        )
      : null
  );

  return rows;
}

function buildStorageRows(
  evidence: ReportEvidence,
  anchorSummary: ReportAnchorSummary | null
): KeyValueRow[] {
  const rows: KeyValueRow[] = [
    { label: "Storage Region", value: safe(evidence.storageRegion) },
    {
      label: "Storage Protection Mode",
      value: mapObjectLockModePublicLabel(evidence.storageObjectLockMode),
    },
{
  label: "Protected from modification until",
  value: evidence.storageObjectLockRetainUntilUtc
    ? `${new Date(evidence.storageObjectLockRetainUntilUtc).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })} (${evidence.storageObjectLockRetainUntilUtc})`
    : "Not recorded",
},
    {
      label: "Legal Hold",
      value: safe(evidence.storageObjectLockLegalHoldStatus, "OFF"),
    },
    {
      label: "Immutable Storage",
      value: safeBooleanLabel(
        evidence.storageImmutable,
        "Verified",
        "Recorded with limitations",
        "Not reported"
      ),
    },
    { label: "RFC 3161 Provider", value: safe(evidence.tsaProvider) },
    {
      label: "RFC 3161 URL",
      value: safe(evidence.tsaUrl),
    },
    { label: "RFC 3161 Serial", value: safe(evidence.tsaSerialNumber) },
    { label: "RFC 3161 Time (UTC)", value: safe(evidence.tsaGenTimeUtc) },
    {
      label: "RFC 3161 Hash Algorithm",
      value: safe(evidence.tsaHashAlgorithm),
    },
    {
      label: "RFC 3161 Status",
      value: mapTimestampStatusPublicLabel(evidence.tsaStatus),
    },
{
  label: "Public Anchoring Status",
  value: mapOtsStatusPublicLabelWithTxid({
    status: evidence.otsStatus,
    bitcoinTxid: evidence.otsBitcoinTxid,
  }),
},
    {
      label: "RFC 3161 Note",
      value: normalizeProviderFailure(evidence.tsaFailureReason),
    },
  ].filter((row) => safe(row.value, "") !== "");
  
  const otsRows: KeyValueRow[] = [
    { label: "OTS Calendar", value: safe(evidence.otsCalendar, "") },
    { label: "OTS Anchored At (UTC)", value: safe(evidence.otsAnchoredAtUtc, "") },
    { label: "OTS Upgraded At (UTC)", value: safe(evidence.otsUpgradedAtUtc, "") },
    {
      label: "OTS Bitcoin TxID",
      value: safe(evidence.otsBitcoinTxid, ""),
    },
  ].filter((row) => safe(row.value, "") !== "");

  rows.push(...otsRows);

  if (anchorSummary) {
    rows.push(
      {
        label: "External Anchor Mode",
        value: mapAnchorModePublicLabel(anchorSummary.mode),
      },
      {
        label: "External Anchor Provider",
        value: safe(anchorSummary.provider),
      },
      {
        label: "Anchor Published",
        value: safeBooleanLabel(anchorSummary.published, "Yes", "No"),
      },
      {
        label: "Anchor Anchored At (UTC)",
        value: safe(anchorSummary.anchoredAtUtc),
      },
      {
        label: "Anchor Public URL",
        value: safe(anchorSummary.publicUrl),
      },
      {
        label: "Anchor Receipt ID",
        value: safe(anchorSummary.receiptId),
      },
      {
        label: "Anchor Transaction ID",
        value: safe(anchorSummary.transactionId),
      }
    );
  }

  return rows;
}

function buildCustodyHashRows(events: ReportCustodyEvent[]): CustodyHashRow[] {
  return events
    .filter((event) => safe(event.eventHash, "") || safe(event.prevEventHash, ""))
    .map((event, index) => {
      const sequence =
        event.sequence !== null && event.sequence !== undefined
          ? String(event.sequence)
          : String(index + 1);

      return {
        sequence,
        atUtc: safe(event.atUtc),
        eventLabel: mapCustodyEventLabel(event.eventType),
        prevEventHash: safe(event.prevEventHash),
        eventHash: safe(event.eventHash),
      };
    });
}

function determinePresentationMode(
  contentSummary: ReportEvidenceContentSummary,
  contentItems: ReportEvidenceAsset[],
  custody: ReturnType<typeof splitCustodyEvents>,
  evidence: ReportEvidence
): PresentationMode {
  let score = 0;

  if (contentSummary.itemCount >= 4) score += 1;
  if (contentSummary.itemCount >= 8) score += 2;
  if (contentSummary.previewableItemCount >= 4) score += 1;
  if (custody.forensic.length > 8) score += 1;
  if (evidence.certifications?.custodian || evidence.certifications?.qualifiedPerson) {
    score += 1;
  }

  const kinds = new Set(contentItems.map((item) => item.kind));
  if (kinds.size > 2) score += 1;
  if (kinds.has("video") || kinds.has("audio")) score += 1;

  const totalBytes = Number(contentSummary.totalSizeBytes ?? evidence.sizeBytes ?? 0);
  if (Number.isFinite(totalBytes) && totalBytes > 10 * 1024 * 1024) score += 1;

  if (score <= 1) return "simple";
  if (score <= 4) return "medium";
  return "heavy";
}

function mapReportVariant(mode: PresentationMode): ReportVariant {
  if (mode === "simple") return "compact";
  if (mode === "medium") return "balanced";
  return "full";
}

function buildPresentationDecisions(params: {
  presentationMode: PresentationMode;
  contentSummary: ReportEvidenceContentSummary;
  certifications: boolean;
}): ReportPresentationDecisions {
  const { presentationMode, contentSummary, certifications } = params;

  return {
    showAllPreviewableItems: true,
    showSupportingPreviewCards: contentSummary.previewableItemCount > 1,
    compactExecutiveSummary: presentationMode === "simple",
    compactLegalSection: presentationMode !== "heavy",
    compactForensicStatement: presentationMode === "simple",
    showHashChainDetailsInMainFlow: false,
    showEvidenceContentSection: presentationMode !== "simple",
    showCertificationSection: certifications,
    appendixDepth:
      presentationMode === "simple"
        ? "compact"
        : presentationMode === "medium"
          ? "balanced"
          : "full",
  };
}

function buildCertificationBlockTitle(
  kind: "custodian" | "qualified"
): string {
  return kind === "custodian"
    ? "Custodian certification state"
    : "Qualified-person certification state";
}

function buildCertificationCallout(
  cert: ReportCertificationSnapshot,
  kind: "custodian" | "qualified"
): CalloutModel {
  const title = buildCertificationBlockTitle(kind);
  const status = safe(cert?.status, "").toUpperCase();

  if (status === "ATTESTED") {
    return {
      title,
      body:
        kind === "custodian"
          ? "A custodian attestation record is attached and corresponds to the preserved evidence state."
          : "A qualified-person certification record is attached and corresponds to the preserved evidence state.",
      tone: "success",
    };
  }

  if (status === "REVOKED") {
    return {
      title,
      body:
        kind === "custodian"
          ? "A custodian certification record was revoked. Review the record carefully and use the attached state information to understand the revocation context."
          : "A qualified-person certification record was revoked. Review the record carefully and use the attached state information to understand the revocation context.",
      tone: "danger",
    };
  }

  return {
    title,
    body:
      kind === "custodian"
        ? "A custodian certification workflow exists but is not yet fully attested."
        : "A qualified-person certification workflow exists but is not yet fully attested.",
    tone: status === "REQUESTED" || status === "DRAFT" ? "warning" : "neutral",
  };
}

function buildCertificationRows(
  cert: ReportCertificationSnapshot,
  kind: "custodian" | "qualified"
): KeyValueRow[] {
  const prefix = kind === "custodian" ? "Custodian" : "Qualified Person";

  return [
    {
      label: `${prefix} Status`,
      value: mapCertificationStatusLabel(cert?.status),
    },
    { label: `${prefix} Version`, value: String(cert?.version ?? "N/A") },
    { label: `${prefix} Requested At`, value: safe(cert?.requestedAtUtc) },
    { label: `${prefix} Attested At`, value: safe(cert?.attestedAtUtc) },
    { label: `${prefix} Attestor Name`, value: safe(cert?.attestorName) },
    { label: `${prefix} Attestor Title`, value: safe(cert?.attestorTitle) },
    {
      label: `${prefix} Organization`,
      value: safe(cert?.attestorOrganization),
    },
    {
      label: `${prefix} Certification Hash`,
      value: safe(cert?.certificationHash),
    },
    { label: `${prefix} Revoked At`, value: safe(cert?.revokedAtUtc) },
  ];
}

function buildForensicIntegrityStatementModel(
  verifyUrl: string,
  structureLabel: string,
  externalMode: boolean,
  evidence?: ReportEvidence
) {
  const explicitPrimaryCount =
    evidence?.contentItems?.filter(
      (item) => item.artifactRole === "primary_evidence"
    ).length ?? 0;
  const multipleExplicitPrimary = explicitPrimaryCount > 1;
  return {
    introLead:
      "Procedural verification checklist",
    introBody:
      "Use this section as a review workflow for validating the report against the preserved evidence package and the verification endpoint.",
    includedBulletItems: [
      multipleExplicitPrimary
        ? "Confirm the evidence reference, package structure, and the explicit primary evidence set."
        : "Confirm the evidence reference, package structure, and lead review item.",
      multipleExplicitPrimary
        ? "Validate the representative primary-item SHA-256, the canonical package digest, and the canonical fingerprint hash against the preserved materials."
        : "Validate the lead item SHA-256, original file or canonical package digest, and canonical fingerprint hash against the preserved materials.",
"Review custody chronology before relying on the evidence record.",
      "Use the verification endpoint for signature, timestamp token, and anchoring proof validation.",
    ],
    reviewSteps:
      structureLabel === "Single evidence item"
        ? [
            "Obtain the original evidence file.",
            "Compute the SHA-256 hash of the evidence file.",
            "Compare the computed hash with the value listed in this report.",
            "Verify the digital signature using the provided public key.",
            "Verify the RFC 3161 timestamp token, when present.",
            "Verify the OpenTimestamps proof, when present.",
            "Review the forensic chain of custody events.",
            "Review immutable storage details, when present.",
          ]
        : [
            "Obtain the complete multipart evidence set.",
            "Review the canonical fingerprint and listed evidence parts.",
"Validate the canonical package digest against the recorded package structure and item SHA-256 values.",
            "Verify the digital signature using the provided public key.",
            "Verify the RFC 3161 timestamp token, when present.",
            "Verify the OpenTimestamps proof, when present.",
            "Review the forensic chain of custody events.",
            "Review immutable storage details, when present.",
          ],
    note:
      "Where a timestamp, anchoring record, or signature package exists, this PDF identifies the exact reference values while the verification workflow preserves the heavier validation payloads.",
    legalNotice: {
      title: "Procedural note",
      body:
        "This checklist is operational only and is intentionally separate from the report's legal interpretation section.",
      tone: "neutral" as const,
    },
    verificationLinkLabel: externalMode
      ? "Public verification page:"
      : "Verification link:",
    verificationLinkText: externalMode
      ? "Open public verification page"
      : verifyUrl,
  };
}

function buildTechnicalAppendixCourtRows(params: {
  evidence: ReportEvidence;
  structureLabel: string;
  contentSummary: ReportEvidenceContentSummary;
  primaryContentItem: ReportEvidenceAsset | null;
  custody: ReturnType<typeof splitCustodyEvents>;
  reportVersion: number;
}): KeyValueRow[] {
  const explicitPrimaryItems =
    params.evidence.contentItems?.filter(
      (item) => item.artifactRole === "primary_evidence"
    ) ?? [];
  const multipleExplicitPrimary = explicitPrimaryItems.length > 1;

  return [
    {
      label: "Evidence Record",
      value: buildPublicEvidenceReference(params.evidence.id),
    },
    {
      label: "Package Structure",
      value: `${params.structureLabel} • ${params.contentSummary.itemCount} item${
        params.contentSummary.itemCount === 1 ? "" : "s"
      }`,
    },
    {
      label: multipleExplicitPrimary ? "Primary Evidence Set" : "Lead Review Item",
      value: multipleExplicitPrimary
        ? `${explicitPrimaryItems.length} items explicitly marked primary`
        : params.primaryContentItem?.originalFileName ??
          params.primaryContentItem?.label ??
          "No identified lead item",
    },
    {
  label: "File Digest Present",
  value: params.evidence.fileSha256 ? "Yes" : "No",
},
{
  label: "Canonical Fingerprint Present",
  value: params.evidence.fingerprintHash ? "Yes" : "No",
},
{
  label: "Signature Present",
  value: params.evidence.signatureBase64 ? "Yes" : "No",
},
{
  label: "Public Key Reference",
  value:
    params.evidence.signingKeyId && params.evidence.signingKeyVersion != null
      ? buildPublicSigningKeyReference(
          params.evidence.signingKeyId,
          params.evidence.signingKeyVersion
        )
      : "Not recorded",
},
{
  label: "Custody Chain Present",
  value: params.custody.forensic.length > 0 ? "Yes" : "No",
},
{
  label: "Report Schema Version",
  value: `v${params.reportVersion}`,
},
{
  label: "Verification Package Version",
  value: params.evidence.verificationPackageVersion
    ? `v${params.evidence.verificationPackageVersion}`
    : `Aligned with report v${params.reportVersion} when generated`,
},
{
  label: "Canonical JSON",
  value: params.evidence.fingerprintCanonicalJson
    ? "Available in technical materials / verification package"
    : "Not embedded in appendix",
},
{
  label: params.contentSummary.itemCount > 1
    ? "Primary Package Digest Type"
    : "Primary Digest Type",
  value:
    params.contentSummary.itemCount > 1
      ? "Canonical multipart package digest"
      : "Original file digest",
},
    {
      label: "Signature Material",
      value:
        params.evidence.signatureBase64 &&
        params.evidence.signingKeyId &&
        params.evidence.signingKeyVersion != null
          ? "Recorded"
          : "Incomplete",
    },
    {
      label: "Timestamp Material",
      value: mapTimestampStatusPublicLabel(params.evidence.tsaStatus),
    },
{
  label: "Public Anchoring",
  value: mapOtsStatusPublicLabelWithTxid({
    status: params.evidence.otsStatus,
    bitcoinTxid: params.evidence.otsBitcoinTxid,
  }),
},
    {
      label: "Forensic Custody Events",
      value: String(params.custody.forensic.length),
    },
{
  label: "Access Activity",
  value:
    "Package access snapshot is taken at generation. Current live access activity should be reviewed on the verification page or audit trail when enabled.",
},
    {
      label: "Immutable Storage",
      value: safeBooleanLabel(
        params.evidence.storageImmutable,
        "Verified",
        "Recorded with limitations",
        "Not reported"
      ),
    },
  ];
}

function attachDuplicateDigestGroups(
  items: ReportEvidenceAsset[]
): ReportEvidenceAsset[] {
  const bySha = new Map<string, ReportEvidenceAsset[]>();

  for (const item of items) {
    const sha = safe(item.sha256, "").toLowerCase();
    if (!sha || sha === "n/a" || sha === "not recorded") continue;

    const group = bySha.get(sha) ?? [];
    group.push(item);
    bySha.set(sha, group);
  }

  let groupNumber = 0;
  const duplicateById = new Map<
    string,
    NonNullable<ReportEvidenceAsset["duplicateDigest"]>
  >();

  for (const group of bySha.values()) {
    if (group.length < 2) continue;

    groupNumber += 1;

    const groupId = `D-${String(groupNumber).padStart(2, "0")}`;
    const matchingFileNames = group.map((item) =>
      safe(item.originalFileName || item.label, "Unnamed evidence item")
    );

    for (const item of group) {
      duplicateById.set(item.id, {
        groupId,
        groupNumber,
        groupSize: group.length,
        matchingFileNames,
      });
    }
  }

  return items.map((item) => ({
    ...item,
    duplicateDigest: duplicateById.get(item.id) ?? null,
  }));
}

function buildCustodyCounts(custody: ReturnType<typeof splitCustodyEvents>) {
  const displayedForensicEvents = custody.forensic.length;
  const packageForensicEvents = custody.forensic.length;
  const accessEvents = custody.access.length;
  const totalPackageEvents = custody.all.length;

  return {
    displayedForensicEvents,
    packageForensicEvents,
    accessEvents,
    totalPackageEvents,
    label:
      displayedForensicEvents === packageForensicEvents
        ? `${displayedForensicEvents} forensic events`
        : `Displayed forensic events: ${displayedForensicEvents} / Package forensic events: ${packageForensicEvents}`,
  };
}

export async function buildReportViewModel(
  input: ReportV2Input
): Promise<ReportViewModel> {
  const mode: ReportArtifactMode = input.externalMode ? "external" : "internal";
  const verifyUrl = buildVerifyUrl(input.evidence.id, input.verifyUrl);
  const technicalUrl = verifyUrl.includes("?")
    ? `${verifyUrl}&tab=technical`
    : `${verifyUrl}?tab=technical`;

  const parsedFingerprintSummary = parseFingerprintSummary(
    input.evidence.fingerprintCanonicalJson
  );

  const contentSummary = resolveContentSummary(
    input.evidence,
    parsedFingerprintSummary
  );
  const resolvedContentItems = resolveContentItems(input.evidence);
  const structureLabel =
    input.evidence.evidenceStructure?.trim() ||
    evidenceStructureLabel(contentSummary);

  const previewPolicy = resolvePreviewPolicy(input.evidence);
  const display = resolveDisplayDescriptor(input.evidence, contentSummary);
  const custody = splitCustodyEvents(input.custodyEvents);
  const otsEvidence = resolveOtsPresentationEvidence(input.evidence);
  const integrityVerified = isIntegrityVerified(input.evidence);
const trustDecision = buildTrustDecision({
  evidence: otsEvidence,
  custodyEvents: custody.forensic,
});
  const reviewGuidance = resolveReviewGuidance(
    input.evidence,
    contentSummary.itemCount,
    contentSummary.previewableItemCount,
    integrityVerified
  );
  const legalLimitations = resolveLegalLimitations(input.evidence);
  const anchorSummary = resolveAnchorSummary(input.evidence);
  const externalMode = mode === "external";
  const presentationMode = determinePresentationMode(
    contentSummary,
    resolvedContentItems,
    custody,
    input.evidence
  );
  const reportVariant: ReportVariant = mapReportVariant(presentationMode);
const optimizedContentItems = await optimizeEvidencePreviews(
  resolvedContentItems,
  presentationMode
);

const contentItems = attachDuplicateDigestGroups(optimizedContentItems);

const primaryContentItem = resolvePrimaryContentItem(
  input.evidence,
  contentItems
);
  const presentationBuckets: ReportPresentationBuckets = buildPresentationBuckets({
    items: contentItems,
    primaryItem: primaryContentItem,
    presentationMode,
  });
  const presentationDecisions = buildPresentationDecisions({
    presentationMode,
    contentSummary,
    certifications: Boolean(
      input.evidence.certifications?.custodian ||
        input.evidence.certifications?.qualifiedPerson
    ),
  });

  const executiveConclusion = buildExecutiveConclusion(trustDecision);
  const legalLimitationShort = buildLegalLimitationShort();
  const reviewSequence = buildReviewSequence(
    primaryContentItem?.originalFileName ?? primaryContentItem?.label
  );
  const mismatchSummary = buildMismatchNarrative({
    evidence: otsEvidence,
    integrityVerified,
    forensicEventCount: custody.forensic.length,
  });

  const timestampTone = normalizeTimestampTone(input.evidence.tsaStatus);
  const storageTone = normalizeStorageTone(
    input.evidence.storageImmutable,
    input.evidence.storageObjectLockMode,
    input.evidence.storageObjectLockRetainUntilUtc
  );
  const storageAndTimestampTone =
    timestampTone === "danger" || storageTone === "danger"
      ? "danger"
      : timestampTone === "success" && storageTone === "success"
        ? "success"
        : "warning";

  const technicalQrEnabled =
    !externalMode &&
    (Boolean(input.downloadUrl) ||
      process.env.REPORT_INCLUDE_TECHNICAL_QR === "true");

  const [publicQrDataUrl, technicalQrDataUrl] = await Promise.all([
    generateQrDataUrl(verifyUrl),
    technicalQrEnabled
      ? generateQrDataUrl(technicalUrl)
      : Promise.resolve(null),
  ]);

  const leadItemName =
    primaryContentItem?.originalFileName ??
    primaryContentItem?.label ??
    "No identified lead item";

  const heroCards: InfoCard[] = [
    {
      label: "Lead Review Item",
      value: primaryContentItem
        ? `${safe(leadItemName)} (${mapEvidenceAssetKindLabel(
            primaryContentItem.kind
          )})`
        : "No primary item identified",
      tone: "neutral",
    },
    {
      label: "Evidence Package",
      value: `${structureLabel} • ${contentSummary.itemCount} item${
        contentSummary.itemCount === 1 ? "" : "s"
      }`,
      tone: "neutral",
    },
    {
      label: "Storage & Timestamp",
      value: buildIntegrityReadinessSummary(input.evidence),
      tone: storageAndTimestampTone,
    },
    {
      label: "Publication Posture",
      value: trustDecision.publicationStatusLabel,
      tone:
        trustDecision.presentationState === "VERIFIED_FINALIZED"
          ? "success"
          : trustDecision.presentationTone === "danger"
            ? "danger"
            : "warning",
    },
  ];

const technicalAppendix = buildTechnicalAppendixModel(
  otsEvidence,
  externalMode,
  anchorSummary,
  contentSummary
);

const verificationPackageAvailable = Boolean(
  input.evidence.verificationPackageVersion ||
    input.evidence.verificationPackageGeneratedAtUtc
);

// Phase D Blocker 3 — per-artifact completeness must come from the
// per-artifact presence record persisted by the worker at package
// generation time. The previous code inferred ALL artifacts as present
// purely because a package record existed. That overclaimed completeness
// for any package that was generated with reduced artifact coverage
// (rate-limited, partial regeneration, future variants).
//
// Resolution order:
//   1. If verificationPackageMetadata.manifestPresent etc are present, use
//      them directly.
//   2. If the metadata blob is absent (legacy records before Phase D),
//      fall back to a CONSERVATIVE wording ("Package record present;
//      component-level artifact presence not independently confirmed").
const packageMetadata =
  input.evidence.verificationPackageMetadata ?? null;
const packageMetadataPresent = packageMetadata !== null;

const componentFlag = (
  field: keyof NonNullable<typeof input.evidence.verificationPackageMetadata>
): boolean | null => {
  if (!verificationPackageAvailable) return false;
  if (!packageMetadata) return null;
  const value = packageMetadata[field];
  return typeof value === "boolean" ? value : null;
};

const verificationPackageIntegrity = {
  available: verificationPackageAvailable,
  version: verificationPackageAvailable
    ? input.evidence.verificationPackageVersion ?? null
    : null,
  generatedAtUtc: verificationPackageAvailable
    ? input.evidence.verificationPackageGeneratedAtUtc ?? null
    : null,
  // Per-component presence: boolean when known from the persisted
  // metadata, null when it is a legacy record without per-component
  // tracking. Renderers MUST surface "presence not independently
  // confirmed" for nulls and never present them as success.
  manifestPresent: componentFlag("manifestPresent"),
  signedManifestPresent: componentFlag("signedManifestPresent"),
  // The legacy code claimed manifestDigestPresent unconditionally; we
  // collapse it onto signedManifestPresent (the digest IS the signed
  // manifest payload) and emit null when unknown.
  manifestDigestPresent: componentFlag("signedManifestPresent"),
  checksumIndexPresent: componentFlag("checksumIndexPresent"),
  offlineVerifierIncluded: componentFlag("offlineVerifierIncluded"),
  auditExportIncluded: componentFlag("auditExportIncluded"),
  custodyExportIncluded: componentFlag("custodyExportIncluded"),
  accessExportIncluded: componentFlag("accessExportIncluded"),
  // Truthful summary so downstream renderers can choose conservative
  // copy without re-deriving the same logic.
  componentPresenceSource: packageMetadataPresent
    ? ("verification_package_metadata" as const)
    : verificationPackageAvailable
      ? ("legacy_inferred_unknown" as const)
      : ("not_generated" as const),
  componentPresenceNote: packageMetadataPresent
    ? "Per-component presence is reported from the verification package's persisted artifact-presence record."
    : verificationPackageAvailable
      ? "Package record present; component-level artifact presence not independently confirmed for this legacy record. Inspect the verification package archive to verify which components are included."
      : "No verification package has been generated for this evidence record yet.",
};

  const forensicIntegrityStatement = buildForensicIntegrityStatementModel(
    verifyUrl,
    structureLabel,
    externalMode,
    input.evidence
  );

const captureLat = input.evidence.gps.lat;
const captureLng = input.evidence.gps.lng;

const hasCaptureContext = hasCaptureLocationMetadata({
  lat: captureLat,
  lng: captureLng,
});

const captureLocationModel =
  hasCaptureContext && captureLat !== null && captureLng !== null
    ? buildCaptureLocationDisplayModel({
        lat: captureLat,
        lng: captureLng,
        accuracyMeters: input.evidence.gps.accuracyMeters,
        width: 1200,
        height: 720,
      })
    : null;

const captureContext = hasCaptureContext && captureLat !== null && captureLng !== null
  ? {
      statusLabel: CAPTURE_LOCATION_STATUS_LABEL,
      description: CAPTURE_LOCATION_CONTEXT_DESCRIPTION,
      lat:
        captureLocationModel?.latLabel ??
        formatCaptureLocationCoordinate(captureLat),
      lng:
        captureLocationModel?.lngLabel ??
        formatCaptureLocationCoordinate(captureLng),
      accuracyRadius:
        captureLocationModel?.accuracyLabel ??
        formatCaptureLocationAccuracy(input.evidence.gps.accuracyMeters),
      capturedAtLabel: formatReportTimestamp(
        input.evidence.capturedAtUtc ??
          input.evidence.deviceTimeIso ??
          input.evidence.createdAtUtc
      ),
      sourceLabel: CAPTURE_LOCATION_SOURCE_LABEL,
      legalBoundary: CAPTURE_LOCATION_LEGAL_BOUNDARY,
      mapPreviewDataUrl:
        (await renderCaptureLocationMapPreviewDataUrl({
          lat: captureLat,
          lng: captureLng,
          accuracyMeters: input.evidence.gps.accuracyMeters,
          width: 1800,
          height: 760,
          zoom: 16,
          tileGrid: 5,
        })) ??
        `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
          buildCaptureLocationPdfFallbackSvg({
            lat: captureLat,
            lng: captureLng,
            accuracyMeters: input.evidence.gps.accuracyMeters,
            width: 1800,
            height: 760,
            zoom: 16,
          })
        )}`,
    }
  : null;

  console.info("[report-v2] capture-context build", {
    evidenceId: input.evidence.id,
    hasCaptureContext,
    lat: captureLat,
    lng: captureLng,
    accuracyMeters: input.evidence.gps.accuracyMeters ?? null,
    mapPreviewPrefix: captureContext?.mapPreviewDataUrl?.slice(0, 48) ?? null,
    mapPreviewLength: captureContext?.mapPreviewDataUrl?.length ?? 0,
    usesSvgFallback:
      captureContext?.mapPreviewDataUrl?.startsWith("data:image/svg+xml") ?? false,
    usesPngPreview:
      captureContext?.mapPreviewDataUrl?.startsWith("data:image/png") ?? false,
  });

  if (captureContext?.mapPreviewDataUrl) {
    await writeCaptureContextDebugArtifact(
      captureContext.mapPreviewDataUrl,
      input.evidence.id
    );
  }
  
  return {
    mode,
    presentationMode,
    reportVariant,
    generatedAtUtc: input.generatedAtUtc,
    buildInfo: input.buildInfo ?? null,
    verifyUrl,
    technicalUrl,
    version: input.version,

    title: display.displayTitle,
    subtitle: display.displayDescription,

    evidenceReference: buildPublicEvidenceReference(input.evidence.id),
    recordStatusLabel: mapRecordStatusLabel(input.evidence.status),
    verificationStatusLabel: mapVerificationStatusLabel(
      input.evidence.verificationStatus
    ),
    integrityVerified,
    trustDecision,
    anchorSummary,
    verificationPackageIntegrity,
    executiveConclusion,
    legalLimitationShort,
    reviewSequence,
    mismatchSummary,

    heroCards,

    executiveRows: buildExecutiveRows(
      input.evidence,
      structureLabel,
      contentSummary,
      primaryContentItem,
      externalMode
    ),
verificationSummaryRows: buildVerificationSummaryRows(
  otsEvidence,
  custody,
  structureLabel,
  contentSummary,
  primaryContentItem,
  externalMode
),
    reviewReadinessRows: buildReviewReadinessRows(
      otsEvidence,
      custody,
      externalMode
    ),
    contentSummaryRows: buildEvidenceContentSummaryRows(
      contentSummary,
      primaryContentItem,
      input.evidence
    ),

    reviewGuidance,
    legalLimitations,

    contentSummary,
    contentItems,
    primaryContentItem,
    structureLabel,
    presentation: {
      decisions: presentationDecisions,
      buckets: presentationBuckets,
    },

    galleryEnabled: contentItems.some((item) => isPreviewRenderable(item)),
    inventoryRows: buildInventoryRows(contentItems),

    certifications: {
      custodian: input.evidence.certifications?.custodian ?? null,
      qualifiedPerson: input.evidence.certifications?.qualifiedPerson ?? null,
      hasAny: Boolean(
        input.evidence.certifications?.custodian ||
          input.evidence.certifications?.qualifiedPerson
      ),
    },

    certificationBlocks: [
      input.evidence.certifications?.custodian
        ? {
            kind: "custodian",
            callout: buildCertificationCallout(
              input.evidence.certifications.custodian,
              "custodian"
            ),
            rows: buildCertificationRows(
              input.evidence.certifications.custodian,
              "custodian"
            ),
          }
        : null,
      input.evidence.certifications?.qualifiedPerson
        ? {
            kind: "qualified",
            callout: buildCertificationCallout(
              input.evidence.certifications.qualifiedPerson,
              "qualified"
            ),
            rows: buildCertificationRows(
              input.evidence.certifications.qualifiedPerson,
              "qualified"
            ),
          }
        : null,
    ].filter(Boolean) as ReportViewModel["certificationBlocks"],

    storageRows: buildStorageRows(otsEvidence, anchorSummary),
    storageCallouts: [
      buildStorageCallout(input.evidence),
      buildTimestampCallout(input.evidence),
      buildOtsCallout(otsEvidence),
    ],

    forensicRows: buildTimelineRows(custody.forensic),
    accessRows: buildTimelineRows(custody.access),
    custodyHashRows: buildCustodyHashRows(custody.forensic),
    custodyCounts: buildCustodyCounts(custody),

    technicalIdentityRows: buildTechnicalIdentityRows(
      input.evidence,
      externalMode
    ),
    technicalFingerprintNarrative: buildFingerprintNarrative(
      parsedFingerprintSummary,
      contentSummary
    ),
    technicalAppendix,

    forensicIntegrityStatement,

    qr: {
      publicEnabled: true,
      technicalEnabled: technicalQrEnabled,
      publicLabel: "Open verification page",
      technicalLabel: "Technical materials",
      publicDataUrl: publicQrDataUrl,
      technicalDataUrl: technicalQrDataUrl,
    },

    // Phase 31.10 — pass-through. When the caller doesn't supply
    // intelligence (every legacy caller), the field is null and
    // the renderer emits NO additional HTML.
    mediaIntelligence: input.mediaIntelligence ?? null,

    // Phase 4A Final Closure — intelligence summary carried verbatim.
    intelligenceSummary: input.intelligenceSummary ?? null,

    // Phase 4B Final Closure (I2) — lifecycle summary carried verbatim.
    lifecycleSummary: input.lifecycleSummary ?? null,

    meta: {
      hasCoreCrypto: hasCoreCryptoMaterials(input.evidence),
      captureContext,
      previewPolicy,
      anchorSummary,
      display,
      publicEvidenceTypeLabel: mapPublicEvidenceTypeLabel(
        input.evidence,
        contentSummary
      ),
      reviewReadinessSummary: buildReviewReadinessRows(
        otsEvidence,
        custody,
        externalMode
      ),
      timestampRows: buildTimestampRows(input.evidence, contentSummary),
      otsRows: buildOtsRows(otsEvidence),
      anchorRows: buildAnchorRows(anchorSummary, {
        otsStatus: otsEvidence.otsStatus,
        otsBitcoinTxid: otsEvidence.otsBitcoinTxid,
        otsAnchoredAtUtc: otsEvidence.otsAnchoredAtUtc,
        otsProofPresent: Boolean(otsEvidence.otsProofBase64),
      }),
      signingKeyReference: buildPublicSigningKeyReference(
        input.evidence.signingKeyId,
        input.evidence.signingKeyVersion
      ),
      fileSizeLabel: formatBytesHuman(input.evidence.sizeBytes),
      primaryHash: primaryContentItem?.sha256 ?? "N/A",
      submittedByLabel: externalMode
        ? maskEmail(input.evidence.submittedByEmail)
        : safe(input.evidence.submittedByEmail),
      verificationPackageVersionLabel: input.evidence.verificationPackageVersion
        ? String(input.evidence.verificationPackageVersion)
        : "N/A",
      reviewerSummaryVersionLabel: input.evidence.reviewerSummaryVersion
        ? String(input.evidence.reviewerSummaryVersion)
        : "N/A",
      lastVerifiedSourceLabel: mapVerificationSourceLabel(
        input.evidence.lastVerifiedSource
      ),
courtAppendixRows: buildTechnicalAppendixCourtRows({
  evidence: otsEvidence,
  structureLabel,
  contentSummary,
  primaryContentItem,
  custody,
  reportVersion: input.version,
}),
      signingKeyLabel: buildPublicSigningKeyReference(
        input.evidence.signingKeyId,
        input.evidence.signingKeyVersion
      ),
      tsaMessageImprint: input.evidence.tsaMessageImprint ?? "N/A",
      otsHash: otsEvidence.otsHash ?? "N/A",
      anchorHash: anchorSummary?.anchorHash ?? "N/A",
    },
  };
}
