"use client";

/**
 * Phase C0 — Reviewer Console.
 *
 * Canonical reviewer workspace consumed by `/review`. Wraps the
 * existing reviewer-ops surface with:
 *
 *   * one aggregator request (`/v1/reviewer-ops/console`) that
 *     returns Queue / Mine / Escalations / SLA / Workload + saved
 *     views in one envelope (Phase C0 server change),
 *   * five operational sub-tabs (Queue · Mine · Escalations · SLA
 *     · Workload),
 *   * keyboard-first navigation: `j` / `k` to move selection,
 *     `Enter` to open the focused row, `a` to assign, `e` to
 *     escalate, `m` to request more info, `/` to focus the in-tab
 *     filter input, `Cmd/Ctrl + K` to open the command palette,
 *   * inline degraded-section badges per the server's
 *     `diagnostics.sectionStatus` so a single failed sub-query
 *     never breaks the rest of the console.
 *
 * Phase G3.2 closure — inline actions live HERE, not in a
 * downstream inspector page:
 *
 *   * Queue + Mine rows expose Assign / Escalate / Request info /
 *     Open inspector buttons.
 *   * Escalations rows expose Acknowledge / Open inspector.
 *   * Mutations go through the existing audited reviewer-ops
 *     endpoints (`/v1/reviewer-ops/reviews/:workflowId/assign`,
 *     `/request-info`, `/v1/reviewer-ops/escalations`,
 *     `/v1/reviewer-ops/escalations/:id/acknowledge`).
 *   * Sensitive mutations route through `useStepUpAction` so the
 *     backend's `enforceStepUpIfFlagged` gate is honoured. No
 *     frontend-only authorization — every action is gated by
 *     `requireReviewerActor` + the workspace step-up flag.
 *   * Approve / Reject remain OFF the inline surface. They live in
 *     the inspector where the full risk + adaptive gate context
 *     renders.
 *   * Rows whose status is terminal (APPROVED / REJECTED / CANCELLED)
 *     have actions disabled — the inspector remains reachable.
 *
 * Saved-view CRUD (also G3.2) — the saved views sidebar now
 * supports Create from current filters + Delete. Rename is not
 * supported (the backend has no PATCH endpoint).
 *
 * Hard rules:
 *   * The console composes existing reviewer-ops endpoints; it does
 *     not invent capability checks client-side.
 *   * Every mutation surfaces a visible loading / error / rollback
 *     state — no silent failures.
 *   * No analytics emission beyond the existing
 *     `REVIEW_SESSION_STARTED` event the legacy reviewer hub fires.
 *   * Vocabulary discipline: every label is operational. The
 *     console never makes claims about factual truth, authorship,
 *     or legal status of the underlying evidence — those words
 *     are explicitly absent.
 */

import { toSafeUserError } from "../../lib/feedback/toSafeUserError";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ReviewerOpsQueueType } from "@proovra/shared";

import { apiFetch } from "../../lib/api";
import { resolveSavedViewQueue } from "../../lib/reviewer-workspace/reviewer-api";
import {
  StepUpModal,
  useStepUpAction,
} from "../identity-security/StepUpModal";
import { useConfirmAction } from "../ui/ConfirmActionModal";
import { ReviewerRoutingRecommendationsPane } from "../hidden-feature-panels/HiddenFeaturePanels";
// Phase 7D — shared enterprise design system. Barrel serves the
// layout primitives; the richer Card / Button / Badge / EmptyState
// are deep-imported (the barrel keeps serving the legacy four).
import { PageShell, PageHeader, PageSection } from "../ui";
import { Card } from "../ui/Card";
import { Button } from "../ui/Button";
import { Badge, type BadgeTone } from "../ui/Badge";
import { EmptyState } from "../ui/EmptyState";

const DEFAULT_TEAM_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";

type ConsoleSectionStatus = "ok" | "degraded";

type ConsoleEnvelope = {
  generatedAt: string;
  teamId: string;
  reviewer: { userId: string; isReviewerCapable: boolean };
  queue: { rows: ReadonlyArray<ConsoleRow>; status: ConsoleSectionStatus; count: number };
  mine: { rows: ReadonlyArray<ConsoleRow>; status: ConsoleSectionStatus; count: number };
  escalations: {
    rows: ReadonlyArray<EscalationRow>;
    status: ConsoleSectionStatus;
    count: number;
  };
  sla: {
    snapshot: SlaSnapshot | null;
    status: ConsoleSectionStatus;
  };
  workload: {
    rows: ReadonlyArray<WorkloadRow>;
    status: ConsoleSectionStatus;
    count: number;
  };
  savedViews: {
    rows: ReadonlyArray<SavedViewRow>;
    status: ConsoleSectionStatus;
    count: number;
  };
  diagnostics: {
    sectionStatus: Record<TabId, ConsoleSectionStatus>;
    sectionLimit: number;
  };
};

type ConsoleRow = {
  // We avoid asserting the exact shape — reviewer-ops queue rows
  // already have a stable projection on the wire. The console
  // renders a minimal column set; the full inspector lives at
  // `/reviewer-ops/[reviewId]`.
  id?: string;
  evidenceId?: string | null;
  reviewerSummary?: string | null;
  priority?: string | null;
  stage?: string | null;
  status?: string | null;
  dueAtUtc?: string | null;
  assignedToUserId?: string | null;
};

type EscalationRow = {
  id?: string;
  workflowId?: string | null;
  reason?: string | null;
  severity?: string | null;
  status?: string | null;
  createdAt?: string | null;
};

type SlaSnapshot = {
  unassigned: number;
  overdue: number;
  dueSoon: number;
  openEscalations: number;
  criticalEscalationsOpen: number;
};

type WorkloadRow = {
  reviewerUserId?: string | null;
  activeAssignments?: number;
  overdueAssignments?: number;
};

type SavedViewRow = {
  id?: string;
  name?: string | null;
  queueType?: string | null;
  filter?: {
    queue?: ReviewerOpsQueueType;
    onlyMine?: boolean;
  };
};

type TabId = "queue" | "mine" | "escalations" | "sla" | "workload";
const TABS: ReadonlyArray<{ id: TabId; label: string; description: string }> = [
  { id: "queue", label: "Queue", description: "Unassigned reviews" },
  { id: "mine", label: "Mine", description: "Assigned to you" },
  {
    id: "escalations",
    label: "Escalations",
    description: "Open + acknowledged",
  },
  { id: "sla", label: "SLA", description: "Breach + due-soon rollup" },
  { id: "workload", label: "Workload", description: "Reviewer capacity" },
];

/**
 * Terminal workflow statuses — no inline mutation buttons render
 * for these. The inspector remains reachable so reviewers can still
 * audit the closed item.
 */
const TERMINAL_STATUSES = new Set([
  "APPROVED",
  "REJECTED",
  "CANCELLED",
  "DESTROYED",
  "TOMBSTONED",
]);

function isRowActionable(row: ConsoleRow): boolean {
  if (!row.id) return false;
  const s = (row.status ?? "").toUpperCase();
  return !TERMINAL_STATUSES.has(s);
}

// ---------------------------------------------------------------------------
// Phase 7D — presentational tone mapping for the shared <Badge>. These map
// the OPERATIONAL status / priority / severity vocabulary onto the design
// system's semantic tones. They never change WHICH value renders — a null
// value still renders the honest "—" placeholder, never a fabricated chip.
// ---------------------------------------------------------------------------

function severityTone(severity: string | null | undefined): BadgeTone {
  switch ((severity ?? "").toUpperCase()) {
    case "CRITICAL":
    case "HIGH":
      return "risk";
    case "WARNING":
      return "pending";
    case "INFO":
      return "info";
    default:
      return "neutral";
  }
}

function priorityTone(priority: string | null | undefined): BadgeTone {
  switch ((priority ?? "").toUpperCase()) {
    case "CRITICAL":
    case "URGENT":
    case "HIGH":
      return "risk";
    case "MEDIUM":
      return "pending";
    case "LOW":
      return "info";
    default:
      return "neutral";
  }
}

