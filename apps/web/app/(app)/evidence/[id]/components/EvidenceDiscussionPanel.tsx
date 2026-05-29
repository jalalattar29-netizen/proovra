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
        data-discussion-mention-token={m[0]}
        style={{
          background: "rgba(99,102,241,0.18)",
          color: "#3730a3",
          padding: "0 4px",
          borderRadius: 4,
          fontWeight: 600,
        }}
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
}: {
  evidenceId: string;
  teamId: string | null;
  initialThreadId?: string | null;
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
      setError(e.message ?? "Could not load discussion threads.");
      setThreads([]);
    } finally {
      setLoadingThreads(false);
    }
  }, [evidenceId, teamId]);

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
        setError(e.message ?? "Could not load messages.");
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
        setError(e2.message ?? "Could not post message.");
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
      <section
        className="evidence-discussion-panel"
        data-evidence-discussion-empty="no-workspace"
        style={panelStyle}
      >
        <h3 style={{ margin: 0 }}>Discussion</h3>
        <p style={{ margin: "0.5rem 0 0", opacity: 0.85 }}>
          Discussion threads are workspace-scoped. This evidence does not have
          an active workspace context. Switch to a workspace this evidence
          belongs to in order to coordinate with reviewers.
        </p>
      </section>
    );
  }

  return (
    <section
      className="evidence-discussion-panel"
      data-evidence-discussion-panel
      style={panelStyle}
    >
      <header style={{ marginBottom: "0.75rem" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <h3 style={{ margin: 0 }}>Discussion</h3>
          {/* Phase G3.2 — Presence on the selected thread (or the
              evidence-level panel when no thread is selected). */}
          <PresenceIndicator
            teamId={teamId}
            resourceKind="discussion_thread"
            resourceId={selectedThreadId ?? evidenceId}
          />
        </div>
        <p style={{ margin: "0.25rem 0 0", opacity: 0.8, fontSize: 13 }}>
          Operational coordination attached to this evidence. Threads are
          workspace-scoped and audit-visible. Use this surface instead of
          external chat tools to preserve traceability.
        </p>
      </header>

      {error ? (
        <div
          role="alert"
          data-evidence-discussion-error
          style={{
            border: "1px solid rgba(239,68,68,0.45)",
            background: "rgba(239,68,68,0.08)",
            padding: "0.5rem 0.75rem",
            borderRadius: 6,
            marginBottom: "0.75rem",
            fontSize: 13,
          }}
        >
          {error}
        </div>
      ) : null}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(260px, 1fr) minmax(380px, 2fr)",
          gap: "1rem",
        }}
      >
        {/* ---------- Thread list ---------- */}
        <div data-evidence-discussion-list>
          <div
            style={{
              fontSize: 11,
              opacity: 0.7,
              letterSpacing: 0.4,
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            Threads
          </div>

          {/* Phase G2 (C2.5) — discussion advanced filters/search.
              Client-side, bounded, operational. No realtime, no
              social, no AI. */}
          <div
            data-evidence-discussion-filters
            style={{
              display: "flex",
              gap: 6,
              marginBottom: 8,
              flexWrap: "wrap",
            }}
          >
            <input
              type="search"
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              placeholder="Filter threads by title…"
              data-discussion-filter-text
              style={{
                flex: 1,
                padding: "4px 8px",
                fontSize: 12.5,
                borderRadius: 6,
                border: "1px solid rgba(127,127,127,0.4)",
                background: "transparent",
                color: "inherit",
              }}
            />
            {(["all", "unresolved", "escalated", "resolved"] as const).map(
              (preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setFilterPreset(preset)}
                  data-discussion-filter-preset={preset}
                  data-discussion-filter-preset-active={
                    filterPreset === preset ? "true" : "false"
                  }
                  style={{
                    padding: "3px 8px",
                    fontSize: 11.5,
                    borderRadius: 999,
                    border:
                      filterPreset === preset
                        ? "1px solid rgba(99,102,241,0.6)"
                        : "1px solid rgba(127,127,127,0.3)",
                    background:
                      filterPreset === preset
                        ? "rgba(99,102,241,0.12)"
                        : "transparent",
                    color: "inherit",
                    cursor: "pointer",
                  }}
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

          {loadingThreads ? (
            <p style={{ fontSize: 13, opacity: 0.75 }}>Loading threads…</p>
          ) : threads && threads.length > 0 ? (
            <ul
              style={{
                listStyle: "none",
                padding: 0,
                margin: 0,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              {threads
                .filter((t) => {
                  // Preset filter
                  if (filterPreset === "unresolved") {
                    if (t.status === "RESOLVED" || t.status === "CLOSED") {
                      return false;
                    }
                  } else if (filterPreset === "escalated") {
                    if (!t.escalatedAtUtc) return false;
                  } else if (filterPreset === "resolved") {
                    if (t.status !== "RESOLVED" && t.status !== "CLOSED") {
                      return false;
                    }
                  }
                  // Text filter (case-insensitive title match)
                  const q = filterText.trim().toLowerCase();
                  if (q.length > 0 && !t.title.toLowerCase().includes(q)) {
                    return false;
                  }
                  return true;
                })
                .map((t) => {
                const active = t.id === selectedThreadId;
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedThreadId(t.id)}
                      data-evidence-discussion-thread={t.id}
                      data-thread-status={t.status}
                      data-thread-escalated={t.escalatedAtUtc ? "true" : "false"}
                      aria-current={active ? "true" : undefined}
                      style={{
                        width: "100%",
                        textAlign: "left",
                        padding: "0.55rem 0.7rem",
                        borderRadius: 6,
                        border: active
                          ? "1px solid rgba(99,102,241,0.65)"
                          : "1px solid rgba(127,127,127,0.25)",
                        background: active
                          ? "rgba(99,102,241,0.08)"
                          : "rgba(127,127,127,0.04)",
                        cursor: "pointer",
                        color: "inherit",
                      }}
                    >
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 600,
                          marginBottom: 2,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {t.title}
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          opacity: 0.75,
                          display: "flex",
                          gap: 6,
                          flexWrap: "wrap",
                        }}
                      >
                        <span>{KIND_LABELS[t.kind] ?? t.kind}</span>
                        <span>·</span>
                        <span>{STATUS_LABELS[t.status] ?? t.status}</span>
                        {t.escalatedAtUtc ? (
                          <>
                            <span>·</span>
                            <span style={{ color: "#b91c1c", fontWeight: 600 }}>
                              escalated
                            </span>
                          </>
                        ) : null}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p
              style={{ fontSize: 13, opacity: 0.78, margin: 0 }}
              data-evidence-discussion-empty="no-threads"
            >
              No discussion threads yet. Threads created from the classic
              reviewer surfaces appear here. Operational coordination on
              this evidence should be recorded as a thread so the audit
              trail remains complete.
            </p>
          )}
        </div>

        {/* ---------- Selected thread ---------- */}
        <div data-evidence-discussion-detail>
          {selectedThread ? (
            <>
              <div
                style={{
                  border: "1px solid rgba(127,127,127,0.25)",
                  borderRadius: 6,
                  padding: "0.75rem 0.85rem",
                  marginBottom: "0.75rem",
                }}
              >
                <h4 style={{ margin: 0, fontSize: 14 }}>
                  {selectedThread.title}
                </h4>
                <div
                  style={{
                    marginTop: 4,
                    fontSize: 11,
                    opacity: 0.75,
                    display: "flex",
                    gap: 6,
                    flexWrap: "wrap",
                  }}
                >
                  <span>
                    {KIND_LABELS[selectedThread.kind] ?? selectedThread.kind}
                  </span>
                  <span>·</span>
                  <span>
                    {STATUS_LABELS[selectedThread.status] ?? selectedThread.status}
                  </span>
                  {selectedThread.escalatedAtUtc ? (
                    <>
                      <span>·</span>
                      <span style={{ color: "#b91c1c", fontWeight: 600 }}>
                        escalated
                      </span>
                    </>
                  ) : null}
                  <span>·</span>
                  <span>updated {formatDateTime(selectedThread.updatedAt)}</span>
                </div>
              </div>

              {loadingMessages ? (
                <p style={{ fontSize: 13, opacity: 0.75 }}>Loading messages…</p>
              ) : messages.length === 0 ? (
                <p
                  style={{ fontSize: 13, opacity: 0.78 }}
                  data-evidence-discussion-empty="no-messages"
                >
                  No messages in this thread yet. Post one below — it will be
                  attributed to your account in the workspace audit trail.
                </p>
              ) : (
                <ol
                  style={{
                    listStyle: "none",
                    padding: 0,
                    margin: 0,
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                  data-evidence-discussion-messages
                >
                  {messages.map((m) => (
                    <li
                      key={m.id}
                      data-evidence-discussion-message={m.id}
                      data-author-kind={m.authorKind}
                      style={{
                        border: "1px solid rgba(127,127,127,0.2)",
                        borderRadius: 6,
                        padding: "0.55rem 0.7rem",
                        background:
                          m.authorKind === "SYSTEM"
                            ? "rgba(127,127,127,0.06)"
                            : "transparent",
                      }}
                    >
                      <div
                        style={{
                          fontSize: 11,
                          opacity: 0.78,
                          marginBottom: 4,
                          display: "flex",
                          gap: 6,
                          flexWrap: "wrap",
                        }}
                      >
                        <strong style={{ fontWeight: 600 }}>
                          {m.authorKind === "CONTRIBUTOR"
                            ? m.contributorLabel ?? "Contributor"
                            : m.authorKind === "SYSTEM"
                              ? "System"
                              : m.authorUserId ?? "Reviewer"}
                        </strong>
                        <span>·</span>
                        <span>{formatDateTime(m.createdAt)}</span>
                        {m.editedAtUtc ? (
                          <>
                            <span>·</span>
                            <em style={{ opacity: 0.7 }}>
                              edited {formatDateTime(m.editedAtUtc)}
                            </em>
                          </>
                        ) : null}
                      </div>
                      <p
                        style={{
                          margin: 0,
                          whiteSpace: "pre-wrap",
                          fontSize: 14,
                          lineHeight: 1.45,
                        }}
                      >
                        {renderMessageBody(m.body)}
                      </p>
                    </li>
                  ))}
                </ol>
              )}

              {selectedThread.status === "RESOLVED" ||
              selectedThread.status === "CLOSED" ? (
                <p
                  style={{ fontSize: 12, opacity: 0.72, marginTop: 12 }}
                  data-evidence-discussion-locked
                >
                  This thread is {STATUS_LABELS[selectedThread.status]}. Reopen
                  it from the classic reviewer surface to continue.
                </p>
              ) : (
                <form
                  onSubmit={handlePost}
                  style={{ marginTop: 12 }}
                  data-evidence-discussion-form
                >
                  <label
                    htmlFor="evidence-discussion-message"
                    style={{
                      display: "block",
                      fontSize: 12,
                      opacity: 0.78,
                      marginBottom: 4,
                    }}
                  >
                    Post a message
                  </label>
                  <textarea
                    id="evidence-discussion-message"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="Write an operational message. Use @username to mention a workspace member."
                    rows={3}
                    maxLength={8192}
                    style={{
                      width: "100%",
                      resize: "vertical",
                      padding: "0.5rem 0.6rem",
                      borderRadius: 6,
                      border: "1px solid rgba(127,127,127,0.4)",
                      background: "transparent",
                      color: "inherit",
                      fontSize: 13.5,
                      fontFamily: "inherit",
                    }}
                  />
                  <div
                    style={{
                      marginTop: 6,
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <small style={{ opacity: 0.7 }}>
                      Audit-attributed. Workspace-scoped.
                    </small>
                    <button
                      type="submit"
                      disabled={posting || draft.trim().length === 0}
                      style={{
                        padding: "0.4rem 0.85rem",
                        borderRadius: 6,
                        border: "1px solid rgba(99,102,241,0.6)",
                        background:
                          posting || draft.trim().length === 0
                            ? "rgba(99,102,241,0.18)"
                            : "rgba(99,102,241,0.85)",
                        color:
                          posting || draft.trim().length === 0 ? "#3730a3" : "#fff",
                        cursor:
                          posting || draft.trim().length === 0
                            ? "default"
                            : "pointer",
                        fontSize: 13,
                      }}
                    >
                      {posting ? "Posting…" : "Post message"}
                    </button>
                  </div>
                </form>
              )}
            </>
          ) : threads && threads.length > 0 ? (
            <p
              style={{ fontSize: 13, opacity: 0.78 }}
              data-evidence-discussion-empty="no-selection"
            >
              Select a thread on the left to read its operational history and
              post a coordinating message.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

const panelStyle = {
  border: "1px solid rgba(127,127,127,0.25)",
  borderRadius: 8,
  padding: "1rem 1.1rem",
  background: "rgba(127,127,127,0.03)",
} as const;
