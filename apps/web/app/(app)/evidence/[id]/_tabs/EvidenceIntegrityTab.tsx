/**
 * Phase EVIDENCE-IA-INTEGRITY — Integrity tab.
 *
 * Verification and preservation posture (human-readable). Technical
 * detail (manifest SHA, TSA imprint, hash semantics, snapshot-boundary
 * divergence detail, forensic event counts) moves to the Technical
 * Appendix tab.
 *
 * Phase EVIDENCE-DETAIL-REDESIGN — presentation only. The tab owns its
 * own presentation (section cards, facts grid, verification matrix,
 * boundary notes) instead of borrowing the generic KeyValueGrid, so a
 * change here cannot ripple into the other six tabs. No field was added,
 * removed or re-derived: every value below is the same expression the
 * previous build rendered.
 *
 * The matrix distinguishes seven states rather than flattening them into
 * one generic success chip. A state is derived from the SAME structured
 * field the value text is derived from — never from sniffing the
 * rendered string — so the chip can never claim more than the response.
 *
 * Phase 5 — copy refinement:
 *   "Preservation Matrix"                  → "Verification & preservation"
 *   "TSA timestamp"                        → "Timestamp proof (TSA)"
 *   "Verification History" + the row block → "Snapshot timing" (plain)
 *
 * Phase 1 — duplication removal:
 *   - Forensic event COUNTS removed here (full Custody timeline in
 *     the Custody tab is the canonical home).
 *   - Multipart manifest SHA-256 / TSA accepted message imprint /
 *     hash semantics / snapshot boundary divergence detail moved to
 *     the Technical Appendix.
 */

"use client";

import type { ReactNode } from "react";
import { Camera, FileSignature, History, MapPin, ShieldCheck, type LucideIcon } from "lucide-react";
import { EvidenceCertificationsPanel } from "../components/EvidenceCertificationsPanel";
import CaptureLocationMapPanel from "../../../../../components/capture-location/CaptureLocationMapPanel";
import LocationStateNote, { readLocationState } from "../../../../../components/capture-location/LocationStateNote";
import { custodyChainVerdictLabel, evidenceLocationCopy, evidenceRecordStatusLabel, objectLockModeLabel, recordSignaturePresentation } from "@proovra/shared";
import { useOptionalLocale } from "../../../../providers";
import type { AppTone } from "../../../../../components/app-primitives/AppStatusBadge";
import {
  describeClientSignalState,
  describePackageManifestStatus,
  describeReportArtifactStatus,
  describeReportPdfSignature,
  describeVerificationPackageStatus,
  formatValue,
  type EvidenceDetailCtx,
  type OtsStatusPresentation,
} from "./_lib";
import { EvidenceProvenanceChainSection } from "./EvidenceProvenanceChainSection";
import { formatUserDateTime } from "../../../../../lib/date";
import { describeStorageProtection, storedBytesVerificationRow } from "@proovra/shared";
import { parseTsaProofStatus, TSA_PROOF_STATUS_LABELS, type TsaProofStatus } from "@proovra/shared";
import { storageProtectionClassOf } from "../../lib/evidence-library-types";
import {
  displayAcquisition,
  displaySourceType,
  shouldShowContextSignal,
} from "../../../../../lib/evidence/source-display";

// ---------------------------------------------------------------------------
// Integrity state vocabulary
//
// These seven states are the ONLY ones this tab may claim, and each maps to
// exactly one canonical badge tone. None of them asserts authenticity,
// authorship, factual truth or legal admissibility: "Verified" means PROOVRA
// re-checked a recorded technical value against the material it was computed
// from, nothing more.
// ---------------------------------------------------------------------------

