"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useParams } from "next/navigation";
import {
  Button,
  Card,
  useToast,
  EmptyState,
  Skeleton,
} from "../../../components/ui";
import { useLocale } from "../../providers";
import { apiFetch } from "../../../lib/api";
import { captureException } from "../../../lib/sentry";

type VerifyTimelineEvent = {
  sequence?: number | null;
  eventType?: string | null;
  atUtc?: string | null;
  payloadSummary?: string | null;
  prevEventHash?: string | null;
  eventHash?: string | null;
  category?: "forensic" | "access" | null;
};

type VerifyOverview = {
  recordStatus?: string | null;
  recordLifecycleStatus?: string | null;
  verificationStatus?: string | null;
  verificationStatusCode?: string | null;
  integrityHeadline?: string | null;
  evidenceTitle?: string | null;
  evidenceId?: string | null;
  evidenceType?: string | null;
  evidenceStructure?: string | null;
  itemCount?: number | null;
  captureMethod?: string | null;
  captureMethodCode?: string | null;
  mimeType?: string | null;
  submittedByEmail?: string | null;
  submittedByAuthProvider?: string | null;
  submittedByAuthProviderCode?: string | null;
  identityLevel?: string | null;
  identityLevelCode?: string | null;
  workspaceName?: string | null;
  organizationName?: string | null;
  organizationVerified?: boolean | null;
  createdAt?: string | null;
  capturedAtUtc?: string | null;
  uploadedAtUtc?: string | null;
  signedAtUtc?: string | null;
  recordedIntegrityVerifiedAtUtc?: string | null;
  lastVerifiedAtUtc?: string | null;
  lastVerifiedSource?: string | null;
  lastVerifiedSourceCode?: string | null;
  reviewReadyAtUtc?: string | null;
  verificationPackageGeneratedAtUtc?: string | null;
  verificationPackageVersion?: number | null;
  reviewerSummaryVersion?: number | null;
  reportVersion?: number | null;
  reportGeneratedAtUtc?: string | null;
  timestampStatus?: string | null;
  otsStatus?: string | null;
  storageProtection?: string | null;
  chainOfCustodyPresent?: boolean | null;
  externalPublicationPresent?: boolean | null;
  externalPublicationProvider?: string | null;
  externalPublicationUrl?: string | null;
  externalPublicationAnchoredAtUtc?: string | null;
};

type VerifyHumanSummary = {
  integrityStatus?: string | null;
  recordStatus?: string | null;
  verificationStatus?: string | null;
  summary?: string | null;
  whatIsVerified?: string | null;
  evidenceTitle?: string | null;
  evidenceId?: string | null;
  evidenceType?: string | null;
  evidenceStructure?: string | null;
  captureMethod?: string | null;
  fileType?: string | null;
  submittedBy?: string | null;
  authProvider?: string | null;
  identityLevel?: string | null;
  organization?: string | null;
  workspace?: string | null;
  organizationVerified?: boolean | null;
  createdAt?: string | null;
  capturedAtUtc?: string | null;
  uploadedAtUtc?: string | null;
  signedAtUtc?: string | null;
  recordedIntegrityVerifiedAtUtc?: string | null;
  lastVerifiedAtUtc?: string | null;
  lastVerifiedSource?: string | null;
  chainOfCustodyPresent?: boolean | null;
  reportVersion?: number | null;
  reportGeneratedAtUtc?: string | null;
  verificationPackageVersion?: number | null;
  verificationPackageGeneratedAtUtc?: string | null;
  reviewerSummaryVersion?: number | null;
  timestampStatus?: string | null;
  otsStatus?: string | null;
  storageProtection?: string | null;
  externalPublicationPresent?: boolean | null;
  externalPublicationProvider?: string | null;
  externalPublicationUrl?: string | null;
  externalPublicationAnchoredAtUtc?: string | null;
};

type VerifyReviewTrail = {
  forensicEventCount?: number | null;
  accessEventCount?: number | null;
  forensicCustodyEvents?: VerifyTimelineEvent[] | null;
  accessCustodyEvents?: VerifyTimelineEvent[] | null;
};

type VerifyTechnicalMaterials = {
  fileSha256?: string | null;
  fingerprintHash?: string | null;
  signatureBase64?: string | null;
  publicKeyPem?: string | null;
  signingKeyId?: string | null;
  signingKeyVersion?: number | null;
  otsProofPresent?: boolean | null;
};

type VerifyStorageProtection = {
  immutable?: boolean | null;
  mode?: string | null;
  retainUntil?: string | null;
  legalHold?: string | null;
  region?: string | null;
  verified?: boolean | null;
} | null;

type VerifyTsa = {
  status?: string | null;
  provider?: string | null;
  url?: string | null;
  serialNumber?: string | null;
  genTimeUtc?: string | null;
  hashAlgorithm?: string | null;
  messageImprint?: string | null;
  failureReason?: string | null;
  digestMatchesFileHash?: boolean | null;
} | null;

type VerifyOts = {
  status?: string | null;
  hash?: string | null;
  calendar?: string | null;
  bitcoinTxid?: string | null;
  anchoredAtUtc?: string | null;
  upgradedAtUtc?: string | null;
  failureReason?: string | null;
  proofPresent?: boolean | null;
  hashMatchesFingerprintHash?: boolean | null;
  proofBase64?: string | null;
} | null;

type VerifyStorageAndTimestamping = {
  storage?: VerifyStorageProtection;
  tsa?: VerifyTsa;
  ots?: VerifyOts;
};

type VerifyLimitations = {
  short?: string | null;
  detailed?: string | null;
};

type VerifyIdentity = {
  submittedByEmail?: string | null;
  submittedByAuthProvider?: string | null;
  submittedByAuthProviderLabel?: string | null;
  submittedByUserId?: string | null;
  identityLevel?: string | null;
  identityLevelLabel?: string | null;
  workspaceName?: string | null;
  organizationName?: string | null;
  organizationVerified?: boolean | null;
} | null;

type VerifyAnchor = {
  mode?: string | null;
  provider?: string | null;
  publicBaseUrl?: string | null;
  configured?: boolean | null;
  published?: boolean | null;
  anchorHash?: string | null;
  receiptId?: string | null;
  transactionId?: string | null;
  publicUrl?: string | null;
  anchoredAtUtc?: string | null;
} | null;

type VerifyEvidenceAssetKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "text"
  | "other";

type VerifyEvidenceAsset = {
  id: string;
  index: number;
  label: string;
  originalFileName?: string | null;
  mimeType?: string | null;
  kind: VerifyEvidenceAssetKind;
  sizeBytes?: string | null;
  durationMs?: number | null;
  sha256?: string | null;
  isPrimary: boolean;
  previewable: boolean;
  downloadable: boolean;
  viewUrl?: string | null;
  displaySizeLabel?: string | null;
  previewRole?:
    | "primary_preview"
    | "secondary_preview"
    | "download_only"
    | "metadata_only";
  originalPreservationNote?: string | null;
  reviewerRepresentationLabel?: string | null;
  reviewerRepresentationNote?: string | null;
  verificationMaterialsNote?: string | null;
  previewDataUrl?: string | null;
  previewTextExcerpt?: string | null;
  previewCaption?: string | null;
};

type VerifyEvidenceContentSummary = {
  structure?: "single" | "multipart";
  itemCount?: number;
  primaryKind?: VerifyEvidenceAssetKind | null;
  totalSizeDisplay?: string | null;
  imageCount?: number;
  videoCount?: number;
  audioCount?: number;
  pdfCount?: number;
  textCount?: number;
  otherCount?: number;
} | null;

type VerifyPreviewPolicy = {
  contentVisible?: boolean;
  previewEnabled?: boolean;
  downloadableFromVerify?: boolean;
  rationale?: string | null;
  privacyNotice?: string | null;
} | null;

type VerifyContentAccessPolicy = {
  mode?: "metadata_only" | "preview_only" | "full_access";
  allowContentView?: boolean;
  allowDownload?: boolean;
} | null;

type VerifyContentExposureDecision = {
  mode?: "metadata_only" | "preview_only" | "full_access";
  allowContentView?: boolean;
  allowDownload?: boolean;
  rationale?: string | null;
} | null;

type VerifyResponse = {
  evidenceId?: string | null;
  id?: string | null;
  title?: string | null;
  status?: string | null;
  verificationStatus?: string | null;
  captureMethod?: string | null;
  identityLevelSnapshot?: string | null;
  mimeType?: string | null;

  reportGeneratedAtUtc?: string | null;
  generatedAtUtc?: string | null;
  verifiedAtUtc?: string | null;
  verificationCheckedAtUtc?: string | null;
  reportVersion?: number | string | null;

  fileSha256?: string | null;
  fingerprintHash?: string | null;
  signatureBase64?: string | null;
  signingKeyId?: string | null;
  signingKeyVersion?: number | null;
  publicKeyPem?: string | null;

  tsaStatus?: string | null;
  tsaProvider?: string | null;
  tsaUrl?: string | null;
  tsaSerialNumber?: string | null;
  tsaGenTimeUtc?: string | null;
  tsaHashAlgorithm?: string | null;
  tsaFailureReason?: string | null;
  tsa?: VerifyTsa;
  timestamp?: VerifyTsa;

  otsStatus?: string | null;
  otsHash?: string | null;
  otsCalendar?: string | null;
  otsBitcoinTxid?: string | null;
  otsAnchoredAtUtc?: string | null;
  otsUpgradedAtUtc?: string | null;
  otsFailureReason?: string | null;
  otsProofBase64?: string | null;
  ots?: VerifyOts;

  storage?: VerifyStorageProtection;
  anchor?: VerifyAnchor;
  identity?: VerifyIdentity;

  integrityProof?: {
    canonicalHashMatches?: boolean;
    signatureValid?: boolean;
    custodyChainValid?: boolean;
    custodyChainMode?: string | null;
    custodyChainFailureReason?: string | null;
    timestampDigestMatches?: boolean;
    otsHashMatches?: boolean;
    overallIntegrity?: boolean;
    forensicEventCount?: number;
    accessEventCount?: number;
  } | null;

  verification?: {
    canonicalHashMatches?: boolean;
    signatureValid?: boolean;
    custodyChainValid?: boolean;
    custodyChainMode?: string | null;
    custodyChainFailureReason?: string | null;
    timestampDigestMatches?: boolean;
    otsHashMatches?: boolean;
    overallIntegrity?: boolean;
    forensicEventCount?: number;
    accessEventCount?: number;
  } | null;

  custodyEvents?: VerifyTimelineEvent[] | null;
  forensicCustodyEvents?: VerifyTimelineEvent[] | null;
  accessCustodyEvents?: VerifyTimelineEvent[] | null;

  overview?: VerifyOverview | null;
  humanSummary?: VerifyHumanSummary | null;
  reviewTrail?: VerifyReviewTrail | null;
    custodyLifecycle?: {
    forensicEventCount?: number | null;
    accessEventCount?: number | null;
    forensicEvents?: VerifyTimelineEvent[] | null;
    accessEvents?: VerifyTimelineEvent[] | null;
    chronologyNote?: string | null;
  } | null;
  technicalMaterials?: VerifyTechnicalMaterials | null;
  storageAndTimestamping?: VerifyStorageAndTimestamping | null;
  limitations?: VerifyLimitations | null;
  contentAccessPolicy?: VerifyContentAccessPolicy;
  contentExposureDecision?: VerifyContentExposureDecision;
  evidenceContent?: {
    summary?: VerifyEvidenceContentSummary;
    items?: VerifyEvidenceAsset[] | null;
    primaryItem?: VerifyEvidenceAsset | null;
    defaultPreviewItemId?: string | null;
    previewPolicy?: VerifyPreviewPolicy;
  } | null;
};

type TimelineItem = {
  sequence?: number | null;
  eventType: string;
  atUtc: string | null;
  payloadSummary: string | null;
  prevEventHash?: string | null;
  eventHash?: string | null;
  category?: "forensic" | "access" | null;
};

type ToastFn = (
  message: string,
  type: "success" | "info" | "error" | "warning",
  duration?: number
) => void;

type StorageProtection = {
  immutable: boolean | null;
  mode: string | null;
  retainUntil: string | null;
  legalHold: string | null;
  region: string | null;
  verified: boolean | null;
};

type OtsDetails = {
  status: string | null;
  hash: string | null;
  calendar: string | null;
  bitcoinTxid: string | null;
  anchoredAtUtc: string | null;
  upgradedAtUtc: string | null;
  failureReason: string | null;
  proofBase64: string | null;
  proofPresent: boolean | null;
  hashMatchesFingerprintHash: boolean | null;
};

type TechnicalTabId =
  | "record"
  | "integrity"
  | "full-custody"
  | "access";

const VERIFY_BRAND = {
  ink: "#10201d",
  accent: "#0b2e27",
  accent2: "#12315A",
  muted: "rgba(16, 32, 29, 0.68)",
  subtle: "rgba(11, 46, 39, 0.72)",
  line: "rgba(12, 28, 25, 0.18)",
  softLine: "rgba(12, 28, 25, 0.12)",
  glass: "rgba(255, 255, 255, 0.58)",
  glassStrong: "rgba(255, 255, 255, 0.74)",
  silver: "#eef1ef",
  bronze: "rgba(96, 66, 24, 0.95)",
  bronzeSoft: "rgba(96, 66, 24, 0.10)",
  success: "#21755d",
  successSoft: "rgba(33, 117, 93, 0.12)",
  warning: "#8a6a2f",
  warningSoft: "rgba(138, 106, 47, 0.13)",
  danger: "#b54738",
  dangerSoft: "rgba(181, 71, 56, 0.12)",
};

const VERIFY_FONT =
  `"Helvetica Neue", Arial, Helvetica, sans-serif`;

const VERIFY_TYPO = {
  page: {
    fontFamily: VERIFY_FONT,
    letterSpacing: "-0.005em",
    WebkitFontSmoothing: "antialiased" as const,
    MozOsxFontSmoothing: "grayscale" as const,
  },
  kicker: {
    fontSize: 12,
    fontWeight: 900,
    letterSpacing: "0.105em",
    textTransform: "uppercase" as const,
    color: VERIFY_BRAND.subtle,
  },
  h1: {
    fontSize: "clamp(2rem, 3.2vw, 3.1rem)",
    lineHeight: 1.05,
    fontWeight: 900,
    letterSpacing: "-0.04em",
    color: VERIFY_BRAND.ink,
  },
  h2: {
    fontSize: "clamp(1.45rem, 2vw, 2rem)",
    lineHeight: 1.12,
    fontWeight: 900,
    letterSpacing: "-0.028em",
    color: VERIFY_BRAND.ink,
  },
  h3: {
    fontSize: 18,
    lineHeight: 1.25,
    fontWeight: 900,
    letterSpacing: "-0.018em",
    color: VERIFY_BRAND.ink,
  },
  body: {
    fontSize: 14,
    lineHeight: 1.7,
    fontWeight: 500,
    color: VERIFY_BRAND.muted,
  },
  small: {
    fontSize: 12,
    lineHeight: 1.55,
    fontWeight: 650,
    color: VERIFY_BRAND.muted,
  },
  value: {
    fontSize: 14,
    lineHeight: 1.45,
    fontWeight: 800,
    color: VERIFY_BRAND.ink,
  },
  hash: {
    fontFamily: VERIFY_FONT,
    fontSize: 12.5,
    lineHeight: 1.55,
    fontWeight: 750,
    letterSpacing: "-0.012em",
    color: VERIFY_BRAND.ink,
    wordBreak: "break-all" as const,
    overflowWrap: "anywhere" as const,
    whiteSpace: "normal" as const,
  },
};

const VERIFY_SURFACE = {
  page: {
    background:
      "radial-gradient(circle at 12% 6%, rgba(11,46,39,0.08), transparent 30%), radial-gradient(circle at 92% 12%, rgba(96,66,24,0.08), transparent 28%), linear-gradient(180deg, #eef1ef 0%, #f8f8f5 46%, #edf1ef 100%)",
  },
  card: {
    background: "rgba(255,255,255,0.48)",
    border: `1px solid ${VERIFY_BRAND.line}`,
    borderRadius: 22,
    boxShadow: "0 18px 55px rgba(16,32,29,0.08)",
    backdropFilter: "blur(14px)",
  },
  cardStrong: {
    background: "rgba(255,255,255,0.66)",
    border: `1px solid ${VERIFY_BRAND.line}`,
    borderRadius: 22,
    boxShadow: "0 18px 55px rgba(16,32,29,0.10)",
    backdropFilter: "blur(16px)",
  },
  inset: {
    background: "rgba(255,255,255,0.26)",
    border: `1px solid ${VERIFY_BRAND.softLine}`,
    borderRadius: 16,
  },
};

