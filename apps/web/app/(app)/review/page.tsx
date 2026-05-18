"use client";

/**
 * Phase 7 — Review queue.
 *
 * Authenticated reviewers see open work: evidence requests by status,
 * priority, and assignment. Filters are minimal and operational. The page
 * is workflow-template-driven; nothing here branches on industry vertical.
 *
 * Each row links to the underlying Evidence detail page where the
 * EvidenceRequestPanel exposes the full set of actions (waive, review
 * response, cancel, close). The queue is a triage surface, not a
 * full editor.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { apiFetch } from "../../../lib/api";

type QueueItem = {
  id: string;
  evidenceId: string | null;
  caseId: string | null;
  status: string;
  priority: string;
  requestType: string;
  title: string;
  dueAtUtc: string | null;
  recipientMode: string;
  recipientLabel: string | null;
  assignedReviewerUserId: string | null;
  requestedByUserId: string;
  createdAt: string;
  deliverables: Array<{
    id: string;
    title: string;
    required: boolean;
    status: string;
  }>;
  responses: Array<{
    id: string;
    status: string;
  }>;
};

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  OPEN: "Open",
  SENT: "Sent",
  VIEWED: "Viewed",
  IN_PROGRESS: "In progress",
  RESPONSE_RECEIVED: "Response received",
  UNDER_REVIEW: "Under internal review",
  PARTIALLY_FULFILLED: "Partially fulfilled",
  FULFILLED: "Fulfilled",
  NEEDS_MORE_INFO: "Needs additional context",
  CANCELLED: "Cancelled",
  CLOSED: "Closed",
};

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "", label: "All open" },
  { value: "RESPONSE_RECEIVED", label: "Response received" },
  { value: "UNDER_REVIEW", label: "Under review" },
  { value: "NEEDS_MORE_INFO", label: "Needs additional context" },
  { value: "PARTIALLY_FULFILLED", label: "Partially fulfilled" },
  { value: "SENT", label: "Sent — awaiting" },
  { value: "OPEN", label: "Open" },
  { value: "FULFILLED", label: "Fulfilled" },
  { value: "CLOSED", label: "Closed" },
];

const PRIORITY_FILTERS = ["", "URGENT", "HIGH", "NORMAL", "LOW"];

export default function ReviewQueuePage() {
  const [teamId, setTeamId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [featureDisabled, setFeatureDisabled] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [priorityFilter, setPriorityFilter] = useState<string>("");
  const [unassignedOnly, setUnassignedOnly] = useState(false);

  // Resolve current workspace.
  useEffect(() => {
    let cancelled = false;
    apiFetch("/v1/users/me", { method: "GET" })
      .then(
        (res: {
          user?: { id?: string; currentWorkspaceId?: string | null };
        }) => {
          if (cancelled) return;
          setTeamId(res?.user?.currentWorkspaceId ?? null);
          setUserId(res?.user?.id ?? null);
        },
      )
      .catch(() => {
        setTeamId(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const queryString = useMemo(() => {
    if (!teamId) return "";
    const params = new URLSearchParams({ teamId });
    if (statusFilter) params.set("status", statusFilter);
    if (priorityFilter) params.set("priority", priorityFilter);
    if (unassignedOnly) params.set("unassigned", "true");
    return params.toString();
  }, [teamId, statusFilter, priorityFilter, unassignedOnly]);

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    apiFetch(`/v1/review/queue?${queryString}`, { method: "GET" })
      .then((res: { items: QueueItem[] }) => {
        if (cancelled) return;
        setItems(res.items ?? []);
        setError(null);
        setFeatureDisabled(false);
      })
      .catch((err: { message?: string; code?: string; statusCode?: number }) => {
        if (cancelled) return;
        if (err?.statusCode === 503 || err?.code === "FEATURE_DISABLED") {
          setFeatureDisabled(true);
          setItems([]);
          return;
        }
        setError(err?.message ?? "Unable to load review queue.");
      });
    return () => {
      cancelled = true;
    };
  }, [queryString]);

  return (
    <main style={pageStyle}>
      <header>
        <h1 style={titleStyle}>Review queue</h1>
        <p style={mutedTextStyle}>
          Coordinate evidence requests, contributor submissions, and reviewer
          decisions across the workspace.
        </p>
      </header>

      <section style={filterRowStyle}>
        <label style={filterLabelStyle}>Status</label>
        <select
          style={selectStyle}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          {STATUS_FILTERS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>

        <label style={filterLabelStyle}>Priority</label>
        <select
          style={selectStyle}
          value={priorityFilter}
          onChange={(e) => setPriorityFilter(e.target.value)}
        >
          {PRIORITY_FILTERS.map((p) => (
            <option key={p} value={p}>
              {p === "" ? "Any" : p}
            </option>
          ))}
        </select>

        <label style={{ ...filterLabelStyle, display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={unassignedOnly}
            onChange={(e) => setUnassignedOnly(e.target.checked)}
          />
          Unassigned only
        </label>
      </section>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      {featureDisabled ? (
        <div style={infoBoxStyle}>
          The review queue is not enabled on this deployment. Ask a platform
          administrator to set <code>EVIDENCE_REQUESTS_ENABLED=true</code>.
        </div>
      ) : !teamId ? (
        <p style={mutedTextStyle}>Switch to a workspace to use the review queue.</p>
      ) : items === null ? (
        <p style={mutedTextStyle}>Loading…</p>
      ) : items.length === 0 ? (
        <p style={mutedTextStyle}>No items match the current filters.</p>
      ) : (
        <ul style={listStyle}>
          {items.map((it) => {
            const requiredRemaining = it.deliverables.filter(
              (d) =>
                d.required && d.status !== "FULFILLED" && d.status !== "WAIVED",
            ).length;
            const responseCount = it.responses.length;
            const dueLabel = it.dueAtUtc
              ? new Date(it.dueAtUtc).toLocaleString()
              : "No due date";
            return (
              <li key={it.id} style={rowStyle}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{it.title}</div>
                  <div style={mutedTextStyle}>
                    {it.requestType} · {it.recipientMode}
                    {it.recipientLabel ? ` · ${it.recipientLabel}` : ""} · Due{" "}
                    {dueLabel}
                  </div>
                  <div style={mutedTextStyle}>
                    {requiredRemaining > 0
                      ? `${requiredRemaining} required deliverable${requiredRemaining === 1 ? "" : "s"} pending`
                      : "All required deliverables resolved"}
                    {responseCount > 0
                      ? ` · ${responseCount} response${responseCount === 1 ? "" : "s"}`
                      : ""}
                  </div>
                </div>
                <span style={statusBadgeStyle(it.status)}>
                  {STATUS_LABEL[it.status] ?? it.status}
                </span>
                <span style={priorityBadgeStyle(it.priority)}>{it.priority}</span>
                {userId && it.assignedReviewerUserId !== userId ? (
                  <button
                    type="button"
                    style={smallButtonStyle}
                    onClick={async () => {
                      try {
                        await apiFetch(
                          `/v1/evidence-requests/${it.id}/assign`,
                          {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({
                              assignedReviewerUserId: userId,
                            }),
                          },
                        );
                        // Refresh local view of the row.
                        setItems((prev) =>
                          prev
                            ? prev.map((p) =>
                                p.id === it.id
                                  ? { ...p, assignedReviewerUserId: userId }
                                  : p,
                              )
                            : prev,
                        );
                      } catch (err) {
                        alert(
                          (err as { message?: string })?.message ??
                            "Could not assign.",
                        );
                      }
                    }}
                  >
                    Assign to me
                  </button>
                ) : userId && it.assignedReviewerUserId === userId ? (
                  <span style={mutedTextStyle}>Assigned to you</span>
                ) : null}
                {it.evidenceId ? (
                  <Link
                    href={`/evidence/${it.evidenceId}`}
                    style={linkButtonStyle}
                  >
                    Open evidence →
                  </Link>
                ) : (
                  <span style={mutedTextStyle}>Standalone request</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}

const pageStyle: React.CSSProperties = {
  maxWidth: 1080,
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
const mutedTextStyle: React.CSSProperties = {
  fontSize: 13,
  color: "#64748b",
};
const filterRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 12,
  alignItems: "center",
  flexWrap: "wrap",
  marginTop: 16,
  marginBottom: 16,
};
const filterLabelStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "#334155",
};
const selectStyle: React.CSSProperties = {
  padding: "6px 10px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 13,
  background: "#fff",
};
const listStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
};
const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "12px 16px",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  marginBottom: 8,
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
const linkButtonStyle: React.CSSProperties = {
  padding: "6px 12px",
  fontSize: 13,
  fontWeight: 500,
  color: "#0f172a",
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  textDecoration: "none",
};
const smallButtonStyle: React.CSSProperties = {
  padding: "6px 12px",
  fontSize: 12,
  fontWeight: 500,
  color: "#0f172a",
  background: "#fff",
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  cursor: "pointer",
};
const infoBoxStyle: React.CSSProperties = {
  marginTop: 16,
  padding: 16,
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  borderRadius: 8,
  fontSize: 14,
  color: "#334155",
};

function statusBadgeStyle(status: string): React.CSSProperties {
  const palette: Record<string, [string, string, string]> = {
    DRAFT: ["#f1f5f9", "#cbd5e1", "#475569"],
    OPEN: ["#eff6ff", "#bfdbfe", "#1e40af"],
    SENT: ["#eff6ff", "#bfdbfe", "#1e40af"],
    VIEWED: ["#eff6ff", "#bfdbfe", "#1e40af"],
    IN_PROGRESS: ["#eff6ff", "#bfdbfe", "#1e40af"],
    RESPONSE_RECEIVED: ["#fef3c7", "#fde68a", "#92400e"],
    UNDER_REVIEW: ["#fef3c7", "#fde68a", "#92400e"],
    PARTIALLY_FULFILLED: ["#fef9c3", "#fde68a", "#854d0e"],
    FULFILLED: ["#dcfce7", "#bbf7d0", "#166534"],
    NEEDS_MORE_INFO: ["#fef3c7", "#fde68a", "#92400e"],
    CANCELLED: ["#fef2f2", "#fecaca", "#7f1d1d"],
    CLOSED: ["#f1f5f9", "#cbd5e1", "#475569"],
  };
  const [bg, border, color] = palette[status] ?? palette.DRAFT;
  return {
    padding: "4px 10px",
    fontSize: 12,
    fontWeight: 600,
    background: bg,
    border: `1px solid ${border}`,
    color,
    borderRadius: 999,
  };
}

function priorityBadgeStyle(priority: string): React.CSSProperties {
  const palette: Record<string, [string, string]> = {
    URGENT: ["#fef2f2", "#7f1d1d"],
    HIGH: ["#fff7ed", "#9a3412"],
    NORMAL: ["#f1f5f9", "#475569"],
    LOW: ["#f8fafc", "#94a3b8"],
  };
  const [bg, color] = palette[priority] ?? palette.NORMAL;
  return {
    padding: "2px 8px",
    fontSize: 11,
    background: bg,
    color,
    borderRadius: 999,
  };
}
