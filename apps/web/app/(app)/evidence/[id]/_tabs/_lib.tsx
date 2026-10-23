/**
 * Phase EVIDENCE-IA-DECOMPOSE — shared helpers + context type for the
 * Evidence Detail tab decomposition.
 *
 * The page.tsx orchestrator owns ALL state, callbacks, and effects. The
 * extracted tab components are pure presentation — they receive the
 * single `EvidenceDetailCtx` prop bag and destructure what they need.
 *
 * This file collects every helper that more than one tab + the page
 * shell would otherwise duplicate. Helpers are unchanged from their
 * original page-internal definitions (Phase 0 is mechanical extraction
 * only — no behavior, copy, or UI changes).
 */

"use client";

import { useEffect, useMemo, useState } from "react";
import type { NewVersionSubmitResult } from "../../../../../components/evidence-outputs/artifact-status-types";
import type {
  ArtifactsFocusTarget,
  EvidenceOutputAttention,
} from "../../../../../components/evidence-outputs/output-attention";
import {
  Archive,
  CircleCheck,
  Link2,
  Lock,
  LockOpen,
  Pencil,
  RotateCcw,
  type LucideIcon,
  Trash2,
} from "lucide-react";
import {
  evidenceLocationCopy,
  getReviewerArtifactRoleLabel,
  locationRequirementRowValue,
  readOtsAnchoringView,
  VERIFICATION_DISCLOSURE_MODE_LABELS,
  type OtsChainView,
  type OtsState,
  type OtsStateTone,
  type OtsVerificationKey,
  custodyEventLabel,
  pdfSignatureStatusLabel,
} from "@proovra/shared";
import type { EvidenceOutputState } from "@proovra/shared";
import { useOptionalLocale } from "../../../../providers";
import type { AppTone } from "../../../../../components/app-primitives/AppStatusBadge";
import { formatUserDateTime } from "../../../../../lib/date";
import type {
  ReviewWorkspaceResponse,
  TimelineEvent,
} from "../review-workspace-types";

// ---------------------------------------------------------------------------
// Tab identifier
// ---------------------------------------------------------------------------

export type EvidenceDetailTab =
  | "overview"
  | "integrity"
  | "custody"
  | "review"
  | "artifacts"
  | "discussion"
  // UC-4 — DERIVED screen-intelligence reviewer surface.
  | "derived"
  | "technical";

// ---------------------------------------------------------------------------
// Single-prop "context" the orchestrator passes into every extracted
// tab. Adding a new field here costs one prop in the orchestrator and
// one destructure in the tab that needs it — far cleaner than ad-hoc
// per-tab prop signatures.
// ---------------------------------------------------------------------------

export type EvidenceDetailCtx = {
  // Core API envelope
  workspace: ReviewWorkspaceResponse;
  evidence: ReviewWorkspaceResponse["evidence"];
  workspaceCaps: NonNullable<ReviewWorkspaceResponse["workspaceCapabilitySnapshot"]>;
  preservation: ReviewWorkspaceResponse["preservationMatrix"];
  trustDecision: unknown;
  evidenceId: string;

  // Derived / memoized values from the orchestrator
  verificationPageState: VerificationPageState | null;
  otsStatusPresentation: OtsStatusPresentation | null;
  technicalReadinessSummary: string;
  reviewReadinessItems: Array<{ label: string; value: string }>;
  overviewMetadataItems: Array<{ label: string; value: string }>;
  shareUrl: string | null;
  isIntegrityFailed: boolean;
  showManualLatestStatusCheck: boolean;
  initialThreadId: string | null;

  // Surface gates (Phase IA-self-serve-completion)
  canSeeReviewerOps: boolean;
  canSeeGovernance: boolean;
  canSeeIntelligence: boolean;
  canSeeIntakeLinks: boolean;
  // Phase EVIDENCE-RELATIONSHIPS-GATE — true on workspaces where the
  // /investigation surface (graph/timeline/relationships) is reachable.
  // Manage Relationships UI in the Review tab gates on this OR on the
  // presence of existing relationships.
  canSeeInvestigation: boolean;

  // Intelligence projection
  intelligence:
    | (Pick<
        import("../../../../../lib/api/intelligence").IntelligenceEvidenceResponse,
        "entities" | "extractedTexts" | "disclaimer"
      > | null);
  intelligenceLoaded: boolean;

  // Workflow drilldown state (for ReviewerWorkflowCard)
  workflowEvents: Array<{
    id: string;
    eventType: string;
    note: string | null;
    previousValue: unknown;
    nextValue: unknown;
    createdAt: string;
    actor: { id: string; email: string | null; displayName: string | null } | null;
  }>;
  workflowEventsLoading: boolean;
  actionBusy: boolean;

  // Artifact stale-pending state (Phase CAPTURE-ARTIFACT-PIPELINE)
  stalePending: boolean;
  setStalePending: (next: boolean) => void;
  setPollStartedAt: (next: number | null) => void;

  // Callbacks
  loadWorkspace: (opts?: { bumpBaseline?: boolean }) => Promise<void> | void;
  loadWorkflowEvents: () => Promise<void> | void;
  openOriginal: () => Promise<void> | void;
  downloadOriginal: () => Promise<void> | void;
  downloadReport: () => Promise<void> | void;
  downloadVerificationPackage: () => Promise<void> | void;
  // RELIABILITY CLOSURE (2026-09-09) — one retained version, by number.
  downloadReportVersion: (version: number) => Promise<void> | void;
  downloadVerificationPackageVersion: (version: number) => Promise<void> | void;
  downloadExternalDisclosurePackageVersion: (version: number) => Promise<void> | void;
  /**
   * Request the action an output offers — GENERATE, RETRY or RECOVER, from the
   * server's `outputs.*.action`. The server re-derives what runs: a report
   * whose package is missing gets only the package, from the stored report.
   */
  generateOutputs: (
    intent?: "GENERATE" | "RETRY" | "RECOVER",
    output?: "report" | "verificationPackage",
  ) => Promise<void> | void;
  /**
   * The separate, confirmed updated report (RGA-02): submitted WITH the signed
   * offer revision the dialog showed; answered accepted / stale / typed error.
   */
  createNewVersion: (input: {
    clientRequestKey: string;
    reason: string;
    offerRevision: string | null;
  }) => Promise<NewVersionSubmitResult>;
  generateOutputsBusy: boolean;
  /**
   * A stored file the server answered 410 for: when (epoch ms) and which
   * version (`null` = the latest route). Learned from a real download only;
   * absent on older callers.
   */
  missingStoredArtifacts?: {
    report: { at: number; version: number | null } | null;
    verificationPackage: { at: number; version: number | null } | null;
  };
  runRecordAction: (path: string, successMessage: string) => Promise<void> | void;
  restoreTrash: () => Promise<void> | void;
  removeCase: (caseId?: string) => Promise<void> | void;
  handleRemoveRelationship: (relationshipId: string) => Promise<void> | void;

  // Modal openers
  setSelectedCaseId: (id: string) => void;
  setAssignCaseOpen: (open: boolean) => void;
  setArchiveOpen: (open: boolean) => void;
  setTrashOpen: (open: boolean) => void;
  setWorkflowOpen: (open: boolean) => void;
  setRelationshipOpen: (open: boolean) => void;

  // Router
  routerPush: (href: string) => void;

  // Evidence output attention — ONE value per render (null while the status
  // is unknown or belongs to another record), read by every output surface.
  outputAttention: EvidenceOutputAttention | null;
  /** Open Artifacts and focus the named section (the one navigation helper). */
  openArtifacts: (focus?: ArtifactsFocusTarget) => void;
  /** Open the ONE canonical updated-report dialog (mounted by the page). */
  openUpdatedReport: () => void;
};

