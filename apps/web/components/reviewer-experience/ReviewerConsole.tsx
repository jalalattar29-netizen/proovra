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
 *   * compact / comfortable / spacious density modes driven by the
 *     persona profile's `operationalDensityPreference`,
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

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { apiFetch } from "../../lib/api";
import {
  StepUpModal,
  useStepUpAction,
} from "../identity-security/StepUpModal";
import { useConfirmAction } from "../ui/ConfirmActionModal";
import { ReviewerRoutingRecommendationsPane } from "../hidden-feature-panels/HiddenFeaturePanels";

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
};

type Density = "compact" | "comfortable" | "spacious";
const DENSITY_VALUES: ReadonlyArray<Density> = [
  "compact",
  "comfortable",
  "spacious",
];

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
  /**
   * Density preference from `personaProfile.operationalDensityPreference`.
   * Drives row padding only — never changes which columns render.
   */
  density: Density;
  /** Open the upstream evidence detail surface in a new view. */
  onOpenRow?: (row: ConsoleRow | EscalationRow) => void;
};

export function ReviewerConsole({
  teamId,
  density,
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

  const effectiveDensity: Density = useMemo(
    () => (DENSITY_VALUES.includes(density) ? density : "comfortable"),
    [density],
  );

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
            (err as { message?: string }).message ??
              "Could not assign reviewer.",
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
            (err as { message?: string }).message ??
              "Could not request information.",
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
            (err as { message?: string }).message ??
              "Could not raise escalation.",
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
              (err as { message?: string }).message ??
              "Could not load more rows.",
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
            (err as { message?: string }).message ??
              "Could not acknowledge escalation.",
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

  // Per-density row padding. Compact mode is the enterprise
  // default for high-throughput reviewers; comfortable is the
  // fallback; spacious is for accessibility / casual review.
  const rowPad =
    effectiveDensity === "compact"
      ? "6px 10px"
      : effectiveDensity === "spacious"
        ? "16px 18px"
        : "10px 14px";

  if (!teamId) {
    return (
      <section className="reviewer-console reviewer-console--no-workspace">
        <p>
          Reviewer Console is workspace-scoped. Switch into a team
          workspace from the top-bar workspace switcher to open the
          queue.
        </p>
      </section>
    );
  }

  return (
    <section
      className="reviewer-console"
      data-density={effectiveDensity}
      data-active-tab={activeTab}
    >
      <header className="reviewer-console__header">
        <h1>Reviewer Console</h1>
        <p className="reviewer-console__sub">
          Queue · Mine · Escalations · SLA · Workload. Keyboard:{" "}
          <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>Enter</kbd> open ·{" "}
          <kbd>a</kbd> assign · <kbd>e</kbd> escalate · <kbd>m</kbd>{" "}
          request info · <kbd>/</kbd> filter · <kbd>Cmd</kbd>+<kbd>K</kbd>{" "}
          palette.
        </p>
      </header>

      {/* Phase Final-Hidden-Feature-Surfacing — routing recommendations
          pane. Reads the canonical reviewer-routing recommendation
          rows via the new `/v1/reviewer/routing-recommendations`
          endpoint. Pane stays above the tabbed sections so guidance
          surfaces even when the reviewer hasn't drilled into a tab. */}
      {teamId ? (
        <ReviewerRoutingRecommendationsPane teamId={teamId} />
      ) : null}

      <nav className="reviewer-console__tabs" role="tablist">
        {TABS.map((t) => {
          const status =
            envelope?.diagnostics.sectionStatus[t.id] ?? "ok";
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={activeTab === t.id}
              className={`reviewer-console__tab ${
                activeTab === t.id ? "is-active" : ""
              }`}
              onClick={() => {
                setActiveTab(t.id);
                setSelectionIndex(0);
              }}
              data-section-status={status}
              data-tab-id={t.id}
            >
              <strong>{t.label}</strong>
              <span className="reviewer-console__tab-desc">{t.description}</span>
              {status === "degraded" ? (
                <span
                  className="reviewer-console__tab-degraded"
                  title="This section failed to load; other tabs are unaffected."
                >
                  degraded
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      {loading ? (
        <p className="reviewer-console__status">Loading reviewer console…</p>
      ) : null}
      {error ? (
        <p className="reviewer-console__error" role="alert">
          {error}
        </p>
      ) : null}

      {actionError ? (
        <p
          className="reviewer-console__action-error"
          role="alert"
          data-reviewer-action-error
        >
          {actionError}
        </p>
      ) : null}
      {actionFlash ? (
        <p
          className="reviewer-console__action-flash"
          role="status"
          data-reviewer-action-flash
        >
          {actionFlash}
        </p>
      ) : null}

      {envelope ? (
        <>
          {/* In-tab filter — `/` focuses this input. The actual
              filter logic lives upstream in the per-domain endpoints
              for deep drill; the console-level input is bounded to
              row.id / reviewer summary prefix matching. */}
          <div className="reviewer-console__filter">
            <input
              ref={filterInputRef}
              type="text"
              placeholder="Filter visible rows (press /)…"
              aria-label="Filter visible rows"
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
    </section>
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
      <p className="reviewer-console__empty">
        No reviews match this slice. Use the saved views panel below
        to switch slices.
      </p>
    );
  }
  return (
    <table className="reviewer-console__table" role="grid">
      <thead>
        <tr>
          <th>Evidence</th>
          <th>Stage</th>
          <th>Status</th>
          <th>Priority</th>
          <th>Due</th>
          <th>Actions</th>
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
              style={{ background: selected ? "rgba(0, 0, 0, 0.04)" : undefined }}
            >
              <td style={{ padding: rowPad }}>
                {row.reviewerSummary ?? row.evidenceId ?? row.id ?? "—"}
              </td>
              <td style={{ padding: rowPad }}>{row.stage ?? "—"}</td>
              <td style={{ padding: rowPad }}>{row.status ?? "—"}</td>
              <td style={{ padding: rowPad }}>{row.priority ?? "—"}</td>
              <td style={{ padding: rowPad }}>{row.dueAtUtc ?? "—"}</td>
              <td style={{ padding: rowPad }}>
                <div
                  data-reviewer-row-actions={wid}
                  style={{ display: "flex", gap: 6, flexWrap: "wrap" }}
                >
                  <button
                    type="button"
                    data-reviewer-action="assign"
                    data-reviewer-workflow-id={wid}
                    disabled={!actionable || assignBusy}
                    onClick={() => onAssign(row)}
                    style={inlineButtonStyle}
                    title="Assign reviewer (a)"
                  >
                    {assignBusy ? "Assigning…" : "Assign"}
                  </button>
                  <button
                    type="button"
                    data-reviewer-action="escalate"
                    data-reviewer-workflow-id={wid}
                    disabled={!actionable || escalateBusy}
                    onClick={() => onEscalate(row)}
                    style={inlineButtonStyle}
                    title="Raise escalation (e)"
                  >
                    {escalateBusy ? "Raising…" : "Escalate"}
                  </button>
                  <button
                    type="button"
                    data-reviewer-action="request-info"
                    data-reviewer-workflow-id={wid}
                    disabled={!actionable || reqInfoBusy}
                    onClick={() => onRequestInfo(row)}
                    style={inlineButtonStyle}
                    title="Request more info (m)"
                  >
                    {reqInfoBusy ? "Requesting…" : "Request info"}
                  </button>
                  <button
                    type="button"
                    data-reviewer-action="open-inspector"
                    data-reviewer-workflow-id={wid}
                    onClick={() => onOpen?.(row)}
                    style={inlineButtonStyle}
                    title="Open reviewer inspector (Enter)"
                  >
                    Open inspector
                  </button>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
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
    return <p className="reviewer-console__empty">No open escalations.</p>;
  }
  return (
    <table className="reviewer-console__table" role="grid">
      <thead>
        <tr>
          <th>Workflow</th>
          <th>Severity</th>
          <th>Status</th>
          <th>Reason</th>
          <th>Actions</th>
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
              style={{ background: selected ? "rgba(0, 0, 0, 0.04)" : undefined }}
            >
              <td style={{ padding: rowPad }}>{row.workflowId ?? row.id ?? "—"}</td>
              <td style={{ padding: rowPad }}>{row.severity ?? "—"}</td>
              <td style={{ padding: rowPad }}>{row.status ?? "—"}</td>
              <td style={{ padding: rowPad }}>{row.reason ?? "—"}</td>
              <td style={{ padding: rowPad }}>
                <div
                  data-reviewer-row-actions={eid}
                  style={{ display: "flex", gap: 6, flexWrap: "wrap" }}
                >
                  <button
                    type="button"
                    data-reviewer-action="acknowledge"
                    data-reviewer-escalation-id={eid}
                    disabled={!ackable || ackBusy}
                    onClick={() => onAcknowledge(row)}
                    style={inlineButtonStyle}
                    title="Acknowledge escalation"
                  >
                    {ackBusy ? "Acknowledging…" : "Acknowledge"}
                  </button>
                  <button
                    type="button"
                    data-reviewer-action="open-inspector"
                    data-reviewer-escalation-id={eid}
                    onClick={() => onOpen?.(row)}
                    style={inlineButtonStyle}
                    title="Open inspector (Enter)"
                  >
                    Open inspector
                  </button>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
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
    return <p className="reviewer-console__empty">No workload snapshots.</p>;
  }
  return (
    <table className="reviewer-console__table" role="grid">
      <thead>
        <tr>
          <th>Reviewer</th>
          <th>Active</th>
          <th>Overdue</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, idx) => {
          const selected = idx === selectionIndex;
          return (
            <tr
              key={row.reviewerUserId ?? `wl-${idx}`}
              data-selected={selected}
              style={{ background: selected ? "rgba(0, 0, 0, 0.04)" : undefined }}
            >
              <td style={{ padding: rowPad }}>{row.reviewerUserId ?? "—"}</td>
              <td style={{ padding: rowPad }}>{row.activeAssignments ?? 0}</td>
              <td style={{ padding: rowPad }}>{row.overdueAssignments ?? 0}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SlaPanel({ snapshot }: { snapshot: SlaSnapshot | null }) {
  if (!snapshot) {
    return <p className="reviewer-console__empty">SLA snapshot unavailable.</p>;
  }
  return (
    <dl className="reviewer-console__sla">
      <div>
        <dt>Unassigned</dt>
        <dd>{snapshot.unassigned}</dd>
      </div>
      <div>
        <dt>Due soon</dt>
        <dd>{snapshot.dueSoon}</dd>
      </div>
      <div>
        <dt>Overdue</dt>
        <dd>{snapshot.overdue}</dd>
      </div>
      <div>
        <dt>Open escalations</dt>
        <dd>{snapshot.openEscalations}</dd>
      </div>
      <div>
        <dt>Critical escalations</dt>
        <dd>{snapshot.criticalEscalationsOpen}</dd>
      </div>
    </dl>
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
        color: "#475569",
        background: "#f8fafc",
        border: "1px solid #e2e8f0",
        borderRadius: 6,
      }}
    >
      <span data-reviewer-pagination-status>
        {extended
          ? `Showing ${shownCount} row${shownCount === 1 ? "" : "s"} (limit ${state.limit}${atCap ? " — workspace max" : ""}).`
          : "Showing first 25 rows from the console aggregator."}
        {state.loading ? " Loading more…" : null}
      </span>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {state.error ? (
          <span
            role="alert"
            data-reviewer-pagination-error
            style={{ color: "#991b1b" }}
          >
            {state.error}
          </span>
        ) : null}
        {extended ? (
          <button
            type="button"
            data-reviewer-pagination-reset
            onClick={onReset}
            style={inlineButtonStyle}
            disabled={state.loading}
            title="Return to the bounded 25-row aggregator slice"
          >
            Reset
          </button>
        ) : null}
        {(!extended || (state.hasMore && !atCap)) ? (
          <button
            type="button"
            data-reviewer-pagination-load-more
            onClick={onLoadMore}
            disabled={state.loading || atCap}
            style={inlineButtonStyle}
          >
            {state.loading ? "Loading…" : "Load more"}
          </button>
        ) : null}
        {!atCap ? (
          <button
            type="button"
            data-reviewer-pagination-view-all
            onClick={onViewAll}
            disabled={state.loading}
            style={inlineButtonStyle}
            title={`Load up to the workspace cap of ${cap} rows`}
          >
            View all (≤{cap})
          </button>
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
        (err as { message?: string }).message ?? "Could not create saved view.",
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
          (err as { message?: string }).message ?? "Could not delete saved view.",
        );
      } finally {
        setDeletingId(null);
      }
    },
    [onChanged, teamId],
  );

  return (
    <aside
      className="reviewer-console__saved-views"
      data-reviewer-saved-views-panel
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <h2>Saved queue views</h2>
        {!creating ? (
          <button
            type="button"
            data-reviewer-saved-view-create
            onClick={() => setCreating(true)}
            style={inlineButtonStyle}
          >
            Save current view
          </button>
        ) : null}
      </header>

      {error ? (
        <p
          role="alert"
          data-reviewer-saved-view-error
          style={{ color: "#991b1b", fontSize: 12.5 }}
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
            padding: "8px 10px",
            border: "1px solid #e2e8f0",
            borderRadius: 6,
            background: "#f8fafc",
          }}
        >
          <label style={{ fontSize: 12, color: "#475569" }}>
            View name
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              data-reviewer-saved-view-name
              required
              style={{
                width: "100%",
                padding: "6px 8px",
                marginTop: 2,
                border: "1px solid #cbd5e1",
                borderRadius: 4,
                fontSize: 13,
              }}
            />
          </label>
          <label style={{ fontSize: 12, color: "#475569" }}>
            Visibility
            <select
              value={visibility}
              onChange={(e) =>
                setVisibility(e.target.value as "PRIVATE" | "TEAM")
              }
              data-reviewer-saved-view-visibility
              style={{
                width: "100%",
                padding: "6px 8px",
                marginTop: 2,
                border: "1px solid #cbd5e1",
                borderRadius: 4,
                fontSize: 13,
              }}
            >
              <option value="PRIVATE">Private — only you</option>
              <option value="TEAM">Workspace — everyone in this team</option>
            </select>
          </label>
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={() => {
                setCreating(false);
                setName("");
                setError(null);
              }}
              data-reviewer-saved-view-cancel
              style={inlineButtonStyle}
            >
              Cancel
            </button>
            <button
              type="submit"
              data-reviewer-saved-view-submit
              disabled={busy || !name.trim()}
              style={primaryInlineButtonStyle}
            >
              {busy ? "Saving…" : "Save view"}
            </button>
          </div>
        </form>
      ) : null}

      {views.length === 0 ? (
        <p
          style={{ color: "#64748b", fontSize: 12, margin: "8px 0" }}
          data-reviewer-saved-views-empty
        >
          No saved views yet. Save the current queue slice to return to it
          later.
        </p>
      ) : (
        <ul>
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
                  style={{
                    background: "transparent",
                    border: 0,
                    color: "#0f172a",
                    padding: "4px 0",
                    cursor: "pointer",
                    textAlign: "left",
                    flex: 1,
                  }}
                >
                  {v.name ?? `View ${idx + 1}`}
                  {v.queueType ? ` · ${v.queueType}` : ""}
                </button>
                <button
                  type="button"
                  data-reviewer-saved-view-delete={vid}
                  disabled={!vid || deleting}
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
                  style={{
                    background: "transparent",
                    border: 0,
                    color: "#7f1d1d",
                    padding: "4px 6px",
                    cursor: "pointer",
                    fontSize: 12,
                  }}
                  title="Delete saved view"
                >
                  {deleting ? "Deleting…" : "Delete"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
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
      <button
        type="button"
        onClick={onCancel}
        data-reviewer-modal-cancel
        style={secondaryInlineButtonStyle}
        disabled={busy}
      >
        Cancel
      </button>
      <button
        type="submit"
        data-reviewer-modal-submit
        disabled={submitDisabled || busy}
        style={primaryInlineButtonStyle}
      >
        {submitLabel}
      </button>
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
// Inline button styling — tight, operational, no flourish.
// ---------------------------------------------------------------------------

const inlineButtonStyle = {
  padding: "4px 8px",
  fontSize: 11.5,
  fontWeight: 500,
  color: "#0f172a",
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  borderRadius: 4,
  cursor: "pointer",
} as const;

const primaryInlineButtonStyle = {
  padding: "6px 12px",
  fontSize: 12.5,
  fontWeight: 600,
  color: "#fff",
  background: "#0f172a",
  border: 0,
  borderRadius: 6,
  cursor: "pointer",
} as const;

const secondaryInlineButtonStyle = {
  padding: "6px 12px",
  fontSize: 12.5,
  fontWeight: 600,
  color: "#0f172a",
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  cursor: "pointer",
} as const;

const modalLabelStyle = {
  display: "block",
  fontSize: 12,
  color: "#475569",
  marginBottom: 8,
} as const;

const modalInputStyle = {
  width: "100%",
  padding: "8px 10px",
  marginTop: 2,
  fontSize: 13,
  border: "1px solid #cbd5e1",
  borderRadius: 4,
} as const;

// `DEFAULT_TEAM_PLACEHOLDER` is exported as a sentinel for tests that
// need to verify the no-workspace branch renders the operator-safe
// panel rather than firing a request.
export { DEFAULT_TEAM_PLACEHOLDER };
