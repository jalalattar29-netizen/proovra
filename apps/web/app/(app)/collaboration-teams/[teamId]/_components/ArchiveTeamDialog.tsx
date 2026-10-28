"use client";

/**
 * ARCHIVE COLLABORATION TEAM — the confirmation (2026-10-28).
 *
 * A Collaboration Team is never deleted; archiving is the one retirement, and
 * it withdraws every member's reach through the group. So before the step-up
 * is asked for, the person sees exactly what changes — from the SERVER's
 * impact preview, never a client guess — and types the group's exact name.
 *
 * The dialog does not archive anything itself: `onConfirm` receives the typed
 * name and reason, and the caller runs the archive through the one step-up
 * flow. A failed impact read shows no destructive control at all.
 */

import { useEffect, useId, useRef, useState } from "react";

import {
  type CollaborationTeamArchiveImpact,
  getTeamArchiveImpact,
} from "../../../../../lib/api/collaboration-teams";

const UNAVAILABLE_COPY: Record<string, string> = {
  case_access_through_team: "Access to Cases granted to this Collaboration Team",
  new_tasks: "New tasks and task changes",
  discussion_posts: "New discussion posts",
  new_members_and_invitations: "New members and invitations",
  team_settings_changes: "Changes to the team's settings",
};

const PRESERVED_COPY: Record<string, string> = {
  team_record: "The Collaboration Team itself",
  membership_history: "Who was a member, and their roles",
  assignments_history: "Every assignment and its outcome",
  discussion_history: "The discussion",
  activity_history: "The activity timeline",
  audit_history: "The audit trail",
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function ArchiveTeamDialog({
  teamId,
  teamName,
  busy,
  onCancel,
  onConfirm,
}: {
  teamId: string;
  teamName: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (input: { confirmName: string; reason?: string }) => void;
}) {
  const titleId = useId();
  const nameInputId = useId();
  const reasonId = useId();
  const [impact, setImpact] = useState<CollaborationTeamArchiveImpact | null>(null);
  const [failed, setFailed] = useState(false);
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setImpact(null);
    setFailed(false);
    void getTeamArchiveImpact(teamId)
      .then((i) => {
        if (!cancelled) setImpact(i);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  useEffect(() => {
    if (impact) inputRef.current?.focus();
  }, [impact]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  // Exact: case and spacing included. The server checks it again.
  const matches = typed === teamName;

  return (
    <div
      role="presentation"
      className="app-dialog-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="app-dialog"
        data-testid="archive-team-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (!matches || !impact || busy) return;
          const trimmed = reason.trim();
          onConfirm({ confirmName: typed, ...(trimmed ? { reason: trimmed } : {}) });
        }}
      >
        <div className="app-dialog__head">
          <div>
            <h2 id={titleId} className="app-dialog__title">
              Archive Collaboration Team
            </h2>
            <p className="app-dialog__subtitle">
              <strong data-testid="archive-team-name">{teamName}</strong> will be archived, not
              deleted. You will be asked to confirm it is you before anything changes.
            </p>
          </div>
        </div>

        <div className="app-dialog__body">
          {failed ? (
            <p className="app-alert" role="alert" data-testid="archive-impact-failed">
              We couldn&apos;t load what archiving would affect, so the team can&apos;t be archived
              right now. Close this and try again.
            </p>
          ) : impact === null ? (
            <p role="status" data-testid="archive-impact-loading">
              Checking what archiving would affect…
            </p>
          ) : (
            <>
              <section aria-label="Affected by archiving" data-testid="archive-impact">
                <p className="app-field-label" style={{ marginBottom: 6 }}>
                  Affected
                </p>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>
                  <li data-testid="archive-impact-members">
                    {plural(impact.acceptedMembers, "member", "members")} lose access through this
                    Collaboration Team
                  </li>
                  <li data-testid="archive-impact-cases">
                    {plural(impact.caseGrants, "Case grant", "Case grants")} stop applying
                  </li>
                  <li data-testid="archive-impact-tasks">
                    {plural(impact.openAssignments, "open task", "open tasks")} will be cancelled
                  </li>
                  <li data-testid="archive-impact-invites">
                    {plural(impact.pendingInvites, "pending invitation", "pending invitations")}{" "}
                    will be revoked
                  </li>
                </ul>
              </section>

              <section aria-label="Unavailable after archiving" style={{ marginTop: 12 }}>
                <p className="app-field-label" style={{ marginBottom: 6 }}>
                  Unavailable while archived
                </p>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>
                  {impact.unavailable.map((k) => (
                    <li key={k}>{UNAVAILABLE_COPY[k] ?? k}</li>
                  ))}
                </ul>
              </section>

              <section aria-label="Preserved" style={{ marginTop: 12 }}>
                <p className="app-field-label" style={{ marginBottom: 6 }}>
                  Preserved
                </p>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>
                  {impact.preserved.map((k) => (
                    <li key={k}>{PRESERVED_COPY[k] ?? k}</li>
                  ))}
                </ul>
              </section>

              <p style={{ marginTop: 12, fontSize: 13 }} data-testid="archive-impact-restore">
                {impact.restore.requestable
                  ? "A Lead of this Collaboration Team can restore it later. Restoring checks your plan, how many active Collaboration Teams you have, and the team's member capacity at that time."
                  : "This team cannot be restored after archiving."}
              </p>

              <div style={{ marginTop: 14 }}>
                <label className="app-field-label" htmlFor={nameInputId}>
                  Type <strong>{teamName}</strong> to confirm
                </label>
                <input
                  ref={inputRef}
                  id={nameInputId}
                  className="app-form-input"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  data-testid="archive-confirm-name"
                  aria-invalid={typed.length > 0 && !matches}
                />
              </div>
              <div style={{ marginTop: 10 }}>
                <label className="app-field-label" htmlFor={reasonId}>
                  Reason <span className="app-field-optional">(optional, recorded in the audit trail)</span>
                </label>
                <textarea
                  id={reasonId}
                  className="app-form-input"
                  rows={2}
                  maxLength={500}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  data-testid="archive-reason"
                />
              </div>
            </>
          )}
        </div>

        <div className="app-dialog__footer">
          <button
            type="button"
            className="app-secondary-action"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          {impact && !failed ? (
            <button
              type="submit"
              className="app-danger-action"
              disabled={!matches || busy}
              data-testid="archive-team-submit"
            >
              {busy ? "Archiving…" : "Archive Collaboration Team"}
            </button>
          ) : null}
        </div>
      </form>
    </div>
  );
}