function statusTone(status: string | null | undefined): BadgeTone {
  const s = (status ?? "").toUpperCase();
  if (s === "APPROVED") return "verified";
  if (s === "REJECTED" || s === "CANCELLED" || s === "DESTROYED" || s === "TOMBSTONED") {
    return "risk";
  }
  if (s === "ACKNOWLEDGED" || s === "RESOLVED" || s === "SUPPRESSED") {
    return "verified";
  }
  if (s === "OPEN" || s.includes("PENDING") || s.includes("PROGRESS")) {
    return "pending";
  }
  return "neutral";
}

/**
 * Bounded reason set for the inline-escalation modal. Matches the
 * shared `REVIEW_ESCALATION_REASONS` vocabulary on the backend so
 * the operator never has to invent a reason.
 */
const ESCALATION_REASONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "POLICY_BREACH", label: "Policy breach" },
  { id: "REVIEWER_INACTIVE", label: "Reviewer inactive" },
  { id: "SLA_BREACH_IMMINENT", label: "SLA breach imminent" },
  { id: "QUALITY_CONCERN", label: "Quality concern" },
  { id: "MANUAL_OPERATOR", label: "Manual operator raise" },
];

const ESCALATION_SEVERITIES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "INFO", label: "Info" },
  { id: "WARNING", label: "Warning" },
  { id: "HIGH", label: "High" },
  { id: "CRITICAL", label: "Critical" },
];

export type ReviewerConsoleProps = {
  /**
   * The active reviewer workspace (Team) id resolved from
   * `ctx.activeSpace` upstream. When null, the component renders
   * the operator-safe "no workspace" panel rather than firing
   * a request with a placeholder.
   */
  teamId: string | null;
  /** Open the upstream evidence detail surface in a new view. */
  onOpenRow?: (row: ConsoleRow | EscalationRow) => void;
};

