import { useCallback, useEffect, useMemo, useState } from "react";
import { OperationalTimeline } from "../../../src/ui/operational-timeline";
import { ArtifactHistoryPanel } from "../../../src/ui/artifact-history";
import {
  buildPackageDownloadPath,
  packageDownloadMessage,
  projectArtifactHistory,
  type ArtifactHistory,
} from "../../../src/product/artifact-history";
import { TrustDecisionCard } from "../../../src/ui/trust-decision";
import { EvidenceComparisonPanel } from "../../../src/ui/evidence-comparison";
import { AiCategorizationPanel } from "../../../src/ui/ai-categorization";
import { CopyButton, copyToClipboard } from "../../../src/ui/copy-button";
import { projectTrustDecision, type TrustDecision } from "../../../src/product/trust-decision";
import { Alert, Linking, Pressable, Share, View, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { EvidenceOutputState } from "@proovra/shared";
import { apiFetch } from "../../../src/api";
import { EvidenceInternalMaterials } from "../../../src/ui/evidence-internal-materials";
import { toSafeUserError, type SafeError } from "../../../src/errors/safe-error";
import { formatUserDateTime } from "../../../src/lib/date";
import { theme } from "../../../src/theme/theme";
import {
  ProovraScreen,
  ProovraCard,
  ProovraSection,
  ProovraText,
  ProovraButton,
  ProovraBadge,
  ProovraListRow,
  ProovraConfirmSheet,
  ProovraInput,
  ProovraFormField,
  ProovraSheet,
  ProovraFilterChips,
  ProovraEmptyState,
  ProovraErrorState,
  ProovraLoadingState,
} from "../../../src/ui";
import {
  evidenceStatusDisplay,
  verificationStatusDisplay,
  humanizeEnum,
} from "../../../src/product/domain-display";
import {
  DUPLICATE_COPY,
  DUPLICATE_LIMITATION,
  buildEvidenceArchivePath,
  buildEvidenceLabelPath,
  buildEvidenceOriginalPath,
  buildEvidenceRelationshipsPath,
  buildEvidenceRelationshipPath,
  buildRelationshipBody,
  relationshipEditRefusal,
  relationshipTypeLabel,
  EVIDENCE_RELATIONSHIP_TYPES,
  parseOriginalLink,
  originalAccessRefusal,
  ORIGINAL_ACCESS_CONSEQUENCE,
  buildEvidenceLabelBody,
  validateEvidenceLabel,
  evidenceLabelRefusal,
  EVIDENCE_LABEL_MAX,
  buildEvidenceLockPath,
  buildEvidencePath,
  buildEvidenceUnarchivePath,
  buildEvidenceRestorePath,
  relationshipRemoveCopy,
  TRASH_COPY,
  buildEvidenceUnlockPath,
  evidenceIsLocked,
  lifecycleBlockReasonLabel,
  parseEvidenceLifecycle,
  type EvidenceLifecycle,
  REGENERATE_CONSEQUENCE,
  buildDuplicatesPath,
  buildRegeneratePath,
  duplicateMatchSummary,
  generationActionLabel,
  generationNeedsConfirmation,
  parseDuplicateReport,
  readGenerationOutcome,
  type DuplicateReport,
  projectPreservation,
  projectRelationships,
  projectCaseAssignment,
  projectCaptureLocation,
  projectReviewerAudit,
  REVIEWER_AUDIT_COPY,
  type ReviewerAuditItem,
  EXIF_REPRESENTATIVE_NOTE,
  INTEGRITY_ADVISORY,
  INTEGRITY_SECTION_TITLE,
  LOCATION_NOT_PROVIDED,
  PER_PARTS_EMPTY,
  CAPTURE_LOCATION_COPY,
  type CaptureLocationView,
  buildEligibleCasesPath,
  parseEligibleCases,
  buildCaseEvidencePath,
  buildCaseEvidenceItemPath,
  CASE_ASSIGN_COPY,
  type CaseAssignmentView,
  EVIDENCE_COMMENT_VISIBILITIES,
  buildCommentBody,
  buildCommentPath,
  buildCommentsPath,
  commentVisibilityLabel,
  isSendableComment,
  projectComments,
  type EvidenceComment,
  type EvidenceCommentVisibility,
  projectMaterials,
  materialBlockedReason,
  type MaterialItem,
  projectProvenance,
  projectTechnical,
  projectRiskSignals,
  projectSourceBoundary,
  DEFAULT_LOCATION_BOUNDARY,
  deriveEvidenceAttention,
  type RiskSignal,
  partMetaLine,
  technicalPartFor,
  type TechnicalPart,
  type PreservationView,
  type RelationshipView,
  type ProvenanceView,
  type TechnicalView,
} from "../../../src/product/evidence-detail";
import {
  LIFECYCLE_DIALOG_COPY,
  UNLOCK_REASON_MAX,
  buildPreservationMatrix,
  buildPublishedVerificationUrl,
  buildSnapshotTiming,
  buildSourceContextFacts,
  buildUnlockBody,
  custodyChainLabel,
  downloadBlockedReason,
  isIntegrityFailed,
  isOtsTerminal,
  lifecycleFacts,
  projectArtifactOutputs,
  projectCaptureTemplate,
  projectCustodyTimelines,
  projectOtsEffectiveStatus,
  projectPreview,
  projectPublicVerification,
  projectRecord,
  recordSummaryItems,
  relationshipDirectionLabel,
  type ArtifactOutputs,
} from "../../../src/product/evidence-record";
import {
  buildDivergenceReasons,
  buildEventCountRows,
  buildHashRows,
  buildTechnicalAppendix,
} from "../../../src/product/evidence-technical-appendix";
import {
  ArtifactLifecyclePanel,
  CaptureNoteCard,
  CaptureTemplateCard,
  CustodyTimelineCard,
  EvidencePreview,
  EvidenceRecordRail,
  FactsGrid,
  HeroIdentityLine,
  IntegrityFailedBanner,
  IntegritySection,
  LatestVerificationLinkCard,
  LifecycleManagementCard,
  NextActionsCard,
  PreservationMatrix,
  PrivateNotesHead,
  PublicVerificationSharing,
  RecordSummaryCard,
  ReviewHero,
  SnapshotTimingSection,
} from "../../../src/ui/evidence-record-sections";
import {
  TechnicalAppendixBlocks,
  TechnicalAppendixIntro,
  TechnicalEvidenceContext,
} from "../../../src/ui/evidence-technical-appendix";
import { webOrigin } from "../../../src/product/intake-create";
import { isDerivedReviewEligible } from "../../../src/product/derived-review";
import { DerivedReviewTab } from "../../../src/ui/derived-review-tab";
import { CaptureLocationMap } from "../../../src/ui/capture-location-map";
import { EvidenceDeclarationsPanel } from "../../../src/ui/evidence-declarations";
import { TeamResponsibilityPanel } from "../../../src/ui/team-responsibility";
import { EvidenceLinkedRequests } from "../../../src/ui/evidence-linked-requests";
import { projectRequestTeamId } from "../../../src/product/evidence-linked-requests";
import { projectDiscussionCaps } from "../../../src/product/evidence-discussion";
import {
  EXPORT_CHECK_FAILED,
  EXPORT_NEXT_STEP,
  EXPORT_OUTCOME_LABEL,
  buildExportEligibilityPath,
  parseExportEligibility,
  type ExportEligibility,
} from "../../../src/product/export-eligibility";
import { EvidenceDiscussion } from "../../../src/ui/evidence-discussion";
import { ProvenanceChainSection } from "../../../src/ui/provenance-chain";
import { ReviewActionsPanel } from "../../../src/ui/review-actions-panel";
import { RuntimeStatusBanner } from "../../../src/ui/runtime-status-banner";
import { PresenceIndicator } from "../../../src/ui/presence-indicator";
import { MediaIntelligencePanel } from "../../../src/ui/media-intelligence-panel";
import { EvidenceCopilot } from "../../../src/ui/evidence-copilot";
import { projectReviewWorkflowRef, type ReviewWorkflowRef } from "../../../src/product/review-actions";
import { ReviewerWorkflowPanel } from "../../../src/ui/reviewer-workflow-panel";
import { usePlatformContext } from "../../../src/product/platform-context";
import {
  buildLibraryQuery,
  parseEvidencePickerRows,
  type EvidencePickerRow,
} from "../../../src/product/evidence-library";

type Tab =
  | "overview"
  | "integrity"
  | "custody"
  | "technical"
  | "links"
  | "materials"
  | "review"
  | "discussion"
  | "artifacts"
  | "duplicates"
  | "internal"
  | "derived";
type LoadState = "loading" | "ready" | "error" | "notfound";
type LifecycleDialog = null | "lock" | "unlock" | "archive" | "restore";

interface Core {
  status: string;
  statusLabel: string | null;
  verificationStatus: string | null;
  verificationStatusLabel: string | null;
  displayTitle: string | null;
  originalFileName: string | null;
  createdAt: string | null;
  type: string;
  fileSha256: string | null;
  fingerprintHash: string | null;
  lockedAt: string | null;
}

const EMPTY_OUTPUTS: ArtifactOutputs = projectArtifactOutputs(null);

export default function EvidenceDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const id = params.id ?? "";

  const [tab, setTab] = useState<Tab>("overview");
  // T-12 — the record's case, and the eligibility-narrowed picker.
  const [caseAssignment, setCaseAssignment] = useState<CaseAssignmentView | null>(null);
  const [eligibleCases, setEligibleCases] = useState<Array<{ id: string; name: string }> | null>(null);
  const [assigningCase, setAssigningCase] = useState(false);
  const openCaseAssign = () => {
    setAssigningCase(true);
    setEligibleCases(null);
    apiFetch(buildEligibleCasesPath(String(id)))
      .then((d) => setEligibleCases(parseEligibleCases(d)))
      .catch(() => setEligibleCases([]));
  };
  const [removingCase, setRemovingCase] = useState(false);
  const [caseBusy, setCaseBusy] = useState(false);
  const [caseMessage, setCaseMessage] = useState<string | null>(null);
  const [captureLocation, setCaptureLocation] = useState<CaptureLocationView | null>(null);
  const [requestTeamId, setRequestTeamId] = useState<string | null>(null);
  const [discussionCaps, setDiscussionCaps] = useState<{ visible: boolean; readOnly: boolean }>({ visible: false, readOnly: false });
  const [commentsFailed, setCommentsFailed] = useState(false);
  const [reviewWorkflow, setReviewWorkflow] = useState<ReviewWorkflowRef | null>(null);
  const [analysisRevision, setAnalysisRevision] = useState<string | null>(null);
  /** The review-workspace reply itself; every web section projects from it. */
  const [rw, setRw] = useState<unknown>(null);
  /** Bumped to open the reviewer-workflow editor from the hero / attention strip. */
  const [workflowOpenRequest, setWorkflowOpenRequest] = useState(0);

  const [duplicates, setDuplicates] = useState<DuplicateReport | null>(null);
  // The SERVER's verdicts. Absent withholds: a client that defaulted to "yes"
  // would put a destructive control in front of someone the server refuses.
  const [lifecycle, setLifecycle] = useState<EvidenceLifecycle | null>(null);
  /** Renaming the record. The route is PATCH /v1/evidence/:id/label. */
  const [renaming, setRenaming] = useState(false);
  const [labelDraft, setLabelDraft] = useState("");
  const [labelBusy, setLabelBusy] = useState(false);
  /** Opening the ORIGINAL file. A GET that writes to the custody chain. */
  const [originalBusy, setOriginalBusy] = useState(false);
  /** Linking this record to another. The picker reads the library. */
  const [linking, setLinking] = useState(false);
  const [linkType, setLinkType] = useState<string>("RELATED");
  const [linkTypePicker, setLinkTypePicker] = useState(false);
  const [linkNote, setLinkNote] = useState("");
  const [linkTarget, setLinkTarget] = useState<{ id: string; title: string } | null>(null);
  const [linkCandidates, setLinkCandidates] = useState<EvidencePickerRow[] | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [duplicatesPhase, setDuplicatesPhase] = useState<"idle" | "loading" | "failed">("idle");
  const [generating, setGenerating] = useState(false);
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false);
  const [generationNote, setGenerationNote] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<SafeError | null>(null);
  const [core, setCore] = useState<Core | null>(null);
  const [reportState, setReportState] = useState<EvidenceOutputState | null>(null);
  const [packageState, setPackageState] = useState<string | null>(null);
  const [outputs, setOutputs] = useState<ArtifactOutputs>(EMPTY_OUTPUTS);
  const [riskSignals, setRiskSignals] = useState<RiskSignal[]>([]);
  const [trustDecision, setTrustDecision] = useState<TrustDecision | null>(null);
  const [sourceBoundary, setSourceBoundary] = useState<string | null>(null);
  const [artifactHistory, setArtifactHistory] = useState<ArtifactHistory>({ reports: [], packages: [] });
  // T-14 — workspace review actions (review-workspace reviewerAudit[]; web ReviewerAuditTrailSection).
  const [reviewerAudit, setReviewerAudit] = useState<ReviewerAuditItem[]>([]);
  // T-15 — the governed-export preflight (GovernedExportAction), read when the
  // record has a READY report; the download is refused with its reason before
  // the audited URL is minted.
  const [exportCheck, setExportCheck] = useState<{ phase: "idle" | "loading" | "failed" } | { phase: "ready"; value: ExportEligibility }>({ phase: "idle" });
  const [downloading, setDownloading] = useState(false);
  const [packageBusy, setPackageBusy] = useState(false);
  const [packageMessage, setPackageMessage] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [dialog, setDialog] = useState<LifecycleDialog>(null);
  const [unlockReason, setUnlockReason] = useState("");
  // Real review-workspace projections (bound from the CURRENT documented shape).
  const [preservation, setPreservation] = useState<PreservationView | null>(null);
  const [relationships, setRelationships] = useState<RelationshipView[]>([]);
  const [provenance, setProvenance] = useState<ProvenanceView | null>(null);
  // UC-4 reads are workspace-scoped, so the derived tab needs the active team.
  // ONE call: the module is the single reader of /v1/platform/context, and a
  // second hook here would be a second fetch of the same envelope.
  const platform = usePlatformContext();
  // The SERVER gate for reviewer-ops surfaces, read exactly as the web reads
  // it. Nothing native derives "enterprise" from a plan name; absent is false,
  // which withholds rather than offers.
  // Internal materials are reviewer operations, which TEAM and above include.
  const reviewerOperations = platform.context?.reviewerOperations === true;
  // The web's usePlanFeatureGate("intakeIncluded") — the server-projected plan feature.
  const intakeIncluded =
    (platform.envelope as { planFeatures?: Record<string, unknown> } | null)?.planFeatures?.["intakeIncluded"] === true;
  const exportTeamId = platform.context?.activeTeamId ?? null;
  const checkExport = useCallback(async () => {
    if (!id || !exportTeamId) {
      setExportCheck({ phase: "failed" });
      return null;
    }
    setExportCheck({ phase: "loading" });
    try {
      const v = parseExportEligibility(await apiFetch(buildExportEligibilityPath(exportTeamId, String(id))));
      setExportCheck(v ? { phase: "ready", value: v } : { phase: "failed" });
      return v;
    } catch {
      setExportCheck({ phase: "failed" });
      return null;
    }
  }, [id, exportTeamId]);
  const reportAvailable = outputs.reportAvailable || reportState === "READY";
  // The web header runs its governance check on load (page.tsx:1217); the
  // report control is the header's, so the preflight is too.
  useEffect(() => {
    if (reportAvailable) void checkExport();
  }, [reportAvailable, checkExport]);
  /** Minted on tap, only when the governed preflight says ALLOWED. */
  const downloadReport = useCallback(async () => {
    const v = await checkExport();
    if (!v || v.outcome !== "ALLOWED") return;
    setDownloading(true);
    try {
      const report = await apiFetch(`/v1/evidence/${id}/report/latest`);
      const url = typeof report?.url === "string" ? report.url : null;
      if (url) await Linking.openURL(url);
      else Alert.alert("Report unavailable", "No report is available for this record yet.");
    } catch (err) {
      Alert.alert("Could not open report", toSafeUserError(err).message);
    } finally {
      setDownloading(false);
    }
  }, [checkExport, id]);
  /** GET /verification-package records a custody download, so it is minted on tap only. */
  const downloadPackage = useCallback(async () => {
    setPackageBusy(true);
    setPackageMessage(null);
    try {
      const data = (await apiFetch(buildPackageDownloadPath(String(id)))) as { url?: unknown; code?: unknown } | null;
      if (data && typeof data.url === "string" && data.url.length > 0) await Linking.openURL(data.url);
      else setPackageMessage(packageDownloadMessage(typeof data?.code === "string" ? data.code : null, null));
    } catch (err) {
      const e = err as { code?: unknown; statusCode?: unknown } | null;
      setPackageMessage(packageDownloadMessage(typeof e?.code === "string" ? e.code : null, typeof e?.statusCode === "number" ? e.statusCode : null));
    } finally {
      setPackageBusy(false);
    }
  }, [id]);
  const [technical, setTechnical] = useState<TechnicalView | null>(null);
  const [technicalRaw, setTechnicalRaw] = useState<{ phase: "loading" | "ready" | "error"; payload: unknown }>({ phase: "loading", payload: null });
  const [materials, setMaterials] = useState<MaterialItem[]>([]);
  const [comments, setComments] = useState<EvidenceComment[] | null>(null);
  const [draft, setDraft] = useState("");
  const [visibility, setVisibility] = useState<EvidenceCommentVisibility>("INTERNAL");
  const [commentBusy, setCommentBusy] = useState(false);
  const [editingComment, setEditingComment] = useState<{ id: string; body: string } | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setState((prev) => (prev === "ready" ? prev : "loading"));
    setError(null);
    try {
      const data = await apiFetch(`/v1/evidence/${id}`);
      const ev = (data.evidence ?? {}) as Record<string, unknown>;
      // The canonical lifecycle projection travels ON the record. Its own type
      // says "Every field is a RESULT. Nothing here lets a client re-derive a
      // verdict" — so it is read, and an absent one withholds.
      setLifecycle(parseEvidenceLifecycle(ev) ?? parseEvidenceLifecycle(data));
      setCore({
        status: (ev.status as string) ?? "SIGNED",
        statusLabel: (ev.statusLabel as string) ?? null,
        verificationStatus: (ev.verificationStatus as string) ?? null,
        verificationStatusLabel: (ev.verificationStatusLabel as string) ?? null,
        displayTitle: (ev.displayTitle as string) ?? (ev.displayFileName as string) ?? null,
        originalFileName: (ev.originalFileName as string) ?? null,
        createdAt: (ev.createdAt as string) ?? null,
        type: (ev.type as string) ?? "Evidence",
        fileSha256: (ev.fileSha256 as string) ?? null,
        fingerprintHash: (ev.fingerprintHash as string) ?? null,
        lockedAt: typeof ev.lockedAt === "string" && ev.lockedAt ? ev.lockedAt : null,
      });
      setState("ready");
    } catch (err) {
      const safe = toSafeUserError(err);
      if (safe.kind === "notFound") {
        setState("notfound");
      } else {
        setError(safe);
        setState("error");
      }
      return;
    }

    // STATUS ONLY. The report URL is minted ON TAP (downloadReport): GET
    // /report/latest records a custody/audit DOWNLOAD, and minting it on load
    // wrote a download into the chain every time someone merely opened a
    // record whose report was ready — a false statement in the custody record.
    try {
      const st = await apiFetch(`/v1/evidence/${id}/artifacts/status`);
      setReportState((st?.outputs?.report?.state ?? null) as EvidenceOutputState | null);
      setPackageState(typeof st?.outputs?.verificationPackage?.state === "string" ? st.outputs.verificationPackage.state : null);
      setOutputs(projectArtifactOutputs(st));
    } catch {
      setReportState(null);
      setPackageState(null);
      setOutputs(EMPTY_OUTPUTS);
    }

    // Rich review-workspace projection — bind the REAL documented shape
    // (custody events, TSA/OTS, signature, relationships, provenance). Defensive:
    // render only what is present; never fabricate integrity/custody facts.
    try {
      const data = await apiFetch(`/v1/evidence/${id}/review-workspace`);
      setRw(data);
      setPreservation(projectPreservation(data));
      setRelationships(projectRelationships(data));
      setCaseAssignment(projectCaseAssignment(data));
      setRequestTeamId(projectRequestTeamId(data));
      setDiscussionCaps(projectDiscussionCaps(data));
      setReviewWorkflow(projectReviewWorkflowRef(data));
      setCaptureLocation(projectCaptureLocation(data));
      setProvenance(projectProvenance(data));
      setMaterials(projectMaterials(data));
      setRiskSignals(projectRiskSignals(data));
      setTrustDecision(projectTrustDecision(data));
      setSourceBoundary(projectSourceBoundary(data));
      setArtifactHistory(projectArtifactHistory(data));
      setReviewerAudit(projectReviewerAudit(data));
      // The copilot's concurrency authority, carried opaquely (never defaulted).
      // It lives on the REVIEW-WORKSPACE record (`evidence.analysisRevision`),
      // as the web's EvidenceReviewTab reads it — GET /v1/evidence/:id has none.
      {
        const rev = (data as { evidence?: { analysisRevision?: unknown } } | null)?.evidence?.analysisRevision;
        setAnalysisRevision(typeof rev === "string" && rev.length > 0 ? rev : null);
      }
    } catch {
      setRw(null);
      setPreservation(null);
      setRelationships([]);
      setProvenance(null);
    }

    // Technical metadata + EXIF (separate endpoint; Personal/PRO-applicable).
    try {
      const tm = await apiFetch(`/v1/evidence/${id}/technical-metadata`);
      setTechnical(projectTechnical(tm));
      setTechnicalRaw({ phase: "ready", payload: tm });
    } catch {
      setTechnical(null);
      setTechnicalRaw({ phase: "error", payload: null });
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Duplicates load when the tab is opened, for the same reason the comments
  // do: a reader who never asks should not pay for the scan.
  const loadDuplicates = useCallback(async () => {
    if (!id) return;
    setDuplicatesPhase("loading");
    try {
      setDuplicates(parseDuplicateReport(await apiFetch(buildDuplicatesPath(String(id)))));
      setDuplicatesPhase("idle");
    } catch {
      setDuplicates(null);
      setDuplicatesPhase("failed");
    }
  }, [id]);

  const requestGeneration = useCallback(async () => {
    if (!id) return;
    setConfirmingRegenerate(false);
    setGenerating(true);
    setGenerationNote(null);
    try {
      // READ THE OUTCOME, NOT THE BOOLEAN. Six server answers used to collapse
      // into one sentence on the web, and two of them described work that was
      // never going to happen.
      const read = readGenerationOutcome(
        await apiFetch(buildRegeneratePath(String(id)), { method: "POST" }),
      );
      setGenerationNote(read.message);
      // Only reload when work was actually accepted; a refusal has nothing new
      // to show and a reload would imply something changed.
      if (read.acceptedWork) await load();
    } catch (err) {
      setGenerationNote(toSafeUserError(err).message);
    } finally {
      setGenerating(false);
    }
  }, [id, load]);

  // Comments load when the tab is opened rather than with the record: a
  // reviewer who never opens the discussion should not pay for it.
  const loadComments = useCallback(async () => {
    if (!id) return;
    try {
      setComments(projectComments(await apiFetch(buildCommentsPath(String(id)))));
      setCommentsFailed(false);
    } catch {
      // A failed read is SAID — it used to render "No comments on this record yet."
      setComments([]);
      setCommentsFailed(true);
    }
  }, [id]);

  useEffect(() => {
    if (tab === "discussion" && comments === null) void loadComments();
  }, [tab, comments, loadComments]);

  const postComment = useCallback(async () => {
    if (!id || !isSendableComment(draft)) return;
    setCommentBusy(true);
    try {
      await apiFetch(buildCommentsPath(String(id)), {
        method: "POST",
        body: JSON.stringify(buildCommentBody(draft, visibility)),
      });
      setDraft("");
      await loadComments();
    } catch (err) {
      Alert.alert("Could not post comment", toSafeUserError(err).message);
    } finally {
      setCommentBusy(false);
    }
  }, [id, draft, visibility, loadComments]);

  /** ReviewerCommentsPanel.tsx:47 — PATCH { body } (ReviewerCommentUpdateBody). */
  const saveCommentEdit = useCallback(async () => {
    if (!editingComment || !isSendableComment(editingComment.body)) return;
    setCommentBusy(true);
    try {
      await apiFetch(buildCommentPath(String(id), editingComment.id), {
        method: "PATCH",
        body: JSON.stringify({ body: editingComment.body.trim() }),
      });
      setEditingComment(null);
      await loadComments();
    } catch (err) {
      Alert.alert("Could not save comment", toSafeUserError(err).message);
    } finally {
      setCommentBusy(false);
    }
  }, [editingComment, id, loadComments]);
  const [deletingComment, setDeletingComment] = useState<string | null>(null);
  const deleteComment = useCallback(async () => {
    if (!deletingComment) return;
    setCommentBusy(true);
    try {
      await apiFetch(buildCommentPath(String(id), deletingComment), { method: "DELETE" });
      setDeletingComment(null);
      await loadComments();
    } catch (err) {
      Alert.alert("Could not delete comment", toSafeUserError(err).message);
    } finally {
      setCommentBusy(false);
    }
  }, [deletingComment, id, loadComments]);

  // THE PUBLIC VERIFICATION LINK. It is the review workspace's own
  // `publicVerificationSummary.sharePath` on the public web origin, and ONLY
  // when the summary is PUBLISHED (web buildPublishedVerificationUrl,
  // _lib.tsx:327). This used to ask GET /public/verify/:id for `publicUrl`, a
  // key that route never sends (evidence.routes.ts:13807) — so the link was
  // always "not published" — and every tap wrote a public verification-page
  // view into the record's analytics.
  const publicVerification = useMemo(() => projectPublicVerification(rw), [rw]);
  const shareUrl = useMemo(() => buildPublishedVerificationUrl(publicVerification, webOrigin()), [publicVerification]);
  const [copyVerifyState, setCopyVerifyState] = useState<"idle" | "copied">("idle");
  const copyVerification = useCallback(async () => {
    if (!shareUrl) {
      Alert.alert("Not available", "Public verification link is only available when publication state is PUBLISHED");
      return;
    }
    if (await copyToClipboard(shareUrl)) {
      setCopyVerifyState("copied");
      setTimeout(() => setCopyVerifyState("idle"), 2000);
    } else {
      Alert.alert("Could not copy", "Failed to copy verification link");
    }
  }, [shareUrl]);
  const shareVerification = useCallback(async () => {
    if (!shareUrl) return;
    try {
      await Share.share({ url: shareUrl, message: `Verify this PROOVRA record: ${shareUrl}` });
    } catch (err) {
      Alert.alert("Could not share", toSafeUserError(err).message);
    }
  }, [shareUrl]);

  /**
   * Rename the record.
   *
   * The one affordance that fixes the commonest real problem with a phone
   * capture: it arrives called IMG_0042.jpg, and the only person who knows
   * what it is is holding the phone. PATCH /v1/evidence/:id/label.
   */
  const renameRecord = useCallback(async () => {
    const invalid = validateEvidenceLabel(labelDraft);
    if (invalid) {
      Alert.alert("Could not rename", invalid);
      return;
    }
    setLabelBusy(true);
    try {
      await apiFetch(buildEvidenceLabelPath(String(id)), {
        method: "PATCH",
        body: JSON.stringify(buildEvidenceLabelBody(labelDraft)),
      });
      setRenaming(false);
      await load();
    } catch (err) {
      Alert.alert("Could not rename", toSafeUserError(err, { message: "Failed to update label" }).message);
    } finally {
      setLabelBusy(false);
    }
  }, [id, labelDraft, load]);

  // The route refuses a locked, trashed or destroyed record with a 409; the
  // projection this screen already loads can say so before the tap.
  const labelRefusal = evidenceLabelRefusal(lifecycle);
  const originalRefusal = originalAccessRefusal(lifecycle);
  const linkRefusal = relationshipEditRefusal(lifecycle);

  /**
   * The records this one can be linked TO: the active library, minus this
   * record and the ones already linked. A picker that offered a duplicate
   * would be building a request the server has to refuse.
   */
  const loadLinkCandidates = useCallback(async () => {
    setLinkCandidates(null);
    try {
      const data = await apiFetch(buildLibraryQuery({ scope: "active", sort: "newest", limit: 50 }));
      const taken = new Set(relationships.map((r) => r.linkedId));
      setLinkCandidates(
        parseEvidencePickerRows(data).filter((r) => r.id !== String(id) && !taken.has(r.id)),
      );
    } catch {
      setLinkCandidates([]);
    }
  }, [id, relationships]);

  const createLink = useCallback(async () => {
    if (!linkTarget) return;
    setLinkBusy(true);
    try {
      await apiFetch(buildEvidenceRelationshipsPath(String(id)), {
        method: "POST",
        body: JSON.stringify(
          buildRelationshipBody({
            targetEvidenceId: linkTarget.id,
            relationshipType: linkType,
            note: linkNote,
          }),
        ),
      });
      setLinking(false);
      setLinkTarget(null);
      setLinkNote("");
      await load();
    } catch (err) {
      Alert.alert("Could not link", toSafeUserError(err, { message: "Failed to create relationship" }).message);
    } finally {
      setLinkBusy(false);
    }
  }, [id, linkTarget, linkType, linkNote, load]);

  /** Removing a link asks first, and says what it does NOT remove. */
  // NEW:EVD-RELATIONSHIP-REMOVE — a visible control with the web's confirm
  // (EvidenceRelationshipsSection.tsx:183-206); long-press stays as a shortcut.
  const [unlinking, setUnlinking] = useState<{ id: string; linkedTitle: string; relationshipType: string } | null>(null);
  const removeLink = useCallback((rel: { id: string; linkedTitle: string; relationshipType: string }) => setUnlinking(rel), []);
  const confirmRemoveLink = useCallback(async () => {
    const rel = unlinking;
    if (!rel) return;
    setLinkBusy(true);
    try {
      await apiFetch(buildEvidenceRelationshipPath(String(id), rel.id), { method: "DELETE" });
      setUnlinking(null);
      await load();
    } catch (err) {
      Alert.alert("Could not remove relationship", toSafeUserError(err, { message: "Failed to remove relationship" }).message);
    } finally {
      setLinkBusy(false);
    }
  }, [unlinking, id, load]);

  // NEW:EVD-DETAIL-RESTORE-TRASH — Trash on the record itself, offered only by
  // the lifecycle projection (canTrash / canRestoreFromTrash), as the web does.
  const [trashing, setTrashing] = useState(false);
  const moveToTrash = useCallback(async () => {
    setActionBusy(true);
    try {
      await apiFetch(buildEvidencePath(String(id)), { method: "DELETE" });
      setTrashing(false);
      await load();
    } catch (err) {
      Alert.alert("Could not move to trash", toSafeUserError(err, { message: "Delete failed" }).message);
    } finally {
      setActionBusy(false);
    }
  }, [id, load]);
  const restoreFromTrash = useCallback(async () => {
    setActionBusy(true);
    try {
      await apiFetch(buildEvidenceRestorePath(String(id)), { method: "POST", body: JSON.stringify({ restore: true }) });
      await load();
    } catch (err) {
      Alert.alert("Could not restore", toSafeUserError(err, { message: "Restore failed" }).message);
    } finally {
      setActionBusy(false);
    }
  }, [id, load]);

  /**
   * Open the original file. The request is made ONLY from this tap, and only
   * after the person has been told what it records: GET /original appends
   * EVIDENCE_VIEWED to the custody chain as it answers.
   */
  const openOriginal = useCallback(() => {
    Alert.alert("Open the original file", ORIGINAL_ACCESS_CONSEQUENCE, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Open original",
        onPress: () => {
          void (async () => {
            setOriginalBusy(true);
            try {
              const link = parseOriginalLink(
                await apiFetch(buildEvidenceOriginalPath(String(id))),
              );
              if (!link) {
                Alert.alert("Original not available", "Original file not available");
                return;
              }
              await Linking.openURL(link);
            } catch (err) {
              Alert.alert("Could not open the original", toSafeUserError(err, { message: "Failed to open original" }).message);
            } finally {
              setOriginalBusy(false);
            }
          })();
        },
      },
    ]);
  }, [id]);

  /**
   * The four lifecycle confirmations (page.tsx:1658-1851). The dialog closes
   * only on success; a refusal leaves it open with the server's reason.
   */
  const runLifecycleAction = useCallback(
    // Each call site builds its own path, so the route it reaches is readable
    // there (lock / archive / unarchive / unlock) rather than hidden behind a
    // builder passed in by reference.
    async (path: string, init: { method: "POST"; body?: Record<string, unknown> }) => {
      setActionBusy(true);
      try {
        await apiFetch(path, { method: init.method, body: JSON.stringify(init.body ?? {}) });
        await load();
        setDialog(null);
        setUnlockReason("");
      } catch (err) {
        Alert.alert("Action failed", toSafeUserError(err, { message: "Action failed" }).message);
      } finally {
        setActionBusy(false);
      }
    },
    [id, load],
  );

  // Derived web sections, each from the ONE review-workspace reply.
  const record = useMemo(() => projectRecord(rw), [rw]);
  const preview = useMemo(() => projectPreview(rw), [rw]);
  const template = useMemo(() => projectCaptureTemplate(rw), [rw]);
  const matrix = useMemo(() => buildPreservationMatrix(rw, (iso) => formatUserDateTime(iso) ?? iso), [rw]);
  const sourceFacts = useMemo(() => buildSourceContextFacts(rw, (iso) => formatUserDateTime(iso) ?? iso), [rw]);
  const snapshotTiming = useMemo(() => buildSnapshotTiming(rw, (iso) => formatUserDateTime(iso) ?? iso), [rw]);
  const timelines = useMemo(() => projectCustodyTimelines(rw), [rw]);
  const appendix = useMemo(() => buildTechnicalAppendix(technicalRaw.payload, rw), [technicalRaw.payload, rw]);
  const hashes = useMemo(() => buildHashRows(rw), [rw]);
  const eventCounts = useMemo(() => buildEventCountRows(rw), [rw]);
  const divergenceReasons = useMemo(() => buildDivergenceReasons(rw), [rw]);
  const chainLabel = useMemo(() => {
    const chain = (rw as { preservationMatrix?: { custodyChain?: Record<string, unknown> } } | null)?.preservationMatrix?.custodyChain;
    return chain ? custodyChainLabel(chain) : null;
  }, [rw]);

  if (state === "loading") {
    return (
      <ProovraScreen shell scroll={false}>
        <ProovraLoadingState label="Loading evidence review workspace…" />
      </ProovraScreen>
    );
  }
  if (state === "notfound") {
    return (
      <ProovraScreen shell scroll={false}>
        <ProovraEmptyState title="Record not found" message="This evidence record is no longer available." action={<ProovraButton label="Back" fullWidth={false} onPress={() => router.back()} />} />
      </ProovraScreen>
    );
  }
  if (state === "error" && error) {
    return (
      <ProovraScreen shell scroll={false}>
        <ProovraText variant="h3" weight="semibold">Unable to load the record</ProovraText>
        <ProovraErrorState message={error.message} onRetry={load} />
      </ProovraScreen>
    );
  }

  const c = core!;
  const integrityFailed = isIntegrityFailed(c.status);
  const trashed = lifecycle?.productState === "TRASHED";
  const locked = c.lockedAt !== null || evidenceIsLocked(lifecycle);
  const exportGovernanceReason =
    exportCheck.phase === "ready" && exportCheck.value.outcome !== "ALLOWED"
      ? EXPORT_OUTCOME_LABEL[exportCheck.value.outcome]
      : exportCheck.phase === "failed" && reportAvailable
        ? EXPORT_CHECK_FAILED
        : null;
  const reportBlocked = downloadBlockedReason({
    integrityFailed,
    governanceBlockedReason: exportGovernanceReason,
    available: reportAvailable,
    state: outputs.report.state ?? (reportState as never),
    noun: "report",
  });
  const packageAvailable = outputs.packageAvailable;
  const packageBlocked = downloadBlockedReason({
    integrityFailed,
    governanceBlockedReason: null,
    available: packageAvailable,
    state: outputs.package.state,
    noun: "verification package",
    blockedReason: outputs.packageBlocked ? (outputs.packageBlockedReason ?? "Verification package export is blocked by an export-governance gate.") : null,
  });
  // The server's verb (`outputs.report.action`); an older reply that sent no
  // projection falls back to the state the record reports.
  const generationAction =
    outputs.report.state !== null ? outputs.report.action : reportState === "READY" ? "REGENERATE" : "GENERATE";
  const generationButton =
    generationAction === "NONE" ? null : (
      <View style={{ gap: 6 }}>
      {/* A confirmed generation incident, beside the control it affects. */}
      <RuntimeStatusBanner requires={["artifactGeneration"]} />
      <ProovraButton
        label={generationActionLabel(generationAction)}
        variant="secondary"
        loading={generating}
        disabled={trashed}
        onPress={() => {
          if (generationNeedsConfirmation(generationAction)) setConfirmingRegenerate(true);
          else void requestGeneration();
        }}
      />
      </View>
    );

  const TABS: Array<{ key: Tab; label: string }> = [
    { key: "overview", label: "Overview" },
    { key: "integrity", label: "Integrity" },
    { key: "custody", label: "Custody" },
    { key: "technical", label: "Technical" },
    // Always present. It used to appear only when a link already existed,
    // which left no way to create the first one from a phone.
    { key: "links", label: "Links" },
    ...(materials.length > 0
      ? ([{ key: "materials", label: "Files" }] as Array<{ key: Tab; label: string }>)
      : []),
    // Always present, as on the web: it opens with the Evidence Copilot for
    // everyone; the reviewer-operations panels inside it keep their entitlement.
    { key: "review", label: "Review" },
    { key: "discussion", label: "Discussion" },
    { key: "artifacts", label: "Artifacts" },
    { key: "duplicates", label: "Duplicates" },
    ...(reviewerOperations
      ? ([{ key: "internal", label: "Internal" }] as Array<{ key: Tab; label: string }>)
      : []),
    // UC-4 — Derived Review is a RECORD property (screen-capture originals
    // only), never a workspace-kind gate, exactly as the web states it.
    ...(isDerivedReviewEligible(provenance?.category ?? null)
      ? ([{ key: "derived", label: "Derived" }] as Array<{ key: Tab; label: string }>)
      : []),
  ];

  const statusText = c.statusLabel?.trim() || evidenceStatusDisplay(c.status).label;

  return (
    <ProovraScreen shell>
      {/* The web breadcrumb (page.tsx:1096): back to the Library. */}
      <View style={styles.headerRow}>
        <ProovraButton label="Back" variant="ghost" fullWidth={false} onPress={() => router.back()} />
        <ProovraText variant="label" color={theme.color.ink.muted}>Evidence Library / Evidence Record</ProovraText>
      </View>
      {/* No platform status panel above the record (web page.tsx parity): a
          readiness rollup is not a statement about this evidence. Global
          service status is the header chip; an incident affecting an action
          here is said beside that action (Artifacts). */}
      {/* T-15 — "Also here" (evidence/[id]/page.tsx:1011), bound to the review workflow's workspace. */}
      {reviewWorkflow?.teamId ? <PresenceIndicator teamId={reviewWorkflow.teamId} resourceKind="evidence" resourceId={String(id)} /> : null}

      {integrityFailed ? <IntegrityFailedBanner /> : null}

      {trashed ? (
        <ProovraCard testID="evidence-trash-banner">
          <ProovraText variant="bodySm" weight="semibold">{TRASH_COPY.bannerTitle}</ProovraText>
          <ProovraText variant="label" color={theme.color.ink.secondary}>{TRASH_COPY.bannerBody}</ProovraText>
          {lifecycle?.canRestoreFromTrash ? (
            <ProovraButton label={TRASH_COPY.restore} variant="secondary" loading={actionBusy} disabled={actionBusy} onPress={() => void restoreFromTrash()} />
          ) : null}
        </ProovraCard>
      ) : null}

      {/* LAYER 1 — the hero: title, identity line, legal boundary, the record's operations, its two downloads. */}
      <ProovraCard style={styles.hero}>
        <View style={styles.badgeRow}>
          {c.verificationStatus ? (
            <ProovraBadge
              tone={verificationStatusDisplay(c.verificationStatus).tone}
              label={c.verificationStatusLabel?.trim() || verificationStatusDisplay(c.verificationStatus).label}
            />
          ) : null}
        </View>
        <ProovraText variant="h1" weight="bold" style={styles.heroTitle}>
          {c.displayTitle?.trim() || record.title?.trim() || c.originalFileName?.trim() || humanizeEnum(c.type)}
        </ProovraText>
        <HeroIdentityLine
          record={{ ...record, typeLabel: record.typeLabel ?? humanizeEnum(c.type), id: record.id ?? String(id) }}
          statusLabel={statusText}
          statusTone={evidenceStatusDisplay(c.status).tone}
        />
        {c.createdAt ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>{`Created ${formatUserDateTime(c.createdAt)}`}</ProovraText>
        ) : null}
        {record.legalBoundary ? (
          <ProovraText variant="label" color={theme.color.ink.muted} style={styles.note} testID="evidence-legal-boundary">{record.legalBoundary}</ProovraText>
        ) : null}

        {/* The record's operations (EvidenceHeroIconActions, _lib.tsx:1262). */}
        <View style={styles.heroActions}>
          <ProovraButton
            label={copyVerifyState === "copied" ? "Copied" : "Verification link"}
            accessibilityLabel="Copy verification link"
            variant="secondary"
            fullWidth={false}
            disabled={integrityFailed || !shareUrl}
            onPress={() => void copyVerification()}
          />
          {shareUrl && !integrityFailed ? (
            <ProovraButton label="Share verification link" variant="ghost" fullWidth={false} onPress={() => void shareVerification()} />
          ) : null}
          {locked ? (
            <ProovraButton label="Unlock" variant="secondary" fullWidth={false} disabled={trashed || actionBusy} onPress={() => { setUnlockReason(""); setDialog("unlock"); }} />
          ) : (
            <ProovraButton label="Lock" variant="secondary" fullWidth={false} disabled={trashed || integrityFailed || actionBusy} onPress={() => setDialog("lock")} />
          )}
          {lifecycle?.canUnarchive ? (
            <ProovraButton label="Restore" accessibilityLabel="Restore archived evidence" variant="secondary" fullWidth={false} disabled={actionBusy} onPress={() => setDialog("restore")} />
          ) : lifecycle === null || lifecycle.canArchive ? (
            <ProovraButton label="Archive" variant="secondary" fullWidth={false} disabled={trashed || actionBusy} onPress={() => setDialog("archive")} />
          ) : null}
          {lifecycle?.canTrash ? (
            <ProovraButton label={TRASH_COPY.moveAction} variant="danger" fullWidth={false} disabled={actionBusy} onPress={() => setTrashing(true)} />
          ) : null}
          <ProovraButton
            label="Edit name"
            variant="ghost"
            fullWidth={false}
            onPress={() => {
              setLabelDraft(c.displayTitle?.trim() || c.originalFileName?.trim() || "");
              setRenaming(true);
            }}
          />
        </View>
        {/*
          The server's reason, rendered from its CODE. Saying "this cannot be
          done" without why leaves the user to guess.
        */}
        {lifecycle && !lifecycle.canArchive && !lifecycle.canUnarchive && lifecycle.archiveBlockReason ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>{lifecycleBlockReasonLabel(lifecycle.archiveBlockReason)}</ProovraText>
        ) : null}
        {lifecycle && !lifecycle.canTrash && lifecycle.trashBlockReason && !trashed ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>{lifecycleBlockReasonLabel(lifecycle.trashBlockReason)}</ProovraText>
        ) : null}
        {lifecycle?.legalHold ? (
          <ProovraText variant="label" color={theme.color.status.risk.fg}>A legal hold is in force on this record.</ProovraText>
        ) : null}

        {/* The two downloads (page.tsx:1240-1293), each refused with its reason rather than faded. */}
        {exportCheck.phase === "ready" && exportCheck.value.outcome !== "ALLOWED" ? (
          <View style={styles.verdict}>
            <ProovraBadge tone="risk" label={EXPORT_OUTCOME_LABEL[exportCheck.value.outcome]} />
            <ProovraText variant="label" color={theme.color.ink.secondary}>{EXPORT_NEXT_STEP[exportCheck.value.outcome]}</ProovraText>
          </View>
        ) : exportCheck.phase === "loading" ? (
          <ProovraText variant="label" color={theme.color.ink.muted}>Checking eligibility for Download report…</ProovraText>
        ) : null}
        {reportAvailable || packageAvailable ? <RuntimeStatusBanner requires={["downloads"]} /> : null}
        <View style={styles.heroActions}>