// ---------------------------------------------------------------------------
// SectionHeading
// ---------------------------------------------------------------------------

export function SectionHeading({
  kicker,
  title,
  icon: Icon,
}: {
  kicker: string;
  title: string;
  icon: LucideIcon;
}) {
  return (
    <div className="evidence-detail-heading">
      <span className="evidence-detail-heading-icon" aria-hidden="true">
        <Icon size={16} strokeWidth={2} />
      </span>
      <div className="evidence-detail-heading-copy">
        <p className="evidence-detail-kicker">{kicker}</p>
        <h2>{title}</h2>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Primitive value formatters
// ---------------------------------------------------------------------------

// Re-exported, not redefined: `lib/short-id.ts` is the one authority. Three
// copies of this function disagreed with each other — see that file.
export { shortId } from "../../../../../lib/short-id";

export function formatBytes(sizeBytes: string | number | null | undefined) {
  const numeric =
    typeof sizeBytes === "number"
      ? sizeBytes
      : typeof sizeBytes === "string"
        ? Number(sizeBytes)
        : Number.NaN;

  if (!Number.isFinite(numeric) || numeric <= 0) return "Not recorded";

  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = numeric;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "Not recorded";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

export function describeContentItemRole(item: {
  isPrimary: boolean;
  artifactRole?: "primary_evidence" | "supporting_evidence" | "attachment" | null;
  artifactRoleLabel?: string | null;
  checklistStepLabel?: string | null;
}) {
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

/**
 * A media KIND's tone.
 *
 * A KIND, NOT A STATE. The content-item card used to pass a media kind to a
 * substring STATE classifier (since deleted) that matched "READY", "PENDING",
 * "FAILED". "IMAGE" matches none of its branches, so every kind
 * fell through to the neutral default and the card's type label was the same
 * grey for a photo, a video and a PDF. A kind is a CLASSIFICATION, not a
 * state; it needed its own table, and this is it.
 *
 * The vocabulary is the content item's own — `image | video | audio | pdf |
 * text | other` (see `evidence-library-types`), lowercase off the wire.
 *
 * `text` and `other` are deliberately NOT given a colour of their own. They
 * are what a document arrives as, and this product has no documented type
 * colour for a document; inventing one here would be a fourth type palette
 * rather than a reuse. They keep the neutral the label already had.
 *
 * NOTE ON PDF: `detectEvidenceKind` in the Evidence LIBRARY folds
 * `application/pdf` into `document`, so the library does not know a PDF as a
 * PDF. This card does — its own preview switch branches on `kind === "pdf"` to
 * choose a PDF viewer — so the blue applies here and the library's classifier
 * is left alone. Changing that classifier would be a change to how records are
 * categorised, not to how a label is painted.
 */
const MEDIA_KIND_TONE: Readonly<Record<string, AppTone>> = {
  image: "indigo",
  video: "orange",
  pdf: "blue",
  audio: "ink",
};

export function mediaKindTone(kind: string): AppTone {
  return MEDIA_KIND_TONE[kind.trim().toLowerCase()] ?? "slate";
}

// ---------------------------------------------------------------------------
// Status / availability describers (kept canonical; tests pin output strings)
// ---------------------------------------------------------------------------

export function buildShareUrl(path: string | null | undefined): string | null {
  const normalized = path?.trim();
  if (!normalized) return null;

  const base =
    (typeof window !== "undefined" ? window.location.origin : null) ??
    process.env.NEXT_PUBLIC_APP_BASE?.trim() ??
    process.env.NEXT_PUBLIC_WEB_BASE?.trim() ??
    "";

  return `${base.replace(/\/+$/, "")}${normalized.startsWith("/") ? normalized : `/${normalized}`}`;
}

/** Why the canonical verification page cannot be opened right now. */
const CANONICAL_UNAVAILABLE: Record<string, string> = {
  NOT_ISSUED: "The verification link is issued when the record is finalized.",
  WITHDRAWN: "The verification page was withdrawn for a legal, privacy or security reason.",
  TEMPORARILY_UNAVAILABLE: "The verification page is temporarily unavailable.",
  RETAINED: "This record is retained in Trash or the archive; its verification page says so.",
  PURGED: "This record has been permanently deleted.",
  DELETED: "A deleted record has no verification link.",
  DESTROYED: "This record has been permanently deleted.",
  ARCHIVED: "An archived record has no verification link.",
  INTEGRITY_FAILED: "No verification link is offered while the record's integrity check has failed.",
  NOT_FINALIZED: "The verification link is issued when the record is finalized.",
  NOT_FOUND: "No verification link is available for this record.",
};

/**
 * THE record's verification link for every owner surface on this page — the
 * canonical `pvr_` page from the canonical contract, never a reviewer share.
 * There is no publication state to fall back to (retired 2026-10-18): an
 * envelope without the contract has no link.
 */
export function resolveCanonicalVerificationLink(workspace: {
  canonicalVerification?: ReviewWorkspaceResponse["canonicalVerification"];
}): { url: string | null; reason: string | null } {
  const canonical = workspace.canonicalVerification;
  if (canonical === undefined) {
    return { url: null, reason: CANONICAL_UNAVAILABLE.NOT_FOUND };
  }
  if (canonical.verifyPath && canonical.status === "AVAILABLE") {
    return { url: buildShareUrl(canonical.verifyPath), reason: null };
  }
  const key = canonical.status === "NOT_ISSUED" ? (canonical.refusalReason ?? "NOT_ISSUED") : canonical.status;
  return { url: null, reason: CANONICAL_UNAVAILABLE[key] ?? CANONICAL_UNAVAILABLE.NOT_FOUND };
}

/**
 * THE VERIFICATION PAGE, summarised for the record page (disclosure model
 * 2026-10-18). Every finalized record has a permanent page; this states its
 * ACCESS (available / withdrawn / suspended) and, when available, what it
 * DISCLOSES — read from the server's summary, never decided here.
 */
export type VerificationPageState = { label: string; detail: string; tone: AppTone };

export function describeVerificationPageState(
  summary: ReviewWorkspaceResponse["publicVerificationSummary"]
): VerificationPageState {
  switch (summary.state) {
    case "NOT_INCLUDED":
      return {
        label: "Not included on plan",
        detail:
          summary.disabledReason ||
          "Public verification is not included in the current workspace capability set.",
        tone: "slate",
      };
    case "AVAILABLE": {
      const contentPreview = summary.disclosureMode === "CONTENT_PREVIEW";
      return {
        label: `Available · ${VERIFICATION_DISCLOSURE_MODE_LABELS[contentPreview ? "CONTENT_PREVIEW" : "VERIFICATION_ONLY"]}`,
        detail: contentPreview
          ? `Anyone with the permanent reference sees the verification result and a content preview${
              summary.showRecordedLocation ? ", including the recorded location" : ""
            }.`
          : "Anyone with the permanent reference sees the verification result only.",
        tone: "green",
      };
    }
    case "WITHDRAWN":
      return {
        label: "Withdrawn",
        detail:
          summary.disabledReason ||
          "The verification page was withdrawn; every link to it answers that it was withdrawn.",
        tone: "red",
      };
    case "SUSPENDED":
      return {
        label: "Suspended",
        detail: summary.disabledReason || "The verification page is temporarily suspended.",
        tone: "amber",
      };
    default:
      return {
        label: "State unavailable",
        detail: "The verification page's state could not be read from the current evidence record.",
        tone: "slate",
      };
  }
}

export function describeClientSignalState(
  status: "NOT_COLLECTED" | "COLLECTED_FALSE" | "DETECTED" | "UNAVAILABLE"
): string {
  switch (status) {
    case "NOT_COLLECTED":
      return "Client signal not collected";
    case "COLLECTED_FALSE":
      return "Collected: no signal detected";
    case "DETECTED":
      return "Signal detected";
    case "UNAVAILABLE":
      return "Unavailable for this evidence type";
    default:
      return "Not recorded";
  }
}

/**
 * COMMERCIAL + OUTPUT LIFECYCLE CLOSURE (2026-09-08) — ONE label per canonical
 * state.
 *
 * These read `available` then `pending` then fell through to "Not generated",
 * and `pending` meant "no artifact row exists". So a record on a plan without
 * reports read "Pending" forever, and once that was corrected server-side the
 * fallback would have called it "Not generated" — true, and still not the fact
 * the reader needs, which is that nothing is coming.
 *
 * Total over `EvidenceOutputState`, so a new state cannot be added without a
 * label.
 */

/**
 * WHY A CONTROL IS UNAVAILABLE, keyed by the server's canonical state.
 *
 * RELIABILITY CLOSURE (2026-09-09) — this lived inside the Artifacts tab while
 * the page HEADER, which renders the two most prominent download buttons on
 * the record, derived its own reason from the legacy `available` / `pending`
 * booleans. So a FREE record whose Artifacts tab correctly said "a report is
 * not included for this evidence record" had a header three lines above it
 * saying "No report has been generated for this record yet" — the sentence for
 * a different state, on the same screen, about the same record.
 *
 * Total over `EvidenceOutputState`, so a new state is a compile error rather
 * than a control that silently explains nothing.
 */
export const OUTPUT_STATE_COPY: Record<
  EvidenceOutputState,
  { reason: (noun: string) => string }
> = {
  READY: { reason: () => "" },
  NOT_INCLUDED: {
    reason: (noun) =>
      `No ${noun} has been issued for this record: reports are not included in the plan that covers this record. The original evidence is finalized and can be verified.`,
  },
  ENTITLEMENT_UNAVAILABLE: {
    reason: (noun) =>
      `We could not confirm the subscription just now, so no ${noun} is being issued. This updates automatically.`,
  },
  /*
   * P1-3 (2026-09-10) — NO PLAN NAME, AND NO PROMISE THAT CANNOT BE KEPT.
   *
   * One sentence has to serve both record conditions here, because this map is
   * keyed by state alone and feeds a disabled control's tooltip. It is written
   * so it is true of each: a record still being finalized, and one whose
   * integrity check failed and never will be. The Artifacts panel, which HAS
   * the bounded reason, says which.
   */
  NOT_APPLICABLE: {
    reason: (noun) =>
      `A ${noun} is not available for this record in its current state.`,
  },
  ELIGIBLE_NOT_GENERATED: {
    reason: (noun) =>
      `No ${noun} has been generated for this record yet. Generate one to download it.`,
  },
  QUEUED: {
    reason: (noun) => `The ${noun} is queued for generation. Re-check shortly.`,
  },
  GENERATING: {
    reason: (noun) =>
      `The ${noun} is being generated. Re-check status once it completes.`,
  },
  RETRYABLE_FAILURE: {
    reason: (noun) => `The last attempt to build the ${noun} failed.`,
  },
  TERMINAL_FAILURE: {
    reason: (noun) => `The ${noun} could not be produced for this record.`,
  },
  // AUD-011 — the issued version's stored file is proven gone.
  ARTIFACT_MISSING: {
    reason: (noun) =>
      `The stored file of the issued ${noun} is unavailable. It is never re-issued in place; a new verified version can be issued.`,
  },
  BLOCKED: {
    reason: (noun) => `${noun.charAt(0).toUpperCase()}${noun.slice(1)} generation is blocked by a policy decision.`,
  },
};

const OUTPUT_STATE_LABEL: Record<EvidenceOutputState, string> = {
  READY: "Available",
  QUEUED: "Queued",
  GENERATING: "Generating",
  ELIGIBLE_NOT_GENERATED: "First issuance pending",
  RETRYABLE_FAILURE: "Generation failed",
  TERMINAL_FAILURE: "Generation stopped",
  BLOCKED: "Blocked",
  NOT_INCLUDED: "Not issued",
  ENTITLEMENT_UNAVAILABLE: "Checking subscription",
  // P1-3 — a record condition, never a commercial one.
  NOT_APPLICABLE: "Not available for this record",
  ARTIFACT_MISSING: "Stored file unavailable",
};

export function describeReportArtifactStatus(
  artifactStatus: ReviewWorkspaceResponse["artifactStatus"]
): string {
  return OUTPUT_STATE_LABEL[artifactStatus.outputs.report.state];
}

export function describeReportPdfSignature(
  artifactStatus: ReviewWorkspaceResponse["artifactStatus"]
): string {
  if (!artifactStatus.report.available || !artifactStatus.report.pdfSignature) {
    return artifactStatus.report.pending ? "Pending" : "Unknown";
  }

  // F-28 (independent forward audit, closure) — THE PDF signature vocabulary
  // (pdfSignatureStatusLabel), the one mobile states.
  return pdfSignatureStatusLabel(artifactStatus.report.pdfSignature.status);
}

export function describeVerificationPackageStatus(
  artifactStatus: ReviewWorkspaceResponse["artifactStatus"],
  /**
   * RETAINED for the call sites that still pass it, and DELIBERATELY unused:
   * the canonical state already carries the commercial answer, and taking it
   * from a separate boolean is how a caller comes to hold one that disagrees.
   */
  _included?: boolean,
): string {
  return OUTPUT_STATE_LABEL[artifactStatus.outputs.verificationPackage.state];
}

export function describePackageManifestStatus(
  artifactStatus: ReviewWorkspaceResponse["artifactStatus"],
  included: boolean
): string {
  if (artifactStatus.verificationPackage.available) {
    return artifactStatus.verificationPackage.manifestSignature?.status === "SIGNED"
      ? "Signed manifest present"
      : "Unknown";
  }
  if (artifactStatus.verificationPackage.blocked) return "Blocked";
  if (artifactStatus.verificationPackage.pending) return "Pending";
  return included ? "Unknown" : "Not included on plan";
}

/** The Bitcoin anchoring card, in the server's state and the one vocabulary. */
export type OtsStatusPresentation = {
  state: OtsState;
  /** THE verification key; only CHAIN_VERIFIED is a positive Bitcoin claim. */
  verification: OtsVerificationKey;
  /** The status word beside "Bitcoin anchoring" (Attestation recorded, Pending, …). */
  status: string;
  /** The standalone label (Bitcoin attestation recorded, Independently verified against the Bitcoin main chain, …). */
  label: string;
  /** "Not independently checked against Bitcoin" for an unchecked attestation, else null. */
  secondaryStatus: string | null;
  /** The one sentence with its facts (block height, confirmations, check time). */
  sentence: string;
  /** The one sentence, plus the bounded failure label when there is one. */
  detail: string;
  tone: OtsStateTone;
  /** The bounded Bitcoin main-chain check, when one is recorded. */
  chain: OtsChainView | null;
};

/**
 * (2026-10-15) THE Bitcoin anchoring state is the server's
 * (`preservationMatrix.ots`, an OtsAnchoringView): read, never re-derived. A
 * missing or unknown state reads as Unavailable; a CHAIN_* key is believed
 * only with a coherent chain fact (readOtsAnchoringView).
 */
export function describeOtsStatus(workspace: ReviewWorkspaceResponse): OtsStatusPresentation {
  const view = readOtsAnchoringView(workspace.preservationMatrix?.ots);
  return {
    state: view.state,
    verification: view.verification,
    status: view.status,
    label: view.label,
    secondaryStatus: view.secondaryStatus,
    sentence: view.sentence,
    detail: view.failureLabel ? `${view.sentence} ${view.failureLabel}` : view.sentence,
    tone: view.tone,
    chain: view.chain,
  };
}

/**
 * Whether the anchoring state can no longer move. Only PENDING can; the
 * server's `recheckAvailable`, when sent, decides instead.
 */
export function isOtsTerminal(ots: ReviewWorkspaceResponse["preservationMatrix"]["ots"] | null | undefined): boolean {
  if (typeof ots?.recheckAvailable === "boolean") return !ots.recheckAvailable;
  return readOtsAnchoringView(ots).state !== "PENDING";
}

/**
 * POLL WHILE THE SERVER SAYS WORK IS LIVE — and only then.
 *
 * This used to poll while `report.available` was false, so a NEW version being
 * generated beside a READY report was never polled at all: the page kept
 * offering the action it had just taken, and the new version appeared only on
 * a manual reload. The server now states the interval (`pollIntervalMs`) from
 * the live requests themselves — including while an older version stays
 * downloadable — and null means stop.
 */
export function shouldPollArtifactReadiness(
  workspace: ReviewWorkspaceResponse | null | undefined
): boolean {
  return workspace?.artifactStatus?.outputs?.pollIntervalMs != null;
}

export function buildTechnicalReadinessSummary(workspace: ReviewWorkspaceResponse): string {
  if (
    workspace.reviewDecision.label === "Ready for review" &&
    !workspace.reviewWorkflow.status
  ) {
    return "Evidence is technically ready; no reviewer workflow has started yet.";
  }

  return workspace.reviewDecision.summary;
}

export async function tryDownloadFile(url: string, filename: string) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error("Download fetch failed");

    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
    return true;
  } catch {
    return false;
  }
}

/*
 * The page's own client-side risk-signal builder was removed on
 * 2026-10-23: what a record asks of its reader is the server's
 * `workspace.attention` (shared `classifyEvidenceAttention`), so the page no
 * longer re-derives advisories from source context beside it.
 */

// ---------------------------------------------------------------------------
// Reusable display components (PreviewWorkspace, KeyValueGrid,
// CaptureTemplateCard, EventTimeline). Logic verbatim from the
// pre-decomposition page.tsx.
// ---------------------------------------------------------------------------

export function PreviewWorkspace({
  workspace,
  onOpenOriginal,
  onDownloadOriginal,
}: {
  workspace: ReviewWorkspaceResponse;
  onOpenOriginal: () => void;
  onDownloadOriginal: () => void;
}) {
  const privateItemNotesById = useMemo(
    () =>
      new Map(
        workspace.parts.map((part) => [part.id, part.privateNote ?? null] as const)
      ),
    [workspace.parts]
  );

  // Resolve the default selected item once per render. Priority:
  //   1. backend-suggested defaultPreviewItemId
  //   2. first previewable item with a viewUrl
  //   3. primaryContentItem
  // This is the same logic the page used before; it now seeds the
  // `selectedPreviewItemId` state instead of being the only source.
  const contentItems = workspace.evidence.contentItems ?? [];
  const defaultItem =
    contentItems.find(
      (item) => item.id === workspace.evidence.defaultPreviewItemId
    ) ??
    contentItems.find((item) => item.previewable && item.viewUrl) ??
    workspace.evidence.primaryContentItem ??
    null;

  // P0 fix — the cards under the main preview must be clickable and
  // switch the main preview. The previous build rendered cards as
  // plain <div>s with no onClick and no selection state, so the
  // preview was permanently stuck on `defaultItem`. We now hold the
  // selected id in local state, default it to the resolved
  // defaultItem, and re-seed it whenever the underlying evidence id
  // changes (navigating between records without remounting).
  const [selectedPreviewItemId, setSelectedPreviewItemId] = useState<string | null>(
    defaultItem?.id ?? null,
  );
  useEffect(() => {
    setSelectedPreviewItemId(defaultItem?.id ?? null);
    // Re-seed when the evidence id changes (route param flip without
    // a full remount). defaultItem.id is the canonical key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.evidence.id]);

  // The item the main preview should render. Falls back to defaultItem
  // when the selected id no longer exists in the list (e.g. after a
  // contentItems refresh dropped the previously-selected file).
  const selectedItem =
    contentItems.find((it) => it.id === selectedPreviewItemId) ??
    defaultItem;

  const renderPreview = () => {
    if (!selectedItem || !selectedItem.viewUrl) {
      return (
        <div className="evidence-detail-preview-placeholder">
          <strong>Open the original evidence record to review preserved content.</strong>
          <p>Reviewer-facing preview is not available for this selection in the current response.</p>
        </div>
      );
    }

    if (selectedItem.kind === "image") {
      return (
        <img
          key={selectedItem.id}
          src={selectedItem.viewUrl}
          alt={selectedItem.label}
          className="evidence-detail-preview-media"
        />
      );
    }

    if (selectedItem.kind === "video") {
      return (
        <video
          key={selectedItem.id}
          controls
          preload="metadata"
          className="evidence-detail-preview-media"
          src={selectedItem.viewUrl}
        >
          Your browser could not load this video preview.
        </video>
      );
    }

    if (selectedItem.kind === "audio") {
      return (
        <div className="evidence-detail-preview-audio">
          <audio
            key={selectedItem.id}
            controls
            preload="metadata"
            src={selectedItem.viewUrl}
          >
            Your browser could not load this audio preview.
          </audio>
        </div>
      );
    }

    if (selectedItem.kind === "pdf") {
      return (
        <iframe
          key={selectedItem.id}
          title={selectedItem.label}
          src={selectedItem.viewUrl}
          className="evidence-detail-preview-frame"
        />
      );
    }

    return (
      <div
        className="evidence-detail-preview-placeholder"
        data-evidence-preview-unsupported
      >
        <strong>Preview is not available for this file type.</strong>
        <p>
          <span className="evidence-detail-preview-filename">
            {selectedItem.originalFileName || selectedItem.label}
          </span>
          {" — "}
          {selectedItem.kind}
          {selectedItem.sizeBytes
            ? ` · ${selectedItem.displaySizeLabel || formatBytes(selectedItem.sizeBytes)}`
            : ""}
        </p>
        <p>Use the original access actions to review the preserved material directly.</p>
      </div>
    );
  };

  return (
    <section className="evidence-detail-section">
      {/* Canonical section head: plain heading + canonical secondary
          actions. The former kicker/icon SectionHeading presentation is
          retired here, so the tab has one heading treatment throughout. */}
      <div className="evidence-detail-section-head">
        <h2 className="evidence-detail-section-title">Evidence Preview</h2>
        <div className="evidence-detail-section-head__actions">
          <button
            type="button"
            className="app-secondary-action"
            onClick={onOpenOriginal}
          >
            Open original
          </button>
          <button
            type="button"
            className="app-secondary-action"
            onClick={onDownloadOriginal}
          >
            Download
          </button>
        </div>
      </div>

      <div className="evidence-detail-preview-shell">{renderPreview()}</div>

      <div
        className="evidence-detail-item-grid"
        role="listbox"
        aria-label="Evidence files"
      >
        {contentItems.map((item) => {
          const privateItemNote = privateItemNotesById.get(item.id);
          const itemWithMeta = item as typeof item & {
            privateRole?: string | null;
            sourceLabel?: string | null;
          };
          const isSelected = item.id === selectedItem?.id;
          // P0 fix — cards are now interactive: clicking (or
          // pressing Enter/Space when focused) updates the
          // selected-preview state, which the main preview above
          // reads via renderPreview(). Render as <button type=
          // "button"> for native keyboard + a11y semantics; the
          // listbox role on the wrapper + aria-selected on each
          // card give screen readers the same model as a single-
          // select gallery.
          return (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={isSelected}
              aria-pressed={isSelected}
              onClick={() => setSelectedPreviewItemId(item.id)}
              className={
                isSelected
                  ? "evidence-detail-item-card evidence-detail-item-card--selected"
                  : "evidence-detail-item-card"
              }
              data-content-item-card={item.id}
              data-content-item-selected={isSelected ? "true" : "false"}
            >
              <div className="evidence-detail-item-row">
                <strong>{item.label}</strong>
                <span
                  className="app-status-text"
                  data-size="sm"
                  data-tone={mediaKindTone(item.kind)}
                >
                  {item.kind}
                </span>
              </div>
              <p>{item.originalFileName || "Original filename not recorded"}</p>
              <div className="evidence-detail-definition-inline">
                <span>Size</span>
                <strong>{item.displaySizeLabel || formatBytes(item.sizeBytes)}</strong>
              </div>
              <div className="evidence-detail-definition-inline">
                <span>Role</span>
                <strong>{describeContentItemRole(item)}</strong>
              </div>
              {itemWithMeta.privateRole ? (
                <div
                  className="evidence-detail-definition-inline"
                  data-content-item-private-role
                >
                  <span>Capture role (private)</span>
                  <strong>{itemWithMeta.privateRole}</strong>
                </div>
              ) : null}
              {itemWithMeta.sourceLabel ? (
                <div
                  className="evidence-detail-definition-inline"
                  data-content-item-source-label
                >
                  <span>Source</span>
                  <strong>{itemWithMeta.sourceLabel}</strong>
                </div>
              ) : null}
              {privateItemNote ? (
                <div
                  className="evidence-detail-definition-inline"
                  data-content-item-private-note
                >
                  <span>Private item note</span>
                  <strong>{privateItemNote}</strong>
                </div>
              ) : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Overview summary-card row — the five operational facts the record header
 * cannot carry. Cards share one grid so they keep equal height and reflow
 * 5 -> 3 -> 2 -> 1 without any card sizing itself from its own content.
 */
export function SummaryCardRow({
  items,
}: {
  items: Array<{ label: string; value: string; ok?: boolean }>;
}) {
  return (
    <div className="evidence-detail-summary-row" data-evidence-summary-row>
      {items.map((item) => (
        <div key={item.label} className="evidence-detail-summary-card">
          <span className="evidence-detail-summary-card__label">{item.label}</span>
          <span className="evidence-detail-summary-card__value">
            <span className="evidence-detail-summary-card__value-text">{item.value}</span>
            {item.ok ? (
              <CircleCheck
                size={16}
                strokeWidth={2}
                aria-hidden="true"
                className="evidence-detail-summary-card__ok"
              />
            ) : null}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Record Summary — the same field/value pairs as KeyValueGrid, laid out as
 * discrete cards. Values wrap or clamp inside their own card, so a long
 * workspace, case or filename can never widen the grid.
 */
export function RecordSummaryGrid({
  items,
}: {
  items: Array<{ label: string; value: string }>;
}) {
  return (
    <div className="evidence-detail-record-grid" data-evidence-record-grid>
      {items.map((item) => (
        <div key={item.label} className="evidence-detail-record-card">
          <span className="evidence-detail-record-card__label">{item.label}</span>
          <span className="evidence-detail-record-card__value">{item.value}</span>
        </div>
      ))}
    </div>
  );
}

export function KeyValueGrid({ items }: { items: Array<{ label: string; value: string }> }) {
  return (
    <div className="evidence-detail-data-grid">
      {items.map((item) => (
        <div key={item.label} className="evidence-detail-data-cell">
          <span>{item.label}</span>
          <strong>{item.value}</strong>
        </div>
      ))}
    </div>
  );
}

export function CaptureTemplateCard({
  intakePlanJson,
  contentItems,
}: {
  intakePlanJson: unknown;
  contentItems: Array<{ checklistStepId?: string | null }>;
}) {
  const locale = useOptionalLocale();
  if (!intakePlanJson || typeof intakePlanJson !== "object") return null;
  const plan = intakePlanJson as Record<string, unknown>;
  const templateName =
    typeof plan.templateName === "string" ? plan.templateName : null;
  const templateId =
    typeof plan.templateId === "string" ? plan.templateId : null;
  const mode = typeof plan.mode === "string" ? plan.mode : null;
  const locationRequirement =
    typeof plan.locationRequirement === "string"
      ? plan.locationRequirement
      : null;
  const locationCopy = evidenceLocationCopy(locale);
  const required = Array.isArray(plan.requiredSteps)
    ? (plan.requiredSteps as Array<{ id?: string; title?: string }>)
    : [];
  const optional = Array.isArray(plan.optionalSteps)
    ? (plan.optionalSteps as Array<{ id?: string; title?: string }>)
    : [];

  if (!templateName && !templateId && required.length === 0 && optional.length === 0) {
    return null;
  }

  const mappedIds = new Set<string>();
  for (const it of contentItems) {
    if (it.checklistStepId) mappedIds.add(it.checklistStepId);
  }
  const requiredMappedCount = required.filter(
    (s) => s.id && mappedIds.has(s.id),
  ).length;
  const requiredMissing = required.filter(
    (s) => s.id && !mappedIds.has(s.id),
  );

  return (
    <section
      className="evidence-detail-section"
      data-evidence-section="capture-template"
    >
      <SummaryCardRow
        items={[
          { label: "Template", value: templateName || templateId || "Not recorded" },
          {
            label: "Mode",
            value:
              mode === "CHECKLIST_REQUIRED"
                ? "Checklist required"
                : mode === "FLEXIBLE"
                  ? "Flexible"
                  : (mode ?? "Not recorded"),
          },
          {
            label: "Required steps",
            value:
              required.length === 0
                ? "None declared"
                : `${requiredMappedCount} of ${required.length}`,
            // The tick is truthful: it appears only when every declared
            // required step is actually mapped to preserved content.
            ok: required.length > 0 && requiredMappedCount === required.length,
          },
          {
            label: "Optional steps",
            value: optional.length === 0 ? "None" : String(optional.length),
          },
          // What the PLAN asked for — a workflow fact, labelled as one so it
          // never reads as the recorded location (that is the Location row of
          // the Integrity tab). A plan that set no level says so; "Not
          // recorded" is a statement about the record, not the plan.
          {
            label: locationCopy.requirementRow.label,
            value: locationRequirementRowValue(locale, locationRequirement),
          },
        ]}
      />
      {requiredMissing.length > 0 ? (
        <div
          data-capture-template-missing
          className="app-alert app-alert--warn evidence-detail-template-missing"
          role="status"
        >
          <strong>Unmapped required step{requiredMissing.length === 1 ? "" : "s"}:</strong>{" "}
          {requiredMissing.map((s) => s.title || s.id || "Untitled").join(" · ")}
        </div>
      ) : null}
    </section>
  );
}

export function EventTimeline({
  title,
  subtitle,
  events,
  icon,
}: {
  title: string;
  subtitle: string;
  events: TimelineEvent[];
  icon: LucideIcon;
}) {
  return (
    <section className="evidence-detail-section">
      <div className="evidence-detail-section-header">
        <SectionHeading kicker={title} title={subtitle} icon={icon} />
      </div>

      {events.length === 0 ? (
        <p className="evidence-detail-muted">No events recorded in the current API response.</p>
      ) : (
        <div className="evidence-detail-timeline">
          {events.map((event) => (
            <article key={`${event.sequence}-${event.eventType}`} className="evidence-detail-timeline-item">
              <div className="evidence-detail-timeline-dot" aria-hidden="true" />
              <div>
                <div className="evidence-detail-item-row">
                  <strong>{custodyEventLabel(event.eventType)}</strong>
                  <span>{formatUserDateTime(event.atUtc)}</span>
                </div>
                <p>{event.payloadSummary || "No event summary recorded."}</p>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}


/**
 * Evidence Record hero — icon-only action group.
 *
 * Lives here rather than in page.tsx because the orchestrator is held under a
 * byte-size guard whose whole purpose is to stop presentation accumulating in
 * the route file. Every control maps to an action the route already owned; the
 * caller still owns the handlers, permissions and disabled reasons.
 */
/**
 * The hero action stack.
 *
 * These were four 40x40 icon squares with no visible text: an operator had to
 * hover each one to learn what it did, and a chain link, a padlock, a box and
 * a pencil are not self-evident on a record whose whole subject is custody.
 * Each is now icon + a short label, in the canonical action primitives —
 * `app-primary-action` for Copy link (the dark treatment), `app-secondary-action`
 * for the rest — stacked vertically at equal width. Compact deliberately: this
 * is a sidebar of record operations, not the page's call to action.
 *
 * The name is kept because every call site and the layout gate use it; what
 * changed is the presentation, not the set of actions or their guards.
 */
export function EvidenceHeroIconActions({
  lockedAt,
  archivedAt,
  deleted,
  shareUrl,
  isIntegrityFailed,
  titles,
  onUnlock,
  onLock,
  onRestoreArchived,
  onArchive,
  onMoveToTrash,
  trashDisabled,
  trashReason,
  onEditLabel,
}: {
  lockedAt: string | null | undefined;
  archivedAt: string | null | undefined;
  deleted: boolean;
  shareUrl: string | null | undefined;
  isIntegrityFailed: boolean;
  titles: { share: string; lock: string; unlock: string; archive: string; restore: string };
  onUnlock: () => void;
  onLock: () => void;
  onRestoreArchived: () => void;
  onArchive: () => void;
  onMoveToTrash: () => void;
  /** From the canonical projection. The header never decides this itself. */
  trashDisabled: boolean;
  /** The server's own refusal, shown on hover when the control is disabled. */
  trashReason: string | null;
  onEditLabel: () => void;
}) {
  return (
      <div className="evidence-detail-hero-icon-actions">
        {/* THE record's canonical verification page (`pvr_`), opened — the same
            link the report's QR code, its printed URL and the verification
            package carry. Anyone holding it can open it without logging in;
            no publication or recipient link is involved. The accessible name
            keeps the visible label as a contiguous substring (WCAG 2.5.3). */}
        {shareUrl && !isIntegrityFailed ? (
          <a
            href={shareUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="app-secondary-action app-secondary-action--filled evidence-detail-hero-action"
            aria-label="Verification link — open the verification page"
            title={titles.share}
            data-evidence-action="open-verification-link"
          >
            <Link2 size={15} strokeWidth={1.9} aria-hidden="true" />
            <span>Verification link</span>
          </a>
        ) : (
          <button
            type="button"
            className="app-secondary-action app-secondary-action--filled evidence-detail-hero-action"
            disabled
            aria-label="Verification link — open the verification page"
            title={titles.share}
            data-evidence-action="open-verification-link"
          >
            <Link2 size={15} strokeWidth={1.9} aria-hidden="true" />
            <span>Verification link</span>
          </button>
        )}

        {lockedAt ? (
          <button
            type="button"
            className="app-secondary-action evidence-detail-hero-action"
            onClick={onUnlock}
            disabled={deleted}
            title={titles.unlock}
            data-evidence-action="unlock-record"
          >
            <LockOpen size={15} strokeWidth={1.9} aria-hidden="true" />
            <span>Unlock</span>
          </button>
        ) : (
          <button
            type="button"
            className="app-secondary-action evidence-detail-hero-action"
            onClick={onLock}
            disabled={deleted || isIntegrityFailed}
            title={titles.lock}
            data-evidence-action="lock-record"
          >
            <Lock size={15} strokeWidth={1.9} aria-hidden="true" />
            <span>Lock</span>
          </button>
        )}

        {archivedAt ? (
          <button
            type="button"
            className="app-secondary-action evidence-detail-hero-action"
            onClick={onRestoreArchived}
            disabled={deleted}
            title={titles.restore}
            data-evidence-action="restore-archived"
          >
            <RotateCcw size={15} strokeWidth={1.9} aria-hidden="true" />
            <span>Restore</span>
          </button>
        ) : (
          <button
            type="button"
            className="app-secondary-action evidence-detail-hero-action"
            onClick={onArchive}
            disabled={deleted}
            title={titles.archive}
            data-evidence-action="archive-evidence"
          >
            <Archive size={15} strokeWidth={1.9} aria-hidden="true" />
            <span>Archive</span>
          </button>
        )}

        {/* MOVE TO TRASH — recoverable, and gated by the SAME projection the
            Review tab's control reads. Disabled with the server's reason
            rather than hidden: a control that vanishes teaches nothing, and
            one that opens a modal only to 409 is worse. */}
        <button
          type="button"
          className="app-secondary-action evidence-detail-hero-action evidence-detail-danger-action"
          onClick={() => {
            if (trashDisabled) return;
            onMoveToTrash();
          }}
          disabled={trashDisabled}
          aria-disabled={trashDisabled}
          title={trashDisabled ? (trashReason ?? undefined) : "Move to trash"}
          data-evidence-action="header-trash"
          data-evidence-trash-disabled={trashDisabled ? "true" : "false"}
        >
          <Trash2 size={15} strokeWidth={1.9} aria-hidden="true" />
          <span>Move to trash</span>
        </button>

        <button
          type="button"
          className="app-secondary-action evidence-detail-hero-action"
          onClick={onEditLabel}
          title="Edit the evidence name"
          data-evidence-action="edit-label"
        >
          <Pencil size={15} strokeWidth={1.9} aria-hidden="true" />
          <span>Edit name</span>
        </button>
      </div>
  );
}

// ---------------------------------------------------------------------------
// Shared right-rail tones
//
// The rail is one authority used by every tab, so these live here rather than
// in any single tab. Each maps a real projection value onto the canonical
// AppTone vocabulary; none of them invents a state.
// ---------------------------------------------------------------------------

export function getWorkflowStatusTone(status: string | null | undefined): AppTone {
  switch ((status ?? "").toUpperCase()) {
    case "APPROVED":
    case "COMPLETED":
      return "green";
    case "REJECTED":
      return "red";
    case "IN_REVIEW":
    case "ASSIGNED":
      return "blue";
    case "CHANGES_REQUESTED":
      return "amber";
    default:
      return "slate";
  }
}

export function getPriorityTone(priority: string | null | undefined): AppTone {
  switch ((priority ?? "").toUpperCase()) {
    case "URGENT":
    case "CRITICAL":
      return "red";
    case "HIGH":
      return "amber";
    case "NORMAL":
    case "MEDIUM":
      return "blue";
    case "LOW":
      return "slate";
    default:
      return "slate";
  }
}
