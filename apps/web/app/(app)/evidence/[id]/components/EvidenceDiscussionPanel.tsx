"use client";

/**
 * Phase C2 — Evidence Discussion Panel.
 *
 * Canonical evidence-context collaboration surface. Renders the
 * Phase 16 discussion thread list for this evidence + an expanded
 * message view when a thread is selected. Designed to keep reviewer
 * coordination ATTACHED to the evidence rather than scattered across
 * Slack / email / external chat.
 *
 * Hard rules:
 *   * Workspace-scoped — every query carries the evidence's teamId.
 *   * Read-mostly — surfacing what already exists. Mutations land on
 *     the existing audited backend (POST /v1/collaboration/threads/...
 *     and /v1/collaboration/threads/:id/messages). The component never
 *     bypasses the audited surface.
 *   * Vocabulary discipline — operational labels only. No "chat",
 *     "DM", "social", "emoji", "reaction", or trust overclaim.
 *   * Deep-linking — `?tab=discussion&thread=:id` opens the focused
 *     thread; mention deep-links from the inbox land here.
 *   * Mention rendering — `@token` tokens are visually highlighted;
 *     the component never invents users (renders the raw token).
 *   * Mark-as-read — opening a thread the caller is mentioned in
 *     clears their unread mention count via POST
 *     /v1/collaboration/threads/:id/mark-mentions-read.
 *
 * Bounded vocabulary: this surface is "operational evidence
 * coordination". It is NOT a chat product.
 */

import { toSafeUserError } from "../../../../../lib/feedback/toSafeUserError";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";

import { apiFetch } from "../../../../../lib/api";
// Phase G3.2 — Presence wiring for the discussion thread surface.
// When a thread is open, the indicator polls heartbeat for that
// thread id so reviewers can see when a peer is replying to the
// same thread.
import { PresenceIndicator } from "../../../../../components/presence/PresenceIndicator";

type ThreadStatus = "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED";
type ThreadVisibility = "INTERNAL" | "CONTRIBUTOR_SCOPED";
type ThreadKind =
  | "EVIDENCE_GENERAL"
  | "REVIEW_REQUEST_CLARIFICATION"
  | "INVESTIGATION_COORDINATION"
  | "WORKFLOW_DISCUSSION";

type Thread = {
  id: string;
  evidenceId: string;
  kind: ThreadKind;
  status: ThreadStatus;
  visibility: ThreadVisibility;
  title: string;
  createdByUserId: string;
  assignedToUserId: string | null;
  resolvedAtUtc: string | null;
  reopenCount: number;
  escalatedAtUtc: string | null;
  createdAt: string;
  updatedAt: string;
};

type Message = {
  id: string;
  threadId: string;
  authorKind: "USER" | "CONTRIBUTOR" | "SYSTEM";
  authorUserId: string | null;
  contributorLabel: string | null;
  body: string;
  editedAtUtc: string | null;
  createdAt: string;
};

type ThreadsResponse = { threads: Thread[] };
type MessagesResponse = { messages: Message[] };

// PHASE 12B — the SERVER owns the collaboration vocabulary
// (GET /v1/collaboration/catalogs). These maps are presentation only:
// curated wording for the kinds we have copy for. A kind the server
// offers that we have no copy for is humanised rather than dropped, so
// the client can never silently hide a vocabulary the server accepts.
type CollaborationCatalogs = {
  threadKinds: ReadonlyArray<string>;
  threadStatuses: ReadonlyArray<string>;
  threadVisibilities: ReadonlyArray<string>;
  participantRoles: ReadonlyArray<string>;
};

function humaniseToken(token: string): string {
  const lower = token.replace(/_/g, " ").toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

const KIND_LABELS: Record<ThreadKind, string> = {
  EVIDENCE_GENERAL: "General",
  REVIEW_REQUEST_CLARIFICATION: "Review clarification",
  INVESTIGATION_COORDINATION: "Investigation",
  WORKFLOW_DISCUSSION: "Workflow",
};

const STATUS_LABELS: Record<ThreadStatus, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In progress",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
};

/**
 * Thread status -> canonical badge tone. Resolved is not the same as open,
 * and closed is not the same as resolved; each keeps its own tone so the list
 * cannot read as uniformly healthy.
 */
