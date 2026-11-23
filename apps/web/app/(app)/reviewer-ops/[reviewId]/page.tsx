"use client";
import { PLAN_REFUSAL_COPY, isPlanRefusal } from "../../../../lib/feedback/plan-refusal";
import { AppListbox } from "../../../../components/app-primitives/AppListbox";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";

/**
 * Phase 25 — Review Workspace (single review).
 *
 * Full-page reviewer workspace surface. Loads `/workspace/:workflowId`,
 * shows lifecycle / SLA / escalation panels and the reviewer action surface.
 *
 * Actions come from the server's `viewer.actions` (who may do what now, and
 * why not); the old lifecycle-only rule is a fallback for an API that does
 * not send them. Decision copy comes from the server's `outcome`, so a FIRST
 * decision under a second-review requirement never reads as an approval.
 * After any action the workspace AND the decision lineage / notes panels
 * reload, and a lineage decision reloads the workspace.
 *
 * Wording: operator-safe only. Approvals and rejections are INTERNAL review
 * decisions. Never composes legal / forensic overclaim phrases.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useConfirmAction } from "../../../../components/ui/ConfirmActionModal";
import { useParams } from "next/navigation";

import { apiFetch } from "../../../../lib/api";
import { formatUserDateTime } from "../../../../lib/date";
import { useActiveSpaceId } from "../../../../lib/platform-context";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
// Phase G3.2 — Presence + collision wiring for the reviewer
// inspector. Mirrors the evidence detail page's presence surfacing
// so reviewers see when a peer is acting on the same workflow + when
// the workflow has moved under them.
import { PresenceIndicator } from "../../../../components/presence/PresenceIndicator";
import { CollisionWarning } from "../../../../components/presence/CollisionWarning";
import { ReviewerCopilotPanel } from "../../../../components/ai-copilot/ReviewerCopilotPanel";
import {
  ReviewerReasonModal,
  type ReviewerReasonKind,
} from "../components/ReviewerReasonModal";
// Batch J — POST /v1/reviewer/work/:workflowId/bind-schema (coding fields
// only appear once a review is bound to a published schema).
import { CodingSchemaBindingPanel } from "../components/CodingSchemaBindingPanel";
import {
  ReviewerShortcutsHelp,
  isShortcutTarget,
  useReviewerHelpHotkey,
} from "../components/ReviewerShortcutsHelp";
import {
  formatCellDateTime,
  formatRelativeDeadline,
} from "../../../../lib/date";
import { PageShell, PageHeader } from "../../../../components/ui/PageShell";
import { Card } from "../../../../components/ui/Card";
import { Badge } from "../../../../components/ui/Badge";
import { buttonSurfaceStyle } from "../../../../components/ui/Button";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { severityTone, statusTone } from "../../../../components/ui/StatusBadge";
import { identifierLabel } from "@proovra/shared";
import { escalationReasonLabel } from "../../../../lib/labels/governanceReviewLabels";
import { describeArtifactDownloadFailure } from "../../../../lib/evidence/report-download-feedback";
import { ARTIFACT_WINDOW_BLOCKED_MESSAGE, openPendingArtifactWindow } from "../../../../lib/evidence/artifact-window";
import { recordReference } from "../../../../lib/short-id";
import { CopyIdButton } from "./_components/CopyIdButton";
import { InspectorActions } from "./_components/InspectorActions";
import { AdjudicationPanel, type AdjudicationKind } from "./_components/AdjudicationPanel";
import {
  DECISION_KIND_LABELS,
  DECISION_OPTION_LABELS,
  REASON_CODE_LABELS,
  SECOND_REVIEW_TRIGGER_LABELS,
  STAGE_LABELS,
  approveConfirmDescription,
  deriveActions,
  describeOutcome,
  describeRefusal,
  headerSlaLabel,
  lifecycleLabel,
  slaDimensionLabel,
  slaStateLabel,
  teamRoleLabel,
  type DecisionOutcome,
  type LifecycleActionKind,
  type LifecycleState,
  type Refusal,
  type SlaState,
  type Viewer,
  type ViewerActionName,
} from "./_components/inspector-model";

type WorkspaceResponse = {
  projection: {
    workflowId: string;
    evidenceId: string;
    /** Optional readable evidence name, when the API projects one. */
    evidenceTitle?: string | null;
    lifecycleState: LifecycleState;
    assignedToUserId: string | null;
    /** Optional readable assignee name, when the API projects one. */
    assignedToDisplayName?: string | null;
    assignedAtUtc: string | null;
    priority: string;
    slaPausedAtUtc: string | null;
    pausedReason: string | null;
    slaRollupState: SlaState;
    slaDimensions: Array<{
      dimension: string;
      dueAtUtc: string | null;
      state: SlaState;
    }>;
  };
  openEscalation: null | {
    id: string;
    reason: string;
    severity: string;
    status: string;
    safeSummary: string;
    createdAt: string;
    assignedToUserId: string | null;
  };
  /** Kept by the API for compatibility; the page renders `viewer.actions`. */
  allowedLifecycleTransitions: LifecycleState[];
  /**
   * Who may do what now, computed by the server from lifecycle, role,
   * assignment, stage and independence. Optional: an older API omits it and
   * the page falls back to the lifecycle-only rule.
   */
  viewer?: Viewer | null;
  /**
   * The opaque analysis revision for this review's evidence.
   *
   * Optional so an older API degrades to a panel that offers no selection
   * rather than one that selects records nobody can say are current.
   */
  analysisRevision?: string | null;
  // Phase B-2 — additive governance signals from the workspace
  // endpoint. Optional so older API versions degrade gracefully.
  governance?: {
    legalHold: {
      activeCount: number;
      mostRecent: null | {
        id: string;
        title: string;
        placedAtUtc: string;
      };
    };
    requiresRedaction: boolean;
    requiresRedactionFieldCount: number;
  };
};

/**
 * The reviewer-ops actions this page can POST.
 *
 * A CLOSED set, matching the registered
 * `POST /v1/reviewer-ops/reviews/:workflowId/<action>` routes one-for-one. Typed
 * as a union rather than `string` so the call site resolves statically: the
 * route-consumer analyzer can then prove exactly which routes this page
 * consumes instead of reporting an unresolvable dynamic call.
 */
type ReviewerOpsAction =
  | "start"
  | "approve"
  | "reject"
  | "pause"
  | "resume"
  | "request-info"
  | "response-received";

/** What the decision lineage panel last read, lifted for the page. */
type DecisionsSummary = {
  state: ReviewState;
  secondRequired: boolean;
  nextAction: NextAction;
  teamRole: string | null;
  decisions: DecisionRow[];
};

/**
 * Read a refusal from a thrown apiFetch error.
 *
 * ApiError carries the nested envelope (`err.body?.error?.code`,
 * `details.reason`); a lost answer is a plain Error with code NETWORK_ERROR.
 */
function readRefusal(err: unknown): Refusal {
  const e = (err ?? {}) as {
    statusCode?: number;
    code?: string;
    details?: { reason?: unknown } | null;
    flatReason?: string;
    body?: { error?: { code?: string; reason?: string; details?: { reason?: unknown } | null } };
  };
  const code = e.body?.error?.code ?? e.code ?? null;
  const rawReason =
    e.details?.reason ?? e.body?.error?.details?.reason ?? e.body?.error?.reason ?? e.flatReason ?? null;
  return {
    status: typeof e.statusCode === "number" ? e.statusCode : 0,
    code: typeof code === "string" ? code : null,
    reason: typeof rawReason === "string" ? rawReason : null,
  };
}

function refusalMessage(err: unknown, fallback: string): string {
  if (isPlanRefusal(err)) return PLAN_REFUSAL_COPY;
  const refusal = readRefusal(err);
  const mapped = describeRefusal(refusal, "");
  return mapped || toSafeUserError(err, { message: fallback }).message;
}

function reviewerName(r: { userId: string; email: string | null; displayName: string | null }): string {
  return r.displayName || r.email || recordReference("Reviewer", r.userId);
}

const ACTION_ROUTE: Record<"start" | "pause" | "resume" | "request_info" | "record_response" | "approve" | "reject", ReviewerOpsAction> = {
  start: "start",
  pause: "pause",
  resume: "resume",
  request_info: "request-info",
  record_response: "response-received",
  approve: "approve",
  reject: "reject",
};

// Phase 38.12 — wrap in canonical PageRouteGate.
export default function ReviewWorkspacePage() {
  return (
    <PageRouteGate routeId="review.queue_detail">
      <ReviewWorkspacePageInner />
    </PageRouteGate>
  );
}

function deriveSignature(r: WorkspaceResponse | null): string | null {
  if (!r) return null;
  const p = r.projection;
  return [
    p.lifecycleState,
    p.assignedToUserId ?? "",
    p.slaRollupState,
    p.assignedAtUtc ?? "",
    r.openEscalation?.id ?? "",
    r.openEscalation?.status ?? "",
  ].join("|");
}

