"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { useToast } from "../../../../../components/ui";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
// THE canonical accessible dialog (focus trap, Escape, focus restoration).
// Despite the `cases-experience` path this is the app-wide authority — the
// `Modal` re-exported from `components/ui` is the legacy one with none of that.
import { Modal } from "../../../../../components/cases-experience/matter-modals/Modal";
import { AppListbox } from "../../../../../components/app-primitives/AppListbox";
import { AppStatusBadge, type AppTone } from "../../../../../components/app-primitives/AppStatusBadge";
/*
 * UI POLISH (2026-09-09) — Priority and Status are ordinary column VALUES, and
 * a capsule behind every one of them turns a scannable table into a wall of
 * lozenges. They move to the no-capsule sibling of the badge: same canonical
 * tone table, same accessible meaning, no filled pill.
 *
 * The Overdue badge below deliberately STAYS a badge. It is an exception state
 * rather than a value every row carries, which is the case the badge exists for.
 */
import { AppStatusText } from "../../../../../components/app-primitives/AppStatusText";
import { ApiError } from "../../../../../lib/api";
import { notifyApiError } from "../../../../../lib/feedback/notify";
import type { SafeErrorFallback } from "../../../../../lib/feedback/toSafeUserError";
import { formatUserDate, formatUserDateTime } from "../../../../../lib/date";
import {
  ASSIGNEE_UNASSIGNED,
  type CollaborationTeamAssignment,
  type CollaborationTeamDetail,
  type CollaborationTeamMember,
  listAssignments,
  updateAssignment,
} from "../../../../../lib/api/collaboration-teams";
import {
  memberLabel,
  priorityLabel,
  statusLabel,
  targetLabel,
} from "../_components/assignment-vocabulary";
import {
  COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES,
  COLLABORATION_TEAM_ASSIGNMENT_STATUSES,
  COLLABORATION_TEAM_ASSIGNMENT_TARGETS,
  type CollaborationTeamAssignmentPriority,
  type CollaborationTeamAssignmentStatus,
} from "@proovra/shared";

// =============================================================================
// WORK — the group's operational surface.
//
// What work is this team responsible for, who is carrying it, what is late.
//
// Every control here is SERVER-authoritative: type, status, priority,
// assignee, overdue and search compose into one query and page on one keyset
// cursor. They used to filter the rows already in hand while only status
// re-queried, which on a group with more work than one page hid rows the
// operator could see and counted only what happened to be loaded.
//
// The rows name the RECORD, not its type. The server resolves each target's
// canonical label at read time — batched, workspace-scoped, never stored on
// the assignment — so a case renamed on /cases reads as renamed here.
//
// This surface OWNS nothing. It holds references to canonical Cases, Evidence
// records and Review workflows plus the responsibility metadata around them
// (assignee, priority, due date, status). Removing work here removes the
// team's responsibility and never the record.
// =============================================================================

