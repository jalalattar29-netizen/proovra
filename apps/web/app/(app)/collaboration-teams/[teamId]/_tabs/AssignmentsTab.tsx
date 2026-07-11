"use client";

import { useEffect, useMemo, useState } from "react";

import { useToast } from "../../../../../components/ui";
import { AppListbox } from "../../../../../components/app-primitives/AppListbox";
import { AppStatusBadge, type AppTone } from "../../../../../components/app-primitives/AppStatusBadge";
import { ApiError } from "../../../../../lib/api";
import { notifyApiError } from "../../../../../lib/feedback/notify";
import { formatUserDate, formatUserDateTime } from "../../../../../lib/date";
import {
  type CollaborationTeamAssignment,
  type CollaborationTeamDetail,
  type CollaborationTeamMember,
  createAssignment,
  listAssignments,
  updateAssignment,
} from "../../../../../lib/api/collaboration-teams";
import {
  COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES,
  COLLABORATION_TEAM_ASSIGNMENT_STATUSES,
  COLLABORATION_TEAM_ASSIGNMENT_TARGETS,
  type CollaborationTeamAssignmentPriority,
  type CollaborationTeamAssignmentStatus,
  type CollaborationTeamAssignmentTarget,
} from "@proovra/shared";

// =============================================================================
// Assignments tab
//
// Neutral `app-*` design system. All header controls filter the
// already-fetched assignments client-side (search / assignee / priority) —
// only the status filter re-queries, preserving the original data flow.
// =============================================================================

// -----------------------------------------------------------------------------
// Humanization — backend enums are NEVER shown raw. Every status, priority and
// target-type is mapped to plain language before it renders.
// -----------------------------------------------------------------------------

const STATUS_LABELS: Record<CollaborationTeamAssignmentStatus, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In progress",
  COMPLETED: "Completed",
  REASSIGNED: "Reassigned",
  CANCELLED: "Cancelled",
};

const PRIORITY_LABELS: Record<CollaborationTeamAssignmentPriority, string> = {
  LOW: "Low",
  NORMAL: "Normal",
  HIGH: "High",
  URGENT: "Urgent",
};

const TARGET_LABELS: Record<CollaborationTeamAssignmentTarget, string> = {
  CASE: "Case",
  EVIDENCE: "Evidence",
  REVIEW: "Access review",
};

function statusLabel(status: CollaborationTeamAssignmentStatus): string {
  return STATUS_LABELS[status] ?? status;
}
function priorityLabel(priority: CollaborationTeamAssignmentPriority): string {
  return PRIORITY_LABELS[priority] ?? priority;
}
function targetLabel(target: CollaborationTeamAssignmentTarget): string {
  return TARGET_LABELS[target] ?? target;
}

// Status → semantic tone (truthful map).
function statusTone(status: CollaborationTeamAssignmentStatus): AppTone {
  switch (status) {
    case "COMPLETED":
      return "green";
    case "IN_PROGRESS":
    case "OPEN":
      return "amber";
    case "CANCELLED":
      return "red";
    case "REASSIGNED":
      return "slate";
    default:
      return "slate";
  }
}

// Priority → semantic tone: Low=slate, Normal=indigo, High=amber, Urgent=red.
function priorityTone(priority: CollaborationTeamAssignmentPriority): AppTone {
  switch (priority) {
    case "URGENT":
      return "red";
    case "HIGH":
      return "amber";
    case "NORMAL":
      return "indigo";
    case "LOW":
      return "slate";
    default:
      return "slate";
  }
}

function memberLabel(member: CollaborationTeamMember): string {
  return (
    member.user.displayName ||
    [member.user.firstName, member.user.lastName].filter(Boolean).join(" ") ||
    member.user.email ||
    member.userId.slice(0, 8)
  );
}

function initialOf(label: string): string {
  return (label.trim()[0] ?? "?").toUpperCase();
}

const SearchIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);