/** AUD-26 — the one sentence for which verdict the owner page shows. */
export function verdictBasisSentence(
  basis: { kind: "AS_ISSUED"; artifact: "REPORT" | "VERIFICATION_PACKAGE"; version: number | null; issuedAtUtc: string | null } | { kind: "LIVE" },
): string {
  if (basis.kind === "LIVE") return "The verification statuses on this page are the record's current state.";
  const what = basis.artifact === "REPORT" ? "report" : "verification package";
  const version = basis.version != null ? ` v${basis.version}` : "";
  const when = basis.issuedAtUtc ? ` on ${basis.issuedAtUtc.replace("T", " ").slice(0, 16)} UTC` : "";
  return `The verification statuses on this page are as issued with ${what}${version}${when}. Public Verify states the record as it is now.`;
}

type IntegrityState =
  | "verified"
  | "recorded"
  | "available"
  | "pending"
  | "unavailable"
  | "failed"
  | "not-applicable";

/** The canonical TSA proof status as this card's state (AUD-14). */
const TSA_INTEGRITY_STATE: Readonly<Record<TsaProofStatus, IntegrityState>> = {
  VALIDATED: "verified",
  RECORDED_NOT_VALIDATED: "recorded",
  PENDING: "pending",
  NOT_OBTAINED: "unavailable",
  NOT_REQUESTED: "unavailable",
  FAILED: "failed",
};

/**
 * RECORDED, AVAILABLE and VERIFIED are three different claims, and this card
 * makes all three about the same record at once.
 *
 * `recorded` is BLUE — the informational tone for a deterministic fact the
 * record carries ("a proof exists"). `available` is indigo ("an artifact can
 * be fetched") and `verified` keeps the green it has always had; the three
 * stay distinct, which is the whole job of a card whose reader is comparing
 * them. Blue here is the canonical `--info` text token, the same AA-safe blue
 * the app uses for informational state elsewhere — not a new colour.
 */
const STATE_PRESENTATION: Record<
  IntegrityState,
  { label: string; tone: AppTone }
> = {
  verified: { label: "Verified", tone: "green" },
  recorded: { label: "Recorded", tone: "blue" },
  available: { label: "Available", tone: "indigo" },
  pending: { label: "Pending", tone: "amber" },
  unavailable: { label: "Unavailable", tone: "slate" },
  failed: { label: "Failed", tone: "red" },
  "not-applicable": { label: "Not applicable", tone: "slate" },
};

/**
 * (2026-10-15) Bitcoin anchoring in this card's states, from THE verification
 * key — never the lifecycle state. Only CHAIN_VERIFIED (an independent check
 * against the Bitcoin main chain) is "verified"; an attestation the proof
 * merely names is "recorded"; FAILED and CHAIN_FAILED are "failed".
 */
export function otsIntegrityState(p: Pick<OtsStatusPresentation, "verification"> | null | undefined): IntegrityState {
  switch (p?.verification) {
    case "CHAIN_VERIFIED":
      return "verified";
    case "ATTESTATION_RECORDED":
      return "recorded";
    case "PENDING":
    case "CHAIN_CONFIRMATIONS_PENDING":
      return "pending";
    case "FAILED":
    case "CHAIN_FAILED":
      return "failed";
    case "NOT_REQUESTED":
      return "not-applicable";
    default:
      return "unavailable";
  }
}

type MatrixItem = {
  label: string;
  value: string;
  /** Omitted for descriptive rows that carry no state of their own. */
  state?: IntegrityState;
  /** The state word, when a shared vocabulary owns it (e.g. Stale / Mismatch). */
  stateLabel?: string;
  /** Descriptive rows span the full row so long prose stays readable. */
  wide?: boolean;
  /** The chip tone, when a shared vocabulary owns it (Bitcoin anchoring). */
  tone?: AppTone;
};

// ---------------------------------------------------------------------------
// Presentation primitives — owned by this tab
// ---------------------------------------------------------------------------