export function ReviewerConsole({
  teamId,
  onOpenRow,
}: ReviewerConsoleProps) {
  const [envelope, setEnvelope] = useState<ConsoleEnvelope | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("queue");
  const [selectionIndex, setSelectionIndex] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [actionState, setActionState] = useState<ActionState>({ kind: "idle" });
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusyKey, setActionBusyKey] = useState<string | null>(null);
  const [actionFlash, setActionFlash] = useState<string | null>(null);
  // G3.2 — per-tab pagination. The aggregator caps every section at
  // SECTION_LIMIT=25; once the operator clicks "Load more" or "View
  // all" we fall through to the per-tab endpoint with a higher
  // bounded limit. The aggregator stays unchanged so the initial
  // render remains fast.
  const [pagination, setPagination] = useState<
    Record<PaginatedTab, TabPagination>
  >(() => buildInitialPagination());
  const filterInputRef = useRef<HTMLInputElement | null>(null);

  // G3.2 — step-up control wired into the inline-action flow. The
  // workspace flag drives when the backend returns 401
  // STEP_UP_REQUIRED; the hook surfaces the modal + retries once.
  const stepUp = useStepUpAction({ teamId });

  // Reload the envelope on tab open / workspace switch. The
  // server already bounds every section; we never paginate the
  // envelope itself.
  const reload = useCallback(async () => {
    if (!teamId) {
      setEnvelope(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const json = (await apiFetch(
        `/v1/reviewer-ops/console?teamId=${encodeURIComponent(teamId)}`,
      )) as ConsoleEnvelope;
      setEnvelope(json);
      // Pagination is reset on reload — extended rows would be
      // stale after a mutation. The operator can click Load more
      // again to re-page; the action that triggered the reload
      // wanted fresh data.
      setPagination(buildInitialPagination());
      setSelectionIndex(0);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message.slice(0, 200)
          : "Reviewer console failed to load.",
      );
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const activeRows = useMemo<
    ReadonlyArray<ConsoleRow | EscalationRow | WorkloadRow>
  >(() => {
    if (!envelope) return [];
    // Phase G3.2 — once the operator paginates, the per-tab extended
    // row set replaces the aggregator's bounded slice for that tab.
    if (activeTab === "queue") {
      return (
        (pagination.queue.extendedRows as ReadonlyArray<ConsoleRow>) ??
        envelope.queue.rows
      );
    }
    if (activeTab === "mine") {
      return (
        (pagination.mine.extendedRows as ReadonlyArray<ConsoleRow>) ??
        envelope.mine.rows
      );
    }
    if (activeTab === "escalations") {
      return (
        (pagination.escalations.extendedRows as ReadonlyArray<EscalationRow>) ??
        envelope.escalations.rows
      );
    }
    if (activeTab === "workload") {
      return (
        (pagination.workload.extendedRows as ReadonlyArray<WorkloadRow>) ??
        envelope.workload.rows
      );
    }
    return [];
  }, [envelope, activeTab, pagination]);

  // ---------------------------------------------------------------------------
  // Mutating action runners — every path goes through `useStepUpAction`'s
  // `runStepUpAction` wrapper so a 401 STEP_UP_REQUIRED is intercepted by
  // the modal and the original call is retried with the challenge header.
  // ---------------------------------------------------------------------------

  const flash = useCallback((msg: string) => {
    setActionFlash(msg);
    setTimeout(() => setActionFlash(null), 4000);
  }, []);

  const runAssign = useCallback(
    async (workflowId: string, assignedToUserId: string, note: string | null) => {
      if (!teamId) return;
      const key = `assign:${workflowId}`;
      setActionBusyKey(key);
      setActionError(null);
      try {
        await stepUp.runStepUpAction(async (headers) => {
          return await apiFetch(
            `/v1/reviewer-ops/reviews/${encodeURIComponent(workflowId)}/assign`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", ...(headers ?? {}) },
              body: JSON.stringify({
                teamId,
                assignedToUserId,
                note: note && note.length > 0 ? note : null,
              }),
            },
          );
        });
        setActionState({ kind: "idle" });
        flash("Reviewer assigned.");
        await reload();
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "STEP_UP_CANCEL") {
          setActionError("Step-up cancelled — assignment not saved.");
        } else {
          setActionError(
            toSafeUserError(err, { message: "Could not assign reviewer." }).message,
          );
        }
      } finally {
        setActionBusyKey(null);
      }
    },
    [flash, reload, stepUp, teamId],
  );

  const runRequestInfo = useCallback(
    async (workflowId: string, note: string) => {
      if (!teamId) return;
      const key = `request-info:${workflowId}`;
      setActionBusyKey(key);
      setActionError(null);
      try {
        await stepUp.runStepUpAction(async (headers) => {
          return await apiFetch(
            `/v1/reviewer-ops/reviews/${encodeURIComponent(workflowId)}/request-info`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", ...(headers ?? {}) },
              body: JSON.stringify({ teamId, note }),
            },
          );
        });
        setActionState({ kind: "idle" });
        flash("Information requested.");
        await reload();
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "STEP_UP_CANCEL") {
          setActionError("Step-up cancelled — request not sent.");
        } else {
          setActionError(
            toSafeUserError(err, { message: "Could not request information." }).message,
          );
        }
      } finally {
        setActionBusyKey(null);
      }
    },
    [flash, reload, stepUp, teamId],
  );

  const runEscalate = useCallback(
    async (
      workflowId: string,
      reason: string,
      severity: string,
      safeSummary: string,
    ) => {
      if (!teamId) return;
      const key = `escalate:${workflowId}`;
      setActionBusyKey(key);
      setActionError(null);
      try {
        await stepUp.runStepUpAction(async (headers) => {
          return await apiFetch("/v1/reviewer-ops/escalations", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(headers ?? {}) },
            body: JSON.stringify({
              teamId,
              workflowId,
              reason,
              severity,
              safeSummary,
            }),
          });
        });
        setActionState({ kind: "idle" });
        flash("Escalation raised.");
        await reload();
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "STEP_UP_CANCEL") {
          setActionError("Step-up cancelled — escalation not raised.");
        } else {
          setActionError(
            toSafeUserError(err, { message: "Could not raise escalation." }).message,
          );
        }
      } finally {
        setActionBusyKey(null);
      }
    },
    [flash, reload, stepUp, teamId],
  );

  // ---------------------------------------------------------------------------
  // Pagination runners — fetch the per-tab endpoint with a bounded
  // higher limit. The aggregator stays unchanged so the initial paint
  // remains fast; this only fires when the operator clicks Load more
  // or View all.
  // ---------------------------------------------------------------------------

  const fetchExtendedRows = useCallback(
    async (tab: PaginatedTab, nextLimit: number) => {
      if (!teamId) return;
      const capped = Math.min(nextLimit, TAB_LIMIT_CAPS[tab]);
      setPagination((p) => ({
        ...p,
        [tab]: { ...p[tab], loading: true, error: null, limit: capped },
      }));
      try {
        let extendedRows:
          | ReadonlyArray<ConsoleRow>
          | ReadonlyArray<EscalationRow>
          | ReadonlyArray<WorkloadRow> = [];
        let hasMore = false;
        if (tab === "queue" || tab === "mine") {
          const queueType = tab === "queue" ? "UNASSIGNED" : "MY_REVIEWS";
          const json = (await apiFetch(
            `/v1/reviewer-ops/queue?teamId=${encodeURIComponent(teamId)}&queue=${queueType}&limit=${capped}`,
          )) as { rows: ReadonlyArray<ConsoleRow>; nextCursor: string | null };
          extendedRows = json.rows ?? [];
          hasMore =
            json.nextCursor !== null && capped < TAB_LIMIT_CAPS[tab];
        } else if (tab === "escalations") {
          const json = (await apiFetch(
            `/v1/reviewer-ops/escalations?teamId=${encodeURIComponent(teamId)}&limit=${capped}`,
          )) as { escalations: ReadonlyArray<EscalationRow> };
          extendedRows = json.escalations ?? [];
          // No cursor on this endpoint — pagination is purely
          // limit-driven and bounded by TAB_LIMIT_CAPS.
          hasMore = extendedRows.length >= capped && capped < TAB_LIMIT_CAPS[tab];
        } else if (tab === "workload") {
          const json = (await apiFetch(
            `/v1/reviewer-ops/workload?teamId=${encodeURIComponent(teamId)}&limit=${capped}`,
          )) as { snapshots: ReadonlyArray<WorkloadRow> };
          extendedRows = json.snapshots ?? [];
          hasMore = extendedRows.length >= capped && capped < TAB_LIMIT_CAPS[tab];
        }
        setPagination((p) => ({
          ...p,
          [tab]: {
            extendedRows,
            limit: capped,
            hasMore,
            loading: false,
            error: null,
          },
        }));
      } catch (err) {
        setPagination((p) => ({
          ...p,
          [tab]: {
            ...p[tab],
            loading: false,
            error:
              toSafeUserError(err, { message: "Could not load more rows." }).message,
          },
        }));
      }
    },
    [teamId],
  );

  const loadMore = useCallback(
    (tab: PaginatedTab) => {
      const next = pagination[tab].limit + PAGE_STEP;
      void fetchExtendedRows(tab, next);
    },
    [fetchExtendedRows, pagination],
  );

  const viewAll = useCallback(
    (tab: PaginatedTab) => {
      void fetchExtendedRows(tab, TAB_LIMIT_CAPS[tab]);
    },
    [fetchExtendedRows],
  );

  const resetPagination = useCallback((tab: PaginatedTab) => {
    setPagination((p) => ({ ...p, [tab]: emptyPagination() }));
  }, []);

  const runAcknowledge = useCallback(
    async (escalationId: string) => {
      if (!teamId) return;
      const key = `ack:${escalationId}`;
      setActionBusyKey(key);
      setActionError(null);
      try {
        await stepUp.runStepUpAction(async (headers) => {
          return await apiFetch(
            `/v1/reviewer-ops/escalations/${encodeURIComponent(escalationId)}/acknowledge`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", ...(headers ?? {}) },
              body: JSON.stringify({ teamId }),
            },
          );
        });
        flash("Escalation acknowledged.");
        await reload();
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "STEP_UP_CANCEL") {
          setActionError("Step-up cancelled — acknowledgement not saved.");
        } else {
          setActionError(
            toSafeUserError(err, { message: "Could not acknowledge escalation." }).message,
          );
        }
      } finally {
        setActionBusyKey(null);
      }
    },
    [flash, reload, stepUp, teamId],
  );

  /**
   * Keyboard navigation. Bounded action list:
   *   * j / k         — move selection within the active tab
   *   * Enter         — open the focused row (delegates to
   *                     `onOpenRow`)
   *   * a             — assign the focused queue/mine row
   *   * e             — escalate the focused queue/mine row
   *   * m             — request more info on the focused
   *                     queue/mine row
   *   * /             — focus the in-tab filter input
   *   * Cmd/Ctrl + K  — open the reviewer command palette
   *
   * Approve / Reject are intentionally NOT inline-keyboard-bound —
   * those flows live in the inspector where the full risk + adaptive
   * gate context renders.
   */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Avoid swallowing keys that the user is typing into a real
      // input — the filter / palette / action modals / future inline edits.
      const tgt = e.target as HTMLElement | null;
      const inField =
        tgt &&
        (tgt.tagName === "INPUT" ||
          tgt.tagName === "TEXTAREA" ||
          tgt.isContentEditable);
      if (actionState.kind !== "idle") {
        // While a modal is open, only Escape closes it; let the modal
        // forms own their own input keys.
        if (e.key === "Escape") {
          setActionState({ kind: "idle" });
          e.preventDefault();
        }
        return;
      }
      if (paletteOpen) {
        if (e.key === "Escape") {
          setPaletteOpen(false);
          e.preventDefault();
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (inField) return;
      if (e.key === "j") {
        setSelectionIndex((i) => Math.min(i + 1, activeRows.length - 1));
        e.preventDefault();
        return;
      }
      if (e.key === "k") {
        setSelectionIndex((i) => Math.max(i - 1, 0));
        e.preventDefault();
        return;
      }
      if (e.key === "Enter") {
        const row = activeRows[selectionIndex];
        if (row && onOpenRow) {
          onOpenRow(row as ConsoleRow);
        }
        e.preventDefault();
        return;
      }
      if (e.key === "/") {
        filterInputRef.current?.focus();
        e.preventDefault();
        return;
      }
      // G3.2 inline-action shortcuts. Only fire on queue/mine tabs
      // where the focused row is a workflow row, and only when the
      // row is actionable (not terminal).
      const lower = e.key.toLowerCase();
      if (lower === "a" || lower === "e" || lower === "m") {
        if (activeTab !== "queue" && activeTab !== "mine") return;
        const row = activeRows[selectionIndex] as ConsoleRow | undefined;
        if (!row || !row.id || !isRowActionable(row)) return;
        e.preventDefault();
        if (lower === "a") {
          setActionState({ kind: "assign", workflowId: row.id });
        } else if (lower === "e") {
          setActionState({ kind: "escalate", workflowId: row.id });
        } else if (lower === "m") {
          setActionState({ kind: "requestInfo", workflowId: row.id });
        }
      }
    },
    [activeRows, activeTab, actionState.kind, onOpenRow, paletteOpen, selectionIndex],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // Canonical row padding. (2026-07-20) The compact/comfortable/
  // spacious density modes were removed with the workspace-persona /
  // operational-density feature; the comfortable value is now the base.
  const rowPad = "10px 14px";

  if (!teamId) {
    return (
      <PageShell
        className="reviewer-console reviewer-console--no-workspace"
        header={
          <PageHeader
            eyebrow="Reviewer operations"
            title="Review Operations Console"
          />
        }
      >
        <Card variant="empty" padding="none">
          <EmptyState
            title="Reviewer Console is workspace-scoped"
            purpose="Switch into a team workspace from the top-bar workspace switcher to open the queue."
          />
        </Card>
      </PageShell>
    );
  }

  return (
    <PageShell
      className="reviewer-console"
      data-active-tab={activeTab}
      header={
        <PageHeader
          eyebrow="Reviewer operations"
          title="Review Operations Console"
          subtitle={
            <>
              Monitor and manage review operations here. Daily evidence
              decisions happen in Reviewer Workspace. Keyboard:{" "}
              <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>Enter</kbd> open ·{" "}
              <kbd>a</kbd> assign · <kbd>e</kbd> escalate · <kbd>m</kbd>{" "}
              request info · <kbd>/</kbd> filter · <kbd>Cmd</kbd>+<kbd>K</kbd>{" "}
              palette.
            </>
          }
          contextStrip={
            <div
              className="reviewer-console__ia-strip"
              data-reviewer-console-ia
              style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
            >
              <a href="/review/workspace">Work: Reviewer Workspace</a>
              <a href="/review/queues?queue=UNASSIGNED">
                Manage: Reviewer Queues
              </a>
              <a href="/reviewer-ops/sla">Monitor: SLA Operations</a>
              <a href="/reviewer-ops/escalations">Respond: Escalations</a>
            </div>
          }
          primaryAction={
            <Button
              variant="primary"
              onClick={() => setPaletteOpen(true)}
              data-reviewer-command-palette-open
            >
              Command palette
            </Button>
          }
        />
      }
    >
      {/* Phase Final-Hidden-Feature-Surfacing — routing recommendations
          pane. Reads the canonical reviewer-routing recommendation
          rows via the new `/v1/reviewer/routing-recommendations`
          endpoint. Pane stays above the tabbed sections so guidance
          surfaces even when the reviewer hasn't drilled into a tab. */}
      {teamId ? (
        <ReviewerRoutingRecommendationsPane teamId={teamId} />
      ) : null}

      <nav
        className="reviewer-console__tabs"
        role="tablist"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 10,
        }}
      >
        {TABS.map((t) => {
          const status =
            envelope?.diagnostics.sectionStatus[t.id] ?? "ok";
          const active = activeTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => {
                setActiveTab(t.id);
                setSelectionIndex(0);
              }}
              data-section-status={status}
              data-tab-id={t.id}
              style={{
                textAlign: "left",
                border: active
                  ? "1px solid var(--ink-primary, #0f172a)"
                  : "1px solid var(--border-default, rgba(15,23,42,0.09))",
                boxShadow: active
                  ? "inset 0 0 0 1px var(--ink-primary, #0f172a)"
                  : "var(--shadow-card, 0 1px 2px rgba(15,23,42,0.04))",
                background: "var(--surface-card, #fff)",
                borderRadius: "var(--radius-card, 14px)",
                padding: "10px 12px",
                display: "grid",
                gap: 4,
                cursor: "pointer",
                color: "var(--ink-primary, #0f172a)",
              }}
            >
              <strong>{t.label}</strong>
              <span
                style={{
                  color: "var(--ink-muted, #64748b)",
                  fontSize: 12,
                }}
              >
                {t.description}
              </span>
              {status === "degraded" ? (
                <Badge
                  tone="pending"
                  style={{ justifySelf: "start" }}
                  title="This section failed to load; other tabs are unaffected."
                >
                  Degraded
                </Badge>
              ) : null}
            </button>
          );
        })}
      </nav>

      {loading ? (
        <Card
          variant="admin"
          padding="compact"
          data-reviewer-console-status
          style={{ color: "var(--ink-secondary, #475569)" }}
        >
          Loading reviewer console…
        </Card>
      ) : null}
      {error ? (
        <Card
          variant="status"
          tone="risk"
          padding="compact"
          role="alert"
          style={{ color: "var(--status-risk-fg, #7f1d1d)" }}
        >
          {error}
        </Card>
      ) : null}

      {actionError ? (
        <Card
          variant="status"
          tone="risk"
          padding="compact"
          role="alert"
          data-reviewer-action-error
          style={{ color: "var(--status-risk-fg, #7f1d1d)" }}
        >
          {actionError}
        </Card>
      ) : null}
      {actionFlash ? (
        <Card
          variant="status"
          tone="verified"
          padding="compact"
          role="status"
          data-reviewer-action-flash
          style={{ color: "var(--status-verified-fg, #166534)" }}
        >
          {actionFlash}
        </Card>
      ) : null}

      {envelope ? (
        <>
          {/* In-tab filter — `/` focuses this input. The actual
              filter logic lives upstream in the per-domain endpoints
              for deep drill; the console-level input is bounded to
              row.id / reviewer summary prefix matching. Kept as a
              token-styled input (not FilterBar.Search) because the
              `/` shortcut focuses this exact ref. */}
          <div className="reviewer-console__filter">
            <input
              ref={filterInputRef}
              type="text"
              placeholder="Filter visible rows (press /)…"
              aria-label="Filter visible rows"
              style={{
                width: "100%",
                minHeight: 40,
                padding: "0 12px",
                fontSize: 13.5,
                color: "var(--ink-primary, #0f172a)",
                background: "var(--surface-card, #fff)",
                border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
                borderRadius: "var(--radius-md, 8px)",
                outline: "none",
              }}
            />
          </div>

          {activeTab === "sla" ? (
            <SlaPanel snapshot={envelope.sla.snapshot} />
          ) : activeTab === "workload" ? (
            <>
              <WorkloadTable
                rows={
                  (pagination.workload.extendedRows as
                    | ReadonlyArray<WorkloadRow>
                    | null) ?? envelope.workload.rows
                }
                rowPad={rowPad}
                selectionIndex={selectionIndex}
              />
              <PaginationFooter
                tab="workload"
                state={pagination.workload}
                cap={TAB_LIMIT_CAPS.workload}
                onLoadMore={() => loadMore("workload")}
                onViewAll={() => viewAll("workload")}
                onReset={() => resetPagination("workload")}
              />
            </>
          ) : activeTab === "escalations" ? (
            <>
              <EscalationsTable
                rows={
                  (pagination.escalations.extendedRows as
                    | ReadonlyArray<EscalationRow>
                    | null) ?? envelope.escalations.rows
                }
                rowPad={rowPad}
                selectionIndex={selectionIndex}
                onOpen={onOpenRow}
                busyKey={actionBusyKey}
                onAcknowledge={(row) => {
                  if (row.id) void runAcknowledge(row.id);
                }}
              />
              <PaginationFooter
                tab="escalations"
                state={pagination.escalations}
                cap={TAB_LIMIT_CAPS.escalations}
                onLoadMore={() => loadMore("escalations")}
                onViewAll={() => viewAll("escalations")}
                onReset={() => resetPagination("escalations")}
              />
            </>
          ) : (
            <>
              <QueueTable
                rows={
                  activeTab === "queue"
                    ? ((pagination.queue.extendedRows as
                        | ReadonlyArray<ConsoleRow>
                        | null) ?? envelope.queue.rows)
                    : ((pagination.mine.extendedRows as
                        | ReadonlyArray<ConsoleRow>
                        | null) ?? envelope.mine.rows)
                }
                rowPad={rowPad}
                selectionIndex={selectionIndex}
                onOpen={onOpenRow}
                busyKey={actionBusyKey}
                onAssign={(row) => {
                  if (row.id) setActionState({ kind: "assign", workflowId: row.id });
                }}
                onEscalate={(row) => {
                  if (row.id) setActionState({ kind: "escalate", workflowId: row.id });
                }}
                onRequestInfo={(row) => {
                  if (row.id)
                    setActionState({ kind: "requestInfo", workflowId: row.id });
                }}
              />
              <PaginationFooter
                tab={activeTab === "queue" ? "queue" : "mine"}
                state={
                  activeTab === "queue" ? pagination.queue : pagination.mine
                }
                cap={
                  activeTab === "queue"
                    ? TAB_LIMIT_CAPS.queue
                    : TAB_LIMIT_CAPS.mine
                }
                onLoadMore={() =>
                  loadMore(activeTab === "queue" ? "queue" : "mine")
                }
                onViewAll={() =>
                  viewAll(activeTab === "queue" ? "queue" : "mine")
                }
                onReset={() =>
                  resetPagination(activeTab === "queue" ? "queue" : "mine")
                }
              />
            </>
          )}

          {/* G3.2 — Saved views sidebar with Create + Delete + Apply.
              Rename is not supported (no backend PATCH endpoint). */}
          <SavedViewsPanel
            teamId={teamId}
            views={envelope.savedViews.rows}
            onChanged={() => void reload()}
          />
        </>
      ) : null}

      {actionState.kind === "assign" ? (
        <AssignModal
          workflowId={actionState.workflowId}
          busy={actionBusyKey === `assign:${actionState.workflowId}`}
          onCancel={() => setActionState({ kind: "idle" })}
          onSubmit={(assigneeUserId, note) =>
            void runAssign(actionState.workflowId, assigneeUserId, note)
          }
        />
      ) : null}
      {actionState.kind === "escalate" ? (
        <EscalateModal
          workflowId={actionState.workflowId}
          busy={actionBusyKey === `escalate:${actionState.workflowId}`}
          onCancel={() => setActionState({ kind: "idle" })}
          onSubmit={(reason, severity, summary) =>
            void runEscalate(actionState.workflowId, reason, severity, summary)
          }
        />
      ) : null}
      {actionState.kind === "requestInfo" ? (
        <RequestInfoModal
          workflowId={actionState.workflowId}
          busy={
            actionBusyKey === `request-info:${actionState.workflowId}`
          }
          onCancel={() => setActionState({ kind: "idle" })}
          onSubmit={(note) =>
            void runRequestInfo(actionState.workflowId, note)
          }
        />
      ) : null}

      {paletteOpen ? (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onSwitchTab={(t) => {
            setActiveTab(t);
            setSelectionIndex(0);
            setPaletteOpen(false);
          }}
        />
      ) : null}

      {/* Step-up modal — surfaces only when a mutation hits the
          backend's STEP_UP_REQUIRED gate. Otherwise it stays
          dormant. */}
      <StepUpModal control={stepUp} />
      <style jsx>{reviewerConsoleStyles}</style>
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// Action state machine — drives which (if any) inline-action modal renders.
// ---------------------------------------------------------------------------