function statusTone(status: ThreadStatus): "green" | "blue" | "amber" | "slate" {
  switch (status) {
    case "RESOLVED":
      return "green";
    case "IN_PROGRESS":
      return "blue";
    case "OPEN":
      return "amber";
    case "CLOSED":
    default:
      return "slate";
  }
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  } catch {
    return iso;
  }
}

/**
 * Render a discussion message body with @-mention tokens visually
 * highlighted. Mentions are recognised by the same regex as the
 * backend's deterministic parser (services/api/src/services/
 * collaboration/discussion.service.ts). The component never resolves
 * the token to a user identity — it only highlights it.
 */
function renderMessageBody(body: string): Array<JSX.Element | string> {
  const out: Array<JSX.Element | string> = [];
  const re = /(@[a-zA-Z0-9_.-]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(body)) !== null) {
    if (m.index > last) {
      out.push(body.slice(last, m.index));
    }
    out.push(
      <mark
        key={`mention-${key++}`}
        className="evidence-discussion__mention"
        data-discussion-mention-token={m[0]}
      >
        {m[0]}
      </mark>,
    );
    last = m.index + m[0].length;
  }
  if (last < body.length) {
    out.push(body.slice(last));
  }
  return out;
}

export default function EvidenceDiscussionPanel({
  evidenceId,
  teamId,
  initialThreadId,
  // Phase DISCUSSION-CAPABILITY-FIX — when true, the panel renders
  // thread list + message history but HIDES the composer and the
  // post-action affordance. This is set by the parent when the
  // workspace no longer qualifies for writable discussion but
  // history exists and must remain accessible. Read-only mode is
  // purely UI politeness — the backend write routes already reject
  // ineligible callers; this just avoids surfacing controls the
  // operator cannot use.
  readOnly = false,
}: {
  evidenceId: string;
  teamId: string | null;
  initialThreadId?: string | null;
  readOnly?: boolean;
}) {
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [loadingThreads, setLoadingThreads] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(
    initialThreadId ?? null,
  );
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  // Phase G2 (C2.5) — operational discussion filters. The bounded
  // thread list (≤200 rows) is client-filterable; no realtime, no
  // social features, no AI summarisation.
  // Server-projected collaboration vocabulary. Never blocks the panel:
  // if the catalog is unavailable the curated labels still render.
  const [catalogs, setCatalogs] = useState<CollaborationCatalogs | null>(null);
  const [filterText, setFilterText] = useState("");
  const [filterPreset, setFilterPreset] = useState<
    "all" | "unresolved" | "escalated" | "resolved"
  >("all");

  // -----------------------------------------------------------------
  // Load thread list (workspace + evidence scoped).
  // -----------------------------------------------------------------
  const loadThreads = useCallback(async () => {
    if (!teamId) {
      setLoadingThreads(false);
      setThreads([]);
      return;
    }
    setLoadingThreads(true);
    setError(null);
    try {
      // Phase O-blockers / D-1 — apiFetch already returns parsed JSON.
      const data = (await apiFetch(
        `/v1/collaboration/threads?teamId=${encodeURIComponent(
          teamId,
        )}&evidenceId=${encodeURIComponent(evidenceId)}`,
      )) as ThreadsResponse;
      setThreads(data.threads ?? []);
    } catch (err) {
      const e = err as { message?: string };
      setError(toSafeUserError(e, { message: "Could not load discussion threads." }).message);
      setThreads([]);
    } finally {
      setLoadingThreads(false);
    }
  }, [evidenceId, teamId]);

  // Server-projected collaboration vocabulary (one fetch per mount).
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const data = (await apiFetch(
          "/v1/collaboration/catalogs",
        )) as CollaborationCatalogs | null;
        if (alive && data) setCatalogs(data);
      } catch {
        // Vocabulary is presentation metadata — curated labels still render.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Label resolution: curated copy first, then any kind the SERVER offers,
  // then the raw token. The client never decides which kinds exist.
  const labelForKind = useCallback(
    (kind: string): string => {
      const curated = KIND_LABELS[kind as ThreadKind];
      if (curated) return curated;
      if (catalogs?.threadKinds.includes(kind)) return humaniseToken(kind);
      return kind;
    },
    [catalogs],
  );

  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

  // -----------------------------------------------------------------
  // Load messages + mark caller's mentions as read when a thread is
  // selected.
  // -----------------------------------------------------------------
  const loadMessages = useCallback(
    async (threadId: string) => {
      if (!teamId) return;
      setLoadingMessages(true);
      try {
        // Phase O-blockers / D-1 — apiFetch already returns parsed JSON.
        const data = (await apiFetch(
          `/v1/collaboration/threads/${encodeURIComponent(
            threadId,
          )}/messages?teamId=${encodeURIComponent(teamId)}`,
        )) as MessagesResponse;
        setMessages(data.messages ?? []);
      } catch (err) {
        const e = err as { message?: string };
        setError(toSafeUserError(e, { message: "Could not load messages." }).message);
        setMessages([]);
      } finally {
        setLoadingMessages(false);
      }
      // Best-effort: clear unread mentions for the caller in this
      // thread. Failure is non-fatal — the next inbox refresh will
      // surface them again.
      try {
        await apiFetch(
          `/v1/collaboration/threads/${encodeURIComponent(
            threadId,
          )}/mark-mentions-read?teamId=${encodeURIComponent(teamId)}`,
          { method: "POST" },
        );
      } catch {
        // intentional best-effort
      }
    },
    [teamId],
  );

  useEffect(() => {
    if (selectedThreadId) {
      void loadMessages(selectedThreadId);
    } else {
      setMessages([]);
    }
  }, [selectedThreadId, loadMessages]);

  const selectedThread = useMemo(
    () => threads?.find((t) => t.id === selectedThreadId) ?? null,
    [threads, selectedThreadId],
  );

  // -----------------------------------------------------------------
  // Post a message via the existing audited backend endpoint.
  // -----------------------------------------------------------------
  const handlePost = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!teamId || !selectedThreadId) return;
      const body = draft.trim();
      if (body.length === 0) return;
      setPosting(true);
      try {
        await apiFetch(
          `/v1/collaboration/threads/${encodeURIComponent(
            selectedThreadId,
          )}/messages?teamId=${encodeURIComponent(teamId)}`,
          {
            method: "POST",
            body: JSON.stringify({ teamId, body }),
            headers: { "Content-Type": "application/json" },
          },
        );
        setDraft("");
        await loadMessages(selectedThreadId);
      } catch (err) {
        const e2 = err as { message?: string };
        setError(toSafeUserError(e2, { message: "Could not post message." }).message);
      } finally {
        setPosting(false);
      }
    },
    [draft, loadMessages, selectedThreadId, teamId],
  );

  // -----------------------------------------------------------------
  // Operator-safe no-workspace + no-thread empty states.
  // -----------------------------------------------------------------
  if (!teamId) {
    return (
      <div
        className="evidence-discussion"
        data-evidence-discussion-empty="no-workspace"
      >
        <p className="evidence-discussion__notice">
          Discussion threads are workspace-scoped. This evidence does not have
          an active workspace context. Switch to a workspace this evidence
          belongs to in order to coordinate with reviewers.
        </p>
      </div>
    );
  }

  const visibleThreads = (threads ?? []).filter((t) => {
    // Preset filter
    if (filterPreset === "unresolved") {
      if (t.status === "RESOLVED" || t.status === "CLOSED") return false;
    } else if (filterPreset === "escalated") {
      if (!t.escalatedAtUtc) return false;
    } else if (filterPreset === "resolved") {
      if (t.status !== "RESOLVED" && t.status !== "CLOSED") return false;
    }
    // Text filter (case-insensitive title match)
    const q = filterText.trim().toLowerCase();
    if (q.length > 0 && !t.title.toLowerCase().includes(q)) return false;
    return true;
  });

  const composerDisabled = posting || draft.trim().length === 0;

  return (
    <div
      className="evidence-discussion"
      data-evidence-discussion-panel
      data-evidence-discussion-mode={readOnly ? "read-only" : "writable"}
    >
      {/* Read-only is stated once, at the top, in the canonical warning
          treatment — the composer below is REPLACED rather than disabled, so
          the mode is unmistakable instead of merely inert. */}
      {readOnly ? (
        <div
          className="app-alert app-alert--warn"
          data-evidence-discussion-readonly-banner
          role="note"
        >
          <strong>Read-only discussion</strong>
          <p>
            Existing discussion history is preserved, but new messages cannot
            be posted in the current workspace context.
          </p>
        </div>
      ) : null}

      {error ? (
        <div
          className="app-alert app-alert--danger"
          role="alert"
          data-evidence-discussion-error
        >
          <strong>Discussion could not be loaded</strong>
          <p>{error}</p>
        </div>
      ) : null}

      <div className="evidence-discussion__layout">
        {/* ---------- Thread list ---------- */}
        <div className="evidence-discussion__threads" data-evidence-discussion-list>
          <div className="evidence-discussion__threads-head">
            <h3 className="evidence-discussion__threads-title">Threads</h3>
            <PresenceIndicator
              teamId={teamId}
              resourceKind="discussion_thread"
              resourceId={selectedThreadId ?? evidenceId}
            />
          </div>

          {/* Phase G2 (C2.5) — discussion advanced filters/search.
              Client-side, bounded, operational. No realtime, no social,
              no AI. */}
          <div
            className="evidence-discussion__filters"
            data-evidence-discussion-filters
          >
            <input
              type="search"
              className="app-form-input evidence-discussion__search"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder="Filter threads by title…"
              aria-label="Filter threads by title"
              data-discussion-filter-text
            />
            <div className="evidence-discussion__presets" role="group" aria-label="Thread filter">
              {(["all", "unresolved", "escalated", "resolved"] as const).map(
                (preset) => (
                  <button
                    key={preset}
                    type="button"
                    className="evidence-discussion__preset"
                    onClick={() => setFilterPreset(preset)}
                    aria-pressed={filterPreset === preset}
                    data-discussion-filter-preset={preset}
                    data-discussion-filter-preset-active={
                      filterPreset === preset ? "true" : "false"
                    }
                  >
                    {preset === "all"
                      ? "All"
                      : preset === "unresolved"
                        ? "Unresolved"
                        : preset === "escalated"
                          ? "Escalated"
                          : "Resolved"}
                  </button>
                ),
              )}
            </div>
          </div>

          {loadingThreads ? (
            <p className="evidence-discussion__muted">Loading threads…</p>
          ) : visibleThreads.length > 0 ? (
            <ul className="evidence-discussion__thread-list">
              {visibleThreads.map((t) => {
                const active = t.id === selectedThreadId;
                return (
                  <li key={t.id}>
                    {/* Selection changes surface and border only — the row
                        keeps identical geometry selected or not, so the list
                        never shifts as the reader moves through it. */}
                    <button
                      type="button"
                      className="evidence-discussion__thread"
                      onClick={() => setSelectedThreadId(t.id)}
                      data-evidence-discussion-thread={t.id}
                      data-thread-status={t.status}
                      data-thread-escalated={t.escalatedAtUtc ? "true" : "false"}
                      data-thread-selected={active ? "true" : "false"}
                      aria-current={active ? "true" : undefined}
                    >
                      <span className="evidence-discussion__thread-title">
                        {t.title}
                      </span>
                      <span className="evidence-discussion__thread-meta">
                        <span>{labelForKind(t.kind)}</span>
                        <span
                          className="app-status-badge"
                          data-tone={statusTone(t.status)}
                        >
                          {STATUS_LABELS[t.status] ?? t.status}
                        </span>
                        {t.escalatedAtUtc ? (
                          <span className="app-status-badge" data-tone="red">
                            Escalated
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : threads && threads.length > 0 ? (
            <p
              className="evidence-discussion__muted"
              data-evidence-discussion-empty="no-matches"
            >
              No threads match the current filter.
            </p>
          ) : (
            <p
              className="evidence-discussion__muted"
              data-evidence-discussion-empty="no-threads"
            >
              No discussion threads yet. Threads created from the classic
              reviewer surfaces appear here. Operational coordination on this
              evidence should be recorded as a thread so the audit trail
              remains complete.
            </p>
          )}
        </div>

        {/* ---------- Selected thread ---------- */}
        <div className="evidence-discussion__detail" data-evidence-discussion-detail>
          {selectedThread ? (
            <>
              <div className="evidence-discussion__thread-header">
                <h3 className="evidence-discussion__thread-header-title">
                  {selectedThread.title}
                </h3>
                <div className="evidence-discussion__thread-meta">
                  <span>{labelForKind(selectedThread.kind)}</span>
                  <span
                    className="app-status-badge"
                    data-tone={statusTone(selectedThread.status)}
                  >
                    {STATUS_LABELS[selectedThread.status] ?? selectedThread.status}
                  </span>
                  {selectedThread.escalatedAtUtc ? (
                    <span className="app-status-badge" data-tone="red">
                      Escalated
                    </span>
                  ) : null}
                  <span className="evidence-discussion__stamp">
                    Updated {formatDateTime(selectedThread.updatedAt)}
                  </span>
                </div>
              </div>

              {loadingMessages ? (
                <p className="evidence-discussion__muted">Loading messages…</p>
              ) : messages.length === 0 ? (
                <p
                  className="evidence-discussion__muted"
                  data-evidence-discussion-empty="no-messages"
                >
                  No messages in this thread yet. Post one below — it will be
                  attributed to your account in the workspace audit trail.
                </p>
              ) : (
                <ol
                  className="evidence-discussion__messages"
                  data-evidence-discussion-messages
                >
                  {messages.map((m) => (
                    <li
                      key={m.id}
                      className="evidence-discussion__message"
                      data-evidence-discussion-message={m.id}
                      data-author-kind={m.authorKind}
                    >
                      <div className="evidence-discussion__message-head">
                        <span className="evidence-discussion__author">
                          {m.authorKind === "CONTRIBUTOR"
                            ? (m.contributorLabel ?? "Contributor")
                            : m.authorKind === "SYSTEM"
                              ? "System"
                              : (m.authorUserId ?? "Reviewer")}
                        </span>
                        {m.authorKind !== "USER" ? (
                          <span className="app-chip">
                            {m.authorKind === "SYSTEM" ? "System" : "Contributor"}
                          </span>
                        ) : null}
                        <span className="evidence-discussion__stamp">
                          {formatDateTime(m.createdAt)}
                        </span>
                        {m.editedAtUtc ? (
                          <span className="evidence-discussion__stamp">
                            Edited {formatDateTime(m.editedAtUtc)}
                          </span>
                        ) : null}
                      </div>
                      {/* `white-space: pre-wrap` preserves the line breaks the
                          author typed. The body is rendered as TEXT nodes —
                          never as markup — so a message cannot inject HTML. */}
                      <p className="evidence-discussion__body">
                        {renderMessageBody(m.body)}
                      </p>
                    </li>
                  ))}
                </ol>
              )}

              {readOnly ? (
                <p
                  className="evidence-discussion__muted"
                  data-evidence-discussion-readonly-message-form-hidden
                >
                  This workspace is in read-only mode for discussion. History
                  above is preserved; new messages cannot be posted.
                </p>
              ) : selectedThread.status === "RESOLVED" ||
                selectedThread.status === "CLOSED" ? (
                <p
                  className="evidence-discussion__muted"
                  data-evidence-discussion-locked
                >
                  This thread is {STATUS_LABELS[selectedThread.status]}. Reopen
                  it from the classic reviewer surface to continue.
                </p>
              ) : (
                <form
                  className="evidence-discussion__composer"
                  onSubmit={handlePost}
                  data-evidence-discussion-form
                >
                  <label
                    className="evidence-discussion__composer-label"
                    htmlFor="evidence-discussion-message"
                  >
                    Post a message
                  </label>
                  <textarea
                    id="evidence-discussion-message"
                    className="app-form-input evidence-discussion__textarea"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="Write an operational message. Use @username to mention a workspace member."
                    rows={3}
                    maxLength={8192}
                    aria-describedby="evidence-discussion-composer-note"
                  />
                  <div className="evidence-discussion__composer-foot">
                    <span
                      className="evidence-discussion__muted"
                      id="evidence-discussion-composer-note"
                    >
                      Audit-attributed. Workspace-scoped.
                    </span>
                    <button
                      type="submit"
                      className="app-primary-action"
                      disabled={composerDisabled}
                      aria-disabled={composerDisabled}
                    >
                      {posting ? "Posting…" : "Post message"}
                    </button>
                  </div>
                </form>
              )}
            </>
          ) : threads && threads.length > 0 ? (
            <p
              className="evidence-discussion__muted"
              data-evidence-discussion-empty="no-selection"
            >
              Select a thread to read its operational history and post a
              coordinating message.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