function IntegritySection({
  icon: Icon,
  title,
  description,
  actions,
  children,
  ...rest
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  actions?: ReactNode;
  children: ReactNode;
} & Record<`data-${string}`, string | undefined>) {
  return (
    <section className="evidence-detail-integrity-section" {...rest}>
      <div className="evidence-detail-integrity-section__head">
        <span className="evidence-detail-integrity-section__icon" aria-hidden="true">
          <Icon size={18} strokeWidth={2} />
        </span>
        <div className="evidence-detail-integrity-section__copy">
          <h2 className="evidence-detail-integrity-section__title">{title}</h2>
          <p className="evidence-detail-integrity-section__description">{description}</p>
        </div>
        {actions ? (
          <div className="evidence-detail-integrity-section__actions">{actions}</div>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function FactsGrid({ items }: { items: Array<{ label: string; value: string }> }) {
  return (
    <div className="evidence-detail-facts-grid" data-evidence-facts-grid>
      {items.map((item) => (
        <div key={item.label} className="evidence-detail-fact">
          <span className="evidence-detail-fact__label">{item.label}</span>
          <span className="evidence-detail-fact__value">{item.value}</span>
        </div>
      ))}
    </div>
  );
}

function MatrixGrid({ items }: { items: MatrixItem[] }) {
  return (
    <div className="evidence-detail-matrix" data-evidence-matrix>
      {items.map((item) => {
        const presentation = item.state ? STATE_PRESENTATION[item.state] : null;
        return (
          <div
            key={item.label}
            className="evidence-detail-matrix-cell"
            data-evidence-matrix-row={item.label}
            data-evidence-matrix-state={item.state ?? "none"}
            data-wide={item.wide ? "true" : undefined}
          >
            <div className="evidence-detail-matrix-cell__head">
              <span className="evidence-detail-matrix-cell__label">{item.label}</span>
              {/* The state word, as TEXT. Every cell in this card carries one,
                  so a grid of capsules put a tinted box beside every label on
                  the page — a wall of surfaces competing with the values
                  underneath them, which is what the reader is actually here to
                  read. One render site, so no row can keep the old treatment
                  by being an uncommon state. */}
              {presentation ? (
                <span
                  className="app-status-text evidence-detail-matrix-cell__state"
                  data-size="md"
                  data-tone={item.tone ?? presentation.tone}
                >
                  {item.stateLabel ?? presentation.label}
                </span>
              ) : null}
            </div>
            <span className="evidence-detail-matrix-cell__value">{item.value}</span>
          </div>
        );
      })}
    </div>
  );
}

function BoundaryNote({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="evidence-detail-boundary-note">
      <span className="evidence-detail-boundary-note__title">{title}</span>
      <p className="evidence-detail-boundary-note__body">{children}</p>
    </div>
  );
}

function BoundaryCallout({
  title,
  role,
  children,
  ...rest
}: {
  title: string;
  role: "alert" | "status";
  children: ReactNode;
} & Record<`data-${string}`, string | undefined>) {
  return (
    <div className="evidence-detail-boundary-callout" role={role} {...rest}>
      <span className="evidence-detail-boundary-callout__title">{title}</span>
      <p className="evidence-detail-boundary-callout__body">{children}</p>
    </div>
  );
}

export function EvidenceIntegrityTab({ ctx }: { ctx: EvidenceDetailCtx }) {
  const {
    workspace,
    preservation,
    workspaceCaps,
    otsStatusPresentation,
    showManualLatestStatusCheck,
    loadWorkspace,
    evidenceId,
  } = ctx;

  const packageIncluded = workspaceCaps.verificationPackageIncluded ?? false;

  // THE canonical location state (served by the review workspace).
  const locale = useOptionalLocale();
  const locationCopy = evidenceLocationCopy(locale);
  const location = readLocationState(workspace.locationState, workspace.sourceCaptureLocation, locale);

  // Every state below is derived from the SAME structured field its value
  // text is derived from. Closed helper vocabularies ("Available" /
  // "Pending" / "Blocked" / …) are mapped by their underlying booleans, not
  // by re-reading the rendered string.
  const verificationState: IntegrityState =
    preservation.verificationStatus === "RECORDED_INTEGRITY_VERIFIED"
      ? "verified"
      : preservation.verificationStatus === "MATERIALS_AVAILABLE"
        ? "available"
        : preservation.verificationStatus === "REVIEW_REQUIRED"
          ? "pending"
          : preservation.verificationStatus === "FAILED"
            ? "failed"
            : "unavailable";

  const fingerprintState: IntegrityState = !preservation.fingerprintHashRecorded
    ? "unavailable"
    : preservation.fingerprintCanonicalHashMatches === true
      ? "verified"
      : preservation.fingerprintCanonicalHashMatches === false
        ? "failed"
        : "recorded";

  // UC-TRUST-008 — the current stored file, worded and badged exactly as on
  // Public Verify. Stale / pending are amber, never green; only a fresh pass over
  // a pinned version is "verified".
  const storedBytesRow = preservation.storedBytes ? storedBytesVerificationRow(preservation.storedBytes) : null;
  const storedBytesState: IntegrityState = !storedBytesRow
    ? "unavailable"
    : storedBytesRow.checkStatus === "VERIFIED"
      ? "verified"
      : storedBytesRow.checkStatus === "MISMATCH" || preservation.storedBytes?.state === "failed"
        ? "failed"
        : storedBytesRow.checkStatus === "UNKNOWN"
          ? "unavailable"
          : "pending";

  // F-12 (independent forward audit) — THE signature presentation from its
  // validity state: an invalid, mismatched, revoked or unregistered-key
  // signature is a failure to verify, never a neutral "Recorded".
  const signaturePresentation = preservation.signature.recorded
    ? recordSignaturePresentation({
        validityState: preservation.signature.validityState ?? null,
        revokedAtUtc: preservation.signature.signingKeyRevokedAtUtc ?? null,
      })
    : { state: "unavailable" as const, label: "Not recorded" };
  const signatureState: IntegrityState = signaturePresentation.state;

  // AUD-14 (2026-10-20): the canonical proof status, one state per status.
  // A provider outage is "unavailable", never "failed"; a kept token never
  // validated is "recorded", never an amber "pending".
  const tsaProof = parseTsaProofStatus(preservation.tsa.proofStatus);
  const tsaState: IntegrityState = tsaProof
    ? TSA_INTEGRITY_STATE[tsaProof]
    : preservation.tsa.timestampAvailable
      ? "recorded"
      : "unavailable";

  // (2026-10-15) Bitcoin anchoring: the server's verification key in the one
  // vocabulary. Only an independent Bitcoin main-chain check is a success
  // (green ✓); FAILED / CHAIN_FAILED are danger; every other key — including
  // a recorded attestation nobody checked — is neutral.
  const otsState: IntegrityState = otsIntegrityState(otsStatusPresentation);
  const otsTone: AppTone =
    otsStatusPresentation?.tone === "success" ? "green" : otsStatusPresentation?.tone === "danger" ? "red" : "slate";
  const otsStateLabel = otsStatusPresentation
    ? otsStatusPresentation.tone === "success"
      ? `✓ ${otsStatusPresentation.status}`
      : otsStatusPresentation.status
    : undefined;

  const reportState: IntegrityState = workspace.artifactStatus.report.available
    ? "available"
    : workspace.artifactStatus.report.pending
      ? "pending"
      : "unavailable";

  const reportSignatureState: IntegrityState =
    !workspace.artifactStatus.report.available ||
    !workspace.artifactStatus.report.pdfSignature
      ? workspace.artifactStatus.report.pending
        ? "pending"
        : "unavailable"
      : workspace.artifactStatus.report.pdfSignature.status === "SIGNED"
        ? "recorded"
        : workspace.artifactStatus.report.pdfSignature.status === "SIGNING_FAILED"
          ? "failed"
          : workspace.artifactStatus.report.pdfSignature.status === "NOT_APPLICABLE"
            ? "not-applicable"
            : "unavailable";

  const packageState: IntegrityState = workspace.artifactStatus.verificationPackage
    .available
    ? "available"
    : workspace.artifactStatus.verificationPackage.pending
      ? "pending"
      : !packageIncluded
        ? "not-applicable"
        : "unavailable";

  const manifestState: IntegrityState = workspace.artifactStatus.verificationPackage
    .available
    ? workspace.artifactStatus.verificationPackage.manifestSignature?.status === "SIGNED"
      ? "recorded"
      : "unavailable"
    : workspace.artifactStatus.verificationPackage.pending
      ? "pending"
      : !packageIncluded
        ? "not-applicable"
        : "unavailable";

  const divergence = workspace.artifactVersions.trustDecisionConsistency;

  return (
    <>
      {/* PHASE 12B — canonical provenance-chain surface. Reads the
          server projection GET /v1/provenance/:evidenceId; the section
          owns its own loading / empty / denial / error states and drops
          responses that land after a workspace switch. */}
      <EvidenceProvenanceChainSection evidenceId={evidenceId} />

      <IntegritySection
        icon={Camera}
        title="Source &amp; Capture Context"
        description="What PROOVRA recorded about where this material came from and how it reached the platform. Signals that were never collected are not listed."
        data-evidence-section="source-capture-context"
      >
        {(() => {
          // Strict-honesty rule: a context fact renders ONLY when
          // PROOVRA has a real collected value. Missing or
          // not-collected signals are HIDDEN entirely — no
          // placeholder cards, no fallback copy, no summary row.
          // If reviewers need to know what's missing, the answer
          // is to collect it (or to not surface the signal until
          // we do).
          const sc = workspace.sourceContext;
          const items: { label: string; value: string }[] = [];

          // UC-0 — acquisition is ALWAYS shown, from the server's
          // acquisition projection. "Not recorded" is a real, collected
          // answer for a legacy record (not a placeholder), so the
          // strict-honesty rule above does not hide it.
          items.push({
            label: "Acquisition",
            value: displayAcquisition(sc.acquisition ?? null),
          });
          const sourceTypeLabel = displaySourceType(sc.sourceType);
          if (sourceTypeLabel !== "Not recorded") {
            items.push({ label: "Source type", value: sourceTypeLabel });
          }

          // Server-stamped timestamps. formatUserDateTime returns null
          // when the input ISO is null; formatValue then returns the
          // em-dash placeholder. We bypass formatValue and skip the
          // row entirely when no timestamp exists.
          const capturedAt = sc.capturedAtUtc
            ? formatUserDateTime(sc.capturedAtUtc)
            : null;
          if (capturedAt) {
            // UC-PROV-001 — Evidence.capturedAtUtc is the PROOVRA server clock
            // when the record was created, never a capture time.
            items.push({ label: "Server received at", value: capturedAt });
          }
          const uploadedAt = sc.uploadedAtUtc
            ? formatUserDateTime(sc.uploadedAtUtc)
            : null;
          if (uploadedAt) {
            items.push({ label: "Uploaded at", value: uploadedAt });
          }

          // Device time — only when the client actually sent one.
          if (sc.deviceTimeIso) {
            items.push({ label: "Device time", value: sc.deviceTimeIso });
          }

          // Location — ALWAYS stated, in the canonical label: recorded,
          // not recorded (neutral, never a failure), not shared,
          // unavailable or invalid. Never "blocked".
          items.push({ label: locationCopy.heading, value: location.label });

          // Client signals — DETECTED / COLLECTED_FALSE only. Every
          // NOT_COLLECTED / UNAVAILABLE state is hidden.
          if (
            shouldShowContextSignal(sc.clientSignalsSummary.screenshotLikeStatus)
          ) {
            items.push({
              label: "Screenshot indicators",
              value: describeClientSignalState(
                sc.clientSignalsSummary.screenshotLikeStatus,
              ),
            });
          }
          if (
            shouldShowContextSignal(sc.clientSignalsSummary.folderPathStatus)
          ) {
            items.push({
              label: "Folder path indicators",
              value: describeClientSignalState(
                sc.clientSignalsSummary.folderPathStatus,
              ),
            });
          }

          // If a record has truly no collected context (e.g. a stub
          // row), render nothing rather than an empty grid skeleton.
          if (items.length === 0) return null;
          return <FactsGrid items={items} />;
        })()}

        <BoundaryNote title="Boundary">
          {workspace.sourceContext.limitations[0]}
        </BoundaryNote>
      </IntegritySection>

      {/* The map panel renders only when the record actually carries a
          recorded capture location, so the real permission and
          availability rules stay authoritative. It is never synthesised
          from an approximate or inferred position. */}
      {workspace.sourceCaptureLocation && location.state === "RECORDED" ? (
        <IntegritySection
          icon={MapPin}
          title={locationCopy.sectionTitle}
          description="The position recorded alongside the capture, with its recorded accuracy. This is where the capturing device reported itself to be — not a determination of where the subject matter is."
          data-evidence-section="capture-location"
        >
          <LocationStateNote location={location} />
          <div className="evidence-detail-map-shell">
            <CaptureLocationMapPanel
              showBoundary={false}
              lat={workspace.sourceCaptureLocation.lat ?? 0}
              lng={workspace.sourceCaptureLocation.lng ?? 0}
              accuracyMeters={workspace.sourceCaptureLocation.accuracyMeters}
              sourceLabel={workspace.sourceCaptureLocation.source}
            />
          </div>
          <BoundaryNote title="Boundary">
            {workspace.sourceCaptureLocation.legalBoundary}
          </BoundaryNote>
        </IntegritySection>
      ) : location.detail || location.requirement?.unmet ? (
        // No coordinates, but a recorded fact about location (a declined or
        // unavailable request, invalid stored coordinates, a plan that
        // required it): the state alone — no map, no empty map shell.
        <IntegritySection
          icon={MapPin}
          title={locationCopy.sectionTitle}
          description={locationCopy.sectionDescription}
          data-evidence-section="capture-location"
        >
          <LocationStateNote location={location} />
        </IntegritySection>
      ) : null}

      {/* Phase 5 — renamed kicker. The matrix below lists recorded
          preservation materials in plain-English row labels. Technical-detail
          rows (multipart manifest, TSA imprint, hash semantics) moved to the
          Technical Appendix. */}
      <IntegritySection
        icon={ShieldCheck}
        title="Verification &amp; Preservation"
        description="Recorded integrity and preservation materials, each with the state PROOVRA can actually attest to. A state describes the material, not the truthfulness of what the material shows."
        data-evidence-section="verification-preservation"
        actions={
          showManualLatestStatusCheck ? (
            <button
              type="button"
              className="app-secondary-action"
              onClick={() => void loadWorkspace()}
            >
              Check latest status
            </button>
          ) : null
        }
      >
        <MatrixGrid
          items={[
            {
              label: "Verification status",
              value: preservation.verificationStatusLabel,
              state: verificationState,
            },
            ...(storedBytesRow
              ? [
                  {
                    label: "Stored file (current)",
                    value: storedBytesRow.label,
                    state: storedBytesState,
                    stateLabel: storedBytesRow.badge,
                  },
                ]
              : []),
            {
              label: "SHA-256 recorded",
              value: preservation.sha256Recorded ? "Recorded" : "Not recorded",
              state: preservation.sha256Recorded ? "recorded" : "unavailable",
            },
            {
              label: "Fingerprint hash",
              value: preservation.fingerprintHashRecorded
                ? preservation.fingerprintCanonicalHashMatches === true
                  ? "Recorded and matches the canonical fingerprint"
                  : preservation.fingerprintCanonicalHashMatches === false
                    ? "Recorded but does not match the canonical fingerprint"
                    : "Recorded"
                : "Not recorded",
              state: fingerprintState,
            },
            {
              label: "Signature",
              value: signaturePresentation.label,
              state: signatureState,
            },
            {
              // Phase 5 — "Timestamp proof (TSA)" is plainer than the
              // prior "TSA timestamp" + matches the Home pass.
              label: "Timestamp proof (TSA)",
              value: tsaProof
                ? TSA_PROOF_STATUS_LABELS[tsaProof]
                : preservation.tsa.timestampAvailable
                  ? "Timestamp recorded"
                  : "Timestamp unavailable",
              state: tsaState,
            },
            {
              label: "Bitcoin anchoring",
              // The label, and for an unchecked attestation the secondary
              // status "Not independently checked against Bitcoin".
              value: otsStatusPresentation
                ? otsStatusPresentation.secondaryStatus
                  ? `${otsStatusPresentation.label} · ${otsStatusPresentation.secondaryStatus}`
                  : otsStatusPresentation.label
                : "Bitcoin anchoring unavailable",
              state: otsState,
              stateLabel: otsStateLabel,
              tone: otsTone,
            },
            {
              label: "Bitcoin anchoring last updated",
              value: formatValue(
                formatUserDateTime(preservation.ots.lastUpdatedAtUtc),
              ),
              state: preservation.ots.lastUpdatedAtUtc ? "recorded" : "unavailable",
            },
            {
              // Evidence-output incident (2026-10-05): the ONE classification.
              // A lock recorded at sealing used to read "Not exposed in current
              // API response" because `verified` (observed just now) was read
              // as protection.
              label: "Storage protection",
              value: describeStorageProtection(
                preservation.storage,
                storageProtectionClassOf(preservation.storage),
                (iso) => formatValue(formatUserDateTime(iso)),
              ),
              state:
                storageProtectionClassOf(preservation.storage) === "PROTECTED"
                  ? "recorded"
                  : "unavailable",
            },
            {
              label: "Report artifact",
              value: `${describeReportArtifactStatus(workspace.artifactStatus)}${
                preservation.report.available
                  ? ` · Version ${preservation.report.version ?? "latest"}`
                  : ""
              }`,
              state: reportState,
            },
            {
              label: "Report PDF signature",
              value: describeReportPdfSignature(workspace.artifactStatus),
              state: reportSignatureState,
            },
            {
              label: "Verification package",
              value: `${describeVerificationPackageStatus(
                workspace.artifactStatus,
                packageIncluded,
              )}${
                preservation.verificationPackage.available
                  ? ` · Version ${preservation.verificationPackage.version ?? "latest"}`
                  : ""
              }`,
              state: packageState,
            },
            {
              label: "Package manifest",
              value: describePackageManifestStatus(
                workspace.artifactStatus,
                packageIncluded,
              ),
              state: manifestState,
            },
            {
              // Phase 5 — "Record protection" is plainer than the
              // prior "Retention until" / "Object Lock" rows in the
              // Review tab. Same underlying fact; condensed.
              label: "Retention until",
              value: workspace.evidence?.retentionUntilUtc
                ? `Recorded — ${formatValue(formatUserDateTime(workspace.evidence.retentionUntilUtc))}`
                : "No record-level retention deadline recorded",
              state: workspace.evidence?.retentionUntilUtc ? "recorded" : "unavailable",
            },
            {
              label: "Object Lock retention mode",
              // AUD-47 — the mode in words, never the raw enum.
              value:
                objectLockModeLabel(workspace.evidence?.storageObjectLockMode ?? null) ??
                "Not asserted (storage immutability not confirmed for this record)",
              state: workspace.evidence?.storageObjectLockMode
                ? "recorded"
                : "unavailable",
            },
            {
              label: "Object Lock retention until",
              value: workspace.evidence?.storageObjectLockRetainUntilUtc
                ? formatValue(
                    formatUserDateTime(workspace.evidence.storageObjectLockRetainUntilUtc),
                  )
                : "Not asserted",
              state: workspace.evidence?.storageObjectLockRetainUntilUtc
                ? "recorded"
                : "unavailable",
            },
            {
              label: "Legal hold",
              value:
                workspace.evidence?.storageObjectLockLegalHoldStatus === "ON"
                  ? "Legal hold active"
                  : workspace.evidence?.storageObjectLockLegalHoldStatus === "OFF"
                    ? "Legal hold off"
                    : "No legal hold metadata recorded",
              state:
                workspace.evidence?.storageObjectLockLegalHoldStatus === "ON"
                  ? "recorded"
                  : workspace.evidence?.storageObjectLockLegalHoldStatus === "OFF"
                    ? "not-applicable"
                    : "unavailable",
            },
            {
              // Descriptive row — carries the anchoring explanation, not a
              // state of its own, so it renders without a chip.
              label: "Bitcoin anchoring detail",
              value:
                otsStatusPresentation?.detail ??
                "The OpenTimestamps proof material cannot currently be read.",
              wide: true,
            },
          ]}
        />
      </IntegritySection>

      {/* Custodian / qualified-person declarations. Read and changed through
          the certification routes; separate from the integrity state above. */}
      <IntegritySection
        icon={FileSignature}
        title="Declarations"
        description="Custodian and qualified-person declarations attached to this record. A declaration is a signed human statement recorded in custody history; it does not change the recorded integrity state."
        data-evidence-section="declarations"
      >
        <EvidenceCertificationsPanel evidenceId={evidenceId} />
      </IntegritySection>

      {/* Phase 1 — kept on Integrity but pared to the user-readable
          fields (report generated at + package generated at + current
          status + chain validity). The forensic event COUNTS + access
          event counts moved to Custody/Technical Appendix; the
          snapshot-boundary DIVERGENCE detail moved to Technical
          Appendix. */}
      <IntegritySection
        icon={History}
        title="Snapshot timing"
        description="When the fixed materials were generated, and whether the custody chain recorded since then is continuous."
        data-evidence-section="snapshot-timing"
      >
        <FactsGrid
          items={[
            {
              label: "Report generated at",
              value: formatValue(
                formatUserDateTime(workspace.snapshot.reportGeneratedAtUtc),
              ),
            },
            {
              label: "Verification package generated at",
              value: formatValue(
                formatUserDateTime(
                  workspace.snapshot.verificationPackageGeneratedAtUtc,
                ),
              ),
            },
            {
              label: "Current status",
              // F-13 — THE record-status label, never the raw enum.
              value: evidenceRecordStatusLabel(workspace.snapshot.currentStatus),
            },
            {
              label: "Custody chain",
              // F-28 (independent forward audit) — the verdict in words, never the verifier's codes.
              value: custodyChainVerdictLabel(preservation.custodyChain),
            },
          ]}
        />

        <BoundaryNote title="Record boundary noted">
          {workspace.snapshot.fixedArtifactNote}
        </BoundaryNote>

        {/* AUD-26 (2026-10-20): which verdict this page shows — as issued, or
            now — so it never reads as the same claim as Public Verify's. */}
        {divergence?.basis ? (
          <p className="evidence-detail-verdict-basis" data-evidence-verdict-basis={divergence.basis.kind}>
            {verdictBasisSentence(divergence.basis)}
          </p>
        ) : null}

        {divergence?.consistentWithSnapshot === false ? (
          <BoundaryCallout
            title="Boundary updated"
            role={divergence?.tone === "danger" ? "alert" : "status"}
            data-evidence-snapshot-divergence-summary="true"
            data-evidence-divergence-tone={
              divergence?.tone === "danger"
                ? "danger"
                : divergence?.accessOnly
                  ? "access-only"
                  : "warn"
            }
          >
            {divergence?.accessOnly
              ? "No integrity mismatch detected. Live access activity now differs from the fixed report snapshot, and this is informational activity drift only."
              : divergence?.tone === "danger"
                ? "A live integrity-relevant divergence was detected between the current state and the fixed report snapshot. Open the Technical Appendix tab for the full reason list."
                : "Live verification now differs from the fixed report snapshot. Open the Technical Appendix tab for the full reason list."}
          </BoundaryCallout>
        ) : null}
      </IntegritySection>
    </>
  );
}
