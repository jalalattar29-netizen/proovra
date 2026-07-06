"use client";

/**
 * Phase 18 — Enterprise communications operations console.
 *
 * Workspace-internal operator view of:
 *   - provider health (configured/unconfigured, no secrets)
 *   - outbound + inbound communication messages with channel / purpose
 *     / status filters
 *   - failed + retry-scheduled rows with cancel / retry controls
 *   - per-recipient delivery preview (masked phone, never raw)
 *
 * Wording: never claim "delivered" without provider confirmation. We
 * surface the row status verbatim and explain that delivery state is
 * provider-reported via webhook.
 */

import { toSafeUserError } from "../../../lib/feedback/toSafeUserError";
import { useEffect, useMemo, useState } from "react";

import { apiFetch } from "../../../lib/api";
import { formatUserDateTime } from "../../../lib/date";
import { useTeamId } from "../../../lib/platform-context";
import { PageRouteGate } from "../../../components/navigation/PageRouteGate";

type Channel = "SMS" | "WHATSAPP" | "EMAIL" | "SYSTEM";
type Status =
  | "QUEUED"
  | "SENT"
  | "DELIVERED"
  | "FAILED"
  | "UNDELIVERED"
  | "RETRY_SCHEDULED"
  | "CANCELLED"
  | "RECEIVED";
type Purpose =
  | "OTP"
  | "EVIDENCE_REQUEST"
  | "INTAKE_LINK"
  | "REVIEW_ESCALATION"
  | "REVIEW_REMINDER"
  | "CONTRIBUTOR_CLARIFICATION"
  | "COLLABORATION_MENTION"
  | "GOVERNANCE_ALERT"
  | "SECURITY_ALERT"
  | "PREFERENCE_UPDATE";

type Message = {
  id: string;
  channel: Channel;
  direction: "OUTBOUND" | "INBOUND";
  purpose: Purpose;
  status: Status;
  provider: string;
  recipientPreview: string;
  bodyPreview: string | null;
  attemptCount: number;
  nextAttemptAtUtc: string | null;
  errorCode: string | null;
  relatedEvidenceRequestId: string | null;
  relatedIntakeSessionId: string | null;
  relatedDiscussionThreadId: string | null;
  createdAt: string;
  sentAtUtc: string | null;
  deliveredAtUtc: string | null;
  failedAtUtc: string | null;
};

type ProviderHealth = {
  communicationsEnabled: boolean;
  provider: "TWILIO" | "NOOP";
  configured: boolean;
  unconfiguredReason: string | null;
  capabilities: { sms: boolean; whatsapp: boolean; verify: boolean };
};

const CHANNELS: Channel[] = ["SMS", "WHATSAPP", "EMAIL", "SYSTEM"];
const STATUSES: Status[] = [
  "QUEUED",
  "SENT",
  "DELIVERED",
  "FAILED",
  "UNDELIVERED",
  "RETRY_SCHEDULED",
  "CANCELLED",
  "RECEIVED",
];
const PURPOSES: Purpose[] = [
  "OTP",
  "EVIDENCE_REQUEST",
  "INTAKE_LINK",
  "REVIEW_ESCALATION",
  "REVIEW_REMINDER",
  "CONTRIBUTOR_CLARIFICATION",
  "COLLABORATION_MENTION",
  "GOVERNANCE_ALERT",
  "SECURITY_ALERT",
  "PREFERENCE_UPDATE",
];

// Phase 38.12 — wrap in canonical PageRouteGate.
export default function CommunicationsPage() {
  return (
    <PageRouteGate routeId="workspace.communications">
      <CommunicationsPageInner />
    </PageRouteGate>
  );
}

