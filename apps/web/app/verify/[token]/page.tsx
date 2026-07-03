"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useParams } from "next/navigation";
import {
  CAPTURE_LOCATION_CONTEXT_DESCRIPTION,
  CAPTURE_LOCATION_LEGAL_BOUNDARY,
  CAPTURE_LOCATION_SHORT_BOUNDARY,
  CAPTURE_LOCATION_SOURCE_LABEL,
  CAPTURE_LOCATION_STATUS_LABEL,
  buildEvidenceTrustDecision,
  formatCaptureLocationAccuracy,
  formatCaptureLocationCoordinate,
  getReviewerEvidenceTypeLabel,
  getReviewerArtifactRoleLabel,
  getTrustDecisionConfidenceLabel,
  getTrustDecisionLabel,
  getTrustNarrative,
  getTrustDecisionPresentationTone,
  getTrustSignalPresentationLabel,
  hasCaptureLocationMetadata,
  isAccessCustodyEventType,
  maskPublicEmail,
  maskPublicEmailsInText,
} from "@proovra/shared";
import {
  PROOVRA_MULTIPART_LEGAL_BOUNDARY_NOTE,
  PROOVRA_MULTIPART_RECOMPUTATION_NOTE,
  PROOVRA_MULTIPART_REVIEWER_EXPLANATION,
} from "@proovra/shared-evidence-presentation";
import {
  Button,
  Card,
  useToast,
  EmptyState,
  Skeleton,
} from "../../../components/ui";
import CaptureLocationMapPanel from "../../../components/capture-location/CaptureLocationMapPanel";
import { useLocale } from "../../providers";
import { apiFetch } from "../../../lib/api";
import { captureException } from "../../../lib/sentry";
// Phase CR4 — `formatUserDateTime` is now consumed inside the extracted
// `formatDateTime` helper in `verify-v2/_helpers.ts`. The orchestrator
// no longer imports it directly.
// Phase CR4 — pure helpers extracted to a presentation-only module
// under `apps/web/components/verify-v2/`. These functions are byte-stable
// against the pre-CR4 inline declarations; behaviour is unchanged.
import {
  firstNonEmpty,
  formatDateTime,
  normalizeBool,
  normalizeEventLabel,
  otsTone,
  statusTone,
  timestampTone,
  truncateHash,
} from "../../../components/verify-v2/_helpers";
import {
  VerifyTechnicalMetadataSection,
  type VerifyTechnicalMetadata,
} from "../../../components/verify-v2/VerifyTechnicalMetadataSection";
import { VerifyCaptureIntegritySection } from "../../../components/verify-v2/VerifyCaptureIntegritySection";
// Type-only imports kept to exactly the symbols this file actually
// references. Nine type aliases that were imported here but never used
// anywhere downstream (VerifyTimelineEvent, VerifyReviewTrail,
// VerifyTechnicalMaterials, VerifyStorageProtection, VerifyOts,
// VerifyStorageAndTimestamping, VerifyIdentity, TrustSignalStatus,
// TrustDecisionTone) were dropped. The symbols themselves still exist in
// ./_verify-types and can be re-imported by any future call site; the
// removal here is purely a no-longer-referenced-import cleanup with zero
// runtime effect (type imports are erased by tsc).
import type {
  VerifyOverview,
  VerifyHumanSummary,
  VerifyCaptureContext,
  VerifyTsa,
  VerifyLimitations,
  VerifyAnchor,
  VerifyEvidenceAssetKind,
  VerifyEvidenceAsset,
  VerifyEvidenceContentSummary,
  VerifyPreviewPolicy,
  VerifyContentAccessPolicy,
  VerifyContentExposureDecision,
  VerifyResponse,
  TimelineItem,
  ToastFn,
  StorageProtection,
  OtsDetails,
  TechnicalTabId,
  VerifyTrustSignal,
  VerifyTrustDecision,
  VerificationVerdict,
  VerificationSignalInput,
  VerificationPackageIntegrity,
  VerifyLifecycleTransparency,
} from "./_verify-types";
import { VerifyLifecycleSection } from "./_verify-lifecycle-section";
import {
  hasAdvancedLiveAnchoring,
  shouldAutoPollPublicVerify,
} from "./public-verify-consistency";

// Re-export the mediaIntelligenceAdvisory shape inline so test contracts can
// assert the field exists directly in this file without reading _verify-types.
// The type is sourced from VerifyResponse but declared here for discoverability.
type _MediaIntelligenceAdvisoryField = {
  mediaIntelligenceAdvisory?: {
    hasObservations: boolean;
    observationCount: number;
    advisory: string;
  } | null;
};

