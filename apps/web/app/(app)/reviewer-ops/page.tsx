"use client";

/**
 * Phase 25 — Reviewer Operations Console.
 *
 * Three-pane enterprise reviewer surface:
 *   - LEFT  filters: queue type, SLA, escalation, assignment, priority
 *   - CENTER dense workflow table with SLA + lifecycle badges
 *   - RIGHT inspector: lifecycle, SLA dimensions, assignment controls,
 *           quick actions (start, pause, request-info, approve, reject,
 *           escalate, reassign)
 *
 * Wording invariant: operator-safe phrases only. The Phase 24 shared
 * `SEARCH_FORBIDDEN_OVERCLAIM_PHRASES` catalog is the source of truth
 * for banned wording; the Phase 25 sweep test asserts no match in this
 * file. Use the `REVIEWER_OPS_ALLOWED_LABELS` catalog for badges.
 */

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../../lib/api";
import { useActiveWorkspaceId } from "../../../lib/useActiveWorkspaceId";
import { WorkspaceGateState } from "./WorkspaceGateState";
import {
  cardStyle,
  emptyStateStyle,
  errorBoxStyle,
  formatDateTime,
  formatRelative,
  ghostButtonStyle,
  headerRowStyle,
  lifecycleBadgeStyle,
  mutedStyle,
  pageStyle,
  primaryButtonStyle,
  rowStyle,
  sectionTitleStyle,
  slaBadgeStyle,
  subtitleStyle,
  tableStyle,
  tdStyle,
  thStyle,
  titleStyle,
  TOKENS,
} from "./ui-tokens";

// -----------------------------------------------------------------------------
// Wire types
// -----------------------------------------------------------------------------

type QueueType =
  | "MY_REVIEWS"
  | "UNASSIGNED"
  | "OVERDUE"
  | "DUE_SOON"
  | "ESCALATED"
  | "HIGH_PRIORITY"
  | "LEGAL_HOLD"
  | "WORKFLOW_BLOCKED"
  | "INTEGRITY_RISK"
  | "EXTERNAL_INTAKE"
  | "COMPLETED_RECENTLY";

const QUEUE_TYPES: { value: QueueType; label: string; tone: string }[] = [
  { value: "MY_REVIEWS", label: "Assigned to me", tone: "" },
  { value: "UNASSIGNED", label: "Unassigned", tone: "" },
  { value: "DUE_SOON", label: "Due soon", tone: "warn" },
  { value: "OVERDUE", label: "Overdue", tone: "alert" },
  { value: "ESCALATED", label: "Escalated", tone: "alert" },
  { value: "HIGH_PRIORITY", label: "High priority", tone: "warn" },
  { value: "LEGAL_HOLD", label: "Legal hold", tone: "" },
  { value: "WORKFLOW_BLOCKED", label: "Paused", tone: "" },
  { value: "INTEGRITY_RISK", label: "Integrity risk", tone: "alert" },
  { value: "EXTERNAL_INTAKE", label: "External intake", tone: "" },
  { value: "COMPLETED_RECENTLY", label: "Completed (7d)", tone: "" },
];

type LifecycleState =
  | "DRAFT"
  | "SUBMITTED"
  | "QUEUED"
  | "ASSIGNED"
  | "IN_REVIEW"
  | "NEEDS_INFORMATION"
  | "ESCALATED"
  | "APPROVED"
  | "REJECTED"
  | "ARCHIVED";

type SlaState =
  | "HEALTHY"
  | "DUE_SOON"
  | "BREACHED"
  | "ESCALATED"
  | "BLOCKED"
  | "PAUSED"
  | "COMPLETED";

type SlaDimensionSnapshot = {
  dimension: "ASSIGNMENT" | "FIRST_REVIEW" | "COMPLETION" | "ESCALATION";
  dueAtUtc: string | null;
  dueSoonAtUtc: string | null;
  state: SlaState;
  timeRemainingMs: number | null;
  breachDurationMs: number | null;
};