function ReviewWorkspacePageInner() {
  const params = useParams<{ reviewId: string }>();
  const workflowId = params?.reviewId ?? "";
  // PageRouteGate guarantees an entitled active workspace here.
  const teamId = useActiveSpaceId();
  const [data, setData] = useState<WorkspaceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A failed READ of the workspace, kept apart from an action refusal so a
  // reload after a refusal never wipes the refusal off the screen.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<ViewerActionName | null>(null);
  // Bumped after every action so the lineage and notes panels reread.
  const [panelsVersion, setPanelsVersion] = useState(0);
  const [decisions, setDecisions] = useState<DecisionsSummary | null>(null);
  // Phase G3.2 — collision detection. The reviewer workspace
  // projection doesn't surface `updatedAt` directly, so we derive a
  // stable signature from the fields that mutating actions move
  // (lifecycle, assignment, SLA, escalation). String equality on the
  // signature is the same check CollisionWarning performs against an
  // ISO timestamp — both modes are honest, neither claims false
  // precision.
  const [initialSignature, setInitialSignature] = useState<string | null>(null);
  // Phase 2.4 — structured reason dialog. `reasonModal` holds the kind
  // currently open, or null when closed; `dialogError` is a refusal shown
  // inside it.
  const [reasonModal, setReasonModal] = useState<ReviewerReasonKind | null>(
    null,
  );
  const [dialogError, setDialogError] = useState<string | null>(null);
  // Phase 2.5 — keyboard shortcuts + help overlay.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  useReviewerHelpHotkey({
    open: shortcutsOpen,
    onOpen: () => setShortcutsOpen(true),
    onClose: () => setShortcutsOpen(false),
  });

  const load = useCallback(() => {
    if (!teamId || !workflowId) return;
    apiFetch(
      `/v1/reviewer-ops/workspace/${encodeURIComponent(
        workflowId,
      )}?teamId=${encodeURIComponent(teamId)}`,
      { method: "GET" },
    )
      .then((r: WorkspaceResponse) => {
        setData(r);
        setLoadError(null);
        // Capture the first signature; subsequent reloads update
        // `data` (the current side) but never overwrite this snapshot.
        setInitialSignature((prev) => prev ?? deriveSignature(r));
      })
      .catch((err: { message?: string }) =>
        setLoadError(toSafeUserError(err, { message: "Could not load workspace." }).message),
      );
  }, [teamId, workflowId]);

  useEffect(() => {
    load();
  }, [load]);

  /** Reload the workspace AND the lineage / notes panels. */
  const reloadAll = useCallback(() => {
    load();
    setPanelsVersion((v) => v + 1);
  }, [load]);

  const post = useCallback(
    // `action` is the TRAILING SEGMENT of a reviewer-ops action route, and the
    // set is CLOSED — typed as the union rather than as `string`, so the
    // route-consumer analyzer can prove which routes the page consumes and a
    // typo is a compile error rather than a 404 discovered by a reviewer.
    //
    // PRO-R2-16 — resolves true only when the action succeeded, so a caller
    // holding typed input (the reason dialog) keeps it on a refusal. A refusal
    // from a dialog is shown inside that dialog.
    async (
      name: ViewerActionName & keyof typeof ACTION_ROUTE,
      body: Record<string, unknown>,
      opts: { kind?: LifecycleActionKind; inDialog?: boolean } = {},
    ): Promise<boolean> => {
      if (!teamId) return false;
      const action: ReviewerOpsAction = ACTION_ROUTE[name];
      setBusy(name);
      setNotice(null);
      if (opts.inDialog) setDialogError(null);
      else setError(null);
      try {
        const resp = (await apiFetch(
          `/v1/reviewer-ops/reviews/${encodeURIComponent(
            workflowId,
          )}/${action}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ teamId, ...body }),
          },
        )) as { outcome?: DecisionOutcome | null } | null;
        if (opts.kind) setNotice(describeOutcome(opts.kind, resp?.outcome ?? null));
        reloadAll();
        return true;
      } catch (err) {
        const message = refusalMessage(err, "The action could not be completed. Nothing was changed.");
        if (opts.inDialog) setDialogError(message);
        else setError(message);
        // A stale or out-of-stage refusal means the page is behind: reread.
        reloadAll();
        return false;
      } finally {
        setBusy(null);
      }
    },
    [teamId, workflowId, reloadAll],
  );

  // PRO-R2-05 — an approval is a permanent internal decision that can release
  // held outputs: the key and the button both ask first, through the shared
  // confirm dialog. A second press while the dialog is open opens nothing.
  const { confirm } = useConfirmAction();
  const approvePending = useRef(false);
  const confirmAndApprove = useCallback(async () => {
    if (approvePending.current) return;
    approvePending.current = true;
    try {
      const firstOnly = decisions?.state === "first_required" && decisions.secondRequired;
      const ok = await confirm({
        title: firstOnly ? "Record the first review as approved (internal)?" : "Approve this review (internal)?",
        description: approveConfirmDescription({
          state: decisions?.state ?? null,
          secondRequired: decisions?.secondRequired ?? false,
        }),
        confirmLabel: firstOnly ? "Record first review" : "Approve (internal)",
        tone: "warning",
      });
      if (ok) await post("approve", {}, { kind: "approve" });
    } finally {
      approvePending.current = false;
    }
  }, [confirm, post, decisions]);

  const actions = data
    ? deriveActions({
        viewer: data.viewer,
        lifecycleState: data.projection.lifecycleState,
        paused: Boolean(data.projection.slaPausedAtUtc),
        assigned: Boolean(data.projection.assignedToUserId),
      })
    : null;

  const openReason = useCallback((kind: ReviewerReasonKind) => {
    setDialogError(null);
    setReasonModal(kind);
  }, []);

  // Phase 2.5 — action shortcuts, aligned with the reviewer console's keys:
  // A starts, M requests information, C approves (asks first). They fire
  // ONLY when no field is focused and only when the action map allows the
  // action, so a shortcut never bypasses what the buttons enforce. None of
  // them navigates away from the review.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isShortcutTarget(e)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (shortcutsOpen) return;
      if (reasonModal !== null) return;
      if (!actions || busy !== null) return;
      const k = e.key.toLowerCase();
      if (k === "m") {
        if (!actions.request_info.allowed) return;
        e.preventDefault();
        openReason("REQUEST_INFO");
      } else if (k === "c") {
        if (!actions.approve.allowed) return;
        e.preventDefault();
        void confirmAndApprove();
      } else if (k === "a") {
        if (!actions.start.allowed) return;
        e.preventDefault();
        void post("start", {});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions, busy, shortcutsOpen, reasonModal, post, confirmAndApprove, openReason]);

  /** A lineage decision or adjudication: POST, then reload everything. */
  const postDecision = useCallback(
    async (body: { decision: string; reasonCode?: string; rationale: string }): Promise<string | null> => {
      if (!teamId) return "No active workspace.";
      try {
        const resp = (await apiFetch(
          `/v1/reviewer-ops/workspace/${encodeURIComponent(workflowId)}/decisions`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ teamId, ...body }),
          },
        )) as { outcome?: DecisionOutcome | null } | null;
        const outcome = resp?.outcome ?? null;
        setNotice(
          outcome
            ? describeOutcome(
                body.decision === "APPROVE" ? "approve" : body.decision === "REJECT" ? "reject" : "decision",
                outcome,
              )
            : "Decision recorded.",
        );
        reloadAll();
        return null;
      } catch (err) {
        reloadAll();
        return refusalMessage(err, "The decision could not be recorded. Nothing was changed.");
      }
    },
    [teamId, workflowId, reloadAll],
  );

  // PageRouteGate already guaranteed ALLOWED. If the envelope is
  // still hydrating, render the bounded loading shell.
  if (!teamId) {
    return (
      <PageShell
        width="full"
        data-review-workspace-loading
        header={
          <PageHeader
            eyebrow="Reviewer operations"
            title="Review workspace"
            subtitle="Loading workspace…"
          />
        }
      />
    );
  }

  if (!data || !actions) {
    return (
      <PageShell
        width="full"
        header={
          <PageHeader eyebrow="Reviewer operations" title="Review workspace" />
        }
      >
        {loadError ? (
          <Card variant="status" tone="risk">
            {loadError}
          </Card>
        ) : null}
        <EmptyState variant="inline" title="Loading workspace…" />
      </PageShell>
    );
  }

  const p = data.projection;
  const evidenceName = p.evidenceTitle?.trim() || recordReference("Evidence", p.evidenceId);
  const inConflict =
    decisions?.state === "conflict_detected" || decisions?.state === "adjudication_required";
  const canAdjudicate =
    decisions?.nextAction === "submit_adjudication" ||
    (data.viewer ? actions.adjudicate.allowed : false);
  const adjudicationBlockedReason =
    data.viewer && !actions.adjudicate.allowed
      ? actions.adjudicate.reason
      : decisions?.nextAction === "blocked_not_adjudicator"
        ? "Adjudication needs a workspace owner or admin who made neither decision."
        : null;
  const assignee = p.assignedToUserId
    ? data.viewer?.isAssignee
      ? "You"
      : p.assignedToDisplayName?.trim() || recordReference("Reviewer", p.assignedToUserId)
    : "Unassigned";

  return (
    <PageShell
      width="full"
      header={
        <PageHeader
          eyebrow="Reviewer operations"
          title="Review workspace"
          subtitle={
            <span style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: 6, minWidth: 0 }}>
              <a
                href={`/evidence/${p.evidenceId}`}
                style={{ color: "var(--ink-link)", textDecoration: "none", overflowWrap: "anywhere" }}
                data-reviewer-evidence-link
              >
                {evidenceName}
              </a>
              <CopyIdButton value={p.evidenceId} label="Evidence" />
            </span>
          }
          contextStrip={
            <>
              {/* ONE lifecycle badge and ONE SLA badge, each with its word.
                  The header used to read "escalated • escalated". */}
              <Badge tone={statusTone(p.lifecycleState)} dot data-reviewer-lifecycle-badge>
                {lifecycleLabel(p.lifecycleState)}
              </Badge>
              <Badge tone={statusTone(p.slaRollupState)} dot data-reviewer-sla-badge>
                {headerSlaLabel(p.slaRollupState, p.lifecycleState)}
              </Badge>
            </>
          }
          secondaryActions={
            /* A real link, not a Button: middle-click and open-in-new-tab
               are how an operator keeps the queue open beside a review, and
               a <button> that navigates takes both away. The canonical look
               is exported for exactly this. */
            <a
              href="/reviewer-ops"
              style={{ ...buttonSurfaceStyle("secondary"), textDecoration: "none" }}
            >
              Back to queue
            </a>
          }
        />
      }
    >
      {notice ? (
        <p role="status" className="app-alert app-alert--ok" data-reviewer-action-notice style={{ marginTop: 0 }}>
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="app-alert app-alert--danger" data-reviewer-action-error style={{ marginTop: 0 }}>
          {error}
        </p>
      ) : null}

      {loadError ? (
        <p role="alert" className="app-alert app-alert--danger" data-reviewer-load-error style={{ marginTop: 0 }}>
          {loadError}
        </p>
      ) : null}
      {/* Phase G3.2 — Presence + collision wiring for the inspector. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 8,
        }}
      >
        <PresenceIndicator
          teamId={teamId}
          resourceKind="reviewer_workflow"
          resourceId={workflowId}
        />
      </div>
      <CollisionWarning
        entityLabel="Review workflow"
        initialUpdatedAtUtc={initialSignature}
        currentUpdatedAtUtc={deriveSignature(data)}
        onReload={() => reloadAll()}
      />

      {/* Phase B-2 — governance signals strip. Surfaces ACTIVE legal
          hold count + redaction-required visibility decisions for the
          underlying evidence. Read-only; the operator's path to act
          on these lives on /governance/* surfaces (Phase 9). Hidden
          when there is no signal — we never show an empty "no hold"
          state because the absence of a hold is the default. */}
      {data.governance &&
        (data.governance.legalHold.activeCount > 0 ||
          data.governance.requiresRedaction) && (
          <section
            data-section="reviewer-governance-signals"
            data-reviewer-legal-hold-active={
              data.governance.legalHold.activeCount > 0 ? "true" : "false"
            }
            data-reviewer-legal-hold-count={
              data.governance.legalHold.activeCount
            }
            data-reviewer-requires-redaction={
              data.governance.requiresRedaction ? "true" : "false"
            }
            data-reviewer-redaction-field-count={
              data.governance.requiresRedactionFieldCount
            }
            style={{
              border: "1px solid var(--border-standard)",
              borderRadius: "var(--radius-md)",
              padding: 16,
              marginBottom: 12,
              /* A governance signal is a WARNING, and the warning tone is the
                 product's, not two alpha values invented here. */
              borderColor: "var(--warning-border)",
              background: "var(--warning-subtle-bg)",
              minWidth: 0,
            }}
          >
            <h3 className="app-panel__title">Governance signals</h3>
            <div
              style={{
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
                fontSize: 13,
              }}
            >
              {data.governance.legalHold.activeCount > 0 && (
                <span
                  data-reviewer-governance-chip="legal-hold"
                  style={{
                    padding: "0.25rem 0.6rem",
                    border: "1px solid rgba(239, 68, 68, 0.55)",
                    background: "rgba(239, 68, 68, 0.1)",
                    borderRadius: 4,
                    fontWeight: 600,
                    overflowWrap: "anywhere",
                  }}
                >
                  Legal hold active ({data.governance.legalHold.activeCount})
                  {data.governance.legalHold.mostRecent
                    ? ` — “${data.governance.legalHold.mostRecent.title}”`
                    : ""}
                </span>
              )}
              {data.governance.requiresRedaction && (
                <span
                  data-reviewer-governance-chip="requires-redaction"
                  style={{
                    padding: "0.25rem 0.6rem",
                    border: "1px solid rgba(245, 158, 11, 0.55)",
                    background: "rgba(245, 158, 11, 0.1)",
                    borderRadius: 4,
                    fontWeight: 600,
                  }}
                >
                  Redaction required (
                  {data.governance.requiresRedactionFieldCount} field
                  {data.governance.requiresRedactionFieldCount === 1
                    ? ""
                    : "s"}
                  )
                </span>
              )}
            </div>
            <p
              style={{
                color: "var(--silver-ink)",
                marginTop: 6,
                fontSize: 12,
              }}
            >
              {data.governance.legalHold.activeCount > 0
                ? "Evidence under legal hold cannot be deleted or purged. Export gating applies; package downloads remain subject to workspace policy. See Governance → Lifecycle for the full hold history. "
                : ""}
              {data.governance.requiresRedaction
                ? "One or more visibility decisions for this evidence flag fields that need redaction before a report or package is exported. The export gate enforces this on the server."
                : ""}
            </p>
          </section>
        )}

      <div style={twoColStyle}>
        <Card padding="comfortable">
          <InspectorActions
            actions={actions}
            fromViewer={Boolean(data.viewer)}
            busy={busy}
            paused={Boolean(p.slaPausedAtUtc)}
            handlers={{
              start: () => void post("start", {}),
              approve: () => void confirmAndApprove(),
              reject: () => openReason("REJECT"),
              request_info: () => openReason("REQUEST_INFO"),
              record_response: () => openReason("RECORD_RESPONSE"),
              pause: () => openReason("PAUSE"),
              resume: () => void post("resume", {}),
            }}
          />
        </Card>

        <Card padding="comfortable">
          <h3 className="app-panel__title">Assignment</h3>
          <div style={{ fontSize: 13 }}>
            <KV k="Assigned to" v={assignee} />
            <KV k="Assigned at" v={formatCellDateTime(p.assignedAtUtc)} />
            <KV k="Priority" v={identifierLabel(p.priority)} />
            {p.slaPausedAtUtc ? (
              <KV k="Paused" v={p.pausedReason?.trim() || "Paused"} />
            ) : null}
          </div>

          <h3 className="app-panel__title">SLA</h3>
          <div style={{ overflowX: "auto", maxWidth: "100%" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 13,
              }}
            >
              <thead>
                <tr>
                  <th style={thLight}>Clock</th>
                  <th style={thLight}>State</th>
                  <th style={thLight}>Due</th>
                </tr>
              </thead>
              <tbody>
                {p.slaDimensions.map((d) => (
                  <tr key={d.dimension}>
                    <td style={tdLight}>{slaDimensionLabel(d.dimension)}</td>
                    <td style={tdLight}>
                      <Badge tone={statusTone(d.state)} subtle>
                        {slaStateLabel(d.state)}
                      </Badge>
                    </td>
                    <td style={tdLight}>
                      <span className="app-field-help">
                        {formatRelativeDeadline(d.dueAtUtc)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.openEscalation ? (
            <>
              <h3 className="app-panel__title">Open escalation</h3>
              <div className="app-alert app-alert--danger" style={{ fontSize: 13 }}>
                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    alignItems: "center",
                    flexWrap: "wrap",
                    marginBottom: 6,
                  }}
                >
                  <Badge tone={severityTone(data.openEscalation.severity)} subtle>
                    {identifierLabel(data.openEscalation.severity)}
                  </Badge>
                  <span className="app-field-help" style={{ margin: 0 }}>
                    {escalationReasonLabel(data.openEscalation.reason)}
                  </span>
                  <span style={{ marginLeft: "auto", fontSize: 12 }}>
                    {formatCellDateTime(data.openEscalation.createdAt)}
                  </span>
                </div>
                <div style={{ overflowWrap: "anywhere" }}>{data.openEscalation.safeSummary}</div>
              </div>
            </>
          ) : null}
        </Card>
      </div>

      {inConflict && decisions ? (
        <AdjudicationPanel
          decisions={decisions.decisions.map((d) => ({
            id: d.id,
            stage: d.stage,
            decision: d.decision,
            reasonCode: d.reasonCode,
            rationale: d.rationale,
            decidedAt: d.decidedAt,
            reviewerName: reviewerName(d.reviewer),
          }))}
          canAdjudicate={canAdjudicate}
          blockedReason={adjudicationBlockedReason}
          onSubmit={(body: { decision: AdjudicationKind; reasonCode: string; rationale: string }) => postDecision(body)}
        />
      ) : null}

      {/* Phase B.2 — multi-stage review governance panel.
          Server-enforced state machine. Caller's next allowed action
          is computed by the API based on existing decision rows +
          policy triggers (escalated / legal hold / redaction
          required) + caller's team role (OWNER/ADMIN required for
          adjudication). */}
      <ReviewerDecisionLineagePanel
        workflowId={workflowId}
        teamId={teamId}
        refreshKey={panelsVersion}
        onLoaded={setDecisions}
        onSubmitDecision={postDecision}
      />

      {/* Phase A.1D — review workflow continuity. Surface the related
          artifacts + cross-surface links the reviewer needs without
          leaving the review workspace. Every link routes to a real,
          registered surface; downloads use the same audited endpoints
          ReportsIndex uses. */}
      <section
        style={{
          background: "var(--surface-standard)",
          border: "1px solid var(--border-standard)",
          borderRadius: "var(--radius-md)",
          padding: 16,
          marginBottom: 12,
          minWidth: 0,
        }}
        data-section="reviewer-workflow-continuity"
      >
        <h3 className="app-panel__title">Linked artifacts &amp; context</h3>
        <ReviewerCrossSurfaceLinks evidenceId={p.evidenceId} />
      </section>

      {/* Phase B.1-1 — structured reviewer notes. Wired to
          /v1/reviewer-ops/workspace/:workflowId/notes. Notes carry
          one of seven structured types and are audited via
          TeamActivity (REVIEWER_NOTE_CREATED). */}
      <ReviewerNotesPanel
        workflowId={workflowId}
        teamId={teamId}
        refreshKey={panelsVersion}
      />

      {/* Phase D3 — Reviewer Copilot (advisory only; final decision stays human). */}
      <div style={{ marginBottom: 12, minWidth: 0 }}>
        <ReviewerCopilotPanel
          reviewId={workflowId}
          evidence={[
            {
              id: p.evidenceId,
              title: evidenceName,
              // THE PROJECTED REVISION. This was a literal `0`, so the panel
              // asserted a version it had never been told and the route it
              // fed had no guard to check it against.
              analysisRevision: data.analysisRevision ?? undefined,
              status: p.lifecycleState,
            },
          ]}
        />
      </div>

      <CodingSchemaBindingPanel teamId={teamId} workflowId={workflowId} />

      {/* Phase B.1-3 — Honest deferred-features panel. The brief
          explicitly told us to "show honest unavailable state" rather
          than fake features. This panel documents the precise truth so a
          reviewer is never misled. */}
      <ReviewerDeferredFeaturesPanel />

      {/* Phase 2.5 — Keyboard shortcuts help (`?`, ignored while typing). */}
      <ReviewerShortcutsHelp
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        variant="inspector"
      />

      {/* Phase 2.4 — Structured reason dialog. A refusal stays inside the
          dialog with the typed reason kept for the retry. */}
      <ReviewerReasonModal
        kind={reasonModal}
        open={reasonModal !== null}
        error={dialogError}
        onCancel={() => {
          setReasonModal(null);
          setDialogError(null);
        }}
        onSubmit={async (reason) => {
          if (!reasonModal) return;
          let ok = false;
          if (reasonModal === "REQUEST_INFO") {
            ok = await post("request_info", { note: reason }, { kind: "request_info", inDialog: true });
          } else if (reasonModal === "REJECT") {
            ok = await post("reject", { note: reason }, { kind: "reject", inDialog: true });
          } else if (reasonModal === "PAUSE") {
            ok = await post("pause", { pausedReason: reason }, { inDialog: true });
          } else if (reasonModal === "RECORD_RESPONSE") {
            ok = await post(
              "record_response",
              reason ? { note: reason } : {},
              { kind: "record_response", inDialog: true },
            );
          }
          // PRO-R2-16 — close only on success; a refusal keeps the dialog,
          // its message and the typed reason for the retry.
          if (ok) {
            setReasonModal(null);
            setDialogError(null);
          }
        }}
      />
    </PageShell>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
        padding: "2px 0",
        flexWrap: "wrap",
        minWidth: 0,
      }}
    >
      <span className="app-field-help" style={{ margin: 0 }}>{k}</span>
      <span style={{ overflowWrap: "anywhere", minWidth: 0 }}>{v}</span>
    </div>
  );
}

const twoColStyle: React.CSSProperties = {
  display: "grid",
  // Two columns where there is room, one stacked column on a phone: a fixed
  // `1fr 1fr` overflowed at 320 px.
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))",
  gap: 16,
  marginTop: 16,
  marginBottom: 12,
  alignItems: "flex-start",
  minWidth: 0,
};

const thLight: React.CSSProperties = {
  textAlign: "left",
  fontSize: 11,
  fontWeight: 700,
  color: "var(--ink-secondary)",
  textTransform: "uppercase",
  letterSpacing: 0.3,
  padding: "6px 8px 6px 0",
  borderBottom: "1px solid var(--border-standard)",
};

const tdLight: React.CSSProperties = {
  padding: "6px 8px 6px 0",
  borderBottom: "1px solid var(--border-subtle)",
  fontSize: 12,
};

// ---------------------------------------------------------------------------
// Phase A.1D — Reviewer cross-surface continuity.
//
// Renders a compact strip of links + on-demand downloads inside the
// review workspace so a reviewer can open the evidence, fetch the
// latest report, fetch the verification package, and jump back to the
// reviewer queue without leaving the review.
//
// Every action routes to an EXISTING endpoint or registered route;
// nothing is invented. Downloads use the same gated path the
// evidence-detail page uses (signed URLs, gated on policy, audited
// server-side). Failure messaging is honest: 202 → "still generating",
// 403 → "permission required", etc.
// ---------------------------------------------------------------------------
function ReviewerCrossSurfaceLinks({ evidenceId }: { evidenceId: string }) {
  const [busy, setBusy] = useState<null | "report" | "package">(null);
  const [error, setError] = useState<string | null>(null);

  const open = async (kind: "report" | "package") => {
    if (busy) return;
    // F-P1-04 — the tab opens IN the click, before the await (artifact-window.ts).
    const pending = openPendingArtifactWindow();
    setBusy(kind);
    setError(null);
    try {
      const path =
        kind === "report"
          ? `/v1/evidence/${evidenceId}/report/latest`
          : `/v1/evidence/${evidenceId}/verification-package`;
      const resp = (await apiFetch(path, { method: "GET" })) as {
        url?: string;
        code?: string;
        message?: string;
      };
      if (resp.url) {
        if (pending.assign(resp.url) === "blocked") setError(ARTIFACT_WINDOW_BLOCKED_MESSAGE);
      } else {
        pending.close();
        // RGA-04 — a 2xx with no URL carries a bounded code (e.g. pending).
        setError(
          describeArtifactDownloadFailure(
            kind === "report" ? "report" : "verificationPackage",
            { code: resp.code, statusCode: resp.code ? 202 : 503 },
          ).message,
        );
      }
    } catch (err) {
      pending.close();
      // RGA-04 — the ONE shared download-failure vocabulary.
      setError(
        describeArtifactDownloadFailure(kind === "report" ? "report" : "verificationPackage", err).message,
      );
    } finally {
      setBusy(null);
    }
  };

  const groupStyle: React.CSSProperties = {
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
    alignItems: "center",
    minWidth: 0,
  };
  const groupTitle: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 600,
    margin: "0 0 6px",
    color: "var(--app-ink-label, var(--ink-secondary))",
  };

  return (
    <div
      data-reviewer-cross-surface-links
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 260px), 1fr))",
        gap: 16,
        fontSize: 13,
        minWidth: 0,
      }}
    >
      {/* Evidence: the record under review and its outputs. One primary.
          Downloads keep the existing gated endpoints; nothing here adds a
          privilege. */}
      <div role="group" aria-labelledby="reviewer-links-evidence" data-reviewer-links-group="evidence" style={{ minWidth: 0 }}>
        <p id="reviewer-links-evidence" style={groupTitle}>Evidence</p>
        <div style={groupStyle}>
          <a
            href={`/evidence/${evidenceId}`}
            data-reviewer-link="open-evidence"
            className="app-primary-action"
            style={{ textDecoration: "none" }}
          >
            Open evidence detail
          </a>
          <button
            type="button"
            onClick={() => void open("report")}
            disabled={busy !== null}
            aria-busy={busy === "report" || undefined}
            data-reviewer-link="download-report"
            className="app-secondary-action"
          >
            {busy === "report" ? "Opening…" : "Download latest report"}
          </button>
          <button
            type="button"
            onClick={() => void open("package")}
            disabled={busy !== null}
            aria-busy={busy === "package" || undefined}
            data-reviewer-link="download-package"
            className="app-secondary-action"
          >
            {busy === "package" ? "Opening…" : "Download verification package"}
          </button>
        </div>
        {error ? (
          <p
            role="alert"
            data-reviewer-cross-surface-error
            className="app-alert app-alert--danger"
            style={{ margin: "8px 0 0" }}
          >
            {error}
          </p>
        ) : null}
      </div>
      {/* Go to: other review surfaces. Navigation only, no primary. */}
      <nav aria-labelledby="reviewer-links-goto" data-reviewer-links-group="goto" style={{ minWidth: 0 }}>
        <p id="reviewer-links-goto" style={groupTitle}>Go to</p>
        <div style={groupStyle}>
          <a
            href="/reports"
            data-reviewer-link="open-reports"
            className="app-secondary-action"
            style={{ textDecoration: "none" }}
          >
            Reports queue
          </a>
          <a
            href="/reviewer-ops/escalations"
            data-reviewer-link="open-escalations"
            className="app-secondary-action"
            style={{ textDecoration: "none" }}
          >
            Escalations
          </a>
        </div>
      </nav>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase B.1-1 + B.1-2 — Structured Reviewer Notes panel + Timeline.
//
// Wired to:
//   GET  /v1/reviewer-ops/workspace/:workflowId/notes?teamId=<uuid>
//   POST /v1/reviewer-ops/workspace/:workflowId/notes  body: { teamId, type, body }
//
// Backend stores notes as a v1 JSON envelope inside
// EvidenceReviewerComment.body so we don't need a schema migration.
// Audit emission is workspace-scoped via TeamActivity. RBAC mirrors
// the rest of reviewer-ops (requireReviewerActor on the workflow's
// team).
//
// Note types (operator-readable categories the brief specified):
//   observation, concern, request_info, escalation_context,
//   decision_rationale, legal_hold_context, redaction_context.
//
// Legacy plain-text comments created BEFORE Phase B.1 surface with
// type "general" — the parser tolerates them so we don't blow up on
// pre-existing rows.
// ---------------------------------------------------------------------------

type ReviewerNoteType =
  | "observation"
  | "concern"
  | "request_info"
  | "escalation_context"
  | "decision_rationale"
  | "legal_hold_context"
  | "redaction_context";

const NOTE_TYPE_OPTIONS: ReadonlyArray<{ value: ReviewerNoteType; label: string }> = [
  { value: "observation", label: "Observation" },
  { value: "concern", label: "Concern" },
  { value: "request_info", label: "Request info" },
  { value: "escalation_context", label: "Escalation context" },
  { value: "decision_rationale", label: "Decision rationale" },
  { value: "legal_hold_context", label: "Legal hold context" },
  { value: "redaction_context", label: "Redaction context" },
];

const NOTE_TYPE_LABELS: Record<string, string> = {
  observation: "Observation",
  concern: "Concern",
  request_info: "Request info",
  escalation_context: "Escalation context",
  decision_rationale: "Decision rationale",
  legal_hold_context: "Legal hold context",
  redaction_context: "Redaction context",
  general: "Note",
};

const NOTE_TYPE_TONE: Record<string, { bg: string; border: string }> = {
  observation: { bg: "rgba(99,102,241,0.06)", border: "rgba(99,102,241,0.45)" },
  concern: { bg: "rgba(245,158,11,0.08)", border: "rgba(245,158,11,0.55)" },
  request_info: { bg: "rgba(99,102,241,0.06)", border: "rgba(99,102,241,0.45)" },
  escalation_context: {
    bg: "rgba(239,68,68,0.08)",
    border: "rgba(239,68,68,0.55)",
  },
  decision_rationale: {
    bg: "rgba(34,197,94,0.06)",
    border: "rgba(34,197,94,0.45)",
  },
  legal_hold_context: {
    bg: "rgba(239,68,68,0.08)",
    border: "rgba(239,68,68,0.55)",
  },
  redaction_context: {
    bg: "rgba(245,158,11,0.08)",
    border: "rgba(245,158,11,0.55)",
  },
  general: { bg: "rgba(127,127,127,0.06)", border: "rgba(127,127,127,0.4)" },
};

type ReviewerNote = {
  id: string;
  type: string;
  body: string;
  isLegacyPlainText: boolean;
  visibility: string;
  author: {
    userId: string;
    email: string | null;
    displayName: string | null;
  };
  createdAt: string;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
};

type NotesEnvelope = {
  workflowId: string;
  evidenceId: string;
  summary: { total: number };
  items: ReviewerNote[];
};

function ReviewerNotesPanel({
  workflowId,
  teamId,
  refreshKey = 0,
}: {
  workflowId: string;
  teamId: string;
  /** Bumped by the page after any action, so the notes reread. */
  refreshKey?: number;
}) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; data: NotesEnvelope }
    | { kind: "error"; status: number; message: string }
  >({ kind: "loading" });
  const [filterType, setFilterType] = useState<"all" | ReviewerNoteType | "general">(
    "all",
  );
  const [composeType, setComposeType] = useState<ReviewerNoteType>("observation");
  const [composeBody, setComposeBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [composeError, setComposeError] = useState<string | null>(null);

  const load = useCallback(async () => {
    // A refresh keeps the current list on screen instead of flashing to a
    // loading state.
    setState((prev) => (prev.kind === "ready" ? prev : { kind: "loading" }));
    try {
      const data = (await apiFetch(
        `/v1/reviewer-ops/workspace/${encodeURIComponent(workflowId)}/notes?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      )) as NotesEnvelope;
      setState({ kind: "ready", data });
    } catch (err: unknown) {
      const status =
        typeof (err as { statusCode?: number }).statusCode === "number"
          ? ((err as { statusCode: number }).statusCode)
          : 0;
      const message =
        toSafeUserError(err, { message: "Could not load notes." }).message;
      setState({ kind: "error", status, message });
    }
  }, [workflowId, teamId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const submitNote = useCallback(async () => {
    const trimmed = composeBody.trim();
    if (!trimmed) {
      setComposeError("Body is required.");
      return;
    }
    setSubmitting(true);
    setComposeError(null);
    try {
      await apiFetch(
        `/v1/reviewer-ops/workspace/${encodeURIComponent(workflowId)}/notes`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ teamId, type: composeType, body: trimmed }),
        },
      );
      setComposeBody("");
      // Reload so the new note appears with its real audit-emitted state.
      await load();
    } catch (err: unknown) {
      const status =
        typeof (err as { statusCode?: number }).statusCode === "number"
          ? ((err as { statusCode: number }).statusCode)
          : 0;
      if (isPlanRefusal(err)) {
        // PRO-R2-14 — the plan, not a membership problem.
        setComposeError(PLAN_REFUSAL_COPY);
      } else if (status === 403) {
        setComposeError(
          "Permission denied. Reviewer note creation requires workspace membership.",
        );
      } else if (status === 404) {
        setComposeError("Workflow not found in this workspace.");
      } else if (status === 400) {
        setComposeError(
          "Request rejected — note body must be 1–4000 characters.",
        );
      } else {
        const message =
          toSafeUserError(err, { message: "Could not create note." }).message;
        setComposeError(message);
      }
    } finally {
      setSubmitting(false);
    }
  }, [composeBody, composeType, workflowId, teamId, load]);

  const visibleNotes =
    state.kind === "ready"
      ? filterType === "all"
        ? state.data.items
        : state.data.items.filter((n) => n.type === filterType)
      : [];

  return (
    <section
      style={{
        background: "var(--surface-standard)",
        border: "1px solid var(--border-standard)",
        borderRadius: "var(--radius-md)",
        padding: 16,
        marginBottom: 12,
      }}
      data-section="reviewer-notes"
      data-reviewer-notes-total={
        state.kind === "ready" ? state.data.summary.total : 0
      }
    >
      <h3 className="app-panel__title">
        Reviewer notes{" "}
        {state.kind === "ready" ? (
          <span style={{ fontSize: 12, opacity: 0.7, marginLeft: 6 }}>
            · {state.data.summary.total} total
          </span>
        ) : null}
      </h3>
      <p
        style={{
          fontSize: 12,
          color: "var(--silver-ink)",
          marginTop: 0,
          marginBottom: 8,
        }}
      >
        Structured notes attached to the evidence under this review.
        Every note is recorded in the workspace activity feed. Notes
        persist across reviewers and survive workflow transitions.
      </p>

      {/* ---- compose ---- */}
      <form
        data-reviewer-notes-form
        onSubmit={(e) => {
          e.preventDefault();
          void submitNote();
        }}
        style={{
          display: "grid",
          gap: 6,
          padding: "0.5rem 0.6rem",
          border: "1px solid rgba(127,127,127,0.3)",
          borderRadius: 6,
          marginBottom: 10,
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 6,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <label style={{ fontSize: 12, fontWeight: 600 }}>
            Type
            <AppListbox
              value={composeType}
              options={[
                ...NOTE_TYPE_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
              ]}
              onChange={(next) => setComposeType(next as ReviewerNoteType)}
              disabled={submitting}
              style={{ marginLeft: 6 }}
              triggerProps={{ "data-reviewer-notes-compose-type": "" }}
            />
          </label>
        </div>
        <textarea
          value={composeBody}
          onChange={(e) => setComposeBody(e.target.value)}
          disabled={submitting}
          maxLength={4000}
          rows={3}
          placeholder="Write a structured reviewer note (1–4000 chars). Every note is audited."
          data-reviewer-notes-compose-body
          style={{
            width: "100%",
            fontSize: 13,
            padding: "0.4rem 0.5rem",
            border: "1px solid currentColor",
            borderRadius: 4,
            background: "transparent",
            color: "inherit",
            resize: "vertical",
            minHeight: 60,
          }}
        />
        {composeError ? (
          <div role="alert" data-reviewer-notes-compose-error style={{ fontSize: 12, color: "#d44" }}>
            {composeError}
          </div>
        ) : null}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 6,
            alignItems: "center",
          }}
        >
          <span style={{ fontSize: 11, opacity: 0.6 }}>
            {composeBody.length}/4000
          </span>
          <button
            type="submit"
            disabled={submitting || composeBody.trim().length === 0}
            data-reviewer-notes-compose-submit
            style={buttonSurfaceStyle("primary", "sm")}
          >
            {submitting ? "Adding…" : "Add note"}
          </button>
        </div>
      </form>

      {/* ---- filter chips ---- */}
      {state.kind === "ready" && state.data.summary.total > 0 ? (
        <div
          data-reviewer-notes-filter
          style={{
            display: "flex",
            gap: 4,
            flexWrap: "wrap",
            marginBottom: 8,
            fontSize: 12,
          }}
        >
          <FilterChip
            label="All"
            active={filterType === "all"}
            onClick={() => setFilterType("all")}
            count={state.data.summary.total}
            dataValue="all"
          />
          {(["observation", "concern", "request_info", "escalation_context", "decision_rationale", "legal_hold_context", "redaction_context"] as ReviewerNoteType[]).map((t) => {
            const c = state.data.items.filter((n) => n.type === t).length;
            if (c === 0) return null;
            return (
              <FilterChip
                key={t}
                label={NOTE_TYPE_LABELS[t]}
                active={filterType === t}
                onClick={() => setFilterType(t)}
                count={c}
                dataValue={t}
              />
            );
          })}
          {state.data.items.some((n) => n.type === "general") ? (
            <FilterChip
              label="Legacy"
              active={filterType === "general"}
              onClick={() => setFilterType("general")}
              count={state.data.items.filter((n) => n.type === "general").length}
              dataValue="general"
            />
          ) : null}
        </div>
      ) : null}

      {/* ---- list ---- */}
      {state.kind === "loading" ? (
        <div data-reviewer-notes-state="loading" className="app-field-help">
          Loading notes…
        </div>
      ) : null}
      {state.kind === "error" ? (
        <div
          role="alert"
          data-reviewer-notes-state="error"
          style={{ fontSize: 13, opacity: 0.85 }}
        >
          {/* raw-identifier-ok: state.status here is the HTTP status number of a failed read */}
          {state.status === 403
            ? "You don't have permission to view notes for this workflow."
            : state.status === 404
              ? "Workflow not found in this workspace."
              : "Could not load notes."}
          <button
            type="button"
            onClick={() => void load()}
            data-reviewer-notes-retry
            style={{
              marginLeft: 6,
              fontSize: 12,
              padding: "0.2rem 0.5rem",
              border: "1px solid currentColor",
              borderRadius: 4,
              background: "transparent",
              cursor: "pointer",
            }}
          >
            Retry
          </button>
        </div>
      ) : null}
      {state.kind === "ready" && state.data.summary.total === 0 ? (
        <div
          data-reviewer-notes-state="empty"
          style={{ fontSize: 13, color: "var(--silver-ink)" }}
        >
          No notes yet. Add the first structured note above to anchor
          this review's context for future reviewers.
        </div>
      ) : null}
      {state.kind === "ready" && visibleNotes.length === 0 && state.data.summary.total > 0 ? (
        <div data-reviewer-notes-state="filter-empty" style={{ fontSize: 13, opacity: 0.8 }}>
          No notes of type{" "}
          <strong>{NOTE_TYPE_LABELS[filterType] ?? filterType}</strong>. {" "}
          <button
            type="button"
            onClick={() => setFilterType("all")}
            style={{
              fontSize: 12,
              padding: "0.15rem 0.45rem",
              border: "1px solid currentColor",
              borderRadius: 4,
              background: "transparent",
              cursor: "pointer",
            }}
          >
            Show all
          </button>
        </div>
      ) : null}
      {state.kind === "ready" && visibleNotes.length > 0 ? (
        <ul
          data-reviewer-notes-items
          data-reviewer-notes-visible-count={visibleNotes.length}
          style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }}
        >
          {visibleNotes.map((n) => {
            const tone = NOTE_TYPE_TONE[n.type] ?? NOTE_TYPE_TONE.general;
            return (
              <li
                key={n.id}
                data-reviewer-note-id={n.id}
                data-reviewer-note-type={n.type}
                data-reviewer-note-legacy={n.isLegacyPlainText ? "true" : "false"}
                style={{
                  padding: "0.55rem 0.7rem",
                  border: `1px solid ${tone.border}`,
                  background: tone.bg,
                  borderRadius: 6,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 6,
                    flexWrap: "wrap",
                    fontSize: 12,
                  }}
                >
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <span
                      data-reviewer-note-type-chip={n.type}
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: 0.4,
                        textTransform: "uppercase",
                        padding: "1px 6px",
                        borderRadius: 4,
                        background: "rgba(127,127,127,0.18)",
                      }}
                    >
                      {NOTE_TYPE_LABELS[n.type] ?? identifierLabel(n.type)}
                    </span>
                    <span style={{ fontWeight: 600 }}>
                      {n.author.displayName || n.author.email || recordReference("Author", n.author.userId)}
                    </span>
                  </div>
                  <time dateTime={n.createdAt} style={{ opacity: 0.75 }}>
                    {formatUserDateTime(n.createdAt)}
                  </time>
                </div>
                <div
                  data-reviewer-note-body
                  style={{
                    fontSize: 13,
                    marginTop: 4,
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                  }}
                >
                  {n.body}
                </div>
                {n.isLegacyPlainText ? (
                  <div
                    data-reviewer-note-legacy-banner
                    style={{
                      marginTop: 4,
                      fontSize: 11,
                      opacity: 0.65,
                    }}
                  >
                    Legacy plain-text note (pre-Phase-B.1; no structured type).
                  </div>
                ) : null}
                {n.resolvedAt ? (
                  <div
                    data-reviewer-note-resolved
                    style={{
                      marginTop: 4,
                      fontSize: 11,
                      opacity: 0.7,
                    }}
                  >
                    Resolved {formatUserDateTime(n.resolvedAt)}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

function FilterChip({
  label,
  active,
  onClick,
  count,
  dataValue,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  count: number;
  dataValue: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-reviewer-notes-filter-chip={dataValue}
      data-reviewer-notes-filter-active={active ? "true" : "false"}
      style={{
        padding: "0.2rem 0.55rem",
        border: "1px solid currentColor",
        borderRadius: 999,
        fontSize: 12,
        background: active ? "rgba(99,102,241,0.18)" : "transparent",
        cursor: "pointer",
        color: "inherit",
      }}
    >
      {label} <span style={{ opacity: 0.65 }}>· {count}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Phase B.2 — Multi-stage review governance panel.
//
// Wired to:
//   GET  /v1/reviewer-ops/workspace/:workflowId/decisions?teamId=<uuid>
//   POST /v1/reviewer-ops/workspace/:workflowId/decisions
//        body: { teamId, decision, reasonCode?, rationale }
//
// The API enforces every state-machine transition (first → second →
// adjudication), the same-reviewer guard, and the adjudicator role
// check. The UI mirrors the server's `callerContext.nextAction` to
// disable / enable the submit controls. Disabled states always
// explain WHY ("blocked: you submitted the FIRST decision",
// "blocked: only team OWNER/ADMIN can adjudicate", "no action: the
// review is already resolved").
//
// Decision lineage is rendered as a sequence card so reviewers see
// every prior decision (stage + reviewer + decision + reason +
// rationale + timestamp). Decisions cannot be edited or deleted —
// the audit chain is the truth.
// ---------------------------------------------------------------------------

type DecisionKind =
  | "APPROVE"
  | "REJECT"
  | "REQUEST_INFO"
  | "UPHOLD_FIRST"
  | "UPHOLD_SECOND"
  | "NEEDS_MORE_INFO"
  | "UNRESOLVED";

type ReasonCode =
  | "EVIDENCE_INCOMPLETE"
  | "REPORT_FAILED"
  | "INTEGRITY_CONCERN"
  | "CUSTODY_CONCERN"
  | "MISSING_CONTEXT"
  | "LEGAL_HOLD_ISSUE"
  | "REDACTION_REQUIRED"
  | "REVIEWER_DISAGREEMENT"
  | "OTHER";

type ReviewState =
  | "first_required"
  | "second_required"
  | "conflict_detected"
  | "adjudication_required"
  | "resolved";

type NextAction =
  | "submit_first"
  | "submit_second"
  | "submit_adjudication"
  | "blocked_same_reviewer"
  | "blocked_not_adjudicator"
  | "no_action_resolved";

type DecisionRow = {
  id: string;
  stage: "FIRST" | "SECOND" | "ADJUDICATION";
  decision: DecisionKind;
  reasonCode: ReasonCode | null;
  rationale: string;
  decidedAt: string;
  reviewer: {
    userId: string;
    email: string | null;
    displayName: string | null;
  };
};

type DecisionsEnvelope = {
  workflowId: string;
  evidenceId: string;
  state: ReviewState;
  secondReviewRequirement: {
    required: boolean;
    reason: string | null;
  };
  callerContext: {
    userId: string;
    teamRole: string | null;
    isAdjudicator: boolean;
    callerIsFirstReviewer: boolean;
    nextAction: NextAction;
  };
  decisions: DecisionRow[];
};

const STATE_LABELS: Record<ReviewState, string> = {
  first_required: "First review required",
  second_required: "Second review required",
  conflict_detected: "The reviews disagree — adjudication needed",
  adjudication_required: "Adjudication needed",
  resolved: "Review resolved",
};

const STATE_TONE: Record<
  ReviewState,
  { bg: string; border: string; chipBg: string; chipFg: string }
> = {
  first_required: {
    bg: "rgba(99,102,241,0.06)",
    border: "rgba(99,102,241,0.45)",
    chipBg: "rgba(99,102,241,0.22)",
    chipFg: "#312e81",
  },
  second_required: {
    bg: "rgba(245,158,11,0.08)",
    border: "rgba(245,158,11,0.55)",
    chipBg: "rgba(245,158,11,0.22)",
    chipFg: "#78350f",
  },
  conflict_detected: {
    bg: "rgba(239,68,68,0.1)",
    border: "rgba(239,68,68,0.65)",
    chipBg: "rgba(239,68,68,0.3)",
    chipFg: "#7f1d1d",
  },
  adjudication_required: {
    bg: "rgba(239,68,68,0.08)",
    border: "rgba(239,68,68,0.55)",
    chipBg: "rgba(239,68,68,0.22)",
    chipFg: "#7f1d1d",
  },
  resolved: {
    bg: "rgba(34,197,94,0.06)",
    border: "rgba(34,197,94,0.45)",
    chipBg: "rgba(34,197,94,0.22)",
    chipFg: "#14532d",
  },
};

const DECISION_KIND_OPTIONS_FIRST_SECOND: DecisionKind[] = [
  "APPROVE",
  "REJECT",
  "REQUEST_INFO",
  "NEEDS_MORE_INFO",
];
const REASON_CODE_OPTIONS: ReasonCode[] = [
  "EVIDENCE_INCOMPLETE",
  "REPORT_FAILED",
  "INTEGRITY_CONCERN",
  "CUSTODY_CONCERN",
  "MISSING_CONTEXT",
  "LEGAL_HOLD_ISSUE",
  "REDACTION_REQUIRED",
  "REVIEWER_DISAGREEMENT",
  "OTHER",
];

function ReviewerDecisionLineagePanel({
  workflowId,
  teamId,
  refreshKey = 0,
  onLoaded,
  onSubmitDecision,
}: {
  workflowId: string;
  teamId: string;
  /** Bumped by the page after any action, so the lineage rereads. */
  refreshKey?: number;
  /** Lifts what was read, for the approve confirmation and adjudication. */
  onLoaded?: (summary: DecisionsSummary | null) => void;
  /**
   * The page's decisions POST: maps refusals and reloads the workspace and
   * this panel. Resolves to an error message, or null on success.
   */
  onSubmitDecision: (body: { decision: string; reasonCode?: string; rationale: string }) => Promise<string | null>;
}) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; data: DecisionsEnvelope }
    | { kind: "error"; status: number; message: string }
  >({ kind: "loading" });

  // Compose form (only visible when submit is allowed)
  const [composeDecision, setComposeDecision] = useState<DecisionKind | "">("");
  const [composeReason, setComposeReason] = useState<ReasonCode | "">("");
  const [composeRationale, setComposeRationale] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // The page's lift callback, read through a ref so a new arrow on every
  // page render does not re-run the load.
  const onLoadedRef = useRef(onLoaded);
  useEffect(() => {
    onLoadedRef.current = onLoaded;
  });

  const load = useCallback(async () => {
    // A refresh keeps the current lineage on screen instead of flashing to a
    // loading state.
    setState((prev) => (prev.kind === "ready" ? prev : { kind: "loading" }));
    try {
      const data = (await apiFetch(
        `/v1/reviewer-ops/workspace/${encodeURIComponent(workflowId)}/decisions?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      )) as DecisionsEnvelope;
      setState({ kind: "ready", data });
      onLoadedRef.current?.({
        state: data.state,
        secondRequired: Boolean(data.secondReviewRequirement?.required),
        nextAction: data.callerContext.nextAction,
        teamRole: data.callerContext.teamRole,
        decisions: data.decisions,
      });
    } catch (err: unknown) {
      const status =
        typeof (err as { statusCode?: number }).statusCode === "number"
          ? ((err as { statusCode: number }).statusCode)
          : 0;
      const message =
        toSafeUserError(err, { message: "Could not load decisions." }).message;
      setState({ kind: "error", status, message });
      onLoadedRef.current?.(null);
    }
  }, [workflowId, teamId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const submit = useCallback(async () => {
    if (!composeDecision) {
      setSubmitError("Choose a decision.");
      return;
    }
    if (composeRationale.trim().length === 0) {
      setSubmitError("Rationale is required.");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    // The page POSTs, maps the refusal by reason (a stale or out-of-stage
    // decision is never reported as "already resolved") and reloads both the
    // workspace and this panel.
    const failure = await onSubmitDecision({
      decision: composeDecision,
      reasonCode: composeReason || undefined,
      rationale: composeRationale.trim(),
    });
    if (failure) {
      setSubmitError(failure);
    } else {
      setComposeDecision("");
      setComposeReason("");
      setComposeRationale("");
    }
    setSubmitting(false);
  }, [composeDecision, composeReason, composeRationale, onSubmitDecision]);

  if (state.kind === "loading") {
    return (
      <section
        style={{
        background: "var(--surface-standard)",
        border: "1px solid var(--border-standard)",
        borderRadius: "var(--radius-md)",
        padding: 16,
        marginBottom: 12,
      }}
        data-section="reviewer-decision-lineage"
        data-decision-state="loading"
      >
        <h3 className="app-panel__title">Review decisions</h3>
        <div className="app-field-help">Loading review state…</div>
      </section>
    );
  }

  if (state.kind === "error") {
    return (
      <section
        style={{
        background: "var(--surface-standard)",
        border: "1px solid var(--border-standard)",
        borderRadius: "var(--radius-md)",
        padding: 16,
        marginBottom: 12,
      }}
        data-section="reviewer-decision-lineage"
        data-decision-state="error"
      >
        <h3 className="app-panel__title">Review decisions</h3>
        <div role="alert" style={{ fontSize: 13, opacity: 0.85 }}>
          {/* raw-identifier-ok: state.status here is the HTTP status number of a failed read */}
          {state.status === 404
            ? "Workflow not found in this workspace."
            : state.status === 403
              ? "You don't have permission to view review decisions."
              : "Could not load decisions."}
        </div>
      </section>
    );
  }

  const data = state.data;
  const tone = STATE_TONE[data.state] ?? STATE_TONE.first_required;
  const nextAction = data.callerContext.nextAction;
  // First and second decisions only. Adjudication is its own panel, so this
  // form never offers an adjudication kind.
  const canSubmit = nextAction === "submit_first" || nextAction === "submit_second";
  const formStage = nextAction === "submit_first" ? "FIRST" : "SECOND";
  const trigger = data.secondReviewRequirement.reason;

  return (
    <section
      style={{
        border: "1px solid var(--border-standard)",
        borderRadius: "var(--radius-md)",
        padding: 16,
        marginBottom: 12,
        background: tone.bg,
        borderColor: tone.border,
        minWidth: 0,
      }}
      data-section="reviewer-decision-lineage"
      data-decision-state={data.state}
      data-decision-next-action={nextAction}
      data-decision-requires-second={
        data.secondReviewRequirement.required ? "true" : "false"
      }
      data-decision-caller-is-first-reviewer={
        data.callerContext.callerIsFirstReviewer ? "true" : "false"
      }
      data-decision-is-adjudicator={
        data.callerContext.isAdjudicator ? "true" : "false"
      }
    >
      <h3 className="app-panel__title" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        Review decisions
        <span
          data-decision-state-chip={data.state}
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 0.4,
            padding: "2px 8px",
            borderRadius: 999,
            background: tone.chipBg,
            color: tone.chipFg,
          }}
        >
          {STATE_LABELS[data.state] ?? "Review in progress"}
        </span>
      </h3>

      {data.secondReviewRequirement.required ? (
        <div
          data-decision-second-review-reason={trigger ?? undefined}
          style={{ fontSize: 12, marginTop: 2 }}
        >
          A second review is required because{" "}
          {(trigger && SECOND_REVIEW_TRIGGER_LABELS[trigger]) || "workspace policy requires it"}.
        </div>
      ) : (
        <div style={{ fontSize: 12, marginTop: 2, color: "var(--silver-ink)" }}>
          One review decides this review (no policy requires a second review).
        </div>
      )}

      {/* ---- next-action / submit form ---- */}
      {canSubmit ? (
        <form
          data-decision-form
          data-decision-form-stage={formStage}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          style={{
            display: "grid",
            gap: 6,
            marginTop: 10,
            padding: "0.6rem 0.75rem",
            border: "1px solid var(--border-standard)",
            borderRadius: 6,
            background: "var(--surface-standard)",
            minWidth: 0,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 700 }}>
            Record the {formStage === "FIRST" ? "first" : "second"} review decision
          </div>
          <label style={{ fontSize: 12 }} className="app-field-label">
            Decision
            <AppListbox
              value={composeDecision}
              options={[
                { value: "", label: "Choose a decision…" },
                ...DECISION_KIND_OPTIONS_FIRST_SECOND.map((d) => ({ value: d, label: DECISION_OPTION_LABELS[d] ?? d })),
              ]}
              onChange={(next) => setComposeDecision(next as DecisionKind | "")}
              disabled={submitting}
              style={{ marginLeft: 6, maxWidth: "100%" }}
              triggerProps={{ "aria-required": true, "data-decision-form-decision": "" }}
            />
          </label>
          <label style={{ fontSize: 12 }} className="app-field-label">
            Reason (optional but recommended)
            <AppListbox
              value={composeReason}
              options={[
                { value: "", label: "No reason" },
                ...REASON_CODE_OPTIONS.map((r) => ({ value: r, label: REASON_CODE_LABELS[r] ?? r })),
              ]}
              onChange={(next) => setComposeReason(next as ReasonCode | "")}
              disabled={submitting}
              style={{ marginLeft: 6, maxWidth: "100%" }}
              triggerProps={{ "data-decision-form-reason": "" }}
            />
          </label>
          <label className="app-field-label" style={{ fontSize: 12 }}>
            Rationale
            <textarea
              className="app-textarea"
              value={composeRationale}
              onChange={(e) => setComposeRationale(e.target.value)}
              disabled={submitting}
              maxLength={4000}
              rows={3}
              required
              placeholder="Required, up to 4,000 characters. Recorded in the audit log and visible to later reviewers."
              data-decision-form-rationale
              style={{ width: "100%", boxSizing: "border-box", resize: "vertical", minHeight: 60, display: "block", marginTop: 4 }}
            />
          </label>
          {submitError ? (
            <p
              role="alert"
              data-decision-form-error
              className="app-alert app-alert--danger"
              style={{ margin: 0 }}
            >
              {submitError}
            </p>
          ) : null}
          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="app-field-help" style={{ margin: 0 }}>
              {composeRationale.length}/4000
            </span>
            <button
              type="submit"
              disabled={
                submitting ||
                !composeDecision ||
                composeRationale.trim().length === 0
              }
              data-decision-form-submit
              className="app-secondary-action app-secondary-action--filled"
            >
              {submitting ? "Recording…" : "Record decision"}
            </button>
          </div>
        </form>
      ) : (
        <div
          data-decision-blocked-banner={nextAction}
          style={{
            marginTop: 10,
            padding: "0.5rem 0.7rem",
            border: "1px dashed var(--border-strong, currentColor)",
            borderRadius: 6,
            fontSize: 12.5,
          }}
        >
          {nextAction === "blocked_same_reviewer" && (
            <>
              <strong>A different reviewer must decide.</strong> You made the
              first decision, so the second review needs another reviewer —
              reassign it.
            </>
          )}
          {nextAction === "blocked_not_adjudicator" && (
            <>
              <strong>Adjudication needed.</strong> The first and second
              reviews disagree. Only a workspace owner or admin who made
              neither decision can adjudicate (your role:{" "}
              {teamRoleLabel(data.callerContext.teamRole)}).
            </>
          )}
          {nextAction === "submit_adjudication" && (
            <>
              <strong>Adjudication needed.</strong> The first and second
              reviews disagree. Record the outcome in the adjudication panel.
            </>
          )}
          {nextAction === "no_action_resolved" && (
            <>
              <strong>Review resolved.</strong> No further decisions are
              accepted for this round.
            </>
          )}
        </div>
      )}

      {/* ---- decision lineage ---- */}
      {data.decisions.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 0.4,
              textTransform: "uppercase",
              opacity: 0.8,
              marginBottom: 6,
            }}
          >
            Decision lineage ({data.decisions.length})
          </div>
          <ol
            data-decision-lineage
            data-decision-lineage-count={data.decisions.length}
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "grid",
              gap: 6,
            }}
          >
            {data.decisions.map((d, idx) => (
              <li
                key={d.id}
                data-decision-row
                data-decision-stage={d.stage}
                data-decision-kind={d.decision}
                data-decision-reason-code={d.reasonCode ?? ""}
                data-decision-reviewer-id={d.reviewer.userId}
                style={{
                  padding: "0.5rem 0.7rem",
                  border: "1px solid rgba(127,127,127,0.3)",
                  background: "rgba(255,255,255,0.04)",
                  borderRadius: 6,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 6,
                    flexWrap: "wrap",
                    fontSize: 12,
                  }}
                >
                  <div
                    style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}
                  >
                    <span
                      data-decision-stage-chip={d.stage}
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: 0.4,
                        padding: "1px 6px",
                        borderRadius: 4,
                        background: "rgba(127,127,127,0.18)",
                      }}
                    >
                      #{idx + 1} · {STAGE_LABELS[d.stage] ?? identifierLabel(d.stage)}
                    </span>
                    <span
                      data-decision-kind-chip={d.decision}
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: 0.4,
                        padding: "1px 6px",
                        borderRadius: 4,
                        background:
                          d.decision === "APPROVE" ||
                          d.decision === "UPHOLD_FIRST" ||
                          d.decision === "UPHOLD_SECOND"
                            ? "rgba(34,197,94,0.22)"
                            : d.decision === "REJECT"
                              ? "rgba(239,68,68,0.22)"
                              : "rgba(245,158,11,0.22)",
                      }}
                    >
                      {DECISION_KIND_LABELS[d.decision] ?? identifierLabel(d.decision)}
                    </span>
                    {d.reasonCode ? (
                      <span
                        data-decision-reason-chip={d.reasonCode}
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          padding: "1px 6px",
                          borderRadius: 4,
                          background: "rgba(127,127,127,0.12)",
                        }}
                      >
                        {REASON_CODE_LABELS[d.reasonCode] ?? identifierLabel(d.reasonCode)}
                      </span>
                    ) : null}
                    <span style={{ fontWeight: 600 }}>
                      {reviewerName(d.reviewer)}
                    </span>
                  </div>
                  <time dateTime={d.decidedAt} style={{ opacity: 0.75 }}>
                    {formatUserDateTime(d.decidedAt)}
                  </time>
                </div>
                <div
                  data-decision-rationale
                  style={{
                    fontSize: 13,
                    marginTop: 4,
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                  }}
                >
                  {d.rationale}
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <div
          data-decision-lineage-empty
          style={{ marginTop: 10, fontSize: 13, color: "var(--silver-ink)" }}
        >
          No decisions recorded yet for this workflow.
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Phase B.1-3 — Honest deferred-features panel.
//
// The brief explicitly told us to "show honest unavailable state"
// for features whose backend doesn't yet exist. Faking second-review,
// conflict resolution, or evidence-compare would have violated the
// brief's non-negotiable rules.
//
// This panel is the operator-visible truth: what Phase B.1 added,
// and what specifically remains backend-modeling work.
// ---------------------------------------------------------------------------
function ReviewerDeferredFeaturesPanel() {
  return (
    <section
      data-section="reviewer-deferred-features"
      style={{
        border: "1px solid var(--border-standard)",
        borderRadius: "var(--radius-md)",
        padding: 16,
        marginBottom: 12,
        background: "var(--surface-muted)",
      }}
    >
      <h3 className="app-panel__title">Reviewer collaboration scope</h3>
      <p style={{ fontSize: 12, color: "var(--silver-ink)", marginTop: 0 }}>
        What reviewer collaboration supports today, and what is planned.
        Items marked “deferred” are not available yet.
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: 10,
          marginTop: 6,
        }}
      >
        <div
          data-reviewer-deferred-block="available"
          style={{
            padding: "0.6rem 0.75rem",
            border: "1px solid rgba(34,197,94,0.45)",
            background: "rgba(34,197,94,0.06)",
            borderRadius: 6,
            fontSize: 12,
          }}
        >
          <div style={deferredBlockTitleStyle}>Available now</div>
          <ul style={deferredListStyle}>
            <li data-reviewer-deferred-item="structured-notes">
              <strong>Structured reviewer notes</strong> with 7 types
              (observation, concern, request for information, escalation
              context, decision rationale, legal hold context, redaction
              context). Recorded in the workspace activity feed.
            </li>
            <li data-reviewer-deferred-item="decision-audit-chain">
              <strong>Decision audit chain.</strong> Every approval,
              rejection, information request, pause and escalation is
              written to the audit log and the review's history.
            </li>
            <li data-reviewer-deferred-item="rationale-required">
              <strong>Rationale enforcement.</strong> Escalate, pause and
              request information each require a note, for single and bulk
              actions alike.
            </li>
            <li data-reviewer-deferred-item="governance-signals">
              <strong>Governance signals on the review.</strong> Legal
              holds and fields that need redaction are shown here, read-only.
            </li>
            <li data-reviewer-deferred-item="multi-stage-review">
              <strong>Multi-stage review governance.</strong> A review
              moves from first review to second review to adjudication,
              and the same reviewer cannot decide twice. Mismatched
              decisions raise a conflict. Adjudication requires a workspace
              Owner or Admin.
              First, second and adjudication decisions are each recorded
              in the workspace activity feed.
            </li>
            <li data-reviewer-deferred-item="decision-lineage">
              <strong>Decision lineage.</strong> Every decision records
              its stage, type, reason, rationale, reviewer and time. It is
              shown on this review and never overwritten.
            </li>
          </ul>
        </div>
        <div
          data-reviewer-deferred-block="deferred"
          style={{
            padding: "0.6rem 0.75rem",
            border: "1px solid rgba(127,127,127,0.4)",
            background: "rgba(127,127,127,0.04)",
            borderRadius: 6,
            fontSize: 12,
          }}
        >
          <div style={deferredBlockTitleStyle}>Deferred</div>
          <ul style={deferredListStyle}>
            {/* Phase B.2 PROMOTED — second-review + conflict
                 resolution are NOW DELIVERED via the multi-stage
                 review governance panel above. The items below have
                 moved out of "deferred" to "available" in the panel
                 header. */}
            <li data-reviewer-deferred-item="manual-second-review-override">
              <strong>Manual “require second review” override.</strong>{" "}
              A second review is required by policy triggers: escalation,
              legal hold or redaction. A manual override for a single
              review is planned.
            </li>
            <li data-reviewer-deferred-item="senior-reviewer-role">
              <strong>Dedicated senior-reviewer role.</strong>{" "}
              Adjudication uses the workspace Owner and Admin roles. There is
              no separate review-lead role yet.
            </li>
            <li data-reviewer-deferred-item="evidence-compare">
              <strong>Evidence side-by-side compare.</strong> Evidence
              records can be linked to each other; a compare view inside the
              review workspace is not available yet.
            </li>
            <li data-reviewer-deferred-item="search-notes">
              <strong>Full-text note search.</strong> Notes can be filtered by type; full-text search is not
              available yet.
            </li>
            <li data-reviewer-deferred-item="auto-routing">
              <strong>Auto-routing rules engine.</strong> Reviewer
              workload is shown under Reviewer SLA and its suggestions are
              advisory. Reviews are not assigned automatically.
            </li>
            <li data-reviewer-deferred-item="note-edit-delete">
              <strong>Note edit / delete.</strong> The underlying
              EvidenceReviewerComment supports soft-delete +
              resolution; the reviewer-ops UI surface for those is
              not exposed in this phase.
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}

const deferredBlockTitleStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.5,
  textTransform: "uppercase",
  marginBottom: 6,
  opacity: 0.85,
};

const deferredListStyle: React.CSSProperties = {
  margin: 0,
  paddingLeft: "1.1rem",
  display: "grid",
  gap: 5,
};
