"use client";

/**
 * Workspace member picker — the ACTIVE members of one workspace, read from the
 * canonical workspace member list (`GET /v1/teams/:id/members`), which pages,
 * searches in the database and never releases an address as a label.
 *
 * Used where an operator must choose a person inside the workspace that owns a
 * record (discussion thread assignment, evidence request reviewer). The server
 * remains the authority on whether the chosen person may be assigned; this
 * control only offers people the workspace itself lists as active.
 *
 * States are truthful: a refused or failed read is shown as a failure, never
 * as "no members".
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { identifierLabel } from "@proovra/shared";

import { apiFetch } from "../../../../../lib/api";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import { AppListbox } from "../../../../../components/app-primitives";

export type WorkspaceMember = {
  userId: string;
  label: string;
  role: string;
};

type MembersPage = {
  members: Array<{ userId: string; label?: string | null; role: string; status: string }>;
  nextCursor: string | null;
};

export type MemberListState =
  | { status: "loading" }
  | { status: "ready"; members: WorkspaceMember[]; nextCursor: string | null }
  | { status: "failed"; message: string };

const PAGE_SIZE = 100;

function membersUrl(teamId: string, search: string, cursor: string | null): string {
  const qs = new URLSearchParams({ status: "ACTIVE", limit: String(PAGE_SIZE) });
  if (search) qs.set("q", search);
  if (cursor) qs.set("cursor", cursor);
  return `/v1/teams/${encodeURIComponent(teamId)}/members?${qs.toString()}`;
}

function project(page: MembersPage): WorkspaceMember[] {
  return (page.members ?? [])
    .filter((m) => m.status === "ACTIVE")
    .map((m) => ({ userId: m.userId, label: m.label || "Workspace member", role: m.role }));
}

/**
 * First page of ACTIVE members. Also used to put a name to a stored assignee
 * id; when the person is not on the first page the caller falls back to a
 * neutral label rather than guessing.
 */
export function useWorkspaceMembers(teamId: string | null, search = ""): {
  state: MemberListState;
  loadMore: () => void;
  loadingMore: boolean;
} {
  const [state, setState] = useState<MemberListState>({ status: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    if (!teamId) {
      setState({ status: "failed", message: "This record has no workspace, so no members can be listed." });
      return;
    }
    setState({ status: "loading" });
    void apiFetch(membersUrl(teamId, search, null))
      .then((page) => {
        if (current !== generation.current) return;
        setState({ status: "ready", members: project(page as MembersPage), nextCursor: (page as MembersPage).nextCursor ?? null });
      })
      .catch((error) => {
        if (current !== generation.current) return;
        setState({
          status: "failed",
          message: toSafeUserError(error, { message: "Workspace members could not be loaded." }).message,
        });
      });
  }, [teamId, search]);

  const loadMore = useCallback(() => {
    if (!teamId || state.status !== "ready" || !state.nextCursor || loadingMore) return;
    const current = generation.current;
    setLoadingMore(true);
    void apiFetch(membersUrl(teamId, search, state.nextCursor))
      .then((page) => {
        if (current !== generation.current) return;
        setState((prev) => {
          if (prev.status !== "ready") return prev;
          const seen = new Set(prev.members.map((m) => m.userId));
          const added = project(page as MembersPage).filter((m) => !seen.has(m.userId));
          return { status: "ready", members: [...prev.members, ...added], nextCursor: (page as MembersPage).nextCursor ?? null };
        });
      })
      .catch((error) => {
        if (current !== generation.current) return;
        setState({
          status: "failed",
          message: toSafeUserError(error, { message: "More workspace members could not be loaded." }).message,
        });
      })
      .finally(() => {
        if (current === generation.current) setLoadingMore(false);
      });
  }, [teamId, search, state, loadingMore]);

  return { state, loadMore, loadingMore };
}

export function WorkspaceMemberSelect({
  teamId,
  value,
  onChange,
  label,
  id,
  disabled = false,
}: {
  teamId: string | null;
  value: string | null;
  onChange: (member: WorkspaceMember) => void;
  label: string;
  /** id given to the listbox trigger so a parent can move focus to it. */
  id: string;
  disabled?: boolean;
}) {
  const labelId = useId();
  const searchId = useId();
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const { state, loadMore, loadingMore } = useWorkspaceMembers(teamId, search);
  const members = state.status === "ready" ? state.members : [];

  return (
    <div className="evidence-lifecycle__field" data-workspace-member-select>
      <label className="evidence-detail-dialog-field__label" htmlFor={searchId}>
        Search members
      </label>
      <div className="evidence-lifecycle__actions">
        <input
          id={searchId}
          type="search"
          className="app-form-input"
          value={draft}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              setSearch(draft.trim());
            }
          }}
        />
        <button
          type="button"
          className="app-secondary-action"
          disabled={disabled}
          onClick={() => setSearch(draft.trim())}
        >
          Search
        </button>
      </div>
      <span id={labelId} className="evidence-detail-dialog-field__label">
        {label}
      </span>
      {state.status === "loading" ? (
        <p className="app-hint" role="status">
          Loading workspace members…
        </p>
      ) : state.status === "failed" ? (
        <p className="app-field-error" role="alert" data-workspace-member-select-error>
          {state.message}
        </p>
      ) : members.length === 0 ? (
        <p className="app-hint" data-workspace-member-select-empty>
          {search
            ? "No active workspace member matches this search."
            : "This workspace has no active members to choose from."}
        </p>
      ) : (
        <AppListbox
          id={id}
          ariaLabelledby={labelId}
          value={value}
          placeholder="Choose a member"
          disabled={disabled}
          options={members.map((m) => ({
            value: m.userId,
            label: m.label,
            description: identifierLabel(m.role),
          }))}
          onChange={(userId) => {
            const member = members.find((m) => m.userId === userId);
            if (member) onChange(member);
          }}
        />
      )}
      {state.status === "ready" && state.nextCursor ? (
        <button
          type="button"
          className="app-ghost-action"
          disabled={disabled || loadingMore}
          onClick={loadMore}
        >
          {loadingMore ? "Loading more members…" : "Show more members"}
        </button>
      ) : null}
    </div>
  );
}

/** A stored assignee id, put into operator language. */
export function memberLabel(state: MemberListState, userId: string | null): string | null {
  if (!userId) return null;
  if (state.status !== "ready") return null;
  return state.members.find((m) => m.userId === userId)?.label ?? null;
}
