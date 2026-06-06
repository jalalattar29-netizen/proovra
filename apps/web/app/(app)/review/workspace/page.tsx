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

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

import {
  REVIEWER_DEFAULT_HOTKEYS,
  type ReviewerCapability,
  type ReviewerWorkspaceProjection,
} from "@proovra/shared";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { OperationalEmptyState } from "../../../../components/operational";

import { CodingPanel } from "../../../../components/reviewer-workspace/CodingPanel";
import { useReviewerHotkeys } from "../../../../lib/reviewer-workspace/reviewer-hotkeys";
import {
  approveReview,
  createEscalation,
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
  rejectReview,
  requestInfoReview,
  type CodingFieldRow,
  type CodingValueRow,
  type EvidenceArtifactsResult,
  type EvidencePreviewMeta,
  type EvidenceSidePaneResult,
  type ExtractedTextsResult,
  type LifecycleCallResult,
  type ReviewerOpsWorkspaceSummary,
  type WorkflowDecisionRow,
  writeCodingValue,
} from "../../../../lib/reviewer-workspace/reviewer-api";
import { useActiveSpace } from "../../../../lib/platform-context";
import { useActiveSpaceId } from "../../../../lib/platform-context";
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
  const canRequestRedaction =
    roleLabel === "OWNER" ||
    roleLabel === "ADMIN" ||
    roleLabel === "MEMBER" ||
    roleLabel === "Owner";
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
  // Phase 1 lifecycle wiring — bounded inline form replacing window.prompt
  // for actions that require operator-supplied reason text (reject /
  // request-info / escalate). The form is rendered inline above the
  // decision bar; nothing fancy, just enough to capture a typed reason
  // and submit it through the canonical reviewer-ops endpoints.
  const [reasonForm, setReasonForm] = useState<{
    kind: "REJECT" | "NEEDS_INFO" | "ESCALATE";
  } | null>(null);
  // Inflight guard so double-clicks / repeat hotkey presses cannot
  // double-fire a lifecycle transition while one is already in flight.
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
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
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingWorkspace(true);
      const ws = await fetchReviewerWorkspace();
      if (cancelled) return;
      setWorkspace(ws);
      if (ws?.activeReview) {
        setActiveWorkflowId(ws.activeReview.workflowId);
        setActiveEvidenceId(ws.activeReview.evidenceId);
      }
      setLoadingWorkspace(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
  }, [activeWorkflowId, teamId]);

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
        fetchSchema(schemaId),
        fetchCodingState(activeWorkflowId),
      ]);
      if (cancelled) return;
      setFields(schema?.fields ?? []);
      setValues(state.values);
      setUnfulfilled(new Set(state.coverage.unfulfilledFieldIds));
    })();
    return () => {
      cancelled = true;
    };
  }, [activeWorkflowId, workspace?.activeReview?.codingSchemaId]);

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
      });
      if (res.ok) {
        // Re-pull coding state for fresh coverage.
        const state = await fetchCodingState(activeWorkflowId);
        setValues(state.values);
        setUnfulfilled(new Set(state.coverage.unfulfilledFieldIds));
      } else {
        setStatusBanner(`Coding refused: ${res.denial}`);
      }
    },
    [activeWorkflowId],
  );

  // Phase 2A Closure — auto-advance to the next assigned workflow
  // after the reviewer records a decision. Pulls the workspace
  // projection again and picks the active review pointer.
  const advanceToNext = useCallback(async () => {
    const ws = await fetchReviewerWorkspace();
    setWorkspace(ws);
    if (ws?.activeReview) {
      setActiveWorkflowId(ws.activeReview.workflowId);
      setActiveEvidenceId(ws.activeReview.evidenceId);
    } else {
      setActiveWorkflowId(null);
      setActiveEvidenceId(null);
    }
  }, []);

  // PHASE 1 — Lifecycle wiring.
  //
  // The Reviewer Workspace MUST actually close the workflow, not just
  // record a CodingValue. Order of operations (per the partial-failure
  // hard rule):
  //
  //   1. Persist the REVIEWER_VERDICT coding value (current behavior,
  //      best-effort — if no verdict field exists on the schema, skip
  //      this step and proceed with the lifecycle call. The lifecycle
  //      endpoints are the source of truth for workflow state.).
  //   2. Call the canonical reviewer-ops lifecycle endpoint.
  //   3. On lifecycle FAILURE: surface a clear partial-failure banner
  //      and DO NOT advance. Operator must retry.
  //   4. On lifecycle SUCCESS: refresh workspace projection and
  //      advance to the next assigned workflow.
  //
  // Every lifecycle call site is wrapped in try/catch via the helper's
  // own classifyLifecycleError + structured warn log here.
  const runLifecycle = useCallback(
    async (
      kind: "APPROVE" | "REJECT" | "NEEDS_INFO" | "ESCALATE",
      reason: string | null,
    ) => {
      if (!activeWorkflowId) return;
      if (!teamId) {
        setStatusBanner(
          "No active workspace — switch to a team workspace before deciding.",
        );
        return;
      }
      if (lifecycleBusy) return;
      setLifecycleBusy(true);

      // 1. Best-effort coding-value write. The coding value is a
      // reviewer-coverage artifact; the workflow lifecycle is the
      // source of truth for state transitions, so a missing verdict
      // field on the schema is NOT a blocker for the lifecycle call.
      const verdictField = fields.find(
        (f) => f.fieldType === "REVIEWER_VERDICT",
      );
      if (verdictField) {
        try {
          await onWrite({
            fieldId: verdictField.id,
            value: { verdict: kind },
            rationale: reason ?? undefined,
          });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            "[reviewer-workspace] verdict coding-value write threw",
            { kind, workflowId: activeWorkflowId, err },
          );
        }
      }

      // 2. Call the canonical lifecycle endpoint.
      let res: LifecycleCallResult;
      try {
        if (kind === "APPROVE") {
          res = await approveReview({
            workflowId: activeWorkflowId,
            teamId,
            note: reason ?? null,
          });
        } else if (kind === "REJECT") {
          res = await rejectReview({
            workflowId: activeWorkflowId,
            teamId,
            reason: reason ?? "",
          });
        } else if (kind === "NEEDS_INFO") {
          res = await requestInfoReview({
            workflowId: activeWorkflowId,
            teamId,
            message: reason ?? "",
          });
        } else {
          res = await createEscalation({
            workflowId: activeWorkflowId,
            teamId,
            reason: "WORKFLOW_STALLED",
            safeSummary: reason ?? "",
            severity: "WARNING",
          });
        }
      } catch (err) {
        // The helpers swallow API errors into a tagged failure, but a
        // network exception could still escape. Surface it explicitly
        // and DO NOT advance.
        // eslint-disable-next-line no-console
        console.warn("[reviewer-workspace] lifecycle call threw", {
          kind,
          workflowId: activeWorkflowId,
          err,
        });
        setStatusBanner(
          "Decision recorded but workflow not closed — please retry.",
        );
        setLifecycleBusy(false);
        return;
      }

      // 3. Partial failure → keep operator on the same item.
      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.warn("[reviewer-workspace] lifecycle endpoint denied", {
          kind,
          workflowId: activeWorkflowId,
          status: res.status,
          code: res.code,
        });
        setStatusBanner(
          `Decision recorded but workflow not closed (${res.code}) — please retry.`,
        );
        setLifecycleBusy(false);
        return;
      }

      // 4. Success → refresh + advance.
      setStatusBanner(`Workflow ${kind.toLowerCase()} recorded.`);
      setLifecycleBusy(false);
      await advanceToNext();
    },
    [
      activeWorkflowId,
      advanceToNext,
      fields,
      lifecycleBusy,
      onWrite,
      teamId,
    ],
  );

  // Decision entry point. APPROVE has no required reason and fires
  // immediately. REJECT / NEEDS_INFO / ESCALATE require a typed reason
  // — we open an inline form (NOT window.prompt, per Phase 1 UX rule)
  // and submit through runLifecycle from the form handler.
  const onDecision = useCallback(
    (kind: "APPROVE" | "REJECT" | "ESCALATE" | "NEEDS_INFO") => {
      if (!activeWorkflowId) return;
      if (kind === "APPROVE") {
        void runLifecycle("APPROVE", null);
        return;
      }
      setReasonForm({ kind });
    },
    [activeWorkflowId, runLifecycle],
  );

  const submitReasonForm = useCallback(
    (reason: string) => {
      if (!reasonForm) return;
      const kind = reasonForm.kind;
      setReasonForm(null);
      void runLifecycle(kind, reason);
    },
    [reasonForm, runLifecycle],
  );
  const cancelReasonForm = useCallback(() => {
    setReasonForm(null);
  }, []);

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
        "No active workspace — switch to a team workspace before filing a disagreement.",
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
            const ws = await fetchReviewerWorkspace();
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
          setStatusBanner(`Disagreement refused: ${res.denial}`);
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
    [activeWorkflowId, disagreeBusy],
  );

  // Cycle through side-pane modes (`]` forward, `[` backward).
  const cycleSidePane = useCallback((dir: 1 | -1) => {
    const idx = SIDE_PANE_MODES.indexOf(sidePaneMode);
    const next = SIDE_PANE_MODES[
      (idx + dir + SIDE_PANE_MODES.length) % SIDE_PANE_MODES.length
    ] as SidePaneMode;
    setSidePaneMode(next);
  }, [sidePaneMode]);

  const hotkeys = useReviewerHotkeys(
    useMemo(
      () => ({
        // Phase 1: lifecycle wiring is the source of truth. onDecision
        // either opens the reason form (REJECT / ESCALATE / NEEDS_INFO)
        // or runs the APPROVE lifecycle, which advances on success.
        // Hotkeys MUST NOT pre-advance — that would mask partial failure.
        APPROVE: () => onDecision("APPROVE"),
        REJECT: () => onDecision("REJECT"),
        ESCALATE: () => onDecision("ESCALATE"),
        REQUEST_INFO: () => onDecision("NEEDS_INFO"),
        NEXT_ITEM: () => void advanceToNext(),
        TOGGLE_ANNOTATIONS: () => setSidePaneMode("ANNOTATIONS"),
        FOCUS_CODING_PANEL: () => setSidePaneMode("CODING"),
        HELP: () => setHelpOpen((o) => !o),
      }),
      [onDecision, advanceToNext],
    ),
    activeWorkflowId !== null,
  );

  if (loadingWorkspace) {
    return <div style={{ padding: 24 }}>Loading reviewer workspace…</div>;
  }

  if (!workspace) {
    return (
      <div
        style={{
          padding: 24,
          color: "#475569",
          fontSize: 14,
          lineHeight: 1.55,
        }}
      >
        <strong>You do not have a reviewer role in this workspace.</strong>{" "}
        Ask a workspace admin to invite you as a Reviewer or above.
      </div>
    );
  }

  const capabilities = new Set<ReviewerCapability>(workspace.capabilities);

  return (
    <div
      data-reviewer-workspace
      data-reviewer-role={workspace.role}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: "calc(100vh - 64px)",
        background: "#fafafa",
      }}
    >
      <WorkspaceRibbon workspace={workspace} statusBanner={statusBanner} />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(180px, 220px) 1fr minmax(320px, 380px)",
          gap: 12,
          padding: 12,
          flex: 1,
          minHeight: 0,
        }}
      >
        <QueueRail workspace={workspace} />

        <EvidenceViewerColumn
          workflowId={activeWorkflowId}
          evidenceId={activeEvidenceId}
          preview={preview}
          annotations={annotations}
          workspace={workspace}
        />

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {activeWorkflowSummary ? (
            <WorkflowSummaryCard
              summary={activeWorkflowSummary}
              codingSchemaId={workspace.activeReview?.codingSchemaId ?? null}
            />
          ) : (
            <WorkspaceGuidanceCard />
          )}
          <DecisionBar
            capabilities={capabilities}
            disabled={
              lifecycleBusy || reasonForm !== null || disagreeForm !== null
            }
            onDecision={onDecision}
            onDisagree={() => {
              void openDisagreeForm();
            }}
            hotkeys={hotkeys}
          />
          {reasonForm ? (
            <ReasonForm
              kind={reasonForm.kind}
              onSubmit={submitReasonForm}
              onCancel={cancelReasonForm}
            />
          ) : null}
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
    </div>
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
      <div
        data-reviewer-viewer-empty
        style={{
          background: "#fff",
          border: "1px solid rgba(15, 23, 42, 0.08)",
          borderRadius: 12,
          padding: 18,
        }}
      >
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
      </div>
    );
  }
  return (
    <section
      data-reviewer-viewer
      data-reviewer-workflow-id={workflowId}
      data-reviewer-evidence-id={evidenceId}
      style={{
        background: "#fff",
        border: "1px solid rgba(15, 23, 42, 0.08)",
        borderRadius: 12,
        padding: 8,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        gap: 8,
      }}
    >
      <header
        style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}
      >
        <strong>Active evidence</strong>
        <a
          href={`/evidence/${evidenceId}`}
          style={{ color: "#0f172a", textDecoration: "underline" }}
        >
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
      style={{
        background: "rgba(15, 23, 42, 0.03)",
        border: "1px dashed rgba(15, 23, 42, 0.18)",
        borderRadius: 12,
        padding: 12,
        color: "#475569",
        fontSize: 12,
        lineHeight: 1.55,
      }}
    >
      <strong>{mode}</strong> pane. {copy}
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
    <div
      data-reviewer-help-overlay
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff",
          borderRadius: 12,
          padding: 20,
          maxWidth: 480,
          fontSize: 13,
          lineHeight: 1.55,
        }}
      >
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Reviewer hotkeys</h2>
        <p style={{ color: "#475569", fontSize: 12 }}>
          Press <kbd>?</kbd> to close. Hotkeys never fire inside input
          fields.
        </p>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            {hotkeys.map((b) => (
              <tr key={b.code}>
                <td style={{ padding: "3px 6px", color: "#0f172a" }}>
                  <kbd
                    style={{
                      background: "#f1f5f9",
                      padding: "1px 6px",
                      borderRadius: 4,
                    }}
                  >
                    {b.key}
                  </kbd>
                </td>
                <td style={{ padding: "3px 6px", color: "#475569" }}>{b.code}</td>
              </tr>
            ))}
            <tr>
              <td style={{ padding: "3px 6px" }}>
                <kbd
                  style={{
                    background: "#f1f5f9",
                    padding: "1px 6px",
                    borderRadius: 4,
                  }}
                >
                  [ ]
                </kbd>
              </td>
              <td style={{ padding: "3px 6px", color: "#475569" }}>
                CYCLE_SIDE_PANE
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
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
    <header
      data-reviewer-ribbon
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 16px",
        background: "#0f172a",
        color: "#fafafa",
        fontSize: 12,
      }}
    >
      <strong style={{ fontSize: 13 }}>Reviewer Workspace</strong>
      <Pill label={`Role: ${workspace.role}`} />
      <Pill label={`Assigned ${workspace.queues.assigned}`} />
      <Pill label={`Unassigned ${workspace.queues.unassigned}`} />
      <Pill label={`In progress ${workspace.queues.in_progress}`} />
      <Pill label={`Escalated ${workspace.queues.escalated}`} tone="warn" />
      <Pill label={`QC ${workspace.queues.qc}`} />
      <Pill label={`Disagreements ${workspace.disagreements.awaitingAdjudication}`} />
      <div style={{ flex: 1 }} />
      <Pill label={`7d throughput ${workspace.metrics.throughput7d}`} />
      <Pill label={`Approval ${workspace.metrics.approvalRate7dPct}%`} />
      <Pill label={`Escalation ${workspace.metrics.escalationRate7dPct}%`} />
      {statusBanner ? (
        <div
          data-reviewer-status-banner
          style={{
            background: "#1e293b",
            padding: "4px 10px",
            borderRadius: 999,
            border: "1px solid rgba(255,255,255,0.16)",
          }}
        >
          {statusBanner}
        </div>
      ) : null}
    </header>
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
      style={{
        padding: "3px 8px",
        borderRadius: 999,
        background:
          tone === "warn"
            ? "rgba(245, 158, 11, 0.2)"
            : "rgba(255, 255, 255, 0.08)",
        border:
          tone === "warn"
            ? "1px solid rgba(245, 158, 11, 0.45)"
            : "1px solid rgba(255, 255, 255, 0.16)",
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      {label}
    </span>
  );
}