function AssignmentsTab({
  team,
  canAssign,
}: {
  team: CollaborationTeamDetail;
  canAssign: boolean;
}) {
  const { addToast } = useToast();
  const [items, setItems] =
    useState<ReadonlyArray<CollaborationTeamAssignment>>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] =
    useState<CollaborationTeamAssignmentStatus | null>(null);
  const [creating, setCreating] = useState(false);

  // Client-side-only filters over already-fetched rows (no new fetch).
  const [query, setQuery] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("");
  const [priorityFilter, setPriorityFilter] = useState<string>("");

  const refresh = async () => {
    setLoading(true);
    try {
      const rows = await listAssignments(team.id, { status: statusFilter });
      setItems(rows);
    } catch (err) {
      if (err instanceof ApiError) {
        addToast("Couldn't load assignments", "error", undefined, err.requestId ? { supportReference: err.requestId } : undefined);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [team.id, statusFilter]);

  const assigneeName = (userId: string | null): string => {
    if (!userId) return "Team-level";
    const m = team.members.find((mm) => mm.userId === userId);
    return m ? memberLabel(m) : userId.slice(0, 8);
  };

  const visibleItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((a) => {
      if (assigneeFilter) {
        if (assigneeFilter === "__team__") {
          if (a.assigneeUserId) return false;
        } else if (a.assigneeUserId !== assigneeFilter) {
          return false;
        }
      }
      if (priorityFilter && a.priority !== priorityFilter) return false;
      if (q) {
        const haystack = [
          targetLabel(a.targetType),
          a.targetId,
          a.note ?? "",
          assigneeName(a.assigneeUserId),
          statusLabel(a.status),
          priorityLabel(a.priority),
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [items, query, assigneeFilter, priorityFilter, team.members]);

  const statusOptions = [
    { value: "", label: "All statuses" },
    ...COLLABORATION_TEAM_ASSIGNMENT_STATUSES.map((s) => ({
      value: s,
      label: statusLabel(s),
    })),
  ];

  const assigneeOptions = [
    { value: "", label: "All assignees" },
    { value: "__team__", label: "Team-level (unassigned)" },
    ...team.members
      .filter((m) => m.status === "ACTIVE")
      .map((m) => ({ value: m.userId, label: memberLabel(m) })),
  ];

  const priorityOptions = [
    { value: "", label: "All priorities" },
    ...COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES.map((p) => ({
      value: p,
      label: priorityLabel(p),
    })),
  ];

  return (
    <section data-testid="tab-assignments-content" className="app-section-stack">
      {/* §4 — reuse the EXACT Cases filter-bar styling: `.cases-toolbar`
          row + translucent `.cases-segments` control tray + `.cases-search-
          field`/`.cases-filter-search` search. No new/duplicate styles. */}
      <div className="cases-toolbar">
        <div className="cases-segments" role="group" aria-label="Filter assignments">
          <div style={{ width: 168 }} data-testid="assignment-status-filter">
            <AppListbox
              value={statusFilter ?? ""}
              options={statusOptions}
              onChange={(v) =>
                setStatusFilter((v as CollaborationTeamAssignmentStatus) || null)
              }
              ariaLabel="Filter by status"
              id="assignment-status-filter"
            />
          </div>

          <div style={{ width: 190 }}>
            <AppListbox
              value={assigneeFilter}
              options={assigneeOptions}
              onChange={(v) => setAssigneeFilter(v)}
              ariaLabel="Filter by assignee"
              id="assignment-assignee-filter"
            />
          </div>

          <div style={{ width: 168 }}>
            <AppListbox
              value={priorityFilter}
              options={priorityOptions}
              onChange={(v) => setPriorityFilter(v)}
              ariaLabel="Filter by priority"
              id="assignment-priority-filter"
            />
          </div>
        </div>

        <div className="cases-toolbar-right">
          <div className="cases-search-field">
            <span className="cases-search-icon" aria-hidden="true">
              <SearchIcon />
            </span>
            <input
              type="search"
              className="cases-filter-search"
              placeholder="Search assignments"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search assignments"
              data-testid="assignment-search"
            />
          </div>

          {canAssign ? (
            <button
              type="button"
              className="app-primary-action"
              onClick={() => setCreating(true)}
              data-testid="create-assignment-button"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              Create assignment
            </button>
          ) : null}
        </div>
      </div>

      {loading ? (
        <div className="app-table-surface" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="app-skeleton"
              style={{ height: 44 }}
              aria-hidden
            />
          ))}
          <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
            Loading assignments…
          </span>
        </div>
      ) : visibleItems.length === 0 ? (
        <div className="app-empty" data-testid="assignments-empty">
          <span className="app-empty__icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
          </span>
          <strong>
            {items.length === 0
              ? statusFilter
                ? `No ${statusLabel(statusFilter).toLowerCase()} assignments`
                : "No assignments yet"
              : "No matching assignments"}
          </strong>
          <p>
            {items.length === 0
              ? canAssign
                ? "Create an assignment to delegate a case, evidence item, or access review to a teammate."
                : "Assignments delegated to this team will appear here."
              : "Try adjusting your search or filters."}
          </p>
        </div>
      ) : (
        <div className="app-table-surface">
          <table className="app-table" data-responsive>
            <thead>
              <tr>
                <th>Assignment</th>
                <th>Target</th>
                <th>Assignee</th>
                <th>Priority</th>
                <th>Status</th>
                <th>Due date</th>
                <th>Last updated</th>
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((a) => (
                <AssignmentRow
                  key={a.id}
                  assignment={a}
                  teamId={team.id}
                  canAssign={canAssign}
                  members={team.members}
                  onChanged={async (msg) => {
                    addToast(msg, "success");
                    await refresh();
                  }}
                  onError={(err) =>
                    addToast(
                      err.message,
                      "error",
                      undefined,
                      err.requestId ? { supportReference: err.requestId } : undefined,
                    )
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating ? (
        <CreateAssignmentModal
          team={team}
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            addToast("Assignment created.", "success");
            await refresh();
          }}
        />
      ) : null}
    </section>
  );
}

function AssignmentRow({
  assignment,
  teamId,
  canAssign,
  members,
  onChanged,
  onError,
}: {
  assignment: CollaborationTeamAssignment;
  teamId: string;
  canAssign: boolean;
  members: ReadonlyArray<CollaborationTeamMember>;
  onChanged: (msg: string) => void | Promise<void>;
  onError: (err: { message: string; requestId?: string }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const assignee = members.find((m) => m.userId === assignment.assigneeUserId);
  const assigneeLabel = assignee ? memberLabel(assignee) : "Team-level";
  const isTeamLevel = !assignment.assigneeUserId;

  const update = async (
    patch: Parameters<typeof updateAssignment>[2],
    msg: string,
  ) => {
    setBusy(true);
    try {
      await updateAssignment(teamId, assignment.id, patch);
      await onChanged(msg);
    } catch (err) {
      if (err instanceof ApiError) {
        onError({ message: err.message, requestId: err.requestId });
      } else {
        onError({ message: "Couldn't update assignment." });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr data-testid={`assignment-row-${assignment.id}`}>
      <td data-label="Assignment">
        <div className="app-table__primary">{targetLabel(assignment.targetType)}</div>
        {assignment.note ? (
          <div className="app-table__muted" style={{ marginTop: 2 }}>
            {assignment.note}
          </div>
        ) : null}
      </td>
      <td data-label="Target">
        <span
          className="app-table__muted"
          style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
          title={assignment.targetId}
        >
          {assignment.targetId.slice(0, 8)}…
        </span>
      </td>
      <td data-label="Assignee">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          {isTeamLevel ? (
            <span className="app-table__muted">Team-level</span>
          ) : (
            <>
              <span className="app-avatar app-avatar--sm" aria-hidden>
                {initialOf(assigneeLabel)}
              </span>
              <span>{assigneeLabel}</span>
            </>
          )}
        </span>
      </td>
      <td data-label="Priority">
        <AppStatusBadge tone={priorityTone(assignment.priority)}>
          {priorityLabel(assignment.priority)}
        </AppStatusBadge>
      </td>
      <td data-label="Status">
        <AppStatusBadge tone={statusTone(assignment.status)}>
          {statusLabel(assignment.status)}
        </AppStatusBadge>
      </td>
      <td data-label="Due date">
        {assignment.dueAtUtc ? (
          formatUserDate(assignment.dueAtUtc)
        ) : (
          <span className="app-table__muted">—</span>
        )}
      </td>
      <td data-label="Last updated" className="app-table__muted">
        {formatUserDateTime(assignment.updatedAt)}
      </td>
      <td data-label="" style={{ textAlign: "right" }}>
        <span className="app-table__actions">
          {canAssign && assignment.status === "OPEN" ? (
            <>
              <button
                type="button"
                disabled={busy}
                className="app-ghost-action"
                onClick={() =>
                  void update({ status: "IN_PROGRESS" }, "Marked in progress.")
                }
                data-testid={`assignment-start-${assignment.id}`}
              >
                Start
              </button>
              <button
                type="button"
                disabled={busy}
                className="app-secondary-action"
                style={{ height: 30 }}
                onClick={() =>
                  void update({ status: "COMPLETED" }, "Assignment completed.")
                }
                data-testid={`assignment-complete-${assignment.id}`}
              >
                Complete
              </button>
            </>
          ) : null}
          {canAssign && assignment.status === "IN_PROGRESS" ? (
            <button
              type="button"
              disabled={busy}
              className="app-secondary-action"
              style={{ height: 30 }}
              onClick={() =>
                void update({ status: "COMPLETED" }, "Assignment completed.")
              }
              data-testid={`assignment-complete-${assignment.id}`}
            >
              Complete
            </button>
          ) : null}
          {!canAssign ||
          (assignment.status !== "OPEN" &&
            assignment.status !== "IN_PROGRESS") ? (
            <span className="app-table__muted" aria-hidden>
              —
            </span>
          ) : null}
        </span>
      </td>
    </tr>
  );
}

function CreateAssignmentModal({
  team,
  onClose,
  onCreated,
}: {
  team: CollaborationTeamDetail;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const { addToast } = useToast();
  const [targetType, setTargetType] =
    useState<CollaborationTeamAssignmentTarget>("CASE");
  const [targetId, setTargetId] = useState("");
  const [assigneeUserId, setAssigneeUserId] = useState<string>("");
  const [priority, setPriority] =
    useState<CollaborationTeamAssignmentPriority>("NORMAL");
  const [dueAt, setDueAt] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetId || busy) return;
    setBusy(true);
    try {
      await createAssignment(team.id, {
        targetType,
        targetId,
        assigneeUserId: assigneeUserId || null,
        priority,
        dueAtUtc: dueAt ? new Date(dueAt).toISOString() : null,
        note: note || null,
      });
      await onCreated();
    } catch (err) {
      if (err instanceof ApiError) {
        notifyApiError(addToast, err);
      } else {
        addToast("Couldn't create assignment.", "error");
      }
    } finally {
      setBusy(false);
    }
  };

  const targetTypeOptions = COLLABORATION_TEAM_ASSIGNMENT_TARGETS.map((t) => ({
    value: t,
    label: targetLabel(t),
  }));

  const assigneeOptions = [
    { value: "", label: "Team-level (no specific assignee)" },
    ...team.members
      .filter((m) => m.status === "ACTIVE")
      .map((m) => ({
        value: m.userId,
        label: memberLabel(m),
        description: m.user.email ?? undefined,
      })),
  ];

  const priorityOptions = COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES.map((p) => ({
    value: p,
    label: priorityLabel(p),
  }));

  return (
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,0.45)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
        zIndex: 200,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={onSubmit}
        data-testid="create-assignment-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-assignment-title"
        className="app-dialog"
      >
        <div className="app-dialog__head">
          <h2 id="create-assignment-title" className="app-dialog__title">
            Create assignment
          </h2>
          <p className="app-dialog__subtitle">
            Delegate a case, evidence item, or access review to a teammate or to
            the team.
          </p>
        </div>

        <div className="app-dialog__body">
          <div data-testid="assignment-target-type">
            <label className="app-field-label" id="assignment-target-type-label">
              Target type
            </label>
            <AppListbox
              value={targetType}
              options={targetTypeOptions}
              onChange={(v) =>
                setTargetType(v as CollaborationTeamAssignmentTarget)
              }
              ariaLabelledby="assignment-target-type-label"
              id="assignment-target-type"
            />
          </div>

          <div>
            <label
              className="app-field-label"
              htmlFor="assignment-target-id"
            >
              {targetLabel(targetType)} reference
            </label>
            <input
              id="assignment-target-id"
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              required
              placeholder={`Search or paste the ${targetLabel(targetType).toLowerCase()} reference`}
              data-testid="assignment-target-id"
              className="app-form-input"
            />
            <p className="app-field-help">
              Paste the {targetLabel(targetType).toLowerCase()} reference from its
              detail page. Copy it from the {targetLabel(targetType).toLowerCase()}
              's URL or "Copy reference" action.
            </p>
          </div>

          <div data-testid="assignment-assignee">
            <label className="app-field-label" id="assignment-assignee-label">
              Assignee
            </label>
            <AppListbox
              value={assigneeUserId}
              options={assigneeOptions}
              onChange={(v) => setAssigneeUserId(v)}
              ariaLabelledby="assignment-assignee-label"
              id="assignment-assignee"
              placeholder="Team-level (no specific assignee)"
            />
          </div>

          <div data-testid="assignment-priority">
            <label className="app-field-label" id="assignment-priority-label">
              Priority
            </label>
            <AppListbox
              value={priority}
              options={priorityOptions}
              onChange={(v) =>
                setPriority(v as CollaborationTeamAssignmentPriority)
              }
              ariaLabelledby="assignment-priority-label"
              id="assignment-priority"
            />
          </div>

          <div>
            <label className="app-field-label" htmlFor="assignment-due">
              Due date <span style={{ fontWeight: 400, color: "var(--app-ink-secondary)" }}>(optional)</span>
            </label>
            <input
              id="assignment-due"
              type="datetime-local"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
              data-testid="assignment-due"
              className="app-form-input"
            />
          </div>

          <div>
            <label className="app-field-label" htmlFor="assignment-note">
              Description <span style={{ fontWeight: 400, color: "var(--app-ink-secondary)" }}>(optional)</span>
            </label>
            <textarea
              id="assignment-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={600}
              rows={3}
              data-testid="assignment-note"
              className="app-form-input"
              placeholder="Add context so the assignee knows what's expected."
            />
          </div>
        </div>

        <div className="app-dialog__footer">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="app-secondary-action"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!targetId || busy}
            className="app-primary-action"
            data-testid="assignment-submit"
          >
            {busy ? "Creating…" : "Create assignment"}
          </button>
        </div>
      </form>
    </div>
  );
}

export { AssignmentsTab };
