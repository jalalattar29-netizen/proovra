"use client";

/**
 * PROOVRA Phase 2A — Reviewer Workspace.
 *
 * The single operational surface where reviewers receive → review →
 * annotate → code → decide → escalate → participate in QC → resolve
 * disagreements → see metrics, without leaving the page.
 *
 * Layout (side-by-side):
 *
 *   ┌───────────────────────────────────────────────────────────────┐
 *   │ Workspace ribbon · role · queues · disagreements · QC · ▮▮▮   │
 *   ├──────────────────┬───────────────────┬───────────────────────┤
 *   │ Queue rail       │ Evidence viewer   │ Coding panel + actions│
 *   │ (≤25 visible)    │ (active workflow) │ (schema-driven)       │
 *   │ Hotkeys: j/k     │ Hotkeys: f/n/v/c  │ Hotkeys: a/r/e/i/g    │
 *   └──────────────────┴───────────────────┴───────────────────────┘
 *
 * Hard rules:
 *   * Bounded vocabulary throughout — PROOVRA language only, no
 *     authenticity assertions.
 *   * Capability-aware — buttons disable when the caller lacks the
 *     bounded capability.
 *   * Hotkeys never intercept text inputs.
 */

import { AppListbox } from "../../../../components/app-primitives/AppListbox";
import { reviewerDenialMessage } from "@proovra/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

import {
  type ReviewerCapability,
  type ReviewerWorkspaceProjection,
  identifierLabel,
} from "@proovra/shared";

import { useReviewDestination } from "../../../../components/reviewer-experience/reviewDestination";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { OperationalEmptyState } from "../../../../components/operational";
import { formatUserDateTime } from "../../../../lib/date";
import {
  escalationSummaryText,
  governingDeadlineText,
} from "../../../../lib/reviewer-workspace/sla-presentation";
import { formatMetricPct as pctOrNoData } from "../../../../lib/reviewer-workspace/metric-format";
import {
  reviewerHotkeyLabel,
  reviewerRoleLabel,
} from "../../../../lib/labels/governanceReviewLabels";

import { PageShell, PageSection } from "../../../../components/ui";
// TEAM-UI-SPEC (structure) — the one review page header: icon title row, the
// tool name, a "← Review" back link above it, no eyebrow.
import {
  ReviewPageHeader,
  REVIEW_HUB_BACK,
} from "../../../../components/reviewer-experience/ReviewPageHeader";
import { CanonicalActionButton } from "../../../../components/external-review/CanonicalActionButton";
import { Modal } from "../../../../components/cases-experience/matter-modals/Modal";
import "../../../../components/reviewer-experience/review-surfaces.css";
import { Badge } from "../../../../components/ui/Badge";
import { EmptyState } from "../../../../components/ui/EmptyState";

import { CodingPanel } from "../../../../components/reviewer-workspace/CodingPanel";
import { useReviewerHotkeys } from "../../../../lib/reviewer-workspace/reviewer-hotkeys";
import {
  fetchAnnotationsForEvidence,
  fetchCodingState,
  fetchEvidenceArtifactsStatus,
  fetchEvidencePreview,
  fetchEvidenceSidePaneDetail,
  fetchExtractedTextsForEvidence,
  fetchReviewerOpsWorkspace,
  fetchReviewerWorkspace,
  fetchSchema,
  fileDisagreement,
  listWorkflowDecisions,
  type CodingFieldRow,
  type CodingValueRow,
  type EvidenceArtifactsResult,
  type EvidencePreviewMeta,
  type EvidenceSidePaneResult,
  type ExtractedTextsResult,
  type ReviewerOpsWorkspaceSummary,
  type WorkflowDecisionRow,
  writeCodingValue,
} from "../../../../lib/reviewer-workspace/reviewer-api";
import { useActiveSpace, useActiveSpaceId } from "../../../../lib/platform-context";
import { usePlatformContext } from "../../../../lib/platform-context";
import { isApiResponseError } from "../../../../lib/api";
import type { ReviewerAnnotationSummary } from "../../../../lib/reviewer-workspace/annotation-types";
import { MediaViewer } from "../../../../components/reviewer-workspace/viewers/MediaViewer";
import { AnnotationPanel } from "../../../../components/reviewer-workspace/AnnotationPanel";
import {
  SidePaneSwitcher,
  SIDE_PANE_MODES,
  type SidePaneMode,
} from "../../../../components/reviewer-workspace/SidePaneSwitcher";
import { SidePaneEvidence } from "../../../../components/reviewer-workspace/SidePaneEvidence";
import { SidePaneExtractedTexts } from "../../../../components/reviewer-workspace/SidePaneExtractedTexts";
import { SidePaneReport } from "../../../../components/reviewer-workspace/SidePaneReport";
// Team remediation T-001…T-006 — focus mode decides through the Review page's
// decision component and the canonical door.
import { FocusDecisionColumn, type FocusHotkeyRequest } from "./_components/FocusDecisionColumn";
import type { DecisionSubmitBody } from "../../reviewer-ops/[reviewId]/_components/DecisionPanel";
import type { DecisionOutcome } from "../../reviewer-ops/[reviewId]/_components/inspector-model";

export default function ReviewerWorkspacePage() {
  return (
    <PageRouteGate routeId="workspace.review_workspace">
      <ReviewerWorkspaceShell />
    </PageRouteGate>
  );
}