function formatDateTime(value?: string | null): string {
  if (!value) return "N/A";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function normalizeEventLabel(value?: string | null): string {
  if (!value) return "Unknown Event";
  return value
    .toLowerCase()
    .split("_")
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function extractTimestampStatus(data: VerifyResponse): string | null {
  const raw =
    data.storageAndTimestamping?.tsa?.status ??
    data.tsa?.status ??
    data.timestamp?.status ??
    data.tsaStatus ??
    data.overview?.timestampStatus ??
    data.humanSummary?.timestampStatus ??
    null;

  if (!raw || !String(raw).trim()) return null;
  return String(raw).trim().toUpperCase();
}

function extractOtsStatus(data: VerifyResponse): string | null {
  const raw =
    data.storageAndTimestamping?.ots?.status ??
    data.ots?.status ??
    data.otsStatus ??
    data.overview?.otsStatus ??
    data.humanSummary?.otsStatus ??
    null;

  if (!raw || !String(raw).trim()) return null;
  return String(raw).trim().toUpperCase();
}

function isOtsTerminalStatus(status?: string | null): boolean {
  const s = (status ?? "").trim().toUpperCase();
  return s === "ANCHORED" || s === "FAILED" || s === "DISABLED";
}

function findEventTime(
  timeline: TimelineItem[],
  eventNames: string[]
): string | null {
  const targets = new Set(eventNames.map((v) => v.toUpperCase()));

  const matched = timeline
    .filter((item) => targets.has((item.eventType ?? "").toUpperCase()) && item.atUtc)
    .sort((a, b) => {
      const ta = a.atUtc ? new Date(a.atUtc).getTime() : 0;
      const tb = b.atUtc ? new Date(b.atUtc).getTime() : 0;
      return tb - ta;
    });

  return matched[0]?.atUtc ?? null;
}

function statusTone(
  status?: string | null
): { label: string; bg: string; color: string; border: string } {
  const s = (status ?? "").toUpperCase();

  if (
    s === "GRANTED" ||
    s === "STAMPED" ||
    s === "VERIFIED" ||
    s === "SUCCEEDED" ||
    s === "SIGNED" ||
    s === "REPORTED" ||
    s === "ANCHORED" ||
    s === "RECORDED_INTEGRITY_VERIFIED"
  ) {
    return {
      label: s || "VERIFIED",
      bg: "#ECFDF3",
      color: "#067647",
      border: "#ABEFC6",
    };
  }

  if (s === "PENDING" || s === "MATERIALS_AVAILABLE") {
    return {
      label: s || "AVAILABLE",
      bg: "#FFFAEB",
      color: "#B54708",
      border: "#FAD7A0",
    };
  }

  if (s) {
    return {
      label: s,
      bg: "#FEF3F2",
      color: "#B42318",
      border: "#FECDCA",
    };
  }

  return {
    label: "AVAILABLE",
    bg: "#F8F9FC",
    color: "#344054",
    border: "#D0D5DD",
  };
}

function timestampTone(
  status?: string | null
): { label: string; tone: "success" | "warning" | "neutral" } {
  const s = (status ?? "").toUpperCase();

  if (s === "STAMPED" || s === "GRANTED" || s === "VERIFIED" || s === "SUCCEEDED") {
    return { label: s, tone: "success" };
  }

  if (s === "PENDING") {
    return { label: "PENDING", tone: "warning" };
  }

  if (s === "FAILED") {
    return { label: "FAILED", tone: "warning" };
  }

  if (s) {
    return { label: s, tone: "warning" };
  }

  return { label: "Unavailable", tone: "neutral" };
}

function otsTone(
  status?: string | null
): { label: string; tone: "success" | "warning" | "neutral" | "info" } {
  const s = (status ?? "").toUpperCase();

  if (s === "ANCHORED") {
    return { label: "ANCHORED", tone: "success" };
  }

  if (s === "PENDING") {
    return { label: "PENDING", tone: "warning" };
  }

  if (s === "FAILED") {
    return { label: "FAILED", tone: "warning" };
  }

  if (s === "DISABLED") {
    return { label: "DISABLED", tone: "neutral" };
  }

  if (s) {
    return { label: s, tone: "info" };
  }

  return { label: "Unavailable", tone: "neutral" };
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function normalizeBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function buildTsaDetails(data: VerifyResponse) {
  const tsa = data.storageAndTimestamping?.tsa ?? data.tsa ?? data.timestamp ?? null;

  return {
    status: extractTimestampStatus(data),
    provider: firstNonEmpty(tsa?.provider, data.tsaProvider),
    genTimeUtc: firstNonEmpty(tsa?.genTimeUtc, data.tsaGenTimeUtc),
    url: firstNonEmpty(tsa?.url, data.tsaUrl),
    serialNumber: firstNonEmpty(tsa?.serialNumber, data.tsaSerialNumber),
    hashAlgorithm: firstNonEmpty(tsa?.hashAlgorithm, data.tsaHashAlgorithm),
    failureReason: firstNonEmpty(tsa?.failureReason, data.tsaFailureReason),
    digestMatchesFileHash:
      typeof tsa?.digestMatchesFileHash === "boolean"
        ? tsa.digestMatchesFileHash
        : null,
  };
}

function buildOtsDetails(data: VerifyResponse): OtsDetails {
  const ots = data.storageAndTimestamping?.ots ?? data.ots ?? null;
  const integrity = data.integrityProof ?? data.verification ?? null;

  return {
    status: extractOtsStatus(data),
    hash: firstNonEmpty(ots?.hash, data.otsHash),
    calendar: firstNonEmpty(ots?.calendar, data.otsCalendar),
    bitcoinTxid: firstNonEmpty(ots?.bitcoinTxid, data.otsBitcoinTxid),
    anchoredAtUtc: firstNonEmpty(ots?.anchoredAtUtc, data.otsAnchoredAtUtc),
    upgradedAtUtc: firstNonEmpty(ots?.upgradedAtUtc, data.otsUpgradedAtUtc),
    failureReason: firstNonEmpty(ots?.failureReason, data.otsFailureReason),
    proofBase64: firstNonEmpty(ots?.proofBase64, data.otsProofBase64),
    proofPresent:
      typeof ots?.proofPresent === "boolean"
        ? ots.proofPresent
        : data.technicalMaterials?.otsProofPresent === true
          ? true
          : firstNonEmpty(ots?.proofBase64, data.otsProofBase64)
            ? true
            : false,
    hashMatchesFingerprintHash:
      typeof ots?.hashMatchesFingerprintHash === "boolean"
        ? ots.hashMatchesFingerprintHash
        : typeof integrity?.otsHashMatches === "boolean"
          ? integrity.otsHashMatches
          : null,
  };
}

function buildStoragePresentation(
  storage?: StorageProtection | null
): {
  badgeLabel: string;
  badgeTone: "success" | "warning" | "neutral" | "info";
  detailLabel: string;
  detailText: string;
} {
  const mode = (storage?.mode ?? "").trim().toUpperCase();
  const immutable = storage?.immutable === true;
  const verified = storage?.verified === true;

  if (immutable && mode === "COMPLIANCE") {
    return {
      badgeLabel: "Immutable Storage Locked",
      badgeTone: "success",
      detailLabel: "Storage Protection",
      detailText:
        "This evidence is stored under immutable Object Lock protection in COMPLIANCE mode. Protected objects cannot be altered or deleted before the retention deadline expires.",
    };
  }

  if (mode === "GOVERNANCE") {
    return {
      badgeLabel: "Governance Retention Active",
      badgeTone: "info",
      detailLabel: "Storage Protection",
      detailText:
        "This evidence is stored with Object Lock governance retention. Retention controls are active, but governance mode is weaker than compliance mode.",
    };
  }

  if (verified) {
    return {
      badgeLabel: "Storage Protection Reported",
      badgeTone: "info",
      detailLabel: "Storage Protection",
      detailText:
        "Storage protection metadata was returned for this evidence, but immutable compliance retention was not fully confirmed.",
    };
  }

  return {
    badgeLabel: "Storage Protection Unverified",
    badgeTone: "neutral",
    detailLabel: "Storage Protection",
    detailText:
      "Immutable storage metadata was not confirmed in the verification response.",
  };
}

function buildOtsPresentation(ots: OtsDetails): {
  badgeLabel: string;
  badgeTone: "success" | "warning" | "neutral" | "info";
  detailLabel: string;
  detailText: string;
} {
  const status = (ots.status ?? "").trim().toUpperCase();

  if (status === "ANCHORED") {
    return {
      badgeLabel: "OTS Anchored",
      badgeTone: "success",
      detailLabel: "OpenTimestamps Status",
      detailText:
        "An OpenTimestamps proof is recorded and appears to be anchored. This adds an independent public-proof timestamping layer for the evidence digest.",
    };
  }

  if (status === "PENDING") {
    return {
      badgeLabel: "OTS Pending",
      badgeTone: "warning",
      detailLabel: "OpenTimestamps Status",
      detailText:
        "An OpenTimestamps proof exists for this evidence digest, but the proof has not yet been upgraded to a final anchored state.",
    };
  }

  if (status === "FAILED") {
    return {
      badgeLabel: "OTS Failed",
      badgeTone: "warning",
      detailLabel: "OpenTimestamps Status",
      detailText:
        "OpenTimestamps processing reported a failure for this evidence record.",
    };
  }

  if (status === "DISABLED") {
    return {
      badgeLabel: "OTS Disabled",
      badgeTone: "neutral",
      detailLabel: "OpenTimestamps Status",
      detailText:
        "OpenTimestamps is disabled in this environment, so no public-proof timestamp was recorded for this evidence item.",
    };
  }

  return {
    badgeLabel: "OTS Not Reported",
    badgeTone: "neutral",
    detailLabel: "OpenTimestamps Status",
    detailText:
      "OpenTimestamps information was not included in the verification response.",
  };
}

function CopyMiniButton({
  value,
  successMessage,
  addToast,
}: {
  value: string;
  successMessage: string;
  addToast: ToastFn;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(value);
        addToast(successMessage, "success");
      }}
style={{
  border: `1px solid ${VERIFY_BRAND.line}`,
  background: "rgba(255,255,255,0.62)",
  color: VERIFY_BRAND.accent,
  borderRadius: 999,
  padding: "7px 12px",
  fontSize: 11,
  fontWeight: 900,
  letterSpacing: "0.055em",
  textTransform: "uppercase",
  cursor: "pointer",
  whiteSpace: "nowrap",
  boxShadow: "0 6px 16px rgba(16,32,29,0.06)",
}}
    >
      Copy
    </button>
  );
}

function Badge({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "success" | "neutral" | "info" | "warning";
}) {
const palette =
  tone === "success"
    ? {
        bg: VERIFY_BRAND.successSoft,
        color: VERIFY_BRAND.success,
        border: "rgba(33,117,93,0.25)",
      }
    : tone === "info"
      ? {
          bg: "rgba(11,46,39,0.08)",
          color: VERIFY_BRAND.accent,
          border: "rgba(11,46,39,0.22)",
        }
      : tone === "warning"
        ? {
            bg: VERIFY_BRAND.warningSoft,
            color: VERIFY_BRAND.warning,
            border: "rgba(138,106,47,0.28)",
          }
        : {
            bg: "rgba(255,255,255,0.36)",
            color: VERIFY_BRAND.ink,
            border: VERIFY_BRAND.softLine,
          };
            return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "7px 11px",
        borderRadius: 999,
        border: `1px solid ${palette.border}`,
        background: palette.bg,
        color: palette.color,
        fontSize: 11,
        fontWeight: 900,
        letterSpacing: "0.045em",
        textTransform: "uppercase",
        lineHeight: 1,
        maxWidth: "100%",
      }}
    >
      {label}
    </span>
  );
}

function SummaryField({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div
      style={{
        ...VERIFY_SURFACE.inset,
        padding: 14,
        minHeight: 74,
      }}
    >
      <div
        style={{
          ...VERIFY_TYPO.kicker,
          fontSize: 10.5,
          marginBottom: 8,
        }}
      >
        {label}
      </div>

      <div style={VERIFY_TYPO.value}>
        {value}
      </div>
    </div>
  );
}

function MaterialField({
  label,
  value,
  addToast,
  copyMessage,
  subtitle,
}: {
  label: string;
  value: string;
  addToast: ToastFn;
  copyMessage: string;
  subtitle?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = value.length > 180;
  const shown = expanded || !long ? value : `${value.slice(0, 180)}...`;

  return (
    <div
      style={{
        ...VERIFY_SURFACE.card,
        padding: 18,
        display: "grid",
        gap: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              ...VERIFY_TYPO.kicker,
              fontSize: 11,
              marginBottom: subtitle ? 5 : 0,
            }}
          >
            {label}
          </div>

          {subtitle ? (
            <div
              style={{
                ...VERIFY_TYPO.small,
                maxWidth: 760,
              }}
            >
              {subtitle}
            </div>
          ) : null}
        </div>

        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          <CopyMiniButton
            value={value}
            successMessage={copyMessage}
            addToast={addToast}
          />

          {long ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              style={{
                border: `1px solid ${VERIFY_BRAND.line}`,
                background: "rgba(255,255,255,0.62)",
                color: VERIFY_BRAND.accent,
                borderRadius: 999,
                padding: "7px 12px",
                fontSize: 11,
                fontWeight: 900,
                letterSpacing: "0.055em",
                textTransform: "uppercase",
                cursor: "pointer",
                whiteSpace: "nowrap",
                boxShadow: "0 6px 16px rgba(16,32,29,0.06)",
              }}
            >
              {expanded ? "Collapse" : "Expand"}
            </button>
          ) : null}
        </div>
      </div>

      <div
        style={{
          padding: 14,
          borderRadius: 14,
          border: `1px solid ${VERIFY_BRAND.softLine}`,
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.34) 0%, rgba(255,255,255,0.18) 100%)",
          ...VERIFY_TYPO.hash,
        }}
      >
        {shown}
      </div>
    </div>
  );
}

function TechnicalTabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "10px 14px",
        borderRadius: 999,
        border: active
          ? `1px solid ${VERIFY_BRAND.accent}`
          : `1px solid ${VERIFY_BRAND.line}`,
        background: active
          ? "rgba(11,46,39,0.10)"
          : "rgba(255,255,255,0.54)",
        color: active ? VERIFY_BRAND.accent : VERIFY_BRAND.ink,
        boxShadow: active ? "inset 0 0 0 1px rgba(11,46,39,0.08)" : "none",
        fontSize: 11.5,
        fontWeight: 900,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

