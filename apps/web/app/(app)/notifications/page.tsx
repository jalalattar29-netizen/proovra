"use client";

/**
 * Phase 8.5 — Notification log / admin UI.
 *
 * Compact authenticated view of NotificationDelivery rows for the current
 * workspace. Operators can:
 *   - filter by status / event type
 *   - inspect the safe delivery projection
 *   - resend FAILED / RETRY_SCHEDULED / SKIPPED rows
 *
 * Privacy boundary: the page only renders fields returned by the safe
 * projector (services/api/src/services/notifications/index.ts —
 * projectNotificationDelivery). It does NOT render templateContextJson,
 * raw token bytes, IP/UA, or any workspace-internal field.
 */

import { useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../../lib/api";
import { formatUserDateTime } from "../../../lib/date";
import { useTeamId } from "../../../lib/platform-context";
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";
import { statusBadgeStyle } from "../../../components/ui/StatusBadge";
type Delivery = {
  id: string;
  eventType: string;
  channel: string;
  provider: string;
  recipient: string;
  recipientName: string | null;
  status: string;
  subject: string | null;
  templateKey: string;
  renderedPreview: string | null;
  providerMessageId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryCount: number;
  nextAttemptAtUtc: string | null;
  sentAtUtc: string | null;
  deliveredAtUtc: string | null;
  failedAtUtc: string | null;
  evidenceRequestId: string | null;
  createdAt: string;
};

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "", label: "All statuses" },
  { value: "PENDING", label: "Pending" },
  { value: "SENT", label: "Sent" },
  { value: "DELIVERED", label: "Delivered" },
  { value: "RETRY_SCHEDULED", label: "Retry scheduled" },
  { value: "FAILED", label: "Failed" },
  { value: "SKIPPED", label: "Skipped" },
  { value: "CANCELLED", label: "Cancelled" },
];

const EVENT_FILTERS: Array<{ value: string; label: string }> = [
  { value: "", label: "All events" },
  { value: "EVIDENCE_REQUEST_SENT", label: "Evidence request sent" },
  { value: "EVIDENCE_REQUEST_REMINDER", label: "Reminder" },
  { value: "EVIDENCE_REQUEST_RESPONSE_RECEIVED", label: "Response received" },
  { value: "EVIDENCE_REQUEST_NEEDS_MORE_INFO", label: "Needs more info" },
  { value: "REVIEW_REQUEST_ASSIGNED", label: "Review assignment" },
  { value: "EXTERNAL_INTAKE_LINK_CREATED", label: "Intake link created" },
];

const RESEND_ELIGIBLE = new Set([
  "FAILED",
  "RETRY_SCHEDULED",
  "SKIPPED",
]);

// Phase 38.9 — wrap in canonical PageRouteGate.
export default function NotificationsPage() {
  return (
    <PageRouteGate routeId="workspace.notifications">
      <NotificationsPageInner />
    </PageRouteGate>
  );
}

function NotificationsPageInner() {
  const teamId = useTeamId();
  const [items, setItems] = useState<Delivery[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [eventFilter, setEventFilter] = useState<string>("");
  const [resendBusyId, setResendBusyId] = useState<string | null>(null);

  
const queryString = useMemo(() => {
    if (!teamId) return "";
    const params = new URLSearchParams({ teamId });
    if (statusFilter) params.set("status", statusFilter);
    if (eventFilter) params.set("eventType", eventFilter);
    params.set("limit", "100");
    return params.toString();
  }, [teamId, statusFilter, eventFilter]);

  async function reload() {
    if (!teamId) return;
    try {
      const res: { deliveries: Delivery[] } = await apiFetch(
        `/v1/notifications/deliveries?${queryString}`,
        { method: "GET" },
      );
      setItems(res.deliveries ?? []);
      setError(null);
    } catch (err) {
      const e = err as { message?: string };
      setError(e?.message ?? "Unable to load notification log.");
    }
  }

  useEffect(() => {
    if (!queryString) return;
    void reload();
  }, [queryString]);

  async function resend(id: string) {
    if (!teamId) return;
    setResendBusyId(id);
    try {
      await apiFetch(`/v1/notifications/deliveries/${id}/resend`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId }),
      });
      await reload();
    } catch (err) {
      const e = err as { message?: string };
      alert(e?.message ?? "Could not resend.");
    } finally {
      setResendBusyId(null);
    }
  }

  return (
    <main style={pageStyle}>
      <header>
        <h1 style={titleStyle}>Notification log</h1>
        <p style={mutedTextStyle}>
          Operational delivery history for this workspace. Reviewer notes,
          token internals, IP, and user-agent are never displayed here.
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

        <label style={filterLabelStyle}>Event</label>
        <select
          style={selectStyle}
          value={eventFilter}
          onChange={(e) => setEventFilter(e.target.value)}
        >
          {EVENT_FILTERS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </section>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      {!teamId ? (
        <p style={mutedTextStyle}>Switch to a workspace to view notifications.</p>
      ) : items === null ? (
        <p style={mutedTextStyle}>Loading…</p>
      ) : items.length === 0 ? (
        <p style={mutedTextStyle}>No notifications match the current filters.</p>
      ) : (
        <ul style={listStyle}>
          {items.map((it) => (
            <li key={it.id} style={rowStyle}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, overflowWrap: "anywhere" }}>
                  {it.subject ?? "(no subject)"}
                </div>
                <div style={mutedTextStyle}>
                  {it.eventType} · {it.channel}/{it.provider} · {it.recipient}
                </div>
                <div style={mutedTextStyle}>
                  Created {formatUserDateTime(it.createdAt)}
                  {it.sentAtUtc
                    ? ` · sent ${formatUserDateTime(it.sentAtUtc)}`
                    : ""}
                  {it.failedAtUtc
                    ? ` · failed ${formatUserDateTime(it.failedAtUtc)}`
                    : ""}
                </div>
                {it.errorCode || it.errorMessage ? (
                  <div style={{ ...mutedTextStyle, color: "#b91c1c" }}>
                    {it.errorCode ? `${it.errorCode}: ` : ""}
                    {it.errorMessage ?? ""}
                  </div>
                ) : null}
                {it.retryCount > 0 ? (
                  <div style={mutedTextStyle}>
                    Retry attempts: {it.retryCount}
                    {it.nextAttemptAtUtc
                      ? ` · next ${formatUserDateTime(it.nextAttemptAtUtc)}`
                      : ""}
                  </div>
                ) : null}
              </div>
              <span style={statusBadgeStyle(it.status)}>{it.status}</span>
              {RESEND_ELIGIBLE.has(it.status) ? (
                <button
                  type="button"
                  style={resendButtonStyle}
                  onClick={() => resend(it.id)}
                  disabled={resendBusyId === it.id}
                >
                  {resendBusyId === it.id ? "Sending…" : "Resend"}
                </button>
              ) : null}
            </li>
          ))}
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
const resendButtonStyle: React.CSSProperties = {
  padding: "6px 12px",
  fontSize: 13,
  fontWeight: 500,
  color: "#fff",
  background: "#0f172a",
  border: 0,
  borderRadius: 8,
  cursor: "pointer",
};

// Phase Final-Closure — local statusBadgeStyle removed; the canonical
// version lives in components/ui/StatusBadge.tsx. CANCELLED now renders
// neutral (terminal-passive), matching ARCHIVED elsewhere.