function ReviewerWorkspaceShell() {
  const teamId = useActiveSpaceId();
  // Phase 5 — Redaction affordance hint. The CapabilityMap has no
  // REDACTION_* key, so we derive the hint from the active space role
  // label. Canonical permissions (packages/shared/permissions.ts)
  // grant `redaction.region.author` to OWNER / ADMIN / REVIEWER (the
  // DB-level MEMBER conceptual role). VIEWER does NOT receive it.
  // Server gating remains the source of truth; this flag only
  // governs whether the affordance renders active or disabled.
  const activeSpace = useActiveSpace();
  const roleLabel = activeSpace?.roleLabel ?? null;
  // PRO-R3-06 (WS-ENT) — the server's rule: redaction writes need
  // FEATURE_REDACTION (planFeatures.redactionIncluded) AND an OWNER / ADMIN
  // redaction role (assertRedactionCapability). A MEMBER, or a workspace
  // without the entitlement, was offered "Request redaction" and refused.
  // An envelope from an API that does not project the field yet leaves the
  // entitlement unknown: the role rule alone applies and the server decides.
  const redactionIncluded = usePlatformContext()?.envelope?.planFeatures?.redactionIncluded;
  const canRequestRedaction =
    redactionIncluded !== false &&
    (roleLabel === "OWNER" || roleLabel === "ADMIN" || roleLabel === "Owner");
  const [workspace, setWorkspace] = useState<ReviewerWorkspaceProjection | null>(null);
  const [loadingWorkspace, setLoadingWorkspace] = useState(true);
  const [fields, setFields] = useState<CodingFieldRow[]>([]);
  const [values, setValues] = useState<CodingValueRow[]>([]);
  const [unfulfilled, setUnfulfilled] = useState<Set<string>>(new Set());
  const [activeWorkflowId, setActiveWorkflowId] = useState<string | null>(null);
  const [activeEvidenceId, setActiveEvidenceId] = useState<string | null>(null);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<ReviewerAnnotationSummary[]>([]);
  const [preview, setPreview] = useState<EvidencePreviewMeta | null>(null);
  const [activeWorkflowSummary, setActiveWorkflowSummary] =
    useState<ReviewerOpsWorkspaceSummary | null>(null);
  const [sidePaneMode, setSidePaneMode] = useState<SidePaneMode>("CODING");
  const [helpOpen, setHelpOpen] = useState(false);
  // PHASE 1 — Side-pane lazy-load state.
  //
  // The OCR / TRANSCRIPT / EVIDENCE / REPORT side-pane tabs each
  // consume a canonical EXISTING endpoint:
  //
  //   * EVIDENCE   -> GET /v1/evidence/:id                       (wireable)
  //   * OCR        -> GET /v1/intelligence/evidence/:id?teamId=  (wireable;
  //                   server projection drops raw text — summary only)
  //   * TRANSCRIPT -> same intelligence endpoint, filtered by kind
  //   * REPORT     -> GET /v1/evidence/:id/artifacts/status      (wireable;
  //                   side-effect-free poll — never /report/latest, which
  //                   writes download / view custody events)
  //
  // Each tab only fetches when (a) the tab is open and (b) the
  // activeEvidenceId changes. A token guards against late responses
  // for a stale evidence id overwriting fresher data.
  const [evidenceSide, setEvidenceSide] = useState<
    | { phase: "LOADING" }
    | { phase: "READY"; result: EvidenceSidePaneResult }
    | { phase: "RETRY" }
    | null
  >(null);
  const [extractedSide, setExtractedSide] = useState<
    | { phase: "LOADING" }
    | { phase: "READY"; result: ExtractedTextsResult }
    | null
  >(null);
  const [reportSide, setReportSide] = useState<
    | { phase: "LOADING" }
    | { phase: "READY"; result: EvidenceArtifactsResult }
    | null
  >(null);
  // Team remediation T-002/T-003 — the result of a decision is shown next to
  // the decision column (never in the ribbon), in the shared outcome copy.
  const [decisionNotice, setDecisionNotice] = useState<string | null>(null);
  // a / r / i / e drive the shared decision controls (FocusDecisionColumn).
  const [hotkeyRequest, setHotkeyRequest] = useState<FocusHotkeyRequest | null>(null);
  const hotkeyNonce = useRef(0);
  const requestHotkey = useCallback((kind: FocusHotkeyRequest["kind"]) => {
    hotkeyNonce.current += 1;
    setHotkeyRequest({ kind, nonce: hotkeyNonce.current });
  }, []);
  // T-003 — the summary card is refetched after EVERY mutation, not only when
  // the active review changes.
  const [summaryVersion, setSummaryVersion] = useState(0);
  // PHASE 2 — Disagreement filing. The canonical
  // fileDisagreement service requires a real originalDecisionId
  // (UUID) tied to the workflow + team — we can't synthesize one
  // from a free-text prompt. So when the operator clicks Disagree
  // we fetch the workflow's prior decisions from
  // /v1/reviewer-ops/workspace/:workflowId/decisions and present a
  // picker. If there are none, Disagree is disabled with explicit
  // copy.
  type DisagreeFormState =
    | { phase: "LOADING" }
    | { phase: "READY"; decisions: WorkflowDecisionRow[] }
    | { phase: "EMPTY" }
    | { phase: "ERROR" };
  const [disagreeForm, setDisagreeForm] = useState<DisagreeFormState | null>(
    null,
  );
  const [disagreeBusy, setDisagreeBusy] = useState(false);

  // Load workspace projection.
  //
  // PRO-077: a VIEWER is answered 403 { denial: "NOT_PERMITTED" }. The
  // rejection used to escape this effect, so loadingWorkspace never went
  // false and the page said "Loading reviewer workspace…" forever. A refusal
  // is now the "no reviewer role" state; any other failure is an error the
  // person can retry. Neither is ever a spinner.
  const [workspaceLoadAttempt, setWorkspaceLoadAttempt] = useState(0);
  const [workspaceLoadError, setWorkspaceLoadError] = useState<
    { kind: "DENIED"; denial: string | null } | { kind: "FAILED" } | null
  >(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingWorkspace(true);
      setWorkspaceLoadError(null);
      try {
        const ws = await fetchReviewerWorkspace(teamId);
        if (cancelled) return;
        setWorkspace(ws);
        if (ws?.activeReview) {
          setActiveWorkflowId(ws.activeReview.workflowId);
          setActiveEvidenceId(ws.activeReview.evidenceId);
        }
      } catch (err) {
        if (cancelled) return;
        setWorkspace(null);
        setWorkspaceLoadError(
          isApiResponseError(err) && err.statusCode === 403
            ? { kind: "DENIED", denial: typeof err.code === "string" ? err.code : null }
            : { kind: "FAILED" },
        );
      } finally {
        if (!cancelled) setLoadingWorkspace(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [teamId, workspaceLoadAttempt]);

  // Load evidence preview + annotations for the active evidence.
  const refreshAnnotations = useCallback(async () => {
    if (!activeEvidenceId) {
      setAnnotations([]);
      return;
    }
    const rows = await fetchAnnotationsForEvidence(activeEvidenceId);
    setAnnotations(rows);
  }, [activeEvidenceId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!activeEvidenceId) {
        setPreview(null);
        setAnnotations([]);
        return;
      }
      const [p, anns] = await Promise.all([
        fetchEvidencePreview(activeEvidenceId),
        fetchAnnotationsForEvidence(activeEvidenceId),
      ]);
      if (cancelled) return;
      setPreview(p);
      setAnnotations(anns);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeEvidenceId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!teamId || !activeWorkflowId) {
        setActiveWorkflowSummary(null);
        return;
      }
      const summary = await fetchReviewerOpsWorkspace(activeWorkflowId, teamId);
      if (cancelled) return;
      setActiveWorkflowSummary(summary);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeWorkflowId, teamId, summaryVersion]);

  // PHASE 1 — Reset the side-pane caches when the active evidence
  // changes so a stale OCR / TRANSCRIPT / EVIDENCE / REPORT projection
  // doesn't survive across queue navigation. The lazy-load effects
  // below will re-pull on next tab open.
  useEffect(() => {
    setEvidenceSide(null);
    setExtractedSide(null);
    setReportSide(null);
  }, [activeEvidenceId]);

  // PHASE 1 — Lazy-load EVIDENCE side-pane.
  // Fires only when the tab is open AND there is an evidence id.
  useEffect(() => {
    if (sidePaneMode !== "EVIDENCE") return;
    if (!activeEvidenceId) return;
    if (evidenceSide && evidenceSide.phase === "READY") return;
    let cancelled = false;
    setEvidenceSide({ phase: "LOADING" });
    (async () => {
      try {
        const result = await fetchEvidenceSidePaneDetail(activeEvidenceId);
        if (cancelled) return;
        setEvidenceSide({ phase: "READY", result });
      } catch (err) {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.warn("[reviewer-workspace] evidence side-pane threw", {
          evidenceId: activeEvidenceId,
          err,
        });
        setEvidenceSide({
          phase: "READY",
          result: { ok: false, reason: "ERROR" },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sidePaneMode, activeEvidenceId, evidenceSide]);

  // PHASE 1 — Lazy-load OCR / TRANSCRIPT side-pane (shared cache —
  // both tabs filter the same intelligence projection by `kind`).
  useEffect(() => {
    if (sidePaneMode !== "OCR" && sidePaneMode !== "TRANSCRIPT") return;
    if (!activeEvidenceId) return;
    if (extractedSide && extractedSide.phase === "READY") return;
    let cancelled = false;
    setExtractedSide({ phase: "LOADING" });
    (async () => {
      try {
        const result = await fetchExtractedTextsForEvidence(
          activeEvidenceId,
          teamId,
        );
        if (cancelled) return;
        setExtractedSide({ phase: "READY", result });
      } catch (err) {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.warn(
          "[reviewer-workspace] extracted-texts side-pane threw",
          { evidenceId: activeEvidenceId, err },
        );
        setExtractedSide({
          phase: "READY",
          result: { ok: false, reason: "ERROR" },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sidePaneMode, activeEvidenceId, teamId, extractedSide]);

  // PHASE 1 — Lazy-load REPORT side-pane.
  // Backed by /artifacts/status (side-effect free) — never the
  // /report/latest path, which records download / view custody events.
  useEffect(() => {
    if (sidePaneMode !== "REPORT") return;
    if (!activeEvidenceId) return;
    if (reportSide && reportSide.phase === "READY") return;
    let cancelled = false;
    setReportSide({ phase: "LOADING" });
    (async () => {
      try {
        const result = await fetchEvidenceArtifactsStatus(activeEvidenceId);
        if (cancelled) return;
        setReportSide({ phase: "READY", result });
      } catch (err) {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.warn(
          "[reviewer-workspace] artifacts-status side-pane threw",
          { evidenceId: activeEvidenceId, err },
        );
        setReportSide({
          phase: "READY",
          result: { ok: false, reason: "ERROR" },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sidePaneMode, activeEvidenceId, reportSide]);

  // Retry handlers — clearing the cache forces the lazy-load effects
  // above to re-fire on next render (same evidence id, no stale data).
  const retryEvidenceSide = useCallback(() => {
    setEvidenceSide(null);
  }, []);
  const retryExtractedSide = useCallback(() => {
    setExtractedSide(null);
  }, []);
  const retryReportSide = useCallback(() => {
    setReportSide(null);
  }, []);

  // Load coding schema + values for the active workflow.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!activeWorkflowId || !workspace?.activeReview?.codingSchemaId) {
        setFields([]);
        setValues([]);
        setUnfulfilled(new Set());
        return;
      }
      const schemaId = workspace.activeReview.codingSchemaId;
      const [schema, state] = await Promise.all([
        fetchSchema(schemaId, teamId),
        fetchCodingState(activeWorkflowId, teamId),
      ]);
      if (cancelled) return;
      setFields(schema?.fields ?? []);
      setValues(state.values);
      setUnfulfilled(new Set(state.coverage.unfulfilledFieldIds));
    })();
    return () => {
      cancelled = true;
    };
    // teamId is a real dependency: the schema/coding reads are workspace-scoped,
    // so a workspace switch must re-run this effect (and the cancelled guard
    // discards the previous workspace's in-flight response).
  }, [activeWorkflowId, workspace?.activeReview?.codingSchemaId, teamId]);

  // Coding writes.
  const onWrite = useCallback(
    async (input: {
      fieldId: string;
      value: Record<string, unknown>;
      rationale?: string;
    }) => {
      if (!activeWorkflowId) return;
      const res = await writeCodingValue({
        workflowId: activeWorkflowId,
        fieldId: input.fieldId,
        value: input.value,
        rationale: input.rationale,
        teamId,
      });
      if (res.ok) {
        // Re-pull coding state for fresh coverage.
        const state = await fetchCodingState(activeWorkflowId, teamId);
        setValues(state.values);
        setUnfulfilled(new Set(state.coverage.unfulfilledFieldIds));
      } else {
        setStatusBanner(`Coding not saved. ${reviewerDenialMessage(res.denial)}`);
      }
    },
    // Coding writes are workspace-scoped; the callback must not keep writing
    // against the workspace that was active when it was first created.
    [activeWorkflowId, teamId],
  );

  // Phase 2A Closure — auto-advance to the next assigned workflow
  // after the reviewer records a decision. Pulls the workspace
  // projection again and picks the active review pointer.
  const advanceToNext = useCallback(async () => {
    const ws = await fetchReviewerWorkspace(teamId);
    setWorkspace(ws);
    if (ws?.activeReview) {
      setActiveWorkflowId(ws.activeReview.workflowId);
      setActiveEvidenceId(ws.activeReview.evidenceId);
    } else {
      setActiveWorkflowId(null);
      setActiveEvidenceId(null);
    }
  }, [teamId]);

  // Team remediation T-001 — a decision recorded through the shared panel.
  // The coded verdict value (a coverage artifact, never the decision) is
  // written only after the decision was recorded; a decision that moved the
  // review out of this reviewer's hands advances to the next item (the server
  // no longer selects a review awaiting this reviewer's own second review).
  const onDecided = useCallback(
    async (body: DecisionSubmitBody, _outcome: DecisionOutcome | null, moved: boolean) => {
      const verdictField = fields.find((f) => f.fieldType === "REVIEWER_VERDICT");
      const verdict = body.decision === "REQUEST_INFO" ? "NEEDS_INFO" : body.decision;
      if (verdictField && (verdict === "APPROVE" || verdict === "REJECT" || verdict === "NEEDS_INFO")) {
        try {
          await onWrite({ fieldId: verdictField.id, value: { verdict }, rationale: body.rationale });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn("[reviewer-workspace] verdict coding-value write threw", { workflowId: activeWorkflowId, err });
        }
      }
      if (moved) await advanceToNext();
    },
    [fields, onWrite, advanceToNext, activeWorkflowId],
  );
  const onMutated = useCallback(() => setSummaryVersion((v) => v + 1), []);

  // ---------------------------------------------------------------------------
  // PHASE 2 — Disagree wiring.
  //
  // Open Disagree: fetch the workflow's prior decisions. If none, the
  // form opens in the EMPTY phase and Submit is disabled with an
  // explicit "no prior decision on file" message. If the fetch itself
  // fails, ERROR phase surfaces and Submit is disabled.
  // ---------------------------------------------------------------------------
  const openDisagreeForm = useCallback(async () => {
    if (!activeWorkflowId) return;
    if (!teamId) {
      setStatusBanner(
        "No active workspace — switch to a workspace before filing a disagreement.",
      );
      return;
    }
    setDisagreeForm({ phase: "LOADING" });
    const rows = await listWorkflowDecisions({
      workflowId: activeWorkflowId,
      teamId,
    });
    if (rows === null) {
      setDisagreeForm({ phase: "ERROR" });
      return;
    }
    if (rows.length === 0) {
      setDisagreeForm({ phase: "EMPTY" });
      return;
    }
    setDisagreeForm({ phase: "READY", decisions: rows });
  }, [activeWorkflowId, teamId]);

  const cancelDisagreeForm = useCallback(() => {
    setDisagreeForm(null);
  }, []);

  const submitDisagreeForm = useCallback(
    async (input: { originalDecisionId: string; rationale: string }) => {
      if (!activeWorkflowId) return;
      if (disagreeBusy) return;
      setDisagreeBusy(true);
      try {
        const res = await fileDisagreement({
          workflowId: activeWorkflowId,
          originalDecisionId: input.originalDecisionId,
          rationale: input.rationale,
          teamId,
        });
        if (res.ok) {
          setStatusBanner(
            "Disagreement filed. Track progress on the Disagreements surface.",
          );
          setDisagreeForm(null);
          // Refresh the workspace projection so the
          // `disagreements.awaitingAdjudication` counter on the ribbon
          // updates with the new filing.
          try {
            const ws = await fetchReviewerWorkspace(teamId);
            setWorkspace(ws);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(
              "[reviewer-workspace] disagreement workspace refresh threw",
              { workflowId: activeWorkflowId, err },
            );
          }
        } else {
          // Surface the bounded denial reason; do NOT close the form
          // so the operator can retry without re-picking the decision.
          // eslint-disable-next-line no-console
          console.warn(
            "[reviewer-workspace] disagreement filing refused",
            {
              workflowId: activeWorkflowId,
              denial: res.denial,
            },
          );
          setStatusBanner(`Disagreement not filed. ${reviewerDenialMessage(res.denial)}`);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[reviewer-workspace] disagreement call threw", {
          workflowId: activeWorkflowId,
          err,
        });
        setStatusBanner(
          "Disagreement not filed — please retry.",
        );
      } finally {
        setDisagreeBusy(false);
      }
    },
    [activeWorkflowId, disagreeBusy, teamId],
  );

  // Cycle through side-pane modes (`]` forward, `[` backward).
  const cycleSidePane = useCallback((dir: 1 | -1) => {
    const idx = SIDE_PANE_MODES.indexOf(sidePaneMode);
    const next = SIDE_PANE_MODES[
      (idx + dir + SIDE_PANE_MODES.length) % SIDE_PANE_MODES.length
    ] as SidePaneMode;
    setSidePaneMode(next);
  }, [sidePaneMode]);

  // PRO-P3DZ-02 — ONE predicate for the decision bar and its keys: a key
  // never does what its disabled button refuses (no review.decide, a
  // decision in flight, a reason or disagreement form open).
  // T-005 — whether a verdict is open is the SERVER's answer (viewer.actions in
  // the shared panel); a key only asks the panel, which enforces it.
  const canDecide = activeWorkflowId !== null && disagreeForm === null;
  const hotkeys = useReviewerHotkeys(
    useMemo(
      () => ({
        // Phase 1: lifecycle wiring is the source of truth. onDecision
        // either opens the reason form (REJECT / ESCALATE / NEEDS_INFO)
        // or runs the APPROVE lifecycle, which advances on success.
        // Hotkeys MUST NOT pre-advance — that would mask partial failure.
        APPROVE: () => (canDecide ? requestHotkey("APPROVE") : undefined),
        REJECT: () => (canDecide ? requestHotkey("REJECT") : undefined),
        ESCALATE: () => (canDecide ? requestHotkey("ESCALATE") : undefined),
        REQUEST_INFO: () => (canDecide ? requestHotkey("REQUEST_INFO") : undefined),
        NEXT_ITEM: () => void advanceToNext(),
        TOGGLE_ANNOTATIONS: () => setSidePaneMode("ANNOTATIONS"),
        FOCUS_CODING_PANEL: () => setSidePaneMode("CODING"),
        HELP: () => setHelpOpen((o) => !o),
      }),
      [requestHotkey, advanceToNext, canDecide],
    ),
    activeWorkflowId !== null,
  );

  if (loadingWorkspace) {
    return (
      <div
        role="status"
        className="app-field-help"
        style={{ padding: "var(--page-pad-y, 28px) var(--page-pad-x, 32px)" }}
      >
        Loading reviewer workspace…
      </div>
    );
  }

  if (!workspace && workspaceLoadError?.kind === "FAILED") {
    return (
      <PageShell
        header={
          <ReviewPageHeader
            back={REVIEW_HUB_BACK}
            title="Reviewer workspace"
            subtitle="The operational surface for receiving, reviewing, coding and deciding evidence workflows."
          />
        }
      >
        <PageSection>
          <EmptyState
            framed
            title="The reviewer workspace could not be loaded."
            purpose="Nothing was changed. Check your connection and try again."
            action={
              <CanonicalActionButton variant="secondary" onClick={() => setWorkspaceLoadAttempt((n) => n + 1)}>
                Try again
              </CanonicalActionButton>
            }
          />
        </PageSection>
      </PageShell>
    );
  }

  if (!workspace) {
    return (
      <PageShell
        header={
          <ReviewPageHeader
            back={REVIEW_HUB_BACK}
            title="Reviewer workspace"
            subtitle="The operational surface for receiving, reviewing, coding and deciding evidence workflows."
          />
        }
      >
        <PageSection>
          <EmptyState
            framed
            title={
              workspaceLoadError?.kind === "DENIED" && workspaceLoadError.denial === "WORKSPACE_NOT_FOUND"
                ? reviewerDenialMessage("WORKSPACE_NOT_FOUND")
                : "You do not have a reviewer role in this workspace."
            }
            purpose="Ask a workspace admin to invite you as a Reviewer or above to receive assignments here."
          />
        </PageSection>
      </PageShell>
    );
  }

  const capabilities = new Set<ReviewerCapability>(workspace.capabilities);

  return (
    <PageShell
      width="full"
      data-reviewer-workspace
      data-reviewer-role={workspace.role}
      style={{
        gap: 12,
        paddingBlock: "var(--page-pad-y, 24px) 12px",
        minHeight: "calc(100vh - 64px)",
      }}
      header={
        <ReviewPageHeader
          back={REVIEW_HUB_BACK}
          title="Reviewer workspace"
          subtitle="Receive, review, annotate, code and decide evidence workflows — without leaving the page."
          contextStrip={<Badge tone="governance">Role: {reviewerRoleLabel(workspace.role)}</Badge>}
        />
      }
    >
      <WorkspaceRibbon workspace={workspace} statusBanner={statusBanner} />

      {/* TEAM-UI-SPEC §4 — three columns on desktop; review-workspace.css
          stacks them below 1100 px so nothing clips at 320/390 px (the
          fixed 180 + 320 px minimums used to push the page sideways). */}
      <div className="review-workspace-grid" data-reviewer-workspace-grid>
        <QueueRail workspace={workspace} />

        <EvidenceViewerColumn
          workflowId={activeWorkflowId}
          evidenceId={activeEvidenceId}
          preview={preview}
          annotations={annotations}
          workspace={workspace}
        />

        <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
          {activeWorkflowSummary ? (
            <WorkflowSummaryCard
              summary={activeWorkflowSummary}
              codingSchemaId={workspace.activeReview?.codingSchemaId ?? null}
            />
          ) : (
            <WorkspaceGuidanceCard />
          )}
          {decisionNotice ? (
            <p role="status" className="app-alert app-alert--ok" data-focus-decision-notice style={{ margin: 0 }}>
              {decisionNotice}
            </p>
          ) : null}
          {activeWorkflowId && teamId ? (
            <FocusDecisionColumn
              key={activeWorkflowId}
              teamId={teamId}
              workflowId={activeWorkflowId}
              hotkeyRequest={hotkeyRequest}
              onNotice={setDecisionNotice}
              onDecided={(body, outcome, moved) => void onDecided(body, outcome, moved)}
              onMutated={onMutated}
            />
          ) : null}
          <DecisionBar
            capabilities={capabilities}
            disabled={disagreeForm !== null}
            onDisagree={() => {
              void openDisagreeForm();
            }}
            hotkeys={hotkeys}
          />
          {disagreeForm ? (
            <DisagreeForm
              state={disagreeForm}
              busy={disagreeBusy}
              onSubmit={submitDisagreeForm}
              onCancel={cancelDisagreeForm}
            />
          ) : null}
          <SidePaneSwitcher current={sidePaneMode} onChange={setSidePaneMode} />
          {sidePaneMode === "CODING" ? (
            <CodingPanel
              fields={fields}
              values={values}
              unfulfilledFieldIds={unfulfilled}
              onWrite={onWrite}
            />
          ) : null}
          {sidePaneMode === "ANNOTATIONS" && activeEvidenceId ? (
            <AnnotationPanel
              evidenceId={activeEvidenceId}
              annotations={annotations}
              onChange={() => void refreshAnnotations()}
            />
          ) : null}
          {(sidePaneMode === "EVIDENCE" ||
            sidePaneMode === "OCR" ||
            sidePaneMode === "TRANSCRIPT" ||
            sidePaneMode === "REPORT") &&
          !activeEvidenceId ? (
            <SidePaneNoEvidence mode={sidePaneMode} />
          ) : null}
          {sidePaneMode === "EVIDENCE" && activeEvidenceId ? (
            <SidePaneEvidence
              evidenceId={activeEvidenceId}
              state={evidenceSide ?? { phase: "LOADING" }}
              onRetry={retryEvidenceSide}
              canRequestRedaction={canRequestRedaction}
            />
          ) : null}
          {sidePaneMode === "OCR" && activeEvidenceId ? (
            <SidePaneExtractedTexts
              mode="OCR"
              state={extractedSide ?? { phase: "LOADING" }}
              onRetry={retryExtractedSide}
            />
          ) : null}
          {sidePaneMode === "TRANSCRIPT" && activeEvidenceId ? (
            <SidePaneExtractedTexts
              mode="TRANSCRIPT"
              state={extractedSide ?? { phase: "LOADING" }}
              onRetry={retryExtractedSide}
            />
          ) : null}
          {sidePaneMode === "REPORT" && activeEvidenceId ? (
            <SidePaneReport
              evidenceId={activeEvidenceId}
              state={reportSide ?? { phase: "LOADING" }}
              onRetry={retryReportSide}
            />
          ) : null}
        </div>
      </div>

      {helpOpen ? (
        <HelpOverlay onClose={() => setHelpOpen(false)} hotkeys={hotkeys} />
      ) : null}

      <CycleSidePaneHandler onCycle={cycleSidePane} />
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// Evidence column with MediaViewer
// ---------------------------------------------------------------------------

function EvidenceViewerColumn({
  workflowId,
  evidenceId,
  preview,
  annotations,
  workspace,
}: {
  workflowId: string | null;
  evidenceId: string | null;
  preview: EvidencePreviewMeta | null;
  annotations: ReviewerAnnotationSummary[];
  workspace: ReviewerWorkspaceProjection;
}) {
  if (!workflowId || !evidenceId) {
    return (
      <section className="app-panel" data-reviewer-viewer-empty style={{ minWidth: 0 }}>
        <OperationalEmptyState
          kicker="Reviewer workspace"
          title="No active review is assigned to you right now."
          reason={`This page centers on your current assignment. Workspace activity can still exist outside your slot: ${workspace.queues.unassigned} unassigned, ${workspace.queues.escalated} escalated, and ${workspace.queues.qc} QC-linked items are visible from the surrounding review surfaces.`}
          actions={[
            { label: "Open reviewer queues", href: "/review/queues?queue=MY_REVIEWS" },
            {
              label: "View unassigned reviews",
              href: "/review/queues?queue=UNASSIGNED",
            },
            { label: "Review SLA pressure", href: "/reviewer-ops/sla" },
            { label: "Open evidence to create workflows", href: "/evidence" },
          ]}
          emptyStateCode="reviewer_workspace_no_active_review"
        />
      </section>
    );
  }
  return (
    <section
      data-reviewer-viewer
      data-reviewer-workflow-id={workflowId}
      data-reviewer-evidence-id={evidenceId}
      className="app-panel"
      style={{
        padding: 8,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        minWidth: 0,
        gap: 8,
      }}
    >
      <header
        className="app-panel__head-row"
        style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8, padding: "2px 4px" }}
      >
        <h2 className="app-panel__title">Active evidence</h2>
        <a href={`/evidence/${evidenceId}`} className="app-ghost-action">
          Open full evidence ↗
        </a>
      </header>
      <MediaViewer
        evidenceId={evidenceId}
        src={preview?.previewUrl ?? null}
        mimeType={preview?.mimeType ?? null}
        annotations={annotations}
      />
    </section>
  );
}

/**
 * PHASE 1 — Honest "no active evidence" state for the EVIDENCE / OCR /
 * TRANSCRIPT / REPORT side-panes. The wired side-pane components
 * require an `activeEvidenceId`; when the reviewer has no active
 * review (queue rail empty / picker pending), we render this card
 * instead of issuing a request that would 404. The body matches the
 * tab so operators know why the data is missing.
 */
function SidePaneNoEvidence({
  mode,
}: {
  mode: "EVIDENCE" | "OCR" | "TRANSCRIPT" | "REPORT";
}) {
  const copy =
    mode === "EVIDENCE"
      ? "Pick an item from the queue rail to load the evidence summary."
      : mode === "OCR"
        ? "Pick an item from the queue rail to load OCR projection."
        : mode === "TRANSCRIPT"
          ? "Pick an item from the queue rail to load transcript projection."
          : "Pick an item from the queue rail to load report status.";
  return (
    <section
      data-side-pane-no-evidence={mode}
      className="app-panel"
    >
      <p className="app-panel__body app-field-help" style={{ margin: 0 }}>
        <strong>{mode}</strong> pane. {copy}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Cycle side-pane via bracket keys (no editable target).
// ---------------------------------------------------------------------------

function CycleSidePaneHandler({ onCycle }: { onCycle: (dir: 1 | -1) => void }) {
  useEffect(() => {
    function isEditable(t: EventTarget | null): boolean {
      if (!t || !(t instanceof HTMLElement)) return false;
      const tag = t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (t.isContentEditable) return true;
      return false;
    }
    function onKey(e: KeyboardEvent) {
      if (isEditable(e.target)) return;
      if (e.key === "]") {
        e.preventDefault();
        onCycle(1);
      } else if (e.key === "[") {
        e.preventDefault();
        onCycle(-1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCycle]);
  return null;
}

// ---------------------------------------------------------------------------
// Help overlay
// ---------------------------------------------------------------------------

function HelpOverlay({
  onClose,
  hotkeys,
}: {
  onClose: () => void;
  hotkeys: ReadonlyArray<{ code: string; key: string }>;
}) {
  return (
    // TEAM-UI-SPEC §1 — the canonical Modal (focus trap, Escape, restore
    // focus) with a secondary Close in its footer, not an ad-hoc overlay.
    <Modal
      open
      title="Reviewer hotkeys"
      onClose={onClose}
      testid="reviewer-help-overlay"
      footer={
        <button type="button" className="app-secondary-action" onClick={onClose}>
          Close
        </button>
      }
    >
      <div data-reviewer-help-overlay>
        <p className="app-field-help" style={{ marginTop: 0 }}>
          Press <kbd>?</kbd> to close. Hotkeys never fire inside input
          fields.
        </p>
        <table className="app-table">
          <tbody>
            {hotkeys.map((b) => (
              <tr key={b.code}>
                <td>
                  <kbd>{b.key}</kbd>
                </td>
                <td>{reviewerHotkeyLabel(b.code)}</td>
              </tr>
            ))}
            <tr>
              <td>
                <kbd>[ ]</kbd>
              </td>
              <td>{reviewerHotkeyLabel("CYCLE_SIDE_PANE")}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Ribbon
// ---------------------------------------------------------------------------

function WorkspaceRibbon({
  workspace,
  statusBanner,
}: {
  workspace: ReviewerWorkspaceProjection;
  statusBanner: string | null;
}) {
  return (
    // TEAM-UI-SPEC §1 — status reads as `app-chip`s on an `app-panel`, not a
    // dark ad-hoc band with its own palette.
    <section
      data-reviewer-ribbon
      className="app-panel"
      aria-label="Workspace counts"
    >
      <div
        className="app-panel__body"
        style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
      >
      <Pill label={`Role: ${reviewerRoleLabel(workspace.role)}`} />
      {/* T-052 / T-053 (stage C) — review counts from the shared definitions,
          labelled with their unit; they equal the Inbox slices they name. */}
      <Pill label={`My reviews ${workspace.queues.assigned}`} />
      <Pill label={`Unassigned reviews ${workspace.queues.unassigned}`} />
      <Pill label={`In progress ${workspace.queues.in_progress}`} />
      <Pill label={`Escalated reviews ${workspace.queues.escalated}`} tone="warn" />
      <Pill label={`QC awaiting verdict ${workspace.queues.qc}`} />
      <Pill label={`Disagreements ${workspace.disagreements.awaitingAdjudication}`} />
      <Pill label={`7d throughput ${workspace.metrics.throughput7d}`} />
      <Pill label={`Approval ${pctOrNoData(workspace.metrics.approvalRate7dPct)}`} />
      <Pill label={`Escalation ${pctOrNoData(workspace.metrics.escalationRate7dPct)}`} />
      {statusBanner ? (
        <p data-reviewer-status-banner role="status" className="app-field-help" style={{ margin: 0, flexBasis: "100%" }}>
          {statusBanner}
        </p>
      ) : null}
      </div>
    </section>
  );
}

function Pill({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "neutral" | "warn";
}) {
  return (
    <span
      data-reviewer-pill={tone}
      className={tone === "warn" ? "app-chip app-chip--warn" : "app-chip"}
    >
      {label}
    </span>
  );
}

function QueueRail({ workspace }: { workspace: ReviewerWorkspaceProjection }) {
  return (
    <aside
      data-reviewer-queue-rail
      className="app-panel"
      style={{
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        minWidth: 0,
      }}
    >
      <h2 className="app-panel__title">Queues</h2>
      <QueueLine
        label="My reviews"
        count={workspace.queues.assigned}
        href="/review/queues?queue=MY_REVIEWS"
      />
      <QueueLine
        label="Unassigned reviews"
        count={workspace.queues.unassigned}
        href="/review/queues?queue=UNASSIGNED"
      />
      <QueueLine
        label="In progress"
        count={workspace.queues.in_progress}
        href="/review/workspace"
        hint="Continue work from this page"
      />
      <QueueLine
        label="Escalated reviews"
        count={workspace.queues.escalated}
        href="/review/queues?queue=ESCALATED"
      />
      <QueueLine
        label="QC awaiting verdict"
        count={workspace.queues.qc}
        href="/review/qc"
      />
      <QueueLine
        label="Completed (7 days)"
        count={workspace.queues.completed}
        href="/review/queues?queue=COMPLETED_RECENTLY"
      />
      <p className="app-field-help" style={{ margin: "8px 0 0" }}>
        This rail shows workspace counts. Use this page to work evidence,
        reviewer queues to triage ownership, and SLA to monitor pressure.
      </p>
      <Link href="/review/schemas" className="app-ghost-action">
        Coding schemas
      </Link>
      <Link href="/review/disagreements" className="app-ghost-action">
        Disagreements
      </Link>
      {/* TEAM-SPEC §3 — metrics needs the review.assign permission (owners / admins);
          the link renders only when the page opens for this actor. */}
      <MetricsRailLink />
    </aside>
  );
}

function QueueLine({
  label,
  count,
  href,
  hint,
}: {
  label: string;
  count: number;
  href: string;
  hint?: string;
}) {
  return (
    <Link
      href={href}
      className="app-ghost-action"
      data-reviewer-queue-line={label}
      style={{
        justifyContent: "space-between",
        flexWrap: "wrap",
        height: "auto",
        minHeight: 32,
      }}
    >
      <span>{label}</span>
      <strong>{count}</strong>
      {hint ? (
        <span className="app-table__muted" style={{ width: "100%" }}>
          {hint}
        </span>
      ) : null}
    </Link>
  );
}

function WorkflowSummaryCard({
  summary,
  codingSchemaId,
}: {
  summary: ReviewerOpsWorkspaceSummary;
  codingSchemaId: string | null;
}) {
  const projection = summary.projection;
  // T-048 (stage C) — the governing deadline is the earliest one still open
  // (the same helper as the Review page header), never a completed one.
  const governing = governingDeadlineText(projection.slaDimensions);
  const escalationText = summary.openEscalation
    ? escalationSummaryText(summary.openEscalation.severity, summary.activeEscalationCount)
    : null;
  return (
    <section
      data-reviewer-workspace-summary
      className="app-panel"
    >
      <div className="app-panel__body" style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <h2 className="app-panel__title">Current assignment</h2>
          <span className="app-field-help">
            Workflow {shortId(projection.workflowId)} linked to evidence{" "}
            {shortId(projection.evidenceId)}.
          </span>
        </div>
        <Link href={`/reviewer-ops/${projection.workflowId}`} className="app-ghost-action">
          Open full inspector
        </Link>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(140px, 100%), 1fr))",
          gap: 8,
        }}
      >
        <SummaryCell
          label="Lifecycle"
          value={projection.lifecycleState.replace(/_/g, " ")}
        />
        <SummaryCell label="Priority" value={projection.priority} />
        <SummaryCell label="Deadline" value={governing.text} />
        <SummaryCell label="Escalation" value={escalationText ?? "None active"} />
        <SummaryCell
          label="Coding schema"
          value={codingSchemaId ? "Bound and ready" : "No schema bound"}
        />
        <SummaryCell
          label="QC eligibility"
          value="Eligible after approve or reject closes the workflow"
        />
      </div>
      <p className="app-field-help" style={{ margin: 0 }}>
        {projection.assignedAtUtc ? (
          <>
            Assigned {formatRelativeTime(projection.assignedAtUtc)}.{" "}
          </>
        ) : null}
        <span data-reviewer-next-checkpoint>
          {governing.kind === "none"
            ? "No deadline is set on this review."
            : governing.kind === "all_met"
              ? `${governing.text}.`
              : `Next deadline: ${governing.text}.`}
        </span>{" "}
        {summary.openEscalation
          ? `${escalationText ?? "Active escalation"}: ${identifierLabel(summary.openEscalation.reason)}.`
          : "No escalation is active."}
      </p>
      </div>
    </section>
  );
}

function WorkspaceGuidanceCard() {
  return (
    <section
      data-reviewer-workspace-guidance
      className="app-panel"
    >
      <div className="app-panel__body" style={{ display: "grid", gap: 10 }}>
      <div>
        <h2 className="app-panel__title">How to use this page</h2>
        <span className="app-field-help">
          This is the daily evidence decision surface. When no review is active,
          claim or inspect work from reviewer queues, check SLA pressure, or
          open evidence to start a real workflow through existing evidence
          actions.
        </span>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Link href="/review/queues?queue=MY_REVIEWS" className="app-secondary-action">
          Open my queue
        </Link>
        <Link href="/review/queues?queue=UNASSIGNED" className="app-ghost-action">
          View unassigned
        </Link>
        <Link href="/reviewer-ops/sla" className="app-ghost-action">
          Review SLA pressure
        </Link>
        <Link href="/evidence" className="app-ghost-action">
          Open evidence
        </Link>
      </div>
      </div>
    </section>
  );
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "grid", gap: 1, minWidth: 0 }}>
      <span className="app-table__muted">{label}</span>
      <span className="app-table__primary">{value}</span>
    </div>
  );
}

function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}

function formatRelativeTime(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  const abs = Math.abs(ms);
  const hours = Math.round(abs / 3_600_000);
  if (hours < 24) return `${hours}h ${ms <= 0 ? "ago" : "from now"}`;
  const days = Math.round(hours / 24);
  return `${days}d ${ms <= 0 ? "ago" : "from now"}`;
}


// Phase 2A Closure — legacy EvidenceViewer replaced by
// EvidenceViewerColumn + MediaViewer; the old function is removed.

// Team remediation T-001 — the inline reason form (which dropped the typed
// reason before the server answered) is gone: every verdict and escalation is
// entered in the shared decision panel and Escalate dialog (FocusDecisionColumn).

// ---------------------------------------------------------------------------
// PHASE 2 — Inline Disagree form.
//
// The canonical /v1/reviewer/work/:wf/disagree route requires a real
// `originalDecisionId` (uuid) plus a rationale (min 1, max 600 chars).
// We surface a real decision picker populated from
// /v1/reviewer-ops/workspace/:wf/decisions instead of a free-text
// prompt — selecting an arbitrary id would fail with
// DISAGREEMENT_NOT_FOUND.
//
// Phases:
//   LOADING  — decisions fetch in flight (Submit disabled).
//   READY    — decisions returned; operator picks one + types rationale.
//   EMPTY    — no decisions on file yet; Submit disabled with explicit
//              "no prior decision on file" copy.
//   ERROR    — decisions fetch failed; Submit disabled with retry copy.
// ---------------------------------------------------------------------------

function DisagreeForm({
  state,
  busy,
  onSubmit,
  onCancel,
}: {
  state:
    | { phase: "LOADING" }
    | { phase: "READY"; decisions: WorkflowDecisionRow[] }
    | { phase: "EMPTY" }
    | { phase: "ERROR" };
  busy: boolean;
  onSubmit: (input: { originalDecisionId: string; rationale: string }) => void;
  onCancel: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string>("");
  const [rationale, setRationale] = useState<string>("");
  const trimmed = rationale.trim();
  const maxLen = 600;
  const tooLong = trimmed.length > maxLen;
  const canSubmit =
    state.phase === "READY" &&
    selectedId.length > 0 &&
    trimmed.length > 0 &&
    !tooLong &&
    !busy;

  return (
    <section
      data-reviewer-disagree-form
      data-reviewer-disagree-phase={state.phase}
      className="app-panel"
      aria-label="File a disagreement"
    >
      <div className="app-panel__body" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <h2 className="app-panel__title">File a disagreement</h2>
      {state.phase === "LOADING" ? (
        <p
          data-reviewer-disagree-loading
          role="status"
          className="app-field-help"
          style={{ margin: 0 }}
        >
          Loading prior decisions…
        </p>
      ) : null}
      {state.phase === "EMPTY" ? (
        <p
          data-reviewer-disagree-empty
          className="app-field-help"
          style={{ margin: 0 }}
        >
          No prior decision on file — disagree is only available after a
          decision is recorded.
        </p>
      ) : null}
      {state.phase === "ERROR" ? (
        <p
          data-reviewer-disagree-error
          role="alert"
          className="app-field-error"
          style={{ margin: 0 }}
        >
          Could not load prior decisions — please retry.
        </p>
      ) : null}
      {state.phase === "READY" ? (
        <>
          <label
            htmlFor="reviewer-disagree-decision-select"
            className="app-field-label"
          >
            Which decision are you challenging?
          </label>
          <AppListbox
            id="reviewer-disagree-decision-select"
            value={selectedId}
            placeholder="Select a recorded decision…"
            options={state.decisions.map((d) => {
              const who =
                d.reviewer.displayName ||
                d.reviewer.email ||
                d.reviewer.userId.slice(0, 8) + "…";
              const when = (() => {
                try {
                  return formatUserDateTime(d.decidedAt);
                } catch {
                  return d.decidedAt;
                }
              })();
              return {
                value: d.id,
                label: `${identifierLabel(d.stage)} · ${identifierLabel(d.decision)} · ${who} · ${when}`,
              };
            })}
            onChange={setSelectedId}
            triggerProps={{ "data-reviewer-disagree-decision-select": "" }}
          />
          <label
            htmlFor="reviewer-disagree-rationale"
            className="app-field-label"
          >
            Rationale (required, ≤ {maxLen} chars)
          </label>
          <textarea
            id="reviewer-disagree-rationale"
            data-reviewer-disagree-rationale
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            rows={4}
            placeholder="Briefly explain why you challenge this decision."
            className="app-input"
            style={{ resize: "vertical" }}
            autoFocus
          />
        </>
      ) : null}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {state.phase === "READY" ? (
          <span className={tooLong ? "app-field-error" : "app-field-help"} style={{ margin: 0 }}>
            {trimmed.length}/{maxLen}
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        <CanonicalActionButton
          variant="secondary"
          data-reviewer-disagree-cancel
          onClick={onCancel}
        >
          Cancel
        </CanonicalActionButton>
        <CanonicalActionButton
          variant="primary"
          data-reviewer-disagree-submit
          disabled={!canSubmit}
          aria-busy={busy || undefined}
          disabledReason={
            busy
              ? null
              : state.phase === "LOADING"
                ? "Prior decisions are still loading."
                : state.phase === "EMPTY"
                  ? "No prior decision is on file to challenge."
                  : state.phase === "ERROR"
                    ? "Prior decisions could not be loaded."
                    : selectedId.length === 0
                      ? "Choose the decision you challenge."
                      : tooLong
                        ? `Keep the rationale to ${maxLen} characters.`
                        : "Write a rationale first."
          }
          onClick={() =>
            onSubmit({ originalDecisionId: selectedId, rationale: trimmed })
          }
        >
          File disagreement
        </CanonicalActionButton>
      </div>
      </div>
    </section>
  );
}

/**
 * Team remediation T-001 / T-005 — the bar keeps Disagree and the hotkey list.
 * Verdicts are no longer buttons here: they are entered in the shared decision
 * panel, whose controls are opened by the server's viewer.actions (the keys
 * a / r / i focus it with that choice; e opens the shared Escalate dialog).
 */
function DecisionBar({
  capabilities,
  onDisagree,
  hotkeys,
  disabled = false,
}: {
  capabilities: Set<ReviewerCapability>;
  onDisagree: () => void;
  hotkeys: ReadonlyArray<{ code: string; key: string }>;
  disabled?: boolean;
}) {
  const canDisagree = capabilities.has("review.disagree") && !disabled;
  const disagreeReason = disabled
    ? "Finish or cancel the open form first."
    : "Your reviewer role cannot file disagreements here.";
  return (
    <section data-reviewer-decision-bar className="app-panel" aria-label="More actions">
      <div className="app-panel__body" style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <DecisionBtn
          label="Disagree"
          hotkey=""
          tone="secondary"
          disabled={!canDisagree}
          disabledReason={disagreeReason}
          onClick={onDisagree}
        />
        <span style={{ flex: 1 }} />
        <details>
          <summary className="app-ghost-action" style={{ display: "inline-flex" }}>
            Hotkeys
          </summary>
          <ul className="app-field-help" style={{ margin: 6, padding: 0, listStyle: "none" }}>
            {hotkeys.map((b) => (
              <li key={b.code} style={{ display: "flex", gap: 8 }}>
                <kbd>{b.key}</kbd>
                <span>{reviewerHotkeyLabel(b.code)}</span>
              </li>
            ))}
          </ul>
        </details>
      </div>
    </section>
  );
}

function DecisionBtn({
  label,
  hotkey,
  tone,
  disabled,
  disabledReason,
  onClick,
}: {
  label: string;
  hotkey: string;
  tone: "primary" | "secondary";
  disabled: boolean;
  disabledReason?: string;
  onClick: () => void;
}) {
  return (
    <CanonicalActionButton
      variant={tone}
      disabled={disabled}
      disabledReason={disabledReason}
      onClick={onClick}
      data-reviewer-decision={label}
    >
      {label}
      {hotkey ? (
        <>
          {" "}
          <kbd aria-hidden="true">{hotkey}</kbd>
        </>
      ) : null}
    </CanonicalActionButton>
  );
}

function MetricsRailLink() {
  const destination = useReviewDestination("workspace.review_metrics", { label: "Metrics" });
  if (!destination || destination.kind !== "link") return null;
  return (
    <Link href={destination.href} className="app-ghost-action">
      Metrics
    </Link>
  );
}
