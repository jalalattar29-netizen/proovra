"use client";

/**
 * Evidence request reviewer assignment (`POST /v1/evidence-requests/:id/assign`)
 * and, for requests addressed to an internal team member, the send that
 * depends on it.
 *
 * The assignee is load-bearing: the server refuses to send an internal-member
 * request without one, and the assignee is the person notified when it is
 * sent and when responses arrive. So the send control states that
 * prerequisite where it is disabled, and a refused send links back here.
 *
 * Every change is confirmed by rereading the request before success is
 * announced.
 */

import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { apiFetch } from "../../../../../lib/api";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { Button } from "../../../../../components/ui/Button";
import { useConfirmAction } from "../../../../../components/ui/ConfirmActionModal";
import {
  WorkspaceMemberSelect,
  memberLabel,
  useWorkspaceMembers,
  type WorkspaceMember,
} from "../../../evidence/[id]/components/WorkspaceMemberSelect";

export type AssignableRequest = {
  id: string;
  teamId: string;
  status: string;
  recipientMode: string;
  assignedReviewerUserId: string | null;
};

export const ASSIGNMENT_ANCHOR = "evidence-request-assignment";
const TERMINAL = new Set(["CLOSED", "CANCELLED"]);
const box = { border: "1px solid var(--app-border, currentColor)", borderRadius: 8, padding: 12, marginTop: 16, display: "grid", gap: 10, minWidth: 0 } as const;
const row = { display: "flex", flexWrap: "wrap" as const, gap: 8, alignItems: "center", minWidth: 0 };

/** The request writes this component makes; `RequestAction` names every route this reaches. */
type RequestAction = "assign" | "send";