function CommunicationsPageInner() {
  const teamId = useTeamId();
  const [health, setHealth] = useState<ProviderHealth | null>(null);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [channel, setChannel] = useState<Channel | "">("");
  const [purpose, setPurpose] = useState<Purpose | "">("");
  const [status, setStatus] = useState<Status | "">("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  
  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    Promise.all([
      apiFetch(
        `/v1/communications/health?teamId=${encodeURIComponent(teamId)}`,
        { method: "GET" },
      ),
      loadMessages(teamId, channel, purpose, status),
    ])
      .then(([h, m]: [{ health: ProviderHealth }, { messages: Message[] }]) => {
        if (cancelled) return;
        setHealth(h.health);
        setMessages(m.messages ?? []);
        setError(null);
      })
      .catch((err: { message?: string }) => {
        if (cancelled) return;
        setError(toSafeUserError(err, { message: "Could not load communications data." }).message);
      });
    return () => {
      cancelled = true;
    };
  }, [teamId, channel, purpose, status]);

  async function refreshMessages() {
    if (!teamId) return;
    const m = await loadMessages(teamId, channel, purpose, status);
    setMessages(m.messages ?? []);
  }

  async function cancelRetry(id: string) {
    if (!teamId) return;
    setBusy(true);
    try {
      await apiFetch(`/v1/communications/messages/${id}/cancel-retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId }),
      });
      await refreshMessages();
    } catch (err) {
      alert(toSafeUserError(err, { message: "Action failed." }).message);
    } finally {
      setBusy(false);
    }
  }

  async function retryNow(id: string) {
    if (!teamId) return;
    setBusy(true);
    try {
      await apiFetch(`/v1/communications/messages/${id}/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId }),
      });
      await refreshMessages();
    } catch (err) {
      alert(toSafeUserError(err, { message: "Action failed." }).message);
    } finally {
      setBusy(false);
    }
  }

  const counts = useMemo(() => {
    if (!messages) return null;
    return {
      total: messages.length,
      failed: messages.filter((m) => m.status === "FAILED").length,
      retryScheduled: messages.filter((m) => m.status === "RETRY_SCHEDULED")
        .length,
      delivered: messages.filter((m) => m.status === "DELIVERED").length,
      cancelled: messages.filter((m) => m.status === "CANCELLED").length,
    };
  }, [messages]);

  return (
    <main style={pageStyle}>
      <header>
        <h1 style={titleStyle}>Communications</h1>
        <p style={mutedStyle}>
          Workspace-internal operations view for SMS, WhatsApp, and
          Twilio Verify activity. Delivery state is reported by the
          provider via webhook; the platform never asserts authenticity
          or admissibility about outbound messages.
        </p>
      </header>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      {!teamId ? (
        <p style={mutedStyle}>Switch to a workspace to use communications.</p>
      ) : (
        <>
          <section style={cardStyle}>
            <h2 style={sectionTitleStyle}>Provider health</h2>
            {!health ? (
              <p style={mutedStyle}>Loading…</p>
            ) : (
              <div style={healthGridStyle}>
                <Stat
                  label="Feature flag"
                  value={health.communicationsEnabled ? "enabled" : "disabled"}
                />
                <Stat label="Provider" value={health.provider} />
                <Stat
                  label="Configured"
                  value={health.configured ? "yes" : "no"}
                />
                <Stat label="SMS" value={health.capabilities.sms ? "ready" : "—"} />
                <Stat
                  label="WhatsApp"
                  value={health.capabilities.whatsapp ? "ready" : "—"}
                />
                <Stat
                  label="Verify (OTP)"
                  value={health.capabilities.verify ? "ready" : "—"}
                />
              </div>
            )}
            {health && !health.configured ? (
              <p style={warnBoxStyle}>
                Provider unconfigured: {health.unconfiguredReason ?? "unknown"}.
                Outbound sends will be cancelled and audited until the
                provider is configured.
              </p>
            ) : null}
          </section>

          <section style={cardStyle}>
            <div style={cardHeaderStyle}>
              <h2 style={sectionTitleStyle}>Messages</h2>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <select
                  value={channel}
                  onChange={(e) => setChannel(e.target.value as Channel | "")}
                  style={selectStyle}
                >
                  <option value="">All channels</option>
                  {CHANNELS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <select
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value as Purpose | "")}
                  style={selectStyle}
                >
                  <option value="">All purposes</option>
                  {PURPOSES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as Status | "")}
                  style={selectStyle}
                >
                  <option value="">All statuses</option>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {counts ? (
              <div style={summaryRowStyle}>
                <small style={mutedStyle}>
                  {counts.total} total · {counts.delivered} delivered ·{" "}
                  {counts.retryScheduled} retry scheduled · {counts.failed}{" "}
                  failed · {counts.cancelled} cancelled
                </small>
              </div>
            ) : null}
            {messages === null ? (
              <p style={mutedStyle}>Loading…</p>
            ) : messages.length === 0 ? (
              <p style={mutedStyle}>No messages match the current filters.</p>
            ) : (
              <ul style={listStyle}>
                {messages.map((m) => (
                  <li key={m.id} style={rowStyle}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>
                        {m.purpose}{" "}
                        <span style={chipStyle}>{m.channel}</span>{" "}
                        <span style={chipStyle}>{m.direction}</span>
                      </div>
                      <div style={mutedStyle}>
                        to {m.recipientPreview} · {m.attemptCount} attempt
                        {m.attemptCount === 1 ? "" : "s"}
                        {m.errorCode ? ` · err ${m.errorCode}` : ""}
                        {m.nextAttemptAtUtc
                          ? ` · next ${formatUserDateTime(m.nextAttemptAtUtc)}`
                          : ""}
                      </div>
                      {m.bodyPreview ? (
                        <div style={previewStyle}>{m.bodyPreview}</div>
                      ) : null}
                    </div>
                    <span style={statusBadgeStyle(m.status)}>{m.status}</span>
                    {m.status === "RETRY_SCHEDULED" ? (
                      <button
                        type="button"
                        style={secondaryButtonStyle}
                        disabled={busy}
                        onClick={() => void cancelRetry(m.id)}
                      >
                        Cancel retry
                      </button>
                    ) : null}
                    {m.status === "FAILED" ? (
                      <button
                        type="button"
                        style={primaryButtonStyle}
                        disabled={busy}
                        onClick={() => void retryNow(m.id)}
                      >
                        Retry
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}

function loadMessages(
  teamId: string,
  channel: Channel | "",
  purpose: Purpose | "",
  status: Status | "",
): Promise<{ messages: Message[] }> {
  const qs = new URLSearchParams();
  qs.set("teamId", teamId);
  if (channel) qs.set("channel", channel);
  if (purpose) qs.set("purpose", purpose);
  if (status) qs.set("status", status);
  qs.set("limit", "200");
  return apiFetch(`/v1/communications/messages?${qs.toString()}`, {
    method: "GET",
  }) as Promise<{ messages: Message[] }>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={statStyle}>
      <div style={{ fontSize: 18, fontWeight: 700, color: "#0f172a" }}>
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
  maxWidth: 1040,
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
const summaryRowStyle: React.CSSProperties = {
  marginBottom: 12,
};
const healthGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
  gap: 12,
  marginBottom: 12,
};
const statStyle: React.CSSProperties = {
  padding: 10,
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
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
  padding: "10px 8px",
  borderBottom: "1px solid #e2e8f0",
};
const chipStyle: React.CSSProperties = {
  padding: "2px 6px",
  fontSize: 10,
  fontWeight: 600,
  borderRadius: 999,
  background: "#eff6ff",
  color: "#1e40af",
  border: "1px solid #93c5fd",
  marginLeft: 6,
};
const previewStyle: React.CSSProperties = {
  marginTop: 4,
  fontSize: 12,
  color: "#475569",
  background: "#f8fafc",
  padding: "6px 8px",
  borderRadius: 6,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
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
const warnBoxStyle: React.CSSProperties = {
  marginTop: 8,
  padding: 12,
  background: "#fffbeb",
  color: "#92400e",
  border: "1px solid #fcd34d",
  borderRadius: 8,
  fontSize: 13,
};
const selectStyle: React.CSSProperties = {
  padding: "6px 10px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 13,
  background: "#fff",
  color: "#0f172a",
};
const primaryButtonStyle: React.CSSProperties = {
  padding: "6px 14px",
  fontWeight: 600,
  color: "#fff",
  background: "#0f172a",
  border: 0,
  borderRadius: 8,
  cursor: "pointer",
  fontSize: 12,
};
const secondaryButtonStyle: React.CSSProperties = {
  padding: "4px 10px",
  fontWeight: 500,
  color: "#0f172a",
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
};

function statusBadgeStyle(status: Status): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: "4px 10px",
    fontSize: 12,
    fontWeight: 600,
    borderRadius: 999,
    border: "1px solid",
    whiteSpace: "nowrap",
  };
  if (status === "DELIVERED" || status === "SENT" || status === "RECEIVED") {
    return {
      ...base,
      background: "#f0fdf4",
      borderColor: "#86efac",
      color: "#166534",
    };
  }
  if (status === "QUEUED" || status === "RETRY_SCHEDULED") {
    return {
      ...base,
      background: "#fffbeb",
      borderColor: "#fcd34d",
      color: "#92400e",
    };
  }
  if (status === "FAILED" || status === "UNDELIVERED") {
    return {
      ...base,
      background: "#fef2f2",
      borderColor: "#fecaca",
      color: "#7f1d1d",
    };
  }
  return {
    ...base,
    background: "#f1f5f9",
    borderColor: "#cbd5e1",
    color: "#475569",
  };
}
