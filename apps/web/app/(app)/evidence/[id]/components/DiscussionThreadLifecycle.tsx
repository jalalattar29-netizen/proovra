"use client";

/**
 * Discussion thread lifecycle — the selected thread's authoritative detail
 * (`GET /v1/collaboration/threads/:id`) and its four lifecycle controls:
 * resolve, reopen, assign and escalate.
 *
 * The thread list deliberately omits the resolution note and escalation
 * reason, so this component reads the detail route and renders both as
 * reviewer-only text. Every change is confirmed by rereading that detail
 * record before success is announced; the parent list is refreshed after.
 *
 * The resolution note, reopen reason and escalation reason are internal to the
 * workspace. None of them changes the evidence record.
 */

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";

import { apiFetch } from "../../../../../lib/api";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import { ReasonedActionButton } from "./ReasonedActionButton";
import {
  WorkspaceMemberSelect,
  memberLabel,
  useWorkspaceMembers,
  type WorkspaceMember,
} from "./WorkspaceMemberSelect";

type LifecycleStatus = "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED";

type ThreadDetail = {
  thread: {
    id: string;
    status: LifecycleStatus;
    assignedToUserId: string | null;
    resolvedAtUtc: string | null;
    escalatedAtUtc: string | null;
    reopenCount: number;
    updatedAt: string;
  };
  resolutionNote: string | null;
  escalationReason: string | null;
};

type Load =
  | { status: "loading" }
  | { status: "ready"; value: ThreadDetail }
  | { status: "failed"; message: string };

type Action = "resolve" | "reopen" | "assign" | "escalate";

const ACTION_LABEL: Record<Action, string> = {
  resolve: "Resolve thread",
  reopen: "Reopen thread",
  assign: "Assign thread",
  escalate: "Escalate thread",
};