function TimelinePanel({
  title,
  subtitle,
  countTone,
  events,
  emptyTitle,
  emptyBody,
  accent,
}: {
  title: string;
  subtitle: string;
  countTone: "info" | "neutral";
  events: TimelineItem[];
  emptyTitle: string;
  emptyBody: string;
  accent: {
    dot: string;
    dotBorder: string;
    line: string;
  };
}) {
  return (
    <div style={{ display: "grid", gap: 18 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div>
          <h3
            style={{
              margin: 0,
              fontSize: 18,
              fontWeight: 800,
              color: "#101828",
            }}
          >
            {title}
          </h3>
          <div
            style={{
              marginTop: 6,
              fontSize: 13,
              color: "#667085",
              lineHeight: 1.65,
              maxWidth: 760,
            }}
          >
            {subtitle}
          </div>
        </div>

        <Badge
          label={`${events.length} Event${events.length === 1 ? "" : "s"}`}
          tone={countTone}
        />
      </div>

      {events.length === 0 ? (
        <div
          style={{
background: "rgba(255,255,255,0.36)",
border: "1px solid rgba(12,28,25,0.16)",
            borderRadius: 16,
            padding: 18,
            display: "grid",
            gap: 8,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 800, color: "#344054" }}>
            {emptyTitle}
          </div>
          <div style={{ fontSize: 13, color: "#667085", lineHeight: 1.7 }}>
            {emptyBody}
          </div>
        </div>
      ) : (
        <div
          style={{
            position: "relative",
            display: "grid",
            gap: 14,
          }}
        >
          {events.map((event, idx) => {
            const isLast = idx === events.length - 1;

            return (
              <div
                key={`${event.eventType}-${event.atUtc}-${idx}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: "28px minmax(0, 1fr)",
                  gap: 14,
                  alignItems: "start",
                }}
              >
                <div
                  style={{
                    position: "relative",
                    display: "flex",
                    justifyContent: "center",
                    minHeight: 80,
                  }}
                >
                  <div
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: 999,
                      background: accent.dot,
                      border: `3px solid ${accent.dotBorder}`,
                      marginTop: 6,
                      zIndex: 1,
                    }}
                  />
                  {!isLast ? (
                    <div
                      style={{
                        position: "absolute",
                        top: 22,
                        bottom: -18,
                        width: 2,
                        background: accent.line,
                      }}
                    />
                  ) : null}
                </div>

                <div
                  style={{
                    border: "1px solid #EAECF0",
                    background: "#FFFFFF",
                    borderRadius: 16,
                    padding: 16,
                    boxShadow: "0 1px 2px rgba(16,24,40,0.04)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                      gap: 12,
                      flexWrap: "wrap",
                      marginBottom: 10,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 15,
                        fontWeight: 800,
                        color: "#101828",
                        minWidth: 0,
                        flex: "1 1 260px",
                      }}
                    >
                      {normalizeEventLabel(event.eventType)}
                    </div>

                    <div
                      style={{
                        fontSize: 12,
                        color: "#475467",
                        fontWeight: 700,
                        padding: "6px 10px",
                        borderRadius: 999,
                        background: "#F2F4F7",
                        border: "1px solid #EAECF0",
                        whiteSpace: "nowrap",
                        flexShrink: 0,
                      }}
                    >
                      {formatDateTime(event.atUtc)}
                    </div>
                  </div>

                  <div
                    style={{
                      fontSize: 13,
                      lineHeight: 1.7,
                      color: "#667085",
                      wordBreak: "break-word",
                      overflowWrap: "anywhere",
                      whiteSpace: "pre-wrap",
                      maxWidth: "100%",
                    }}
                  >
                    {event.payloadSummary?.trim()
                      ? event.payloadSummary
                      : "No additional event summary provided."}
                  </div>

                  {(event.prevEventHash || event.eventHash) ? (
                    <div
                      style={{
                        marginTop: 12,
                        display: "grid",
                        gap: 8,
                      }}
                    >
                      {event.prevEventHash ? (
                        <div
                          style={{
                            fontSize: 12,
                            color: "#98A2B3",
                            wordBreak: "break-all",
                          }}
                        >
                          Prev Hash: {event.prevEventHash}
                        </div>
                      ) : null}
                      {event.eventHash ? (
                        <div
                          style={{
                            fontSize: 12,
                            color: "#98A2B3",
                            wordBreak: "break-all",
                          }}
                        >
                          Event Hash: {event.eventHash}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function normalizeOtsFailureMessage(raw?: string | null): string | null {
  if (!raw) return null;

  const text = raw.trim();
  if (!text) return null;

  const lower = text.toLowerCase();

  if (
    lower.includes("cannot be greater than available calendar") ||
    lower.includes("available calendar")
  ) {
    return "OpenTimestamps proof was created, but blockchain anchoring is not available yet. The proof still needs more time to be upgraded by the calendar service.";
  }

  if (
    lower.includes("not found") &&
    (lower.includes("ots") || lower.includes("opentimestamps"))
  ) {
    return "OpenTimestamps binary is not installed correctly in the worker environment.";
  }

  if (lower.includes("timed out") || lower.includes("timeout")) {
    return "OpenTimestamps request timed out before the calendar service returned a result.";
  }

  if (
    lower.includes("network") ||
    lower.includes("econnreset") ||
    lower.includes("enotfound") ||
    lower.includes("fetch failed") ||
    lower.includes("connection")
  ) {
    return "OpenTimestamps service could not be reached at the time of report generation.";
  }

  if (lower.includes("stamp") && lower.includes("failed")) {
    return "OpenTimestamps stamping did not complete successfully for this evidence record.";
  }

  return "OpenTimestamps processing did not complete successfully for this evidence record.";
}

function sanitizeOtsFailureTechnical(raw?: string | null): string | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text) return null;

  return text.replace(/\s+/g, " ").trim();
}

function formatDuration(durationMs?: number | null): string | null {
  if (!durationMs || durationMs <= 0) return null;

  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(
      2,
      "0"
    )}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function evidenceKindLabel(kind?: VerifyEvidenceAssetKind | null): string {
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
      return "Evidence";
  }
}

function previewRoleLabel(
  role?: VerifyEvidenceAsset["previewRole"]
): string | null {
  switch (role) {
    case "primary_preview":
      return "Primary reviewer preview";
    case "secondary_preview":
      return "Supporting reviewer preview";
    case "download_only":
      return "Download-only access";
    case "metadata_only":
      return "Metadata-only access";
    default:
      return null;
  }
}

function renderVerifyEvidenceMedia(
  item: VerifyEvidenceAsset | null
): JSX.Element {
  const wrapperStyle: CSSProperties = {
    overflow: "hidden",
    borderRadius: 22,
    border: "1px solid #D0D5DD",
    background:
      item?.kind === "image" || item?.kind === "pdf"
        ? "#FFFFFF"
        : "linear-gradient(180deg, #101828 0%, #0F172A 100%)",
    minHeight: 340,
  };

  if (!item || !item.viewUrl) {
    if (item?.previewDataUrl) {
      return (
        <div style={wrapperStyle}>
          <img
            src={item.previewDataUrl}
            alt={item.previewCaption ?? item.label}
            style={{
              display: "block",
              width: "100%",
              maxHeight: 560,
              objectFit: "contain",
              background: "#F8FAFC",
            }}
          />
        </div>
      );
    }

    if (item?.previewTextExcerpt) {
      return (
        <div
          style={{
            ...wrapperStyle,
            background: "#F8FAFC",
            padding: 28,
            display: "grid",
            gap: 14,
          }}
        >
          <div style={{ fontSize: 14, color: "#475467", lineHeight: 1.8 }}>
            {item.previewTextExcerpt}
          </div>
        </div>
      );
    }

    return (
      <div
        style={{
          ...wrapperStyle,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 32,
          background: "#F8FAFC",
        }}
      >
        <div style={{ maxWidth: 560, textAlign: "center" }}>
          <div
            style={{
              fontSize: 18,
              fontWeight: 800,
              color: "#101828",
              marginBottom: 10,
            }}
          >
            Evidence content is not directly exposed here
          </div>
          <div style={{ fontSize: 14, color: "#667085", lineHeight: 1.7 }}>
            This verification flow can still validate the recorded integrity state,
            chain of custody, timestamps, and publication details even when direct
            evidence viewing is intentionally restricted.
          </div>
        </div>
      </div>
    );
  }

  if (item.kind === "image") {
    return (
      <div style={wrapperStyle}>
        <img
          src={item.viewUrl}
          alt={item.label}
          style={{
            display: "block",
            width: "100%",
            maxHeight: 560,
            objectFit: "contain",
            background: "#F8FAFC",
          }}
        />
      </div>
    );
  }

  if (item.kind === "video") {
    return (
      <div style={{ display: "grid", gap: 12 }}>
        {item.previewDataUrl ? (
          <div style={wrapperStyle}>
            <img
              src={item.previewDataUrl}
              alt={item.previewCaption ?? `${item.label} poster`}
              style={{
                display: "block",
                width: "100%",
                maxHeight: 420,
                objectFit: "contain",
                background: "#F8FAFC",
              }}
            />
          </div>
        ) : null}
        <div style={wrapperStyle}>
          <video
            src={item.viewUrl}
            controls
            preload="metadata"
            style={{ display: "block", width: "100%", maxHeight: 560 }}
          />
        </div>
      </div>
    );
  }

  if (item.kind === "audio") {
    return (
      <div style={{ display: "grid", gap: 12 }}>
        {item.previewDataUrl ? (
          <div
            style={{
              overflow: "hidden",
              borderRadius: 22,
              border: "1px solid #D0D5DD",
              background: "#FFFFFF",
            }}
          >
            <img
              src={item.previewDataUrl}
              alt={item.previewCaption ?? `${item.label} waveform`}
              style={{
                display: "block",
                width: "100%",
                maxHeight: 260,
                objectFit: "contain",
                background: "#F8FAFC",
              }}
            />
          </div>
        ) : null}
        <div
          style={{
            ...wrapperStyle,
            padding: 28,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            gap: 18,
          }}
        >
          <div style={{ color: "#EAECF0", fontSize: 14, lineHeight: 1.7 }}>
            Listen to the preserved audio item through controlled verification
            access. Original evidence remains separately preserved with the recorded
            integrity state.
          </div>
          <audio src={item.viewUrl} controls preload="metadata" style={{ width: "100%" }} />
        </div>
      </div>
    );
  }

  if (item.kind === "pdf") {
    return (
      <div style={{ display: "grid", gap: 12 }}>
        {item.previewDataUrl ? (
          <div style={wrapperStyle}>
            <img
              src={item.previewDataUrl}
              alt={item.previewCaption ?? `${item.label} first page`}
              style={{
                display: "block",
                width: "100%",
                maxHeight: 480,
                objectFit: "contain",
                background: "#F8FAFC",
              }}
            />
          </div>
        ) : null}
        <div style={wrapperStyle}>
          <iframe
            src={item.viewUrl}
            title={item.label}
            style={{ width: "100%", height: 720, border: 0 }}
          />
        </div>
      </div>
    );
  }

  if (item.kind === "text") {
    return (
      <div
        style={{
          ...wrapperStyle,
          padding: 28,
          background: "#F8FAFC",
          color: "#475467",
          display: "grid",
          gap: 14,
        }}
      >
        <div style={{ fontSize: 14, lineHeight: 1.7 }}>
          Text-based evidence is best opened in a dedicated tab so reviewers can
          inspect the original preserved file directly.
        </div>
        <a
          href={item.viewUrl}
          target="_blank"
          rel="noreferrer"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "10px 14px",
            borderRadius: 12,
            border: "1px solid #D0D5DD",
            background: "#FFFFFF",
            color: "#344054",
            fontSize: 13,
            fontWeight: 700,
            textDecoration: "none",
            width: "fit-content",
          }}
        >
          Open text evidence
        </a>
      </div>
    );
  }

  return (
    <div
      style={{
        ...wrapperStyle,
        padding: 28,
        background: "#F8FAFC",
        display: "grid",
        gap: 12,
        alignContent: "center",
      }}
    >
      <div style={{ fontSize: 16, fontWeight: 800, color: "#101828" }}>
        Preview is not available inline for this file type
      </div>
      <div style={{ fontSize: 14, color: "#667085", lineHeight: 1.7 }}>
        The verification record still exposes the preserved file reference and
        integrity materials for controlled review.
      </div>
      <a
        href={item.viewUrl}
        target="_blank"
        rel="noreferrer"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "10px 14px",
          borderRadius: 12,
          border: "1px solid #D0D5DD",
          background: "#FFFFFF",
          color: "#344054",
          fontSize: 13,
          fontWeight: 700,
          textDecoration: "none",
          width: "fit-content",
        }}
      >
        Open preserved file
      </a>
    </div>
  );
}

export default function VerifyPage() {
  useLocale();
  const params = useParams<{ token: string }>();
  const { addToast } = useToast();

  const [hash, setHash] = useState<string | null>(null);
  const [fingerprintHash, setFingerprintHash] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [forensicTimeline, setForensicTimeline] = useState<TimelineItem[]>([]);
  const [accessTimeline, setAccessTimeline] = useState<TimelineItem[]>([]);
  const [fullCustodyTimeline, setFullCustodyTimeline] = useState<TimelineItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [title, setTitle] = useState<string | null>(null);
  const [evidenceId, setEvidenceId] = useState<string | null>(null);
  const [mimeType, setMimeType] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [verifiedAt, setVerifiedAt] = useState<string | null>(null);
  const [reportVersion, setReportVersion] = useState<string | null>(null);
  const [verificationPackageVersion, setVerificationPackageVersion] =
    useState<string | null>(null);
  const [reviewerSummaryVersion, setReviewerSummaryVersion] =
    useState<string | null>(null);

  const [tsaStatus, setTsaStatus] = useState<string | null>(null);
  const [tsaProvider, setTsaProvider] = useState<string | null>(null);
  const [tsaGenTimeUtc, setTsaGenTimeUtc] = useState<string | null>(null);
  const [tsaSerialNumber, setTsaSerialNumber] = useState<string | null>(null);
  const [tsaHashAlgorithm, setTsaHashAlgorithm] = useState<string | null>(null);
  const [tsaFailureReason, setTsaFailureReason] = useState<string | null>(null);

  const [publicKeyPem, setPublicKeyPem] = useState<string | null>(null);
  const [verifyStatus, setVerifyStatus] = useState<string | null>(null);
  const [verificationStatus, setVerificationStatus] = useState<string | null>(null);
  const [signingKeyId, setSigningKeyId] = useState<string | null>(null);
  const [signingKeyVersion, setSigningKeyVersion] = useState<number | null>(null);

  const [submittedByEmail, setSubmittedByEmail] = useState<string | null>(null);
  const [authProvider, setAuthProvider] = useState<string | null>(null);
  const [identityLevel, setIdentityLevel] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [organizationName, setOrganizationName] = useState<string | null>(null);
  const [organizationVerified, setOrganizationVerified] = useState<boolean | null>(
    null
  );

  const [externalPublicationPresent, setExternalPublicationPresent] = useState<
    boolean | null
  >(null);
  const [externalPublicationProvider, setExternalPublicationProvider] =
    useState<string | null>(null);
  const [externalPublicationUrl, setExternalPublicationUrl] =
    useState<string | null>(null);
  const [externalPublicationAnchoredAtUtc, setExternalPublicationAnchoredAtUtc] =
    useState<string | null>(null);

  const [otsStatus, setOtsStatus] = useState<string | null>(null);
  const [otsHash, setOtsHash] = useState<string | null>(null);
  const [otsCalendar, setOtsCalendar] = useState<string | null>(null);
  const [otsBitcoinTxid, setOtsBitcoinTxid] = useState<string | null>(null);
  const [otsAnchoredAtUtc, setOtsAnchoredAtUtc] = useState<string | null>(null);
  const [otsUpgradedAtUtc, setOtsUpgradedAtUtc] = useState<string | null>(null);
  const [otsFailureReason, setOtsFailureReason] = useState<string | null>(null);
  const [otsProofBase64, setOtsProofBase64] = useState<string | null>(null);
  const [otsProofPresent, setOtsProofPresent] = useState<boolean | null>(null);

  const [canonicalHashMatches, setCanonicalHashMatches] = useState<boolean | null>(null);
  const [signatureValid, setSignatureValid] = useState<boolean | null>(null);
  const [custodyChainValid, setCustodyChainValid] = useState<boolean | null>(null);
  const [custodyChainMode, setCustodyChainMode] = useState<string | null>(null);
  const [custodyChainFailureReason, setCustodyChainFailureReason] = useState<string | null>(null);
  const [timestampDigestMatches, setTimestampDigestMatches] = useState<boolean | null>(null);
  const [otsHashMatches, setOtsHashMatches] = useState<boolean | null>(null);
  const [overallIntegrity, setOverallIntegrity] = useState<boolean | null>(null);

  const [storageProtection, setStorageProtection] = useState<StorageProtection | null>(null);

  const [overview, setOverview] = useState<VerifyOverview | null>(null);
  const [humanSummary, setHumanSummary] = useState<VerifyHumanSummary | null>(null);
  const [limitations, setLimitations] = useState<VerifyLimitations | null>(null);
  const [evidenceContentSummary, setEvidenceContentSummary] =
    useState<VerifyEvidenceContentSummary>(null);
  const [evidenceItems, setEvidenceItems] = useState<VerifyEvidenceAsset[]>([]);
  const [primaryContentItem, setPrimaryContentItem] =
    useState<VerifyEvidenceAsset | null>(null);
  const [defaultPreviewItemId, setDefaultPreviewItemId] = useState<string | null>(null);
  const [selectedEvidenceItemId, setSelectedEvidenceItemId] = useState<string | null>(null);
  const [previewPolicy, setPreviewPolicy] = useState<VerifyPreviewPolicy>(null);
  const [contentAccessPolicy, setContentAccessPolicy] =
    useState<VerifyContentAccessPolicy>(null);
  const [contentExposureDecision, setContentExposureDecision] =
    useState<VerifyContentExposureDecision>(null);
const [activeTechnicalTab, setActiveTechnicalTab] =
  useState<TechnicalTabId>("record");

  const pollingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasShownAnchoredToastRef = useRef(false);
  const isMountedRef = useRef(true);

  const clearPolling = () => {
    if (pollingTimerRef.current) {
      clearTimeout(pollingTimerRef.current);
      pollingTimerRef.current = null;
    }
  };

function extractEvidenceContent(data: VerifyResponse) {
  return {
    summary: data.evidenceContent?.summary ?? null,
    items: Array.isArray(data.evidenceContent?.items)
      ? data.evidenceContent.items
      : [],
    primaryItem: data.evidenceContent?.primaryItem ?? null,
    defaultPreviewItemId: data.evidenceContent?.defaultPreviewItemId ?? null,
    previewPolicy: data.evidenceContent?.previewPolicy ?? null,
  };
}

function isAccessEventType(eventType?: string | null): boolean {
  const value = (eventType ?? "").toUpperCase();

  return [
    "VERIFY_VIEWED",
    "EVIDENCE_VIEWED",
    "EVIDENCE_DOWNLOADED",
    "REPORT_DOWNLOADED",
    "VERIFICATION_PACKAGE_DOWNLOADED",
    "TECHNICAL_VERIFICATION_CHECKED",
  ].includes(value);
}

  const applyVerifyResponse = (data: VerifyResponse) => {
    const tsaDetails = buildTsaDetails(data);
    const otsDetails = buildOtsDetails(data);

    const reviewTrailForensic =
      data.reviewTrail?.forensicCustodyEvents ??
      data.custodyLifecycle?.forensicEvents ??
      null;

    const reviewTrailAccess =
      data.reviewTrail?.accessCustodyEvents ??
      data.custodyLifecycle?.accessEvents ??
      null;

    const rawTimeline: TimelineItem[] = (data.custodyEvents ?? []).map((ev) => ({
      sequence: ev.sequence ?? null,
      eventType: ev.eventType ?? "UNKNOWN_EVENT",
      atUtc: ev.atUtc ?? null,
      payloadSummary: ev.payloadSummary ?? null,
      prevEventHash: ev.prevEventHash ?? null,
      eventHash: ev.eventHash ?? null,
      category: ev.category ?? null,
    }));

    const forensicOnly: TimelineItem[] =
      reviewTrailForensic && reviewTrailForensic.length > 0
        ? reviewTrailForensic.map((ev) => ({
            sequence: ev.sequence ?? null,
            eventType: ev.eventType ?? "UNKNOWN_EVENT",
            atUtc: ev.atUtc ?? null,
            payloadSummary: ev.payloadSummary ?? null,
            prevEventHash: ev.prevEventHash ?? null,
            eventHash: ev.eventHash ?? null,
            category: ev.category ?? "forensic",
          }))
        : data.forensicCustodyEvents && data.forensicCustodyEvents.length > 0
          ? data.forensicCustodyEvents.map((ev) => ({
              sequence: ev.sequence ?? null,
              eventType: ev.eventType ?? "UNKNOWN_EVENT",
              atUtc: ev.atUtc ?? null,
              payloadSummary: ev.payloadSummary ?? null,
              prevEventHash: ev.prevEventHash ?? null,
              eventHash: ev.eventHash ?? null,
              category: ev.category ?? "forensic",
            }))
: rawTimeline.filter(
    (item) => item.category === "forensic" || !isAccessEventType(item.eventType)
  );

    const accessOnly: TimelineItem[] =
      reviewTrailAccess && reviewTrailAccess.length > 0
        ? reviewTrailAccess.map((ev) => ({
            sequence: ev.sequence ?? null,
            eventType: ev.eventType ?? "UNKNOWN_EVENT",
            atUtc: ev.atUtc ?? null,
            payloadSummary: ev.payloadSummary ?? null,
            prevEventHash: ev.prevEventHash ?? null,
            eventHash: ev.eventHash ?? null,
            category: ev.category ?? "access",
          }))
        : data.accessCustodyEvents && data.accessCustodyEvents.length > 0
          ? data.accessCustodyEvents.map((ev) => ({
              sequence: ev.sequence ?? null,
              eventType: ev.eventType ?? "UNKNOWN_EVENT",
              atUtc: ev.atUtc ?? null,
              payloadSummary: ev.payloadSummary ?? null,
              prevEventHash: ev.prevEventHash ?? null,
              eventHash: ev.eventHash ?? null,
              category: ev.category ?? "access",
            }))
: rawTimeline.filter(
    (item) => item.category === "access" || isAccessEventType(item.eventType)
  );

const sortTimeline = (items: TimelineItem[]) =>
  [...items].sort((a, b) => {
    const sa = a.sequence ?? Number.MAX_SAFE_INTEGER;
    const sb = b.sequence ?? Number.MAX_SAFE_INTEGER;

    if (sa !== sb) return sa - sb;

    const ta = a.atUtc ? new Date(a.atUtc).getTime() : 0;
    const tb = b.atUtc ? new Date(b.atUtc).getTime() : 0;

    return ta - tb;
  });

const fullTimeline =
  rawTimeline.length > 0
    ? sortTimeline(rawTimeline)
    : sortTimeline([...forensicOnly, ...accessOnly]);

setFullCustodyTimeline(fullTimeline);

    const effectiveOverview = data.overview ?? null;
    const effectiveHumanSummary = data.humanSummary ?? null;

    const generatedAtFallback =
      effectiveOverview?.reportGeneratedAtUtc ??
      effectiveHumanSummary?.reportGeneratedAtUtc ??
      data.reportGeneratedAtUtc ??
      data.generatedAtUtc ??
      findEventTime(forensicOnly, ["REPORT_GENERATED"]) ??
      null;

    const verifiedAtFallback =
      effectiveOverview?.lastVerifiedAtUtc ??
      effectiveHumanSummary?.lastVerifiedAtUtc ??
      data.verifiedAtUtc ??
      data.verificationCheckedAtUtc ??
      null;

    const effectiveEvidenceId =
      effectiveOverview?.evidenceId ??
      effectiveHumanSummary?.evidenceId ??
      data.evidenceId ??
      data.id ??
      params?.token ??
      null;

    const effectiveTitle =
      effectiveOverview?.evidenceTitle ??
      effectiveHumanSummary?.evidenceTitle ??
      data.title ??
      "Digital Evidence Record";

    const effectiveMimeType =
      effectiveOverview?.mimeType ??
      effectiveHumanSummary?.fileType ??
      data.mimeType ??
      null;

    const effectiveReportVersion =
      effectiveOverview?.reportVersion ??
      effectiveHumanSummary?.reportVersion ??
      (data.reportVersion !== undefined && data.reportVersion !== null
        ? Number(data.reportVersion)
        : null);

    const effectiveRecordStatus =
      effectiveOverview?.recordStatus ??
      effectiveHumanSummary?.recordStatus ??
      data.status ??
      "REPORTED";

    const effectiveVerificationStatus =
      effectiveOverview?.verificationStatus ?? data.verificationStatus ?? null;

    const effectiveIdentity = data.identity ?? null;

    setHash(data.technicalMaterials?.fileSha256 ?? data.fileSha256 ?? null);
    setFingerprintHash(
      data.technicalMaterials?.fingerprintHash ?? data.fingerprintHash ?? null
    );
    setSignature(
      data.technicalMaterials?.signatureBase64 ?? data.signatureBase64 ?? null
    );
    setVerifyStatus(effectiveRecordStatus);
    setVerificationStatus(effectiveVerificationStatus);
    setTitle(effectiveTitle);
    setEvidenceId(effectiveEvidenceId);
    setMimeType(effectiveMimeType);
    setGeneratedAt(generatedAtFallback);
    setVerifiedAt(verifiedAtFallback);
    setReportVersion(
      effectiveReportVersion !== undefined &&
        effectiveReportVersion !== null &&
        Number.isFinite(Number(effectiveReportVersion))
        ? String(effectiveReportVersion)
        : null
    );
    setVerificationPackageVersion(
      effectiveOverview?.verificationPackageVersion != null
        ? String(effectiveOverview.verificationPackageVersion)
        : effectiveHumanSummary?.verificationPackageVersion != null
          ? String(effectiveHumanSummary.verificationPackageVersion)
          : null
    );
    setReviewerSummaryVersion(
      effectiveOverview?.reviewerSummaryVersion != null
        ? String(effectiveOverview.reviewerSummaryVersion)
        : effectiveHumanSummary?.reviewerSummaryVersion != null
          ? String(effectiveHumanSummary.reviewerSummaryVersion)
          : null
    );

    setTsaStatus(tsaDetails.status);
    setTsaProvider(tsaDetails.provider);
    setTsaGenTimeUtc(tsaDetails.genTimeUtc);
    setTsaSerialNumber(tsaDetails.serialNumber);
    setTsaHashAlgorithm(tsaDetails.hashAlgorithm);
    setTsaFailureReason(tsaDetails.failureReason);

    setPublicKeyPem(
      data.technicalMaterials?.publicKeyPem ?? data.publicKeyPem ?? null
    );
    setSigningKeyId(
      data.technicalMaterials?.signingKeyId ?? data.signingKeyId ?? null
    );
    setSigningKeyVersion(
      data.technicalMaterials?.signingKeyVersion ??
        data.signingKeyVersion ??
        null
    );

    setSubmittedByEmail(
      effectiveHumanSummary?.submittedBy ??
        effectiveOverview?.submittedByEmail ??
        effectiveIdentity?.submittedByEmail ??
        null
    );
    setAuthProvider(
      effectiveHumanSummary?.authProvider ??
        effectiveOverview?.submittedByAuthProvider ??
        effectiveIdentity?.submittedByAuthProviderLabel ??
        effectiveIdentity?.submittedByAuthProvider ??
        null
    );
    setIdentityLevel(
      effectiveHumanSummary?.identityLevel ??
        effectiveOverview?.identityLevel ??
        effectiveIdentity?.identityLevelLabel ??
        effectiveIdentity?.identityLevel ??
        null
    );
    setWorkspaceName(
      effectiveHumanSummary?.workspace ??
        effectiveOverview?.workspaceName ??
        effectiveIdentity?.workspaceName ??
        null
    );
    setOrganizationName(
      effectiveHumanSummary?.organization ??
        effectiveOverview?.organizationName ??
        effectiveIdentity?.organizationName ??
        null
    );
    setOrganizationVerified(
      typeof effectiveHumanSummary?.organizationVerified === "boolean"
        ? effectiveHumanSummary.organizationVerified
        : typeof effectiveOverview?.organizationVerified === "boolean"
          ? effectiveOverview.organizationVerified
          : typeof effectiveIdentity?.organizationVerified === "boolean"
            ? effectiveIdentity.organizationVerified
            : null
    );

    setExternalPublicationPresent(
      typeof effectiveHumanSummary?.externalPublicationPresent === "boolean"
        ? effectiveHumanSummary.externalPublicationPresent
        : typeof effectiveOverview?.externalPublicationPresent === "boolean"
          ? effectiveOverview.externalPublicationPresent
          : typeof data.anchor?.published === "boolean"
            ? data.anchor.published
            : null
    );
    setExternalPublicationProvider(
      effectiveHumanSummary?.externalPublicationProvider ??
        effectiveOverview?.externalPublicationProvider ??
        data.anchor?.provider ??
        null
    );
    setExternalPublicationUrl(
      effectiveHumanSummary?.externalPublicationUrl ??
        effectiveOverview?.externalPublicationUrl ??
        data.anchor?.publicUrl ??
        null
    );
    setExternalPublicationAnchoredAtUtc(
      effectiveHumanSummary?.externalPublicationAnchoredAtUtc ??
        effectiveOverview?.externalPublicationAnchoredAtUtc ??
        data.anchor?.anchoredAtUtc ??
        null
    );

    setForensicTimeline(forensicOnly);
    setAccessTimeline(accessOnly);

    setOtsStatus(otsDetails.status);
    setOtsHash(otsDetails.hash);
    setOtsCalendar(otsDetails.calendar);
    setOtsBitcoinTxid(otsDetails.bitcoinTxid);
    setOtsAnchoredAtUtc(otsDetails.anchoredAtUtc);
    setOtsUpgradedAtUtc(otsDetails.upgradedAtUtc);
    setOtsFailureReason(otsDetails.failureReason);
    setOtsProofBase64(otsDetails.proofBase64);
    setOtsProofPresent(otsDetails.proofPresent);
    const integrity = data.integrityProof ?? data.verification ?? null;

    setCanonicalHashMatches(
      typeof integrity?.canonicalHashMatches === "boolean"
        ? integrity.canonicalHashMatches
        : null
    );
    setSignatureValid(
      typeof integrity?.signatureValid === "boolean"
        ? integrity.signatureValid
        : null
    );
    setCustodyChainValid(
      typeof integrity?.custodyChainValid === "boolean"
        ? integrity.custodyChainValid
        : null
    );
    setCustodyChainMode(integrity?.custodyChainMode ?? null);
    setCustodyChainFailureReason(
      integrity?.custodyChainFailureReason ?? null
    );
    setTimestampDigestMatches(
      typeof integrity?.timestampDigestMatches === "boolean"
        ? integrity.timestampDigestMatches
        : typeof tsaDetails.digestMatchesFileHash === "boolean"
          ? tsaDetails.digestMatchesFileHash
          : null
    );
    setOtsHashMatches(
      typeof integrity?.otsHashMatches === "boolean"
        ? integrity.otsHashMatches
        : otsDetails.hashMatchesFingerprintHash
    );
    setOverallIntegrity(
      typeof integrity?.overallIntegrity === "boolean"
        ? integrity.overallIntegrity
        : null
    );

    const storage =
      data.storageAndTimestamping?.storage ?? data.storage ?? null;

    setStorageProtection({
      immutable: normalizeBool(storage?.immutable),
      mode: storage?.mode ?? null,
      retainUntil: storage?.retainUntil ?? null,
      legalHold: storage?.legalHold ?? null,
      region: storage?.region ?? null,
      verified: normalizeBool(storage?.verified),
    });

    setOverview(effectiveOverview);
    setHumanSummary(effectiveHumanSummary);
    setLimitations(data.limitations ?? null);
const content = extractEvidenceContent(data);

setEvidenceContentSummary(content.summary);
setEvidenceItems(content.items);
setPrimaryContentItem(content.primaryItem);
setDefaultPreviewItemId(content.defaultPreviewItemId);
setSelectedEvidenceItemId((current) =>
  current ??
  content.defaultPreviewItemId ??
  content.primaryItem?.id ??
  content.items[0]?.id ??
  null
);
setPreviewPolicy(content.previewPolicy);
    setContentAccessPolicy(data.contentAccessPolicy ?? null);
    setContentExposureDecision(data.contentExposureDecision ?? null);

    return otsDetails;
  };

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      clearPolling();
    };
  }, []);

  useEffect(() => {
    if (!params?.token) return;

    let cancelled = false;
    clearPolling();
    setLoading(true);
    setError(null);
    hasShownAnchoredToastRef.current = false;

    const fetchVerify = async (background = false) => {
      try {
        const data = await apiFetch(
          `/public/verify/${encodeURIComponent(params.token)}`
        );
        if (cancelled || !isMountedRef.current) return;

        const otsDetails = applyVerifyResponse(data as VerifyResponse);

        if (!background) {
          setError(null);
        }

        if ((otsDetails.status ?? "").toUpperCase() === "ANCHORED") {
          clearPolling();

          if (background && !hasShownAnchoredToastRef.current) {
            hasShownAnchoredToastRef.current = true;
            addToast("OpenTimestamps proof is now anchored", "success");
          }

          return;
        }

        if (isOtsTerminalStatus(otsDetails.status)) {
          clearPolling();
          return;
        }

        if ((otsDetails.status ?? "").toUpperCase() === "PENDING") {
          clearPolling();
          pollingTimerRef.current = setTimeout(() => {
            void fetchVerify(true);
          }, 30000);
        }
      } catch (err) {
        if (cancelled || !isMountedRef.current) return;

        captureException(err, { feature: "web_verify", token: params.token });

        if (!background) {
          const message =
            err instanceof Error ? err.message : "Verification failed";
          setError(message);
          addToast(message, "error");
        } else {
          clearPolling();
        }
      } finally {
        if (!cancelled && !background && isMountedRef.current) {
          setLoading(false);
        }
      }
    };

    void fetchVerify(false);

    return () => {
      cancelled = true;
      clearPolling();
    };
  }, [params?.token, addToast]);

  const storagePresentation = useMemo(
    () => buildStoragePresentation(storageProtection),
    [storageProtection]
  );

  const otsPresentation = useMemo(
    () =>
      buildOtsPresentation({
        status: otsStatus,
        hash: otsHash,
        calendar: otsCalendar,
        bitcoinTxid: otsBitcoinTxid,
        anchoredAtUtc: otsAnchoredAtUtc,
        upgradedAtUtc: otsUpgradedAtUtc,
        failureReason: otsFailureReason,
        proofBase64: otsProofBase64,
        proofPresent: otsProofPresent,
        hashMatchesFingerprintHash: otsHashMatches,
      }),
    [
      otsStatus,
      otsHash,
      otsCalendar,
      otsBitcoinTxid,
      otsAnchoredAtUtc,
      otsUpgradedAtUtc,
      otsFailureReason,
      otsProofBase64,
      otsProofPresent,
      otsHashMatches,
    ]
  );

  const otsFailureDisplayMessage = useMemo(
    () => normalizeOtsFailureMessage(otsFailureReason),
    [otsFailureReason]
  );

  const otsFailureTechnicalMessage = useMemo(
    () => sanitizeOtsFailureTechnical(otsFailureReason),
    [otsFailureReason]
  );

  const selectedEvidenceItem = useMemo(
    () =>
      evidenceItems.find((item) => item.id === selectedEvidenceItemId) ??
      evidenceItems.find((item) => item.id === defaultPreviewItemId) ??
      primaryContentItem ??
      evidenceItems[0] ??
      null,
    [defaultPreviewItemId, evidenceItems, primaryContentItem, selectedEvidenceItemId]
  );

  const evidenceSectionDescription = useMemo(() => {
    const parts = [
      evidenceContentSummary?.structure === "multipart"
        ? "Multipart evidence package"
        : evidenceItems.length > 0
          ? "Single evidence item"
          : null,
      evidenceContentSummary?.totalSizeDisplay ?? null,
      overview?.itemCount != null
        ? `${overview.itemCount} item${overview.itemCount === 1 ? "" : "s"}`
        : evidenceItems.length > 0
          ? `${evidenceItems.length} item${evidenceItems.length === 1 ? "" : "s"}`
          : null,
    ].filter(Boolean);

    return parts.join(" • ");
  }, [evidenceContentSummary?.structure, evidenceContentSummary?.totalSizeDisplay, evidenceItems.length, overview?.itemCount]);

  const mismatchMessages = useMemo(() => {
    const items: string[] = [];

    if (canonicalHashMatches === false) {
      items.push(
        "The canonical fingerprint check did not match the recorded evidence state."
      );
    }

    if (signatureValid === false) {
      items.push(
        "The digital signature check failed for the recorded verification materials."
      );
    }

    if (custodyChainValid === false) {
      items.push(
        custodyChainFailureReason
          ? `The custody chain reported a mismatch: ${custodyChainFailureReason}`
          : "The custody chain reported an integrity mismatch."
      );
    }

    if (timestampDigestMatches === false) {
      items.push(
        "The trusted timestamp digest did not match the recorded file hash."
      );
    }

    if (otsHashMatches === false) {
      items.push(
        "The OpenTimestamps hash did not match the recorded fingerprint hash."
      );
    }

    return items;
  }, [
    canonicalHashMatches,
    custodyChainFailureReason,
    custodyChainValid,
    otsHashMatches,
    signatureValid,
    timestampDigestMatches,
  ]);

  const whatChangedSinceCompletion = useMemo(() => {
    const changes: string[] = [];

    if (reportVersion) {
      changes.push(`Report artifact version: ${reportVersion}.`);
    }

    if (verificationPackageVersion) {
      changes.push(`Verification package version: ${verificationPackageVersion}.`);
    }

    if (reviewerSummaryVersion) {
      changes.push(`Reviewer summary version: ${reviewerSummaryVersion}.`);
    }

    if (generatedAt) {
      changes.push(`Latest report generated at ${formatDateTime(generatedAt)}.`);
    }

    if (verifiedAt) {
      changes.push(`Latest verification recorded at ${formatDateTime(verifiedAt)}.`);
    }

    return changes;
  }, [
    generatedAt,
    reportVersion,
    reviewerSummaryVersion,
    verificationPackageVersion,
    verifiedAt,
  ]);

  const heroIntegrityHeadline = useMemo(() => {
    return (
      humanSummary?.integrityStatus ??
      overview?.integrityHeadline ??
      (overallIntegrity === true
        ? "Recorded Integrity Verified"
        : overallIntegrity === false
          ? "Recorded Integrity Review Required"
          : "Recorded Integrity Materials Available")
    );
  }, [humanSummary?.integrityStatus, overview?.integrityHeadline, overallIntegrity]);

  const heroSummaryText = useMemo(() => {
    return (
      humanSummary?.summary ??
      "This page shows whether the recorded fingerprint, signature, timestamp linkage, hashed custody chain, OpenTimestamps status, immutable storage protection, and external publication state pass technical verification checks. It does not by itself prove authorship, factual truth, or legal admissibility of the underlying content."
    );
  }, [humanSummary?.summary]);

  const heroWhatIsVerifiedText = useMemo(() => {
    return (
      humanSummary?.whatIsVerified ??
      "This page verifies the recorded integrity state of the evidence record. It does not independently prove factual truth, authorship, context, or legal admissibility."
    );
  }, [humanSummary?.whatIsVerified]);

  const verificationBadges = useMemo(() => {
    const items: Array<{
      label: string;
      tone: "success" | "warning" | "neutral" | "info";
      show: boolean;
    }> = [];

    items.push({
      label:
        overallIntegrity === true
          ? "Overall Integrity Verified"
          : overallIntegrity === false
            ? "Overall Integrity Failed"
            : "Overall Integrity Pending",
      tone:
        overallIntegrity === true
          ? "success"
          : overallIntegrity === false
            ? "warning"
            : "neutral",
      show: true,
    });

    items.push({
      label:
        canonicalHashMatches === true
          ? "Fingerprint Valid"
          : canonicalHashMatches === false
            ? "Fingerprint Invalid"
            : "Fingerprint Check Pending",
      tone:
        canonicalHashMatches === true
          ? "success"
          : canonicalHashMatches === false
            ? "warning"
            : "neutral",
      show: true,
    });

    items.push({
      label:
        signatureValid === true
          ? "Signature Valid"
          : signatureValid === false
            ? "Signature Invalid"
            : "Signature Check Pending",
      tone:
        signatureValid === true
          ? "success"
          : signatureValid === false
            ? "warning"
            : "neutral",
      show: true,
    });

    items.push({
      label:
        custodyChainValid === true
          ? custodyChainMode === "legacy"
            ? "Custody Trail Valid (Legacy)"
            : "Custody Trail Valid"
          : custodyChainValid === false
            ? "Custody Trail Invalid"
            : "Custody Trail Pending",
      tone:
        custodyChainValid === true
          ? custodyChainMode === "legacy"
            ? "info"
            : "success"
          : custodyChainValid === false
            ? "warning"
            : "neutral",
      show: true,
    });

    items.push({
      label:
        timestampDigestMatches === true
          ? "Timestamp Digest Matches"
          : timestampDigestMatches === false
            ? "Timestamp Digest Mismatch"
            : "Timestamp Digest Unavailable",
      tone:
        timestampDigestMatches === true
          ? "success"
          : timestampDigestMatches === false
            ? "warning"
            : "neutral",
      show: true,
    });

    items.push({
      label:
        otsHashMatches === true
          ? "OTS Hash Matches"
          : otsHashMatches === false
            ? "OTS Hash Mismatch"
            : "OTS Hash Unavailable",
      tone:
        otsHashMatches === true
          ? "success"
          : otsHashMatches === false
            ? "warning"
            : "neutral",
      show: true,
    });

    items.push({
      label: otsPresentation.badgeLabel,
      tone: otsPresentation.badgeTone,
      show: true,
    });

    items.push({
      label: storagePresentation.badgeLabel,
      tone: storagePresentation.badgeTone,
      show: true,
    });

    if (externalPublicationPresent === true) {
      items.push({
        label: "External Publication Recorded",
        tone: "success",
        show: true,
      });
    }

    return items.filter((item) => item.show);
  }, [
    overallIntegrity,
    canonicalHashMatches,
    signatureValid,
    custodyChainValid,
    custodyChainMode,
    timestampDigestMatches,
    otsHashMatches,
    otsPresentation,
    storagePresentation,
    externalPublicationPresent,
  ]);

const executiveBadges = useMemo(
  () =>
    verificationBadges.filter((item) =>
      [
        "Overall Integrity",
        "Fingerprint",
        "Signature",
        "Custody Trail",
        "Timestamp",
        "OTS",
        "Immutable Storage",
        "Storage Protection",
      ].some((prefix) => item.label.startsWith(prefix))
    ),
  [verificationBadges]
);

  const legalOutcomeNarrative = useMemo(() => {
    if (overallIntegrity === true) {
      return "The recorded integrity state passed the available cryptographic and timestamp-linked verification checks returned in this record. This supports reliance on the recorded system state, while authorship, factual truth, context, and admissibility still require separate legal or expert assessment.";
    }

    if (overallIntegrity === false) {
      return "At least one returned integrity signal requires caution or further review before this record should be relied upon as a complete integrity verification result.";
    }

    return "The verification response exposes integrity materials, but the system did not return a final overall integrity conclusion for every technical layer.";
  }, [overallIntegrity]);

  const forensicCustodyNarrative = useMemo(() => {
    if (forensicTimeline.length > 0) {
      return `The record contains ${forensicTimeline.length} forensic custody event${
        forensicTimeline.length === 1 ? "" : "s"
      } describing integrity-relevant system activity. These events are displayed separately from later access activity.`;
    }

    return "No forensic custody events were returned in this verification record. This means this response does not provide an internal custody-event chain for the evidence record; it should not be read as proof that no handling occurred outside the recorded system workflow.";
  }, [forensicTimeline.length]);

  const accessActivityNarrative = useMemo(() => {
    if (accessTimeline.length > 0) {
      return `The record contains ${accessTimeline.length} access-related event${
        accessTimeline.length === 1 ? "" : "s"
      } such as viewing, verification, or download activity. These events are informational and are not the same thing as forensic custody events.`;
    }

    return "No access-activity entries were returned in this response. The absence of access entries does not alter the recorded integrity outcome.";
  }, [accessTimeline.length]);

  const summaryFields = useMemo(
    () =>
      [
        {
          label: "Record Status",
          value: overview?.recordStatus ?? statusTone(verifyStatus).label,
          show: true,
        },
        {
          label: "Verification Status",
          value: verificationStatus ?? "N/A",
          show: Boolean(verificationStatus),
        },
        {
          label: "Integrity Status",
          value: heroIntegrityHeadline,
          show: true,
        },
        {
          label: "Evidence Title",
          value:
            humanSummary?.evidenceTitle ??
            overview?.evidenceTitle ??
            title ??
            "Digital Evidence Record",
          show: true,
        },
        {
          label: "Evidence ID",
          value:
            humanSummary?.evidenceId ??
            overview?.evidenceId ??
            evidenceId ??
            params?.token ??
            "N/A",
          show: true,
        },
        {
          label: "Evidence Type",
          value:
            humanSummary?.evidenceType ?? overview?.evidenceType ?? "Evidence",
          show: true,
        },
        {
          label: "Evidence Structure",
          value:
            humanSummary?.evidenceStructure ??
            overview?.evidenceStructure ??
            "N/A",
          show: Boolean(
            humanSummary?.evidenceStructure ?? overview?.evidenceStructure
          ),
        },
        {
          label: "Capture Method",
          value:
            humanSummary?.captureMethod ?? overview?.captureMethod ?? "N/A",
          show: Boolean(humanSummary?.captureMethod ?? overview?.captureMethod),
        },
        {
          label: "Submitted By",
          value: submittedByEmail ?? "N/A",
          show: Boolean(submittedByEmail),
        },
        {
          label: "Auth Provider",
          value: authProvider ?? "N/A",
          show: Boolean(authProvider),
        },
        {
          label: "Identity Level",
          value: identityLevel ?? "N/A",
          show: Boolean(identityLevel),
        },
        {
          label: "Workspace",
          value: workspaceName ?? "N/A",
          show: Boolean(workspaceName),
        },
        {
          label: "Organization",
          value: organizationName ?? "N/A",
          show: Boolean(organizationName),
        },
        {
          label: "Organization Verified",
          value:
            organizationVerified === true
              ? "Yes"
              : organizationVerified === false
                ? "No"
                : "N/A",
          show: organizationVerified !== null,
        },
        {
          label: "Report Version",
          value:
            reportVersion ??
            (overview?.reportVersion != null
              ? String(overview.reportVersion)
              : "N/A"),
          show: Boolean(reportVersion || overview?.reportVersion != null),
        },
        {
          label: "Verification Package Version",
          value: verificationPackageVersion ?? "N/A",
          show: Boolean(verificationPackageVersion),
        },
        {
          label: "Reviewer Summary Version",
          value: reviewerSummaryVersion ?? "N/A",
          show: Boolean(reviewerSummaryVersion),
        },
        {
          label: "Created At",
          value: humanSummary?.createdAt
            ? formatDateTime(humanSummary.createdAt)
            : overview?.createdAt
              ? formatDateTime(overview.createdAt)
              : "N/A",
          show: Boolean(humanSummary?.createdAt ?? overview?.createdAt),
        },
        {
          label: "Captured At",
          value: humanSummary?.capturedAtUtc
            ? formatDateTime(humanSummary.capturedAtUtc)
            : overview?.capturedAtUtc
              ? formatDateTime(overview.capturedAtUtc)
              : "N/A",
          show: Boolean(humanSummary?.capturedAtUtc ?? overview?.capturedAtUtc),
        },
        {
          label: "Uploaded At",
          value: humanSummary?.uploadedAtUtc
            ? formatDateTime(humanSummary.uploadedAtUtc)
            : overview?.uploadedAtUtc
              ? formatDateTime(overview.uploadedAtUtc)
              : "N/A",
          show: Boolean(humanSummary?.uploadedAtUtc ?? overview?.uploadedAtUtc),
        },
        {
          label: "Signed At",
          value: humanSummary?.signedAtUtc
            ? formatDateTime(humanSummary.signedAtUtc)
            : overview?.signedAtUtc
              ? formatDateTime(overview.signedAtUtc)
              : "N/A",
          show: Boolean(humanSummary?.signedAtUtc ?? overview?.signedAtUtc),
        },
        {
          label: "Generated At",
          value: generatedAt ? formatDateTime(generatedAt) : "N/A",
          show: Boolean(generatedAt),
        },
        {
          label: "Last Verified At",
          value: verifiedAt ? formatDateTime(verifiedAt) : "N/A",
          show: Boolean(verifiedAt),
        },
        {
          label: "File Type",
          value:
            humanSummary?.fileType ?? overview?.mimeType ?? mimeType ?? "N/A",
          show: Boolean(humanSummary?.fileType ?? overview?.mimeType ?? mimeType),
        },
        {
          label: "Timestamp Status",
          value:
            humanSummary?.timestampStatus ??
            overview?.timestampStatus ??
            tsaStatus ??
            "N/A",
          show: Boolean(
            humanSummary?.timestampStatus ?? overview?.timestampStatus ?? tsaStatus
          ),
        },
        {
          label: "OTS Status",
          value:
            humanSummary?.otsStatus ?? overview?.otsStatus ?? otsStatus ?? "N/A",
          show: Boolean(humanSummary?.otsStatus ?? overview?.otsStatus ?? otsStatus),
        },
        {
          label: "Storage Protection",
          value:
            humanSummary?.storageProtection ??
            overview?.storageProtection ??
            storagePresentation.badgeLabel,
          show: true,
        },
      ].filter((item) => item.show),
    [
      overview,
      humanSummary,
      verifyStatus,
      verificationStatus,
      heroIntegrityHeadline,
      title,
      evidenceId,
      params?.token,
      submittedByEmail,
      authProvider,
      identityLevel,
      workspaceName,
      organizationName,
      organizationVerified,
      reportVersion,
      verificationPackageVersion,
      reviewerSummaryVersion,
      generatedAt,
      verifiedAt,
      mimeType,
      tsaStatus,
      otsStatus,
      storagePresentation.badgeLabel,
    ]
  );

  const technicalCards = useMemo(
    () =>
      [
        {
          label: "Signature Status",
          content: (
            <Badge
              label={
                signatureValid === true
                  ? "Valid"
                  : signatureValid === false
                    ? "Invalid"
                    : signature
                      ? "Present"
                      : "Unavailable"
              }
              tone={
                signatureValid === true
                  ? "success"
                  : signatureValid === false
                    ? "warning"
                    : signature
                      ? "info"
                      : "neutral"
              }
            />
          ),
          show: true,
        },
        {
          label: "Fingerprint Status",
          content: (
            <Badge
              label={
                canonicalHashMatches === true
                  ? "Valid"
                  : canonicalHashMatches === false
                    ? "Invalid"
                    : "Pending"
              }
              tone={
                canonicalHashMatches === true
                  ? "success"
                  : canonicalHashMatches === false
                    ? "warning"
                    : "neutral"
              }
            />
          ),
          show: true,
        },
        {
          label: "Custody Chain",
          content: (
            <Badge
              label={
                custodyChainValid === true
                  ? custodyChainMode === "legacy"
                    ? "Valid (Legacy)"
                    : "Valid"
                  : custodyChainValid === false
                    ? "Invalid"
                    : "Pending"
              }
              tone={
                custodyChainValid === true
                  ? custodyChainMode === "legacy"
                    ? "info"
                    : "success"
                  : custodyChainValid === false
                    ? "warning"
                    : "neutral"
              }
            />
          ),
          show: true,
        },
        {
          label: "OpenTimestamps",
          content: (
            <Badge
              label={otsTone(otsStatus).label}
              tone={otsTone(otsStatus).tone}
            />
          ),
          show: true,
        },
        {
          label: "Storage Protection",
          content: (
            <Badge
              label={storagePresentation.badgeLabel}
              tone={storagePresentation.badgeTone}
            />
          ),
          show: true,
        },
        {
          label: "Timestamp Status",
          content: (
            <Badge
              label={timestampTone(tsaStatus).label}
              tone={timestampTone(tsaStatus).tone}
            />
          ),
          show: true,
        },
        {
          label: "Timestamp Provider",
          content: tsaProvider ?? null,
          show: Boolean(tsaProvider),
        },
        {
          label: "Timestamp Time",
          content: tsaGenTimeUtc ? formatDateTime(tsaGenTimeUtc) : null,
          show: Boolean(tsaGenTimeUtc),
        },
        {
          label: "Timestamp Serial",
          content: tsaSerialNumber ?? null,
          show: Boolean(tsaSerialNumber),
        },
        {
          label: "Hash Algorithm",
          content: tsaHashAlgorithm ?? null,
          show: Boolean(tsaHashAlgorithm),
        },
        {
          label: "Signing Key",
          content: signingKeyId ?? null,
          show: Boolean(signingKeyId),
        },
        {
          label: "Signing Key Version",
          content: signingKeyVersion != null ? String(signingKeyVersion) : null,
          show: signingKeyVersion != null,
        },
        {
          label: "OTS Calendar",
          content: otsCalendar ?? null,
          show: Boolean(otsCalendar),
        },
        {
          label: "OTS Proof",
          content: (
            <Badge
              label={
                otsProofPresent === true
                  ? "Proof Present"
                  : otsProofPresent === false
                    ? "Not Present"
                    : "Unavailable"
              }
              tone={otsProofPresent === true ? "success" : "neutral"}
            />
          ),
          show: otsProofPresent !== null,
        },
        {
          label: "OTS Anchored At",
          content: otsAnchoredAtUtc ? formatDateTime(otsAnchoredAtUtc) : null,
          show: Boolean(otsAnchoredAtUtc),
        },
        {
          label: "OTS Upgraded At",
          content: otsUpgradedAtUtc ? formatDateTime(otsUpgradedAtUtc) : null,
          show: Boolean(otsUpgradedAtUtc),
        },
        {
          label: "OTS Hash Check",
          content: (
            <Badge
              label={
                otsHashMatches === true
                  ? "Hash Matches"
                  : otsHashMatches === false
                    ? "Hash Mismatch"
                    : "Unavailable"
              }
              tone={
                otsHashMatches === true
                  ? "success"
                  : otsHashMatches === false
                    ? "warning"
                    : "neutral"
              }
            />
          ),
          show: true,
        },
        {
          label: "External Publication",
          content: (
            <Badge
              label={
                externalPublicationPresent === true ? "Published" : "Not Published"
              }
              tone={externalPublicationPresent === true ? "success" : "neutral"}
            />
          ),
          show: externalPublicationPresent !== null,
        },
        {
          label: "Anchor Provider",
          content: externalPublicationProvider ?? null,
          show: Boolean(externalPublicationProvider),
        },
        {
          label: "Anchor Time",
          content: externalPublicationAnchoredAtUtc
            ? formatDateTime(externalPublicationAnchoredAtUtc)
            : null,
          show: Boolean(externalPublicationAnchoredAtUtc),
        },
      ].filter((item) => item.show),
    [
      signature,
      signatureValid,
      canonicalHashMatches,
      custodyChainValid,
      custodyChainMode,
      otsStatus,
      otsCalendar,
      otsProofPresent,
      otsAnchoredAtUtc,
      otsUpgradedAtUtc,
      otsHashMatches,
      storagePresentation,
      tsaStatus,
      tsaProvider,
      tsaGenTimeUtc,
      tsaSerialNumber,
      tsaHashAlgorithm,
      signingKeyId,
      signingKeyVersion,
      externalPublicationPresent,
      externalPublicationProvider,
      externalPublicationAnchoredAtUtc,
    ]
  );

  const recordTabFields = useMemo(
    () =>
      summaryFields.filter((field) =>
        [
          "Record Status",
          "Verification Status",
          "Integrity Status",
          "Evidence Title",
          "Evidence ID",
          "Evidence Type",
          "Evidence Structure",
          "Capture Method",
          "Submitted By",
          "Auth Provider",
          "Identity Level",
          "Organization",
          "Organization Verified",
          "Report Version",
          "Verification Package Version",
          "Reviewer Summary Version",
          "Created At",
          "Captured At",
          "Uploaded At",
          "Signed At",
          "Generated At",
          "Last Verified At",
          "File Type",
        ].includes(field.label)
      ),
    [summaryFields]
  );

  const integrityStatusCards = useMemo(
    () =>
      technicalCards.filter((card) =>
        [
          "Signature Status",
          "Fingerprint Status",
          "Custody Chain",
          "OpenTimestamps",
          "Storage Protection",
          "Timestamp Status",
          "Timestamp Provider",
          "Timestamp Time",
          "Timestamp Serial",
          "Hash Algorithm",
          "Signing Key",
          "Signing Key Version",
          "OTS Calendar",
          "OTS Proof",
          "OTS Anchored At",
          "OTS Upgraded At",
          "OTS Hash Check",
          "External Publication",
          "Anchor Provider",
          "Anchor Time",
        ].includes(card.label)
      ),
    [technicalCards]
  );

  const heroTitleSize = "clamp(2rem, 3.2vw, 3.1rem)";
  const heroTextSize = "clamp(0.95rem, 1.15vw, 1rem)";
  const cardTitleSize = "clamp(1.45rem, 2.2vw, 1.95rem)";

  const glassCardStyle: CSSProperties = {
    border: `1px solid ${VERIFY_BRAND.line}`,
    background: VERIFY_BRAND.glassStrong,
    backdropFilter: "blur(16px)",
    boxShadow: "0 18px 50px rgba(16, 32, 29, 0.08)",
    borderRadius: 22,
  };

  const glassPanelStyle: CSSProperties = {
    border: `1px solid ${VERIFY_BRAND.softLine}`,
    background: VERIFY_BRAND.glass,
    borderRadius: 18,
  };

  const bronzeRailStyle: CSSProperties = {
    border: `1px solid ${VERIFY_BRAND.line}`,
    borderLeft: `5px solid ${VERIFY_BRAND.bronze}`,
    background: VERIFY_BRAND.bronzeSoft,
    borderRadius: 18,
  };

  const verifyAssetPaths = {
    logo: "/brand/icon-192.png",
    pagePaper: "/brand/paper-silver.png",
    headerVelvet: "/brand/site-velvet-bg.webp.png",
  };

  const pageBackgroundStyle: CSSProperties = {
    backgroundImage: `
      radial-gradient(circle at 12% 6%, rgba(11,46,39,0.08), transparent 30%),
      radial-gradient(circle at 92% 12%, rgba(96,66,24,0.08), transparent 28%),
      url("${verifyAssetPaths.pagePaper}")
    `,
    backgroundColor: "#eef1ef",
    backgroundSize: "auto, auto, cover",
    backgroundPosition: "left top, right top, center top",
    backgroundRepeat: "no-repeat, no-repeat, repeat",
  };

  const headerVelvetStyle: CSSProperties = {
    backgroundImage: `
      linear-gradient(180deg, rgba(0,0,0,0.10) 0%, rgba(0,0,0,0.34) 100%),
      url("${verifyAssetPaths.headerVelvet}")
    `,
    backgroundColor: "#062b24",
    backgroundSize: "cover",
    backgroundPosition: "center bottom",
    backgroundRepeat: "no-repeat",
    border: "1px solid rgba(255,255,255,0.18)",
    boxShadow: "0 18px 50px rgba(11,46,39,0.18)",
  };

  return (
        <div className="page" style={VERIFY_TYPO.page}>
      <section
        className="section"
        style={{
          position: "relative",
          overflow: "hidden",
          paddingTop: 24,
          paddingBottom: 42,
          minHeight: "100vh",
          ...pageBackgroundStyle,
        }}
      >
                <div className="container" style={{ position: "relative", zIndex: 1 }}>
          <div
            style={{
              ...glassCardStyle,
              ...headerVelvetStyle,
              marginBottom: 28,
              padding: "16px 20px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <img
src="/brand/icon-192.png"
                alt="PROOVRA"
                style={{
                  width: 46,
                  height: 46,
                  borderRadius: 13,
                  objectFit: "contain",
                  boxShadow: "0 12px 28px rgba(11,46,39,0.16)",
                  flexShrink: 0,
                }}
              />

              <div>
                <div
                  style={{
                    fontFamily: 'Georgia, "Times New Roman", serif',
                    fontSize: 20,
                    fontWeight: 900,
                    letterSpacing: "0.075em",
                    lineHeight: 1.05,
                    background:
                      "linear-gradient(180deg, #f2f4f6 0%, #cfd4d8 35%, #9aa3aa 55%, #e6eaed 100%)",
                    WebkitBackgroundClip: "text",
                    WebkitTextFillColor: "transparent",
                    textShadow:
                      "0 1px 0 rgba(255,255,255,0.25), 0 2px 6px rgba(0,0,0,0.25)",
                  }}
                                >
                  PROOVRA
                </div>
                <div
                  style={{
                    marginTop: 5,
                    ...VERIFY_TYPO.kicker,
                    fontSize: 10,
                    letterSpacing: "0.13em",
                    color: "rgba(220,225,230,0.85)",
                  }}
                                  >
                  Secure Evidence Verification
                </div>
              </div>
            </div>

            <a
              href="/"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                minHeight: 42,
                padding: "10px 15px",
                borderRadius: 999,
                border: "1px solid rgba(255,255,255,0.24)",
                background: "rgba(255,255,255,0.12)",
                color: "#ffffff",
                                fontSize: 11,
                fontWeight: 900,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                textDecoration: "none",
                whiteSpace: "nowrap",
                boxShadow: "0 8px 22px rgba(16,32,29,0.06)",
              }}
            >
              Back to Home
            </a>
          </div>

          <div
            className="page-title"
            style={{
              marginBottom: 24,
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "space-between",
              gap: 18,
              flexWrap: "wrap",
            }}
          >
            <div style={{ minWidth: 0, flex: "1 1 680px" }}>
              <h1
                style={{
                  margin: 0,
                  fontSize: heroTitleSize,
                  lineHeight: 1.05,
                  fontWeight: 900,
                  letterSpacing: "-0.04em",
                  color: VERIFY_BRAND.ink,
                  maxWidth: 820,
                }}
              >
                Evidence Integrity Review
              </h1>
              <p
                className="page-subtitle"
                style={{
                  marginTop: 12,
                  marginBottom: 0,
                  fontSize: heroTextSize,
                  color: VERIFY_BRAND.muted,
                  maxWidth: 780,
                  lineHeight: 1.65,
                  fontWeight: 500,
                }}
              >
                Review recorded integrity status, cryptographic materials, immutable
                storage protection, timestamp evidence, OpenTimestamps proofing,
                verification history, and custody timeline associated with this
                evidence record.
              </p>
            </div>

            <div
              style={{
                padding: "10px 14px",
                borderRadius: 999,
                border: `1px solid ${VERIFY_BRAND.line}`,
                background: "rgba(255,255,255,0.42)",
                color: VERIFY_BRAND.ink,
                fontSize: 12,
                fontWeight: 800,
                backdropFilter: "blur(12px)",
                maxWidth: "100%",
                wordBreak: "break-all",
              }}
            >
              Token: {params?.token ?? ""}
            </div>
          </div>

          {loading ? (
            <div style={{ display: "grid", gap: 18 }}>
              <Card>
                <div style={{ display: "grid", gap: 14 }}>
                  <Skeleton width="42%" height="18px" />
                  <Skeleton width="100%" height="72px" />
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                      gap: 12,
                    }}
                  >
                    <Skeleton width="100%" height="78px" />
                    <Skeleton width="100%" height="78px" />
                    <Skeleton width="100%" height="78px" />
                  </div>
                </div>
              </Card>

              <Card>
                <div style={{ display: "grid", gap: 12 }}>
                  <Skeleton width="28%" height="18px" />
                  <Skeleton width="100%" height="110px" />
                  <Skeleton width="100%" height="110px" />
                </div>
              </Card>
            </div>
          ) : error ? (
            <Card>
              <EmptyState
                title="Verification Failed"
                subtitle={error}
                action={() => (
                  <Button onClick={() => window.location.reload()}>Try Again</Button>
                )}
              />
            </Card>
          ) : !hash &&
            !signature &&
            evidenceItems.length === 0 &&
            !overview &&
            !humanSummary ? (
            <Card>
              <EmptyState
                title="Evidence Not Found"
                subtitle="The evidence token is invalid, unavailable, or no verification materials were returned."
                action={() => (
                  <Button onClick={() => (window.location.href = "/")}>
                    Back to Home
                  </Button>
                )}
              />
            </Card>
          ) : (
            <div style={{ display: "grid", gap: 18 }}>
              <Card>
                <div
                  style={{
                    ...glassCardStyle,
                    padding: 24,
                    display: "grid",
                    gridTemplateColumns: "minmax(0, 1fr)",
                    gap: 18,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                      gap: 18,
                      flexWrap: "wrap",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 16,
                        minWidth: 0,
                        flex: "1 1 640px",
                      }}
                    >
                      <div
                        style={{
                          width: 60,
                          height: 60,
                          borderRadius: 999,
                          background:
                            overallIntegrity === false
                              ? `linear-gradient(180deg, ${VERIFY_BRAND.danger} 0%, #8f3328 100%)`
                              : `linear-gradient(180deg, ${VERIFY_BRAND.success} 0%, #145c48 100%)`,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: "#fff",
                          fontSize: 28,
                          fontWeight: 900,
                          boxShadow:
                            overallIntegrity === false
                              ? "0 16px 34px rgba(181,71,56,0.20)"
                              : "0 16px 34px rgba(33,117,93,0.20)",
                          flexShrink: 0,
                        }}
                      >
                        {overallIntegrity === false ? "!" : "✓"}
                      </div>

                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{
                            ...VERIFY_TYPO.kicker,
                            fontSize: 11,
                            marginBottom: 7,
                          }}
                        >
                          Integrity Status
                        </div>
                        <div
                          style={{
                            fontSize: cardTitleSize,
                            lineHeight: 1.12,
                            fontWeight: 900,
                            color: VERIFY_BRAND.ink,
                            letterSpacing: "-0.028em",
                            marginBottom: 9,
                            wordBreak: "break-word",
                          }}
                        >
                          {heroIntegrityHeadline}
                        </div>
                        <div
                          style={{
                            ...VERIFY_TYPO.body,
                            fontSize: 15,
                            maxWidth: 820,
                          }}
                        >
                          {heroSummaryText}
                        </div>
                      </div>
                    </div>

                    <div
                      style={{
                        padding: "10px 14px",
                        borderRadius: 999,
                        border: `1px solid ${statusTone(verifyStatus).border}`,
                        background: statusTone(verifyStatus).bg,
                        color: statusTone(verifyStatus).color,
                        fontSize: 11,
                        fontWeight: 900,
                        letterSpacing: "0.055em",
                        textTransform: "uppercase",
                        alignSelf: "flex-start",
                        maxWidth: "100%",
                      }}
                    >
                      {statusTone(verifyStatus).label}
                    </div>
                  </div>

                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                    {executiveBadges.map((item) => (
                      <Badge key={item.label} label={item.label} tone={item.tone} />
                    ))}
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(min(100%, 260px), 1fr))",
                      gap: 14,
                    }}
                  >
                    {[
                      {
                        title: "Legal review outcome",
                        body: legalOutcomeNarrative,
                        footer: null,
                      },
                      {
                        title: "Forensic custody posture",
                        body: forensicCustodyNarrative,
                        footer: accessActivityNarrative,
                      },
                      {
                        title: "Scope of this page",
                        body: heroWhatIsVerifiedText,
                        footer:
                          "Technical details, timestamping, anchoring, and access history remain available below in the technical review layer.",
                      },
                    ].map((panel) => (
                      <div
                        key={panel.title}
                        style={{
                          ...glassPanelStyle,
                          borderLeft: `5px solid ${VERIFY_BRAND.bronze}`,
                          padding: 18,
                          display: "grid",
                          gap: 8,
                        }}
                      >
                        <div
                          style={{
                            ...VERIFY_TYPO.kicker,
                            fontSize: 10.5,
                          }}
                        >
                          {panel.title}
                        </div>
                        <div
                          style={{
                            ...VERIFY_TYPO.small,
                            fontSize: 13,
                            color: VERIFY_BRAND.ink,
                            wordBreak: "break-word",
                            overflowWrap: "anywhere",
                          }}
                        >
                          {panel.body}
                        </div>
                        {panel.footer ? (
                          <div
                            style={{
                              ...VERIFY_TYPO.small,
                              fontSize: 12,
                            }}
                          >
                            {panel.footer}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>

                  {externalPublicationPresent === true ? (
                    <div
                      style={{
                        ...glassPanelStyle,
                        borderLeft: `5px solid ${VERIFY_BRAND.success}`,
                        padding: 18,
                        display: "grid",
                        gap: 8,
                      }}
                    >
                      <div
                        style={{
                          ...VERIFY_TYPO.kicker,
                          fontSize: 10.5,
                          color: VERIFY_BRAND.success,
                        }}
                      >
                        External Publication
                      </div>
                      <div
                        style={{
                          ...VERIFY_TYPO.small,
                          fontSize: 13,
                          color: VERIFY_BRAND.ink,
                        }}
                      >
                        This evidence record includes external publication metadata.
                        That means an external publication or anchor receipt has been
                        recorded for this integrity state.
                      </div>
                      {externalPublicationProvider ? (
                        <div style={VERIFY_TYPO.small}>
                          Provider: {externalPublicationProvider}
                        </div>
                      ) : null}
                      {externalPublicationAnchoredAtUtc ? (
                        <div style={VERIFY_TYPO.small}>
                          Anchored At:{" "}
                          {formatDateTime(externalPublicationAnchoredAtUtc)}
                        </div>
                      ) : null}
                      {externalPublicationUrl ? (
                        <a
                          href={externalPublicationUrl}
                          target="_blank"
                          rel="noreferrer"
                          style={{
                            ...VERIFY_TYPO.small,
                            color: VERIFY_BRAND.accent2,
                            fontWeight: 900,
                            textDecoration: "underline",
                            wordBreak: "break-all",
                          }}
                        >
                          Open publication record
                        </a>
                      ) : null}
                    </div>
                  ) : null}

                  {custodyChainFailureReason ? (
                    <div
                      style={{
                        border: `1px solid rgba(181,71,56,0.25)`,
                        borderLeft: `5px solid ${VERIFY_BRAND.danger}`,
                        background: VERIFY_BRAND.dangerSoft,
                        borderRadius: 18,
                        padding: 18,
                      }}
                    >
                      <div
                        style={{
                          ...VERIFY_TYPO.kicker,
                          fontSize: 10.5,
                          color: VERIFY_BRAND.danger,
                          marginBottom: 8,
                        }}
                      >
                        Verification Warning
                      </div>
                      <div
                        style={{
                          ...VERIFY_TYPO.small,
                          fontSize: 13,
                          color: VERIFY_BRAND.ink,
                          wordBreak: "break-word",
                          overflowWrap: "anywhere",
                        }}
                      >
                        Custody chain check reported: {custodyChainFailureReason}
                      </div>
                    </div>
                  ) : null}

                  {limitations?.short || limitations?.detailed ? (
                    <div
                      style={{
                        ...bronzeRailStyle,
                        padding: 18,
                        display: "grid",
                        gap: 8,
                      }}
                    >
                      <div
                        style={{
                          ...VERIFY_TYPO.kicker,
                          fontSize: 10.5,
                          color: VERIFY_BRAND.warning,
                        }}
                      >
                        Important limitation
                      </div>
                      {limitations?.short ? (
                        <div
                          style={{
                            ...VERIFY_TYPO.small,
                            fontSize: 13,
                            color: VERIFY_BRAND.ink,
                          }}
                        >
                          {limitations.short}
                        </div>
                      ) : null}
                      {limitations?.detailed ? (
                        <div
                          style={{
                            ...VERIFY_TYPO.small,
                            fontSize: 13,
                            color: VERIFY_BRAND.ink,
                          }}
                        >
                          {limitations.detailed}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </Card>

              {evidenceItems.length > 0 ? (
                <Card>
                  <div
                    style={{
                      ...glassCardStyle,
                      padding: 24,
                      display: "grid",
                      gap: 18,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        justifyContent: "space-between",
                        gap: 16,
                        flexWrap: "wrap",
                      }}
                    >
                      <div style={{ minWidth: 0, flex: "1 1 620px" }}>
                        <div
                          style={{
                            ...VERIFY_TYPO.kicker,
                            fontSize: 11,
                            marginBottom: 8,
                          }}
                        >
                          Evidence Content Review
                        </div>
                        <div
                          style={{
                            fontSize: cardTitleSize,
                            fontWeight: 900,
                            color: VERIFY_BRAND.ink,
                            lineHeight: 1.12,
                            letterSpacing: "-0.028em",
                            marginBottom: 8,
                          }}
                        >
                          {selectedEvidenceItem
                            ? `${evidenceKindLabel(
                                selectedEvidenceItem.kind
                              )} review surface`
                            : "Evidence review surface"}
                        </div>
                        <div
                          style={{
                            ...VERIFY_TYPO.body,
                            maxWidth: 860,
                          }}
                        >
                          {previewPolicy?.rationale ??
                            "Review the preserved evidence item here while keeping integrity, custody, and timestamp materials in the same verification record."}
                        </div>
                      </div>

                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: 10,
                          justifyContent: "flex-end",
                        }}
                      >
                        {evidenceSectionDescription ? (
                          <div
                            style={{
                              padding: "10px 14px",
                              borderRadius: 999,
                              border: `1px solid ${VERIFY_BRAND.line}`,
                              background: "rgba(255,255,255,0.46)",
                              color: VERIFY_BRAND.ink,
                              fontSize: 11,
                              fontWeight: 900,
                              letterSpacing: "0.055em",
                              textTransform: "uppercase",
                            }}
                          >
                            {evidenceSectionDescription}
                          </div>
                        ) : null}
                        {contentAccessPolicy?.mode ? (
                          <div
                            style={{
                              padding: "10px 14px",
                              borderRadius: 999,
                              border: `1px solid ${VERIFY_BRAND.line}`,
                              background:
                                contentAccessPolicy.mode === "full_access"
                                  ? VERIFY_BRAND.successSoft
                                  : contentAccessPolicy.mode === "preview_only"
                                    ? "rgba(11,46,39,0.08)"
                                    : VERIFY_BRAND.warningSoft,
                              color:
                                contentAccessPolicy.mode === "full_access"
                                  ? VERIFY_BRAND.success
                                  : contentAccessPolicy.mode === "preview_only"
                                    ? VERIFY_BRAND.accent
                                    : VERIFY_BRAND.warning,
                              fontSize: 11,
                              fontWeight: 900,
                              letterSpacing: "0.055em",
                              textTransform: "uppercase",
                            }}
                          >
                            {contentAccessPolicy.mode === "full_access"
                              ? "Direct evidence access"
                              : contentAccessPolicy.mode === "preview_only"
                                ? "Controlled preview access"
                                : "Metadata-only verification"}
                          </div>
                        ) : null}
                      </div>
                    </div>

                    <div
                      style={{
                        ...bronzeRailStyle,
                        padding: 18,
                        display: "grid",
                        gap: 10,
                      }}
                    >
                      <div
                        style={{
                          ...VERIFY_TYPO.kicker,
                          fontSize: 10.5,
                        }}
                      >
                        Reviewer access note
                      </div>
                      <div
                        style={{
                          ...VERIFY_TYPO.small,
                          fontSize: 13,
                          color: VERIFY_BRAND.ink,
                        }}
                      >
                        {contentExposureDecision?.rationale ??
                          previewPolicy?.privacyNotice ??
                          "Displayed content may be a reviewer-facing exposure of the preserved evidence item. Original evidence remains separately preserved and integrity-checked."}
                      </div>
                      <div style={{ ...VERIFY_TYPO.small, fontSize: 13 }}>
                        {previewPolicy?.privacyNotice ??
                          "Any preview shown here should be interpreted together with the integrity, custody, and timestamp sections below."}
                      </div>
                    </div>

                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                        gap: 14,
                      }}
                    >
                      <div
                        style={{
                          ...glassPanelStyle,
                          padding: 18,
                          display: "grid",
                          gap: 8,
                        }}
                      >
                        <div
                          style={{
                            ...VERIFY_TYPO.kicker,
                            fontSize: 10.5,
                          }}
                        >
                          What changed since completion
                        </div>
                        {whatChangedSinceCompletion.length > 0 ? (
                          whatChangedSinceCompletion.map((entry) => (
                            <div
                              key={entry}
                              style={{
                                ...VERIFY_TYPO.small,
                                fontSize: 13,
                                color: VERIFY_BRAND.ink,
                              }}
                            >
                              {entry}
                            </div>
                          ))
                        ) : (
                          <div
                            style={{
                              ...VERIFY_TYPO.small,
                              fontSize: 13,
                            }}
                          >
                            No later report, package, or reviewer-summary changes were
                            exposed in this verification response.
                          </div>
                        )}
                      </div>

                      <div
                        style={{
                          border:
                            mismatchMessages.length > 0
                              ? `1px solid rgba(181,71,56,0.25)`
                              : `1px solid rgba(33,117,93,0.25)`,
                          borderLeft:
                            mismatchMessages.length > 0
                              ? `5px solid ${VERIFY_BRAND.danger}`
                              : `5px solid ${VERIFY_BRAND.success}`,
                          background:
                            mismatchMessages.length > 0
                              ? VERIFY_BRAND.dangerSoft
                              : VERIFY_BRAND.successSoft,
                          borderRadius: 18,
                          padding: 18,
                          display: "grid",
                          gap: 8,
                        }}
                      >
                        <div
                          style={{
                            ...VERIFY_TYPO.kicker,
                            fontSize: 10.5,
                            color:
                              mismatchMessages.length > 0
                                ? VERIFY_BRAND.danger
                                : VERIFY_BRAND.success,
                          }}
                        >
                          Mismatch detection
                        </div>
                        {mismatchMessages.length > 0 ? (
                          mismatchMessages.map((entry) => (
                            <div
                              key={entry}
                              style={{
                                ...VERIFY_TYPO.small,
                                fontSize: 13,
                                color: VERIFY_BRAND.ink,
                              }}
                            >
                              {entry}
                            </div>
                          ))
                        ) : (
                          <div
                            style={{
                              ...VERIFY_TYPO.small,
                              fontSize: 13,
                              color: VERIFY_BRAND.ink,
                            }}
                          >
                            No explicit digest, signature, custody, timestamp, or OTS
                            mismatches were detected in the current verification result.
                          </div>
                        )}
                      </div>
                    </div>

                    {evidenceItems.length > 1 ? (
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: 10,
                        }}
                      >
                        {evidenceItems.map((item) => {
                          const active = selectedEvidenceItem?.id === item.id;

                          return (
                            <button
                              key={item.id}
                              type="button"
                              onClick={() => setSelectedEvidenceItemId(item.id)}
                              style={{
                                padding: "12px 14px",
                                borderRadius: 16,
                                border: active
                                  ? `1px solid ${VERIFY_BRAND.accent}`
                                  : `1px solid ${VERIFY_BRAND.line}`,
                                background: active
                                  ? "rgba(11,46,39,0.10)"
                                  : "rgba(255,255,255,0.54)",
                                color: VERIFY_BRAND.ink,
                                fontSize: 13,
                                fontWeight: 800,
                                cursor: "pointer",
                                textAlign: "left",
                                minWidth: 220,
                              }}
                            >
                              <div style={{ marginBottom: 4 }}>{item.label}</div>
                              <div
                                style={{
                                  ...VERIFY_TYPO.small,
                                  fontSize: 12,
                                  color: active
                                    ? VERIFY_BRAND.accent
                                    : VERIFY_BRAND.muted,
                                }}
                              >
                                {evidenceKindLabel(item.kind)}
                                {item.isPrimary ? " • Primary item" : ""}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    ) : null}

                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns:
                          "repeat(auto-fit, minmax(min(100%, 320px), 1fr))",
                        gap: 18,
                      }}
                    >
                      <div style={{ display: "grid", gap: 14 }}>
                        {renderVerifyEvidenceMedia(selectedEvidenceItem)}

                        <div
                          style={{
                            ...glassPanelStyle,
                            padding: 16,
                            display: "grid",
                            gap: 8,
                          }}
                        >
                          <div
                            style={{
                              ...VERIFY_TYPO.kicker,
                              fontSize: 10.5,
                            }}
                          >
                            Representation note
                          </div>
                          <div
                            style={{
                              ...VERIFY_TYPO.small,
                              fontSize: 13,
                              color: VERIFY_BRAND.ink,
                            }}
                          >
                            This panel is intended for reviewer understanding of the
                            preserved evidence item. The original file remains
                            separately preserved and the technical sections below
                            describe the recorded integrity, custody, timestamping,
                            and publication state tied to that item.
                          </div>
                        </div>
                      </div>

                      <div style={{ display: "grid", gap: 14 }}>
                        <div
                          style={{
                            ...VERIFY_SURFACE.card,
                            padding: 18,
                            display: "grid",
                            gap: 12,
                          }}
                        >
                          <div
                            style={{
                              ...VERIFY_TYPO.kicker,
                              fontSize: 10.5,
                            }}
                          >
                            Selected Evidence Item
                          </div>
                          <div
                            style={{
                              ...VERIFY_TYPO.h3,
                              fontSize: 20,
                            }}
                          >
                            {selectedEvidenceItem?.label ?? "No item selected"}
                          </div>
                          <div
                            style={{
                              display: "grid",
                              gap: 10,
                              ...VERIFY_TYPO.small,
                              color: VERIFY_BRAND.ink,
                            }}
                          >
                            <div>
                              <strong>Kind:</strong>{" "}
                              {evidenceKindLabel(selectedEvidenceItem?.kind)}
                            </div>
                            {selectedEvidenceItem?.mimeType ? (
                              <div>
                                <strong>MIME Type:</strong>{" "}
                                {selectedEvidenceItem.mimeType}
                              </div>
                            ) : null}
                            {selectedEvidenceItem?.displaySizeLabel ? (
                              <div>
                                <strong>Size:</strong>{" "}
                                {selectedEvidenceItem.displaySizeLabel}
                              </div>
                            ) : null}
                            {formatDuration(selectedEvidenceItem?.durationMs) ? (
                              <div>
                                <strong>Duration:</strong>{" "}
                                {formatDuration(selectedEvidenceItem?.durationMs)}
                              </div>
                            ) : null}
                            {previewRoleLabel(selectedEvidenceItem?.previewRole) ? (
                              <div>
                                <strong>Access role:</strong>{" "}
                                {previewRoleLabel(selectedEvidenceItem?.previewRole)}
                              </div>
                            ) : null}
                            {selectedEvidenceItem?.sha256 ? (
                              <div style={VERIFY_TYPO.hash}>
                                <strong>SHA-256:</strong>{" "}
                                {selectedEvidenceItem.sha256}
                              </div>
                            ) : null}
                            {selectedEvidenceItem?.originalPreservationNote ? (
                              <div style={{ lineHeight: 1.7 }}>
                                <strong>Original:</strong>{" "}
                                {selectedEvidenceItem.originalPreservationNote}
                              </div>
                            ) : null}
                            {selectedEvidenceItem?.reviewerRepresentationLabel ? (
                              <div>
                                <strong>Reviewer surface:</strong>{" "}
                                {selectedEvidenceItem.reviewerRepresentationLabel}
                              </div>
                            ) : null}
                          </div>

                          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                            {selectedEvidenceItem?.viewUrl ? (
                              <a
                                href={selectedEvidenceItem.viewUrl}
                                target="_blank"
                                rel="noreferrer"
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  padding: "10px 14px",
                                  borderRadius: 999,
                                  border: `1px solid ${VERIFY_BRAND.accent}`,
                                  background: VERIFY_BRAND.accent,
                                  color: "#ffffff",
                                  fontSize: 11,
                                  fontWeight: 900,
                                  letterSpacing: "0.055em",
                                  textTransform: "uppercase",
                                  textDecoration: "none",
                                  boxShadow: "0 12px 26px rgba(11,46,39,0.16)",
                                }}
                              >
                                Open preserved evidence
                              </a>
                            ) : null}
                            {selectedEvidenceItem?.viewUrl &&
                            selectedEvidenceItem.downloadable ? (
                              <a
                                href={selectedEvidenceItem.viewUrl}
                                download={selectedEvidenceItem.originalFileName ?? true}
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  padding: "10px 14px",
                                  borderRadius: 999,
                                  border: `1px solid ${VERIFY_BRAND.line}`,
                                  background: "rgba(255,255,255,0.54)",
                                  color: VERIFY_BRAND.ink,
                                  fontSize: 11,
                                  fontWeight: 900,
                                  letterSpacing: "0.055em",
                                  textTransform: "uppercase",
                                  textDecoration: "none",
                                }}
                              >
                                Download evidence
                              </a>
                            ) : null}
                          </div>
                        </div>

                        {selectedEvidenceItem?.reviewerRepresentationNote ? (
                          <div
                            style={{
                              ...bronzeRailStyle,
                              padding: 18,
                              display: "grid",
                              gap: 8,
                            }}
                          >
                            <div
                              style={{
                                ...VERIFY_TYPO.kicker,
                                fontSize: 10.5,
                                color: VERIFY_BRAND.warning,
                              }}
                            >
                              Reviewer representation note
                            </div>
                            <div
                              style={{
                                ...VERIFY_TYPO.small,
                                fontSize: 13,
                                color: VERIFY_BRAND.ink,
                              }}
                            >
                              {selectedEvidenceItem.reviewerRepresentationNote}
                            </div>
                          </div>
                        ) : null}

                        {selectedEvidenceItem?.verificationMaterialsNote ? (
                          <div
                            style={{
                              ...glassPanelStyle,
                              borderLeft: `5px solid ${VERIFY_BRAND.accent}`,
                              padding: 18,
                              display: "grid",
                              gap: 8,
                            }}
                          >
                            <div
                              style={{
                                ...VERIFY_TYPO.kicker,
                                fontSize: 10.5,
                              }}
                            >
                              Verification materials note
                            </div>
                            <div
                              style={{
                                ...VERIFY_TYPO.small,
                                fontSize: 13,
                                color: VERIFY_BRAND.ink,
                              }}
                            >
                              {selectedEvidenceItem.verificationMaterialsNote}
                            </div>
                          </div>
                        ) : null}

                        {primaryContentItem &&
                        selectedEvidenceItem?.id !== primaryContentItem.id ? (
                          <div
                            style={{
                              ...glassPanelStyle,
                              borderLeft: `5px solid ${VERIFY_BRAND.accent}`,
                              padding: 18,
                              display: "grid",
                              gap: 8,
                            }}
                          >
                            <div
                              style={{
                                ...VERIFY_TYPO.kicker,
                                fontSize: 10.5,
                              }}
                            >
                              Primary evidence item
                            </div>
                            <div
                              style={{
                                ...VERIFY_TYPO.value,
                                color: VERIFY_BRAND.ink,
                              }}
                            >
                              {primaryContentItem.label}
                            </div>
                            <button
                              type="button"
                              onClick={() =>
                                setSelectedEvidenceItemId(primaryContentItem.id)
                              }
                              style={{
                                width: "fit-content",
                                padding: "10px 14px",
                                borderRadius: 999,
                                border: `1px solid ${VERIFY_BRAND.line}`,
                                background: "rgba(255,255,255,0.54)",
                                color: VERIFY_BRAND.accent,
                                fontSize: 11,
                                fontWeight: 900,
                                letterSpacing: "0.055em",
                                textTransform: "uppercase",
                                cursor: "pointer",
                              }}
                            >
                              Jump to primary item
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </Card>
              ) : null}

              <Card>
                <div
                  style={{
                    ...glassCardStyle,
                    padding: 24,
                    display: "grid",
                    gap: 18,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                      gap: 12,
                      flexWrap: "wrap",
                    }}
                  >
                    <div>
                      <h3
                        style={{
                          margin: 0,
                          ...VERIFY_TYPO.h3,
                        }}
                      >
                        Technical Review Materials
                      </h3>
                      <div
                        style={{
                          marginTop: 7,
                          ...VERIFY_TYPO.small,
                          maxWidth: 820,
                        }}
                      >
                        This technical layer keeps record metadata, cryptographic
                        materials, forensic custody, and access activity separate so
                        reviewers can distinguish legal posture from raw verification
                        materials.
                      </div>
                    </div>
                  </div>

                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                    <TechnicalTabButton
                      label="Record"
                      active={activeTechnicalTab === "record"}
                      onClick={() => setActiveTechnicalTab("record")}
                    />
                    <TechnicalTabButton
                      label="Integrity"
                      active={activeTechnicalTab === "integrity"}
                      onClick={() => setActiveTechnicalTab("integrity")}
                    />
                    <TechnicalTabButton
                      label="Full Custody Chain"
                      active={activeTechnicalTab === "full-custody"}
                      onClick={() => setActiveTechnicalTab("full-custody")}
                    />
                    <TechnicalTabButton
                      label="Access Activity"
                      active={activeTechnicalTab === "access"}
                      onClick={() => setActiveTechnicalTab("access")}
                    />
                  </div>

                  {activeTechnicalTab === "record" ? (
                    <div style={{ display: "grid", gap: 16 }}>
                      <div
                        style={{
                          ...bronzeRailStyle,
                          padding: 16,
                          ...VERIFY_TYPO.small,
                          fontSize: 13,
                          color: VERIFY_BRAND.ink,
                        }}
                      >
                        Core record identity, lifecycle milestones, and versioning
                        metadata are shown here. This metadata identifies the
                        preserved record but is separate from the cryptographic proof
                        and from any custody-event chronology.
                      </div>

                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                          gap: 14,
                        }}
                      >
                        {recordTabFields.map((field) => (
                          <SummaryField
                            key={field.label}
                            label={field.label}
                            value={field.value}
                          />
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {activeTechnicalTab === "integrity" ? (
                    <div style={{ display: "grid", gap: 14 }}>
                      <div
                        style={{
                          ...bronzeRailStyle,
                          padding: 16,
                          display: "grid",
                          gap: 8,
                        }}
                      >
                        <div
                          style={{
                            ...VERIFY_TYPO.kicker,
                            fontSize: 10.5,
                          }}
                        >
                          Integrity scope
                        </div>
                        <div
                          style={{
                            ...VERIFY_TYPO.small,
                            fontSize: 13,
                            color: VERIFY_BRAND.ink,
                          }}
                        >
                          These materials support review of the recorded file hash,
                          canonical fingerprint, signature, timestamp linkage,
                          OpenTimestamps proofing, immutable storage indicators, and
                          publication state. They do not independently resolve
                          authorship, narrative context, or admissibility.
                        </div>
                      </div>

                      {hash ? (
                        <MaterialField
                          label={
                            evidenceContentSummary?.structure === "multipart"
                              ? "Canonical Package Digest (SHA-256)"
                              : "Original File SHA-256"
                          }
                          subtitle={
                            evidenceContentSummary?.structure === "multipart"
                              ? "SHA-256 digest representing the canonical multipart evidence package. Individual item hashes are listed separately, and the Canonical Fingerprint Hash defines the full package identity."
                              : "SHA-256 digest of the original preserved evidence file."
                          }
                          value={hash}
                          addToast={addToast}
                          copyMessage={
                            evidenceContentSummary?.structure === "multipart"
                              ? "Canonical package digest copied"
                              : "Original file hash copied"
                          }
                        />
                      ) : null}

                      {fingerprintHash ? (
                        <MaterialField
                          label="Canonical Fingerprint Hash"
                          subtitle="Hash derived from the canonical fingerprint record."
                          value={fingerprintHash}
                          addToast={addToast}
                          copyMessage="Fingerprint hash copied"
                        />
                      ) : null}

                      {signature ? (
                        <MaterialField
                          label="Digital Signature"
                          subtitle="Recorded signature material associated with this evidence."
                          value={signature}
                          addToast={addToast}
                          copyMessage="Digital signature copied"
                        />
                      ) : null}

                      {publicKeyPem ? (
                        <MaterialField
                          label="Public Key"
                          subtitle="Public key material available for advanced technical review."
                          value={publicKeyPem}
                          addToast={addToast}
                          copyMessage="Public key copied"
                        />
                      ) : null}

                      {otsProofBase64 ? (
                        <MaterialField
                          label="OpenTimestamps Proof"
                          subtitle="Recorded OTS proof material for the evidence digest."
                          value={otsProofBase64}
                          addToast={addToast}
                          copyMessage="OTS proof copied"
                        />
                      ) : null}

                      {integrityStatusCards.length > 0 ? (
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                            gap: 14,
                          }}
                        >
                          {integrityStatusCards.map((card) => (
                            <div
                              key={card.label}
                              style={{
                                ...glassPanelStyle,
                                padding: 16,
                                minWidth: 0,
                                overflow: "hidden",
                              }}
                            >
                              <div
                                style={{
                                  ...VERIFY_TYPO.kicker,
                                  fontSize: 10.5,
                                  marginBottom: 10,
                                }}
                              >
                                {card.label}
                              </div>

                              <div
                                style={{
                                  ...VERIFY_TYPO.value,
                                  wordBreak: "break-word",
                                  overflowWrap: "anywhere",
                                  minWidth: 0,
                                }}
                              >
                                {card.content}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : null}

                      {tsaFailureReason ? (
                        <div
                          style={{
                            border: `1px solid rgba(181,71,56,0.25)`,
                            borderLeft: `5px solid ${VERIFY_BRAND.danger}`,
                            background: VERIFY_BRAND.dangerSoft,
                            borderRadius: 18,
                            padding: 16,
                          }}
                        >
                          <div
                            style={{
                              ...VERIFY_TYPO.kicker,
                              fontSize: 10.5,
                              color: VERIFY_BRAND.danger,
                              marginBottom: 8,
                            }}
                          >
                            Timestamp Failure Reason
                          </div>
                          <div
                            style={{
                              ...VERIFY_TYPO.small,
                              fontSize: 13,
                              color: VERIFY_BRAND.ink,
                              wordBreak: "break-word",
                              overflowWrap: "anywhere",
                            }}
                          >
                            {tsaFailureReason}
                          </div>
                        </div>
                      ) : null}

                      {otsFailureDisplayMessage ? (
                        <div
                          style={{
                            border: `1px solid rgba(181,71,56,0.25)`,
                            borderLeft: `5px solid ${VERIFY_BRAND.danger}`,
                            background: VERIFY_BRAND.dangerSoft,
                            borderRadius: 18,
                            padding: 16,
                            display: "grid",
                            gap: 10,
                          }}
                        >
                          <div
                            style={{
                              ...VERIFY_TYPO.kicker,
                              fontSize: 10.5,
                              color: VERIFY_BRAND.danger,
                            }}
                          >
                            OpenTimestamps Status Note
                          </div>

                          <div
                            style={{
                              ...VERIFY_TYPO.small,
                              fontSize: 13,
                              color: VERIFY_BRAND.ink,
                              wordBreak: "break-word",
                              overflowWrap: "anywhere",
                            }}
                          >
                            {otsFailureDisplayMessage}
                          </div>

                          {otsFailureTechnicalMessage ? (
                            <details style={{ marginTop: 2 }}>
                              <summary
                                style={{
                                  cursor: "pointer",
                                  ...VERIFY_TYPO.small,
                                  fontWeight: 900,
                                  color: VERIFY_BRAND.danger,
                                  userSelect: "none",
                                }}
                              >
                                Show technical details
                              </summary>

                              <div
                                style={{
                                  marginTop: 10,
                                  padding: 12,
                                  borderRadius: 12,
                                  border: `1px solid rgba(181,71,56,0.22)`,
                                  background: "rgba(255,255,255,0.36)",
                                  ...VERIFY_TYPO.hash,
                                  color: VERIFY_BRAND.ink,
                                }}
                              >
                                {otsFailureTechnicalMessage}
                              </div>
                            </details>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

{activeTechnicalTab === "full-custody" ? (
  <TimelinePanel
    title="Custody Chain"
    subtitle="Complete recorded custody chronology, including integrity-relevant lifecycle events and later access activity when returned by the verification response. Event hashes are shown in full for chain-continuity review."
    countTone="info"
    events={fullCustodyTimeline}
    emptyTitle="No custody-chain events were returned"
    emptyBody="This verification response did not include a complete custody-event chain."
    accent={{
      dot: VERIFY_BRAND.accent,
      dotBorder: "rgba(11,46,39,0.16)",
      line: "rgba(11,46,39,0.25)",
    }}
  />
) : null}

                  {activeTechnicalTab === "access" ? (
                    <TimelinePanel
                      title="Access Activity"
                      subtitle="Access events show later viewing, download, and verification interactions. They are informational and should not be conflated with forensic custody events."
                      countTone="neutral"
                      events={accessTimeline}
                      emptyTitle="No access activity was returned"
                      emptyBody="No access-activity entries were included in this response. Their absence does not change the recorded integrity result and should not be read as a forensic custody conclusion."
                      accent={{
                        dot: "rgba(11,46,39,0.42)",
                        dotBorder: "rgba(11,46,39,0.12)",
                        line: "rgba(11,46,39,0.16)",
                      }}
                    />
                  ) : null}
                </div>
              </Card>

              <Card>
                <div
                  style={{
                    ...glassCardStyle,
                    padding: 24,
                    display: "grid",
                    gap: 18,
                  }}
                >
                  <div>
                    <h3
                      style={{
                        margin: 0,
                        ...VERIFY_TYPO.h3,
                      }}
                    >
                      Actions
                    </h3>
                    <div
                      style={{
                        marginTop: 7,
                        ...VERIFY_TYPO.small,
                        maxWidth: 760,
                      }}
                    >
                      Copy the verification link or open the external publication
                      record when available.
                    </div>
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(220px, 1fr))",
                      gap: 12,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        const url = window.location.href;
                        navigator.clipboard.writeText(url);
                        addToast("Verification link copied", "success");
                      }}
                      style={{
                        width: "100%",
                        minHeight: 52,
                        borderRadius: 999,
                        border: "1px solid rgba(196,165,91,0.42)",
                        background:
                          "linear-gradient(180deg, #163f38 0%, #0b2e27 100%)",
                        color: "#ffffff",
                        fontSize: 12,
                        fontWeight: 900,
                        letterSpacing: "0.065em",
                        textTransform: "uppercase",
                        cursor: "pointer",
                        boxShadow: "0 16px 34px rgba(11,46,39,0.20)",
                      }}
                    >
                      Copy Verification Link
                    </button>

                    {externalPublicationUrl ? (
                      <a
                        href={externalPublicationUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          width: "100%",
                          minHeight: 52,
                          borderRadius: 999,
                          border: `1px solid ${VERIFY_BRAND.line}`,
                          background: "rgba(255,255,255,0.54)",
                          color: VERIFY_BRAND.ink,
                          fontSize: 12,
                          fontWeight: 900,
                          letterSpacing: "0.065em",
                          textTransform: "uppercase",
                          textDecoration: "none",
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          boxShadow: "0 10px 24px rgba(16,32,29,0.08)",
                        }}
                      >
                        Open External Publication
                      </a>
                    ) : null}
                  </div>
                </div>
              </Card>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}