type ActionState =
  | { kind: "idle" }
  | { kind: "assign"; workflowId: string }
  | { kind: "escalate"; workflowId: string }
  | { kind: "requestInfo"; workflowId: string };

// ---------------------------------------------------------------------------
// G3.2 — Pagination. Each tab tracks its own bounded "extended" view
// once the operator chooses to look past the aggregator's 25-row cap.
// ---------------------------------------------------------------------------

type PaginatedTab = "queue" | "mine" | "escalations" | "workload";

type TabPagination = {
  /**
   * Rows currently displayed in place of the aggregator's slice. Null
   * means the operator has not paginated — the aggregator's bounded
   * 25-row sample is in effect.
   */
  extendedRows:
    | ReadonlyArray<ConsoleRow>
    | ReadonlyArray<EscalationRow>
    | ReadonlyArray<WorkloadRow>
    | null;
  limit: number;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
};

const PAGE_STEP = 25;
const TAB_LIMIT_CAPS: Record<PaginatedTab, number> = {
  queue: 100,
  mine: 100,
  escalations: 200,
  workload: 200,
};

function buildInitialPagination(): Record<PaginatedTab, TabPagination> {
  return {
    queue: emptyPagination(),
    mine: emptyPagination(),
    escalations: emptyPagination(),
    workload: emptyPagination(),
  };
}

