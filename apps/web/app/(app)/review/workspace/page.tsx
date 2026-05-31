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

import { CodingPanel } from "../../../../components/reviewer-workspace/CodingPanel";
import { useReviewerHotkeys } from "../../../../lib/reviewer-workspace/reviewer-hotkeys";
import {
  fetchAnnotationsForEvidence,
  fetchCodingState,
  fetchEvidencePreview,
  fetchReviewerWorkspace,
  fetchSchema,
  type CodingFieldRow,
  type CodingValueRow,
  type EvidencePreviewMeta,
  writeCodingValue,
} from "../../../../lib/reviewer-workspace/reviewer-api";
import type { ReviewerAnnotationSummary } from "../../../../lib/reviewer-workspace/annotation-types";
import { MediaViewer } from "../../../../components/reviewer-workspace/viewers/MediaViewer";
import { AnnotationPanel } from "../../../../components/reviewer-workspace/AnnotationPanel";
import {
  SidePaneSwitcher,
  SIDE_PANE_MODES,
  type SidePaneMode,
} from "../../../../components/reviewer-workspace/SidePaneSwitcher";

export default function ReviewerWorkspacePage() {
  return (
    <PageRouteGate routeId="workspace.review_workspace">
      <ReviewerWorkspaceShell />
    </PageRouteGate>
  );
}

function ReviewerWorkspaceShell() {
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
  const [sidePaneMode, setSidePaneMode] = useState<SidePaneMode>("CODING");
  const [helpOpen, setHelpOpen] = useState(false);

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

  // Hotkey handlers.
  const onDecision = useCallback(
    (kind: "APPROVE" | "REJECT" | "ESCALATE" | "NEEDS_INFO") => {
      // The decision is recorded by writing the REVIEWER_VERDICT field
      // if present on the schema; the workflow itself transitions via
      // existing review-operations routes (out of scope to re-wire
      // here). For the Phase 2A workspace, the action surfaces a
      // bounded banner + persists the verdict field when present.
      const verdictField = fields.find(
        (f) => f.fieldType === "REVIEWER_VERDICT",
      );
      if (!verdictField) {
        setStatusBanner("This schema does not include a REVIEWER_VERDICT field.");
        return;
      }
      void onWrite({
        fieldId: verdictField.id,
        value: { verdict: kind },
      });
      setStatusBanner(`Verdict recorded: ${kind}`);
    },
    [fields, onWrite],
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
        APPROVE: () => {
          onDecision("APPROVE");
          void advanceToNext();
        },
        REJECT: () => {
          onDecision("REJECT");
          void advanceToNext();
        },
        ESCALATE: () => {
          onDecision("ESCALATE");
          void advanceToNext();
        },
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
        />

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <DecisionBar
            capabilities={capabilities}
            onDecision={(kind) => {
              onDecision(kind);
              void advanceToNext();
            }}
            onDisagree={() => {
              // Inline disagree: keep the reviewer in the workspace.
              // We surface a bounded prompt; the actual file happens
              // via the existing disagreements service. The full
              // dedicated UI remains at /review/disagreements.
              const rationale = window.prompt(
                "File a disagreement. Brief rationale (≤ 600 chars):",
              );
              if (!rationale) return;
              setStatusBanner(
                `Disagreement drafted: ${rationale.slice(0, 60)}. Open the Disagreements surface to select the original decision.`,
              );
            }}
            hotkeys={hotkeys}
          />
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
          {sidePaneMode === "OCR" || sidePaneMode === "TRANSCRIPT" ||
          sidePaneMode === "EVIDENCE" || sidePaneMode === "REPORT" ? (
            <SidePaneStub mode={sidePaneMode} />
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
}: {
  workflowId: string | null;
  evidenceId: string | null;
  preview: EvidencePreviewMeta | null;
  annotations: ReviewerAnnotationSummary[];
}) {
  if (!workflowId || !evidenceId) {
    return (
      <div
        data-reviewer-viewer-empty
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#fff",
          border: "1px solid rgba(15, 23, 42, 0.08)",
          borderRadius: 12,
          color: "#475569",
          fontSize: 14,
        }}
      >
        No active review. Pick an item from the queue rail.
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

function SidePaneStub({ mode }: { mode: SidePaneMode }) {
  return (
    <section
      data-side-pane-stub={mode}
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
      <strong>{mode}</strong> pane.
      {mode === "OCR" ? " OCR text loads from the workspace search foundation when available." : null}
      {mode === "TRANSCRIPT" ? " Transcript segments load from the worker's transcript foundation when available." : null}
      {mode === "EVIDENCE" ? " Pick a second evidence item from the queue rail to compare side-by-side." : null}
      {mode === "REPORT" ? " Latest report snapshot is loaded from the existing reports aggregator." : null}
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
        href="/review/queues?state=assigned"
      />
      <QueueLine
        label="Unassigned"
        count={workspace.queues.unassigned}
        href="/review/queues?state=unassigned"
      />
      <QueueLine
        label="In progress"
        count={workspace.queues.in_progress}
        href="/review/queues?state=in_progress"
      />
      <QueueLine
        label="Escalated"
        count={workspace.queues.escalated}
        href="/review/queues?state=escalated"
      />
      <QueueLine
        label="QC"
        count={workspace.queues.qc}
        href="/review/qc"
      />
      <QueueLine
        label="Completed"
        count={workspace.queues.completed}
        href="/review/queues?state=completed"
      />
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
}: {
  label: string;
  count: number;
  href: string;
}) {
  return (
    <Link
      href={href}
      style={{
        display: "flex",
        justifyContent: "space-between",
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
    </Link>
  );
}

// Phase 2A Closure — legacy EvidenceViewer replaced by
// EvidenceViewerColumn + MediaViewer; the old function is removed.

function DecisionBar({
  capabilities,
  onDecision,
  onDisagree,
  hotkeys,
}: {
  capabilities: Set<ReviewerCapability>;
  onDecision: (kind: "APPROVE" | "REJECT" | "ESCALATE" | "NEEDS_INFO") => void;
  onDisagree: () => void;
  hotkeys: ReadonlyArray<{ code: string; key: string }>;
}) {
  const canDecide = capabilities.has("review.decide");
  const canDisagree = capabilities.has("review.disagree");
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
        hotkey="?"
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
      {label} <kbd style={{ fontSize: 9, opacity: 0.7 }}>{hotkey}</kbd>
    </button>
  );
}
