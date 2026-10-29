"use client";
/**
 * THE PUBLIC VERIFY PAGE (rich tier) — converged 2026-10-18 onto the server
 * contract (docs/verification/public-verify-convergence-2026-10-18.md).
 *
 * The API's matrix, qualifiers and projection are the ONLY truth and
 * disclosure authorities. This page renders what the API returned: it never
 * re-derives a status (no client trust-decision rebuild, no client matrix, no
 * verdict, no TSA-string mismatch inference, no package-integrity rebuild),
 * never decides what to show from a policy, and never hides a field
 * cosmetically — the API already withheld what the record's disclosure policy
 * withholds.
 */
import { toSafeUserError } from "../../../lib/feedback/toSafeUserError";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useParams } from "next/navigation";
import {
  CAPTURE_LOCATION_CONTEXT_DESCRIPTION,
  CAPTURE_LOCATION_LEGAL_BOUNDARY,
  CAPTURE_LOCATION_SHORT_BOUNDARY,
  CAPTURE_LOCATION_SOURCE_LABEL,
  evidenceLocationCopy,
  formatCaptureLocationAccuracy,
  formatCaptureLocationCoordinate,
  parseVerificationMatrix,
  readStoredTrustDecision,
  hasCaptureLocationMetadata,
  isAccessCustodyEventType,
  liveDeltaMaterialsText,
  maskPublicEmailsInText,
  otsBoundaryFor,
  readOtsAnchoringView,
  type VerificationMatrix,
  type OtsAnchoringView,
  custodyChainVerdictLabel,
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
import BasicVerificationView, {
  CanonicalVerificationStateView,
  canonicalVerificationStateFromCode,
  StoredBytesNotice,
  VerifyLinkNotice,
  type CanonicalVerificationFacts,
  type CanonicalVerificationState,
  type VerifyLinkInfo,
} from "./BasicVerificationView";
import type { BasicVerification } from "@proovra/shared";
import { selectRecordTabFields, tsaClaimLabel } from "./_verify-record-tab";
import { VerifyCaptureManifestSection, readPublicCaptureManifest } from "./VerifyCaptureManifestSection";
import { VerifyLocationStateSection, readVerifyLocationState } from "./VerifyLocationStateSection";
import { useLocale } from "../../providers";
import { apiFetch } from "../../../lib/api";
import { captureException } from "../../../lib/sentry";
import {
  firstNonEmpty,
  formatDateTime,
  normalizeEventLabel,
} from "../../../components/verify-v2/_helpers";
import {
  VerifyTechnicalMetadataSection,
  type VerifyTechnicalMetadata,
} from "../../../components/verify-v2/VerifyTechnicalMetadataSection";
import {
  VerifyCaptureIntegritySection,
  readPublicVerifyAcquisition,
} from "../../../components/verify-v2/VerifyCaptureIntegritySection";
// PHASE 12B — redaction verification badge, read from this page's own
// token-bound projection.
import {
  VerifyRedactionSection,
  type VerifyRedaction,
} from "../../../components/verify-v2/VerifyRedactionSection";
import type {
  VerifyResponse,
  TimelineItem,
  ToastFn,
  TechnicalTabId,
  VerifyTsa,
} from "./_verify-types";
import { VERIFY_BRAND, VERIFY_FONT, VERIFY_TYPO } from "./_verify-theme";
import {
  VerificationMatrixGrid,
  VerificationSummaryCard,
  VERIFY_MATRIX_INTRO,
  VERIFY_MATRIX_UNAVAILABLE,
} from "./VerifyMatrixPanels";
import {
  AccessActivitySummary,
  ArtifactHistory,
  ConsistencyReasons,
  DisclosureNotice,
  ItemInventoryTable,
  OtsAnchoringCard,
  PackageIntegrityCard,
  Pager,
  RecordFactsCard,
  VERIFY_PAGE_CSS,
  VerifyTabPanel,
  VerifyTabs,
  groupForensicEvents,
  usePaged,
  type OtsFacts,
} from "./VerifyRecordSections";
import { ContentPreviewSurface } from "./VerifyContentReview";

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
  tone?: "success" | "neutral" | "info" | "warning" | "danger";
  muted?: boolean;
}) {
  const effectiveTone = muted && tone === "success" ? "info" : tone;

  const palette =
    effectiveTone === "danger"
      ? {
          bg: VERIFY_BRAND.dangerSoft,
          color: VERIFY_BRAND.danger,
          border: "rgba(181,71,56,0.30)",
        }
      : effectiveTone === "success"
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
      data-badge-tone={effectiveTone}
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

/**
 * Phase 2 closure — render the canonical OutputContext under the verdict
 * card. Reviewers see at a glance whether the verdict is a sealed
 * snapshot (REPORT / VERIFICATION_PACKAGE) or live, the snapshot's
 * generated-at timestamp, when the live view was observed, and which
 * materials may have advanced since the snapshot was sealed (live
 * delta). The legal boundary is stated once, by the verification matrix
 * limitation in the summary card — this badge never repeats it.
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
  // AUD-48 (2026-10-20) — reader-facing words only: an unknown source is
  // named as such, times are formatted, and live-delta keys are labelled.
  const friendlySource = sourceLabel[outputContext.outputType] ?? "Unrecognized source";
  const snapAt = outputContext.snapshotGeneratedAtUtc
    ? formatDateTime(outputContext.snapshotGeneratedAtUtc)
    : null;
  const liveAt = outputContext.liveObservedAtUtc
    ? formatDateTime(outputContext.liveObservedAtUtc)
    : null;
  const deltas = liveDeltaMaterialsText(outputContext.liveDeltaMaterials ?? []);
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
        Signals source: {friendlySource}
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
          {deltas}
        </span>
      ) : null}
    </div>
  );
}


/**
 * The RFC 3161 token's recorded FACTS (provider, time, serial, digest input).
 * Its status is the matrix's tsa_token row — never read from these strings.
 */
function buildTsaDetails(data: VerifyResponse) {
  const tsa = data.storageAndTimestamping?.tsa ?? data.tsa ?? data.timestamp ?? null;

  return {
    provider: firstNonEmpty(tsa?.provider, data.tsaProvider),
    genTimeUtc: firstNonEmpty(tsa?.genTimeUtc, data.tsaGenTimeUtc),
    inputDigestHex: firstNonEmpty(tsa?.inputDigestHex, data.technicalMaterials?.tsaInputDigestHex),
    inputKind: firstNonEmpty(tsa?.inputKind, data.technicalMaterials?.tsaInputKind),
    legacyMode:
      typeof tsa?.legacyMode === "boolean"
        ? tsa.legacyMode
        : typeof data.technicalMaterials?.legacyMode === "boolean"
          ? data.technicalMaterials.legacyMode
          : null,
    serialNumber: firstNonEmpty(tsa?.serialNumber, data.tsaSerialNumber),
    claimsBasis: firstNonEmpty((tsa as VerifyTsa | null)?.tokenClaimsBasis),
    hashAlgorithm: firstNonEmpty(tsa?.hashAlgorithm, data.tsaHashAlgorithm),
    failureReason: firstNonEmpty(tsa?.failureReason, data.tsaFailureReason),
    timestampedDigestLabel: firstNonEmpty((tsa as VerifyTsa | null)?.timestampedDigestLabel),
    timestampedDigestNote: firstNonEmpty((tsa as VerifyTsa | null)?.timestampedDigestNote),
  };
}

function buildOtsDetails(data: VerifyResponse): { view: OtsAnchoringView; calendar: string | null; proofBase64: string | null } {
  // THE Bitcoin anchoring state is the server's (2026-10-13): read, never derived.
  const ots = data.storageAndTimestamping?.ots ?? data.ots ?? null;
  return {
    view: readOtsAnchoringView(ots),
    calendar: firstNonEmpty(ots?.calendar, data.otsCalendar),
    proofBase64: firstNonEmpty(data.otsProofBase64),
  };
}

function toTimelineItem(ev: NonNullable<VerifyResponse["custodyEvents"]>[number], category: TimelineItem["category"]): TimelineItem {
  return {
    sequence: ev.sequence ?? null,
    eventType: ev.eventType ?? "UNKNOWN_EVENT",
    atUtc: ev.atUtc ?? null,
    payloadSummary: ev.payloadSummary ?? null,
    prevEventHash: ev.prevEventHash ?? null,
    eventHash: ev.eventHash ?? null,
    category: ev.category ?? category,
  };
}

/**
 * THE forensic chain the API listed. Access activity is never listed (the API
 * aggregates it: custodyLifecycle.accessActivity); an older response that
 * still mixes both in `custodyEvents` contributes only its forensic events.
 */
function readForensicChain(data: VerifyResponse): TimelineItem[] {
  const listed =
    data.custodyLifecycle?.forensicEvents ??
    data.reviewTrail?.forensicCustodyEvents ??
    data.forensicCustodyEvents ??
    null;
  const items =
    listed && listed.length > 0
      ? listed.map((ev) => toTimelineItem(ev, "forensic"))
      : (data.custodyEvents ?? [])
          .map((ev) => toTimelineItem(ev, null))
          .filter((item) => item.category === "forensic" || (!item.category && !isAccessCustodyEventType(item.eventType)));
  return [...items].sort((a, b) => {
    const sa = a.sequence ?? Number.MAX_SAFE_INTEGER;
    const sb = b.sequence ?? Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    return (a.atUtc ? Date.parse(a.atUtc) : 0) - (b.atUtc ? Date.parse(b.atUtc) : 0);
  });
}

/** One group of the forensic chain, 20 events per page. */
function ForensicChainGroup({
  title,
  subtitle,
  events,
  forensicMode,
}: {
  title: string;
  subtitle: string;
  events: TimelineItem[];
  forensicMode: boolean;
}) {
  const { page, pages, slice, setPage } = usePaged(events);
  if (events.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <TimelinePanel
        title={title}
        subtitle={subtitle}
        forensicMode={forensicMode}
        countLabel={`${events.length} event${events.length === 1 ? "" : "s"}`}
        countTone="info"
        events={slice}
        emptyTitle=""
        emptyBody=""
        accent={{ dot: VERIFY_BRAND.accent, dotBorder: "rgba(11,46,39,0.16)", line: "rgba(11,46,39,0.25)" }}
      />
      <Pager page={page} pages={pages} total={events.length} onPage={setPage} label={title} />
    </div>
  );
}

const TECHNICAL_TABS: ReadonlyArray<{ id: TechnicalTabId; label: string }> = [
  { id: "record", label: "Record" },
  { id: "integrity", label: "Integrity" },
  { id: "package", label: "Package Integrity" },
  { id: "full-custody", label: "Forensic Chain" },
  { id: "access", label: "Access Activity" },
];

type VerifyLinkNotice = { kind: "LINK_ENDED" | "RATE_LIMITED"; title: string; detail: string };

/** AUD-28 — the expected, non-failure answers of the verify API, in plain words. */
function verifyLinkNoticeOf(err: unknown): VerifyLinkNotice | null {
  const status = (err as { statusCode?: number } | null)?.statusCode;
  if (status === 410) {
    return {
      kind: "LINK_ENDED",
      title: "This verification link is no longer active",
      detail: "The link was revoked, expired or used up by the person who shared it. Ask them for a new link.",
    };
  }
  if (status === 429) {
    return {
      kind: "RATE_LIMITED",
      title: "Too many checks in a short time",
      detail: "Please wait a minute and reload this page.",
    };
  }
  return null;
}

export default function VerifyPage() {
  // The location words in the reader's language (en / de / ar).
  const verifyLocationCopy = evidenceLocationCopy(useLocale().locale);
  const params = useParams<{ token: string }>();
  const { addToast } = useToast();

  const [error, setError] = useState<string | null>(null);
  // AUD-28 (2026-10-20): an ended link and a rate limit are states, not failures.
  const [linkNotice, setLinkNotice] = useState<VerifyLinkNotice | null>(null);
  const [loading, setLoading] = useState(true);
  // Decision B — a BASIC answer carries only the basic projection.
  const [basicOnly, setBasicOnly] = useState<BasicVerification | null>(null);
  // CANONICAL VERIFICATION (owner decision 2026-10-14) — the canonical page's
  // facts, or the truthful state of a reference it cannot show as active.
  const [canonicalFacts, setCanonicalFacts] = useState<CanonicalVerificationFacts | null>(null);
  const [canonicalState, setCanonicalState] = useState<CanonicalVerificationState | null>(null);
  // ET-PKG-07 — which kind of link was used, and when it stops working.
  const [verifyLink, setVerifyLink] = useState<VerifyLinkInfo | null>(null);
  // ET-SM-07 — the stored-file recheck state, shown on the rich view too.
  const [storedBytes, setStoredBytes] = useState<BasicVerification["storedBytes"] | null>(null);

  // THE answer, as the API sent it. Every section reads it; none re-derives a status.
  const [response, setResponse] = useState<VerifyResponse | null>(null);
  const [serverVerificationMatrix, setServerVerificationMatrix] = useState<VerificationMatrix | null>(null);
  // Phase 2 closure — canonical OutputContext (snapshot vs live semantics).
  const [outputContext, setOutputContext] = useState<VerifyResponse["outputContext"]>(null);
  const [refreshingAnchoring, setRefreshingAnchoring] = useState(false);
  const [activeTechnicalTab, setActiveTechnicalTab] = useState<TechnicalTabId>("record");
  // AUD-48 (2026-10-20) — a printed page carries EVERY technical tab, not only
  // the one that happened to be open: each panel mounts while printing.
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    const on = () => setPrinting(true);
    const off = () => setPrinting(false);
    window.addEventListener("beforeprint", on);
    window.addEventListener("afterprint", off);
    return () => {
      window.removeEventListener("beforeprint", on);
      window.removeEventListener("afterprint", off);
    };
  }, []);
  const showTab = (id: TechnicalTabId) => printing || activeTechnicalTab === id;
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

  // Applied from the token-fetch effect AND from its poller. Held in a ref so
  // late poll results always run the CURRENT applier.
  const applyVerifyResponse = (data: VerifyResponse) => {
    setResponse(data);
    setServerVerificationMatrix(parseVerificationMatrix(data.verificationMatrix));
    setOutputContext(data.outputContext ?? null);
  };
  const applyVerifyResponseRef = useRef(applyVerifyResponse);
  applyVerifyResponseRef.current = applyVerifyResponse;

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

    const fetchVerify = async (options: { background?: boolean; manual?: boolean } = {}) => {
      const background = options.background === true;
      const manual = options.manual === true;
      try {
        const data = await apiFetch(`/public/verify/${encodeURIComponent(params.token)}`);
        if (cancelled || !isMountedRef.current) return;
        setLinkNotice(null);

        setVerifyLink((data as { link?: VerifyLinkInfo } | null)?.link ?? null);
        const canonical = (data as { canonicalVerification?: { status?: string } } | null)?.canonicalVerification;
        if (canonical?.status === "RETAINED") {
          setCanonicalState("RETAINED");
          setError(null);
          clearPolling();
          return;
        }
        setCanonicalState(null);
        setCanonicalFacts(canonical?.status === "AVAILABLE" ? (canonical as CanonicalVerificationFacts) : null);
        const tier = (data as { tier?: unknown } | null)?.tier;
        if (tier === "BASIC") {
          setBasicOnly((data as { basicVerification: BasicVerification }).basicVerification);
          setServerVerificationMatrix(
            parseVerificationMatrix((data as { verificationMatrix?: unknown }).verificationMatrix),
          );
          setError(null);
          clearPolling();
          return;
        }
        setBasicOnly(null);
        setStoredBytes(
          (data as { basicVerification?: BasicVerification } | null)?.basicVerification?.storedBytes ?? null,
        );

        applyVerifyResponseRef.current(data as VerifyResponse);

        if (!background) {
          setError(null);
        }

        // AUD-48 (2026-10-20) — no automatic re-poll: the API never
        // recommended one (the flag was always false), so the branch could not
        // run. The reader refreshes explicitly.
        clearPolling();

        if (manual) {
          addToast("Anchoring status refreshed", "info");
        }
      } catch (err) {
        if (cancelled || !isMountedRef.current) return;

        // CANONICAL VERIFICATION — a reference the page cannot show as an
        // active record answers with its truthful state, not an error.
        const stateCode = (err as { code?: string } | null)?.code;
        const truthful: CanonicalVerificationState | null =
          canonicalVerificationStateFromCode(stateCode) ??
          ((err as { statusCode?: number } | null)?.statusCode === 404 &&
                    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(params.token))
                  ? // An old record-id link: the API answers the same 404 as for
                    // anything unknown (anti-enumeration); the page says what it is.
                    "LEGACY_LINK_RETIRED"
                  : null);
        if (truthful) {
          setCanonicalState(truthful);
          setError(null);
          clearPolling();
          return;
        }

        // AUD-28 (2026-10-20): a share link that has ended (410: revoked,
        // expired, used up) or a rate limit (429) is an expected answer — a
        // neutral state, never "Verification Failed" and never a Sentry event.
        const notice = verifyLinkNoticeOf(err);
        if (notice) {
          setLinkNotice(notice);
          setError(null);
          if (notice.kind === "LINK_ENDED") clearPolling();
          return;
        }

        // ET-PKG-13 — the token is the capability to the record; it never goes
        // to Sentry. The feature tag is enough to find the failure.
        captureException(err, { feature: "web_verify" });

        if (!background) {
          const message = toSafeUserError(err, { message: "Verification failed" }).message;
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

  // ---- What the API returned, read once (no re-derivation) -----------------
  const data = response;
  // 2026-10-08 — the wire decision is read through readStoredTrustDecision:
  // an API deployed before the verification matrix still sends a score,
  // weighted points, a verdict and a reliance level; none of it survives.
  const trustDecision = useMemo(() => (data ? readStoredTrustDecision(data.trustDecision) : null), [data]);
  const verificationMatrix = serverVerificationMatrix;
  const matrixRow = (key: string) => verificationMatrix?.rows.find((row) => row.key === key) ?? null;
  const recordFacts = data?.recordFacts ?? null;
  const disclosure = data?.disclosure ?? null;
  const overview = data?.overview ?? null;
  const humanSummary = data?.humanSummary ?? null;
  const tsaDetails = useMemo(() => (data ? buildTsaDetails(data) : null), [data]);
  const otsDetails = useMemo(() => (data ? buildOtsDetails(data) : null), [data]);
  const otsView = otsDetails?.view ?? readOtsAnchoringView(null);
  const forensicTimeline = useMemo(() => (data ? readForensicChain(data) : []), [data]);
  const forensicGroups = useMemo(() => groupForensicEvents(forensicTimeline), [forensicTimeline]);
  const evidenceItems = useMemo(
    () => (Array.isArray(data?.evidenceContent?.items) ? data!.evidenceContent!.items! : []),
    [data],
  );
  const evidenceContentSummary = data?.evidenceContent?.summary ?? null;
  const hash = data?.technicalMaterials?.fileSha256 ?? data?.fileSha256 ?? null;
  const fingerprintHash = data?.technicalMaterials?.fingerprintHash ?? data?.fingerprintHash ?? null;
  const signature = data?.technicalMaterials?.signatureBase64 ?? data?.signatureBase64 ?? null;
  const publicKeyPem = data?.technicalMaterials?.publicKeyPem ?? data?.publicKeyPem ?? null;
  const signingKeyId = data?.technicalMaterials?.signingKeyId ?? data?.signingKeyId ?? null;
  const signingKeyVersion = data?.technicalMaterials?.signingKeyVersion ?? data?.signingKeyVersion ?? null;
  // The custody check's own sentence when it failed (the status is the matrix row).
  const integrity = data ? data.integrityProof ?? data.verification ?? null : null;
  const custodyChainFailureReason = integrity?.custodyChainFailureReason ?? null;
  const captureContext = data?.captureContext ?? null;
  const technicalMetadata = (data as { technicalMetadata?: VerifyTechnicalMetadata | null } | null)?.technicalMetadata ?? null;
  const redaction = ((data as { redaction?: VerifyRedaction | null } | null)?.redaction ?? null) as VerifyRedaction | null;
  const acquisition = data ? readPublicVerifyAcquisition(data) : null;
  const captureManifest = data ? readPublicCaptureManifest(data) : null;
  const locationState = data ? readVerifyLocationState(data) : null;
  const reference = recordFacts?.verificationReference ?? canonicalFacts?.reference ?? null;
  const canonicalIssuedAtUtc = canonicalFacts?.issuedAtUtc ?? null;
  // Wire contract D — digest semantics follow the STORED parts (a screen
  // recording is one item but its digest is the multipart package digest).
  const technicalPartCount = Math.max(
    data?.evidenceContent?.artifacts?.technical?.storedPartCount ?? 0,
    evidenceItems.length,
  );
  const isMultipart =
    technicalPartCount > 1 || (recordFacts?.itemCount ?? evidenceContentSummary?.itemCount ?? 0) > 1;

  const otsFacts: OtsFacts = {
    bitcoinBlockHeight: otsView.bitcoinBlockHeight,
    anchoredAtUtc: otsView.anchoredAtUtc,
    bitcoinTxid: otsView.bitcoinTxid,
    proofSha256: otsView.proofSha256,
    chain: otsView.chain,
    sentence: otsView.state !== "NOT_REQUESTED" ? otsView.sentence : null,
    failureLabel: otsView.failureLabel,
    boundary: otsBoundaryFor(otsView),
    statusWord: otsView.status,
  };

  const hasCaptureLocation = hasCaptureLocationMetadata({
    lat: captureContext?.lat,
    lng: captureContext?.lng,
  });

  // The Record tab's facts — record metadata as the API returned it. The
  // verification statuses live in the matrix; identity in recordFacts.
  const summaryFields = [
    { label: "Evidence Title", value: overview?.evidenceTitle ?? humanSummary?.evidenceTitle ?? null },
    { label: "Evidence Type", value: overview?.evidenceType ?? humanSummary?.evidenceType ?? null },
    { label: "Evidence Structure", value: overview?.evidenceStructure ?? humanSummary?.evidenceStructure ?? null },
    // UC-0 — the acquisition label ("Not recorded" for a legacy record), never a structure enum.
    { label: "Acquisition", value: acquisition?.acquisition.label ?? overview?.captureMethod ?? null },
    { label: "Created At", value: overview?.createdAt ?? humanSummary?.createdAt ?? null, time: true },
    // UC-PROV-001 — the server clock at record creation, never a capture time.
    { label: "Server received at", value: overview?.capturedAtUtc ?? humanSummary?.capturedAtUtc ?? null, time: true },
    { label: "Uploaded At", value: overview?.uploadedAtUtc ?? humanSummary?.uploadedAtUtc ?? null, time: true },
    { label: "Signed At", value: overview?.signedAtUtc ?? humanSummary?.signedAtUtc ?? null, time: true },
    // Reserved for real verification events; page views are tracked separately.
    { label: "Last meaningful verification", value: overview?.lastVerifiedAtUtc ?? humanSummary?.lastVerifiedAtUtc ?? null, time: true },
    {
      label: "Last public verify page view",
      value: overview?.lastPublicVerifyViewAtUtc ?? humanSummary?.lastPublicVerifyViewAtUtc ?? null,
      time: true,
    },
    {
      label: "Current public verify page view",
      value: overview?.currentPublicVerifyViewAtUtc ?? humanSummary?.currentPublicVerifyViewAtUtc ?? null,
      time: true,
    },
  ]
    .filter((field) => Boolean(field.value))
    .map((field) => ({ label: field.label, value: field.time ? formatDateTime(field.value) : String(field.value) }));
  const recordTabFields = selectRecordTabFields(summaryFields);

  const technicalFacts = [
    { label: "Timestamp provider", value: tsaDetails?.provider ?? null },
    // AUD-17: an unvalidated token's own time and serial are its claims, labelled so.
    { label: tsaClaimLabel("Timestamp time", tsaDetails?.claimsBasis), value: tsaDetails?.genTimeUtc ? formatDateTime(tsaDetails.genTimeUtc) : null },
    { label: tsaClaimLabel("Timestamp serial", tsaDetails?.claimsBasis), value: tsaDetails?.serialNumber ?? null },
    { label: "Timestamp hash algorithm", value: tsaDetails?.hashAlgorithm ?? null },
    { label: "Signing key", value: signingKeyId },
    { label: "Signing key version", value: signingKeyVersion != null ? String(signingKeyVersion) : null },
    { label: "OTS calendar", value: otsDetails?.calendar ?? null },
  ].filter((fact): fact is { label: string; value: string } => Boolean(fact.value));

  const heroTitleSize = "clamp(1.8rem, 6vw, 3.1rem)";
  const heroTextSize = "clamp(0.95rem, 1.15vw, 1rem)";

  const glassCardStyle: CSSProperties = {
    border: `1px solid ${VERIFY_BRAND.line}`,
    background: "linear-gradient(180deg, rgba(255,255,255,0.94) 0%, rgba(250,251,249,0.90) 100%)",
    boxShadow: "0 18px 44px rgba(16, 32, 29, 0.075)",
    borderRadius: 22,
    minWidth: 0,
  };

  const glassPanelStyle: CSSProperties = {
    border: `1px solid ${VERIFY_BRAND.softLine}`,
    background: "linear-gradient(180deg, rgba(255,255,255,0.88) 0%, rgba(248,249,247,0.82) 100%)",
    borderRadius: 18,
    minWidth: 0,
  };

  const VERIFY_HEADER_IMAGE = "/assets/branding/report-header.png";

  if (canonicalState && !loading) {
    return <CanonicalVerificationStateView state={canonicalState} />;
  }

  if (basicOnly && !loading) {
    return (
      <BasicVerificationView
        data={basicOnly}
        link={verifyLink}
        matrix={serverVerificationMatrix}
        canonical={canonicalFacts}
      />
    );
  }

  const pageBackgroundStyle: CSSProperties = {
    background:
      "radial-gradient(circle at 12% 0%, rgba(11,46,39,0.055), transparent 30%), radial-gradient(circle at 90% 8%, rgba(96,66,24,0.045), transparent 26%), linear-gradient(180deg, #f6f7f4 0%, #f8faf8 42%, #f2f4f1 100%)",
  };

  const copyVerificationLink = () => {
    // The record's canonical address — never the link the visitor happened to hold.
    const url = reference
      ? `${window.location.origin}/verify/${encodeURIComponent(reference)}`
      : window.location.href;
    void navigator.clipboard?.writeText(url);
    addToast("Verification link copied", "success");
  };

  return (
    <div
      className="page verify-enterprise-font verify-page-root"
      style={{
        ...VERIFY_TYPO.page,
        fontFamily: "var(--font-jakarta), ui-sans-serif, system-ui, sans-serif",
        maxWidth: "100%",
      }}
    >
      <style>{VERIFY_PAGE_CSS}</style>
      <section
        className="section"
        style={{
          position: "relative",
          paddingTop: 24,
          paddingBottom: 42,
          minHeight: "100vh",
          ...pageBackgroundStyle,
        }}
      >
        <div className="container" style={{ position: "relative", zIndex: 1, minWidth: 0 }}>
          {/* ET-SM-07 — before any verdict below: whether the STORED FILE was
              re-read against its signed hash, and when. */}
          <VerifyLinkNotice link={verifyLink} />
          {storedBytes ? <StoredBytesNotice integrity={storedBytes} /> : null}
          <div
            data-print-hide
            style={{
              marginBottom: 24,
              width: "100%",
              minHeight: 72,
              borderRadius: 26,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 12,
              padding: "12px 16px",
              border: `1px solid ${VERIFY_BRAND.softLine}`,
              boxShadow: "0 18px 42px rgba(7, 26, 58, 0.10)",
            }}
          >
            <img
              src={VERIFY_HEADER_IMAGE}
              alt="PROOVRA — Integrity in Every Evidence"
              style={{
                display: "block",
                width: "min(430px, 100%)",
                maxHeight: 58,
                objectFit: "contain",
                objectPosition: "left center",
                minWidth: 0,
                flex: "1 1 180px",
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
            <div style={{ minWidth: 0, flex: "1 1 320px" }}>
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
                Evidence Verification
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
                Each verification signal as PROOVRA&apos;s records and stored proofs show it, the record&apos;s facts,
                its issued reports and packages, and its forensic custody chain.
              </p>
            </div>

            {reference ? (
              <div
                data-verify-hero-reference
                style={{
                  padding: "10px 14px",
                  borderRadius: 999,
                  border: `1px solid ${VERIFY_BRAND.line}`,
                  background: "rgba(255,255,255,0.42)",
                  color: VERIFY_BRAND.ink,
                  fontSize: 12,
                  fontWeight: 800,
                  maxWidth: "100%",
                  overflowWrap: "anywhere",
                }}
              >
                Verification reference: {reference}
              </div>
            ) : null}
          </div>

          {loading ? (
            <div style={{ display: "grid", gap: 18 }}>
              <Card>
                <div style={{ display: "grid", gap: 14 }}>
                  <Skeleton width="42%" height="18px" />
                  <Skeleton width="100%" height="72px" />
                  <Skeleton width="100%" height="78px" />
                </div>
              </Card>
            </div>
          ) : linkNotice ? (
            <Card>
              <div data-testid="verify-link-notice" data-notice={linkNotice.kind}>
                <EmptyState title={linkNotice.title} subtitle={linkNotice.detail} />
              </div>
            </Card>
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
          ) : !data || (!hash && !signature && evidenceItems.length === 0 && !overview && !humanSummary && !recordFacts && !verificationMatrix) ? (
            <Card>
              <EmptyState
                title="Evidence Not Found"
                subtitle="The evidence token is invalid, unavailable, or no verification materials were returned."
                action={() => <Button onClick={() => (window.location.href = "/")}>Back to Home</Button>}
              />
            </Card>
          ) : (
            <div style={{ display: "grid", gap: 18, minWidth: 0 }}>
              <VerificationSummaryCard matrix={verificationMatrix} decision={trustDecision} />
              {outputContext ? <OutputContextBadge outputContext={outputContext} /> : null}
              {disclosure ? <DisclosureNotice disclosure={disclosure} /> : null}
              {recordFacts ? (
                <RecordFactsCard facts={recordFacts} canonicalIssuedAtUtc={canonicalIssuedAtUtc} addToast={addToast} />
              ) : null}
              <ConsistencyReasons reasons={data.trustDecisionConsistency?.reasons ?? []} />

              <section aria-labelledby="verify-matrix-heading" data-verify-card style={{ ...glassCardStyle, padding: "clamp(16px, 4vw, 24px)", display: "grid", gap: 18 }}>
                <div>
                  <div style={{ ...VERIFY_TYPO.kicker, fontSize: 11, marginBottom: 8 }}>Verification Matrix</div>
                  <h2 id="verify-matrix-heading" style={{ ...VERIFY_TYPO.h3, fontSize: 22, margin: "0 0 8px" }}>
                    What was checked, signal by signal
                  </h2>
                  <div data-testid="verify-matrix-intro" style={{ ...VERIFY_TYPO.small, maxWidth: 860 }}>
                    {VERIFY_MATRIX_INTRO}
                  </div>
                </div>
                {verificationMatrix ? (
                  <VerificationMatrixGrid rows={verificationMatrix.rows} />
                ) : (
                  <div style={{ ...VERIFY_TYPO.value }}>{VERIFY_MATRIX_UNAVAILABLE}</div>
                )}
              </section>

              <OtsAnchoringCard
                row={matrixRow("ots_anchoring")}
                facts={otsFacts}
                snapshot={data.verificationSnapshot ?? null}
                liveAnchoring={data.liveAnchoring ?? null}
                addToast={addToast}
              />

              <ArtifactHistory
                versioning={data.versioning ?? null}
                snapshot={data.verificationSnapshot ?? null}
                liveAnchoring={data.liveAnchoring ?? null}
                tsaRow={matrixRow("tsa_token")}
                canonicalIssuedAtUtc={canonicalIssuedAtUtc}
                forensicEvents={forensicTimeline}
                consistencyReasons={data.trustDecisionConsistency?.reasons ?? []}
              />

              {hasCaptureLocation && captureContext ? (
                <section
                  aria-labelledby="verify-recorded-location"
                  data-testid="verify-recorded-location"
                  data-verify-card
                  style={{ ...glassCardStyle, padding: "clamp(16px, 4vw, 24px)", display: "grid", gap: 18 }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ ...VERIFY_TYPO.kicker, fontSize: 11, marginBottom: 8 }}>Recorded Location</div>
                    <h2 id="verify-recorded-location" style={{ ...VERIFY_TYPO.h3, fontSize: 22, margin: "0 0 8px" }}>
                      {verifyLocationCopy.states.RECORDED.label}
                    </h2>
                    <div style={{ ...VERIFY_TYPO.body, maxWidth: 860 }}>
                      {captureContext.description ?? CAPTURE_LOCATION_CONTEXT_DESCRIPTION}
                    </div>
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))",
                      gap: 18,
                      alignItems: "stretch",
                    }}
                  >
                    <div style={{ overflow: "hidden", borderRadius: 22, minWidth: 0 }}>
                      {captureContext.lat != null && captureContext.lng != null ? (
                        <CaptureLocationMapPanel
                          showBoundary={false}
                          lat={captureContext.lat}
                          lng={captureContext.lng}
                          accuracyMeters={captureContext.accuracyMeters}
                          addToast={addToast}
                          height={280}
                          sourceLabel={captureContext.source ?? null}
                        />
                      ) : null}
                    </div>
                    <div style={{ display: "grid", gap: 10, alignContent: "start" }}>
                      {[
                        ["Latitude (device-reported)", formatCaptureLocationCoordinate(captureContext.lat)],
                        ["Longitude (device-reported)", formatCaptureLocationCoordinate(captureContext.lng)],
                        ["Accuracy radius (device-reported)", formatCaptureLocationAccuracy(captureContext.accuracyMeters)],
                        ["Server received at", formatDateTime(captureContext.capturedAtUtc ?? null)],
                        ...(captureContext.deviceTimeIso ? [["Device-reported time", captureContext.deviceTimeIso]] : []),
                        ["Source", captureContext.source ?? CAPTURE_LOCATION_SOURCE_LABEL],
                      ].map(([label, value]) => (
                        <div key={label} style={{ ...glassPanelStyle, padding: 14, display: "grid", gap: 5 }}>
                          <div data-verify-label style={{ ...VERIFY_TYPO.kicker, fontSize: 10.5 }}>{label}</div>
                          <div style={{ ...VERIFY_TYPO.value, fontSize: 14, overflowWrap: "anywhere" }}>{value}</div>
                        </div>
                      ))}
                      <div style={{ ...glassPanelStyle, borderLeft: `5px solid ${VERIFY_BRAND.bronze}`, padding: 16 }}>
                        <div style={{ ...VERIFY_TYPO.small, fontSize: 12.5, color: VERIFY_BRAND.ink }}>
                          {captureContext.legalBoundary ?? CAPTURE_LOCATION_LEGAL_BOUNDARY ?? CAPTURE_LOCATION_SHORT_BOUNDARY}
                        </div>
                      </div>
                    </div>
                  </div>
                </section>
              ) : (
                <VerifyLocationStateSection location={locationState} />
              )}

              <VerifyTechnicalMetadataSection technicalMetadata={technicalMetadata} typo={VERIFY_TYPO} brand={VERIFY_BRAND} />
              {/* UC-0 — "How this record was acquired", from the typed acquisition projection. */}
              <VerifyCaptureIntegritySection acquisition={acquisition} typo={VERIFY_TYPO} brand={VERIFY_BRAND} />
              <VerifyCaptureManifestSection facts={captureManifest} />
              <VerifyRedactionSection redaction={redaction} typo={VERIFY_TYPO} brand={VERIFY_BRAND} />

              {evidenceItems.length > 0 ? (
                disclosure?.mode === "VERIFICATION_ONLY" ? (
                  <ItemInventoryTable items={evidenceItems} addToast={addToast} />
                ) : (
                  <ContentPreviewSurface
                    items={evidenceItems}
                    artifacts={data.evidenceContent?.artifacts ?? null}
                    summary={evidenceContentSummary}
                    primaryItem={data.evidenceContent?.primaryItem ?? null}
                    defaultPreviewItemId={data.evidenceContent?.defaultPreviewItemId ?? null}
                    previewPolicy={data.evidenceContent?.previewPolicy ?? null}
                    contentAccessPolicy={data.contentAccessPolicy ?? null}
                    contentExposureDecision={data.contentExposureDecision ?? null}
                  />
                )
              ) : null}

              <section aria-labelledby="verify-technical-heading" data-verify-card style={{ ...glassCardStyle, padding: "clamp(16px, 4vw, 24px)", display: "grid", gap: 18 }}>
                <div>
                  <h2 id="verify-technical-heading" style={{ margin: 0, ...VERIFY_TYPO.h3 }}>
                    Technical Review Materials
                  </h2>
                  <div style={{ marginTop: 7, ...VERIFY_TYPO.small, maxWidth: 820 }}>
                    The raw hashes, signatures, package seal, forensic custody chain and access activity behind the
                    verification matrix above.
                  </div>
                </div>
                <div
                  data-print-hide
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 12,
                    flexWrap: "wrap",
                    padding: 14,
                    borderRadius: 18,
                    border: `1px solid ${forensicMode ? VERIFY_BRAND.accent : VERIFY_BRAND.line}`,
                  }}
                >
                  <div style={{ minWidth: 0, flex: "1 1 220px" }}>
                    <div style={{ ...VERIFY_TYPO.kicker, fontSize: 10.5, marginBottom: 4 }}>Forensic Review Mode</div>
                    <div style={{ ...VERIFY_TYPO.small, fontSize: 13, color: VERIFY_BRAND.ink }}>
                      {forensicMode
                        ? "Raw technical materials are expanded for forensic review."
                        : "Enable to expand raw hashes, signatures, public key material, custody hashes, and timestamp proof fields."}
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-pressed={forensicMode}
                    onClick={() => setForensicMode((value) => !value)}
                    style={{
                      minHeight: 42,
                      padding: "10px 16px",
                      borderRadius: 999,
                      border: `1px solid ${forensicMode ? VERIFY_BRAND.accent : VERIFY_BRAND.line}`,
                      background: forensicMode ? VERIFY_BRAND.accent : "rgba(255,255,255,0.62)",
                      color: forensicMode ? "#ffffff" : VERIFY_BRAND.accent,
                      fontSize: 11,
                      fontWeight: 900,
                      letterSpacing: "0.06em",
                      textTransform: "uppercase",
                      cursor: "pointer",
                    }}
                  >
                    {forensicMode ? "Disable Forensic Mode" : "Enable Forensic Mode"}
                  </button>
                </div>

                <VerifyTabs tabs={TECHNICAL_TABS} active={activeTechnicalTab} onChange={setActiveTechnicalTab} label="Technical review materials" />

                {showTab("record") ? (
                  <VerifyTabPanel id="record">
                    <div style={{ ...BRONZE_RAIL_STYLE, padding: 16, ...VERIFY_TYPO.small, fontSize: 13, color: VERIFY_BRAND.ink }}>
                      Record metadata as returned for this page. It identifies the preserved record and is separate
                      from the cryptographic proof and from the custody chain.
                    </div>
                    {recordTabFields.length > 0 ? (
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: 14 }}>
                        {recordTabFields.map((field) => (
                          <SummaryField key={field.label} label={field.label} value={field.value} />
                        ))}
                      </div>
                    ) : null}
                  </VerifyTabPanel>
                ) : null}

                {showTab("integrity") ? (
                  <VerifyTabPanel id="integrity">
                    {verificationMatrix ? (
                      <VerificationMatrixGrid
                        rows={verificationMatrix.rows.filter((row) =>
                          ["file_integrity", "record_signature", "tsa_token", "storage_protection"].includes(row.key),
                        )}
                      />
                    ) : (
                      <div style={{ ...VERIFY_TYPO.value }}>{VERIFY_MATRIX_UNAVAILABLE}</div>
                    )}

                    {hash ? (
                      <MaterialField
                        label={
                          isMultipart
                            ? "Canonical Package Digest (SHA-256)"
                            : tsaDetails?.inputKind && tsaDetails.inputKind !== "FILE_SHA256"
                              ? "File Digest (SHA-256)"
                              : "Original File SHA-256"
                        }
                        subtitle={
                          isMultipart
                            ? `${PROOVRA_MULTIPART_REVIEWER_EXPLANATION} ${PROOVRA_MULTIPART_RECOMPUTATION_NOTE}`
                            : "SHA-256 digest of the original preserved evidence file."
                        }
                        value={hash}
                        forensicMode={forensicMode}
                        addToast={addToast}
                        copyMessage={isMultipart ? "Canonical package digest copied" : "File digest copied"}
                      />
                    ) : null}

                    {isMultipart ? (
                      <div style={{ ...BRONZE_RAIL_STYLE, padding: 16, display: "grid", gap: 8 }}>
                        <div style={{ ...VERIFY_TYPO.kicker, fontSize: 10.5 }}>Multipart integrity boundary</div>
                        <div style={{ ...VERIFY_TYPO.small, fontSize: 13, color: VERIFY_BRAND.ink }}>
                          {PROOVRA_MULTIPART_REVIEWER_EXPLANATION} {PROOVRA_MULTIPART_RECOMPUTATION_NOTE}{" "}
                          {PROOVRA_MULTIPART_LEGAL_BOUNDARY_NOTE}
                        </div>
                      </div>
                    ) : null}

                    {tsaDetails?.inputDigestHex && tsaDetails.inputDigestHex !== hash ? (
                      <MaterialField
                        label={
                          tsaDetails.timestampedDigestLabel ??
                          getTimestampDigestLabel({ itemCount: technicalPartCount, tsaInputKind: tsaDetails.inputKind })
                        }
                        subtitle={
                          tsaDetails.timestampedDigestNote ??
                          "This value may differ from the original file SHA-256 when the timestamp is applied to canonical evidence or fingerprint material."
                        }
                        value={tsaDetails.inputDigestHex}
                        forensicMode={forensicMode}
                        addToast={addToast}
                        copyMessage="Timestamped digest copied"
                      />
                    ) : null}

                    {tsaDetails?.legacyMode ? (
                      <div style={{ ...VERIFY_TYPO.small, color: VERIFY_BRAND.subtle }}>
                        Legacy mode: this record predates explicit timestamp-input digest storage.
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
                        subtitle="Public key material available for independent verification."
                        value={publicKeyPem}
                        addToast={addToast}
                        copyMessage="Public key copied"
                      />
                    ) : null}
                    {otsDetails?.proofBase64 ? (
                      <MaterialField
                        label="OpenTimestamps Proof"
                        forensicMode={forensicMode}
                        subtitle="Recorded OTS proof material for the evidence digest."
                        value={otsDetails.proofBase64}
                        addToast={addToast}
                        copyMessage="OTS proof copied"
                      />
                    ) : null}

                    {technicalFacts.length > 0 ? (
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: 14 }}>
                        {technicalFacts.map((fact) => (
                          <SummaryField key={fact.label} label={fact.label} value={fact.value} />
                        ))}
                      </div>
                    ) : null}

                    {tsaDetails?.failureReason ? (
                      <div style={{ ...glassPanelStyle, borderLeft: `5px solid ${VERIFY_BRAND.warning}`, padding: 16 }}>
                        <div style={{ ...VERIFY_TYPO.kicker, fontSize: 10.5, marginBottom: 8 }}>Timestamp request note</div>
                        <div style={{ ...VERIFY_TYPO.small, fontSize: 13, color: VERIFY_BRAND.ink, overflowWrap: "anywhere" }}>
                          {tsaDetails.failureReason}
                        </div>
                      </div>
                    ) : null}
                  </VerifyTabPanel>
                ) : null}

                {showTab("package") ? (
                  <VerifyTabPanel id="package">
                    <PackageIntegrityCard integrity={data.verificationPackageIntegrity ?? null} />
                    <div style={{ ...BRONZE_RAIL_STYLE, padding: 16, display: "grid", gap: 8 }}>
                      <div style={{ ...VERIFY_TYPO.kicker, fontSize: 10.5 }}>Package verification scope</div>
                      <div style={{ ...VERIFY_TYPO.small, fontSize: 13, color: VERIFY_BRAND.ink }}>
                        Package integrity is separate from evidence integrity. Evidence integrity verifies the preserved
                        evidence state; the package seal and completeness state whether the exported bundle is bound by
                        its signature and carries what it lists. A record&apos;s verification does not depend on one: the
                        fingerprint, signature, timestamp, anchoring and custody materials are stated on this page.
                      </div>
                    </div>
                  </VerifyTabPanel>
                ) : null}

                {showTab("full-custody") ? (
                  <VerifyTabPanel id="full-custody">
                    <div style={{ ...VERIFY_TYPO.small, fontSize: 13, color: VERIFY_BRAND.ink }}>
                      {typeof data.custodyLifecycle?.forensicEventCount === "number"
                        ? `${data.custodyLifecycle.forensicEventCount} forensic event${data.custodyLifecycle.forensicEventCount === 1 ? "" : "s"} recorded. `
                        : ""}
                      Event hashes are shown in forensic review mode for chain-continuity review.
                      {data.custodyLifecycle?.truncated
                        ? ` Showing the latest recorded events (up to ${data.custodyLifecycle.displayLimit ?? 500}); the chain-integrity check covers all of them.`
                        : ""}
                    </div>
                    {custodyChainFailureReason ? (
                      <div style={{ ...glassPanelStyle, borderLeft: `5px solid ${VERIFY_BRAND.danger}`, padding: 16, ...VERIFY_TYPO.small, fontSize: 13, color: VERIFY_BRAND.ink }}>
                        <span aria-hidden="true">✕ </span>Custody chain check: {custodyChainVerdictLabel({ valid: false, reason: custodyChainFailureReason })}
                      </div>
                    ) : null}
                    {forensicTimeline.length === 0 ? (
                      <div style={{ ...VERIFY_TYPO.small, fontSize: 13 }}>No forensic custody events were returned in this response.</div>
                    ) : null}
                    <ForensicChainGroup
                      title="Forensic chain — evidence events"
                      subtitle="Integrity-relevant lifecycle events of the evidence, in hash-chain order."
                      events={forensicGroups.integrity}
                      forensicMode={forensicMode}
                    />
                    <ForensicChainGroup
                      title="Forensic chain — administrative events"
                      subtitle="How the record is reached or disclosed (for example its verification reference). They stay in the chain but say nothing about the evidence bytes, signatures or custody."
                      events={forensicGroups.administrative}
                      forensicMode={forensicMode}
                    />
                  </VerifyTabPanel>
                ) : null}

                {showTab("access") ? (
                  <VerifyTabPanel id="access">
                    <AccessActivitySummary activity={data.custodyLifecycle?.accessActivity ?? null} />
                  </VerifyTabPanel>
                ) : null}
              </section>

              <section aria-labelledby="verify-actions-heading" data-print-hide data-verify-card style={{ ...glassCardStyle, padding: "clamp(16px, 4vw, 24px)", display: "grid", gap: 18 }}>
                <div>
                  <h2 id="verify-actions-heading" style={{ margin: 0, ...VERIFY_TYPO.h3 }}>
                    Actions
                  </h2>
                  <div style={{ marginTop: 7, ...VERIFY_TYPO.small, maxWidth: 760 }}>
                    Copy this record&apos;s permanent verification link to share it.
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: 12 }}>
                  <button
                    type="button"
                    data-verify-copy-link
                    onClick={copyVerificationLink}
                    style={{
                      width: "100%",
                      minHeight: 52,
                      borderRadius: 999,
                      border: "1px solid rgba(196,165,91,0.42)",
                      background: "linear-gradient(180deg, #163f38 0%, #0b2e27 100%)",
                      color: "#ffffff",
                      fontSize: 12,
                      fontWeight: 900,
                      letterSpacing: "0.065em",
                      textTransform: "uppercase",
                      cursor: "pointer",
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
                      opacity: refreshingAnchoring ? 0.7 : 1,
                    }}
                    disabled={refreshingAnchoring}
                  >
                    {refreshingAnchoring ? "Checking anchoring status..." : "Check Latest Anchoring Status"}
                  </button>
                </div>
              </section>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