/** One POST per lifecycle action; `Action` names every route this reaches. */
function postThreadAction(threadId: string, action: Action, body: Record<string, unknown>) {
  return apiFetch(`/v1/collaboration/threads/${encodeURIComponent(threadId)}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function isActive(status: LifecycleStatus): boolean {
  return status === "OPEN" || status === "IN_PROGRESS";
}

function safeMessage(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "invalid_status_transition" || code === "thread_terminal") {
    return "This thread changed since it was loaded. Refresh the thread and try again.";
  }
  return toSafeUserError(error, { message: fallback }).message;
}

export function DiscussionThreadLifecycle({
  teamId,
  threadId,
  readOnly,
  onChanged,
}: {
  teamId: string;
  threadId: string;
  readOnly: boolean;
  /** Refresh the thread list after a confirmed change. */
  onChanged: () => void;
}) {
  const { confirm } = useConfirmAction();
  const formId = useId();
  const [detail, setDetail] = useState<Load>({ status: "loading" });
  const [revision, setRevision] = useState(0);
  const [open, setOpen] = useState<Action | null>(null);
  const [text, setText] = useState("");
  const [assignee, setAssignee] = useState<WorkspaceMember | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [unconfirmed, setUnconfirmed] = useState(false);
  const alive = useRef(true);
  const toggles = useRef<Partial<Record<Action, HTMLButtonElement | null>>>({});
  const firstField = useRef<HTMLTextAreaElement | null>(null);
  const noticeRef = useRef<HTMLDivElement | null>(null);
  const members = useWorkspaceMembers(teamId);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const detailUrl = `/v1/collaboration/threads/${encodeURIComponent(threadId)}?teamId=${encodeURIComponent(teamId)}`;

  useEffect(() => {
    let current = true;
    setDetail({ status: "loading" });
    void apiFetch(detailUrl)
      .then((value) => {
        if (!current) return;
        setDetail({ status: "ready", value: value as ThreadDetail });
        setUnconfirmed(false);
      })
      .catch((error) => {
        if (current) {
          setDetail({ status: "failed", message: safeMessage(error, "The thread details could not be loaded.") });
        }
      });
    return () => {
      current = false;
    };
  }, [detailUrl, revision]);

  useEffect(() => {
    if (!open) return;
    if (open === "assign") {
      document.getElementById(`${formId}-assignee`)?.focus();
    } else {
      firstField.current?.focus();
    }
  }, [open, formId]);

  const thread = detail.status === "ready" ? detail.value.thread : null;

  function openForm(action: Action) {
    setOpen(action);
    setText("");
    setAssignee(null);
    setMutationError("");
    setNotice("");
  }

  function closeForm() {
    const action = open;
    setOpen(null);
    setText("");
    setAssignee(null);
    if (action) toggles.current[action]?.focus();
  }

  const lockedReason = unconfirmed
    ? "Refresh the thread to confirm the last change before making another."
    : detail.status !== "ready"
      ? "The thread details must load before its state can change."
      : null;

  const trimmed = text.trim();
  const submitReason =
    open === "assign"
      ? !assignee
        ? "Choose a workspace member to assign."
        : assignee.userId === thread?.assignedToUserId
          ? "This member is already assigned to the thread."
          : null
      : open === "reopen" || open === "escalate"
        ? trimmed.length === 0
          ? "Enter the internal reason."
          : null
        : null;

  const submit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!open || busy || submitReason || lockedReason) return;
      const action = open;
      setMutationError("");
      setNotice("");
      if (action === "resolve" || action === "escalate") {
        setBusy(true);
        const ok = await confirm(
          action === "resolve"
            ? {
                title: "Resolve this thread?",
                description:
                  "The thread is marked resolved and closes for new messages until it is reopened. The resolution note stays internal to the workspace.",
                confirmLabel: "Resolve thread",
              }
            : {
                title: "Escalate this thread?",
                description:
                  "The thread is flagged as escalated for everyone in the workspace who can see it. The reason stays internal to the workspace.",
                confirmLabel: "Escalate thread",
                tone: "warning",
              },
        );
        if (!alive.current) return;
        if (!ok) {
          setBusy(false);
          return;
        }
      }
      setBusy(true);
      const body =
        action === "resolve"
          ? { teamId, resolutionNote: trimmed || null }
          : action === "assign"
            ? { teamId, assignedToUserId: assignee!.userId }
            : { teamId, reason: trimmed };
      let written = false;
      try {
        await postThreadAction(threadId, action, body);
        written = true;
        const reread = (await apiFetch(detailUrl)) as ThreadDetail;
        if (!alive.current) return;
        setDetail({ status: "ready", value: reread });
        const t = reread.thread;
        const confirmed =
          action === "resolve"
            ? t.status === "RESOLVED"
            : action === "reopen"
              ? isActive(t.status)
              : action === "assign"
                ? t.assignedToUserId === assignee!.userId
                : t.escalatedAtUtc !== null;
        if (confirmed) {
          setNotice(
            action === "resolve"
              ? "Thread resolved. The saved thread was reloaded."
              : action === "reopen"
                ? "Thread reopened. New messages can be posted again."
                : action === "assign"
                  ? `Thread assigned to ${assignee!.label}. The saved thread was reloaded.`
                  : "Thread escalated. The saved thread was reloaded.",
          );
        } else {
          setMutationError(
            "The request was accepted, but the reloaded thread does not show the change. Refresh the thread before trying again.",
          );
        }
        setOpen(null);
        setText("");
        setAssignee(null);
        noticeRef.current?.focus();
        onChanged();
      } catch (error) {
        if (!alive.current) return;
        if (written) {
          setUnconfirmed(true);
          setOpen(null);
          setMutationError(
            "The change was sent, but the thread could not be reloaded to confirm it. Refresh the thread before making another change.",
          );
          noticeRef.current?.focus();
          onChanged();
        } else {
          setMutationError(safeMessage(error, "The thread could not be updated."));
        }
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [open, busy, submitReason, lockedReason, confirm, teamId, trimmed, assignee, threadId, detailUrl, onChanged],
  );

  const assigneeName = thread?.assignedToUserId
    ? memberLabel(members.state, thread.assignedToUserId) ?? "A workspace member"
    : null;

  const offered: Action[] = [];
  if (thread && !readOnly) {
    if (isActive(thread.status)) offered.push("resolve", "assign");
    if (thread.status === "RESOLVED") offered.push("reopen");
    if (isActive(thread.status) && !thread.escalatedAtUtc) offered.push("escalate");
  }

  return (
    <div className="evidence-lifecycle" data-discussion-lifecycle>
      {detail.status === "loading" ? (
        <p className="app-hint" role="status">
          Loading thread details…
        </p>
      ) : detail.status === "failed" ? (
        <p className="app-field-error" role="alert" data-discussion-lifecycle-error>
          {detail.message}
        </p>
      ) : (
        <dl className="evidence-lifecycle__facts" data-discussion-lifecycle-detail>
          <div>
            <dt>Assigned to</dt>
            <dd data-discussion-assignee>
              {assigneeName ?? "Unassigned"}
              {thread?.assignedToUserId && assigneeName === "A workspace member" ? (
                <>
                  {" "}
                  <code data-identifier>{thread.assignedToUserId}</code>
                </>
              ) : null}
            </dd>
          </div>
          {detail.value.resolutionNote ? (
            <div>
              <dt>Resolution note (internal)</dt>
              <dd data-discussion-resolution-note>{detail.value.resolutionNote}</dd>
            </div>
          ) : null}
          {thread?.escalatedAtUtc ? (
            <div>
              <dt>Escalation reason (internal)</dt>
              <dd data-discussion-escalation-reason>
                {detail.value.escalationReason ?? "No reason was recorded."}
              </dd>
            </div>
          ) : null}
          {thread && thread.reopenCount > 0 ? (
            <div>
              <dt>Times reopened</dt>
              <dd>{thread.reopenCount}</dd>
            </div>
          ) : null}
        </dl>
      )}

      {!readOnly ? (
        <div className="evidence-lifecycle__actions" role="group" aria-label="Thread lifecycle">
          {offered.map((action) => (
            <ReasonedActionButton
              key={action}
              className={action === "escalate" ? "app-secondary-action app-secondary-action--accent" : "app-secondary-action"}
              aria-expanded={open === action}
              aria-controls={`${formId}-form`}
              disabled={Boolean(lockedReason) || busy}
              disabledReason={lockedReason}
              onClick={(event) => {
                toggles.current[action] = event.currentTarget;
                if (open === action) closeForm();
                else openForm(action);
              }}
              data-discussion-lifecycle-action={action}
            >
              {action === "resolve"
                ? "Resolve"
                : action === "reopen"
                  ? "Reopen"
                  : action === "assign"
                    ? thread?.assignedToUserId
                      ? "Change assignee"
                      : "Assign"
                    : "Escalate"}
            </ReasonedActionButton>
          ))}
          {detail.status !== "loading" ? (
            <button
              type="button"
              className="app-ghost-action"
              onClick={() => {
                setNotice("");
                setMutationError("");
                setRevision((value) => value + 1);
              }}
            >
              Refresh thread
            </button>
          ) : null}
        </div>
      ) : null}

      {open ? (
        <form
          id={`${formId}-form`}
          className="evidence-lifecycle__form"
          onSubmit={submit}
          aria-label={ACTION_LABEL[open]}
          data-discussion-lifecycle-form={open}
        >
          {open === "assign" ? (
            <WorkspaceMemberSelect
              teamId={teamId}
              id={`${formId}-assignee`}
              label="Assign to"
              value={assignee?.userId ?? null}
              onChange={setAssignee}
              disabled={busy}
            />
          ) : (
            <div className="evidence-lifecycle__field">
              <label className="evidence-detail-dialog-field__label" htmlFor={`${formId}-text`}>
                {open === "resolve"
                  ? "Resolution note (optional, internal)"
                  : open === "reopen"
                    ? "Reason for reopening (internal)"
                    : "Reason for escalating (internal)"}
              </label>
              <textarea
                id={`${formId}-text`}
                ref={firstField}
                className="app-form-input"
                rows={3}
                maxLength={open === "resolve" ? 1000 : 400}
                value={text}
                disabled={busy}
                onChange={(event) => setText(event.target.value)}
                required={open !== "resolve"}
              />
              <span className="app-hint">
                {open === "resolve" ? "Up to 1,000 characters." : "Required. Up to 400 characters."} Visible only
                to workspace reviewers.
              </span>
            </div>
          )}
          <div className="evidence-lifecycle__actions">
            <ReasonedActionButton
              type="submit"
              className="app-primary-action"
              busy={busy}
              disabled={Boolean(submitReason) || Boolean(lockedReason)}
              disabledReason={submitReason ?? lockedReason}
            >
              {busy ? "Saving…" : ACTION_LABEL[open]}
            </ReasonedActionButton>
            <button type="button" className="app-secondary-action" onClick={closeForm} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      <div ref={noticeRef} tabIndex={-1} className="evidence-lifecycle__feedback">
        {notice ? (
          <p className="app-alert app-alert--ok" role="status" data-discussion-lifecycle-notice>
            {notice}
          </p>
        ) : null}
        {mutationError ? (
          <p className="app-alert app-alert--danger" role="alert" data-discussion-lifecycle-mutation-error>
            {mutationError}
          </p>
        ) : null}
      </div>
    </div>
  );
}
