/**
 * Phase IA-intake-completion — Delivery history drawer for one intake link.
 *
 * Shows every CommunicationMessage tied to the link via the new
 * `?relatedIntakeLinkId=` filter on `GET /v1/communications/messages`.
 * Operator can retry rows that the backend left in RETRY_SCHEDULED.
 */

"use client";

import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "../../lib/api";
import { formatUserDate } from "../../lib/date";

type CommunicationMessageRow = {
  id: string;
  channel: "SMS" | "WHATSAPP" | "EMAIL";
  purpose: string;
  status:
    | "QUEUED"
    | "SENT"
    | "DELIVERED"
    | "FAILED"
    | "UNDELIVERED"
    | "RETRY_SCHEDULED"
    | "CANCELLED";
  provider: string;
  recipientPreview: string | null;
  bodyPreview: string | null;
  attemptCount: number;
  createdAt: string;
  sentAtUtc: string | null;
  deliveredAtUtc: string | null;
  failedAtUtc: string | null;
  nextAttemptAtUtc: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export function IntakeLinkDeliveryDrawer({
  linkId,
  teamId,
  onClose,
}: {
  linkId: string;
  teamId: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<CommunicationMessageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryBusy, setRetryBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const res: { messages: CommunicationMessageRow[] } = await apiFetch(
        `/v1/communications/messages?teamId=${encodeURIComponent(teamId)}&relatedIntakeLinkId=${encodeURIComponent(linkId)}&limit=50`,
        { method: "GET" },
      );
      setRows(res.messages ?? []);
    } catch (err) {
      const e = err as { message?: string };
      setError(e?.message ?? "Could not load delivery history.");
      setRows([]);
    }
  }, [linkId, teamId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function retry(messageId: string) {
    setRetryBusy(messageId);
    try {
      await apiFetch(
        `/v1/communications/messages/${encodeURIComponent(messageId)}/retry`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ teamId }),
        },
      );
      await reload();
    } catch (err) {
      const e = err as { message?: string };
      setError(e?.message ?? "Retry failed.");
    } finally {
      setRetryBusy(null);
    }
  }

  return (
    <div
      style={backdropStyle}
      onClick={onClose}
      data-intake-link-delivery-drawer
    >
      <aside
        style={drawerStyle}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Delivery history"
      >
        <header style={headerStyle}>
          <h2 style={titleStyle}>Delivery history</h2>
          <button type="button" style={closeBtnStyle} onClick={onClose}>
            Close
          </button>
        </header>

        {error ? <div style={errorStyle}>{error}</div> : null}

        {rows === null ? (
          <p style={mutedStyle}>Loading…</p>
        ) : rows.length === 0 ? (
          <p style={mutedStyle}>
            Nothing has been sent for this link yet. SMS and WhatsApp delivery
            attempts will appear here.
          </p>
        ) : (
          <ul style={listStyle}>
            {rows.map((r) => (
              <li
                key={r.id}
                style={rowStyle}
                data-delivery-row={r.id}
                data-delivery-status={r.status}
                data-delivery-channel={r.channel}
              >
                <div style={rowHeaderStyle}>
                  <span style={chipStyle(r.channel)}>{r.channel}</span>
                  <span style={statusChipStyle(r.status)}>
                    {humanStatus(r.status)}
                  </span>
                  <span style={mutedSmallStyle}>
                    {formatRelative(r.createdAt)}
                  </span>
                </div>
                <div style={mutedSmallStyle}>
                  to {r.recipientPreview ?? "—"} · attempt {r.attemptCount}
                </div>
                {r.errorCode ? (
                  <div style={errorRowStyle}>
                    {r.errorCode}
                    {r.errorMessage ? ` · ${r.errorMessage}` : ""}
                  </div>
                ) : null}
                <div style={timeLineStyle}>
                  {r.sentAtUtc
                    ? `Sent ${formatRelative(r.sentAtUtc)} · `
                    : ""}
                  {r.deliveredAtUtc
                    ? `Delivered ${formatRelative(r.deliveredAtUtc)} · `
                    : ""}
                  {r.failedAtUtc
                    ? `Failed ${formatRelative(r.failedAtUtc)} · `
                    : ""}
                  {r.nextAttemptAtUtc
                    ? `Next retry ${formatRelative(r.nextAttemptAtUtc)}`
                    : ""}
                </div>
                {r.status === "RETRY_SCHEDULED" || r.status === "FAILED" ? (
                  <div style={{ marginTop: 8 }}>
                    <button
                      type="button"
                      style={retryBtnStyle}
                      onClick={() => retry(r.id)}
                      disabled={retryBusy === r.id}
                      data-delivery-retry={r.id}
                    >
                      {retryBusy === r.id ? "Retrying…" : "Retry now"}
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}

function humanStatus(s: CommunicationMessageRow["status"]): string {
  switch (s) {
    case "QUEUED":
      return "Queued";
    case "SENT":
      return "Sent";
    case "DELIVERED":
      return "Delivered";
    case "FAILED":
      return "Failed";
    case "UNDELIVERED":
      return "Not delivered";
    case "RETRY_SCHEDULED":
      return "Retrying";
    case "CANCELLED":
      return "Cancelled";
  }
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const delta = Date.now() - t;
  const minutes = Math.round(delta / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatUserDate(new Date(t));
}

const backdropStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 23, 42, 0.5)",
  zIndex: 1100,
  display: "flex",
  justifyContent: "flex-end",
};
const drawerStyle: React.CSSProperties = {
  width: "min(480px, 100vw)",
  height: "100vh",
  background: "white",
  boxShadow: "-20px 0 60px rgba(15, 23, 42, 0.2)",
  padding: 20,
  overflow: "auto",
};
const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 16,
};
const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 18,
  fontWeight: 700,
};
const closeBtnStyle: React.CSSProperties = {
  padding: "6px 12px",
  border: "1px solid #cbd5e1",
  background: "white",
  borderRadius: 6,
  cursor: "pointer",
};
const errorStyle: React.CSSProperties = {
  padding: 10,
  background: "#fef2f2",
  border: "1px solid #fecaca",
  color: "#7f1d1d",
  borderRadius: 6,
  fontSize: 13,
  marginBottom: 12,
};
const mutedStyle: React.CSSProperties = {
  color: "#64748b",
  fontSize: 13,
};
const mutedSmallStyle: React.CSSProperties = {
  color: "#94a3b8",
  fontSize: 11,
};
const listStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: 10,
};
const rowStyle: React.CSSProperties = {
  padding: 12,
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  background: "#f8fafc",
};
const rowHeaderStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  marginBottom: 6,
};
const errorRowStyle: React.CSSProperties = {
  marginTop: 6,
  padding: 6,
  background: "#fef2f2",
  border: "1px solid #fecaca",
  color: "#991b1b",
  borderRadius: 4,
  fontSize: 12,
};
const timeLineStyle: React.CSSProperties = {
  marginTop: 6,
  fontSize: 11,
  color: "#475569",
};
const retryBtnStyle: React.CSSProperties = {
  padding: "5px 10px",
  background: "#0f172a",
  color: "white",
  border: 0,
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

function chipStyle(channel: string): React.CSSProperties {
  return {
    padding: "2px 8px",
    borderRadius: 999,
    background:
      channel === "WHATSAPP"
        ? "rgba(34, 197, 94, 0.15)"
        : channel === "SMS"
          ? "rgba(79, 70, 229, 0.15)"
          : "rgba(148, 163, 184, 0.15)",
    color:
      channel === "WHATSAPP"
        ? "#15803d"
        : channel === "SMS"
          ? "#4338ca"
          : "#475569",
    fontSize: 11,
    fontWeight: 700,
  };
}
function statusChipStyle(
  status: CommunicationMessageRow["status"],
): React.CSSProperties {
  const colorMap: Record<
    CommunicationMessageRow["status"],
    { bg: string; fg: string }
  > = {
    QUEUED: { bg: "#f1f5f9", fg: "#475569" },
    SENT: { bg: "#dbeafe", fg: "#1d4ed8" },
    DELIVERED: { bg: "#dcfce7", fg: "#166534" },
    FAILED: { bg: "#fee2e2", fg: "#991b1b" },
    UNDELIVERED: { bg: "#fee2e2", fg: "#991b1b" },
    RETRY_SCHEDULED: { bg: "#fef3c7", fg: "#92400e" },
    CANCELLED: { bg: "#f1f5f9", fg: "#475569" },
  };
  const c = colorMap[status];
  return {
    padding: "2px 8px",
    borderRadius: 999,
    background: c.bg,
    color: c.fg,
    fontSize: 11,
    fontWeight: 700,
  };
}