function QueueRail({ workspace }: { workspace: ReviewerWorkspaceProjection }) {
  return (
    <aside
      data-reviewer-queue-rail
      style={{
        background: "#fff",
        border: "1px solid rgba(15, 23, 42, 0.08)",
        borderRadius: 12,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <strong style={{ fontSize: 12, color: "#0f172a" }}>Queues</strong>
      <QueueLine
        label="Assigned (mine)"
        count={workspace.queues.assigned}
        href="/review/queues?queue=MY_REVIEWS"
      />
      <QueueLine
        label="Unassigned"
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
        label="Escalated"
        count={workspace.queues.escalated}
        href="/review/queues?queue=ESCALATED"
      />
      <QueueLine
        label="QC"
        count={workspace.queues.qc}
        href="/review/qc"
      />
      <QueueLine
        label="Completed"
        count={workspace.queues.completed}
        href="/review/queues?queue=COMPLETED_RECENTLY"
      />
      <div
        style={{
          marginTop: 8,
          paddingTop: 8,
          borderTop: "1px solid rgba(15, 23, 42, 0.08)",
          color: "#475569",
          fontSize: 11,
          lineHeight: 1.5,
        }}
      >
        This rail shows workspace counts. Use this page to work evidence,
        reviewer queues to triage ownership, and SLA to monitor pressure.
      </div>
      <Link
        href="/review/schemas"
        style={{
          fontSize: 11,
          color: "#0f172a",
          marginTop: 8,
          textDecoration: "underline",
        }}
      >
        Coding schemas
      </Link>
      <Link
        href="/review/disagreements"
        style={{ fontSize: 11, color: "#0f172a", textDecoration: "underline" }}
      >
        Disagreements
      </Link>
      <Link
        href="/review/metrics"
        style={{ fontSize: 11, color: "#0f172a", textDecoration: "underline" }}
      >
        Metrics
      </Link>
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
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        flexWrap: "wrap",
        fontSize: 12,
        color: "#0f172a",
        padding: "4px 6px",
        borderRadius: 6,
        background: "rgba(15, 23, 42, 0.03)",
        textDecoration: "none",
      }}
    >
      <span>{label}</span>
      <strong>{count}</strong>
      {hint ? (
        <span
          style={{
            width: "100%",
            color: "#64748b",
            fontSize: 10,
            marginTop: 2,
          }}
        >
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
  const nextDue = projection.slaDimensions.find((d) => d.dueAtUtc !== null) ?? null;
  return (
    <section
      data-reviewer-workspace-summary
      style={{
        background: "#fff",
        border: "1px solid rgba(15, 23, 42, 0.08)",
        borderRadius: 12,
        padding: 12,
        display: "grid",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <div>
          <strong style={{ display: "block", fontSize: 13 }}>Current assignment</strong>
          <span style={{ color: "#475569", fontSize: 12 }}>
            Workflow {shortId(projection.workflowId)} linked to evidence{" "}
            {shortId(projection.evidenceId)}.
          </span>
        </div>
        <Link
          href={`/reviewer-ops/${projection.workflowId}`}
          style={{ color: "#0f172a", fontSize: 12, textDecoration: "underline" }}
        >
          Open full inspector
        </Link>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: 8,
          fontSize: 12,
        }}
      >
        <SummaryCell
          label="Lifecycle"
          value={projection.lifecycleState.replace(/_/g, " ")}
        />
        <SummaryCell label="Priority" value={projection.priority} />
        <SummaryCell label="SLA" value={projection.slaRollupState.replace(/_/g, " ")} />
        <SummaryCell
          label="Escalation"
          value={summary.openEscalation ? summary.openEscalation.status : "None open"}
        />
        <SummaryCell
          label="Coding schema"
          value={codingSchemaId ? "Bound and ready" : "No schema bound"}
        />
        <SummaryCell
          label="QC eligibility"
          value="Eligible after approve or reject closes the workflow"
        />
      </div>
      <div
        style={{
          background: "rgba(15, 23, 42, 0.03)",
          border: "1px dashed rgba(15, 23, 42, 0.15)",
          borderRadius: 10,
          padding: "10px 12px",
          fontSize: 12,
          color: "#475569",
          lineHeight: 1.5,
        }}
      >
        {projection.assignedAtUtc ? (
          <>
            Assigned {formatRelativeTime(projection.assignedAtUtc)}.{" "}
          </>
        ) : null}
        {nextDue?.dueAtUtc
          ? `Next SLA checkpoint: ${nextDue.dimension.toLowerCase().replace(/_/g, " ")} due ${formatRelativeTime(nextDue.dueAtUtc)}.`
          : "No due checkpoint is currently projected on this workflow."}{" "}
        {summary.openEscalation
          ? `Open escalation: ${summary.openEscalation.reason.toLowerCase().replace(/_/g, " ")} (${summary.openEscalation.severity}).`
          : "No escalation is currently open."}
      </div>
    </section>
  );
}

function WorkspaceGuidanceCard() {
  return (
    <section
      data-reviewer-workspace-guidance
      style={{
        background: "#fff",
        border: "1px solid rgba(15, 23, 42, 0.08)",
        borderRadius: 12,
        padding: 12,
        display: "grid",
        gap: 10,
      }}
    >
      <div>
        <strong style={{ display: "block", fontSize: 13 }}>How to use this page</strong>
        <span style={{ color: "#475569", fontSize: 12, lineHeight: 1.5 }}>
          This is the daily evidence decision surface. When no review is active,
          claim or inspect work from reviewer queues, check SLA pressure, or
          open evidence to start a real workflow through existing evidence
          actions.
        </span>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Link href="/review/queues?queue=MY_REVIEWS" style={summaryLinkStyle}>
          Open my queue
        </Link>
        <Link href="/review/queues?queue=UNASSIGNED" style={summaryLinkStyle}>
          View unassigned
        </Link>
        <Link href="/reviewer-ops/sla" style={summaryLinkStyle}>
          Review SLA pressure
        </Link>
        <Link href="/evidence" style={summaryLinkStyle}>
          Open evidence
        </Link>
      </div>
    </section>
  );
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        border: "1px solid rgba(15, 23, 42, 0.08)",
        borderRadius: 10,
        padding: "8px 10px",
      }}
    >
      <div style={{ color: "#64748b", fontSize: 11 }}>{label}</div>
      <div style={{ color: "#0f172a", fontWeight: 600 }}>{value}</div>
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

const summaryLinkStyle = {
  padding: "6px 10px",
  borderRadius: 999,
  border: "1px solid rgba(15, 23, 42, 0.14)",
  textDecoration: "none",
  color: "#0f172a",
  fontSize: 12,
  fontWeight: 600,
  background: "#f8fafc",
} as const;

// Phase 2A Closure — legacy EvidenceViewer replaced by
// EvidenceViewerColumn + MediaViewer; the old function is removed.

// ---------------------------------------------------------------------------
// Phase 1 lifecycle wiring — inline reason form.
//
// Replaces window.prompt for the three reason-bearing actions
// (REJECT / NEEDS_INFO / ESCALATE). Reject and request-info both
// require BoundedNote (server schema: min 1, max 1000). Escalate
// requires safeSummary (max 400). We cap the input at the tightest
// bound (400) so the same form is reusable; longer reject narratives
// would not improve workflow closure.
// ---------------------------------------------------------------------------

function ReasonForm({
  kind,
  onSubmit,
  onCancel,
}: {
  kind: "REJECT" | "NEEDS_INFO" | "ESCALATE";
  onSubmit: (reason: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const trimmed = value.trim();
  const maxLen = 400;
  const tooLong = trimmed.length > maxLen;
  const ready = trimmed.length > 0 && !tooLong;
  const title =
    kind === "REJECT"
      ? "Reject — reason required"
      : kind === "NEEDS_INFO"
        ? "Request info — message required"
        : "Escalate — summary required";
  const placeholder =
    kind === "REJECT"
      ? "Why is this workflow being rejected?"
      : kind === "NEEDS_INFO"
        ? "What additional information is needed?"
        : "Brief summary of why this is being escalated.";
  return (
    <section
      data-reviewer-reason-form={kind}
      style={{
        background: "#fff",
        border: "1px solid rgba(15, 23, 42, 0.12)",
        borderRadius: 12,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <strong style={{ fontSize: 12, color: "#0f172a" }}>{title}</strong>
      <textarea
        data-reviewer-reason-input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        rows={4}
        style={{
          fontSize: 12,
          padding: 8,
          borderRadius: 8,
          border: "1px solid rgba(15, 23, 42, 0.18)",
          resize: "vertical",
          fontFamily: "inherit",
        }}
        autoFocus
      />
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          fontSize: 11,
          color: tooLong ? "#dc2626" : "#475569",
        }}
      >
        <span>
          {trimmed.length}/{maxLen}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          data-reviewer-reason-cancel
          onClick={onCancel}
          style={{
            padding: "5px 10px",
            borderRadius: 6,
            background: "transparent",
            border: "1px solid rgba(15, 23, 42, 0.2)",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          data-reviewer-reason-submit
          disabled={!ready}
          onClick={() => onSubmit(trimmed)}
          style={{
            padding: "5px 10px",
            borderRadius: 6,
            background: ready ? "#0f172a" : "#e2e8f0",
            color: ready ? "#fafafa" : "#94a3b8",
            border: "none",
            fontSize: 12,
            fontWeight: 700,
            cursor: ready ? "pointer" : "not-allowed",
          }}
        >
          Submit
        </button>
      </div>
    </section>
  );
}

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
      style={{
        background: "#fff",
        border: "1px solid rgba(15, 23, 42, 0.12)",
        borderRadius: 12,
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <strong style={{ fontSize: 12, color: "#0f172a" }}>
        File a disagreement
      </strong>
      {state.phase === "LOADING" ? (
        <p
          data-reviewer-disagree-loading
          style={{ fontSize: 12, color: "#475569", margin: 0 }}
        >
          Loading prior decisions…
        </p>
      ) : null}
      {state.phase === "EMPTY" ? (
        <p
          data-reviewer-disagree-empty
          style={{ fontSize: 12, color: "#475569", margin: 0 }}
        >
          No prior decision on file — disagree is only available after a
          decision is recorded.
        </p>
      ) : null}
      {state.phase === "ERROR" ? (
        <p
          data-reviewer-disagree-error
          style={{ fontSize: 12, color: "#dc2626", margin: 0 }}
        >
          Could not load prior decisions — please retry.
        </p>
      ) : null}
      {state.phase === "READY" ? (
        <>
          <label
            htmlFor="reviewer-disagree-decision-select"
            style={{ fontSize: 11, color: "#475569" }}
          >
            Which decision are you challenging?
          </label>
          <select
            id="reviewer-disagree-decision-select"
            data-reviewer-disagree-decision-select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            style={{
              fontSize: 12,
              padding: 6,
              borderRadius: 6,
              border: "1px solid rgba(15, 23, 42, 0.18)",
              fontFamily: "inherit",
            }}
          >
            <option value="" disabled>
              Select a recorded decision…
            </option>
            {state.decisions.map((d) => {
              const who =
                d.reviewer.displayName ||
                d.reviewer.email ||
                d.reviewer.userId.slice(0, 8) + "…";
              const when = (() => {
                try {
                  return new Date(d.decidedAt).toLocaleString();
                } catch {
                  return d.decidedAt;
                }
              })();
              return (
                <option key={d.id} value={d.id}>
                  {d.stage} · {d.decision} · {who} · {when}
                </option>
              );
            })}
          </select>
          <label
            htmlFor="reviewer-disagree-rationale"
            style={{ fontSize: 11, color: "#475569" }}
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
            style={{
              fontSize: 12,
              padding: 8,
              borderRadius: 8,
              border: "1px solid rgba(15, 23, 42, 0.18)",
              resize: "vertical",
              fontFamily: "inherit",
            }}
            autoFocus
          />
        </>
      ) : null}
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          fontSize: 11,
          color: tooLong ? "#dc2626" : "#475569",
        }}
      >
        {state.phase === "READY" ? (
          <span>
            {trimmed.length}/{maxLen}
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          data-reviewer-disagree-cancel
          onClick={onCancel}
          style={{
            padding: "5px 10px",
            borderRadius: 6,
            background: "transparent",
            border: "1px solid rgba(15, 23, 42, 0.2)",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          data-reviewer-disagree-submit
          disabled={!canSubmit}
          onClick={() =>
            onSubmit({ originalDecisionId: selectedId, rationale: trimmed })
          }
          style={{
            padding: "5px 10px",
            borderRadius: 6,
            background: canSubmit ? "#0f172a" : "#e2e8f0",
            color: canSubmit ? "#fafafa" : "#94a3b8",
            border: "none",
            fontSize: 12,
            fontWeight: 700,
            cursor: canSubmit ? "pointer" : "not-allowed",
          }}
        >
          File disagreement
        </button>
      </div>
    </section>
  );
}

function DecisionBar({
  capabilities,
  onDecision,
  onDisagree,
  hotkeys,
  disabled = false,
}: {
  capabilities: Set<ReviewerCapability>;
  onDecision: (kind: "APPROVE" | "REJECT" | "ESCALATE" | "NEEDS_INFO") => void;
  onDisagree: () => void;
  hotkeys: ReadonlyArray<{ code: string; key: string }>;
  disabled?: boolean;
}) {
  const canDecide = capabilities.has("review.decide") && !disabled;
  const canDisagree = capabilities.has("review.disagree") && !disabled;
  return (
    <section
      data-reviewer-decision-bar
      style={{
        display: "flex",
        gap: 6,
        background: "#fff",
        border: "1px solid rgba(15, 23, 42, 0.08)",
        borderRadius: 12,
        padding: "10px 12px",
        flexWrap: "wrap",
        alignItems: "center",
      }}
    >
      <DecisionBtn
        label="Approve"
        hotkey={REVIEWER_DEFAULT_HOTKEYS.APPROVE}
        tone="ok"
        disabled={!canDecide}
        onClick={() => onDecision("APPROVE")}
      />
      <DecisionBtn
        label="Reject"
        hotkey={REVIEWER_DEFAULT_HOTKEYS.REJECT}
        tone="danger"
        disabled={!canDecide}
        onClick={() => onDecision("REJECT")}
      />
      <DecisionBtn
        label="Escalate"
        hotkey={REVIEWER_DEFAULT_HOTKEYS.ESCALATE}
        tone="warn"
        disabled={!canDecide}
        onClick={() => onDecision("ESCALATE")}
      />
      <DecisionBtn
        label="Request info"
        hotkey={REVIEWER_DEFAULT_HOTKEYS.REQUEST_INFO}
        tone="neutral"
        disabled={!canDecide}
        onClick={() => onDecision("NEEDS_INFO")}
      />
      <DecisionBtn
        label="Disagree"
        hotkey=""
        tone="neutral"
        disabled={!canDisagree}
        onClick={onDisagree}
      />
      <span style={{ flex: 1 }} />
      <details>
        <summary style={{ fontSize: 11, color: "#475569", cursor: "pointer" }}>
          Hotkeys
        </summary>
        <ul style={{ margin: 6, padding: 0, listStyle: "none", fontSize: 11 }}>
          {hotkeys.map((b) => (
            <li key={b.code} style={{ display: "flex", gap: 8 }}>
              <code
                style={{
                  background: "#f1f5f9",
                  padding: "1px 6px",
                  borderRadius: 4,
                }}
              >
                {b.key}
              </code>
              <span style={{ color: "#475569" }}>{b.code}</span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function DecisionBtn({
  label,
  hotkey,
  tone,
  disabled,
  onClick,
}: {
  label: string;
  hotkey: string;
  tone: "ok" | "warn" | "danger" | "neutral";
  disabled: boolean;
  onClick: () => void;
}) {
  const palette: Record<typeof tone, { bg: string; ink: string }> = {
    ok: { bg: "#16a34a", ink: "#fafafa" },
    warn: { bg: "#f59e0b", ink: "#0f172a" },
    danger: { bg: "#dc2626", ink: "#fafafa" },
    neutral: { bg: "#0f172a", ink: "#fafafa" },
  };
  const p = palette[tone];
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      data-reviewer-decision={label}
      style={{
        padding: "6px 12px",
        borderRadius: 8,
        border: "none",
        background: disabled ? "#e2e8f0" : p.bg,
        color: disabled ? "#94a3b8" : p.ink,
        fontSize: 12,
        fontWeight: 700,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {label}
      {hotkey ? (
        <>
          {" "}
          <kbd style={{ fontSize: 9, opacity: 0.7 }}>{hotkey}</kbd>
        </>
      ) : null}
    </button>
  );
}
