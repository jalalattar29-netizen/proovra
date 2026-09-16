"use client";

/**
 * WORKSPACE MEMBERS — the server-paged, server-searched roster.
 *
 *   GET   /v1/teams/:id/members?limit&q&status&cursor   (any member; contact
 *                                                        details only for ADMIN+)
 *   PATCH /v1/teams/:id/members/:memberId               (role change)
 *
 * The page used to render the members EMBEDDED in `GET /v1/teams/:id`, which
 * carries only the first 50. The search box filtered those 50 in the browser,
 * so on a larger workspace everyone after the fiftieth could not be seen,
 * found, or managed. The API names this route "the paginated, searchable
 * authority for the rest"; the roster now reads it directly:
 *
 *   - search and the status filter run on the SERVER and reset the cursor;
 *   - "Load more" follows the server cursor, and the count beside it is the
 *     server's `total` for the current filter;
 *   - a failed or refused read is an error with a retry, never "nobody here";
 *   - after a role change or a removal the loaded rows are reread before the
 *     change is announced.
 *
 * Removal stays in `MemberRemovalDialog` (impact check + transfer). It is
 * opened by the page, and the page calls `rereadAfterRemoval` when the dialog
 * reports success.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import { AppListbox } from "../../../../../components/app-primitives/AppListbox";
import { AppStatusText } from "../../../../../components/app-primitives/AppStatusText";
import { apiFetch } from "../../../../../lib/api";
import { formatUserDate } from "../../../../../lib/date";
import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";

export type WorkspaceMember = {
  id?: string;
  userId: string;
  role: string;
  /** ACTIVE / SUSPENDED / REVOKED. */
  status?: string;
  createdAt?: string;
  user?: { id?: string; email?: string | null; displayName?: string | null };
  label?: string;
};

type MembersPage = {
  members: WorkspaceMember[];
  nextCursor: string | null;
  total: number;
};

export const MANAGEABLE_ROLE_OPTIONS = ["ADMIN", "MEMBER", "VIEWER"] as const;
export type ManageableRole = (typeof MANAGEABLE_ROLE_OPTIONS)[number];

/**
 * WORKSPACE role labels — DISPLAY ONLY (§15.12, §15.33). The VALUE stays the
 * enum; this changes what a person reads and nothing about what is sent.
 */
const WORKSPACE_ROLE_LABEL: Record<string, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  MEMBER: "Member",
  VIEWER: "Viewer",
};

export function workspaceRoleLabel(role: string): string {
  return WORKSPACE_ROLE_LABEL[role] ?? "Other role";
}

/** A person's display name, never falling back to a raw id in the primary slot. */
export function memberLabel(member: {
  user?: { displayName?: string | null; email?: string | null } | null;
  label?: string | null;
}): string {
  return (
    member.user?.displayName?.trim() ||
    member.user?.email ||
    member.label ||
    "Workspace member"
  );
}

const STATUS_FILTERS = [
  { value: "ALL", label: "All statuses" },
  { value: "ACTIVE", label: "Active" },
  { value: "SUSPENDED", label: "Suspended" },
] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number]["value"];

const PAGE_SIZE = 50;
const PAGE_MAX = 200;
const SEARCH_DEBOUNCE_MS = 300;

function statusText(status?: string): { label: string; tone: "green" | "amber" | "slate" } {
  if (status === "SUSPENDED") return { label: "Suspended", tone: "amber" };
  if (status === "REVOKED") return { label: "Access removed", tone: "slate" };
  return { label: "Active", tone: "green" };
}

type ListState =
  | { kind: "loading" }
  | { kind: "ready"; rows: WorkspaceMember[]; nextCursor: string | null; total: number }
  | { kind: "failed"; message: string };

export type WorkspaceMembersPanelHandle = {
  /** Rereads the loaded rows after `MemberRemovalDialog` reports success. */
  rereadAfterRemoval: (member: WorkspaceMember) => Promise<void>;
};

export const WorkspaceMembersPanel = forwardRef<
  WorkspaceMembersPanelHandle,
  {
    teamId: string;
    currentUserId: string;
    canManageTeam: boolean;
    onInvite: () => void;
    onRemove: (member: WorkspaceMember) => void;
    notify: (message: string, tone: "success" | "error") => void;
  }