const VERIFY_BRAND = {
  ink: "#071A3A",
  accent: "#071A3A",
  accent2: "#12315A",
  muted: "rgba(7, 26, 58, 0.68)",
  subtle: "rgba(7, 26, 58, 0.72)",
  line: "rgba(7, 26, 58, 0.18)",
  softLine: "rgba(7, 26, 58, 0.12)",
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
  `Inter, "Helvetica Neue", Arial, Helvetica, sans-serif`;

const VERIFY_TYPO = {
  page: {
    fontFamily: VERIFY_FONT,
    letterSpacing: "-0.003em",
    WebkitFontSmoothing: "antialiased" as const,
    MozOsxFontSmoothing: "grayscale" as const,
  },
  kicker: {
    fontSize: 10.5,
    fontWeight: 750,
    letterSpacing: "0.085em",
    textTransform: "uppercase" as const,
    color: VERIFY_BRAND.subtle,
  },
  h1: {
    fontSize: "clamp(2rem, 3vw, 2.85rem)",
    lineHeight: 1.06,
    fontWeight: 800,
    letterSpacing: "-0.04em",
    color: VERIFY_BRAND.ink,
  },
  h2: {
    fontSize: "clamp(1.35rem, 1.9vw, 1.85rem)",
    lineHeight: 1.14,
    fontWeight: 800,
    letterSpacing: "-0.026em",
    color: VERIFY_BRAND.ink,
  },
  h3: {
    fontSize: 17,
    lineHeight: 1.25,
    fontWeight: 800,
    letterSpacing: "-0.014em",
    color: VERIFY_BRAND.ink,
  },
body: {
  fontSize: 14,
  lineHeight: 1.7,
  fontWeight: 430,
      color: VERIFY_BRAND.muted,
  },
small: {
  fontSize: 12,
  lineHeight: 1.6,
  fontWeight: 500,
      color: VERIFY_BRAND.muted,
  },
value: {
  fontSize: 14,
  lineHeight: 1.45,
  fontWeight: 650,
      color: VERIFY_BRAND.ink,
  },
  hash: {
    fontFamily: VERIFY_FONT,
    fontSize: 11,
    lineHeight: 1.45,
    fontWeight: 550,
    letterSpacing: "-0.006em",
    color: VERIFY_BRAND.ink,
    wordBreak: "break-all" as const,
    overflowWrap: "anywhere" as const,
    whiteSpace: "normal" as const,
  },
};

const VERIFY_SURFACE = {
  page: {
    background:
      "radial-gradient(circle at 12% 0%, rgba(11,46,39,0.05), transparent 32%), radial-gradient(circle at 92% 8%, rgba(96,66,24,0.04), transparent 28%), linear-gradient(180deg, #f6f7f4 0%, #fafbf8 48%, #f2f4f1 100%)",
  },
  card: {
    background:
      "linear-gradient(180deg, rgba(255,255,255,0.96) 0%, rgba(248,250,248,0.92) 100%)",
    border: `1px solid ${VERIFY_BRAND.line}`,
    borderRadius: 22,
    boxShadow: "0 18px 42px rgba(16,32,29,0.065)",
    backdropFilter: "blur(8px)",
  },
  cardStrong: {
    background:
      "linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(248,250,248,0.94) 100%)",
    border: `1px solid ${VERIFY_BRAND.line}`,
    borderRadius: 22,
    boxShadow: "0 20px 48px rgba(16,32,29,0.075)",
    backdropFilter: "blur(8px)",
  },
  inset: {
    background:
      "linear-gradient(180deg, rgba(255,255,255,0.88) 0%, rgba(246,248,246,0.82) 100%)",
    border: `1px solid ${VERIFY_BRAND.softLine}`,
    borderRadius: 16,
  },
};

const BRONZE_RAIL_STYLE: CSSProperties = {
  border: `1px solid ${VERIFY_BRAND.line}`,
  borderLeft: `5px solid ${VERIFY_BRAND.bronze}`,
  background: VERIFY_BRAND.bronzeSoft,
  borderRadius: 18,
};

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
  // Canonical OTS states surfaced by this page: PENDING, ANCHORED, FAILED, UNAVAILABLE.
  return String(raw).trim().toUpperCase();
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

function describeEvidenceAssetRole(item: VerifyEvidenceAsset): string {
  const roleLabel =
    item.artifactRoleLabel ??
    (item.artifactRole ? getReviewerArtifactRoleLabel(item.artifactRole) : null) ??
    (item.isPrimary ? "Primary evidence" : "Supporting evidence");
  const checklistLabel =
    typeof item.checklistStepLabel === "string" && item.checklistStepLabel.trim()
      ? item.checklistStepLabel.trim()
      : null;

  return checklistLabel ? `${roleLabel} • ${checklistLabel}` : roleLabel;
}

function buildTsaDetails(data: VerifyResponse) {
  const tsa = data.storageAndTimestamping?.tsa ?? data.tsa ?? data.timestamp ?? null;

  return {
    status: extractTimestampStatus(data),
    provider: firstNonEmpty(tsa?.provider, data.tsaProvider),
    genTimeUtc: firstNonEmpty(tsa?.genTimeUtc, data.tsaGenTimeUtc),
    tokenBase64: firstNonEmpty(
  (tsa as VerifyTsa & { tokenBase64?: string | null })?.tokenBase64,
  data.tsaTokenBase64
),
messageImprint: firstNonEmpty(
  tsa?.messageImprint,
  data.tsaMessageImprint
),
    inputDigestHex: firstNonEmpty(
      tsa?.inputDigestHex,
      data.technicalMaterials?.tsaInputDigestHex
    ),
    inputKind: firstNonEmpty(
      tsa?.inputKind,
      data.technicalMaterials?.tsaInputKind
    ),
    legacyMode:
      typeof tsa?.legacyMode === "boolean"
        ? tsa.legacyMode
        : typeof data.technicalMaterials?.legacyMode === "boolean"
          ? data.technicalMaterials.legacyMode
          : null,
    url: firstNonEmpty(tsa?.url, data.tsaUrl),
    serialNumber: firstNonEmpty(tsa?.serialNumber, data.tsaSerialNumber),
    digestCheckConclusive:
  typeof tsa?.digestCheckConclusive === "boolean"
    ? tsa.digestCheckConclusive
    : null,
timestampAvailable:
  typeof tsa?.timestampAvailable === "boolean"
    ? tsa.timestampAvailable
    : null,
    hashAlgorithm: firstNonEmpty(tsa?.hashAlgorithm, data.tsaHashAlgorithm),
    failureReason: firstNonEmpty(tsa?.failureReason, data.tsaFailureReason),
    digestMatchesTimestampInput:
      typeof tsa?.digestMatchesTimestampInput === "boolean"
        ? tsa.digestMatchesTimestampInput
        : null,
    digestMatchesFileHash:
      typeof tsa?.digestMatchesFileHash === "boolean"
        ? tsa.digestMatchesFileHash
        : null,
    timestampedDigestLabel: firstNonEmpty(tsa?.timestampedDigestLabel),
    timestampedDigestNote: firstNonEmpty(tsa?.timestampedDigestNote),
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

function describeSnapshotSource(source?: string | null): string {
  switch (source) {
    case "REPORT_SNAPSHOT":
      return "Report snapshot";
    case "VERIFICATION_PACKAGE_SNAPSHOT":
      return "Verification package snapshot";
    case "LIVE_SHARED_FALLBACK":
      return "Live fallback (no fixed snapshot)";
    default:
      return "Snapshot source not recorded";
  }
}

function formatSignatureStatus(status?: string | null): string {
  const normalized = typeof status === "string" ? status.trim().toUpperCase() : "";

  switch (normalized) {
    case "SIGNED":
      return "Signed";
    case "SIGNING_UNAVAILABLE":
      return "Signing unavailable";
    case "FAILED":
      return "Signing failed";
    case "PENDING":
      return "Signing pending";
    default:
      return normalized ? normalized.replace(/_/g, " ") : "Not recorded";
  }
}

function buildVerificationPackageIntegrity(params: {
  serverIntegrity?: Partial<VerificationPackageIntegrity> | null;
  version: string | null;
  generatedAtUtc: string | null;
  forensicEventCount: number;
  accessEventCount: number;
}): VerificationPackageIntegrity {
  const server = params.serverIntegrity ?? null;
  const available = Boolean(server?.available ?? params.version);

  return {
    available,
    version: server?.version != null ? String(server.version) : params.version,
    generatedAtUtc: server?.generatedAtUtc ?? params.generatedAtUtc,
    packageType: server?.packageType ?? null,

    manifestPresent: server?.manifestPresent === true,
    signedManifestPresent: server?.signedManifestPresent === true,
    manifestDigestPresent: server?.manifestDigestPresent === true,
    checksumIndexPresent: server?.checksumIndexPresent === true,
    offlineVerifierIncluded: server?.offlineVerifierIncluded === true,
    auditExportIncluded: server?.auditExportIncluded === true,

    custodyExportIncluded:
      server?.custodyExportIncluded === true || params.forensicEventCount > 0,

    accessExportIncluded:
      server?.accessExportIncluded === true || params.accessEventCount > 0,
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
  muted = false,
}: {
  label: string;
  tone?: "success" | "neutral" | "info" | "warning";
  muted?: boolean;
}) {
  const effectiveTone = muted && tone === "success" ? "info" : tone;

  const palette =
    effectiveTone === "success"
      ? {
          bg: VERIFY_BRAND.successSoft,
          color: VERIFY_BRAND.success,
          border: "rgba(33,117,93,0.25)",
        }
      : effectiveTone === "info"
        ? {
            bg: "rgba(11,46,39,0.07)",
            color: VERIFY_BRAND.accent,
            border: "rgba(11,46,39,0.18)",
          }
        : effectiveTone === "warning"
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
        opacity: muted && tone === "success" ? 0.78 : 1,
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
  forensicMode = false,
}: {
  label: string;
  value: string;
  addToast: ToastFn;
  copyMessage: string;
  subtitle?: string;
  forensicMode?: boolean;
}) {
const [expanded, setExpanded] = useState(false);
const long = value.length > 180;
const shouldExpand = forensicMode || expanded;
const shown = shouldExpand || !long ? value : `${value.slice(0, 180)}...`;

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

{long && !forensicMode ? (
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
  height: 72,
  display: "flex",
  flexDirection: "column",
  justifyContent: "space-between",
}}    >
      {label}
    </button>
  );
}

function stripShortHashLines(value?: string | null): string | null {
  if (!value) return null;

  const cleaned = value
    .split(/\s*•\s*|\n/g)
    .map((part) => part.trim())
    .filter((part) => {
      const lower = part.toLowerCase();
      if (lower.startsWith("event hash:")) return false;
      if (lower.startsWith("prev hash:")) return false;
      if (lower.startsWith("previous hash:")) return false;
      return true;
    })
    .join(" • ")
    .trim();

  return cleaned || null;
}

function HashLine({
  label,
  value,
}: {
  label: string;
  value?: string | null;
}) {
  if (!value) return null;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "92px minmax(0, 1fr)",
        gap: 10,
        alignItems: "start",
      }}
    >
      <div
        style={{
          ...VERIFY_TYPO.kicker,
          fontSize: 9,
          letterSpacing: "0.07em",
          color: "rgba(11,46,39,0.62)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: VERIFY_FONT,
          fontSize: 11,
          lineHeight: 1.45,
          fontWeight: 700,
          color: VERIFY_BRAND.ink,
          wordBreak: "break-all",
          overflowWrap: "anywhere",
          whiteSpace: "normal",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function TimelinePanel({
  title,
  subtitle,
  note,
  countLabel,
  countTone,
  events,
  emptyTitle,
  emptyBody,
  accent,
  forensicMode = false,
}: {
  title: string;
  subtitle: string;
  note?: string | null;
  countLabel?: string | null;
  countTone: "info" | "neutral";
  events: TimelineItem[];
  emptyTitle: string;
  emptyBody: string;
  forensicMode?: boolean;
  accent: {
    dot: string;
    dotBorder: string;
    line: string;
  };
}) {
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 14,
          flexWrap: "wrap",
        }}
      >
        <div style={{ minWidth: 0, flex: "1 1 620px" }}>
          <h3 style={{ margin: 0, ...VERIFY_TYPO.h3 }}>
            {title}
          </h3>
          <div
            style={{
              marginTop: 6,
              ...VERIFY_TYPO.small,
              maxWidth: 860,
            }}
          >
            {subtitle}
          </div>
          {note ? (
            <div
              style={{
                marginTop: 8,
                ...VERIFY_TYPO.small,
                maxWidth: 860,
                color: VERIFY_BRAND.warning,
              }}
            >
              {note}
            </div>
          ) : null}
        </div>

        <Badge
          label={countLabel ?? `${events.length} Event${events.length === 1 ? "" : "s"}`}
          tone={countTone}
        />
      </div>

      {events.length === 0 ? (
        <div
          style={{
            ...VERIFY_SURFACE.inset,
            padding: 16,
            display: "grid",
            gap: 6,
          }}
        >
          <div style={{ ...VERIFY_TYPO.value, fontSize: 13 }}>
            {emptyTitle}
          </div>
          <div style={{ ...VERIFY_TYPO.small, fontSize: 12.5 }}>
            {emptyBody}
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {events.map((event, idx) => {
            const cleanSummary = maskPublicEmailsInText(
              stripShortHashLines(event.payloadSummary)
            );

            return (
              <div
                key={`${event.sequence ?? idx}-${event.eventType}-${event.atUtc ?? "na"}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: "24px minmax(0, 1fr)",
                  gap: 12,
                  alignItems: "stretch",
                }}
              >
                <div
                  style={{
                    position: "relative",
                    display: "flex",
                    justifyContent: "center",
                  }}
                >
                  <div
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: 999,
                      background: accent.dot,
                      border: `3px solid ${accent.dotBorder}`,
                      marginTop: 16,
                      zIndex: 1,
                    }}
                  />
                  {idx !== events.length - 1 ? (
                    <div
                      style={{
                        position: "absolute",
                        top: 30,
                        bottom: -10,
                        width: 2,
                        background: accent.line,
                      }}
                    />
                  ) : null}
                </div>

                <div
                  style={{
                    border: `1px solid ${VERIFY_BRAND.softLine}`,
background:
  "linear-gradient(180deg, rgba(255,255,255,0.96) 0%, rgba(248,250,248,0.9) 100%)",
                      borderRadius: 16,
                    padding: 14,
                    display: "grid",
                    gap: 9,
                    boxShadow: "0 10px 28px rgba(16,32,29,0.045)",
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
                    <div
                      style={{
                        fontSize: 13,
                        lineHeight: 1.25,
                        fontWeight: 900,
                        letterSpacing: "-0.012em",
                        color: VERIFY_BRAND.ink,
                        minWidth: 0,
                        flex: "1 1 260px",
                      }}
                    >
                      {normalizeEventLabel(event.eventType)}
                    </div>

                    <div
                      style={{
                        padding: "5px 9px",
                        borderRadius: 999,
                        border: `1px solid ${VERIFY_BRAND.softLine}`,
                        background: "rgba(11,46,39,0.055)",
                        color: VERIFY_BRAND.accent,
                        fontSize: 10.5,
                        lineHeight: 1,
                        fontWeight: 900,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {formatDateTime(event.atUtc)}
                    </div>
                  </div>

                  <div
                    style={{
                      ...VERIFY_TYPO.small,
                      fontSize: 12.5,
                      color: VERIFY_BRAND.muted,
                      wordBreak: "break-word",
                      overflowWrap: "anywhere",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {cleanSummary ?? "No additional event summary provided."}
                  </div>

{forensicMode && (event.prevEventHash || event.eventHash) ? (
                      <div
                      style={{
                        marginTop: 4,
                        padding: 12,
                        borderRadius: 14,
                        border: `1px solid ${VERIFY_BRAND.softLine}`,
                        background: "rgba(248,250,248,0.72)",
                        display: "grid",
                        gap: 8,
                      }}
                    >
                      <HashLine label="Prev Hash" value={event.prevEventHash} />
                      <HashLine label="Event Hash" value={event.eventHash} />
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

function normalizeVerifyTrustDecision(
  decision: VerifyTrustDecision
): VerifyTrustDecision & {
  presentationState:
    | "VERIFIED_FINALIZED"
    | "VERIFIED_PENDING_PUBLICATION"
    | "VERIFIED_WITH_DEGRADED_SIGNALS"
    | "PARTIALLY_VERIFIED"
    | "FAILED_VERIFICATION"
    | "REVIEW_REQUIRED";
} {
  return {
    ...decision,
    presentationState:
      decision.presentationState ??
      (decision.verdict === "PARTIALLY_VERIFIED"
        ? "PARTIALLY_VERIFIED"
        : decision.verdict === "REVIEW_REQUIRED"
          ? "REVIEW_REQUIRED"
          : "VERIFIED_WITH_DEGRADED_SIGNALS"),
  };
}

function buildVerificationVerdict(input: VerificationSignalInput): VerificationVerdict {
  const coreSignal = input.trustDecision?.signals.find(
    (signal) => signal.key === "core_integrity"
  );
  const publicAnchoringSignal = input.trustDecision?.signals.find(
    (signal) => signal.key === "public_anchoring"
  );
  const verdictCode = input.trustDecision?.verdict ?? null;
  const presentationState = input.trustDecision?.presentationState ?? null;
  const coreExplicitlyVerified = coreSignal?.status === "passed";
  const publicAnchoringPending =
    publicAnchoringSignal?.status === "pending" ||
    publicAnchoringSignal?.status === "partial" ||
    presentationState === "VERIFIED_PENDING_PUBLICATION";
  const timestampMismatch =
    isPositiveTsa(input.tsaStatus) && input.timestampDigestMatches === false;
  const timestampUnavailable =
    (isFailedTsa(input.tsaStatus) || !String(input.tsaStatus ?? "").trim()) &&
    input.timestampDigestMatches !== true;

  const failedSignals = [
    input.canonicalHashMatches === false,
    input.signatureValid === false,
    input.custodyChainValid === false,
    timestampMismatch,
    input.otsHashMatches === false,
  ].filter(Boolean).length;

  const passedSignals = [
    input.canonicalHashMatches === true,
    input.signatureValid === true,
    input.custodyChainValid === true,
    input.timestampDigestMatches === true,
    input.otsHashMatches === true,
    input.storageVerified === true || input.immutableStorage === true,
  ].filter(Boolean).length;

  const knownSignals = [
    input.canonicalHashMatches !== null,
    input.signatureValid !== null,
    input.custodyChainValid !== null,
    input.timestampDigestMatches !== null,
    input.otsHashMatches !== null,
    input.storageVerified !== null || input.immutableStorage !== null,
  ].filter(Boolean).length;

  const confidenceScore =
    knownSignals === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            100,
            Math.round((passedSignals / Math.max(knownSignals, 1)) * 100)
          )
        );

  if (
    verdictCode === "REVIEW_REQUIRED" ||
    input.overallIntegrity === false ||
    failedSignals > 0
  ) {
    return {
      status: "review_required",
      title: "Final Verification Verdict",
      label: "Review Required",
      riskLevel: "High",
      actionRequired:
        "Do not rely on this record as a finalized integrity result until the failed integrity signal is reviewed by a qualified technical or forensic reviewer.",
      legalStatement:
        "One or more returned integrity checks did not pass. This page supports review of the recorded system state, but it must not be interpreted as conclusive proof of authenticity, authorship, factual truth, legal admissibility, or absence of tampering.",
      reviewerSummary:
        "The record contains usable verification materials, but at least one integrity layer requires manual review before this evidence should be relied upon without qualification.",
      confidenceScore,
      tone: "danger",
    };
  }

  if (coreExplicitlyVerified && failedSignals === 0 && !timestampUnavailable) {
    return {
      status: "verified",
      title: "Final Verification Verdict",
      // Phase 2 closure — prefer the canonical verdict label from the
      // shared trust-decision module. The previous hardcoded strings
      // duplicated `decision.verdictLabel` from packages/shared, which
      // could drift if the canonical wording ever changed. The fallback
      // only runs when no trustDecision was provided (legacy callers).
      label: input.trustDecision
        ? getTrustDecisionLabel(input.trustDecision)
        : publicAnchoringPending
          ? "Recorded integrity verified; publication pending"
          : "Recorded integrity verified",
      riskLevel: publicAnchoringPending ? "Medium" : "Low",
      actionRequired:
        publicAnchoringPending
          ? "Reviewers may rely on the recorded integrity state, while still separately assessing authorship, factual context, relevance, and legal admissibility. Independent public anchoring is not finalized yet and should be rechecked later if public anchoring matters to the review."
          : "Reviewers may rely on the recorded integrity state, while still separately assessing authorship, factual context, relevance, and legal admissibility.",
      legalStatement:
        publicAnchoringPending
          ? "The available cryptographic, custody, timestamping, and storage signals returned in this verification response support the recorded integrity state. Independent public anchoring is still pending and must not be treated as finalized publication. This does not independently prove factual truth, authorship, legal admissibility, or the real-world meaning of the evidence content."
          : "The available cryptographic, custody, timestamping, and storage signals returned in this verification response support the recorded integrity state. This does not independently prove factual truth, authorship, legal admissibility, or the real-world meaning of the evidence content.",
      reviewerSummary:
        publicAnchoringPending
          ? "The available technical verification signals support the recorded integrity state, while independent public anchoring remains pending."
          : "The available technical verification signals support the integrity of the recorded evidence state.",
      confidenceScore,
      tone: publicAnchoringPending ? "warning" : "success",
    };
  }

  if (
    verdictCode === "PARTIALLY_VERIFIED" ||
    passedSignals > 0 ||
    knownSignals > 0
  ) {
    return {
      status: "partial",
      title: "Final Verification Verdict",
      label: !coreExplicitlyVerified
        ? "Conditional trust state"
        : timestampUnavailable
        ? "Integrity verified; trusted timestamp unavailable"
        : "Conditional trust state",
      riskLevel: "Medium",
      actionRequired:
        !coreExplicitlyVerified
          ? "Core integrity materials are recorded, but the recorded-integrity state has not been finalized as explicitly verified. Use this record with limitations until that state is explicit."
          : timestampUnavailable
          ? "Core integrity checks are available, but the trusted timestamp provider did not return a usable token. Review timestamp availability before treating the evidence as timestamp-verified."
          : "Use this record with caution. Review missing, pending, or unavailable verification layers before treating the evidence as finalized.",
      legalStatement:
        !coreExplicitlyVerified
          ? "Core integrity materials are present, but the recorded-integrity state has not been finalized as explicitly verified. This response should not be summarized as plain verified."
          : timestampUnavailable
          ? "Available integrity checks support the recorded evidence state, but trusted timestamp verification is unavailable. No timestamp digest match or mismatch can be concluded from this response."
          : "Some verification materials were returned, but the response did not provide a complete positive integrity conclusion for every technical layer. The record should be treated as a conditional trust state until missing or pending layers are resolved.",
      reviewerSummary:
        !coreExplicitlyVerified
          ? "The record contains strong supporting verification materials, but the core recorded-integrity state remains partial rather than explicitly verified."
          : timestampUnavailable
          ? "The record contains supporting verification materials, but the trusted timestamp layer is unavailable and should not be described as a digest mismatch."
          : "The record contains supporting verification materials, but the verification result is incomplete or not fully conclusive.",
      confidenceScore,
      tone: "warning",
    };
  }

  return {
    status: "unavailable",
    title: "Final Verification Verdict",
    label: "Verification Unavailable",
    riskLevel: "Unknown",
    actionRequired:
      "Do not rely on this record as verified until verification materials are available and reviewed.",
    legalStatement:
      "The verification response did not expose enough technical material to support a complete integrity conclusion.",
    reviewerSummary:
      "The system returned insufficient verification material for a reliable integrity conclusion.",
    confidenceScore,
    tone: "neutral",
  };
}

function buildUnavailableTrustDecision(): VerifyTrustDecision {
  return {
    verdict: "REVIEW_REQUIRED",
    verdictLabel: "Verification decision unavailable",
    shortLabel: "Unavailable",
    score: 0,
    scoreLabel: "0/100",
    tone: "neutral",
    presentationState: "REVIEW_REQUIRED",
    presentationTone: "neutral",
    publicationState: "unavailable",
    confidenceLabel: "Unavailable",
    publicationStatusLabel: "Public anchoring unavailable",
    relianceLevel: "limited",
    degradedButUsable: false,
    summary:
      "Verification decision unavailable. No shared trust-decision snapshot was returned by the verification response.",
    primaryReason:
      "The verification response did not include the canonical trust-decision object.",
    reviewerAction:
      "Refresh the verification response or regenerate the report/package so the shared trust-decision snapshot is available.",
    passedSignals: 0,
    degradedSignals: 0,
    failedSignals: 0,
    signals: [],
  };
}

function buildLegacyTrustDecisionFallback(params: {
  verificationStatus?: string | null;
  recordedIntegrityVerifiedAtUtc?: string | null;
  fileSha256?: string | null;
  fingerprintHash?: string | null;
  signatureBase64?: string | null;
  signingKeyId?: string | null;
  publicKeyPem?: string | null;
  tsaStatus?: string | null;
  tsaFailureReason?: string | null;
  otsStatus?: string | null;
  otsFailureReason?: string | null;
  storageProtection?: StorageProtection | null;
  identityLevelSnapshot?: string | null;
  submittedByEmail?: string | null;
  submittedByAuthProvider?: string | null;
  verificationPackageVersion?: number | string | null;
  verificationPackageGeneratedAtUtc?: string | null;
  anchor?: VerifyAnchor;
  custodyEvents: TimelineItem[];
}): VerifyTrustDecision {
  return buildEvidenceTrustDecision({
    evidence: {
      verificationStatus: params.verificationStatus ?? null,
      recordedIntegrityVerifiedAtUtc:
        params.recordedIntegrityVerifiedAtUtc ?? null,
      fileSha256: params.fileSha256 ?? null,
      fingerprintHash: params.fingerprintHash ?? null,
      signatureBase64: params.signatureBase64 ?? null,
      signingKeyId: params.signingKeyId ?? null,
      publicKeyPem: params.publicKeyPem ?? null,
      tsaStatus: params.tsaStatus ?? null,
      tsaFailureReason: params.tsaFailureReason ?? null,
      otsStatus: params.otsStatus ?? null,
      otsFailureReason: params.otsFailureReason ?? null,
      storageImmutable: params.storageProtection?.immutable ?? null,
      storageObjectLockMode: params.storageProtection?.mode ?? null,
      storageObjectLockRetainUntilUtc: params.storageProtection?.retainUntil ?? null,
      identityLevelSnapshot: params.identityLevelSnapshot ?? null,
      submittedByEmail: params.submittedByEmail ?? null,
      submittedByAuthProvider: params.submittedByAuthProvider ?? null,
      verificationPackageVersion: params.verificationPackageVersion ?? null,
      verificationPackageGeneratedAtUtc:
        params.verificationPackageGeneratedAtUtc ?? null,
      anchor: params.anchor
        ? {
            configured:
              typeof params.anchor.configured === "boolean"
                ? params.anchor.configured
                : null,
            provider: params.anchor.provider ?? null,
            anchoredAtUtc: params.anchor.anchoredAtUtc ?? null,
            transactionId: params.anchor.transactionId ?? null,
          }
        : null,
    },
    custodyEvents: params.custodyEvents.map((event) => ({
      eventType: event.eventType ?? null,
      category: event.category ?? null,
      eventHash: event.eventHash ?? null,
      prevEventHash: event.prevEventHash ?? null,
    })),
  });
}

function getTimestampDigestLabel(params: {
  itemCount?: number | null;
  tsaInputKind?: string | null;
}): string {
  const isMultipart =
    Number(params.itemCount ?? 0) > 1 ||
    String(params.tsaInputKind ?? "").toUpperCase() ===
      "CANONICAL_PACKAGE_SHA256";

  return isMultipart
    ? "Timestamped Digest / Canonical Package Digest"
    : "Timestamped Digest / Original File SHA-256";
}

function isPositiveTsa(status?: string | null): boolean {
  const s = String(status ?? "").toUpperCase();
  return ["STAMPED", "GRANTED", "VERIFIED", "SUCCEEDED"].includes(s);
}

function isFailedTsa(status?: string | null): boolean {
  const s = String(status ?? "").toUpperCase();
  return ["FAILED", "UNAVAILABLE", "ERROR"].includes(s);
}

function buildReviewerActions(params: {
  verdict: VerificationVerdict;
  canonicalHashMatches: boolean | null;
  signatureValid: boolean | null;
  custodyChainValid: boolean | null;
  timestampDigestMatches: boolean | null;
  otsHashMatches: boolean | null;
  storageProtection: StorageProtection | null;
  tsaStatus: string | null;
}): string[] {
  const actions: string[] = [];

  if (params.verdict.status === "review_required") {
    actions.push(
      "Treat this record as requiring technical review before relying on it as a complete integrity verification result."
    );
  }

  if (params.canonicalHashMatches === false) {
    actions.push(
      "Compare the displayed evidence digest against the original evidence material and confirm whether the preserved content differs from the recorded fingerprint."
    );
  }

  if (params.signatureValid === false) {
    actions.push(
      "Review the digital signature, signing key identifier, key version, and public key material before accepting the signature layer."
    );
  }

  if (params.custodyChainValid === false) {
    actions.push(
      "Inspect the custody chain continuity. A custody-chain mismatch may indicate missing, altered, or inconsistent event linkage."
    );
  }

  if (
    isPositiveTsa(params.tsaStatus) &&
    params.timestampDigestMatches === false
  ) {
    actions.push(
      "Review the trusted timestamp mismatch. A timestamp digest mismatch means the timestamped digest does not match the recorded timestamp input digest."
    );
  }

  if (isFailedTsa(params.tsaStatus)) {
    actions.push(
      "Review timestamp availability. The timestamp provider did not return a usable token, so no timestamp digest match or mismatch can be concluded."
    );
  }

  if (params.otsHashMatches === false) {
    actions.push(
      "Review the OpenTimestamps proof and its linked hash. The OTS proof should be checked against the recorded fingerprint/hash material."
    );
  }

  if (
    params.storageProtection?.immutable !== true &&
    params.storageProtection?.verified !== true
  ) {
    actions.push(
      "Confirm storage immutability or retention status before relying on the storage-protection layer."
    );
  }

  if (actions.length === 0) {
    actions.push(
      "Review the displayed record identity, evidence hash, custody chain, timestamping materials, and access activity before external legal or operational reliance."
    );
  }

  return actions;
}

function buildMismatchExplanations(params: {
  canonicalHashMatches: boolean | null;
  signatureValid: boolean | null;
  custodyChainValid: boolean | null;
  timestampDigestMatches: boolean | null;
  otsHashMatches: boolean | null;
  custodyChainFailureReason: string | null;
  tsaStatus: string | null;
}): Array<{ title: string; body: string; severity: "danger" | "warning" }> {
  const explanations: Array<{
    title: string;
    body: string;
    severity: "danger" | "warning";
  }> = [];

  if (params.canonicalHashMatches === false) {
    explanations.push({
      title: "Fingerprint mismatch",
      severity: "danger",
      body:
        "The canonical fingerprint check did not match the recorded evidence state. This is a critical integrity signal and should be reviewed before relying on the record.",
    });
  }

  if (params.signatureValid === false) {
    explanations.push({
      title: "Digital signature invalid",
      severity: "danger",
      body:
        "The recorded digital signature did not validate against the available verification material. This may affect confidence in the signed record state.",
    });
  }

  if (params.custodyChainValid === false) {
    explanations.push({
      title: "Custody-chain continuity issue",
      severity: "danger",
      body:
        params.custodyChainFailureReason ??
        "The custody chain reported an integrity issue. Review previous-event hashes and event hashes to determine where continuity failed.",
    });
  }

  if (
    isPositiveTsa(params.tsaStatus) &&
    params.timestampDigestMatches === false
  ) {
    explanations.push({
      title: "Trusted timestamp digest mismatch",
      severity: "warning",
      body:
        "The trusted timestamp digest does not match the recorded timestamp input digest. This does not automatically prove the content is false, but it means the timestamp layer cannot be treated as clean without review.",
    });
  }

  if (params.otsHashMatches === false) {
    explanations.push({
      title: "OpenTimestamps hash mismatch",
      severity: "warning",
      body:
        "The OpenTimestamps hash does not match the recorded fingerprint hash. The OTS proof should be manually checked against the expected digest.",
    });
  }

  return explanations;
}

/**
 * Phase 2 closure — render the canonical OutputContext under the verdict
 * card. Reviewers see at a glance whether the verdict is a sealed
 * snapshot (REPORT / VERIFICATION_PACKAGE) or live, the snapshot's
 * generated-at timestamp, when the live view was observed, and which
 * materials may have advanced since the snapshot was sealed (live
 * delta). Pure additive surface; no existing element changed.
 */
function OutputContextBadge({
  outputContext,
}: {
  outputContext: NonNullable<VerifyResponse["outputContext"]>;
}) {
  const sourceLabel: Record<string, string> = {
    REPORT_SNAPSHOT: "Report snapshot",
    VERIFICATION_PACKAGE_SNAPSHOT: "Verification package snapshot",
    PUBLIC_VERIFY_LIVE: "Live (recomputed at request time)",
    INTERNAL_OPERATIONAL_PROJECTION: "Operational projection",
    OFFLINE_PACKAGE_REVIEW: "Offline package review",
  };
  const friendlySource =
    sourceLabel[outputContext.outputType] ?? outputContext.outputType;
  const snapAt = outputContext.snapshotGeneratedAtUtc
    ? new Date(outputContext.snapshotGeneratedAtUtc).toISOString()
    : null;
  const liveAt = outputContext.liveObservedAtUtc
    ? new Date(outputContext.liveObservedAtUtc).toISOString()
    : null;
  const deltas = outputContext.liveDeltaMaterials ?? [];
  return (
    <div
      data-testid="output-context-badge"
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 12,
        alignItems: "center",
        padding: "10px 14px",
        borderRadius: 12,
        border: `1px solid ${VERIFY_BRAND.line}`,
        background: "rgba(255,255,255,0.62)",
        fontSize: 12,
        color: VERIFY_BRAND.ink,
      }}
    >
      <span
        style={{
          ...VERIFY_TYPO.kicker,
          fontSize: 10,
          padding: "3px 8px",
          borderRadius: 999,
          background: outputContext.isSnapshotOutput
            ? "rgba(33,117,93,0.10)"
            : "rgba(124,90,255,0.10)",
          color: outputContext.isSnapshotOutput
            ? VERIFY_BRAND.success
            : "#5a3fcc",
        }}
      >
        Verdict source: {friendlySource}
      </span>
      {snapAt ? (
        <span>
          <strong>Snapshot generated:</strong> {snapAt}
        </span>
      ) : null}
      {outputContext.isLiveOutput && liveAt ? (
        <span>
          <strong>Live observed:</strong> {liveAt}
        </span>
      ) : null}
      {deltas.length > 0 ? (
        <span style={{ color: VERIFY_BRAND.muted }}>
          <strong>May have advanced since snapshot:</strong>{" "}
          {deltas.join(", ")}
        </span>
      ) : null}
      {outputContext.legalBoundary ? (
        <span
          data-testid="output-context-legal-boundary"
          style={{
            flex: "1 1 100%",
            marginTop: 4,
            paddingTop: 8,
            borderTop: `1px dashed ${VERIFY_BRAND.line}`,
            color: VERIFY_BRAND.muted,
            fontSize: 11.5,
            lineHeight: 1.5,
          }}
        >
          {outputContext.legalBoundary}
        </span>
      ) : null}
    </div>
  );
}

function TrustDecisionCard({
  decision,
}: {
  decision: VerifyTrustDecision;
}) {
  const normalizedDecision = normalizeVerifyTrustDecision(decision);
  const relianceLabel = getTrustDecisionConfidenceLabel(decision);
  const trustNarrative = getTrustNarrative(normalizedDecision);
  const decisionTone = getTrustDecisionPresentationTone(normalizedDecision);
  const palette =
    decisionTone === "success"
      ? {
          rail: VERIFY_BRAND.success,
          bg: "linear-gradient(180deg, rgba(33,117,93,0.10), rgba(255,255,255,0.78))",
          border: "rgba(33,117,93,0.30)",
        }
      : decisionTone === "danger"
        ? {
            rail: VERIFY_BRAND.danger,
            bg: "linear-gradient(180deg, rgba(181,71,56,0.10), rgba(255,255,255,0.78))",
            border: "rgba(181,71,56,0.30)",
          }
        : {
            rail: VERIFY_BRAND.warning,
            bg: "linear-gradient(180deg, rgba(138,106,47,0.11), rgba(255,255,255,0.78))",
            border: "rgba(138,106,47,0.30)",
          };

  return (
    <div
      style={{
        border: `1px solid ${palette.border}`,
        borderLeft: `7px solid ${palette.rail}`,
        background: palette.bg,
        borderRadius: 24,
        padding: 24,
        display: "grid",
        gap: 18,
        boxShadow: "0 18px 42px rgba(16,32,29,0.08)",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 210px",
          gap: 18,
          alignItems: "stretch",
        }}
      >
        <div>
          <div style={{ ...VERIFY_TYPO.kicker, marginBottom: 8 }}>
            Overall Trust Decision
          </div>

          <div
            style={{
              fontSize: "clamp(1.45rem, 2.3vw, 2.15rem)",
              lineHeight: 1.1,
              fontWeight: 950,
              letterSpacing: "-0.035em",
              color: VERIFY_BRAND.ink,
              marginBottom: 10,
            }}
          >
            {getTrustDecisionLabel(decision)}
          </div>

          <div
            style={{
              ...VERIFY_TYPO.body,
              fontSize: 14.5,
              color: VERIFY_BRAND.ink,
              maxWidth: 900,
            }}
          >
            {trustNarrative}
          </div>
        </div>

        <div
          style={{
            border: `1px solid ${VERIFY_BRAND.line}`,
            background: "rgba(255,255,255,0.58)",
            borderRadius: 18,
            padding: 16,
            textAlign: "center",
            display: "grid",
            alignContent: "center",
            gap: 8,
          }}
        >
          <div
            style={{
              ...VERIFY_TYPO.kicker,
              fontSize: 10.5,
              color: VERIFY_BRAND.subtle,
            }}
          >
            Technical Confidence
          </div>

          <div
            style={{
              fontSize: 24,
              lineHeight: 1.1,
              fontWeight: 950,
              color: VERIFY_BRAND.accent,
            }}
          >
            {relianceLabel}
          </div>

          <div style={{ ...VERIFY_TYPO.kicker, fontSize: 10 }}>
            Verification Classification
          </div>

          <div
            style={{
              fontSize: 12,
              fontWeight: 900,
              color: VERIFY_BRAND.muted,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            {getTrustDecisionLabel(decision)}
          </div>
        </div>
      </div>

      <div
        style={{
          border: `1px solid ${VERIFY_BRAND.softLine}`,
          background: "rgba(255,255,255,0.44)",
          borderRadius: 18,
          padding: 16,
          display: "grid",
          gap: 8,
        }}
      >
        <div style={{ ...VERIFY_TYPO.kicker, fontSize: 10.5 }}>
          Decision Basis
        </div>
        <div style={{ ...VERIFY_TYPO.small, color: VERIFY_BRAND.ink }}>
          {decision.primaryReason}
        </div>
        <div style={{ ...VERIFY_TYPO.small, color: VERIFY_BRAND.ink }}>
          Publication posture:{" "}
          {decision.publicationStatusLabel ?? "Public anchoring status requires review"}.
        </div>
        <div
          style={{
            ...VERIFY_TYPO.small,
            color: VERIFY_BRAND.ink,
            fontWeight: 850,
          }}
        >
          {decision.reviewerAction}
        </div>
      </div>
    </div>
  );
}

function TrustSignalGrid({
  signals,
}: {
  signals: VerifyTrustSignal[];
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
        gap: 14,
      }}
    >
      {signals.map((signal) => {
        const color =
          signal.tone === "success"
            ? VERIFY_BRAND.success
            : signal.tone === "danger"
              ? VERIFY_BRAND.danger
              : signal.tone === "warning"
                ? VERIFY_BRAND.warning
                : VERIFY_BRAND.accent;

        return (
          <div
            key={signal.key}
            style={{
              border: `1px solid ${VERIFY_BRAND.line}`,
              borderLeft: `5px solid ${color}`,
              background: "rgba(255,255,255,0.64)",
              borderRadius: 18,
              padding: 16,
              display: "grid",
              gap: 9,
              minHeight: 150,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                alignItems: "flex-start",
              }}
            >
              <div style={{ ...VERIFY_TYPO.kicker, fontSize: 10.5 }}>
                {signal.label}
              </div>

              <div
                style={{
                  color,
                  fontSize: 12,
                  fontWeight: 950,
                  whiteSpace: "nowrap",
                }}
              >
                {getTrustSignalPresentationLabel(signal)}
              </div>
            </div>

            <div
              style={{
                ...VERIFY_TYPO.value,
                fontSize: 14,
                color,
              }}
            >
              {signal.summary}
            </div>

            <div style={{ ...VERIFY_TYPO.small, fontSize: 12.5 }}>
              {signal.detail}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function VerificationPackageIntegrityCard({
  integrity,
}: {
  integrity: VerificationPackageIntegrity;
}) {
  const complete =
    integrity.available &&
    integrity.manifestPresent &&
    integrity.signedManifestPresent &&
    integrity.checksumIndexPresent &&
    integrity.offlineVerifierIncluded &&
    integrity.auditExportIncluded;

  const decisionLabel = complete
    ? "Package Integrity Complete"
    : integrity.available
      ? "Package Integrity Partial"
      : "Package Not Generated";

  const decisionTone = complete
    ? "success"
    : integrity.available
      ? "warning"
      : "neutral";

  const decisionText = complete
    ? "Independent offline verification is enabled for this evidence package."
: integrity.available
? "A verification package version exists, but this public response has not confirmed every offline package artifact."
        : "No generated verification package was exposed in this verification response.";

  const rows = [
    {
      label: "Package Manifest",
      value: integrity.manifestPresent ? "Present" : "Not available",
      tone: integrity.manifestPresent ? "success" : "neutral",
    },
{
  label: "Manifest Signature",
  value: integrity.signedManifestPresent ? "Ed25519 signature present" : "Not available",
  tone: integrity.signedManifestPresent ? "success" : "neutral",
},
    {
      label: "Checksum Index",
      value: integrity.checksumIndexPresent ? "Present" : "Not available",
      tone: integrity.checksumIndexPresent ? "success" : "neutral",
    },
    {
      label: "Offline Verifier",
      value: integrity.offlineVerifierIncluded ? "Included" : "Not available",
      tone: integrity.offlineVerifierIncluded ? "success" : "neutral",
    },
    {
      label: "Custody Export",
      value: integrity.custodyExportIncluded ? "Included" : "Not available",
      tone: integrity.custodyExportIncluded ? "success" : "neutral",
    },
    {
      label: "Access / Audit Export",
      value: integrity.accessExportIncluded || integrity.auditExportIncluded ? "Included" : "Not available",
      tone: integrity.accessExportIncluded || integrity.auditExportIncluded ? "success" : "neutral",
    },
  ] as const;

  return (
    <div
      style={{
        border: `1px solid ${
          complete
            ? "rgba(33,117,93,0.30)"
            : integrity.available
              ? "rgba(138,106,47,0.30)"
              : VERIFY_BRAND.line
        }`,
        borderLeft: `7px solid ${
          complete
            ? VERIFY_BRAND.success
            : integrity.available
              ? VERIFY_BRAND.warning
              : VERIFY_BRAND.accent
        }`,
        background: complete
          ? "linear-gradient(180deg, rgba(33,117,93,0.11), rgba(255,255,255,0.74))"
          : integrity.available
            ? "linear-gradient(180deg, rgba(138,106,47,0.11), rgba(255,255,255,0.74))"
            : "linear-gradient(180deg, rgba(11,46,39,0.06), rgba(255,255,255,0.74))",
        borderRadius: 24,
        padding: 22,
        display: "grid",
        gap: 18,
        boxShadow: "0 16px 38px rgba(16,32,29,0.07)",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: 18,
          alignItems: "stretch",
        }}
      >
        <div
          style={{
            minWidth: 0,
            wordBreak: "normal",
            overflowWrap: "break-word",
            whiteSpace: "normal",
          }}
        >
          <div style={{ ...VERIFY_TYPO.kicker, fontSize: 10.5, marginBottom: 8 }}>
            Verification Package Integrity
          </div>

          <div
            style={{
              ...VERIFY_TYPO.h3,
              fontSize: 22,
              marginBottom: 8,
              minWidth: 0,
              wordBreak: "normal",
              overflowWrap: "break-word",
              whiteSpace: "normal",
            }}
          >
            {decisionLabel}
          </div>

          <div
            style={{
              ...VERIFY_TYPO.small,
              fontSize: 13.5,
              color: VERIFY_BRAND.ink,
              maxWidth: 860,
              minWidth: 0,
              wordBreak: "normal",
              overflowWrap: "break-word",
              whiteSpace: "normal",
            }}
          >
            {decisionText}
          </div>
        </div>

        <div
          style={{
            border: `1px solid ${VERIFY_BRAND.line}`,
            background: "rgba(255,255,255,0.58)",
            borderRadius: 18,
            padding: 16,
            display: "grid",
            alignContent: "center",
            gap: 8,
            textAlign: "center",
            minWidth: 0,
            justifySelf: "stretch",
          }}
        >
          <Badge
            label={complete ? "Offline Review Enabled" : integrity.available ? "Partial Package" : "Unavailable"}
            tone={decisionTone}
          />

          <div style={{ ...VERIFY_TYPO.kicker, fontSize: 10 }}>
            Package Decision
          </div>

          {integrity.version ? (
            <div style={{ ...VERIFY_TYPO.small, fontWeight: 900 }}>
              Version v{integrity.version}
            </div>
          ) : null}
        </div>
      </div>

      <div
        style={{
          ...BRONZE_RAIL_STYLE,
          padding: 16,
          display: "grid",
          gap: 8,
        }}
      >
        <div style={{ ...VERIFY_TYPO.kicker, fontSize: 10.5 }}>
          Impact on Trust Decision
        </div>

        <div style={{ ...VERIFY_TYPO.small, fontSize: 13, color: VERIFY_BRAND.ink }}>
          {complete
            ? "The exported forensic bundle supports independent offline verification of package contents, checksums, manifest integrity, custody export, and audit/access materials."
: "Evidence integrity can still be reviewed here. Package-level offline verification should be performed from the downloaded verification package."}
        </div>

        {integrity.generatedAtUtc ? (
          <div style={{ ...VERIFY_TYPO.small, fontSize: 12.5 }}>
            Package generated at: {formatDateTime(integrity.generatedAtUtc)}
          </div>
        ) : null}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
          gap: 12,
        }}
      >
        {rows.map((row) => (
          <div
            key={row.label}
            style={{
              ...VERIFY_SURFACE.inset,
              padding: 14,
              display: "grid",
              gap: 8,
              minHeight: 84,
            }}
          >
            <div style={{ ...VERIFY_TYPO.kicker, fontSize: 10 }}>
              {row.label}
            </div>
            <Badge label={row.value} tone={row.tone} />
          </div>
        ))}
      </div>
    </div>
  );
}

function LegalWarningBlock({
  verdict,
}: {
  verdict: VerificationVerdict;
}) {
  return (
    <div
      style={{
        border: `1px solid ${
          verdict.tone === "danger"
            ? "rgba(181,71,56,0.28)"
            : "rgba(138,106,47,0.30)"
        }`,
        borderLeft: `6px solid ${
          verdict.tone === "danger" ? VERIFY_BRAND.danger : VERIFY_BRAND.bronze
        }`,
        background:
          verdict.tone === "danger"
            ? "linear-gradient(180deg, rgba(181,71,56,0.10), rgba(255,255,255,0.68))"
            : "linear-gradient(180deg, rgba(138,106,47,0.11), rgba(255,255,255,0.68))",
        borderRadius: 20,
        padding: 18,
        display: "grid",
        gap: 8,
      }}
    >
      <div
        style={{
          ...VERIFY_TYPO.kicker,
          fontSize: 10.5,
          color: verdict.tone === "danger" ? VERIFY_BRAND.danger : VERIFY_BRAND.warning,
        }}
      >
        Legal Review Boundary
      </div>
      <div
        style={{
          ...VERIFY_TYPO.small,
          fontSize: 13.5,
          color: VERIFY_BRAND.ink,
        }}
      >
        {verdict.legalStatement}
      </div>
    </div>
  );
}

function ReviewerActionsBlock({
  actions,
}: {
  actions: string[];
}) {
  return (
    <div
      style={{
        border: `1px solid ${VERIFY_BRAND.line}`,
        background: "rgba(255,255,255,0.68)",
        borderRadius: 22,
        padding: 20,
        display: "grid",
        gap: 14,
        boxShadow: "0 14px 34px rgba(16,32,29,0.06)",
      }}
    >
      <div>
        <div style={{ ...VERIFY_TYPO.kicker, fontSize: 10.5, marginBottom: 6 }}>
          Recommended Reviewer Actions
        </div>
        <div style={{ ...VERIFY_TYPO.small, fontSize: 13, maxWidth: 860 }}>
          These actions help a legal, insurance, compliance, or forensic reviewer decide what must be checked before relying on this evidence record.
        </div>
      </div>

      <div style={{ display: "grid", gap: 10 }}>
        {actions.map((action, index) => (
          <div
            key={`${index}-${action}`}
            style={{
              display: "grid",
              gridTemplateColumns: "32px minmax(0, 1fr)",
              gap: 12,
              alignItems: "start",
              border: `1px solid ${VERIFY_BRAND.softLine}`,
              background: "rgba(255,255,255,0.44)",
              borderRadius: 16,
              padding: 12,
            }}
          >
            <div
              style={{
                width: 26,
                height: 26,
                borderRadius: 999,
                background: VERIFY_BRAND.accent,
                color: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 12,
                fontWeight: 950,
              }}
            >
              {index + 1}
            </div>
            <div
              style={{
                ...VERIFY_TYPO.small,
                fontSize: 13,
                color: VERIFY_BRAND.ink,
              }}
            >
              {action}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MismatchExplanationBlock({
  explanations,
}: {
  explanations: Array<{ title: string; body: string; severity: "danger" | "warning" }>;
}) {
  if (explanations.length === 0) return null;

  return (
    <div
      style={{
        border: "1px solid rgba(181,71,56,0.28)",
        background: "rgba(255,255,255,0.70)",
        borderRadius: 22,
        padding: 20,
        display: "grid",
        gap: 14,
        boxShadow: "0 14px 34px rgba(16,32,29,0.06)",
      }}
    >
      <div>
        <div
          style={{
            ...VERIFY_TYPO.kicker,
            fontSize: 10.5,
            color: VERIFY_BRAND.danger,
            marginBottom: 6,
          }}
        >
          Integrity Issue Explanation
        </div>
        <div style={{ ...VERIFY_TYPO.small, fontSize: 13 }}>
          The following issue explanations translate raw technical mismatch signals into reviewer-facing meaning.
        </div>
      </div>

      <div style={{ display: "grid", gap: 10 }}>
        {explanations.map((item) => (
          <div
            key={item.title}
            style={{
              border: `1px solid ${
                item.severity === "danger"
                  ? "rgba(181,71,56,0.28)"
                  : "rgba(138,106,47,0.30)"
              }`,
              borderLeft: `6px solid ${
                item.severity === "danger"
                  ? VERIFY_BRAND.danger
                  : VERIFY_BRAND.warning
              }`,
              background:
                item.severity === "danger"
                  ? VERIFY_BRAND.dangerSoft
                  : VERIFY_BRAND.warningSoft,
              borderRadius: 16,
              padding: 14,
              display: "grid",
              gap: 6,
            }}
          >
            <div
              style={{
                ...VERIFY_TYPO.value,
                fontSize: 14,
                color:
                  item.severity === "danger"
                    ? VERIFY_BRAND.danger
                    : VERIFY_BRAND.warning,
              }}
            >
              {item.title}
            </div>
            <div
              style={{
                ...VERIFY_TYPO.small,
                fontSize: 13,
                color: VERIFY_BRAND.ink,
              }}
            >
              {item.body}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function normalizeVerificationStatusCode(status?: string | null): string {
  return String(status ?? "").trim().toUpperCase();
}

function verificationStatusDisplayLabel(status?: string | null): string {
  const code = normalizeVerificationStatusCode(status);

  if (code === "RECORDED_INTEGRITY_VERIFIED") {
    return "Recorded integrity state verified";
  }

  if (code === "MATERIALS_AVAILABLE") {
    return "Technical materials available";
  }

  if (code === "REVIEW_REQUIRED") return "Review required";
  if (code === "FAILED") return "Verification failed";

  return code
    ? code
        .toLowerCase()
        .split("_")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ")
    : "Technical materials available";
}

function integrityStatusDisplayLabel(decision: VerifyTrustDecision): string {
  const core = decision.signals.find((signal) => signal.key === "core_integrity");

  if (core?.status === "passed") return "Recorded Integrity Verified";
  if (core?.status === "partial") return "Integrity materials recorded";
  if (core?.status === "failed") return "Integrity review required";
  if (core?.status === "missing") return "Integrity materials missing";

  return "Integrity materials recorded";
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
  const [tsaInputDigestHex, setTsaInputDigestHex] = useState<string | null>(null);
  const [tsaInputKind, setTsaInputKind] = useState<string | null>(null);
  const [tsaLegacyMode, setTsaLegacyMode] = useState<boolean | null>(null);
  const [timestampedDigestLabel, setTimestampedDigestLabel] = useState<string | null>(
    null
  );
  const [timestampedDigestNote, setTimestampedDigestNote] = useState<string | null>(
    null
  );

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

  const [anchorTransactionId, setAnchorTransactionId] =
    useState<string | null>(null);

  const [otsStatus, setOtsStatus] = useState<string | null>(null);
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
  const [captureContext, setCaptureContext] = useState<VerifyCaptureContext>(null);
  // Phase 31.12 — bounded public-safe media intelligence advisory.
  // Media Intelligence / Advisory Observations was REMOVED from the
  // public verify page (product decision). The API still returns
  // `mediaIntelligenceAdvisory`, so the setter is retained to consume the
  // field without warnings, but the value is never read/rendered — hence
  // the empty first tuple slot.
  const [, setMediaIntelligenceAdvisory] =
    useState<NonNullable<VerifyResponse["mediaIntelligenceAdvisory"]> | null>(
      null,
    );
  // Phase 1B Closure — bounded capture-trust projection. The API returns
  // null when there is nothing surfaceable (legacy non-trust artifact or
  // projection failure). We render no section in either case; the page
  // is honest about no-data rather than fabricating a Class B or claim.
  const [captureTrust, setCaptureTrust] = useState<{
    provenanceClassLabel: string;
    signatureVerdict: string;
    attestationVerdict: string;
    serverCountersigned: boolean;
    rfc3161Applied: boolean;
    otsApplied: boolean;
    limitations: ReadonlyArray<string>;
  } | null>(null);

  // Enterprise Technical Metadata layer — privacy-safe Media / EXIF /
  // Capture Environment projection. Null when the API has nothing to
  // surface; we render no section in that case (honest no-data).
  const [technicalMetadata, setTechnicalMetadata] =
    useState<VerifyTechnicalMetadata | null>(null);

  // Phase 4B Final Closure (I3) — lifecycle transparency projection.
  // Fetched from /public/verify/:id/lifecycle after evidenceId resolves.
  // No auth required. Bounded counts + chips + ids only.
  const [lifecycleTransparency, setLifecycleTransparency] =
    useState<VerifyLifecycleTransparency | null>(null);
  const [serverTrustDecision, setServerTrustDecision] =
    useState<VerifyTrustDecision | null>(null);
  const [trustSnapshotDivergence, setTrustSnapshotDivergence] =
    useState<NonNullable<VerifyResponse["trustDecisionConsistency"]> | null>(null);
  const [verificationSnapshot, setVerificationSnapshot] =
    useState<VerifyResponse["verificationSnapshot"]>(null);
  const [outputContext, setOutputContext] =
    useState<VerifyResponse["outputContext"]>(null);
  const [liveAnchoring, setLiveAnchoring] =
    useState<VerifyResponse["liveAnchoring"]>(null);
  const [refreshingAnchoring, setRefreshingAnchoring] = useState(false);
  const [custodyDisplayCounts, setCustodyDisplayCounts] =
    useState<VerifyResponse["custodyDisplayCounts"]>(null);
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
  const [serverVerificationPackageIntegrity, setServerVerificationPackageIntegrity] =
  useState<Partial<VerificationPackageIntegrity> | null>(null);
const [activeTechnicalTab, setActiveTechnicalTab] =
  useState<TechnicalTabId>("record");

const [forensicMode, setForensicMode] = useState(false);

  const pollingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchVerifyRef = useRef<
    ((options?: { background?: boolean; manual?: boolean }) => Promise<void>) | null
  >(null);
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
  return isAccessCustodyEventType(eventType);
}

  const applyVerifyResponse = (data: VerifyResponse) => {
    const tsaDetails = buildTsaDetails(data);
    const otsDetails = buildOtsDetails(data);
    setServerTrustDecision(data.trustDecision ?? null);
    // Issue #7: surface snapshot/live divergence. The API returns
    // trustDecisionConsistency.consistentWithSnapshot === false when the
    // current live recomputation differs from the report snapshot. We render
    // a clear warning instead of silently preferring the snapshot.
    setTrustSnapshotDivergence(
      data.trustDecisionConsistency?.consistentWithSnapshot === false
        ? data.trustDecisionConsistency
        : null
    );
    setVerificationSnapshot(data.verificationSnapshot ?? null);
    // Phase 2 closure — canonical OutputContext carries snapshot vs
    // live semantics for the verdict card. Stored verbatim from the
    // API; the renderer below the hero surfaces it.
    setOutputContext(data.outputContext ?? null);
    setLiveAnchoring(data.liveAnchoring ?? null);
    setCaptureContext(data.captureContext ?? null);
    // Phase 31.12 — set the bounded advisory state. The API has
    // already applied the public-safety projection so we just store
    // the shape verbatim.
    setMediaIntelligenceAdvisory(data.mediaIntelligenceAdvisory ?? null);
    // Enterprise Technical Metadata layer — stored verbatim from the
    // API's privacy-safe projection (no raw IP / UA / GPS coordinates).
    setTechnicalMetadata(
      (data as { technicalMetadata?: typeof technicalMetadata }).technicalMetadata ??
        null,
    );
    // Phase 1B Closure — bounded captureTrust projection from the API.
    // Reshape from the projection's nested chain.capture/server/time
    // structure into the flat bounded fields the verify section renders.
    const ct = (data as { captureTrust?: unknown }).captureTrust as
      | {
          provenanceClassLabel?: string | null;
          chain?: {
            capture?: {
              signatureVerdict?: string | null;
              attestationVerdict?: string | null;
            } | null;
            server?: { countersigned?: boolean | null } | null;
            time?: {
              rfc3161?: { applied?: boolean | null } | null;
              ots?: { applied?: boolean | null } | null;
            } | null;
          } | null;
          limitations?: ReadonlyArray<string> | null;
        }
      | null
      | undefined;
    setCaptureTrust(
      ct
        ? {
            provenanceClassLabel: ct.provenanceClassLabel ?? "",
            signatureVerdict: ct.chain?.capture?.signatureVerdict ?? "MISSING",
            attestationVerdict:
              ct.chain?.capture?.attestationVerdict ?? "NOT_ATTEMPTED",
            serverCountersigned: Boolean(ct.chain?.server?.countersigned),
            rfc3161Applied: Boolean(ct.chain?.time?.rfc3161?.applied),
            otsApplied: Boolean(ct.chain?.time?.ots?.applied),
            limitations: ct.limitations ?? [],
          }
        : null,
    );

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
    setTsaInputDigestHex(tsaDetails.inputDigestHex);
    setTsaInputKind(tsaDetails.inputKind);
    setTsaLegacyMode(tsaDetails.legacyMode);
    setTimestampedDigestLabel(tsaDetails.timestampedDigestLabel);
    setTimestampedDigestNote(tsaDetails.timestampedDigestNote);

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
      maskPublicEmail(
        effectiveHumanSummary?.submittedBy ??
          effectiveOverview?.submittedByEmail ??
          effectiveIdentity?.submittedByEmail ??
          null
      )
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

    setAnchorTransactionId(data.anchor?.transactionId ?? null);

    setForensicTimeline(forensicOnly);
    setAccessTimeline(accessOnly);

    setOtsStatus(otsDetails.status);
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
        : typeof tsaDetails.digestMatchesTimestampInput === "boolean"
          ? tsaDetails.digestMatchesTimestampInput
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
setServerVerificationPackageIntegrity(data.verificationPackageIntegrity ?? null);
    setCustodyDisplayCounts(data.custodyDisplayCounts ?? null);
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

    const fetchVerify = async (
      options: { background?: boolean; manual?: boolean } = {},
    ) => {
      const background = options.background === true;
      const manual = options.manual === true;
      try {
        const data = await apiFetch(
          `/public/verify/${encodeURIComponent(params.token)}`
        );
        if (cancelled || !isMountedRef.current) return;

        applyVerifyResponse(data as VerifyResponse);

        if (!background) {
          setError(null);
        }

        if (shouldAutoPollPublicVerify(data as VerifyResponse)) {
          clearPolling();
          pollingTimerRef.current = setTimeout(() => {
            void fetchVerify({ background: true });
          }, 30000);
        } else {
          clearPolling();
        }

        if (manual) {
          addToast("Anchoring status refreshed", "info");
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
        if (!cancelled && manual && isMountedRef.current) {
          setRefreshingAnchoring(false);
        }
      }
    };

    fetchVerifyRef.current = fetchVerify;
    void fetchVerify();

    return () => {
      cancelled = true;
      fetchVerifyRef.current = null;
      clearPolling();
    };
  }, [params?.token, addToast]);

  // Phase 4B Final Closure (I3) — fetch bounded lifecycle transparency
  // when we have a resolved evidenceId. Fire once; fail silently.
  useEffect(() => {
    if (!evidenceId) return;
    let cancelled = false;
    apiFetch(`/public/verify/${encodeURIComponent(evidenceId)}/lifecycle`)
      .then((raw) => {
        if (!cancelled) setLifecycleTransparency(raw as VerifyLifecycleTransparency);
      })
      .catch(() => {
        /* lifecycle transparency is optional — fail silently */
      });
    return () => {
      cancelled = true;
    };
  }, [evidenceId]);

  const storagePresentation = useMemo(
    () => buildStoragePresentation(storageProtection),
    [storageProtection]
  );

  const otsFailureDisplayMessage = useMemo(
    () => normalizeOtsFailureMessage(otsFailureReason),
    [otsFailureReason]
  );

  const otsFailureTechnicalMessage = useMemo(
    () => sanitizeOtsFailureTechnical(otsFailureReason),
    [otsFailureReason]
  );

  const liveAnchoringAdvanced = useMemo(
    () => hasAdvancedLiveAnchoring({ liveAnchoring }),
    [liveAnchoring],
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
      (evidenceContentSummary?.itemCount ?? evidenceItems.length) > 1
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

  const reviewerEvidenceTypeLabel = useMemo(() => {
    return getReviewerEvidenceTypeLabel({
      itemCount:
        evidenceContentSummary?.itemCount ?? overview?.itemCount ?? evidenceItems.length,
      structure: evidenceContentSummary?.structure ?? null,
      imageCount: evidenceContentSummary?.imageCount ?? null,
      videoCount: evidenceContentSummary?.videoCount ?? null,
      audioCount: evidenceContentSummary?.audioCount ?? null,
      pdfCount: evidenceContentSummary?.pdfCount ?? null,
      textCount: evidenceContentSummary?.textCount ?? null,
      otherCount: evidenceContentSummary?.otherCount ?? null,
      evidenceType: overview?.evidenceType ?? humanSummary?.evidenceType ?? null,
      mimeType: overview?.mimeType ?? null,
    });
  }, [
    evidenceContentSummary?.audioCount,
    evidenceContentSummary?.imageCount,
    evidenceContentSummary?.itemCount,
    evidenceContentSummary?.otherCount,
    evidenceContentSummary?.pdfCount,
    evidenceContentSummary?.structure,
    evidenceContentSummary?.textCount,
    evidenceContentSummary?.videoCount,
    evidenceItems.length,
    humanSummary?.evidenceType,
    overview?.evidenceType,
    overview?.itemCount,
    overview?.mimeType,
  ]);

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

    if (isPositiveTsa(tsaStatus) && timestampDigestMatches === false) {
      items.push(
        "The trusted timestamp digest did not match the recorded timestamp input digest."
      );
    }

    if (isFailedTsa(tsaStatus)) {
      items.push(
        "Trusted timestamp unavailable. The timestamp provider did not return a usable token, so no timestamp digest match or mismatch can be concluded."
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
    tsaStatus,
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

  const heroWhatIsVerifiedText = useMemo(() => {
    return (
      humanSummary?.whatIsVerified ??
      // Phase C #14 / #15 — explicit honest positioning: PROOVRA preserves and
      // verifies the *recorded integrity state* after intake; it does not
      // make controlled-capture / device-attestation / examiner-grade
      // forensic-acquisition / court-acceptance claims.
      "PROOVRA preserves and verifies the recorded integrity state of the evidence record after intake. It does not prove original device-capture authenticity, factual truth, authorship, context, intent, legal admissibility, or court acceptance."
    );
  }, [humanSummary?.whatIsVerified]);

  const hasCaptureLocation = useMemo(
    () =>
      hasCaptureLocationMetadata({
        lat: captureContext?.lat,
        lng: captureContext?.lng,
      }),
    [captureContext?.lat, captureContext?.lng]
  );

  const captureLocationCapturedAtLabel = useMemo(
    () =>
      formatDateTime(
        captureContext?.capturedAtUtc ?? captureContext?.deviceTimeIso ?? null
      ),
    [captureContext?.capturedAtUtc, captureContext?.deviceTimeIso]
  );

    const verificationVerdict = useMemo(
    () =>
      buildVerificationVerdict({
        trustDecision: serverTrustDecision,
        overallIntegrity,
        verificationStatus,
        canonicalHashMatches,
        signatureValid,
        custodyChainValid,
        timestampDigestMatches,
        otsHashMatches,
        tsaStatus,
        storageVerified: storageProtection?.verified ?? null,
        immutableStorage: storageProtection?.immutable ?? null,
      }),
    [
      serverTrustDecision,
      overallIntegrity,
      verificationStatus,
      canonicalHashMatches,
      signatureValid,
      custodyChainValid,
      timestampDigestMatches,
      otsHashMatches,
      tsaStatus,
      storageProtection?.verified,
      storageProtection?.immutable,
    ]
  );

  const reviewerActions = useMemo(
    () =>
      buildReviewerActions({
        verdict: verificationVerdict,
        canonicalHashMatches,
        signatureValid,
        custodyChainValid,
        timestampDigestMatches,
        otsHashMatches,
        storageProtection,
        tsaStatus,
      }),
    [
      verificationVerdict,
      canonicalHashMatches,
      signatureValid,
      custodyChainValid,
      timestampDigestMatches,
      otsHashMatches,
      storageProtection,
      tsaStatus,
    ]
  );

  const mismatchExplanations = useMemo(
    () =>
      buildMismatchExplanations({
        canonicalHashMatches,
        signatureValid,
        custodyChainValid,
        timestampDigestMatches,
        otsHashMatches,
        custodyChainFailureReason,
        tsaStatus,
      }),
    [
      canonicalHashMatches,
      signatureValid,
      custodyChainValid,
      timestampDigestMatches,
      otsHashMatches,
      custodyChainFailureReason,
      tsaStatus,
    ]
  );

const trustDecision = useMemo(() => {
  if (serverTrustDecision) {
    return serverTrustDecision;
  }

  if (
    !verificationStatus &&
    !hash &&
    !fingerprintHash &&
    !signature &&
    !signingKeyId &&
    !tsaStatus &&
    !otsStatus &&
    !storageProtection &&
    !identityLevel &&
    !submittedByEmail &&
    !authProvider &&
    !verificationPackageVersion &&
    !(overview?.verificationPackageGeneratedAtUtc ?? humanSummary?.verificationPackageGeneratedAtUtc) &&
    !anchorTransactionId &&
    forensicTimeline.length === 0 &&
    accessTimeline.length === 0
  ) {
    return buildUnavailableTrustDecision();
  }

  return buildLegacyTrustDecisionFallback({
    verificationStatus,
    recordedIntegrityVerifiedAtUtc:
      overview?.recordedIntegrityVerifiedAtUtc ??
      humanSummary?.recordedIntegrityVerifiedAtUtc ??
      null,
    fileSha256: hash,
    fingerprintHash,
    signatureBase64: signature,
    signingKeyId,
    publicKeyPem,
    tsaStatus,
    tsaFailureReason,
    otsStatus,
    otsFailureReason,
    storageProtection,
    identityLevelSnapshot: identityLevel,
    submittedByEmail,
    submittedByAuthProvider: authProvider,
    verificationPackageVersion,
    verificationPackageGeneratedAtUtc:
      overview?.verificationPackageGeneratedAtUtc ??
      humanSummary?.verificationPackageGeneratedAtUtc ??
      null,
    anchor: {
      configured:
        Boolean(anchorTransactionId) || Boolean(otsAnchoredAtUtc),
      provider: null,
      anchoredAtUtc: otsAnchoredAtUtc,
      transactionId: anchorTransactionId,
    },
    custodyEvents: [...forensicTimeline, ...accessTimeline],
  });
}, [
  accessTimeline,
  anchorTransactionId,
  authProvider,
  fingerprintHash,
  forensicTimeline,
  hash,
  humanSummary?.recordedIntegrityVerifiedAtUtc,
  humanSummary?.verificationPackageGeneratedAtUtc,
  identityLevel,
  overview?.recordedIntegrityVerifiedAtUtc,
  overview?.verificationPackageGeneratedAtUtc,
  otsAnchoredAtUtc,
  otsFailureReason,
  otsStatus,
  publicKeyPem,
  serverTrustDecision,
  signature,
  signingKeyId,
  storageProtection,
  submittedByEmail,
  tsaFailureReason,
  tsaStatus,
  verificationPackageVersion,
  verificationStatus,
]);

const verificationPackageIntegrity = useMemo(
  () =>
    buildVerificationPackageIntegrity({
      serverIntegrity: serverVerificationPackageIntegrity,
      version: verificationPackageVersion,
      generatedAtUtc:
        overview?.verificationPackageGeneratedAtUtc ??
        humanSummary?.verificationPackageGeneratedAtUtc ??
        null,
      forensicEventCount: forensicTimeline.length,
      accessEventCount: accessTimeline.length,
    }),
  [
    serverVerificationPackageIntegrity,
    verificationPackageVersion,
    overview?.verificationPackageGeneratedAtUtc,
    humanSummary?.verificationPackageGeneratedAtUtc,
    forensicTimeline.length,
    accessTimeline.length,
  ]
);

const verdictRequiresReview =
  trustDecision.verdict === "REVIEW_REQUIRED";
const normalizedTrustDecision = normalizeVerifyTrustDecision(trustDecision);
const trustDecisionTone = getTrustDecisionPresentationTone(
  normalizedTrustDecision
);
const publicationPendingPosture =
  trustDecision.presentationState === "VERIFIED_PENDING_PUBLICATION" ||
  trustDecision.publicationState === "pending" ||
  trustDecision.publicationState === "degraded";

const executiveBadges = useMemo<
  Array<{
    label: string;
    tone: "success" | "warning" | "neutral" | "info";
    show: boolean;
  }>
>(
  () =>
    trustDecision.signals.map((signal) => {
      const tone: "success" | "warning" | "neutral" | "info" =
        signal.tone === "success"
          ? "success"
          : signal.tone === "warning" || signal.tone === "danger"
            ? "warning"
            : "neutral";

      return {
        label: `${signal.label}: ${signal.summary}`,
        tone,
        show: true,
      };
    }),
  [trustDecision.signals]
);

  const forensicCustodyNarrative = useMemo(() => {
    if (custodyDisplayCounts) {
      return `Forensic custody at report/package generation: ${
        custodyDisplayCounts.forensicAtReportGeneration ?? forensicTimeline.length
      }. Current forensic custody events: ${
        custodyDisplayCounts.currentForensicEvents ?? forensicTimeline.length
      }. Current access activity events: ${
        custodyDisplayCounts.currentAccessEvents ?? accessTimeline.length
      }. Total displayed now: ${
        custodyDisplayCounts.totalDisplayedNow ??
        custodyDisplayCounts.totalDisplayedEvents ??
        forensicTimeline.length + accessTimeline.length
      }.`;
    }

    if (forensicTimeline.length > 0) {
      return `The record contains ${forensicTimeline.length} forensic custody event${
        forensicTimeline.length === 1 ? "" : "s"
      } describing integrity-relevant system activity. These events are displayed separately from later access activity.`;
    }

    return "No forensic custody events were returned in this verification record. This means this response does not provide an internal custody-event chain for the evidence record; it should not be read as proof that no handling occurred outside the recorded system workflow.";
  }, [custodyDisplayCounts, forensicTimeline.length, accessTimeline.length]);

  const custodyTimestampOrderNote = useMemo(() => {
    for (let index = 1; index < fullCustodyTimeline.length; index += 1) {
      const previousAt = fullCustodyTimeline[index - 1]?.atUtc;
      const currentAt = fullCustodyTimeline[index]?.atUtc;

      if (!previousAt || !currentAt) continue;

      if (new Date(currentAt).getTime() < new Date(previousAt).getTime()) {
        return "Timestamp order note: custody events are displayed in hash-chain sequence order. Some event timestamps may be slightly out of chronological order because system jobs complete asynchronously.";
      }
    }

    return null;
  }, [fullCustodyTimeline]);

  const liveCustodyCountsNote = useMemo(() => {
    if (!custodyDisplayCounts) return null;

    const accessAfterGeneration =
      custodyDisplayCounts.accessAfterReportGeneration;
    const currentAccess = custodyDisplayCounts.currentAccessEvents;

    return `Counts are live and may increase after report or package generation as reviewers open, download, or verify materials.${
      typeof accessAfterGeneration === "number" &&
      typeof currentAccess === "number"
        ? ` Package access snapshot at generation may be lower or zero by design. Access activity after report/package generation: ${accessAfterGeneration}. Current access activity total: ${currentAccess}.`
        : ""
    }`;
  }, [custodyDisplayCounts]);

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
          label: "Evidence Status At Report Generation",
          value: overview?.recordStatus ?? statusTone(verifyStatus).label,
          show: true,
        },
{
  label: "Verification Status",
  value:
    trustDecision.signals.find((signal) => signal.key === "core_integrity")
      ?.status === "partial"
      ? "Technical materials available"
      : verificationStatusDisplayLabel(
          overview?.verificationStatusCode ?? verificationStatus
        ),
  show: true,
},
{
  label: "Integrity Status",
  value: integrityStatusDisplayLabel(trustDecision),
  show: true,
},
{
  label: "Trust Decision",
  value: getTrustDecisionLabel(trustDecision),
  show: true,
},
{
  label: "Technical Confidence",
  value: getTrustDecisionConfidenceLabel(trustDecision),
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
          value: reviewerEvidenceTypeLabel || "Evidence",
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
          // Phase D Blocker 1 — "Last meaningful verification" instead of
          // "Last Verified At". This field is now reserved for real
          // verification events (report generation, reviewer technical
          // verification). Public page views are tracked separately under
          // "Last public verify page view".
          label: "Last meaningful verification",
          value: verifiedAt ? formatDateTime(verifiedAt) : "N/A",
          show: Boolean(verifiedAt),
        },
        {
          // Analytics-only — anonymous public verify page view, NOT a
          // technical verification.
          label: "Last public verify page view",
          value: humanSummary?.lastPublicVerifyViewAtUtc
            ? formatDateTime(humanSummary.lastPublicVerifyViewAtUtc)
            : overview?.lastPublicVerifyViewAtUtc
              ? formatDateTime(overview.lastPublicVerifyViewAtUtc)
              : "N/A",
          show: Boolean(
            humanSummary?.lastPublicVerifyViewAtUtc ??
              overview?.lastPublicVerifyViewAtUtc
          ),
        },
        {
          label: "Current public verify page view",
          value: humanSummary?.currentPublicVerifyViewAtUtc
            ? formatDateTime(humanSummary.currentPublicVerifyViewAtUtc)
            : overview?.currentPublicVerifyViewAtUtc
              ? formatDateTime(overview.currentPublicVerifyViewAtUtc)
              : "N/A",
          show: Boolean(
            humanSummary?.currentPublicVerifyViewAtUtc ??
              overview?.currentPublicVerifyViewAtUtc
          ),
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
overview?.verificationStatusCode,
trustDecision,
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
          trustDecision.verdictLabel,
    trustDecision.scoreLabel,
    trustDecision.relianceLevel,
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
    ? verdictRequiresReview
      ? "info"
      : "success"
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
                  ? verdictRequiresReview
                    ? "info"
                    : "success"
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
              label={otsTone(otsStatus, otsBitcoinTxid).label}
              tone={otsTone(otsStatus, otsBitcoinTxid).tone}
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
      verdictRequiresReview,
      tsaStatus,
      tsaProvider,
      tsaGenTimeUtc,
      tsaSerialNumber,
      tsaHashAlgorithm,
      signingKeyId,
      signingKeyVersion,
    ]
  );

  const recordTabFields = useMemo(
    () =>
      summaryFields.filter((field) =>
        [
          "Evidence Status At Report Generation",
          "Verification Status",
"Integrity Status",
"Trust Decision",
"Reliance Level",
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
          // Match the renamed label from Blocker 1.
          "Last meaningful verification",
          "Last public verify page view",
          "Current public verify page view",
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
        ].includes(card.label)
      ),
    [technicalCards]
  );

  const heroTitleSize = "clamp(2rem, 3.2vw, 3.1rem)";
  const heroTextSize = "clamp(0.95rem, 1.15vw, 1rem)";
  const cardTitleSize = "clamp(1.45rem, 2.2vw, 1.95rem)";

const glassCardStyle: CSSProperties = {
  border: `1px solid ${VERIFY_BRAND.line}`,
  background:
    "linear-gradient(180deg, rgba(255,255,255,0.94) 0%, rgba(250,251,249,0.90) 100%)",
  backdropFilter: "blur(10px)",
  boxShadow: "0 18px 44px rgba(16, 32, 29, 0.075)",
  borderRadius: 22,
};

const glassPanelStyle: CSSProperties = {
  border: `1px solid ${VERIFY_BRAND.softLine}`,
  background:
    "linear-gradient(180deg, rgba(255,255,255,0.88) 0%, rgba(248,249,247,0.82) 100%)",
  borderRadius: 18,
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.7)",
};

  const verifyAssetPaths = {
    logo: "/brand/icon-192.png",
    headerVelvet: "/brand/site-velvet-bg.webp.png",
  };
  void verifyAssetPaths;

  const VERIFY_HEADER_IMAGE = "/assets/branding/report-header.png";

  const pageBackgroundStyle: CSSProperties = {
    background:
      "radial-gradient(circle at 12% 0%, rgba(11,46,39,0.055), transparent 30%), radial-gradient(circle at 90% 8%, rgba(96,66,24,0.045), transparent 26%), linear-gradient(180deg, #f6f7f4 0%, #f8faf8 42%, #f2f4f1 100%)",
  };

  return (
<div
  className="page verify-enterprise-font"
  style={{
    ...VERIFY_TYPO.page,
    fontFamily: "var(--font-jakarta), ui-sans-serif, system-ui, sans-serif",
  }}
>
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
              marginBottom: 28,
              width: "100%",
              height: 92,
              borderRadius: 26,
              overflow: "hidden",
              position: "relative",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "0 22px 0 34px",
              background: "transparent",
              border: `1px solid ${VERIFY_BRAND.softLine}`,
              boxShadow: "0 18px 42px rgba(7, 26, 58, 0.10)",
            }}
          >
            <img
              src={VERIFY_HEADER_IMAGE}
              alt="PROOVRA — Integrity in Every Evidence"
              style={{
                display: "block",
                width: "min(430px, 58vw)",
                maxHeight: 58,
                objectFit: "contain",
                objectPosition: "left center",
              }}
            />

            <a
              href="/"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                minHeight: 42,
                padding: "10px 15px",
                borderRadius: 999,
                border: `1px solid ${VERIFY_BRAND.softLine}`,
                background: "#ffffff",
                color: VERIFY_BRAND.ink,
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
                  fontWeight: 700,
                  letterSpacing: "-0.04em",
                  color: VERIFY_BRAND.ink,
                  maxWidth: 820,
                }}
              >
Evidence Trust Decision
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
Review the final verification verdict, legal reliance boundary,
recommended reviewer actions, cryptographic materials, custody chain,
timestamping state, storage protection, and access activity associated
with this evidence record.
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
                  <Button
                    onClick={() => {
                      if (!fetchVerifyRef.current) return;
                      setLoading(true);
                      void fetchVerifyRef.current();
                    }}
                  >
                    Try Again
                  </Button>
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
<TrustDecisionCard decision={trustDecision} />
{outputContext ? (
  <OutputContextBadge outputContext={outputContext} />
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
    <div>
      <div style={{ ...VERIFY_TYPO.kicker, fontSize: 11, marginBottom: 8 }}>
        Trust Signal Breakdown
      </div>
      <div
        style={{
          ...VERIFY_TYPO.h3,
          fontSize: 22,
          marginBottom: 8,
        }}
      >
        Why this decision was reached
      </div>
      <div style={{ ...VERIFY_TYPO.small, maxWidth: 860 }}>
        These signals align the verification page with the PDF report and verification package.
        A failed or pending timestamp/anchoring layer does not automatically invalidate core hashes,
        signatures, custody records, or preserved originals.
      </div>
    </div>

<TrustSignalGrid signals={trustDecision.signals} />
  </div>
</Card>
              {hasCaptureLocation ? (
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
                          Capture Context
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
                          📍 {captureContext?.statusLabel ?? CAPTURE_LOCATION_STATUS_LABEL}
                        </div>
                        <div
                          style={{
                            ...VERIFY_TYPO.body,
                            maxWidth: 860,
                          }}
                        >
                          {captureContext?.description ??
                            CAPTURE_LOCATION_CONTEXT_DESCRIPTION}
                        </div>
                      </div>

                      <div
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 8,
                          borderRadius: 999,
                          border: `1px solid ${VERIFY_BRAND.line}`,
                          background: "rgba(255,255,255,0.48)",
                          padding: "10px 14px",
                          color: VERIFY_BRAND.ink,
                          fontSize: 11,
                          fontWeight: 900,
                          letterSpacing: "0.055em",
                          textTransform: "uppercase",
                        }}
                      >
                        Supporting provenance context
                      </div>
                    </div>

                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns:
                          "repeat(auto-fit, minmax(min(100%, 320px), 1fr))",
                        gap: 18,
                        alignItems: "stretch",
                      }}
                    >
                      <div
                        style={{
                          overflow: "hidden",
                          borderRadius: 22,
                          minHeight: 280,
                        }}
                      >
                        {captureContext?.lat !== null &&
                        captureContext?.lat !== undefined &&
                        captureContext?.lng !== null &&
                        captureContext?.lng !== undefined ? (
                          <CaptureLocationMapPanel
                            lat={captureContext.lat}
                            lng={captureContext.lng}
                            accuracyMeters={captureContext.accuracyMeters}
                            addToast={addToast}
                            height={280}
                            sourceLabel={captureContext.source ?? null}
                          />
                        ) : null}
                      </div>

                      <div
                        style={{
                          display: "grid",
                          gap: 10,
                          alignContent: "start",
                        }}
                      >
                        {[
                          [
                            CAPTURE_LOCATION_STATUS_LABEL,
                            "Yes",
                          ],
                          [
                            "Latitude",
                            formatCaptureLocationCoordinate(captureContext?.lat),
                          ],
                          [
                            "Longitude",
                            formatCaptureLocationCoordinate(captureContext?.lng),
                          ],
                          [
                            "Accuracy radius",
                            formatCaptureLocationAccuracy(
                              captureContext?.accuracyMeters
                            ),
                          ],
                          ["Capture timestamp", captureLocationCapturedAtLabel],
                          [
                            "Source",
                            captureContext?.source ?? CAPTURE_LOCATION_SOURCE_LABEL,
                          ],
                        ].map(([label, value]) => (
                          <div
                            key={label}
                            style={{
                              ...glassPanelStyle,
                              padding: 14,
                              display: "grid",
                              gap: 5,
                            }}
                          >
                            <div
                              style={{
                                ...VERIFY_TYPO.kicker,
                                fontSize: 10.5,
                              }}
                            >
                              {label}
                            </div>
                            <div
                              style={{
                                ...VERIFY_TYPO.value,
                                fontSize: 14,
                                color: VERIFY_BRAND.ink,
                              }}
                            >
                              {value}
                            </div>
                          </div>
                        ))}

                        <div
                          style={{
                            ...glassPanelStyle,
                            borderLeft: `5px solid ${VERIFY_BRAND.bronze}`,
                            padding: 16,
                          }}
                        >
                          <div
                            style={{
                              ...VERIFY_TYPO.small,
                              fontSize: 12.5,
                              color: VERIFY_BRAND.ink,
                            }}
                          >
                            {captureContext?.legalBoundary ??
                              CAPTURE_LOCATION_LEGAL_BOUNDARY ??
                              CAPTURE_LOCATION_SHORT_BOUNDARY}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </Card>
              ) : null}
              <LegalWarningBlock verdict={verificationVerdict} />

              <ReviewerActionsBlock actions={reviewerActions} />

              <MismatchExplanationBlock explanations={mismatchExplanations} />

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
  trustDecisionTone === "danger"
    ? `linear-gradient(180deg, ${VERIFY_BRAND.danger} 0%, #8f3328 100%)`
    : trustDecisionTone === "warning"
      ? `linear-gradient(180deg, ${VERIFY_BRAND.warning} 0%, #6f4f1f 100%)`
      : `linear-gradient(180deg, ${VERIFY_BRAND.success} 0%, #145c48 100%)`,
                                display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          color: "#fff",
                          fontSize: 28,
                          fontWeight: 900,
                          boxShadow:
                            trustDecisionTone === "danger"
                              ? "0 16px 34px rgba(181,71,56,0.20)"
                              : trustDecisionTone === "warning"
                                ? "0 16px 34px rgba(138,106,47,0.20)"
                                : "0 16px 34px rgba(33,117,93,0.20)",
                          flexShrink: 0,
                        }}
                      >
{trustDecisionTone === "success" ? "✓" : "!"}
                      </div>

                      <div style={{ minWidth: 0 }}>
<div
  style={{
    ...VERIFY_TYPO.kicker,
    fontSize: 11,
    marginBottom: 7,
  }}
>
  Verification Signal Summary
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
Supporting Technical Signals
                        </div>
                        <div
                          style={{
                            ...VERIFY_TYPO.body,
                            fontSize: 15,
                            maxWidth: 820,
                          }}
                        >
The signals below show the recorded verification layers behind the Trust Decision above. They support forensic review, but the overall decision should be read from the classification, reviewer reliance, legal boundary, and reviewer action.
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
  <Badge
    key={item.label}
    label={item.label}
    tone={item.tone}
    muted={verdictRequiresReview}
  />
))}
                  </div>
                  <div
  style={{
      border: `1px solid ${
      trustDecisionTone === "success"
        ? "rgba(33,117,93,0.28)"
        : trustDecisionTone === "danger"
          ? "rgba(181,71,56,0.28)"
          : "rgba(138,106,47,0.32)"
    }`,
    borderLeft: `5px solid ${
      trustDecisionTone === "success"
        ? VERIFY_BRAND.success
        : trustDecisionTone === "danger"
          ? VERIFY_BRAND.danger
          : VERIFY_BRAND.warning
    }`,
    background:
      trustDecisionTone === "success"
        ? VERIFY_BRAND.successSoft
        : trustDecisionTone === "danger"
          ? VERIFY_BRAND.dangerSoft
          : VERIFY_BRAND.warningSoft,
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
        trustDecisionTone === "success"
          ? VERIFY_BRAND.success
          : trustDecisionTone === "danger"
            ? VERIFY_BRAND.danger
            : VERIFY_BRAND.warning,
    }}
  >
Reviewer Action
  </div>

  <div
    style={{
      ...VERIFY_TYPO.value,
      fontSize: 15,
      lineHeight: 1.55,
    }}
  >
{trustDecision.reviewerAction}
  </div>

  <div
    style={{
      ...VERIFY_TYPO.small,
      fontSize: 13,
      color: VERIFY_BRAND.ink,
    }}
  >
    This decision is limited to the recorded technical state. It does not prove
    factual truth, authorship, intent, context, or court admissibility.
  </div>
</div>

{/*
  Issue #7: surface snapshot/live trust divergence to the public viewer.
  When the report snapshot differs from a live recomputation, we must NOT
  silently show the older snapshot as positive — render an explicit warning.
*/}
{trustSnapshotDivergence ? (() => {
  const isAccessOnly = trustSnapshotDivergence.accessOnly === true;

  const railColor = isAccessOnly
    ? VERIFY_BRAND.accent
    : VERIFY_BRAND.warning;

  const background = isAccessOnly
    ? "rgba(11,46,39,0.045)"
    : "rgba(138,106,47,0.075)";

  const borderColor = isAccessOnly
    ? "rgba(11,46,39,0.16)"
    : "rgba(138,106,47,0.26)";

  return (
    <div
      role="status"
      style={{
        border: `1px solid ${borderColor}`,
        borderLeft: `5px solid ${railColor}`,
        background,
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
          color: railColor,
        }}
      >
        {isAccessOnly
          ? "Live access activity update"
          : "Live verification status update"}
      </div>

      <div
        style={{
          ...VERIFY_TYPO.value,
          fontSize: 15,
          lineHeight: 1.55,
        }}
      >
        {isAccessOnly
          ? "No integrity mismatch detected. Later page views, downloads, or access activity changed after the fixed report snapshot."
          : "The live verification state differs from the fixed report snapshot. Review the technical materials if this change matters to your review."}
      </div>

      <div
        style={{
          ...VERIFY_TYPO.small,
          fontSize: 13,
          color: VERIFY_BRAND.ink,
        }}
      >
        The trust decision shown here is sourced from the fixed snapshot taken at
        report or package generation time. Later activity can change the live page
        without necessarily changing the preserved evidence integrity state.
      </div>

      {trustSnapshotDivergence.reasons?.length ? (
        <div
          style={{
            ...VERIFY_TYPO.small,
            fontSize: 13,
            color: VERIFY_BRAND.ink,
            display: "grid",
            gap: 8,
          }}
        >
          <strong>Why this appears</strong>

          <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
            {trustSnapshotDivergence.reasons.map((reason, index) => (
              <li key={`${reason.code ?? "reason"}-${index}`}>
                <strong>{reason.label ?? "Snapshot difference"}.</strong>{" "}
                {reason.detail ??
                  "Later activity changed after the fixed snapshot."}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
})() : null}

{verificationSnapshot ? (
  <div
    style={{
      display: "grid",
      gap: 16,
    }}
  >
    <div
      style={{
        ...VERIFY_SURFACE.card,
        padding: 18,
        display: "grid",
        gap: 12,
      }}
    >
      <div style={{ display: "grid", gap: 6 }}>
        <div
          style={{
            ...VERIFY_TYPO.kicker,
            fontSize: 10.5,
            color: VERIFY_BRAND.accent,
          }}
        >
          Verification package snapshot
        </div>
        <div style={{ ...VERIFY_TYPO.small, fontSize: 13, color: VERIFY_BRAND.ink }}>
          This section reflects the verification package/report generated at the recorded time.
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 12,
        }}
      >
        <SummaryField
          label="Snapshot Source"
          value={describeSnapshotSource(verificationSnapshot.source)}
        />
        <SummaryField
          label="Generated At"
          value={
            verificationSnapshot.generatedAtUtc
              ? formatDateTime(verificationSnapshot.generatedAtUtc)
              : "Not recorded"
          }
        />
        <SummaryField
          label="Report Version"
          value={
            verificationSnapshot.reportVersion != null
              ? `v${verificationSnapshot.reportVersion}`
              : "Not recorded"
          }
        />
        <SummaryField
          label="Package Version"
          value={
            verificationSnapshot.packageVersion != null
              ? `v${verificationSnapshot.packageVersion}`
              : "Not recorded"
          }
        />
        <SummaryField
          label="OTS Status At Generation"
          value={verificationSnapshot.otsStatusAtGeneration ?? "Not recorded in snapshot"}
        />
        <SummaryField
          label="Report Signature"
          value={formatSignatureStatus(verificationSnapshot.reportSignature?.status)}
        />
        <SummaryField
          label="Package Manifest Signature"
          value={
            verificationSnapshot.verificationPackageSignature?.manifestSigned === true
              ? "Signed"
              : verificationSnapshot.verificationPackageSignature?.manifestPresent === true
                ? "Manifest present; signature not confirmed"
                : "Not recorded"
          }
        />
        <SummaryField
          label="Snapshot Trust Decision"
          value={
            verificationSnapshot.trustDecisionSnapshot?.verdictLabel ??
            "No fixed trust-decision snapshot"
          }
        />
      </div>
    </div>

    <div
      style={{
        ...VERIFY_SURFACE.card,
        padding: 18,
        display: "grid",
        gap: 12,
      }}
    >
      <div style={{ display: "grid", gap: 6 }}>
        <div
          style={{
            ...VERIFY_TYPO.kicker,
            fontSize: 10.5,
            color: VERIFY_BRAND.warning,
          }}
        >
          Live anchoring status
        </div>
        <div style={{ ...VERIFY_TYPO.small, fontSize: 13, color: VERIFY_BRAND.ink }}>
          This section reflects the current OpenTimestamps/public anchoring state and may advance after the package was generated.
        </div>
      </div>

      {liveAnchoringAdvanced ? (
        <div
          style={{
            border: "1px solid rgba(33,117,93,0.28)",
            borderLeft: `5px solid ${VERIFY_BRAND.success}`,
            background: VERIFY_BRAND.successSoft,
            borderRadius: 18,
            padding: 16,
            ...VERIFY_TYPO.small,
            fontSize: 13,
            color: VERIFY_BRAND.ink,
          }}
        >
          Anchoring has advanced since this package was generated. A newer report/package may be available.
        </div>
      ) : null}

      {(liveAnchoring?.currentOtsStatus ?? otsStatus) === "PENDING" ? (
        <div
          style={{
            border: "1px solid rgba(138,106,47,0.28)",
            borderLeft: `5px solid ${VERIFY_BRAND.warning}`,
            background: VERIFY_BRAND.warningSoft,
            borderRadius: 18,
            padding: 16,
            ...VERIFY_TYPO.small,
            fontSize: 13,
            color: VERIFY_BRAND.ink,
          }}
        >
          OpenTimestamps public anchoring is pending. This does not invalidate recorded integrity, TSA timestamping, signature, custody, or Object Lock.
        </div>
      ) : null}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 12,
        }}
      >
        <SummaryField
          label="Current OTS Status"
          value={liveAnchoring?.currentOtsStatus ?? otsStatus ?? "Not recorded"}
        />
        <SummaryField
          label="Anchored At"
          value={
            liveAnchoring?.otsAnchoredAtUtc
              ? formatDateTime(liveAnchoring.otsAnchoredAtUtc)
              : "Not recorded"
          }
        />
        <SummaryField
          label="Bitcoin Transaction"
          value={liveAnchoring?.otsBitcoinTxid ?? "Not recorded"}
        />
        <SummaryField
          label="Last Anchoring Update"
          value={
            liveAnchoring?.lastUpdatedAtUtc
              ? formatDateTime(liveAnchoring.lastUpdatedAtUtc)
              : "Not recorded"
          }
        />
        <SummaryField
          label="Latest Report"
          value={liveAnchoring?.newerReportAvailable ? "Latest report available" : "No newer report recorded"}
        />
        <SummaryField
          label="Latest Package"
          value={liveAnchoring?.newerPackageAvailable ? "Latest package available" : "No newer package recorded"}
        />
      </div>
    </div>
  </div>
) : null}

{/*
  Media Intelligence / Advisory Observations REMOVED (product decision).
  The public advisory block surfaced only a bounded count of low-value
  workspace/correlation observations (duplicate/similar material) with no
  hashes or reviewer-actionable proof, which added no forensic value to
  the public verification page. Public verification now focuses on the
  Technical Metadata cards below (Media / EXIF / Capture Environment) and
  the preservation + custody verdicts above. The API still returns
  `mediaIntelligenceAdvisory`; it is simply no longer rendered.
*/}

{/*
  Enterprise Technical Metadata layer — privacy-safe Media / EXIF /
  Capture Environment cards. Extracted to VerifyTechnicalMetadataSection
  (CR4 decomposition) — same testids, same privacy-safe payload, renders
  null when the projection is absent.
*/}
<VerifyTechnicalMetadataSection
  technicalMetadata={technicalMetadata}
  typo={VERIFY_TYPO}
  brand={VERIFY_BRAND}
/>

{/*
  Capture-trust panel — extracted to VerifyCaptureIntegritySection (CR4
  decomposition). The CURRENT preservation verification (trusted timestamp
  + blockchain anchoring) is shown prominently ABOVE. The full capture-
  side panel renders only on a positive capture-side signal; otherwise a
  reassuring Advanced details accordion is shown. Behaviour is unchanged.
*/}
<VerifyCaptureIntegritySection
  captureTrust={captureTrust}
  typo={VERIFY_TYPO}
  brand={VERIFY_BRAND}
/>

{lifecycleTransparency ? (
  <VerifyLifecycleSection lifecycleTransparency={lifecycleTransparency} />
) : null}

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
  body: verificationVerdict.legalStatement,
  footer: verificationVerdict.actionRequired,
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

                    {publicationPendingPosture ? (
                    <div
                      style={{
                        ...glassPanelStyle,
                        borderLeft: `5px solid ${VERIFY_BRAND.warning}`,
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
                        Publication Posture
                      </div>
                      <div
                        style={{
                          ...VERIFY_TYPO.small,
                          fontSize: 13,
                          color: VERIFY_BRAND.ink,
                        }}
                      >
                        Recorded integrity is verified, but independent public anchoring is not finalized yet. Reviewers should treat this as a conditional anchoring state and recheck anchoring later if independent public anchoring matters to the review.
                      </div>
                    </div>
                  ) : null}

                  {anchorTransactionId ? (
                    <div
                      style={{
                        ...glassCardStyle,
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
                        Bitcoin Anchoring
                      </div>
                      <div style={{ display: "grid", gap: 10 }}>
                        <div
                          style={{
                            ...VERIFY_TYPO.small,
                            fontWeight: 700,
                            color: VERIFY_BRAND.ink,
                          }}
                        >
                          Bitcoin anchor recorded
                        </div>
                        <div
                          style={{
                            ...VERIFY_TYPO.small,
                            color: VERIFY_BRAND.ink,
                          }}
                        >
                          TxID: {truncateHash(anchorTransactionId)}
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard.writeText(anchorTransactionId);
                            addToast("Transaction ID copied", "success");
                          }}
                          style={{
                            width: "fit-content",
                            borderRadius: 999,
                            border: `1px solid ${VERIFY_BRAND.line}`,
                            background: "rgba(255,255,255,0.62)",
                            color: VERIFY_BRAND.accent,
                            fontSize: 12,
                            fontWeight: 900,
                            letterSpacing: "0.065em",
                            textTransform: "uppercase",
                            padding: "10px 14px",
                            cursor: "pointer",
                          }}
                        >
                          Copy TxID
                        </button>
                      </div>
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
                        ...BRONZE_RAIL_STYLE,
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
                        ...BRONZE_RAIL_STYLE,
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
                          Timestamp / mismatch review
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
      display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
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
<div
  style={{
    marginBottom: 4,

    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  }}
>
  {item.label}
</div>
<div
  style={{
    ...VERIFY_TYPO.small,
    fontSize: 12,
    color: active
      ? VERIFY_BRAND.accent
      : VERIFY_BRAND.muted,

    // 👇 يمنع التمدد
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  }}
>
  {evidenceKindLabel(item.kind)}
  {` • ${describeEvidenceAssetRole(item)}`}
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
                              ...BRONZE_RAIL_STYLE,
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
These materials support the Trust Decision shown above. The Trust Decision is the reviewer-facing summary; this technical layer exposes the raw hashes, signatures, custody-chain hashes, timestamp materials, anchoring state, and access activity for deeper forensic review.
                      </div>
                    </div>
                  </div>
<div
  style={{
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    flexWrap: "wrap",
    padding: 14,
    borderRadius: 18,
    border: `1px solid ${forensicMode ? VERIFY_BRAND.accent : VERIFY_BRAND.line}`,
    background: forensicMode
      ? "rgba(11,46,39,0.08)"
      : "rgba(255,255,255,0.38)",
  }}
>
  <div>
    <div
      style={{
        ...VERIFY_TYPO.kicker,
        fontSize: 10.5,
        marginBottom: 4,
      }}
    >
      Forensic Review Mode
    </div>
    <div
      style={{
        ...VERIFY_TYPO.small,
        fontSize: 13,
        color: VERIFY_BRAND.ink,
      }}
    >
      {forensicMode
        ? "Raw technical materials are expanded for forensic review."
        : "Enable to expand raw hashes, signatures, public key material, custody hashes, and timestamp proof fields."}
    </div>
  </div>

  <button
    type="button"
    onClick={() => setForensicMode((value) => !value)}
    style={{
      minHeight: 42,
      padding: "10px 16px",
      borderRadius: 999,
      border: forensicMode
        ? `1px solid ${VERIFY_BRAND.accent}`
        : `1px solid ${VERIFY_BRAND.line}`,
      background: forensicMode
        ? VERIFY_BRAND.accent
        : "rgba(255,255,255,0.62)",
      color: forensicMode ? "#ffffff" : VERIFY_BRAND.accent,
      fontSize: 11,
      fontWeight: 900,
      letterSpacing: "0.06em",
      textTransform: "uppercase",
      cursor: "pointer",
      boxShadow: forensicMode
        ? "0 12px 28px rgba(11,46,39,0.18)"
        : "0 8px 20px rgba(16,32,29,0.06)",
    }}
  >
    {forensicMode ? "Disable Forensic Mode" : "Enable Forensic Mode"}
  </button>
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
  label="Package Integrity"
  active={activeTechnicalTab === "package"}
  onClick={() => setActiveTechnicalTab("package")}
/>
<TechnicalTabButton
  label="Custody Chain"
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
                          ...BRONZE_RAIL_STYLE,
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
                          ...BRONZE_RAIL_STYLE,
                          padding: 16,
                          display: "grid",
                          gap: 8,
                        }}
                      >
                        <TrustSignalGrid
  signals={trustDecision.signals.filter((signal) =>
    [
      "core_integrity",
      "signature",
      "trusted_timestamp",
      "public_anchoring",
      "immutable_storage",
    ].includes(signal.key)
  )}
/>
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
                            evidenceContentSummary?.itemCount &&
                            evidenceContentSummary.itemCount > 1
                              ? "Canonical Package Digest (SHA-256)"
                              : tsaInputKind && tsaInputKind !== "FILE_SHA256"
                                ? "File Digest (SHA-256)"
                                : "Original File SHA-256"
                          }
                          subtitle={
                            evidenceContentSummary?.itemCount &&
                            evidenceContentSummary.itemCount > 1
                              ? `${PROOVRA_MULTIPART_REVIEWER_EXPLANATION} ${PROOVRA_MULTIPART_RECOMPUTATION_NOTE}`
                              : tsaInputKind && tsaInputKind !== "FILE_SHA256"
                                ? "SHA-256 digest of the original preserved evidence file. The timestamp layer may instead reference canonical evidence or fingerprint material."
                                : "SHA-256 digest of the original preserved evidence file."
                          }
                          value={hash}
                          forensicMode={forensicMode}
                          addToast={addToast}
                          copyMessage={
                            evidenceContentSummary?.itemCount &&
                            evidenceContentSummary.itemCount > 1
                              ? "Canonical package digest copied"
                              : tsaInputKind && tsaInputKind !== "FILE_SHA256"
                                ? "File digest copied"
                                : "Original file hash copied"
                          }
                        />
                      ) : null}

                      {evidenceContentSummary?.itemCount &&
                      evidenceContentSummary.itemCount > 1 ? (
                        <div
                          style={{
                            ...BRONZE_RAIL_STYLE,
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
                            Multipart integrity boundary
                          </div>
                          <div
                            style={{
                              ...VERIFY_TYPO.small,
                              fontSize: 13,
                              color: VERIFY_BRAND.ink,
                            }}
                          >
                            {PROOVRA_MULTIPART_REVIEWER_EXPLANATION}{" "}
                            {PROOVRA_MULTIPART_RECOMPUTATION_NOTE}{" "}
                            {PROOVRA_MULTIPART_LEGAL_BOUNDARY_NOTE}
                          </div>
                        </div>
                      ) : null}

                      {tsaInputDigestHex && tsaInputDigestHex !== hash ? (
                        <MaterialField
                          label={
                            timestampedDigestLabel ??
                            getTimestampDigestLabel({
                              itemCount: evidenceContentSummary?.itemCount,
                              tsaInputKind,
                            })
                          }
                          subtitle={
                            timestampedDigestNote ??
                            "This value may differ from the original file SHA-256 when the timestamp is applied to canonical evidence or fingerprint material."
                          }
                          value={tsaInputDigestHex}
                          forensicMode={forensicMode}
                          addToast={addToast}
                          copyMessage="Timestamped digest copied"
                        />
                      ) : null}

                      {tsaLegacyMode ? (
                        <div style={{ ...VERIFY_TYPO.small, color: VERIFY_BRAND.subtle }}>
                          Legacy mode: this record predates explicit timestamp-input
                          digest storage, so timestamp verification falls back to the
                          recorded legacy digest model.
                        </div>
                      ) : null}

                      {fingerprintHash ? (
                        <MaterialField
                          label="Canonical Fingerprint Hash"
                          forensicMode={forensicMode}
                          subtitle="Hash derived from the canonical fingerprint record."
                          value={fingerprintHash}
                          addToast={addToast}
                          copyMessage="Fingerprint hash copied"
                        />
                      ) : null}

                      {signature ? (
                        <MaterialField
                          label="Digital Signature"
                          forensicMode={forensicMode}
                          subtitle="Recorded signature material associated with this evidence."
                          value={signature}
                          addToast={addToast}
                          copyMessage="Digital signature copied"
                        />
                      ) : null}

                      {publicKeyPem ? (
                        <MaterialField
                          label="Public Key"
                          forensicMode={forensicMode}
                          subtitle="Public key material available for advanced technical review."
                          value={publicKeyPem}
                          addToast={addToast}
                          copyMessage="Public key copied"
                        />
                      ) : null}

                      {otsProofBase64 ? (
                        <MaterialField
                          label="OpenTimestamps Proof"
                          forensicMode={forensicMode}
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
                  {activeTechnicalTab === "package" ? (
                    <div style={{ display: "grid", gap: 14 }}>
                      <VerificationPackageIntegrityCard
                        integrity={verificationPackageIntegrity}
                      />

                      <div
                        style={{
                          ...BRONZE_RAIL_STYLE,
                          padding: 16,
                          display: "grid",
                          gap: 8,
                        }}
                      >
                        <div style={{ ...VERIFY_TYPO.kicker, fontSize: 10.5 }}>
                          Package verification scope
                        </div>
                        <div
                          style={{
                            ...VERIFY_TYPO.small,
                            fontSize: 13,
                            color: VERIFY_BRAND.ink,
                          }}
                        >
                          Package integrity is separate from evidence integrity.
                          Evidence integrity verifies the preserved evidence state.
                          Package integrity verifies whether the exported forensic
                          bundle contains the manifest, checksum index, manifest
                          digest reference, offline verifier, and audit exports
                          needed for independent offline review.
                        </div>
                      </div>
                    </div>
                  ) : null}

{activeTechnicalTab === "full-custody" ? (
  <TimelinePanel
    title="Custody Chain"
    forensicMode={forensicMode}
    subtitle="Complete recorded custody chronology, including integrity-relevant lifecycle events and later access activity when returned by the verification response. Event hashes are shown in full for chain-continuity review."
    note={
      [liveCustodyCountsNote, custodyTimestampOrderNote]
        .filter(Boolean)
        .join(" ")
    }
    countLabel={
      custodyDisplayCounts
        ? `Forensic ${custodyDisplayCounts.currentForensicEvents ?? forensicTimeline.length} • Access ${custodyDisplayCounts.currentAccessEvents ?? accessTimeline.length} • Total ${custodyDisplayCounts.totalDisplayedNow ?? custodyDisplayCounts.totalDisplayedEvents ?? fullCustodyTimeline.length}`
        : null
    }
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
  <div style={{ display: "grid", gap: 14 }}>
    <div
      style={{
        ...BRONZE_RAIL_STYLE,
        padding: 16,
        display: "grid",
        gap: 6,
      }}
    >
      <div
        style={{
          ...VERIFY_TYPO.kicker,
          fontSize: 10.5,
          color: VERIFY_BRAND.warning,
        }}
      >
        Access Activity Boundary
      </div>

        <div
          style={{
            ...VERIFY_TYPO.small,
            fontSize: 13,
            color: VERIFY_BRAND.ink,
          }}
        >
        Access activity is not part of the evidence integrity verdict. It records
        later interaction with the verification page, files, reports, or packages
        and must not be treated as proof that the underlying evidence is authentic
        or admissible. Package access snapshots are taken at generation time;
        the current activity shown here is live and may include later events not
        present in the exported package.
      </div>
    </div>

    <TimelinePanel
      title="Access Activity"
      forensicMode={forensicMode}
      subtitle="Access events show later viewing, download, and verification interactions. They are informational activity records, not proof of evidence authenticity, and must not be used alone to infer integrity or legal admissibility."
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
  </div>
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
                      Copy the verification link to share this record.
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

                    <button
                      type="button"
                      onClick={() => {
                        if (!fetchVerifyRef.current) return;
                        setRefreshingAnchoring(true);
                        void fetchVerifyRef.current({ manual: true });
                      }}
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
                        cursor: refreshingAnchoring ? "progress" : "pointer",
                        boxShadow: "0 10px 24px rgba(16,32,29,0.08)",
                        opacity: refreshingAnchoring ? 0.7 : 1,
                      }}
                      disabled={refreshingAnchoring}
                    >
                      {refreshingAnchoring
                        ? "Checking anchoring status..."
                        : "Check Latest Anchoring Status"}
                    </button>
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