function emptyPagination(): TabPagination {
  return {
    extendedRows: null,
    limit: PAGE_STEP,
    hasMore: true,
    loading: false,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Tables — now with an Actions column on queue/mine + escalations.
// ---------------------------------------------------------------------------

function QueueTable({
  rows,
  rowPad,
  selectionIndex,
  onOpen,
  onAssign,
  onEscalate,
  onRequestInfo,
  busyKey,
}: {
  rows: ReadonlyArray<ConsoleRow>;
  rowPad: string;
  selectionIndex: number;
  onOpen?: (row: ConsoleRow) => void;
  onAssign: (row: ConsoleRow) => void;
  onEscalate: (row: ConsoleRow) => void;
  onRequestInfo: (row: ConsoleRow) => void;
  busyKey: string | null;
}) {
  if (rows.length === 0) {
    return (
      <Card variant="empty" padding="none" className="reviewer-console__empty">
        <EmptyState
          title="No reviews in this slice"
          purpose="No reviews match this slice right now. Use the queue links above to switch between daily work, unassigned triage, and escalations, or save a queue view once this workspace has active reviews."
        />
      </Card>
    );
  }
  return (
    <div style={reviewerTableScrollStyle}>
      <table role="grid" style={reviewerTableStyle}>
        <thead>
          <tr>
            <th style={reviewerThStyle}>Evidence</th>
            <th style={reviewerThStyle}>Stage</th>
            <th style={reviewerThStyle}>Status</th>
            <th style={reviewerThStyle}>Priority</th>
            <th style={reviewerThStyle}>Due</th>
            <th style={reviewerThStyle}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => {
            const selected = idx === selectionIndex;
            const actionable = isRowActionable(row);
            const wid = row.id ?? "";
            const assignBusy = busyKey === `assign:${wid}`;
            const escalateBusy = busyKey === `escalate:${wid}`;
            const reqInfoBusy = busyKey === `request-info:${wid}`;
            return (
              <tr
                key={row.id ?? `row-${idx}`}
                data-selected={selected}
                data-reviewer-row-actionable={actionable ? "true" : "false"}
                style={reviewerRowStyle(selected)}
              >
                <td style={{ padding: rowPad, ...reviewerTdStyle }}>
                  {row.reviewerSummary ?? row.evidenceId ?? row.id ?? "—"}
                </td>
                <td style={{ padding: rowPad, ...reviewerTdStyle }}>
                  {row.stage ?? "—"}
                </td>
                <td style={{ padding: rowPad, ...reviewerTdStyle }}>
                  {row.status ? (
                    <Badge tone={statusTone(row.status)} subtle>
                      {row.status}
                    </Badge>
                  ) : (
                    "—"
                  )}
                </td>
                <td style={{ padding: rowPad, ...reviewerTdStyle }}>
                  {row.priority ? (
                    <Badge tone={priorityTone(row.priority)} subtle>
                      {row.priority}
                    </Badge>
                  ) : (
                    "—"
                  )}
                </td>
                <td style={{ padding: rowPad, ...reviewerTdStyle }}>
                  {row.dueAtUtc ?? "—"}
                </td>
                <td style={{ padding: rowPad, ...reviewerTdStyle }}>
                  <div
                    data-reviewer-row-actions={wid}
                    style={{ display: "flex", gap: 6, flexWrap: "wrap" }}
                  >
                    <Button
                      size="sm"
                      variant="secondary"
                      data-reviewer-action="assign"
                      data-reviewer-workflow-id={wid}
                      disabled={!actionable}
                      loading={assignBusy}
                      onClick={() => onAssign(row)}
                      title="Assign reviewer (a)"
                    >
                      {assignBusy ? "Assigning…" : "Assign"}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      data-reviewer-action="escalate"
                      data-reviewer-workflow-id={wid}
                      disabled={!actionable}
                      loading={escalateBusy}
                      onClick={() => onEscalate(row)}
                      title="Raise escalation (e)"
                    >
                      {escalateBusy ? "Raising…" : "Escalate"}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      data-reviewer-action="request-info"
                      data-reviewer-workflow-id={wid}
                      disabled={!actionable}
                      loading={reqInfoBusy}
                      onClick={() => onRequestInfo(row)}
                      title="Request more info (m)"
                    >
                      {reqInfoBusy ? "Requesting…" : "Request info"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      data-reviewer-action="open-inspector"
                      data-reviewer-workflow-id={wid}
                      onClick={() => onOpen?.(row)}
                      title="Open reviewer inspector (Enter)"
                    >
                      Open inspector
                    </Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EscalationsTable({
  rows,
  rowPad,
  selectionIndex,
  onOpen,
  onAcknowledge,
  busyKey,
}: {
  rows: ReadonlyArray<EscalationRow>;
  rowPad: string;
  selectionIndex: number;
  onOpen?: (row: EscalationRow) => void;
  onAcknowledge: (row: EscalationRow) => void;
  busyKey: string | null;
}) {
  if (rows.length === 0) {
    return (
      <Card variant="empty" padding="none" className="reviewer-console__empty">
        <EmptyState
          title="No open escalations"
          purpose="No escalations are open. This usually means no review is currently blocked, overdue enough to escalate, or manually raised by an operator."
        />
      </Card>
    );
  }
  return (
    <div style={reviewerTableScrollStyle}>
      <table role="grid" style={reviewerTableStyle}>
        <thead>
          <tr>
            <th style={reviewerThStyle}>Workflow</th>
            <th style={reviewerThStyle}>Severity</th>
            <th style={reviewerThStyle}>Status</th>
            <th style={reviewerThStyle}>Reason</th>
            <th style={reviewerThStyle}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => {
            const selected = idx === selectionIndex;
            const eid = row.id ?? "";
            const ackBusy = busyKey === `ack:${eid}`;
            const ackable =
              !!row.id &&
              (row.status ?? "OPEN").toUpperCase() !== "ACKNOWLEDGED" &&
              (row.status ?? "OPEN").toUpperCase() !== "RESOLVED" &&
              (row.status ?? "OPEN").toUpperCase() !== "SUPPRESSED";
            return (
              <tr
                key={row.id ?? `esc-${idx}`}
                data-selected={selected}
                style={reviewerRowStyle(selected)}
              >
                <td style={{ padding: rowPad, ...reviewerTdStyle }}>
                  {row.workflowId ?? row.id ?? "—"}
                </td>
                <td style={{ padding: rowPad, ...reviewerTdStyle }}>
                  {row.severity ? (
                    <Badge tone={severityTone(row.severity)} subtle>
                      {row.severity}
                    </Badge>
                  ) : (
                    "—"
                  )}
                </td>
                <td style={{ padding: rowPad, ...reviewerTdStyle }}>
                  {row.status ? (
                    <Badge tone={statusTone(row.status)} subtle>
                      {row.status}
                    </Badge>
                  ) : (
                    "—"
                  )}
                </td>
                <td style={{ padding: rowPad, ...reviewerTdStyle }}>
                  {row.reason ?? "—"}
                </td>
                <td style={{ padding: rowPad, ...reviewerTdStyle }}>
                  <div
                    data-reviewer-row-actions={eid}
                    style={{ display: "flex", gap: 6, flexWrap: "wrap" }}
                  >
                    <Button
                      size="sm"
                      variant="secondary"
                      data-reviewer-action="acknowledge"
                      data-reviewer-escalation-id={eid}
                      disabled={!ackable}
                      loading={ackBusy}
                      onClick={() => onAcknowledge(row)}
                      title="Acknowledge escalation"
                    >
                      {ackBusy ? "Acknowledging…" : "Acknowledge"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      data-reviewer-action="open-inspector"
                      data-reviewer-escalation-id={eid}
                      onClick={() => onOpen?.(row)}
                      title="Open inspector (Enter)"
                    >
                      Open inspector
                    </Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function WorkloadTable({
  rows,
  rowPad,
  selectionIndex,
}: {
  rows: ReadonlyArray<WorkloadRow>;
  rowPad: string;
  selectionIndex: number;
}) {
  if (rows.length === 0) {
    return (
      <Card variant="empty" padding="none" className="reviewer-console__empty">
        <EmptyState
          title="No workload snapshots yet"
          purpose="No workload snapshots are available yet. Reconcile must run before this tab can show reviewer capacity."
        />
      </Card>
    );
  }
  return (
    <div style={reviewerTableScrollStyle}>
      <table role="grid" style={reviewerTableStyle}>
        <thead>
          <tr>
            <th style={reviewerThStyle}>Reviewer</th>
            <th style={reviewerThStyle}>Active</th>
            <th style={reviewerThStyle}>Overdue</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => {
            const selected = idx === selectionIndex;
            return (
              <tr
                key={row.reviewerUserId ?? `wl-${idx}`}
                data-selected={selected}
                style={reviewerRowStyle(selected)}
              >
                <td style={{ padding: rowPad, ...reviewerTdStyle }}>
                  {row.reviewerUserId ?? "—"}
                </td>
                <td style={{ padding: rowPad, ...reviewerTdStyle }}>
                  {row.activeAssignments ?? 0}
                </td>
                <td style={{ padding: rowPad, ...reviewerTdStyle }}>
                  {row.overdueAssignments ?? 0}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SlaPanel({ snapshot }: { snapshot: SlaSnapshot | null }) {
  if (!snapshot) {
    return (
      <Card variant="empty" padding="none" className="reviewer-console__empty">
        <EmptyState
          title="SLA snapshot unavailable"
          purpose="Use the SLA Operations page for runtime and freshness details when the console has not received a snapshot."
        />
      </Card>
    );
  }
  const tiles: ReadonlyArray<{ label: string; value: number; tone: BadgeTone }> = [
    { label: "Unassigned", value: snapshot.unassigned, tone: "neutral" },
    { label: "Due soon", value: snapshot.dueSoon, tone: "pending" },
    { label: "Overdue", value: snapshot.overdue, tone: "risk" },
    { label: "Open escalations", value: snapshot.openEscalations, tone: "info" },
    {
      label: "Critical escalations",
      value: snapshot.criticalEscalationsOpen,
      tone: "risk",
    },
  ];
  return (
    <div
      className="reviewer-console__sla"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
        gap: 12,
      }}
    >
      {tiles.map((t) => (
        <Card key={t.label} variant="status" tone={t.tone} padding="comfortable">
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: "var(--ink-muted, #64748b)",
              marginBottom: 6,
            }}
          >
            {t.label}
          </div>
          <div
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: "var(--ink-primary, #0f172a)",
            }}
          >
            {t.value}
          </div>
        </Card>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// G3.2 — Pagination footer. Renders Load more / View all once the
// operator has data, plus a clear "showing N rows" status. The
// console aggregator still caps the initial paint at 25 rows; this
// footer is the bounded escape hatch.
// ---------------------------------------------------------------------------

function PaginationFooter({
  tab,
  state,
  cap,
  onLoadMore,
  onViewAll,
  onReset,
}: {
  tab: PaginatedTab;
  state: TabPagination;
  cap: number;
  onLoadMore: () => void;
  onViewAll: () => void;
  onReset: () => void;
}) {
  const extended = state.extendedRows !== null;
  const shownCount = extended ? state.extendedRows!.length : null;
  const atCap = state.limit >= cap;
  return (
    <div
      className="reviewer-console__pagination"
      data-reviewer-pagination-tab={tab}
      data-reviewer-pagination-limit={state.limit}
      data-reviewer-pagination-has-more={state.hasMore ? "true" : "false"}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        margin: "8px 0",
        padding: "8px 12px",
        fontSize: 12.5,
        color: "var(--ink-secondary, #475569)",
        background: "var(--surface-muted, #f8fafc)",
        border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
        borderRadius: "var(--radius-md, 8px)",
      }}
    >
      <span data-reviewer-pagination-status>
        {extended
          ? `Showing ${shownCount} row${shownCount === 1 ? "" : "s"} (limit ${state.limit}${atCap ? " — workspace max" : ""}).`
          : "Showing first 25 rows from the console aggregator."}
        {state.loading ? " Loading more…" : null}
      </span>
      <div
        style={{
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        {state.error ? (
          <span
            role="alert"
            data-reviewer-pagination-error
            style={{ color: "var(--status-risk-fg, #991b1b)" }}
          >
            {state.error}
          </span>
        ) : null}
        {extended ? (
          <Button
            size="sm"
            variant="ghost"
            data-reviewer-pagination-reset
            onClick={onReset}
            disabled={state.loading}
            title="Return to the bounded 25-row aggregator slice"
          >
            Reset
          </Button>
        ) : null}
        {(!extended || (state.hasMore && !atCap)) ? (
          <Button
            size="sm"
            variant="secondary"
            data-reviewer-pagination-load-more
            onClick={onLoadMore}
            disabled={atCap}
            loading={state.loading}
          >
            {state.loading ? "Loading…" : "Load more"}
          </Button>
        ) : null}
        {!atCap ? (
          <Button
            size="sm"
            variant="secondary"
            data-reviewer-pagination-view-all
            onClick={onViewAll}
            disabled={state.loading}
            title={`Load up to the workspace cap of ${cap} rows`}
          >
            View all (≤{cap})
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Saved views — Create + Delete + Apply.
// ---------------------------------------------------------------------------

function SavedViewsPanel({
  teamId,
  views,
  onChanged,
}: {
  teamId: string;
  views: ReadonlyArray<SavedViewRow>;
  onChanged: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"PRIVATE" | "TEAM">("PRIVATE");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const { confirm } = useConfirmAction();
  const applySavedView = useCallback((view: SavedViewRow) => {
    const queue = resolveSavedViewQueue(view);
    if (queue) {
      window.location.href = `/review/queues?queue=${encodeURIComponent(queue)}`;
      return;
    }
    if (view.filter?.onlyMine) {
      window.location.href = "/review/queues?queue=MY_REVIEWS";
      return;
    }
    setError(
      "This saved view does not expose a queue filter the console can apply directly yet.",
    );
  }, []);

  const create = useCallback(async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/v1/reviewer-ops/saved-views", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teamId,
          name: name.trim(),
          visibility,
          filter: { teamId },
        }),
      });
      setName("");
      setCreating(false);
      onChanged();
    } catch (err) {
      setError(
        toSafeUserError(err, { message: "Could not create saved view." }).message,
      );
    } finally {
      setBusy(false);
    }
  }, [name, onChanged, teamId, visibility]);

  const remove = useCallback(
    async (id: string) => {
      setDeletingId(id);
      setError(null);
      try {
        await apiFetch(
          `/v1/reviewer-ops/saved-views/${encodeURIComponent(id)}?teamId=${encodeURIComponent(teamId)}`,
          { method: "DELETE" },
        );
        onChanged();
      } catch (err) {
        setError(
          toSafeUserError(err, { message: "Could not delete saved view." }).message,
        );
      } finally {
        setDeletingId(null);
      }
    },
    [onChanged, teamId],
  );

  return (
    <PageSection
      className="reviewer-console__saved-views"
      data-reviewer-saved-views-panel
    >
      <Card
        padding="comfortable"
        header={
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
            }}
          >
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 650 }}>
              Saved queue views
            </h2>
            {!creating ? (
              <Button
                size="sm"
                variant="secondary"
                data-reviewer-saved-view-create
                onClick={() => setCreating(true)}
              >
                Save current view
              </Button>
            ) : null}
          </div>
        }
      >
        {error ? (
          <p
            role="alert"
            data-reviewer-saved-view-error
            style={{ color: "var(--status-risk-fg, #991b1b)", fontSize: 12.5 }}
          >
            {error}
          </p>
        ) : null}

        {creating ? (
          <form
            data-reviewer-saved-view-form
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
            style={{
              display: "grid",
              gap: 8,
              margin: "8px 0",
              padding: "10px 12px",
              border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
              borderRadius: "var(--radius-md, 8px)",
              background: "var(--surface-muted, #f8fafc)",
            }}
          >
            <label
              style={{ fontSize: 12, color: "var(--ink-secondary, #475569)" }}
            >
              View name
              <input
                autoFocus
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                data-reviewer-saved-view-name
                required
                style={savedViewControlStyle}
              />
            </label>
            <label
              style={{ fontSize: 12, color: "var(--ink-secondary, #475569)" }}
            >
              Visibility
              <select
                value={visibility}
                onChange={(e) =>
                  setVisibility(e.target.value as "PRIVATE" | "TEAM")
                }
                data-reviewer-saved-view-visibility
                style={savedViewControlStyle}
              >
                <option value="PRIVATE">Private — only you</option>
                <option value="TEAM">Workspace — everyone in this team</option>
              </select>
            </label>
            <div
              style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}
            >
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setCreating(false);
                  setName("");
                  setError(null);
                }}
                data-reviewer-saved-view-cancel
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                variant="primary"
                data-reviewer-saved-view-submit
                disabled={!name.trim()}
                loading={busy}
              >
                {busy ? "Saving…" : "Save view"}
              </Button>
            </div>
          </form>
        ) : null}

        {views.length === 0 ? (
          <p
            style={{
              color: "var(--ink-muted, #64748b)",
              fontSize: 12,
              margin: "8px 0",
            }}
            data-reviewer-saved-views-empty
          >
            No saved views yet. Save the current queue slice to return to it
            later.
          </p>
        ) : (
          <ul
            style={{
              margin: 0,
              padding: 0,
              listStyle: "none",
              display: "grid",
              gap: 6,
            }}
          >
            {views.map((v, idx) => {
              const vid = v.id ?? "";
              const deleting = deletingId === vid;
              return (
                <li
                  key={v.id ?? idx}
                  data-reviewer-saved-view-row={vid}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    justifyContent: "space-between",
                  }}
                >
                  <button
                    type="button"
                    data-reviewer-saved-view-apply={vid}
                    onClick={() => applySavedView(v)}
                    style={{
                      background: "transparent",
                      border: 0,
                      color: "var(--ink-primary, #0f172a)",
                      padding: "4px 0",
                      cursor: "pointer",
                      textAlign: "left",
                      flex: 1,
                      font: "inherit",
                    }}
                  >
                    {v.name ?? `View ${idx + 1}`}
                    {v.queueType ? ` · ${v.queueType}` : ""}
                  </button>
                  <Button
                    size="sm"
                    variant="ghost"
                    data-reviewer-saved-view-delete={vid}
                    disabled={!vid}
                    loading={deleting}
                    onClick={() => {
                      if (!vid) return;
                      void (async () => {
                        const ok = await confirm({
                          title: "Delete saved view?",
                          description: `Delete saved view "${v.name ?? vid}"?`,
                          confirmLabel: "Delete view",
                          tone: "warning",
                          testId: "reviewer-saved-view-delete",
                        });
                        if (ok) void remove(vid);
                      })();
                    }}
                    style={{ color: "var(--status-risk-fg, #7f1d1d)" }}
                    title="Delete saved view"
                  >
                    {deleting ? "Deleting…" : "Delete"}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </PageSection>
  );
}

// ---------------------------------------------------------------------------
// Inline-action modals — minimal, focused, keyboard-accessible.
// ---------------------------------------------------------------------------

function AssignModal({
  workflowId,
  busy,
  onCancel,
  onSubmit,
}: {
  workflowId: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (assigneeUserId: string, note: string | null) => void;
}) {
  const [assigneeUserId, setAssigneeUserId] = useState("");
  const [note, setNote] = useState("");
  return (
    <ModalShell
      title="Assign reviewer"
      subtitle={`Workflow ${shortId(workflowId)}`}
      onCancel={onCancel}
      dataAttr={{ "data-reviewer-modal": "assign" }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (assigneeUserId.trim().length > 0)
            onSubmit(assigneeUserId.trim(), note.trim() ? note.trim() : null);
        }}
      >
        <label style={modalLabelStyle}>
          Assignee user id (UUID)
          <input
            autoFocus
            type="text"
            value={assigneeUserId}
            onChange={(e) => setAssigneeUserId(e.target.value)}
            required
            data-reviewer-assign-user-id
            style={modalInputStyle}
            placeholder="00000000-0000-0000-0000-000000000000"
          />
        </label>
        <label style={modalLabelStyle}>
          Note (optional, ≤400 chars)
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={400}
            data-reviewer-assign-note
            style={{ ...modalInputStyle, minHeight: 60 }}
          />
        </label>
        <ModalActions
          busy={busy}
          onCancel={onCancel}
          submitLabel={busy ? "Assigning…" : "Assign reviewer"}
          submitDisabled={!assigneeUserId.trim()}
        />
      </form>
    </ModalShell>
  );
}

function EscalateModal({
  workflowId,
  busy,
  onCancel,
  onSubmit,
}: {
  workflowId: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (reason: string, severity: string, summary: string) => void;
}) {
  const [reason, setReason] = useState(ESCALATION_REASONS[0].id);
  const [severity, setSeverity] = useState("WARNING");
  const [summary, setSummary] = useState("");
  return (
    <ModalShell
      title="Raise escalation"
      subtitle={`Workflow ${shortId(workflowId)}`}
      onCancel={onCancel}
      dataAttr={{ "data-reviewer-modal": "escalate" }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (summary.trim().length > 0)
            onSubmit(reason, severity, summary.trim());
        }}
      >
        <label style={modalLabelStyle}>
          Reason
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            data-reviewer-escalate-reason
            style={modalInputStyle}
          >
            {ESCALATION_REASONS.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label style={modalLabelStyle}>
          Severity
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
            data-reviewer-escalate-severity
            style={modalInputStyle}
          >
            {ESCALATION_SEVERITIES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label style={modalLabelStyle}>
          Safe summary (operational only — no allegations, ≤400 chars)
          <textarea
            autoFocus
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            maxLength={400}
            required
            data-reviewer-escalate-summary
            style={{ ...modalInputStyle, minHeight: 80 }}
          />
        </label>
        <ModalActions
          busy={busy}
          onCancel={onCancel}
          submitLabel={busy ? "Raising…" : "Raise escalation"}
          submitDisabled={!summary.trim()}
        />
      </form>
    </ModalShell>
  );
}

function RequestInfoModal({
  workflowId,
  busy,
  onCancel,
  onSubmit,
}: {
  workflowId: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  return (
    <ModalShell
      title="Request more information"
      subtitle={`Workflow ${shortId(workflowId)}`}
      onCancel={onCancel}
      dataAttr={{ "data-reviewer-modal": "request-info" }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (note.trim().length > 0) onSubmit(note.trim());
        }}
      >
        <label style={modalLabelStyle}>
          What additional information is needed? (≤400 chars)
          <textarea
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={400}
            required
            data-reviewer-request-info-note
            style={{ ...modalInputStyle, minHeight: 100 }}
          />
        </label>
        <ModalActions
          busy={busy}
          onCancel={onCancel}
          submitLabel={busy ? "Requesting…" : "Request information"}
          submitDisabled={!note.trim()}
        />
      </form>
    </ModalShell>
  );
}

function ModalShell({
  title,
  subtitle,
  children,
  onCancel,
  dataAttr,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  onCancel: () => void;
  dataAttr?: Record<string, string>;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      {...dataAttr}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.45)",
        zIndex: 1050,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          position: "relative",
          background: "#fff",
          borderRadius: 12,
          maxWidth: 460,
          width: "100%",
          padding: "1.25rem 1.5rem",
          boxShadow: "0 24px 64px rgba(15, 23, 42, 0.3)",
        }}
      >
        <header style={{ marginBottom: 12 }}>
          <strong style={{ fontSize: 15 }}>{title}</strong>
          <p
            style={{
              margin: "4px 0 0",
              fontSize: 12,
              color: "#475569",
              lineHeight: 1.4,
            }}
          >
            {subtitle}
          </p>
        </header>
        {children}
        <button
          type="button"
          aria-label="Close"
          onClick={onCancel}
          style={{
            position: "absolute",
            top: 12,
            right: 16,
            background: "transparent",
            border: 0,
            color: "#475569",
            cursor: "pointer",
            fontSize: 18,
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}

function ModalActions({
  busy,
  onCancel,
  submitLabel,
  submitDisabled,
}: {
  busy: boolean;
  onCancel: () => void;
  submitLabel: string;
  submitDisabled?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "flex-end",
        gap: 8,
        marginTop: 12,
      }}
    >
      <Button
        size="sm"
        variant="secondary"
        onClick={onCancel}
        data-reviewer-modal-cancel
        disabled={busy}
      >
        Cancel
      </Button>
      <Button
        type="submit"
        size="sm"
        variant="primary"
        data-reviewer-modal-submit
        disabled={submitDisabled}
        loading={busy}
      >
        {submitLabel}
      </Button>
    </div>
  );
}

function shortId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function CommandPalette({
  onClose,
  onSwitchTab,
}: {
  onClose: () => void;
  onSwitchTab: (t: TabId) => void;
}) {
  // Bounded action set. Adding an action requires touching this
  // component AND the C0 test suite's vocabulary contract.
  const actions: ReadonlyArray<{ id: string; label: string; run: () => void }> = [
    { id: "tab.queue", label: "Switch to Queue", run: () => onSwitchTab("queue") },
    { id: "tab.mine", label: "Switch to Mine", run: () => onSwitchTab("mine") },
    {
      id: "tab.escalations",
      label: "Switch to Escalations",
      run: () => onSwitchTab("escalations"),
    },
    { id: "tab.sla", label: "Switch to SLA rollup", run: () => onSwitchTab("sla") },
    {
      id: "tab.workload",
      label: "Switch to Workload",
      run: () => onSwitchTab("workload"),
    },
  ];
  return (
    <div
      role="dialog"
      aria-label="Reviewer command palette"
      className="reviewer-console__palette"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <input
        autoFocus
        type="text"
        placeholder="Reviewer commands — type to filter"
        aria-label="Reviewer commands"
      />
      <ul>
        {actions.map((a) => (
          <li key={a.id}>
            <button type="button" onClick={a.run}>
              {a.label}
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="reviewer-console__palette-close"
        onClick={onClose}
        aria-label="Close palette"
      >
        Close
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase 7D — token-driven table + control styling. Bespoke tables are kept
// (their <tr> carries load-bearing data-selected / data-reviewer-row-*
// attributes that the shared <DataTable> row model does not surface) but
// restyled onto the design tokens instead of the removed legacy classes.
// ---------------------------------------------------------------------------

const reviewerTableScrollStyle = {
  width: "100%",
  overflowX: "auto",
  border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
  borderRadius: "var(--radius-card, 14px)",
  background: "var(--surface-card, #ffffff)",
} as const;

const reviewerTableStyle = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13.5,
  color: "var(--ink-primary, #0f172a)",
} as const;

const reviewerThStyle = {
  textAlign: "left",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--ink-muted, #94a3b8)",
  background: "var(--surface-header, #f8fafc)",
  borderBottom: "1px solid var(--border-default, rgba(15,23,42,0.09))",
  whiteSpace: "nowrap",
  padding: "10px 12px",
} as const;

const reviewerTdStyle = {
  borderBottom: "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
  verticalAlign: "middle",
} as const;

function reviewerRowStyle(selected: boolean) {
  return {
    background: selected ? "var(--surface-muted, rgba(15,23,42,0.04))" : undefined,
  } as const;
}

const savedViewControlStyle = {
  width: "100%",
  padding: "6px 8px",
  marginTop: 2,
  border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
  borderRadius: "var(--radius-md, 8px)",
  fontSize: 13,
  background: "var(--surface-card, #fff)",
  color: "var(--ink-primary, #0f172a)",
} as const;

const modalLabelStyle = {
  display: "block",
  fontSize: 12,
  color: "var(--ink-secondary, #475569)",
  marginBottom: 8,
} as const;

const modalInputStyle = {
  width: "100%",
  padding: "8px 10px",
  marginTop: 2,
  fontSize: 13,
  border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
  borderRadius: "var(--radius-md, 8px)",
  background: "var(--surface-card, #fff)",
  color: "var(--ink-primary, #0f172a)",
} as const;

// Only the IA-strip anchors and the command palette still rely on
// scoped CSS — every other surface migrated to PageShell / Card /
// Button / Badge / EmptyState and is styled inline with design tokens.
const reviewerConsoleStyles = `
  .reviewer-console__ia-strip a {
    text-decoration: none;
    color: var(--ink-primary, #0f172a);
    border: 1px solid var(--border-default, rgba(15,23,42,0.09));
    background: var(--surface-card, #fff);
    border-radius: 999px;
    padding: 6px 10px;
    font-size: 12px;
    font-weight: 600;
  }
  .reviewer-console__palette {
    position: fixed;
    inset: 10% 50% auto 50%;
    transform: translateX(-50%);
    width: min(560px, calc(100vw - 32px));
    background: var(--surface-card, #fff);
    border: 1px solid var(--border-default, rgba(15,23,42,0.09));
    border-radius: var(--radius-card, 14px);
    padding: 16px;
    box-shadow: 0 20px 50px rgba(15, 23, 42, 0.18);
    z-index: 70;
  }
  .reviewer-console__palette-close {
    margin-top: 12px;
  }
`;

// `DEFAULT_TEAM_PLACEHOLDER` is exported as a sentinel for tests that
// need to verify the no-workspace branch renders the operator-safe
// panel rather than firing a request.
export { DEFAULT_TEAM_PLACEHOLDER };
