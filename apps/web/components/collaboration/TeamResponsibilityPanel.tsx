"use client";

/**
 * TEAM RESPONSIBILITY — the same relationship, shown on the record.
 *
 * =============================================================================
 * WHY THIS EXISTS
 * =============================================================================
 * A Collaboration Team could be made responsible for a case or an evidence
 * record since the assignment model shipped, and the record could never say
 * so: nothing outside the collaboration module read
 * `collaboration_team_assignments`. Responsibility was real, tenant-safe, and
 * visible only to someone who already knew to open that group's Work tab. Two
 * people could pick up the same case and neither would find out here.
 *
 * This is the read that closes the loop. ONE component serves both the Case
 * and the Evidence surface so the two cannot drift on what responsibility
 * looks like or which authority it comes from.
 *
 * =============================================================================
 * WHAT IT IS NOT
 * =============================================================================
 * It is not a second assignment model. It reads
 * `GET /v1/collaboration-teams/responsibility`, which returns rows from the
 * ONE group-responsibility authority; assigning from the Team page and
 * assigning from here would write that same authority. There is no
 * `responsibleTeamId` column and no mirror table.
 *
 * It is not access. A group being responsible for a record grants nobody the
 * right to read it — `/cases/:id` and `/evidence/:id` authorize themselves and
 * always did. This answers "who is coordinating this?", which is a question
 * about work, not about custody.
 *
 * It is not the individual-role authority. `CaseAssignment` remains canonical
 * for a person's ROLE on a case (owner, investigator, reviewer); this is the
 * operational UNIT that carries it. The two are deliberately separate and the
 * copy says which is which.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import {
  createAssignment,
  listTeamMembers,
  listTeamResponsibility,
  listTeams,
  updateAssignment,
  type CollaborationTeamSummary,
  type TeamResponsibility,
} from "../../lib/api/collaboration-teams";
// The target vocabulary and the group-permission predicate are shared, not
// re-declared per surface.
import {
  COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES,
  collaborationTeamRoleHasPermission,
  type CollaborationTeamAssignmentPriority,
  type CollaborationTeamAssignmentTarget,
} from "@proovra/shared";
import { AppListbox } from "../app-primitives/AppListbox";
import { Modal } from "../cases-experience/matter-modals/Modal";
import { useConfirmAction } from "../ui/ConfirmActionModal";
import { useToast } from "../ui";
import { notifyApiError } from "../../lib/feedback/notify";
import { AppStatusBadge, type AppTone } from "../app-primitives/AppStatusBadge";
import { formatUserDate } from "../../lib/date";
import { toSafeUserError } from "../../lib/feedback/toSafeUserError";

function priorityTone(p: TeamResponsibility["priority"]): AppTone {
  if (p === "URGENT") return "red";
  if (p === "HIGH") return "amber";
  if (p === "LOW") return "slate";
  return "indigo";
}

function statusLabel(s: TeamResponsibility["status"]): string {
  return s === "IN_PROGRESS" ? "In progress" : s === "OPEN" ? "Open" : s;
}

export function TeamResponsibilityPanel({
  targetType,
  targetId,
  /**
   * Rendered inside a surface that already owns a heading level, so the panel
   * takes a heading tag rather than assuming one and producing a second h1.
   */
  headingLevel = "h3",
}: {
  targetType: CollaborationTeamAssignmentTarget;
  targetId: string;
  headingLevel?: "h2" | "h3";
}) {
  const [rows, setRows] = useState<ReadonlyArray<TeamResponsibility> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [editing, setEditing] = useState<TeamResponsibility | null>(null);
  const { addToast } = useToast();
  const { confirm } = useConfirmAction();

  /**
   * THE TEAMS THIS VIEWER MAY HAND WORK TO.
   *
   * Filtered on `team.assignment.create` — the SAME group permission the
   * server enforces on `POST /v1/collaboration-teams/:teamId/assignments`.
   * That is a display decision only: assigning is still refused server-side
   * for anyone who lacks it, and this list exists so the control is not
   * offered where it would be refused.
   *
   * Empty means "you lead no team here", which is a real and common answer on
   * a workspace whose groups you only participate in.
   */
  const [assignable, setAssignable] = useState<
    ReadonlyArray<CollaborationTeamSummary>
  >([]);

  const load = useCallback(
    async (isStale: () => boolean) => {
      try {
        const res = await listTeamResponsibility({ targetType, targetId });
        if (isStale()) return;
        setRows(res);
      } catch (err) {
        if (isStale()) return;
        /**
         * A COORDINATION PANEL MUST NEVER BREAK THE RECORD IT SITS ON.
         *
         * This is supplementary context beside evidence and case data. If it
         * cannot load, the record still renders and the panel says so quietly
         * — it does not throw, and it does not blank the page around it.
         */
        setError(
          toSafeUserError(err, {
            message: "Team responsibility couldn't be loaded.",
          }).message,
        );
        setRows([]);
      }
    },
    [targetType, targetId],
  );

  useEffect(() => {
    let cancelled = false;
    void load(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    void listTeams({ limit: 100 })
      .then((page) => {
        if (cancelled) return;
        setAssignable(
          page.teams.filter(
            (t) =>
              t.status === "ACTIVE" &&
              collaborationTeamRoleHasPermission(
                t.viewerRole,
                "team.assignment.create",
              ),
          ),
        );
      })
      // A missing list means no assign control, never a broken record page.
      .catch(() => {
        if (!cancelled) setAssignable([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const canAssign = assignable.length > 0;

  /**
   * REMOVE THE TEAM'S RESPONSIBILITY. THE RECORD IS NOT TOUCHED.
   *
   * Writes the SAME `updateAssignment` the group's own Work tab writes — this
   * surface adds no writer of its own, which is what keeps "assign from either
   * side" a property of the UX rather than of the storage.
   */
  const removeResponsibility = async (row: TeamResponsibility) => {
    const ok = await confirm({
      title: `Remove ${row.teamName} from this record?`,
      description:
        "The team stops being responsible for it. The record itself is not changed, not unlinked and not deleted — it keeps its owner and stays exactly where it is.",
      confirmLabel: "Remove from team",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await updateAssignment(row.teamId, row.id, { status: "CANCELLED" });
      addToast("Removed from that team.", "success");
      await load(() => false);
    } catch (err) {
      notifyApiError(addToast, err, {
        message: "Could not remove the team's responsibility.",
      });
    }
  };

  // Nothing loaded yet — render nothing rather than a skeleton that flashes on
  // every record open for a panel that is empty most of the time.
  if (rows === null) return null;

  const Heading = headingLevel;

  return (
    <div className="app-panel" data-testid="team-responsibility-panel">
      <div className="app-panel__head">
        <Heading className="app-panel__title">Team responsibility</Heading>
        {/*
          ASSIGN FROM THE RECORD, NOT ONLY FROM THE TEAM.

          The same relationship, written from the side an operator is standing
          on. Somebody looking at a case should not have to know which group
          they lead, navigate to it, and search for the case they were already
          reading.

          It posts to `POST /v1/collaboration-teams/:teamId/assignments` — the
          SAME writer the group's Work tab uses. There is no record-side
          assignment model and no second endpoint; only the entry point is new.
        */}
        {canAssign ? (
          <button
            type="button"
            className="app-secondary-action"
            onClick={() => setAssigning(true)}
            data-testid="team-responsibility-assign"
          >
            Assign to a team
          </button>
        ) : null}
      </div>
      <div className="app-panel__body">
        {error ? (
          <p className="app-table__muted" style={{ margin: 0 }}>
            {error}
          </p>
        ) : rows.length === 0 ? (
          <p className="app-table__muted" style={{ margin: 0 }}>
            No collaboration team is currently responsible for this record.
            Assign it from a team&rsquo;s Work tab to coordinate it there.
          </p>
        ) : (
          <ul
            style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}
            data-testid="team-responsibility-list"
          >
            {rows.map((r) => (
              <li
                key={r.id}
                data-testid={`team-responsibility-${r.id}`}
                data-team-id={r.teamId}
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <Link
                  href={`/collaboration-teams/${encodeURIComponent(r.teamId)}?tab=work`}
                  className="app-table__link"
                >
                  {r.teamName}
                </Link>
                <AppStatusBadge tone={priorityTone(r.priority)}>
                  {r.priority === "NORMAL" ? "Normal priority" : `${r.priority.charAt(0)}${r.priority.slice(1).toLowerCase()} priority`}
                </AppStatusBadge>
                <span className="app-table__muted">{statusLabel(r.status)}</span>
                {r.dueAtUtc ? (
                  <span
                    className="app-table__muted"
                    data-overdue={r.overdue ? "true" : "false"}
                  >
                    {r.overdue ? "Overdue — due " : "Due "}
                    {formatUserDate(r.dueAtUtc)}
                  </span>
                ) : null}
                {r.assigneeUserId ? null : (
                  <span className="app-table__muted">Team-level</span>
                )}
                {/*
                  Reassign / reprioritise / re-date / remove, from the record.
                  Offered only for a team this viewer can manage work in — the
                  same permission the server enforces — and every one of these
                  writes the group's own `updateAssignment`.
                */}
                {assignable.some((t) => t.id === r.teamId) ? (
                  <span
                    style={{ marginLeft: "auto", display: "flex", gap: 8 }}
                  >
                    <button
                      type="button"
                      className="app-ghost-action"
                      onClick={() => setEditing(r)}
                      data-testid={`team-responsibility-edit-${r.id}`}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="app-danger-link"
                      onClick={() => void removeResponsibility(r)}
                      data-testid={`team-responsibility-remove-${r.id}`}
                    >
                      Remove from team
                    </button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <p
          className="app-table__muted"
          style={{ margin: "10px 0 0", fontSize: 12 }}
        >
          Responsibility coordinates work. It does not change who owns this
          record or who can open it.
        </p>
      </div>

      {assigning ? (
        <ResponsibilityDialog
          title="Assign this record to a team"
          description="The team becomes responsible for coordinating it. The record itself is unchanged — same owner, same place, same access."
          testid="assign-responsibility-modal"
          teams={assignable}
          onClose={() => setAssigning(false)}
          onSubmit={async (values) => {
            await createAssignment(values.teamId, {
              targetType,
              targetId,
              assigneeUserId: values.assigneeUserId || null,
              priority: values.priority,
              dueAtUtc: values.dueAt ? new Date(values.dueAt).toISOString() : null,
              note: values.note.trim() || null,
            });
            addToast("Assigned to the team.", "success");
            setAssigning(false);
            await load(() => false);
          }}
        />
      ) : null}

      {editing ? (
        <ResponsibilityDialog
          title={`Edit ${editing.teamName}'s responsibility`}
          description="Change who is responsible, how urgent it is, and when it is needed. The record itself is not affected."
          testid="edit-responsibility-modal"
          // The team is fixed when editing: moving work between GROUPS is a
          // remove plus an assign, not a silent re-key of one row, so the
          // activity timeline shows both halves.
          teams={assignable.filter((t) => t.id === editing.teamId)}
          initial={{
            teamId: editing.teamId,
            assigneeUserId: editing.assigneeUserId ?? "",
            priority: editing.priority,
            dueAt: editing.dueAtUtc ? editing.dueAtUtc.slice(0, 16) : "",
            note: editing.note ?? "",
          }}
          onClose={() => setEditing(null)}
          onSubmit={async (values) => {
            await updateAssignment(editing.teamId, editing.id, {
              assigneeUserId: values.assigneeUserId || null,
              priority: values.priority,
              dueAtUtc: values.dueAt ? new Date(values.dueAt).toISOString() : null,
              note: values.note.trim() || null,
            });
            addToast("Responsibility updated.", "success");
            setEditing(null);
            await load(() => false);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * ONE dialog for both record-side writes.
 *
 * Assign and Edit differ only in whether the team is chosen or fixed, so they
 * are one form rather than two that drift. Neither posts anywhere new: assign
 * calls `createAssignment(teamId, …)` and edit calls
 * `updateAssignment(teamId, assignmentId, …)` — the exact writers the group's
 * own Work tab uses.
 */
function ResponsibilityDialog({
  title,
  description,
  testid,
  teams,
  initial,
  onClose,
  onSubmit,
}: {
  title: string;
  description: string;
  testid: string;
  teams: ReadonlyArray<CollaborationTeamSummary>;
  initial?: {
    teamId: string;
    assigneeUserId: string;
    priority: CollaborationTeamAssignmentPriority;
    dueAt: string;
    note: string;
  };
  onClose: () => void;
  onSubmit: (values: {
    teamId: string;
    assigneeUserId: string;
    priority: CollaborationTeamAssignmentPriority;
    dueAt: string;
    note: string;
  }) => Promise<void>;
}) {
  const { addToast } = useToast();
  const [teamId, setTeamId] = useState(initial?.teamId ?? teams[0]?.id ?? "");
  const [assigneeUserId, setAssigneeUserId] = useState(
    initial?.assigneeUserId ?? "",
  );
  const [priority, setPriority] = useState<CollaborationTeamAssignmentPriority>(
    initial?.priority ?? "NORMAL",
  );
  const [dueAt, setDueAt] = useState(initial?.dueAt ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [members, setMembers] = useState<
    ReadonlyArray<{ userId: string; label: string }>
  >([]);

  /**
   * The chosen team's OWN members — the only people who may hold its work.
   * `addExistingMember`'s rule in reverse: an assignee must be an active
   * member of the group, and the server refuses anyone else.
   */
  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    void listTeamMembers(teamId, { limit: 100 })
      .then((page) => {
        if (cancelled) return;
        setMembers(
          page.members
            .filter((m) => m.status === "ACTIVE")
            .map((m) => ({
              userId: m.userId,
              label: m.displayName || m.email || "Team member",
            })),
        );
      })
      .catch(() => {
        if (!cancelled) setMembers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  const submit = async () => {
    if (!teamId || busy) return;
    setBusy(true);
    try {
      await onSubmit({ teamId, assigneeUserId, priority, dueAt, note });
    } catch (err) {
      // The server is the authority on who may assign and on capacity; its
      // refusal is shown as given, never guessed at here.
      notifyApiError(addToast, err, {
        message: "Could not save this team responsibility.",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      description={description}
      testid={testid}
      footer={
        <>
          <button type="button" className="app-secondary-action" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="app-primary-action"
            disabled={busy || !teamId}
            onClick={() => void submit()}
            data-testid={`${testid}-submit`}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <div style={{ display: "grid", gap: 14 }}>
        {teams.length > 1 ? (
          <div>
            <label className="app-field-label" htmlFor={`${testid}-team`}>
              Team
            </label>
            <AppListbox
              value={teamId}
              options={teams.map((t) => ({ value: t.id, label: t.name }))}
              onChange={(v) => {
                setTeamId(v);
                // The assignee belongs to the previous team's roster.
                setAssigneeUserId("");
              }}
              ariaLabel="Team"
              id={`${testid}-team`}
            />
          </div>
        ) : null}

        <div>
          <label className="app-field-label" htmlFor={`${testid}-assignee`}>
            Assignee
          </label>
          <AppListbox
            value={assigneeUserId}
            options={[
              { value: "", label: "Team-level (nobody specific)" },
              ...members.map((m) => ({ value: m.userId, label: m.label })),
            ]}
            onChange={setAssigneeUserId}
            ariaLabel="Assignee"
            id={`${testid}-assignee`}
          />
          <p className="app-field__help">
            Team-level work belongs to the whole team and notifies nobody in
            particular.
          </p>
        </div>

        <div>
          <label className="app-field-label" htmlFor={`${testid}-priority`}>
            Priority
          </label>
          <AppListbox
            value={priority}
            options={COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES.map((p) => ({
              value: p,
              label:
                p === "NORMAL"
                  ? "Normal"
                  : `${p.charAt(0)}${p.slice(1).toLowerCase()}`,
            }))}
            onChange={(v) =>
              setPriority(v as CollaborationTeamAssignmentPriority)
            }
            ariaLabel="Priority"
            id={`${testid}-priority`}
          />
        </div>

        <div>
          <label className="app-field-label" htmlFor={`${testid}-due`}>
            Due
          </label>
          <input
            id={`${testid}-due`}
            type="datetime-local"
            className="app-form-input"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
          />
        </div>

        <div>
          <label className="app-field-label" htmlFor={`${testid}-note`}>
            Note
          </label>
          <textarea
            id={`${testid}-note`}
            className="app-form-input"
            rows={3}
            maxLength={600}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </div>
    </Modal>
  );
}