type WorkflowProjection = {
  workflowId: string;
  evidenceId: string;
  teamId: string | null;
  lifecycleState: LifecycleState;
  assignedToUserId: string | null;
  assignedAtUtc: string | null;
  priority: string;
  slaRollupState: SlaState;
  slaDimensions: SlaDimensionSnapshot[];
  legacy: {
    stage: string;
    slaStatus: string | null;
    dueAt: string | null;
    priority: string;
  };
};

type QueueResponse = {
  rows: WorkflowProjection[];
  nextCursor: string | null;
};

// -----------------------------------------------------------------------------
// Page
// -----------------------------------------------------------------------------

type SavedView = {
  id: string;
  name: string;
  description: string | null;
  visibility: "PRIVATE" | "TEAM";
  pinned: boolean;
  filter: { queue?: QueueType; teamId: string };
};

export default function ReviewerOpsConsole() {
  // Hotfix — canonical workspace resolution. Distinguishes auth /
  // permission / operational errors from genuine "no workspace"
  // membership so the page no longer collapses every failure mode
  // into "Switch to a workspace".
  const workspaceState = useActiveWorkspaceId();
  const teamId =
    workspaceState.status === "ready" ? workspaceState.workspaceId : null;
  const [queue, setQueue] = useState<QueueType>("UNASSIGNED");
  const [rows, setRows] = useState<WorkflowProjection[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<WorkflowProjection | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  // Phase 25.5 — bulk selection + saved views.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [bulkBusy, setBulkBusy] = useState<string | null>(null);

  const loadQueue = useCallback(() => {
    if (!teamId) return;
    setLoading(true);
    apiFetch(
      `/v1/reviewer-ops/queue?teamId=${encodeURIComponent(
        teamId,
      )}&queue=${queue}&limit=50`,
      { method: "GET" },
    )
      .then((r: QueueResponse) => {
        setRows(r.rows ?? []);
        setError(null);
        if (!r.rows.find((x) => x.workflowId === selected?.workflowId)) {
          setSelected(r.rows?.[0] ?? null);
        }
      })
      .catch((err: { message?: string }) =>
        setError(err?.message ?? "Could not load queue."),
      )
      .finally(() => setLoading(false));
  }, [teamId, queue, selected?.workflowId]);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  // Phase 25.5 — saved views.
  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    apiFetch(`/v1/reviewer-ops/saved-views?teamId=${encodeURIComponent(teamId)}`, {
      method: "GET",
    })
      .then((r: { views: SavedView[] }) => {
        if (!cancelled) setSavedViews(r.views ?? []);
      })
      .catch(() => {
        if (!cancelled) setSavedViews([]);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  // Phase 25.5 — keyboard navigation (j/k row move, x toggle select,
  // Esc clear selection). Skip when focus is inside an input.
  useEffect(() => {
    if (!rows || rows.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const idx = selected
        ? rows.findIndex((r) => r.workflowId === selected.workflowId)
        : -1;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        const next = rows[Math.min(rows.length - 1, idx + 1)];
        if (next) setSelected(next);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = rows[Math.max(0, idx - 1)];
        if (next) setSelected(next);
      } else if (e.key === "x" && selected) {
        e.preventDefault();
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(selected.workflowId)) next.delete(selected.workflowId);
          else next.add(selected.workflowId);
          return next;
        });
      } else if (e.key === "Escape") {
        setSelectedIds(new Set());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, selected]);

  // Reset bulk selection when the queue changes.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [queue]);

  const toggleSelectAll = useCallback(() => {
    if (!rows) return;
    if (selectedIds.size === rows.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(rows.map((r) => r.workflowId)));
  }, [rows, selectedIds]);

  const runBulk = useCallback(
    async (
      action: string,
      extra: Record<string, unknown> = {},
    ): Promise<void> => {
      if (!teamId || selectedIds.size === 0) return;
      setBulkBusy(action);
      try {
        const res = await apiFetch("/v1/reviewer-ops/reviews/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            teamId,
            workflowIds: Array.from(selectedIds),
            action,
            ...extra,
          }),
        });
        if (res?.failed && res.failed > 0) {
          setError(
            `Bulk ${action.toLowerCase()}: ${res.succeeded} succeeded, ${res.failed} failed.`,
          );
        } else {
          setError(null);
        }
        setSelectedIds(new Set());
        await loadQueue();
      } catch (err) {
        setError(
          (err as { message?: string })?.message ?? `Bulk ${action} failed.`,
        );
      } finally {
        setBulkBusy(null);
      }
    },
    [teamId, selectedIds, loadQueue],
  );

  const saveCurrentView = useCallback(async () => {
    if (!teamId) return;
    const name = window.prompt("Name this queue view");
    if (!name || name.trim().length === 0) return;
    try {
      const res = await apiFetch("/v1/reviewer-ops/saved-views", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teamId,
          name: name.trim().slice(0, 120),
          visibility: "PRIVATE",
          filter: { teamId, queue },
        }),
      });
      if (res?.view) {
        setSavedViews((prev) => [res.view as SavedView, ...prev]);
      }
    } catch (err) {
      setError(
        (err as { message?: string })?.message ?? "Could not save view.",
      );
    }
  }, [teamId, queue]);

  const deleteSavedView = useCallback(
    async (id: string) => {
      if (!teamId) return;
      if (!window.confirm("Delete this saved view?")) return;
      try {
        await apiFetch(
          `/v1/reviewer-ops/saved-views/${encodeURIComponent(id)}?teamId=${encodeURIComponent(teamId)}`,
          { method: "DELETE" },
        );
        setSavedViews((prev) => prev.filter((v) => v.id !== id));
      } catch (err) {
        setError(
          (err as { message?: string })?.message ?? "Could not delete view.",
        );
      }
    },
    [teamId],
  );

  const runAction = useCallback(
    async (
      label: string,
      url: string,
      body: Record<string, unknown>,
    ): Promise<void> => {
      if (!teamId || !selected) return;
      setActionBusy(label);
      try {
        const res = await apiFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ teamId, ...body }),
        });
        if (res?.projection) {
          setSelected(res.projection as WorkflowProjection);
        }
        await loadQueue();
      } catch (err) {
        setError(
          (err as { message?: string })?.message ??
            `Action "${label}" failed.`,
        );
      } finally {
        setActionBusy(null);
      }
    },
    [teamId, selected, loadQueue],
  );

  if (workspaceState.status !== "ready") {
    return (
      <WorkspaceGateState
        state={workspaceState}
        surface="Reviewer Ops"
      />
    );
  }

  return (
    <main style={pageStyle}>
      <header style={headerRowStyle}>
        <div>
          <h1 style={titleStyle}>Reviewer Operations</h1>
          <p style={subtitleStyle}>
            Operator queues, SLA tracking, escalation lifecycle. All
            actions are governance-aware; the queue respects legal hold
            and visibility restrictions.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            type="button"
            style={ghostButtonStyle}
            onClick={loadQueue}
            disabled={loading}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      <div style={threeColStyle}>
        {/* LEFT — queue selector + saved views */}
        <aside style={leftRailStyle}>
          <div style={sectionTitleStyle}>Queues</div>
          <div style={queueListStyle}>
            {QUEUE_TYPES.map((q) => {
              const active = q.value === queue;
              return (
                <button
                  key={q.value}
                  type="button"
                  onClick={() => setQueue(q.value)}
                  style={queueButtonStyle(active, q.tone)}
                  aria-pressed={active}
                >
                  {q.label}
                </button>
              );
            })}
          </div>

          <div style={{ ...sectionTitleStyle, marginTop: 18 }}>Saved views</div>
          <button
            type="button"
            style={ghostButtonStyle}
            onClick={saveCurrentView}
          >
            Save current queue
          </button>
          {savedViews.length === 0 ? (
            <p style={{ ...mutedStyle, marginTop: 6 }}>No saved views yet.</p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: "6px 0 0", display: "flex", flexDirection: "column", gap: 4 }}>
              {savedViews.map((v) => (
                <li key={v.id} style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <button
                    type="button"
                    style={{
                      ...queueButtonStyle(false, ""),
                      flex: 1,
                      textAlign: "left",
                    }}
                    onClick={() => {
                      if (v.filter.queue) setQueue(v.filter.queue);
                    }}
                  >
                    {v.pinned ? "★ " : ""}
                    {v.name}
                  </button>
                  <button
                    type="button"
                    aria-label="Delete saved view"
                    style={{
                      padding: "2px 8px",
                      fontSize: 14,
                      lineHeight: 1,
                      border: "1px solid #e2e8f0",
                      background: "#fff",
                      color: "#64748b",
                      borderRadius: 4,
                      cursor: "pointer",
                    }}
                    onClick={() => deleteSavedView(v.id)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div style={{ ...sectionTitleStyle, marginTop: 18 }}>Shortcuts</div>
          <ul style={{ margin: 0, paddingLeft: 14, ...mutedStyle, lineHeight: 1.6 }}>
            <li><code>j / ↓</code> next</li>
            <li><code>k / ↑</code> previous</li>
            <li><code>x</code> toggle select</li>
            <li><code>Esc</code> clear selection</li>
          </ul>
        </aside>

        {/* CENTER — dense queue table */}
        <section style={centerColStyle}>
          {/* Bulk toolbar (sticky when items are selected) */}
          {selectedIds.size > 0 ? (
            <div style={bulkBarStyle}>
              <span style={{ fontWeight: 600, fontSize: 12 }}>
                {selectedIds.size} selected
              </span>
              <button
                type="button"
                style={ghostButtonStyle}
                disabled={bulkBusy !== null}
                onClick={async () => {
                  const u = window.prompt("Assignee user id (UUID)");
                  if (!u) return;
                  await runBulk("ASSIGN", { assignedToUserId: u });
                }}
              >
                Assign…
              </button>
              <button
                type="button"
                style={ghostButtonStyle}
                disabled={bulkBusy !== null}
                onClick={async () => {
                  const n = window.prompt("Escalation note (required)");
                  if (!n) return;
                  await runBulk("ESCALATE", { note: n });
                }}
              >
                Escalate
              </button>
              <button
                type="button"
                style={ghostButtonStyle}
                disabled={bulkBusy !== null}
                onClick={async () => {
                  const n = window.prompt("Pause reason (required)");
                  if (!n) return;
                  await runBulk("PAUSE", { note: n });
                }}
              >
                Pause
              </button>
              <button
                type="button"
                style={ghostButtonStyle}
                disabled={bulkBusy !== null}
                onClick={() => runBulk("PRIORITY_HIGH")}
              >
                Priority high
              </button>
              <button
                type="button"
                style={ghostButtonStyle}
                disabled={bulkBusy !== null}
                onClick={async () => {
                  const n = window.prompt("Close note");
                  await runBulk("CLOSE", n ? { note: n } : {});
                }}
              >
                Close
              </button>
              <button
                type="button"
                style={ghostButtonStyle}
                onClick={() => setSelectedIds(new Set())}
              >
                Clear
              </button>
            </div>
          ) : null}

          {rows === null ? (
            <SkeletonTable />
          ) : rows.length === 0 ? (
            <div style={emptyStateStyle}>
              No reviews in this queue.
            </div>
          ) : (
            <div style={{ overflowY: "auto", maxHeight: "calc(100vh - 200px)" }}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>
                      <input
                        type="checkbox"
                        aria-label="Select all"
                        checked={
                          rows.length > 0 && selectedIds.size === rows.length
                        }
                        onChange={toggleSelectAll}
                      />
                    </th>
                    <th style={thStyle}>Lifecycle</th>
                    <th style={thStyle}>Priority</th>
                    <th style={thStyle}>SLA</th>
                    <th style={thStyle}>Due (first review)</th>
                    <th style={thStyle}>Reviewer</th>
                    <th style={thStyle}>Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const firstRev = r.slaDimensions.find(
                      (d) => d.dimension === "FIRST_REVIEW",
                    );
                    const isSelected = selectedIds.has(r.workflowId);
                    return (
                      <tr
                        key={r.workflowId}
                        style={rowStyle(
                          selected?.workflowId === r.workflowId,
                        )}
                        onClick={() => setSelected(r)}
                      >
                        <td
                          style={tdStyle}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            aria-label="Select row"
                            checked={isSelected}
                            onChange={() => {
                              setSelectedIds((prev) => {
                                const next = new Set(prev);
                                if (next.has(r.workflowId))
                                  next.delete(r.workflowId);
                                else next.add(r.workflowId);
                                return next;
                              });
                            }}
                          />
                        </td>
                        <td style={tdStyle}>
                          <span style={lifecycleBadgeStyle(r.lifecycleState)}>
                            {r.lifecycleState.toLowerCase().replace("_", " ")}
                          </span>
                        </td>
                        <td style={tdStyle}>
                          <span style={priorityChipStyle(r.priority)}>
                            {r.priority}
                          </span>
                        </td>
                        <td style={tdStyle}>
                          <span style={slaBadgeStyle(r.slaRollupState)}>
                            {r.slaRollupState.toLowerCase().replace("_", " ")}
                          </span>
                        </td>
                        <td style={tdStyle}>
                          <div style={mutedStyle}>
                            {formatRelative(firstRev?.dueAtUtc ?? null)}
                          </div>
                        </td>
                        <td style={tdStyle}>
                          <span style={mutedStyle}>
                            {r.assignedToUserId
                              ? r.assignedToUserId.slice(0, 8) + "…"
                              : "—"}
                          </span>
                        </td>
                        <td style={tdStyle}>
                          <a
                            href={`/evidence/${r.evidenceId}`}
                            style={evidenceLinkStyle}
                          >
                            {r.evidenceId.slice(0, 8)}…
                          </a>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* RIGHT — inspector */}
        <aside style={rightRailStyle}>
          {!selected ? (
            <div style={emptyStateStyle}>
              Select a review to see lifecycle, SLA, and reviewer actions.
            </div>
          ) : (
            <Inspector
              row={selected}
              actionBusy={actionBusy}
              onAction={runAction}
            />
          )}
        </aside>
      </div>
    </main>
  );
}

// -----------------------------------------------------------------------------
// Inspector
// -----------------------------------------------------------------------------

function Inspector({
  row,
  actionBusy,
  onAction,
}: {
  row: WorkflowProjection;
  actionBusy: string | null;
  onAction: (
    label: string,
    url: string,
    body: Record<string, unknown>,
  ) => Promise<void>;
}) {
  const wfBase = `/v1/reviewer-ops/reviews/${encodeURIComponent(
    row.workflowId,
  )}`;
  const isAssignedToOther = !!row.assignedToUserId;
  const canStart = row.lifecycleState === "ASSIGNED";
  const canComplete =
    row.lifecycleState === "IN_REVIEW" ||
    row.lifecycleState === "NEEDS_INFORMATION" ||
    row.lifecycleState === "ESCALATED";
  const canRequestInfo = canComplete;
  const canPause =
    canComplete || row.lifecycleState === "ASSIGNED";

  const submitAssign = async () => {
    const userId = window.prompt("Reviewer user id (UUID)");
    if (!userId) return;
    await onAction("assign", `${wfBase}/${isAssignedToOther ? "reassign" : "assign"}`, {
      [isAssignedToOther ? "newAssigneeUserId" : "assignedToUserId"]: userId,
    });
  };

  const submitWithNote = async (label: string, path: string, key = "note") => {
    const note = window.prompt(`${label} — note (required)`);
    if (!note || note.trim().length === 0) return;
    await onAction(label, `${wfBase}/${path}`, { [key]: note });
  };

  return (
    <div>
      <div style={inspectorHeaderStyle}>
        <span style={lifecycleBadgeStyle(row.lifecycleState)}>
          {row.lifecycleState.toLowerCase().replace("_", " ")}
        </span>
        <h2 style={inspectorTitleStyle}>Review workspace</h2>
        <p style={inspectorSubtitleStyle}>
          Workflow {row.workflowId.slice(0, 8)}… · Evidence{" "}
          <a
            href={`/evidence/${row.evidenceId}`}
            style={evidenceLinkStyle}
          >
            {row.evidenceId.slice(0, 8)}…
          </a>
        </p>
      </div>

      <Section label="Assignment">
        <KeyVal
          label="Reviewer"
          value={
            row.assignedToUserId
              ? row.assignedToUserId.slice(0, 12) + "…"
              : "Unassigned"
          }
        />
        <KeyVal
          label="Assigned"
          value={formatDateTime(row.assignedAtUtc ?? null)}
        />
        <KeyVal label="Priority" value={row.priority} />
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <button
            type="button"
            style={ghostButtonStyle}
            onClick={submitAssign}
            disabled={actionBusy !== null}
          >
            {isAssignedToOther ? "Reassign…" : "Assign…"}
          </button>
        </div>
      </Section>

      <Section label="SLA dimensions">
        {row.slaDimensions.map((d) => (
          <div key={d.dimension} style={slaRowStyle}>
            <span style={{ minWidth: 110, ...mutedStyle }}>
              {d.dimension.toLowerCase().replace("_", " ")}
            </span>
            <span style={slaBadgeStyle(d.state)}>
              {d.state.toLowerCase().replace("_", " ")}
            </span>
            <span style={{ flex: 1, textAlign: "right", ...mutedStyle }}>
              {formatRelative(d.dueAtUtc)}
            </span>
          </div>
        ))}
      </Section>

      <Section label="Reviewer actions">
        <div style={actionRowStyle}>
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={!canStart || actionBusy !== null}
            onClick={() => onAction("start", `${wfBase}/start`, {})}
          >
            Start review
          </button>
          <button
            type="button"
            style={ghostButtonStyle}
            disabled={!canRequestInfo || actionBusy !== null}
            onClick={() =>
              submitWithNote("request-info", "request-info", "note")
            }
          >
            Request info
          </button>
        </div>
        <div style={actionRowStyle}>
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={!canComplete || actionBusy !== null}
            onClick={() => onAction("approve", `${wfBase}/approve`, {})}
          >
            Approve
          </button>
          <button
            type="button"
            style={ghostButtonStyle}
            disabled={!canComplete || actionBusy !== null}
            onClick={() => submitWithNote("reject", "reject", "note")}
          >
            Reject
          </button>
        </div>
        <div style={actionRowStyle}>
          <button
            type="button"
            style={ghostButtonStyle}
            disabled={!canPause || actionBusy !== null}
            onClick={() =>
              submitWithNote("pause", "pause", "pausedReason")
            }
          >
            Pause
          </button>
          <a
            href={`/reviewer-ops/escalations?workflowId=${encodeURIComponent(row.workflowId)}`}
            style={{ ...ghostButtonStyle, textDecoration: "none", display: "inline-block" }}
          >
            Escalation log
          </a>
        </div>
      </Section>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Small components
// -----------------------------------------------------------------------------

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={sectionStyle}>
      <div style={sectionLabelStyle}>{label}</div>
      <div>{children}</div>
    </div>
  );
}

function KeyVal({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={keyValRowStyle}>
      <span style={keyValLabelStyle}>{label}</span>
      <span style={keyValValueStyle}>{value}</span>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Local styles
// -----------------------------------------------------------------------------

const threeColStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "200px 1fr 360px",
  gap: 16,
  marginTop: 16,
  alignItems: "flex-start",
};

const leftRailStyle: React.CSSProperties = {
  background: TOKENS.surface,
  border: `1px solid ${TOKENS.border}`,
  borderRadius: 8,
  padding: 12,
  position: "sticky",
  top: 16,
  maxHeight: "calc(100vh - 32px)",
  overflowY: "auto",
};

const centerColStyle: React.CSSProperties = {
  ...cardStyle,
  padding: 0,
};

const rightRailStyle: React.CSSProperties = {
  background: TOKENS.surface,
  border: `1px solid ${TOKENS.border}`,
  borderRadius: 8,
  padding: 16,
  position: "sticky",
  top: 16,
  maxHeight: "calc(100vh - 32px)",
  overflowY: "auto",
};

const queueListStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  marginTop: 4,
};

function queueButtonStyle(active: boolean, tone: string): React.CSSProperties {
  const bg: string = active ? TOKENS.accent : TOKENS.surface;
  let fg: string = active ? TOKENS.accentInk : "#334155";
  let borderColor: string = active ? TOKENS.accent : TOKENS.borderStrong;
  if (!active && tone === "alert") {
    borderColor = "#fecaca";
    fg = "#991b1b";
  } else if (!active && tone === "warn") {
    borderColor = "#fde68a";
    fg = "#78350f";
  }
  return {
    padding: "6px 10px",
    fontSize: 12,
    fontWeight: 500,
    background: bg,
    color: fg,
    border: `1px solid ${borderColor}`,
    borderRadius: 6,
    textAlign: "left",
    cursor: "pointer",
  };
}

function priorityChipStyle(priority: string): React.CSSProperties {
  const palette: Record<string, { bg: string; fg: string }> = {
    URGENT: { bg: "#fef2f2", fg: "#7f1d1d" },
    HIGH: { bg: "#fef3c7", fg: "#78350f" },
    NORMAL: { bg: "#f1f5f9", fg: "#334155" },
    LOW: { bg: "#f8fafc", fg: "#64748b" },
  };
  const p = palette[priority] ?? palette.NORMAL;
  return {
    padding: "2px 6px",
    fontSize: 10,
    fontWeight: 600,
    borderRadius: 4,
    background: p.bg,
    color: p.fg,
    textTransform: "uppercase",
    letterSpacing: 0.3,
    display: "inline-block",
  };
}

const evidenceLinkStyle: React.CSSProperties = {
  color: TOKENS.link,
  textDecoration: "none",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 12,
};

const inspectorHeaderStyle: React.CSSProperties = {
  paddingBottom: 12,
  borderBottom: `1px solid ${TOKENS.divider}`,
  marginBottom: 8,
};

const inspectorTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 700,
  margin: "8px 0 4px",
  color: TOKENS.ink,
};

const inspectorSubtitleStyle: React.CSSProperties = {
  fontSize: 12,
  color: TOKENS.inkMuted,
  margin: 0,
};

const sectionStyle: React.CSSProperties = {
  padding: "12px 0",
  borderBottom: `1px solid ${TOKENS.divider}`,
};

const sectionLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  color: TOKENS.inkMuted,
  letterSpacing: 0.5,
  marginBottom: 6,
};

const keyValRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  gap: 8,
  padding: "2px 0",
  fontSize: 12,
};

const keyValLabelStyle: React.CSSProperties = {
  color: TOKENS.inkSubtle,
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 0.3,
  whiteSpace: "nowrap",
};

const keyValValueStyle: React.CSSProperties = {
  color: TOKENS.ink,
  textAlign: "right",
  fontSize: 12,
  wordBreak: "break-word",
};

const slaRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "4px 0",
};

const actionRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 6,
  marginTop: 6,
};

// Phase 25.5 — sticky bulk toolbar + skeleton loader.
const bulkBarStyle: React.CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 2,
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 12px",
  background: "#0f172a",
  color: "#fff",
  borderRadius: 6,
  marginBottom: 8,
  flexWrap: "wrap",
};

function SkeletonTable() {
  return (
    <div style={{ padding: "8px 4px" }}>
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <div
          key={i}
          style={{
            display: "grid",
            gridTemplateColumns: "20px 80px 60px 80px 100px 100px 1fr",
            gap: 12,
            padding: "8px 10px",
            borderBottom: "1px solid #f1f5f9",
          }}
          aria-hidden="true"
        >
          {[20, 80, 60, 80, 100, 100, 160].map((w, j) => (
            <div
              key={j}
              style={{
                height: 14,
                width: w,
                background: "#e2e8f0",
                borderRadius: 4,
                opacity: 0.6 + (i % 4) * 0.1,
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