>(function WorkspaceMembersPanel(
  { teamId, currentUserId, canManageTeam, onInvite, onRemove, notify },
  ref,
) {
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [roleSavingId, setRoleSavingId] = useState<string | null>(null);
  const generation = useRef(0);
  const rowsRef = useRef<WorkspaceMember[]>([]);
  rowsRef.current = list.kind === "ready" ? list.rows : [];

  // Debounce the search box; the SERVER runs the search.
  useEffect(() => {
    const handle = setTimeout(() => setQuery(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const urlFor = useCallback(
    (cursor: string | null, limit: number) => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (query) params.set("q", query);
      if (status !== "ALL") params.set("status", status);
      if (cursor) params.set("cursor", cursor);
      return `/v1/teams/${encodeURIComponent(teamId)}/members?${params.toString()}`;
    },
    [teamId, query, status],
  );

  /**
   * Loads from the first row. `limit` lets a reread cover every row the
   * operator already had on screen (bounded by the server maximum).
   */
  const loadFirst = useCallback(
    async (limit: number): Promise<MembersPage | null> => {
      const mine = ++generation.current;
      setMoreError(null);
      try {
        const page = (await apiFetch(urlFor(null, limit))) as MembersPage;
        if (mine !== generation.current) return null;
        const value = {
          members: page?.members ?? [],
          nextCursor: page?.nextCursor ?? null,
          total: typeof page?.total === "number" ? page.total : (page?.members ?? []).length,
        };
        setList({ kind: "ready", rows: value.members, nextCursor: value.nextCursor, total: value.total });
        return value;
      } catch (err) {
        if (mine !== generation.current) return null;
        const code = (err as { statusCode?: number })?.statusCode;
        setList({
          kind: "failed",
          message:
            code === 403 || code === 404
              ? "You no longer have access to this workspace's members. Reload the page or switch workspace."
              : toSafeUserError(err, { message: "The member list could not be loaded." }).message,
        });
        return null;
      }
    },
    [urlFor],
  );

  useEffect(() => {
    setList({ kind: "loading" });
    void loadFirst(PAGE_SIZE);
  }, [loadFirst, revision]);

  const loadMore = async () => {
    if (list.kind !== "ready" || !list.nextCursor || loadingMore) return;
    const mine = generation.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = (await apiFetch(urlFor(list.nextCursor, PAGE_SIZE))) as MembersPage;
      if (mine !== generation.current) return;
      setList((prev) =>
        prev.kind === "ready"
          ? {
              kind: "ready",
              rows: [...prev.rows, ...(page?.members ?? [])],
              nextCursor: page?.nextCursor ?? null,
              total: typeof page?.total === "number" ? page.total : prev.total,
            }
          : prev,
      );
    } catch (err) {
      if (mine !== generation.current) return;
      setMoreError(
        toSafeUserError(err, { message: "More members could not be loaded. Try again." }).message,
      );
    } finally {
      setLoadingMore(false);
    }
  };

  const rereadLimit = useCallback(
    () => Math.min(PAGE_MAX, Math.max(PAGE_SIZE, rowsRef.current.length)),
    [],
  );

  useImperativeHandle(
    ref,
    () => ({
      rereadAfterRemoval: async (member) => {
        const page = await loadFirst(rereadLimit());
        if (!page) {
          notify(
            "The member was removed, but the list could not be reloaded to confirm it. Reload the page.",
            "error",
          );
          return;
        }
        const stillThere = page.members.some(
          (m) => (m.id && m.id === member.id) || m.userId === member.userId,
        );
        notify(
          stillThere
            ? "The removal was accepted, but the reloaded list still shows this person. Reload the page before trying again."
            : "Member removed",
          stillThere ? "error" : "success",
        );
      },
    }),
    [loadFirst, notify, rereadLimit],
  );

  const changeRole = async (member: WorkspaceMember, nextRole: ManageableRole) => {
    /**
     * The route resolves `:memberId` against `TeamMember.id` (WCR-02), so a
     * row without one is refused here rather than sent to a URL that 404s.
     */
    if (!canManageTeam || !member.id || roleSavingId) return;
    if (nextRole === member.role) return;
    setRoleSavingId(member.id);
    try {
      await apiFetch(
        `/v1/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(member.id)}`,
        { method: "PATCH", body: JSON.stringify({ role: nextRole }) },
      );
    } catch (err) {
      setRoleSavingId(null);
      notify(toSafeUserError(err, { message: "Failed to update role" }).message, "error");
      return;
    }
    const page = await loadFirst(rereadLimit());
    setRoleSavingId(null);
    const reread = page?.members.find((m) => m.id === member.id);
    if (!page) {
      notify("The role change was accepted, but the member list could not be reloaded to confirm it.", "error");
    } else if (reread && reread.role !== nextRole) {
      notify("The role change was accepted, but the reloaded list shows a different role. Reload before trying again.", "error");
    } else {
      notify(`${memberLabel(member)} is now ${workspaceRoleLabel(nextRole)}`, "success");
    }
  };

  const filtered = query !== "" || status !== "ALL";
  const rows = list.kind === "ready" ? list.rows : [];

  return (
    <div className="app-panel" data-testid="people-roster">
      <div className="app-panel__head app-panel__head-row" style={{ flexWrap: "wrap", gap: 8 }}>
        <h2 className="app-panel__title">Members</h2>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", minWidth: 0 }}>
          <div className="app-search-field">
            <span className="app-search-icon" aria-hidden="true">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m21 21-4.3-4.3" />
              </svg>
            </span>
            <input
              type="search"
              className="app-search-input"
              placeholder="Search by name or email"
              aria-label="Search members"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              data-testid="people-search"
            />
          </div>
          <div style={{ minWidth: 150 }}>
            <AppListbox
              value={status}
              options={STATUS_FILTERS.map((o) => ({ value: o.value, label: o.label }))}
              onChange={(v) => setStatus(v as StatusFilter)}
              ariaLabel="Filter members by status"
              id="people-status-filter"
            />
          </div>
        </div>
      </div>
      <div className="app-table-surface">
        {list.kind === "loading" ? (
          <p className="app-table__muted" role="status" data-testid="people-loading" style={{ margin: 16 }}>
            Loading members…
          </p>
        ) : list.kind === "failed" ? (
          <div className="app-alert app-alert--danger" role="alert" data-testid="people-error" style={{ margin: 16 }}>
            <span>{list.message}</span>{" "}
            <button type="button" className="app-secondary-action" onClick={() => setRevision((v) => v + 1)}>
              Try again
            </button>
          </div>
        ) : rows.length === 0 ? (
          <div className="app-empty" data-testid="people-empty">
            <span className="app-empty__icon" aria-hidden>
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
              </svg>
            </span>
            <strong>{filtered ? "Nobody here matches that" : "Nobody has access to this workspace yet"}</strong>
            <p>
              {filtered
                ? "Try a different name, address or status."
                : "Invite a colleague to give them access to this workspace's evidence, cases and reports."}
            </p>
            {!filtered && canManageTeam ? (
              <div className="app-empty__actions">
                <button
                  type="button"
                  className="app-primary-action"
                  onClick={onInvite}
                  data-testid="people-empty-invite"
                >
                  Invite person
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <table className="app-table" data-responsive>
            <colgroup>
              <col style={{ width: "auto" }} />
              <col style={{ width: 168 }} />
              <col style={{ width: 110 }} />
              <col style={{ width: 120 }} />
              <col style={{ width: 108 }} />
            </colgroup>
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">Joined</th>
                <th scope="col" style={{ textAlign: "right" }}>
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((member) => {
                const label = memberLabel(member);
                const isSelf = member.userId === currentUserId;
                const isTeamOwner = member.role === "OWNER";
                /**
                 * Only where the server would accept the change: OWNER moves by
                 * transfer, and nobody edits their own role. The server
                 * re-checks both.
                 */
                const editable = canManageTeam && !isSelf && !isTeamOwner;
                const rowKey = member.id ?? member.userId;
                const st = statusText(member.status);
                return (
                  <tr key={rowKey} data-member-row={rowKey}>
                    <td data-label="Person">
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                        <span className="app-avatar" aria-hidden>
                          {(label.trim()[0] ?? "?").toUpperCase()}
                        </span>
                        <span
                          className="app-table__identity"
                          title={member.user?.email ? `${label} · ${member.user.email}` : label}
                        >
                          <span className="app-table__primary">
                            {label}
                            {isSelf ? " (you)" : ""}
                          </span>
                          {member.user?.email ? (
                            <span className="app-table__muted app-identity">{member.user.email}</span>
                          ) : null}
                        </span>
                      </span>
                    </td>
                    <td data-label="Role">
                      {editable ? (
                        <div style={{ maxWidth: 150 }}>
                          <AppListbox
                            value={member.role}
                            options={MANAGEABLE_ROLE_OPTIONS.map((r) => ({
                              value: r,
                              label: workspaceRoleLabel(r),
                            }))}
                            onChange={(next) => void changeRole(member, next as ManageableRole)}
                            ariaLabel={`Workspace role for ${label}`}
                            id={`member-role-${rowKey}`}
                            disabled={roleSavingId !== null || !member.id}
                          />
                        </div>
                      ) : (
                        <AppStatusText tone={isTeamOwner ? "indigo" : "slate"}>
                          {workspaceRoleLabel(member.role)}
                        </AppStatusText>
                      )}
                    </td>
                    <td data-label="Status">
                      <AppStatusText tone={st.tone}>{st.label}</AppStatusText>
                    </td>
                    <td data-label="Joined" className="app-table__muted">
                      {member.createdAt ? formatUserDate(member.createdAt) : "—"}
                    </td>
                    <td data-label="" style={{ textAlign: "right" }}>
                      {editable ? (
                        <button
                          type="button"
                          className="app-secondary-action app-secondary-action--danger"
                          onClick={() => onRemove(member)}
                          data-testid={`member-remove-${rowKey}`}
                          aria-label={`Remove ${label}`}
                        >
                          Remove
                        </button>
                      ) : (
                        <span className="app-table__muted" aria-hidden>
                          —
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {list.kind === "ready" && rows.length > 0 ? (
        <div
          className="app-panel__body"
          style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between" }}
        >
          <span className="app-table__muted" role="status" data-testid="people-count">
            Showing {rows.length} of {list.total} {filtered ? "matching " : ""}
            {list.total === 1 ? "person" : "people"}
          </span>
          {list.nextCursor ? (
            <button
              type="button"
              className="app-secondary-action"
              onClick={() => void loadMore()}
              disabled={loadingMore}
              aria-busy={loadingMore}
              data-testid="people-load-more"
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          ) : null}
          {moreError ? (
            <span className="app-alert app-alert--danger" role="alert">
              {moreError}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