<ProovraButton
  label="Download Report PDF"
  accessibilityLabel="Download report"
              fullWidth={false}
            loading={downloading}
            disabled={reportBlocked !== null || !(exportCheck.phase === "ready" && exportCheck.value.outcome === "ALLOWED")}
            onPress={() => void downloadReport()}
          />
          <ProovraButton
            label="Download Verification Package ZIP"
            variant="secondary"
            fullWidth={false}
            loading={packageBusy}
            disabled={packageBlocked !== null}
            onPress={() => void downloadPackage()}
          />
        </View>
        {reportBlocked || packageBlocked ? (
          <ProovraText variant="label" color={theme.color.ink.secondary} testID="evidence-download-blocked-reason">
            {reportBlocked ?? packageBlocked}
          </ProovraText>
        ) : null}
        {packageMessage ? <ProovraText variant="label" color={theme.color.ink.secondary}>{packageMessage}</ProovraText> : null}
      </ProovraCard>

      {/*
        RENAMING THE RECORD. The route refuses a locked or deleted record
        with a 409, and the lifecycle projection this screen already loads
        can say so BEFORE the tap.
      */}
      <ProovraSheet visible={renaming} title="Edit name" onClose={() => setRenaming(false)}>
        {labelRefusal ? (
          <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
            {labelRefusal}
          </ProovraText>
        ) : (
          <>
            <ProovraFormField label="Evidence label">
              <ProovraInput
                value={labelDraft}
                onChangeText={setLabelDraft}
                placeholder={`Up to ${EVIDENCE_LABEL_MAX} characters`}
                autoCapitalize="sentences"
                accessibilityLabel="Evidence label"
              />
            </ProovraFormField>
            <ProovraText variant="label" color={theme.color.ink.muted}>
              The original file name is part of the record and never changes.
            </ProovraText>
            <ProovraButton
              label="Save label"
              loading={labelBusy}
              disabled={validateEvidenceLabel(labelDraft) !== null}
              onPress={() => void renameRecord()}
            />
          </>
        )}
      </ProovraSheet>

      {/* The lifecycle confirmations, in the web's words. */}
      <ProovraConfirmSheet
        visible={dialog === "lock"}
        title={LIFECYCLE_DIALOG_COPY.lock.title}
        consequence={LIFECYCLE_DIALOG_COPY.lock.body}
        confirmLabel={LIFECYCLE_DIALOG_COPY.lock.confirm}
        tone="warning"
        busy={actionBusy}
        onConfirm={() => void runLifecycleAction(buildEvidenceLockPath(String(id)), { method: "POST" })}
        onCancel={() => setDialog(null)}
      />
      <ProovraConfirmSheet
        visible={dialog === "archive"}
        title={LIFECYCLE_DIALOG_COPY.archive.title}
        consequence={LIFECYCLE_DIALOG_COPY.archive.body}
        confirmLabel={LIFECYCLE_DIALOG_COPY.archive.confirm}
        busy={actionBusy}
        onConfirm={() => void runLifecycleAction(buildEvidenceArchivePath(String(id)), { method: "POST" })}
        onCancel={() => setDialog(null)}
      />
      <ProovraConfirmSheet
        visible={dialog === "restore"}
        title={LIFECYCLE_DIALOG_COPY.restore.title}
        consequence={LIFECYCLE_DIALOG_COPY.restore.body}
        confirmLabel={LIFECYCLE_DIALOG_COPY.restore.confirm}
        busy={actionBusy}
        onConfirm={() => void runLifecycleAction(buildEvidenceUnarchivePath(String(id)), { method: "POST" })}
        onCancel={() => setDialog(null)}
      />
      <ProovraSheet visible={dialog === "unlock"} title={LIFECYCLE_DIALOG_COPY.unlock.title} onClose={() => setDialog(null)}>
        <ProovraText variant="bodySm" color={theme.color.ink.secondary}>{LIFECYCLE_DIALOG_COPY.unlock.body}</ProovraText>
        <ProovraText variant="label" color={theme.color.ink.muted}>{LIFECYCLE_DIALOG_COPY.unlock.note}</ProovraText>
        <ProovraFormField label={LIFECYCLE_DIALOG_COPY.unlock.reasonLabel}>
          <ProovraInput
            value={unlockReason}
            onChangeText={(v: string) => setUnlockReason(v.slice(0, UNLOCK_REASON_MAX))}
            placeholder={LIFECYCLE_DIALOG_COPY.unlock.reasonPlaceholder}
            accessibilityLabel={LIFECYCLE_DIALOG_COPY.unlock.reasonLabel}
          />
        </ProovraFormField>
        <View style={styles.heroActions}>
          <ProovraButton label="Cancel" variant="ghost" fullWidth={false} disabled={actionBusy} onPress={() => setDialog(null)} />
          <ProovraButton
            label={LIFECYCLE_DIALOG_COPY.unlock.confirm}
            fullWidth={false}
            loading={actionBusy}
            onPress={() => void runLifecycleAction(buildEvidenceUnlockPath(String(id)), { method: "POST", body: buildUnlockBody(unlockReason) })}
          />
        </View>
      </ProovraSheet>

      {/* Choosing what to link to, and how the two records relate. */}
      <ProovraSheet
        visible={linking}
        title="Record evidence relationship"
        onClose={() => setLinking(false)}
      >
        <ProovraListRow
          title="Relationship type"
          subtitle={relationshipTypeLabel(linkType)}
          onPress={() => setLinkTypePicker(true)}
        />
        <ProovraFormField label="Note (optional)">
          <ProovraInput
            value={linkNote}
            onChangeText={setLinkNote}
            placeholder="Why these two records go together"
            autoCapitalize="sentences"
            multiline
            accessibilityLabel="Link note"
          />
        </ProovraFormField>
        {linkCandidates === null ? (
          <ProovraLoadingState label="Loading records" />
        ) : linkCandidates.length === 0 ? (
          <ProovraEmptyState
            title="Nothing to link"
            message="Every other record you can see is already linked to this one."
          />
        ) : (
          <ProovraCard>
            {linkCandidates.map((cand) => (
              <ProovraListRow
                key={cand.id}
                title={cand.title}
                subtitle={cand.subtitle ?? undefined}
                trailing={
                  linkTarget?.id === cand.id ? (
                    <ProovraBadge tone="verified" label="Selected" />
                  ) : undefined
                }
                onPress={() => setLinkTarget({ id: cand.id, title: cand.title })}
              />
            ))}
          </ProovraCard>
        )}
        <ProovraButton
          label={linkTarget ? `Save relationship with ${linkTarget.title}` : "Choose a record first"}
          loading={linkBusy}
          disabled={!linkTarget}
          onPress={() => void createLink()}
        />
      </ProovraSheet>

      <ProovraSheet
        visible={linkTypePicker}
        title="Relationship type"
        onClose={() => setLinkTypePicker(false)}
      >
        {EVIDENCE_RELATIONSHIP_TYPES.map((t) => (
          <ProovraListRow
            key={t}
            title={relationshipTypeLabel(t)}
            subtitle={t === linkType ? "Current" : undefined}
            onPress={() => {
              setLinkType(t);
              setLinkTypePicker(false);
            }}
          />
        ))}
      </ProovraSheet>

      {/* The web's "What needs attention" strip (page.tsx:1972), same rules, above every tab. */}
      {caseAssignment
        ? (() => {
            const attention = deriveEvidenceAttention({
              hasCase: Boolean(caseAssignment.caseId || caseAssignment.caseName),
              canSeeReviewerOps: reviewerOperations,
              reviewStatus: reviewWorkflow?.status ?? null,
              reportState,
              packageState,
              signals: riskSignals,
            });
            if (!attention || tab !== "overview") return null;
            return (
              <ProovraCard testID="evidence-attention">
                <ProovraText variant="label" weight="semibold">What needs attention</ProovraText>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s1 }}>
                  {attention.risks.map((r) => (
                    <ProovraBadge key={`${r.title}-${r.detail}`} label={r.title} tone={r.severity === "danger" ? "risk" : r.severity === "warning" ? "pending" : "neutral"} />
                  ))}
                </View>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 }}>
                  {attention.needsCase ? <ProovraButton label="No case assigned · Assign" variant="secondary" fullWidth={false} onPress={openCaseAssign} /> : null}
                  {attention.needsReviewer ? (
                    <ProovraButton
                      label="Review not started · Start"
                      variant="secondary"
                      fullWidth={false}
                      onPress={() => {
                        setTab("review");
                        setWorkflowOpenRequest((n) => n + 1);
                      }}
                    />
                  ) : null}
                  {attention.missingReport ? <ProovraButton label="Report not available · Artifacts" variant="secondary" fullWidth={false} onPress={() => setTab("artifacts")} /> : null}
                  {attention.missingPackage ? <ProovraButton label="Verification package not available · Artifacts" variant="secondary" fullWidth={false} onPress={() => setTab("artifacts")} /> : null}
                  {attention.risks.length === 0 && !attention.needsCase && !attention.needsReviewer ? (
                    <ProovraButton label="Open review workspace" variant="ghost" fullWidth={false} onPress={() => setTab("review")} />
                  ) : null}
                </View>
              </ProovraCard>
            );
          })()
        : null}

      <View style={styles.tabs} accessibilityLabel="Evidence detail sections">
        {TABS.map((tb) => {
          const active = tb.key === tab;
          return (
            <Pressable
              key={tb.key}
              onPress={() => {
                setTab(tb.key);
                if (tb.key === "duplicates" && duplicates === null) void loadDuplicates();
              }}
              accessibilityRole="tab"
              accessibilityLabel={tb.label}
              accessibilityState={{ selected: active }}
              style={[styles.tab, { borderColor: active ? theme.color.accent.a500 : theme.color.border.default, backgroundColor: active ? theme.color.accent.a050 : "transparent" }]}
            >
              <ProovraText variant="label" weight="semibold" color={active ? theme.color.accent.a600 : theme.color.ink.secondary}>
                {tb.label}
              </ProovraText>
            </Pressable>
          );
        })}
      </View>

      {tab === "overview" ? (
        <>
          {/*
            T-12 — requests linked to this record, and "New request" from it
            (EvidenceOverviewTab.tsx:121): intakeIncluded plans, in the record's
            review workspace.
          */}
          {requestTeamId && intakeIncluded ? (
            <EvidenceLinkedRequests evidenceId={String(id)} teamId={requestTeamId} workspaceName={platform.context?.displayName ?? null} />
          ) : null}
          {template ? <CaptureTemplateCard template={template} /> : null}
          {record.internalNotes ? <CaptureNoteCard note={record.internalNotes} /> : null}
          <EvidencePreview
            key={String(id)}
            items={preview.items}
            defaultId={preview.defaultId}
            onOpenOriginal={openOriginal}
            originalBusy={originalBusy}
            originalRefusal={originalRefusal}
          />
          {rw ? <RecordSummaryCard items={recordSummaryItems(record, (iso) => formatUserDateTime(iso) ?? iso)} /> : null}
          {caseAssignment ? (
            <View style={styles.inline}>
              {!caseAssignment.caseName && !caseAssignment.caseId ? (
                <ProovraText variant="label" color={theme.color.ink.muted}>Unassigned</ProovraText>
              ) : null}
              <ProovraButton
                label={caseAssignment.caseId ? "Reassign case" : "Assign case"}
                variant="secondary"
                fullWidth={false}
                disabled={caseBusy || trashed}
                onPress={openCaseAssign}
              />
              {caseAssignment.caseId ? (
                <ProovraButton label="Remove from case" variant="ghost" fullWidth={false} disabled={caseBusy} onPress={() => setRemovingCase(true)} />
              ) : null}
            </View>
          ) : null}
          {caseMessage ? <ProovraText variant="label" color={theme.color.ink.secondary}>{caseMessage}</ProovraText> : null}
          {record.nextActions.length > 0 ? <NextActionsCard actions={record.nextActions} /> : null}
          {provenance?.statement ? (
            <ProovraText variant="label" color={theme.color.ink.muted} style={styles.note}>{provenance.statement}</ProovraText>
          ) : null}
        </>
      ) : null}

      <ProovraSheet visible={assigningCase} title={CASE_ASSIGN_COPY.title} onClose={() => setAssigningCase(false)}>
        {eligibleCases === null ? (
          <ProovraLoadingState label="Loading cases" />
        ) : eligibleCases.length === 0 ? (
          <ProovraText variant="bodySm">{CASE_ASSIGN_COPY.empty}</ProovraText>
        ) : (
          eligibleCases.map((k) => (
            <ProovraListRow
              key={k.id}
              title={k.name}
              subtitle={k.id === caseAssignment?.caseId ? "Current" : undefined}
              onPress={async () => {
                setAssigningCase(false);
                setCaseBusy(true);
                setCaseMessage(null);
                try {
                  await apiFetch(buildCaseEvidencePath(k.id), { method: "POST", body: JSON.stringify({ evidenceId: String(id) }) });
                  setCaseMessage(CASE_ASSIGN_COPY.added);
                  setCaseAssignment({ ...(caseAssignment ?? {}), caseId: k.id, caseName: k.name });
                } catch (err) {
                  setCaseMessage(`${CASE_ASSIGN_COPY.addFailed}: ${toSafeUserError(err).message}`);
                } finally {
                  setCaseBusy(false);
                }
              }}
            />
          ))
        )}
      </ProovraSheet>
      <ProovraConfirmSheet
        visible={removingCase}
        title="Remove from case?"
        consequence={caseAssignment?.caseName ? `This record will no longer belong to ${caseAssignment.caseName}. The record itself is not changed.` : undefined}
        confirmLabel="Remove from case"
        tone="warning"
        busy={caseBusy}
        onConfirm={async () => {
          if (!caseAssignment?.caseId) return;
          setRemovingCase(false);
          setCaseBusy(true);
          try {
            await apiFetch(buildCaseEvidenceItemPath(caseAssignment.caseId, String(id)), { method: "DELETE" });
            setCaseMessage(CASE_ASSIGN_COPY.removed);
            setCaseAssignment({ ...caseAssignment, caseId: null, caseName: null });
          } catch (err) {
            setCaseMessage(`${CASE_ASSIGN_COPY.removeFailed}: ${toSafeUserError(err).message}`);
          } finally {
            setCaseBusy(false);
          }
        }}
        onCancel={() => setRemovingCase(false)}
      />

      {tab === "integrity" ? (
        <>
        {/* T-15 — how this record reached PROOVRA (server provenance projection). */}
        <ProvenanceChainSection evidenceId={String(id)} workspaceId={platform.context?.activeTeamId ?? null} />
        {rw ? (
          <IntegritySection
            testID="evidence-source-context"
            title="Source & Capture Context"
            description="What PROOVRA recorded about where this material came from and how it reached the platform. Signals that were never collected are not listed."
          >
            {sourceFacts.length > 0 ? <FactsGrid items={sourceFacts} /> : null}
            {sourceBoundary ? (
              <ProovraText variant="label" color={theme.color.ink.muted} testID="source-boundary">{`Boundary: ${sourceBoundary}`}</ProovraText>
            ) : null}
          </IntegritySection>
        ) : null}
        {captureLocation ? (
          <ProovraSection title={CAPTURE_LOCATION_COPY.title}>
            <ProovraText variant="label" color={theme.color.ink.secondary}>
              {CAPTURE_LOCATION_COPY.description}
            </ProovraText>
            <CaptureLocationMap lat={captureLocation.lat} lng={captureLocation.lng} accuracyMeters={captureLocation.accuracyMeters} />
            {/* The web Location facts (LocationContextCard.tsx:76), and its boundary always. */}
            <ProovraText variant="label" color={theme.color.ink.secondary} selectable testID="capture-location-facts">
              {[
                `Latitude ${captureLocation.lat.toFixed(6)}`,
                `Longitude ${captureLocation.lng.toFixed(6)}`,
                captureLocation.accuracyMeters != null ? `± ${Math.round(captureLocation.accuracyMeters)} m` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </ProovraText>
            {/* LocationContextCard.tsx:47-50, :90 — "lat, lng" to six places. */}
            <CopyButton value={`${captureLocation.lat.toFixed(6)}, ${captureLocation.lng.toFixed(6)}`} label="Copy coordinates" />
            {captureLocation.externalMapUrl ? (
              <ProovraButton
                label="Open map"
                variant="ghost"
                fullWidth={false}
                onPress={() => void Linking.openURL(captureLocation.externalMapUrl as string)}
              />
            ) : null}
            <ProovraText variant="label" color={theme.color.ink.muted}>
              {`Boundary: ${captureLocation.legalBoundary ?? DEFAULT_LOCATION_BOUNDARY}`}
            </ProovraText>
          </ProovraSection>
        ) : (
          <ProovraSection title="Location">
            <ProovraText variant="label" color={theme.color.ink.muted} testID="location-not-provided">{LOCATION_NOT_PROVIDED}</ProovraText>
          </ProovraSection>
        )}
        {matrix.length > 0 ? (
          <IntegritySection
            testID="evidence-verification-preservation"
            title="Verification & Preservation"
            description="Recorded integrity and preservation materials, each with the state PROOVRA can actually attest to. A state describes the material, not the truthfulness of what the material shows."
            action={
              !isOtsTerminal(projectOtsEffectiveStatus(rw)) ? (
                <ProovraButton label="Check latest status" variant="secondary" fullWidth={false} onPress={() => void load()} />
              ) : null
            }
          >
            <PreservationMatrix rows={matrix} />
          </IntegritySection>
        ) : null}
        <ProovraSection title={INTEGRITY_SECTION_TITLE}>
          <ProovraCard>
            <Row k="SHA-256" v={c.fileSha256 ?? "—"} mono />
            <Row k="Ed25519 fingerprint" v={c.fingerprintHash ?? "—"} mono />
            {preservation ? (
              <>
                {preservation.signature.recorded ? <Row k="Signature" v={preservation.signature.valid === false ? "Recorded (invalid)" : "Recorded"} /> : null}
                <Row k="Trusted timestamp (TSA)" v={preservation.tsa.status ? `${humanizeEnum(preservation.tsa.status)}${preservation.tsa.provider ? ` · ${preservation.tsa.provider}` : ""}` : "Not timestamped"} />
                {preservation.ots.bitcoinTxid ? <Row k="Bitcoin tx" v={preservation.ots.bitcoinTxid} mono /> : null}
              </>
            ) : null}
          </ProovraCard>
          <ProovraText variant="h3" weight="semibold" style={styles.note}>Declarations</ProovraText>
          <ProovraText variant="label" color={theme.color.ink.muted}>
            Custodian and qualified-person declarations attached to this record. A declaration is a signed human statement recorded in custody history; it does not change the recorded integrity state.
          </ProovraText>
          <EvidenceDeclarationsPanel evidenceId={id} />
          <ProovraText variant="label" color={theme.color.ink.muted} style={styles.note}>
            {INTEGRITY_ADVISORY}
          </ProovraText>
        </ProovraSection>
        {snapshotTiming ? <SnapshotTimingSection timing={snapshotTiming} /> : null}
        </>
      ) : null}

      {tab === "custody" ? (
        <>
          <CustodyTimelineCard kind="forensic" events={timelines.forensic} />
          <CustodyTimelineCard kind="access" events={timelines.access} />
        </>
      ) : null}
      {/* T-14 — the web OperationalTimelinePanel (Custody tab, reviewer operations). */}
      {tab === "custody" && reviewerOperations && reviewWorkflow?.teamId ? (
        <OperationalTimeline evidenceId={String(id)} teamId={reviewWorkflow.teamId} />
      ) : null}

      {tab === "technical" ? (
        <>
          <TechnicalAppendixIntro />
          {/* 1. Trust decision summary + per-signal detail. */}
          <TrustDecisionCard trust={trustDecision} />
          {/* 2. Technical Evidence Context (EvidenceTechnicalAppendix.tsx). */}
          <TechnicalEvidenceContext model={appendix} phase={technicalRaw.phase} onOpenCustody={() => setTab("custody")} />
          {/* Per-part technical metadata (EvidencePartMetadataTable). */}
          {technical ? (
            <ProovraSection title="Technical Metadata">
              {technical.perParts.length === 0 ? (
                <ProovraText variant="label" color={theme.color.ink.muted} testID="per-parts-empty">{PER_PARTS_EMPTY}</ProovraText>
              ) : (
                <ProovraCard>
                  <ProovraBadge tone="neutral" label={`${technical.perParts.length} ${technical.perParts.length === 1 ? "part" : "parts"}`} />
                  {technical.perParts.map((p, i) => (
                    <View key={`${p.partIndex ?? i}`} style={styles.detailRow}>
                      <ProovraText variant="label" weight="semibold">{`Part ${p.partIndex ?? i + 1}`}</ProovraText>
                      {partMetaLine(p) ? <ProovraText variant="label" color={theme.color.ink.secondary}>{partMetaLine(p)}</ProovraText> : null}
                      {p.sha256 ? <ProovraText variant="label" mono numberOfLines={1} color={theme.color.ink.muted} selectable>{p.sha256}</ProovraText> : null}
                    </View>
                  ))}
                  {technical.perParts.length > 1 && technical.exif?.present ? (
                    <ProovraText variant="label" color={theme.color.ink.muted}>{EXIF_REPRESENTATIVE_NOTE}</ProovraText>
                  ) : null}
                </ProovraCard>
              )}
            </ProovraSection>
          ) : null}
          {/* 3-6. The disclosure blocks. */}
          {rw ? (
            <TechnicalAppendixBlocks
              hashRows={hashes.rows}
              multipartContext={hashes.multipartContext}
              eventCounts={eventCounts}
              divergence={divergenceReasons}
              custodyChain={chainLabel}
            />
          ) : null}
        </>
      ) : null}

      {/* T-15 — advisory media-intelligence signals (EvidenceTechnicalAppendixTab.tsx:279);
          nothing actionable without the server-projected workspace. */}
      {tab === "technical" && reviewWorkflow?.teamId ? (
        <MediaIntelligencePanel evidenceId={String(id)} teamId={reviewWorkflow.teamId} />
      ) : null}

      {tab === "links" ? (
        <ProovraSection title="Case & relationships">
          {/* The web Case & relationships facts (EvidenceRelationshipsSection.tsx:105-123). */}
          {caseAssignment ? (
            <ProovraCard testID="evidence-structure">
              <Row k="Case assignment" v={caseAssignment.caseName || "Unassigned"} />
              <Row k="Related evidence" v={caseAssignment.relatedEvidenceCount != null ? `${caseAssignment.relatedEvidenceCount} item${caseAssignment.relatedEvidenceCount === 1 ? "" : "s"}` : "Not available"} />
              <Row k="Structure" v={caseAssignment.multipart ? "Multipart package" : "Single record"} />
              {rw ? <Row k="Item count" v={String(record.itemCount)} /> : null}
              {record.relationshipsNote ? (
                <ProovraText variant="label" color={theme.color.ink.muted}>{record.relationshipsNote}</ProovraText>
              ) : null}
              <View style={styles.inline}>
                <ProovraButton label={caseAssignment.caseName ? "Reassign case" : "Assign case"} accessibilityLabel={caseAssignment.caseName ? "Reassign case (relationships)" : "Assign case (relationships)"} variant="ghost" fullWidth={false} disabled={trashed} onPress={openCaseAssign} />
                {caseAssignment.caseId ? (
                  <ProovraButton label="Remove case" variant="ghost" fullWidth={false} disabled={caseBusy} onPress={() => setRemovingCase(true)} />
                ) : null}
              </View>
            </ProovraCard>
          ) : null}
          <View style={styles.inline}>
            <ProovraText variant="bodySm" weight="semibold">Linked evidence relationships</ProovraText>
            <ProovraText variant="label" color={theme.color.ink.muted}>{`${relationships.length} recorded`}</ProovraText>
          </View>
          {relationships.length === 0 ? (
            <ProovraCard>
              <ProovraText variant="bodySm" color={theme.color.ink.secondary}>No linked evidence relationships recorded.</ProovraText>
              <ProovraText variant="label" color={theme.color.ink.muted}>
                Linking records says how two pieces of evidence relate — the same incident, one supporting another, one replacing another.
              </ProovraText>
            </ProovraCard>
          ) : (
            relationships.map((rel) => (
              <ProovraCard key={rel.id}>
                <View style={styles.inline}>
                  <ProovraText variant="bodySm" weight="semibold" style={{ flex: 1 }}>{rel.linkedTitle}</ProovraText>
                  <ProovraBadge tone="neutral" label={rel.relationshipType.replace(/_/g, " ")} />
                </View>
                <ProovraText variant="label" color={theme.color.ink.secondary}>
                  {`${relationshipDirectionLabel(rel.direction)} • ${rel.linkedStatus.replace(/_/g, " ")}`}
                </ProovraText>
                {rel.note ? <ProovraText variant="label" color={theme.color.ink.muted}>{rel.note}</ProovraText> : null}
                <View style={styles.inline}>
                  <ProovraButton
                    label="Open linked evidence"
                    accessibilityLabel={`Open linked evidence: ${rel.linkedTitle}`}
                    variant="secondary"
                    fullWidth={false}
                    onPress={() => router.push(`/evidence/${rel.linkedId}`)}
                  />
                  {linkRefusal ? null : (
                    <ProovraButton
                      label="Remove relationship"
                      accessibilityLabel={`Remove relationship with ${rel.linkedTitle}`}
                      variant="ghost"
                      fullWidth={false}
                      disabled={linkBusy}
                      onPress={() => removeLink(rel)}
                    />
                  )}
                </View>
              </ProovraCard>
            ))
          )}

          {/*
            The WRITE half. Reading links has worked from the start and the
            three write routes were never called, so a reviewer could see
            that two records were linked and could not link two more.
          */}
          {linkRefusal ? (
            <ProovraText variant="label" color={theme.color.ink.muted}>
              {linkRefusal}
            </ProovraText>
          ) : (
            <ProovraButton
              label="Manage relationships"
              variant="secondary"
              disabled={linkBusy}
              onPress={() => {
                setLinking(true);
                void loadLinkCandidates();
              }}
            />
          )}
        </ProovraSection>
      ) : null}

      {tab === "artifacts" ? (
        <>
          {/* THE OUTPUT LIFECYCLE PANEL — total over the canonical state (EvidenceArtifactsTab.tsx:555). */}
          {outputs.report.state !== null ? (
            <ArtifactLifecyclePanel output={outputs.report} actionNode={generationButton} />
          ) : (
            <ProovraCard>
              <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                Report status is unavailable right now. Pull to refresh, or check again shortly.
              </ProovraText>
              {generationButton}
            </ProovraCard>
          )}
          {outputs.report.state === "QUEUED" || outputs.report.state === "GENERATING" ? (
            <RuntimeStatusBanner requires={["artifactGeneration"]} />
          ) : null}
          {generationNote ? (
            // The SERVER's sentence for the outcome it actually returned.
            <ProovraText variant="label" color={theme.color.ink.secondary}>{generationNote}</ProovraText>
          ) : null}
          <LatestVerificationLinkCard shareUrl={shareUrl} publicVerification={publicVerification} />
          {/* T-14 — package download and every retained version (web ArtifactHistorySection). */}
          <ArtifactHistoryPanel evidenceId={String(id)} history={artifactHistory} />
          {publicVerification ? <PublicVerificationSharing publicVerification={publicVerification} shareUrl={shareUrl} /> : null}
        </>
      ) : null}

      {tab === "review" ? <EvidenceCopilot evidenceId={String(id)} analysisRevision={analysisRevision} /> : null}
      {tab === "review" && rw ? (
        <ReviewHero
          status={record.workflow.status}
          canSeeReviewerOps={reviewerOperations}
          reportAvailable={reportAvailable}
          reportPending={outputs.report.state === "QUEUED" || outputs.report.state === "GENERATING"}
          onAttachToCase={trashed ? null : openCaseAssign}
          onAssignReviewer={() => setWorkflowOpenRequest((n) => n + 1)}
          onOpenReport={() => setTab("artifacts")}
        />
      ) : null}
      {tab === "review" && reviewerOperations ? (
        <>
          <ReviewerWorkflowPanel evidenceId={String(id)} openRequest={workflowOpenRequest} />
          {/* T-15 — claim + internal decisions (EvidenceReviewActionsPanel), reviewer-operations plans. */}
          {reviewWorkflow ? <ReviewActionsPanel evidenceId={String(id)} workflow={reviewWorkflow} onChanged={() => void load()} /> : null}
        </>
      ) : null}
      {tab === "review" && rw ? <PrivateNotesHead record={record} canSeeReviewerOps={reviewerOperations} /> : null}
      {/* T-14 — Comparison mode (web ComparisonPanel, Review tab, every plan). */}
      {tab === "review" ? <EvidenceComparisonPanel evidenceId={String(id)} /> : null}
      {/* T-14 — AI categorization (web AiCategorizationPanel, Review-tab tools, every plan). */}
      {tab === "review" ? <AiCategorizationPanel evidenceId={String(id)} /> : null}
      {tab === "review" ? (
        <ProovraSection title={REVIEWER_AUDIT_COPY.title}>
          <View testID="reviewer-audit" style={{ gap: theme.space.s2 }}>
            {reviewerAudit.length > 0 ? (
              <ProovraText variant="label" weight="semibold" color={theme.color.ink.secondary}>{`${reviewerAudit.length} recorded`}</ProovraText>
            ) : null}
            <ProovraText variant="label" color={theme.color.ink.muted}>{REVIEWER_AUDIT_COPY.boundary}</ProovraText>
            {reviewerAudit.length === 0 ? (
              <ProovraText variant="label" color={theme.color.ink.muted}>{REVIEWER_AUDIT_COPY.empty}</ProovraText>
            ) : (
              <ProovraCard>
                {reviewerAudit.map((a) => (
                  <ProovraListRow
                    key={a.id}
                    title={a.eventLabel}
                    subtitle={[a.actorLabel + (a.metadataRecorded ? " • metadata recorded" : ""), a.createdAtIso ? formatUserDateTime(a.createdAtIso) : null].filter(Boolean).join(" · ")}
                  />
                ))}
              </ProovraCard>
            )}
          </View>
        </ProovraSection>
      ) : null}
      {tab === "review" && rw ? (
        <LifecycleManagementCard
          lifecycle={lifecycle}
          facts={lifecycleFacts(lifecycle, record, (iso) => formatUserDateTime(iso) ?? iso)}
          busy={actionBusy}
          onRestoreArchive={() => void runLifecycleAction(buildEvidenceUnarchivePath(String(id)), { method: "POST" })}
          onArchive={() => setDialog("archive")}
          onRestoreTrash={() => void restoreFromTrash()}
          onTrash={() => setTrashing(true)}
        />
      ) : null}
      {/* T-12 — which collaboration group is coordinating this record (EvidenceReviewTab.tsx:580). */}
      {tab === "review" && reviewerOperations ? <TeamResponsibilityPanel targetType="EVIDENCE" targetId={String(id)} /> : null}

      {tab === "internal" && reviewerOperations ? (
        <EvidenceInternalMaterials evidenceId={String(id)} />
      ) : null}

      {tab === "duplicates" ? (
        <ProovraSection title="Duplicate detection">
          {/*
            Shown whether or not anything matched: "no duplicates found"
            without this sentence reads as "there are none", which is a
            stronger claim than the check can support.
          */}
          <ProovraText variant="label" color={theme.color.ink.muted}>
            {duplicates?.limitation ?? DUPLICATE_LIMITATION}
          </ProovraText>

          {duplicatesPhase === "loading" ? (
            <ProovraLoadingState label={DUPLICATE_COPY.loading} />
          ) : null}

          {duplicatesPhase === "failed" ? (
            <ProovraErrorState
              message="Duplicate detection unavailable"
              onRetry={() => void loadDuplicates()}
            />
          ) : null}

          {duplicates && duplicates.totalRecords === 0 && duplicatesPhase === "idle" ? (
            <ProovraCard>
              <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                {DUPLICATE_COPY.empty}
              </ProovraText>
            </ProovraCard>
          ) : null}

          {duplicates && duplicates.matches.length > 0 ? (
            <>
              <ProovraText variant="label" color={theme.color.ink.secondary}>{DUPLICATE_COPY.summary(duplicates.totalRecords)}</ProovraText>
              {/*
                Each record appears ONCE, from the grouped view. The legacy
                per-category arrays repeated a record across categories and
                once per matching part.
              */}
              {duplicates.matches.map((m) => (
                <ProovraCard key={m.evidenceId}>
                  <View style={styles.inline}>
                    <ProovraText variant="bodySm" weight="semibold" style={{ flex: 1 }}>{m.title}</ProovraText>
                    <ProovraText variant="label" mono color={theme.color.ink.muted}>{m.evidenceId.slice(0, 8)}</ProovraText>
                  </View>
                  {m.createdAtIso ? <ProovraText variant="label" color={theme.color.ink.muted}>{formatUserDateTime(m.createdAtIso)}</ProovraText> : null}
                  <ProovraText variant="label" color={theme.color.ink.secondary}>{duplicateMatchSummary(m)}</ProovraText>
                  <ProovraButton
                    label={DUPLICATE_COPY.open}
                    accessibilityLabel={`Open record: ${m.title}`}
                    variant="ghost"
                    fullWidth={false}
                    onPress={() => router.push(`/(stack)/evidence/${m.evidenceId}` as never)}
                  />
                </ProovraCard>
              ))}
            </>
          ) : null}
        </ProovraSection>
      ) : null}

      <ProovraConfirmSheet
        visible={trashing}
        title={TRASH_COPY.moveTitle}
        consequence={`${TRASH_COPY.moveBody}\n\n${TRASH_COPY.moveBody2}`}
        confirmLabel={TRASH_COPY.moveAction}
        tone="danger"
        busy={actionBusy}
        onConfirm={() => void moveToTrash()}
        onCancel={() => setTrashing(false)}
      />
      <ProovraConfirmSheet
        visible={unlinking !== null}
        title={unlinking ? relationshipRemoveCopy(unlinking.relationshipType, unlinking.linkedTitle).title : ""}
        consequence={unlinking ? relationshipRemoveCopy(unlinking.relationshipType, unlinking.linkedTitle).body : undefined}
        confirmLabel="Remove relationship"
        tone="danger"
        busy={linkBusy}
        onConfirm={() => void confirmRemoveLink()}
        onCancel={() => setUnlinking(null)}
      />
      <ProovraConfirmSheet
        visible={confirmingRegenerate}
        title="Confirm regeneration"
        consequence={REGENERATE_CONSEQUENCE}
        confirmLabel="Create a new version"
        tone="warning"
        busy={generating}
        onConfirm={() => void requestGeneration()}
        onCancel={() => setConfirmingRegenerate(false)}
      />
      <ProovraConfirmSheet
        visible={deletingComment !== null}
        title="Delete this comment?"
        consequence="The comment is removed from this record's reviewer comments. The deletion is recorded in the reviewer audit."
        confirmLabel="Delete"
        tone="danger"
        busy={commentBusy}
        onConfirm={() => void deleteComment()}
        onCancel={() => setDeletingComment(null)}
      />

      {tab === "materials" ? (
        <ProovraSection title="Files in this record">
          {/*
            The record's preserved files. `downloadable` is the SERVER's
            decision: a control the server has already refused is not offered,
            and when it cannot be offered the reason is shown.
          */}
          <ProovraCard>
            {materials.map((m) => (
              <View key={m.id} style={styles.detailRow}>
                <ProovraText variant="bodySm" weight="semibold">
                  {m.label}
                </ProovraText>
                <ProovraText variant="label" color={theme.color.ink.muted}>
                  {[m.kind, m.mimeType, m.sizeLabel].filter(Boolean).join(" · ")}
                </ProovraText>
                {/* Per-part technical metadata (web EvidencePartMetadataTable). */}
                {technical && technicalPartFor(technical.perParts, m) && partMetaLine(technicalPartFor(technical.perParts, m) as TechnicalPart) ? (
                  <ProovraText variant="label" color={theme.color.ink.secondary}>
                    {partMetaLine(technicalPartFor(technical.perParts, m) as TechnicalPart)}
                  </ProovraText>
                ) : null}
                {m.representationNote ? (
                  <ProovraText variant="label" color={theme.color.ink.muted}>
                    {m.representationNote}
                  </ProovraText>
                ) : null}
                {m.sha256 ? (
                  <>
                    <ProovraText variant="label" mono numberOfLines={1} color={theme.color.ink.muted} selectable>
                      {m.sha256}
                    </ProovraText>
                    {/* EvidencePartMetadataTable.tsx:154 */}
                    <CopyButton value={m.sha256} label="Copy SHA-256" accessibilityLabel={`Copy SHA-256 of ${m.label ?? "this file"}`} />
                  </>
                ) : null}
                {materialBlockedReason(m) ? (
                  <ProovraText variant="label" color={theme.color.ink.muted}>
                    {materialBlockedReason(m)}
                  </ProovraText>
                ) : (
                  <ProovraButton
                    label="Open file"
                    variant="secondary"
                    fullWidth={false}
                    onPress={() => void Linking.openURL(m.viewUrl as string)}
                  />
                )}
              </View>
            ))}
          </ProovraCard>
        </ProovraSection>
      ) : null}

      {/*
        T-12 — the record's discussion THREADS (EvidenceDiscussionTab.tsx), shown
        when the review workspace allows discussion (enabled or read-only).
      */}
      {tab === "discussion" && discussionCaps.visible ? (
        <EvidenceDiscussion evidenceId={String(id)} teamId={requestTeamId} readOnly={discussionCaps.readOnly} />
      ) : null}

      {tab === "discussion" ? (
        <ProovraSection title="Reviewer comments">
          {/*
            ReviewerCommentsPanel.tsx — list, add, edit, delete. Visibility
            defaults to workspace-only: a comment that turns out to be wider
            than its author intended cannot be un-seen.
          */}
          <ProovraText variant="label" color={theme.color.ink.muted}>
            Reviewer comments are operational notes and do not alter the recorded integrity state.
          </ProovraText>
          <ProovraCard>
            <ProovraFormField label="Add comment">
              <ProovraInput
                value={draft}
                onChangeText={setDraft}
                placeholder="What should a reviewer know?"
                multiline
                autoCapitalize="sentences"
                accessibilityLabel="Add comment"
              />
            </ProovraFormField>
            <ProovraFilterChips
              label="Visible to"
              value={visibility}
              onChange={(v: string) => setVisibility(v as EvidenceCommentVisibility)}
              options={EVIDENCE_COMMENT_VISIBILITIES.map((v) => ({
                value: v,
                label: commentVisibilityLabel(v),
              }))}
            />
            <ProovraButton
              label="Save Comment"
              loading={commentBusy && editingComment === null}
              disabled={!isSendableComment(draft)}
              onPress={() => void postComment()}
            />
          </ProovraCard>
          {comments === null ? (
            <ProovraLoadingState label="Loading comments..." />
          ) : commentsFailed ? (
            <ProovraErrorState message="Comments on this record could not be loaded." onRetry={() => void loadComments()} />
          ) : comments.length === 0 ? (
            <ProovraCard>
              <ProovraText variant="bodySm" color={theme.color.ink.secondary}>
                No reviewer comments yet.
              </ProovraText>
            </ProovraCard>
          ) : (
            <ProovraCard>
              {comments.map((cm) => (
                <View key={cm.id} style={styles.detailRow}>
                  <ProovraText variant="label" weight="semibold">{cm.authorName}</ProovraText>
                  <ProovraText variant="label" color={theme.color.ink.muted}>
                    {[
                      cm.createdAtIso ? formatUserDateTime(cm.createdAtIso) : null,
                      commentVisibilityLabel(cm.visibility),
                      cm.edited ? "Edited" : null,
                    ]
                      .filter(Boolean)
                      .join(" • ")}
                  </ProovraText>
                  {editingComment?.id === cm.id ? (
                    <>
                      <ProovraInput
                        value={editingComment.body}
                        onChangeText={(v: string) => setEditingComment({ id: cm.id, body: v })}
                        multiline
                        accessibilityLabel="Edit comment"
                      />
                      <View style={styles.inline}>
                        <ProovraButton label="Save" fullWidth={false} loading={commentBusy} disabled={!isSendableComment(editingComment.body)} onPress={() => void saveCommentEdit()} />
                        <ProovraButton label="Cancel" variant="ghost" fullWidth={false} onPress={() => setEditingComment(null)} />
                      </View>
                    </>
                  ) : (
                    <>
                      <ProovraText variant="bodySm">{cm.body}</ProovraText>
                      <View style={styles.inline}>
                        <ProovraButton label="Edit" accessibilityLabel={`Edit comment by ${cm.authorName}`} variant="ghost" fullWidth={false} onPress={() => setEditingComment({ id: cm.id, body: cm.body })} />
                        <ProovraButton label="Delete" accessibilityLabel={`Delete comment by ${cm.authorName}`} variant="ghost" fullWidth={false} onPress={() => setDeletingComment(cm.id)} />
                      </View>
                    </>
                  )}
                </View>
              ))}
            </ProovraCard>
          )}
        </ProovraSection>
      ) : null}

      {tab === "derived" ? (
        <DerivedReviewTab evidenceId={String(id)} teamId={platform.context?.activeTeamId ?? null} />
      ) : null}

      {/* ONE shared rail for every tab (EvidenceRecordRail.tsx), below the tab body on a phone. */}
      {rw ? <EvidenceRecordRail signals={riskSignals} record={record} publicVerification={publicVerification} shareUrl={shareUrl} /> : null}
    </ProovraScreen>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <View style={styles.detailRow}>
      <ProovraText variant="label" color={theme.color.ink.muted}>
        {k}
      </ProovraText>
      <ProovraText variant="bodySm" mono={mono} numberOfLines={mono ? 2 : 1} style={styles.detailValue} selectable={mono}>
        {v}
      </ProovraText>
      {/* The web MetadataRow copy control, on every identifier value (MetadataRow.tsx:25). */}
      {mono && v && v !== "—" ? <CopyButton value={v} accessibilityLabel={`Copy ${k}`} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: "row", alignItems: "center", gap: theme.space.s2, marginTop: theme.space.s2 },
  hero: { marginBottom: theme.space.s4 },
  badgeRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2 },
  heroTitle: { marginTop: theme.space.s2 },
  heroActions: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2, marginTop: theme.space.s3 },
  verdict: { marginTop: theme.space.s3, gap: theme.space.s1 },
  inline: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.space.s2, marginTop: theme.space.s2 },
  tabs: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.s2, marginBottom: theme.space.s4 },
  tab: { paddingHorizontal: theme.space.s3, paddingVertical: theme.space.s2, borderRadius: theme.radius.pill, borderWidth: 1, minHeight: 36, justifyContent: "center" },
  detailRow: { paddingVertical: theme.space.s2, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.color.border.subtle, gap: 2 },
  detailValue: { marginTop: 2 },
  note: { marginTop: theme.space.s3 },
});