function postRequestAction(requestId: string, action: RequestAction, body: Record<string, unknown>) {
  return apiFetch(`/v1/evidence-requests/${encodeURIComponent(requestId)}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function errorMessage(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "assignee_not_workspace_member") {
    return "That person is no longer a member of this workspace. Choose someone else.";
  }
  if (code === "request_terminal") return "This request is closed or cancelled, so it can no longer change.";
  return toSafeUserError(error, { message: fallback }).message;
}

export function EvidenceRequestAssignment<T extends AssignableRequest>({
  request,
  onSaved,
}: {
  request: T;
  /** Receives the request as reread from the server after a change. */
  onSaved: (request: T) => void;
}) {
  const { confirm } = useConfirmAction();
  const pickerId = useId();
  const formId = useId();
  const members = useWorkspaceMembers(request.teamId);
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<WorkspaceMember | null>(null);
  const [busy, setBusy] = useState<null | "assign" | "unassign" | "send">(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<{ message: string; linkToAssignment?: boolean } | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const alive = useRef(true);
  const toggle = useRef<HTMLButtonElement | null>(null);
  const feedback = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (open) document.getElementById(pickerId)?.focus();
  }, [open, pickerId]);

  const terminal = TERMINAL.has(request.status);
  const assigned = request.assignedReviewerUserId;
  const assignedName = assigned ? memberLabel(members.state, assigned) ?? "A workspace member" : null;
  const internal = request.recipientMode === "INTERNAL_USER";
  const url = `/v1/evidence-requests/${encodeURIComponent(request.id)}`;

  const lockedReason = unconfirmed
    ? "Reload the request to confirm the last change before making another."
    : null;
  const submitReason = !choice
    ? "Choose a workspace member to assign."
    : choice.userId === assigned
      ? "This member is already the assigned reviewer."
      : undefined;
  const sendReason = unconfirmed
    ? "Reload the request to confirm the last change before sending."
    : !assigned
      ? "Assign a reviewer first. A request addressed to an internal team member cannot be sent without an assigned reviewer."
      : undefined;

  async function writeThenReread(
    kind: "assign" | "unassign" | "send",
    write: () => Promise<unknown>,
    verify: (fresh: T) => boolean,
    success: string,
  ) {
    setBusy(kind);
    setNotice("");
    setError(null);
    let written = false;
    try {
      await write();
      written = true;
      const fresh = ((await apiFetch(url)) as { request: T }).request;
      if (!alive.current) return;
      onSaved(fresh);
      if (verify(fresh)) setNotice(success);
      else setError({ message: "The request was accepted, but the reloaded request does not show the change. Reload before trying again." });
      setOpen(false);
      setChoice(null);
      feedback.current?.focus();
    } catch (err) {
      if (!alive.current) return;
      if (written) {
        setUnconfirmed(true);
        setOpen(false);
        setError({ message: "The change was sent, but the request could not be reloaded to confirm it. Reload the page before making another change." });
        feedback.current?.focus();
      } else {
        const code = (err as { code?: unknown } | null)?.code;
        setError(
          code === "internal_recipient_requires_assignee"
            ? { message: "This request cannot be sent until a reviewer is assigned.", linkToAssignment: true }
            : { message: errorMessage(err, kind === "send" ? "The request could not be sent." : "The assignment could not be saved.") },
        );
      }
    } finally {
      if (alive.current) setBusy(null);
    }
  }

  async function assign(event: FormEvent) {
    event.preventDefault();
    if (!choice || submitReason || lockedReason || busy) return;
    const target = choice;
    await writeThenReread(
      "assign",
      () => postRequestAction(request.id, "assign", { assignedReviewerUserId: target.userId }),
      (fresh) => fresh.assignedReviewerUserId === target.userId,
      `${target.label} is now the assigned reviewer. The saved request was reloaded.`,
    );
  }

  async function unassign() {
    if (busy || lockedReason) return;
    const ok = await confirm({
      title: "Remove the assigned reviewer?",
      description: internal
        ? "The request will have no reviewer. A request addressed to an internal team member cannot be sent until someone is assigned again."
        : "The request will have no reviewer, and nobody will be notified about new responses.",
      confirmLabel: "Remove reviewer",
      tone: "warning",
    });
    if (!ok || !alive.current) return;
    await writeThenReread(
      "unassign",
      () => postRequestAction(request.id, "assign", { assignedReviewerUserId: null }),
      (fresh) => fresh.assignedReviewerUserId === null,
      "The request is now unassigned. The saved request was reloaded.",
    );
  }

  async function send() {
    if (busy || sendReason) return;
    const ok = await confirm({
      title: "Send this request to the assigned reviewer?",
      description: `${assignedName ?? "The assigned reviewer"} is notified by email and the request moves out of draft.`,
      confirmLabel: "Send request",
    });
    if (!ok || !alive.current) return;
    await writeThenReread(
      "send",
      () => postRequestAction(request.id, "send", {}),
      (fresh) => fresh.status !== "DRAFT",
      "Request sent to the assigned reviewer. The saved request was reloaded.",
    );
  }

  return (
    <section id={ASSIGNMENT_ANCHOR} aria-labelledby={`${formId}-heading`} style={box} data-evidence-request-assignment>
      <h2 id={`${formId}-heading`} style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>
        Assigned reviewer
      </h2>
      <p style={{ margin: 0 }} data-evidence-request-assignee>
        {assignedName ?? "Unassigned"}
        {assigned && assignedName === "A workspace member" ? (
          <>
            {" "}
            <code data-identifier>{assigned}</code>
          </>
        ) : null}
      </p>
      {internal ? (
        <p style={{ margin: 0 }}>
          This request is addressed to an internal team member. The assigned reviewer is the person who receives it.
        </p>
      ) : null}

      {terminal ? (
        <p style={{ margin: 0 }}>The reviewer cannot change on a closed or cancelled request.</p>
      ) : (
        <div style={row}>
          <Button
            ref={toggle}
            aria-expanded={open}
            aria-controls={`${formId}-form`}
            disabled={Boolean(lockedReason) || busy !== null}
            disabledReason={lockedReason ?? undefined}
            onClick={() => {
              if (open) {
                setOpen(false);
                setChoice(null);
                toggle.current?.focus();
              } else {
                setOpen(true);
                setNotice("");
                setError(null);
              }
            }}
          >
            {assigned ? "Change reviewer" : "Assign reviewer"}
          </Button>
          {assigned ? (
            <Button
              variant="ghost"
              loading={busy === "unassign"}
              disabled={Boolean(lockedReason) || busy !== null}
              disabledReason={lockedReason ?? undefined}
              onClick={() => void unassign()}
            >
              Remove reviewer
            </Button>
          ) : null}
          {internal && request.status === "DRAFT" ? (
            <Button
              variant="primary"
              loading={busy === "send"}
              disabled={Boolean(sendReason) || busy !== null}
              disabledReason={sendReason}
              onClick={() => void send()}
            >
              Send to assigned reviewer
            </Button>
          ) : null}
        </div>
      )}
      {!terminal && internal && request.status === "DRAFT" && sendReason ? (
        <p style={{ margin: 0 }} data-evidence-request-send-prerequisite>
          {sendReason}
        </p>
      ) : null}

      {open && !terminal ? (
        <form id={`${formId}-form`} onSubmit={assign} style={{ display: "grid", gap: 8, minWidth: 0 }} aria-label="Assign reviewer">
          <WorkspaceMemberSelect
            teamId={request.teamId}
            id={pickerId}
            label="Reviewer"
            value={choice?.userId ?? null}
            onChange={setChoice}
            disabled={busy !== null}
          />
          <div style={row}>
            <Button
              type="submit"
              variant="primary"
              loading={busy === "assign"}
              disabled={Boolean(submitReason) || Boolean(lockedReason)}
              disabledReason={submitReason ?? lockedReason ?? undefined}
            >
              Save reviewer
            </Button>
            <Button
              variant="ghost"
              disabled={busy !== null}
              onClick={() => {
                setOpen(false);
                setChoice(null);
                toggle.current?.focus();
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      <div ref={feedback} tabIndex={-1} style={{ outline: "none" }}>
        {notice ? (
          <p role="status" style={{ margin: 0 }} data-evidence-request-assignment-notice>
            {notice}
          </p>
        ) : null}
        {error ? (
          <p role="alert" style={{ margin: 0 }} data-evidence-request-assignment-error>
            {error.message}
            {error.linkToAssignment ? (
              <>
                {" "}
                <a href={`#${ASSIGNMENT_ANCHOR}`}>Assign a reviewer</a>
              </>
            ) : null}
          </p>
        ) : null}
      </div>
    </section>
  );
}