// -----------------------------------------------------------------------------
// Humanization — backend enums are NEVER shown raw. Every status, priority and
// target-type is mapped to plain language before it renders.
// -----------------------------------------------------------------------------

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
  onCreateAssignment,
  reloadToken = 0,
}: {
  team: CollaborationTeamDetail;
  canAssign: boolean;
  /**
   * Opens the team's ONE create-assignment dialog, which the page owns.
   *
   * The dialog used to live in this file, privately, so the Work tab was the
   * only surface in the product that could delegate anything. It is a shared
   * launcher now and this button is one of its two callers — the team header
   * is the other — so there is exactly one form and one payload.
   */
  onCreateAssignment: () => void;
  /**
   * Bumped by the page when an assignment is created from ANYWHERE, so a
   * creation made from the header reaches a Work tab that is already mounted.
   * Without it the row appears only after a manual reload.
   */
  reloadToken?: number;
}) {
  const { addToast } = useToast();
  const [items, setItems] =
    useState<ReadonlyArray<CollaborationTeamAssignment>>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] =
    useState<CollaborationTeamAssignmentStatus | null>(null);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  /**
   * EVERY FILTER IS THE SERVER'S NOW.
   *
   * These narrowed the rows already in hand while the status filter went to
   * the database. On a group with more work than one page that is not a filter
   * — the row being searched for sits on page two, the empty state says
   * "nothing matches" about a set that was never asked, and the count beside
   * it means "matches on this page". Two controls side by side behaved
   * differently and neither said so.
   *
   * They are query parameters now, they compose into one WHERE, and they page
   * on the same keyset cursor.
   */
  const [query, setQuery] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("");
  const [priorityFilter, setPriorityFilter] = useState<string>("");
  const [targetTypeFilter, setTargetTypeFilter] = useState<string>("");
  /*
    `overdueOnly` state is gone with the toggle that set it (§8). It could only
    ever be `false` once the control was removed, and a filter permanently
    pinned to its own default is dead weight the next reader has to disprove.
    `listAssignments` still ACCEPTS the option and the API still answers it —
    the capability is intact, this surface simply no longer asks for it.
  */
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  // Debounced so typing issues one query per pause, not one per keystroke.
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(handle);
  }, [query]);

  // `isStale` lets the effect drop a list that arrived after the team or a
  // filter changed — a previous team's assignments must never render.
  const refresh = useCallback(async (isStale?: () => boolean) => {
    setLoading(true);
    try {
      // ONE PAGE, and the surface says which one. The server used to truncate
      // at two hundred with nothing to say so; a list that is silently
      // incomplete is worse than a short one, because it reads as the whole
      // set. `total` below is the SERVER's count for these filters, which is
      // what makes "showing N of M" honest.
      const page = await listAssignments(team.id, {
        status: statusFilter,
        targetType: (targetTypeFilter || null) as never,
        priority: (priorityFilter || null) as never,
        assignee: assigneeFilter || null,
        search: debouncedQuery,
      });
      if (isStale?.()) return;
      setItems(page.assignments);
      setTotal(page.total);
      setCursor(page.nextCursor);
      setHasMore(page.nextCursor !== null);
    } catch (err) {
      if (isStale?.()) return;
      if (err instanceof ApiError) {
        addToast("Couldn't load work", "error", undefined, err.requestId ? { supportReference: err.requestId } : undefined);
      }
    } finally {
      if (!isStale?.()) setLoading(false);
    }
  }, [
    team.id,
    statusFilter,
    targetTypeFilter,
    priorityFilter,
    assigneeFilter,
    debouncedQuery,
    addToast,
  ]);

  /*
   * `reloadToken` is in the dependency list on purpose. An assignment created
   * from the team header lands on a Work tab that is already mounted, and
   * without a signal from the page this list would keep showing the set it
   * fetched before the creation. It is a counter, not data — re-running the
   * SAME query is the whole point.
   */
  useEffect(() => {
    let cancelled = false;
    void refresh(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [refresh, reloadToken]);

  /**
   * The rest of the set, on the same cursor. Appended rather than replacing,
   * so "Load more" grows the page instead of navigating it — and the filters
   * that produced it are unchanged, because the cursor is only valid for them.
   */
  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await listAssignments(team.id, {
        status: statusFilter,
        targetType: (targetTypeFilter || null) as never,
        priority: (priorityFilter || null) as never,
        assignee: assigneeFilter || null,
        search: debouncedQuery,
        cursor,
      });
      setItems((prev) => [...prev, ...page.assignments]);
      setCursor(page.nextCursor);
      setHasMore(page.nextCursor !== null);
    } catch (err) {
      if (err instanceof ApiError) {
        addToast("Couldn't load more work", "error", undefined, err.requestId ? { supportReference: err.requestId } : undefined);
      }
    } finally {
      setLoadingMore(false);
    }
  }, [
    cursor,
    loadingMore,
    team.id,
    statusFilter,
    targetTypeFilter,
    priorityFilter,
    assigneeFilter,
    debouncedQuery,
    addToast,
  ]);

  // `assigneeName` is gone with the client-side search it fed: the search
  // haystack it built (target type, uuid, note, assignee, status, priority)
  // was the browser's approximation of a query the database now runs. The row
  // resolves its own assignee from `members`.

  /**
   * The server already applied every filter, so what came back IS what
   * matches. Re-filtering here would narrow a correct answer a second time
   * against a stale copy of the criteria.
   */
  const visibleItems = items;

  const statusOptions = [
    { value: "", label: "All statuses" },
    ...COLLABORATION_TEAM_ASSIGNMENT_STATUSES.map((s) => ({
      value: s,
      label: statusLabel(s),
    })),
  ];

  const assigneeOptions = [
    { value: "", label: "All assignees" },
    // The sentinel the SERVER understands. It used to be a client-only
    // `__team__` that the filter translated locally; now the value travels.
    { value: ASSIGNEE_UNASSIGNED, label: "Team-level (unassigned)" },
    ...team.members
      .filter((m) => m.status === "ACTIVE")
      .map((m) => ({ value: m.userId, label: memberLabel(m) })),
  ];

  const targetTypeOptions = [
    { value: "", label: "All work" },
    ...COLLABORATION_TEAM_ASSIGNMENT_TARGETS.map((t) => ({
      value: t,
      label: targetLabel(t),
    })),
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
        {/*
          A FILTER GROUP, NOT A SEGMENTED CONTROL (§9).

          These controls sat in `.cases-segments` — a 6px-gap, 4px-padded tray
          that caps itself at `max-content` and scrolls internally, because it
          was built for adjacent pill CHIPS. Four listboxes at 160-190px could
          not fit that, so the tray squeezed them until their labels collided.

          `.app-filter-group` wraps rather than shrinking, so a label is never
          clipped to make room: one row on a desktop, cleanly wrapped below it.

          FOUR CONTROLS, ALL THE SAME SHAPE. The row used to end in a checkbox
          — a fifth control of a different height, radius and interaction, so
          the toolbar read as four selectors plus an afterthought. Every filter
          here is now an `AppListbox`, which is what makes them line up.
        */}
        <div className="app-filter-group" role="group" aria-label="Filter work">
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

          {/* Which KIND of work — cases, evidence or reviews. */}
          <div style={{ width: 160 }} data-testid="assignment-target-type-filter">
            <AppListbox
              value={targetTypeFilter}
              options={targetTypeOptions}
              onChange={(v) => setTargetTypeFilter(v)}
              ariaLabel="Filter by work type"
              id="assignment-target-type-filter"
            />
          </div>

          {/*
            THE "OVERDUE ONLY" TOGGLE IS GONE (§8) — the CONTROL, not the
            concept. Overdue remains server-derived, still returned per row and
            still rendered as the red marker on a late assignment, so a reader
            can see which work is late; there is simply no longer a fifth
            control of a different SHAPE sitting at the end of a row of four
            selectors. Nothing in the overdue or SLA computation changed.
          */}
        </div>

        <div className="cases-toolbar-right">
          <div className="cases-search-field">
            <span className="cases-search-icon" aria-hidden="true">
              <SearchIcon />
            </span>
            <input
              type="search"
              className="cases-filter-search"
              placeholder="Search work"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search work"
              data-testid="assignment-search"
            />
          </div>

          {canAssign ? (
            <button
              type="button"
              className="app-primary-action"
              onClick={onCreateAssignment}
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
            Loading work…
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
          {/*
            SAY WHAT IS SHOWN.

            `total` is now the SERVER's count FOR THESE FILTERS, so "showing 50
            of 380" means what it appears to mean. It used to be the total for
            the status filter alone while the rows had been narrowed further in
            the browser, so the two numbers described different sets — and the
            advice was to "refine the filters", which could not reach anything
            the page did not already hold. The rest is reachable now.
          */}
          <p
            className="app-table__muted"
            data-testid="assignments-page-summary"
            style={{ margin: "0 0 0.5rem" }}
          >
            Showing {visibleItems.length} of {total}
          </p>
          <table className="app-table" data-responsive>
            <thead>
              <tr>
                {/* "Work" names the record; the old "Assignment"/"Target"
                    pair printed a type in one column and "Open case" in the
                    other, so neither said which record it was. */}
                <th>Work</th>
                <th>Review state</th>
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
                  /* Through the safe-error boundary like every other mutation
                     on this page. This called `addToast(err.message)` directly,
                     which bypassed `toSafeUserError` entirely — the one path
                     that could have put a raw backend string in front of a
                     user. */
                  onError={(err) =>
                    notifyApiError(addToast, err, {
                      message: "Couldn't update this work item.",
                    })
                  }
                />
              ))}
            </tbody>
          </table>
          {/*
            The rest of the set, on the same cursor. Without this the surface
            showed one page and told the operator to narrow the filters — which
            could never reach a row the page did not already hold.
          */}
          {hasMore ? (
            <div style={{ padding: "0.75rem", textAlign: "center" }}>
              <button
                type="button"
                className="app-secondary-action"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                data-testid="assignments-load-more"
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          ) : null}
        </div>
      )}
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
  /** The error itself — see the note on MembersTab's identical prop (§5). */
  onError: (err: unknown, fallback?: SafeErrorFallback) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const { confirm } = useConfirmAction();
  const assignee = members.find((m) => m.userId === assignment.assigneeUserId);
  const assigneeLabel = assignee ? memberLabel(assignee) : "Team-level";
  const isTeamLevel = !assignment.assigneeUserId;

  /**
   * Cancel the TEAM'S responsibility. The record is not touched.
   *
   * The confirmation says exactly what survives, because this is the one
   * control on the surface a person could mistake for a destructive one, and
   * on an evidence platform that mistake has to be impossible to make.
   */
  const removeResponsibility = async () => {
    const name =
      assignment.target.resolved && assignment.target.label
        ? assignment.target.label
        : targetLabel(assignment.targetType).toLowerCase();
    const ok = await confirm({
      title: "Remove this work from the team?",
      description: `The team stops being responsible for ${name}. The ${targetLabel(
        assignment.targetType,
      ).toLowerCase()} itself is not changed, not unlinked and not deleted — it keeps its owner and stays exactly where it is.`,
      confirmLabel: "Remove from team",
      tone: "danger",
    });
    if (!ok) return;
    await update({ status: "CANCELLED" }, "Removed from this team.");
  };

  const update = async (
    patch: Parameters<typeof updateAssignment>[2],
    msg: string,
  ) => {
    setBusy(true);
    try {
      await updateAssignment(teamId, assignment.id, patch);
      await onChanged(msg);
    } catch (err) {
      onError(err, { message: "Couldn't update assignment." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr data-testid={`assignment-row-${assignment.id}`}>
      <td data-label="Work">
        {/*
          THE ROW NAMES THE RECORD.

          This printed the target TYPE — the literal word "Case" — because the
          list response carried nothing but a uuid. Twenty rows read as twenty
          identical lines, and the one question the row exists to answer,
          "WHICH case?", could only be answered by opening each one.

          `assignment.target` is the server's read-time resolution of the
          canonical record: batched, workspace-scoped, and never stored on the
          assignment, so a case renamed on /cases reads as renamed here.
        */}
        <Link
          href={targetHref(assignment.targetType, assignment.targetId)}
          className="app-table__link app-table__primary"
          data-testid={`assignment-target-link-${assignment.id}`}
        >
          {assignment.target.resolved && assignment.target.label
            ? assignment.target.label
            : /*
                An unresolved target is a record this workspace cannot read —
                deleted, or a row written before targets were validated at
                write time. Saying so is the honest answer; inventing a title
                for a record that may not exist is not.
              */
              `${targetLabel(assignment.targetType)} (unavailable)`}
        </Link>
        <div className="app-table__muted" style={{ marginTop: 2 }}>
          {targetLabel(assignment.targetType)}
          {assignment.target.sublabel ? ` · ${assignment.target.sublabel}` : ""}
          {assignment.target.state ? ` · ${assignment.target.state}` : ""}
        </div>
        {assignment.note ? (
          <div className="app-table__muted" style={{ marginTop: 2 }}>
            {assignment.note}
          </div>
        ) : null}
      </td>
      <td data-label="Review state">
        {/*
          Projected READ-ONLY from the canonical review workflow. A group that
          is responsible for a review needs to know whether it is late and
          whether it has escalated in order to decide what to do next; it does
          not own any of it, and the actions live in the reviewer console the
          row links to.
        */}
        {assignment.target.review ? (
          <span
            className="app-table__muted"
            data-testid={`assignment-review-state-${assignment.id}`}
          >
            {assignment.target.review.slaStatus ?? "No SLA"}
            {assignment.target.review.escalationLevel > 0
              ? ` · escalated ×${assignment.target.review.escalationLevel}`
              : ""}
          </span>
        ) : (
          <span className="app-table__muted">—</span>
        )}
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
        <AppStatusText tone={priorityTone(assignment.priority)}>
          {priorityLabel(assignment.priority)}
        </AppStatusText>
      </td>
      <td data-label="Status">
        <AppStatusText tone={statusTone(assignment.status)}>
          {statusLabel(assignment.status)}
        </AppStatusText>
      </td>
      <td data-label="Due date">
        {assignment.dueAtUtc ? (
          /*
            `overdue` is the SERVER's, decided against the server's clock and
            by the same predicate the "Overdue only" filter uses — so the badge
            on a row and the count in the filter can never disagree, which they
            would the moment a browser's clock drifted or a page sat open past
            midnight.
          */
          <span
            data-overdue={assignment.overdue ? "true" : "false"}
            data-testid={`assignment-due-${assignment.id}`}
          >
            {assignment.overdue ? (
              <AppStatusBadge tone="red">
                Overdue · {formatUserDate(assignment.dueAtUtc)}
              </AppStatusBadge>
            ) : (
              formatUserDate(assignment.dueAtUtc)
            )}
          </span>
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
          {canAssign &&
          (assignment.status === "OPEN" ||
            assignment.status === "IN_PROGRESS") ? (
            <>
              {/*
                Reassign, reprioritise, re-date. A supervisor's actual job is
                moving work between people and changing when it is needed, and
                the row offered neither — only Start and Complete, which are
                the assignee's actions, not the manager's.
              */}
              <button
                type="button"
                disabled={busy}
                className="app-ghost-action"
                onClick={() => setEditing(true)}
                data-testid={`assignment-edit-${assignment.id}`}
              >
                Edit
              </button>
              {/*
                REMOVING RESPONSIBILITY IS NOT DELETING ANYTHING.

                The wording is deliberate and load-bearing. This cancels the
                TEAM'S RESPONSIBILITY for a record; the Case, the Evidence
                record and the Review workflow are untouched, keep their
                owners, keep their custody and remain exactly where they were.
                A control on an evidence platform that reads "Delete" while
                meaning "stop tracking" is how somebody eventually believes
                they destroyed something they did not — or destroys something
                they meant to keep.
              */}
              <button
                type="button"
                disabled={busy}
                className="app-danger-link"
                onClick={() => void removeResponsibility()}
                data-testid={`assignment-remove-${assignment.id}`}
              >
                Remove from team
              </button>
            </>
          ) : null}
          {!canAssign ||
          (assignment.status !== "OPEN" &&
            assignment.status !== "IN_PROGRESS") ? (
            <span className="app-table__muted" aria-hidden>
              —
            </span>
          ) : null}
        </span>
        {editing ? (
          <EditAssignmentModal
            assignment={assignment}
            members={members}
            onClose={() => setEditing(false)}
            onSaved={async (msg) => {
              setEditing(false);
              await onChanged(msg);
            }}
            onError={onError}
            teamId={teamId}
          />
        ) : null}
      </td>
    </tr>
  );
}

/**
 * REASSIGN, REPRIORITISE, RE-DATE — the supervisor's half of the surface.
 *
 * The row only ever offered Start and Complete, which are the ASSIGNEE's
 * actions. Moving work between people and changing when it is needed is the
 * manager's job and the reason a group has a lead, and there was no control
 * for it anywhere: the only way to change an assignee was to cancel the
 * assignment and create another one, which loses its history.
 *
 * It writes the SAME `updateAssignment` the row's status buttons write. One
 * authority, audited on the group's activity timeline, and a reassignment
 * notifies the person who has just become responsible.
 */
function EditAssignmentModal({
  assignment,
  members,
  teamId,
  onClose,
  onSaved,
  onError,
}: {
  assignment: CollaborationTeamAssignment;
  members: ReadonlyArray<CollaborationTeamMember>;
  teamId: string;
  onClose: () => void;
  onSaved: (msg: string) => void | Promise<void>;
  /** The error itself — see the note on MembersTab's identical prop (§5). */
  onError: (err: unknown, fallback?: SafeErrorFallback) => void;
}) {
  const [assigneeUserId, setAssigneeUserId] = useState<string>(
    assignment.assigneeUserId ?? "",
  );
  const [priority, setPriority] = useState<CollaborationTeamAssignmentPriority>(
    assignment.priority,
  );
  // `datetime-local` wants a local wall-clock string, so the stored UTC
  // instant is trimmed to minutes for the control and sent back as an ISO
  // instant below. Empty means "no due date", which is a real choice.
  const [dueAt, setDueAt] = useState(
    assignment.dueAtUtc ? assignment.dueAtUtc.slice(0, 16) : "",
  );
  const [note, setNote] = useState(assignment.note ?? "");
  const [busy, setBusy] = useState(false);

  const assigneeOptions = [
    { value: "", label: "Team-level (nobody specific)" },
    ...members
      .filter((m) => m.status === "ACTIVE")
      .map((m) => ({ value: m.userId, label: memberLabel(m) })),
  ];

  const submit = async () => {
    setBusy(true);
    try {
      await updateAssignment(teamId, assignment.id, {
        assigneeUserId: assigneeUserId || null,
        priority,
        dueAtUtc: dueAt ? new Date(dueAt).toISOString() : null,
        note: note.trim() ? note.trim() : null,
      });
      await onSaved("Work updated.");
    } catch (err) {
      onError(err, { message: "Couldn't update this work." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit work"
      description="Change who is responsible, how urgent it is, and when it is needed. The record itself is not affected."
      testid="edit-assignment-modal"
      footer={
        <>
          <button type="button" className="app-secondary-action" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="app-primary-action"
            disabled={busy}
            onClick={() => void submit()}
            data-testid="edit-assignment-submit"
          >
            {busy ? "Saving…" : "Save changes"}
          </button>
        </>
      }
    >
      <div style={{ display: "grid", gap: 14 }}>
        <div data-testid="edit-assignment-assignee">
          <label className="app-field-label" htmlFor="edit-assignment-assignee-input">
            Assignee
          </label>
          <AppListbox
            value={assigneeUserId}
            options={assigneeOptions}
            onChange={setAssigneeUserId}
            ariaLabel="Assignee"
            id="edit-assignment-assignee-input"
          />
          <p className="app-field__help">
            Team-level work belongs to the whole team and notifies nobody in
            particular.
          </p>
        </div>

        <div data-testid="edit-assignment-priority">
          <label className="app-field-label" htmlFor="edit-assignment-priority-input">
            Priority
          </label>
          <AppListbox
            value={priority}
            options={COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES.map((p) => ({
              value: p,
              label: priorityLabel(p),
            }))}
            onChange={(v) =>
              setPriority(v as CollaborationTeamAssignmentPriority)
            }
            ariaLabel="Priority"
            id="edit-assignment-priority-input"
          />
        </div>

        <div>
          <label className="app-field-label" htmlFor="edit-assignment-due">
            Due
          </label>
          <input
            id="edit-assignment-due"
            type="datetime-local"
            className="app-form-input"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
            data-testid="edit-assignment-due"
          />
        </div>

        <div>
          <label className="app-field-label" htmlFor="edit-assignment-note">
            Note
          </label>
          <textarea
            id="edit-assignment-note"
            className="app-form-input"
            rows={3}
            maxLength={600}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            data-testid="edit-assignment-note"
          />
        </div>
      </div>
    </Modal>
  );
}

/** The canonical page for each assignable record kind. */
function targetHref(
  targetType: CollaborationTeamAssignment["targetType"],
  targetId: string,
): string {
  if (targetType === "CASE") return `/cases/${encodeURIComponent(targetId)}`;
  if (targetType === "EVIDENCE") return `/evidence/${encodeURIComponent(targetId)}`;
  /*
    THE REVIEW LINK WAS A 404.

    This returned `/review/queue/<id>`, and no such route exists — the review
    surfaces are `/review/queues` (the plural LIST) and
    `/reviewer-ops/[reviewId]` (the single-workflow console). So every REVIEW
    assignment's only affordance led nowhere.

    `/reviewer-ops/:reviewId` is the right destination and needs no
    translation: it loads `/v1/reviewer-ops/workspace/:workflowId`, keyed by
    the `EvidenceReviewWorkflow` id — which is exactly what
    `listAssignableTargets` puts in `targetId` for this target type.
  */
  return `/reviewer-ops/${encodeURIComponent(targetId)}`;
}

export { AssignmentsTab };
