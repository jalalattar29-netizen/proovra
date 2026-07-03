"use client";

/**
 * Phase 16 — Collaboration operations console.
 *
 * Reviewer-and-above view of in-flight discussion threads in the
 * workspace. Dense, workflow-centric layout — NOT a chat client.
 *
 * Wording: never claim authenticity, admissibility, or factual
 * truth. The page surfaces operator coordination state only.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../../lib/api";
import { formatUserDateTime } from "../../../lib/date";
import { usePlatformContext, useTeamId } from "../../../lib/platform-context";
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
type ThreadStatus = "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED";
type ThreadVisibility = "INTERNAL" | "CONTRIBUTOR_SCOPED";

type Thread = {
  id: string;
  evidenceId: string;
  evidenceRequestId: string | null;
  kind: string;
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

type Counts = {
  open: number;
  inProgress: number;
  resolved: number;
  closed: number;
  unresolvedAssignedToMe: number;
  unresolvedMentions: number;
};

type Message = {
  id: string;
  threadId: string;
  authorKind: "USER" | "CONTRIBUTOR" | "SYSTEM";
  authorUserId: string | null;
  contributorLabel: string | null;
  body: string;
  createdAt: string;
};

const STATUSES: ThreadStatus[] = ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"];

// Phase 38.15 — wrap in canonical PageRouteGate.
export default function CollaborationPage() {
  return (
    <PageRouteGate routeId="workspace.collaboration">
      <CollaborationPageInner />
    </PageRouteGate>
  );
}

function CollaborationPageInner() {
  const teamId = useTeamId();
  const meUserId = usePlatformContext().envelope?.user.id ?? null;
  const [counts, setCounts] = useState<Counts | null>(null);
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<ThreadStatus | "">(
    "IN_PROGRESS",
  );
  const [assignedToMe, setAssignedToMe] = useState(false);
  const [selected, setSelected] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  
useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    const qs = new URLSearchParams();
    qs.set("teamId", teamId);
    if (statusFilter) qs.set("status", statusFilter);
    if (assignedToMe && meUserId) qs.set("assignedToUserId", meUserId);
    qs.set("limit", "100");
    Promise.all([
      apiFetch(
        `/v1/collaboration/threads/counts?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      ),
      apiFetch(`/v1/collaboration/threads?${qs.toString()}`, {
        method: "GET",
      }),
    ])
      .then(
        ([c, list]: [
          { counts: Counts },
          { threads: Thread[] },
        ]) => {
          if (cancelled) return;
          setCounts(c.counts);
          setThreads(list.threads ?? []);
          setError(null);
        },
      )
      .catch((err: { message?: string }) => {
        if (cancelled) return;
        setError(err?.message ?? "Could not load discussions.");
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, statusFilter, assignedToMe, meUserId]);

  useEffect(() => {
    if (!teamId || !selected) {
      setMessages(null);
      return;
    }
    let cancelled = false;
    apiFetch(
      `/v1/collaboration/threads/${selected.id}/messages?teamId=${encodeURIComponent(teamId)}`,
      { method: "GET" },
    )
      .then((res: { messages: Message[] }) => {
        if (!cancelled) setMessages(res.messages ?? []);
      })
      .catch(() => setMessages([]));
    return () => {
      cancelled = true;
    };
  }, [teamId, selected]);

  async function postReply() {
    if (!teamId || !selected || draft.trim().length === 0) return;
    setBusy(true);
    try {
      const res: { message: Message } = await apiFetch(
        `/v1/collaboration/threads/${selected.id}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ teamId, body: draft }),
        },
      );
      setMessages((prev) => (prev ? [...prev, res.message] : [res.message]));
      setDraft("");
    } catch (err) {
      const e = err as { message?: string };
      alert(e?.message ?? "Could not post reply.");
    } finally {
      setBusy(false);
    }
  }

  async function transition(action: "resolve" | "reopen" | "escalate") {
    if (!teamId || !selected) return;
    let reason: string | null = null;
    if (action === "reopen" || action === "escalate") {
      reason = window.prompt(
        action === "reopen"
          ? "Reason for reopening (required, internal only)"
          : "Reason for escalation (required, internal only)",
      );
      if (!reason || reason.trim().length === 0) return;
    }
    setBusy(true);
    try {
      const url = `/v1/collaboration/threads/${selected.id}/${action}`;
      const body =
        action === "resolve"
          ? { teamId }
          : { teamId, reason };
      const res: { thread: Thread } = await apiFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      setSelected(res.thread);
      setThreads((prev) =>
        prev
          ? prev.map((t) => (t.id === res.thread.id ? res.thread : t))
          : prev,
      );
    } catch (err) {
      const e = err as { message?: string };
      alert(e?.message ?? "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  const headlineCounts = useMemo(() => {
    if (!counts) return null;
    return {
      active: counts.open + counts.inProgress,
      assignedToMe: counts.unresolvedAssignedToMe,
      mentions: counts.unresolvedMentions,
      resolved: counts.resolved,
      closed: counts.closed,
    };
  }, [counts]);

  return (
    <main style={pageStyle}>
      <header>
        <h1 style={titleStyle}>Collaboration</h1>
        <p style={mutedStyle}>
          Workspace-internal discussion threads for evidence review,
          investigation coordination, and contributor follow-ups. Threads
          and messages NEVER appear on public verify and are not
          exported with reports by default.
        </p>
      </header>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      {!teamId ? (
        <p style={mutedStyle}>Switch to a workspace to use collaboration.</p>
      ) : counts === null || headlineCounts === null ? (
        <p style={mutedStyle}>Loading…</p>
      ) : (
        <>
          <section style={cardStyle}>
            <h2 style={sectionTitleStyle}>Headlines</h2>
            <div style={summaryGridStyle}>
              <Stat label="Active" value={String(headlineCounts.active)} />
              <Stat
                label="Assigned to me"
                value={String(headlineCounts.assignedToMe)}
              />
              <Stat
                label="Unread mentions"
                value={String(headlineCounts.mentions)}
                tone={headlineCounts.mentions > 0 ? "warn" : "neutral"}
              />
              <Stat label="Resolved" value={String(headlineCounts.resolved)} />
              <Stat label="Closed" value={String(headlineCounts.closed)} />
            </div>
          </section>

          <section style={cardStyle}>
            <div style={cardHeaderStyle}>
              <h2 style={sectionTitleStyle}>Threads</h2>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <select
                  value={statusFilter}
                  onChange={(e) =>
                    setStatusFilter(e.target.value as ThreadStatus | "")
                  }
                  style={selectStyle}
                >
                  <option value="">All statuses</option>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <label style={checkboxLabelStyle}>
                  <input
                    type="checkbox"
                    checked={assignedToMe}
                    disabled={!meUserId}
                    onChange={(e) => setAssignedToMe(e.target.checked)}
                  />
                  Assigned to me
                </label>
              </div>
            </div>
            {threads === null ? (
              <p style={mutedStyle}>Loading…</p>
            ) : threads.length === 0 ? (
              <p style={mutedStyle}>No threads match the current filters.</p>
            ) : (
              <ul style={listStyle}>
                {threads.map((t) => (
                  <li
                    key={t.id}
                    style={{
                      ...rowStyle,
                      cursor: "pointer",
                      background: selected?.id === t.id ? "#f8fafc" : "transparent",
                    }}
                    onClick={() => setSelected(t)}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>{t.title}</div>
                      <div style={mutedStyle}>
                        {t.kind} · evidence{" "}
                        <Link
                          href={`/evidence/${t.evidenceId}`}
                          onClick={(e) => e.stopPropagation()}
                          style={{ color: "#1e40af" }}
                        >
                          {t.evidenceId.slice(0, 8)}…
                        </Link>
                        {t.assignedToUserId
                          ? ` · assigned ${t.assignedToUserId.slice(0, 8)}…`
                          : ""}
                        {t.escalatedAtUtc ? " · escalated" : ""}
                        {t.reopenCount > 0 ? ` · reopened ${t.reopenCount}×` : ""}
                      </div>
                    </div>
                    <span style={statusBadgeStyle(t.status)}>{t.status}</span>
                    {t.visibility === "CONTRIBUTOR_SCOPED" ? (
                      <span style={visibilityBadgeStyle}>contributor</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {selected ? (
            <section style={cardStyle}>
              <div style={cardHeaderStyle}>
                <h2 style={sectionTitleStyle}>{selected.title}</h2>
                <div style={{ display: "flex", gap: 8 }}>
                  {selected.status !== "RESOLVED" &&
                  selected.status !== "CLOSED" ? (
                    <button
                      type="button"
                      style={secondaryButtonStyle}
                      disabled={busy}
                      onClick={() => transition("resolve")}
                    >
                      Resolve
                    </button>
                  ) : (
                    <button
                      type="button"
                      style={secondaryButtonStyle}
                      disabled={busy}
                      onClick={() => transition("reopen")}
                    >
                      Reopen
                    </button>
                  )}
                  <button
                    type="button"
                    style={secondaryButtonStyle}
                    disabled={busy || selected.status === "CLOSED"}
                    onClick={() => transition("escalate")}
                  >
                    Escalate
                  </button>
                </div>
              </div>
              <p style={mutedStyle}>
                {selected.kind} ·{" "}
                {selected.visibility === "CONTRIBUTOR_SCOPED"
                  ? "Visible to a scoped external contributor"
                  : "Workspace-internal only"}
              </p>
              {messages === null ? (
                <p style={mutedStyle}>Loading messages…</p>
              ) : (
                <ul style={messageListStyle}>
                  {messages.map((m) => (
                    <li key={m.id} style={messageRowStyle}>
                      <div style={mutedStyle}>
                        {m.authorKind === "CONTRIBUTOR"
                          ? `contributor ${m.contributorLabel ?? "…"}`
                          : m.authorUserId
                            ? `user ${m.authorUserId.slice(0, 8)}…`
                            : "system"}{" "}
                        · {formatUserDateTime(m.createdAt)}
                      </div>
                      <div style={{ whiteSpace: "pre-wrap" }}>{m.body}</div>
                    </li>
                  ))}
                </ul>
              )}
              {selected.status !== "CLOSED" ? (
                <div style={{ marginTop: 12 }}>
                  <textarea
                    style={{ ...inputStyle, minHeight: 80, width: "100%" }}
                    placeholder="Reply (internal). @-mention workspace members by their handle."
                    value={draft}
                    onChange={(e) => setDraft(e.target.value.slice(0, 8 * 1024))}
                  />
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "flex-end",
                      marginTop: 8,
                    }}
                  >
                    <button
                      type="button"
                      style={primaryButtonStyle}
                      disabled={busy || draft.trim().length === 0}
                      onClick={() => void postReply()}
                    >
                      Post reply
                    </button>
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}
        </>
      )}
    </main>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "warn";
}) {
  return (
    <div style={statStyle}>
      <div
        style={{
          fontSize: 22,
          fontWeight: 700,
          color: tone === "warn" ? "#b45309" : "#0f172a",
        }}
      >
        {value}
      </div>
      <div style={mutedStyle}>{label}</div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------------

const pageStyle: React.CSSProperties = {
  maxWidth: 960,
  margin: "0 auto",
  padding: "32px 24px",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  color: "#0f172a",
};
const titleStyle: React.CSSProperties = {
  fontSize: 24,
  fontWeight: 700,
  marginBottom: 4,
};
const sectionTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  marginBottom: 12,
};
const mutedStyle: React.CSSProperties = { fontSize: 13, color: "#64748b" };
const cardStyle: React.CSSProperties = {
  marginTop: 24,
  padding: 20,
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  background: "#fff",
};
const cardHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 8,
  marginBottom: 12,
};
const summaryGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
  gap: 12,
};
const statStyle: React.CSSProperties = {
  padding: 12,
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
};
const listStyle: React.CSSProperties = { listStyle: "none", padding: 0, margin: 0 };
const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 8px",
  borderBottom: "1px solid #e2e8f0",
  borderRadius: 6,
};
const messageListStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  marginTop: 12,
};
const messageRowStyle: React.CSSProperties = {
  padding: 12,
  marginBottom: 8,
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  fontSize: 14,
};
const checkboxLabelStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  fontSize: 13,
};
const errorBoxStyle: React.CSSProperties = {
  marginTop: 12,
  padding: 12,
  background: "#fef2f2",
  color: "#7f1d1d",
  border: "1px solid #fecaca",
  borderRadius: 8,
  fontSize: 14,
};
const selectStyle: React.CSSProperties = {
  padding: "6px 12px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 13,
  background: "#fff",
  color: "#0f172a",
};
const inputStyle: React.CSSProperties = {
  padding: "8px 12px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 14,
  fontFamily: "inherit",
  color: "#0f172a",
  background: "#fff",
};
const primaryButtonStyle: React.CSSProperties = {
  padding: "8px 16px",
  fontWeight: 600,
  color: "#fff",
  background: "#0f172a",
  border: 0,
  borderRadius: 8,
  cursor: "pointer",
  fontSize: 14,
};
const secondaryButtonStyle: React.CSSProperties = {
  padding: "6px 14px",
  fontWeight: 500,
  color: "#0f172a",
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  cursor: "pointer",
  fontSize: 13,
};
const visibilityBadgeStyle: React.CSSProperties = {
  padding: "2px 8px",
  fontSize: 11,
  fontWeight: 600,
  borderRadius: 999,
  background: "#fffbeb",
  color: "#92400e",
  border: "1px solid #fcd34d",
};

function statusBadgeStyle(status: ThreadStatus): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: "4px 10px",
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 999,
    border: "1px solid",
    whiteSpace: "nowrap",
  };
  if (status === "RESOLVED") {
    return {
      ...base,
      background: "#f0fdf4",
      borderColor: "#86efac",
      color: "#166534",
    };
  }
  if (status === "CLOSED") {
    return {
      ...base,
      background: "#f1f5f9",
      borderColor: "#cbd5e1",
      color: "#475569",
    };
  }
  return {
    ...base,
    background: "#eff6ff",
    borderColor: "#93c5fd",
    color: "#1e40af",
  };
}
