"use client";

/**
 * Phase 27.5 — Governance notifications surface.
 *
 * Operator-facing notification queue. Lists every workspace governance
 * notification with severity, dedupe-key (collapsed by the engine),
 * delivery status, occurrence count, and an acknowledge action.
 *
 * Privileged legal text is NEVER displayed here. The notification
 * service redacts known-sensitive metadata keys before persistence;
 * this page simply renders the bounded-catalog payload.
 */

import Link from "next/link";
import { useEffect, useState } from "react";

import { apiFetch } from "../../../../lib/api";

type Severity = "INFO" | "WARNING" | "HIGH" | "CRITICAL";
type DeliveryStatus = "PENDING" | "SENT" | "SUPPRESSED" | "FAILED";

type Notification = {
  id: string;
  teamId: string;
  kind: string;
  severity: Severity;
  dedupeKey: string;
  title: string;
  summary: string;
  relatedEvidenceId: string | null;
  relatedReviewId: string | null;
  relatedHoldId: string | null;
  relatedPolicyId: string | null;
  relatedIncidentId: string | null;
  firstSeenAtUtc: string;
  lastSeenAtUtc: string;
  occurrenceCount: number;
  deliveryStatus: DeliveryStatus;
  deliveryAttempts: number;
  lastDeliveryAtUtc: string | null;
  channels: string[];
  acknowledgedAtUtc: string | null;
  acknowledgedByUserId: string | null;
};

export default function GovernanceNotificationsPage() {
  const [teamId, setTeamId] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<Notification[] | null>(null);
  const [counts, setCounts] = useState<{ pending: number; failed: number } | null>(null);
  const [filter, setFilter] = useState<"unacknowledged" | "all">("unacknowledged");
  const [severityFilter, setSeverityFilter] = useState<Severity | "ALL">("ALL");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/v1/users/me", { method: "GET" })
      .then((res: { user?: { currentWorkspaceId?: string | null } }) => {
        if (cancelled) return;
        setTeamId(res?.user?.currentWorkspaceId ?? null);
      })
      .catch(() => setTeamId(null));
    return () => {
      cancelled = true;
    };
  }, []);

  function refetch(currentTeamId: string) {
    const params = new URLSearchParams({
      teamId: currentTeamId,
      limit: "200",
    });
    if (filter === "unacknowledged") params.set("unacknowledged", "true");
    if (severityFilter !== "ALL") params.set("severity", severityFilter);
    return apiFetch(`/v1/governance/notifications?${params.toString()}`, {
      method: "GET",
    });
  }

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    refetch(teamId)
      .then(
        (res: {
          notifications: Notification[];
          counts: { pending: number; failed: number };
        }) => {
          if (cancelled) return;
          setNotifications(res.notifications);
          setCounts(res.counts);
          setError(null);
        },
      )
      .catch((err: { message?: string }) => {
        if (cancelled) return;
        setError(err?.message ?? "Unable to load notifications.");
      });
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, filter, severityFilter]);

  async function acknowledge(n: Notification) {
    if (!teamId) return;
    try {
      await apiFetch(`/v1/governance/notifications/${n.id}/acknowledge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teamId }),
      });
      const res: {
        notifications: Notification[];
        counts: { pending: number; failed: number };
      } = await refetch(teamId);
      setNotifications(res.notifications);
      setCounts(res.counts);
    } catch (err) {
      const e = err as { message?: string };
      alert(e?.message ?? "Could not acknowledge notification.");
    }
  }

  return (
    <main style={pageStyle}>
      <header>
        <h1 style={titleStyle}>Governance notifications</h1>
        <p style={mutedStyle}>
          Deduped operator alerts for governance events. Same-key emissions
          collapse into a single row with a live occurrence count.
        </p>
      </header>

      <nav style={navStyle}>
        <Link href="/governance/lifecycle" style={navLinkStyle}>
          ← Governance operations
        </Link>
        <Link href="/governance/analytics" style={navLinkStyle}>
          Analytics →
        </Link>
      </nav>

      {counts ? (
        <div style={countsStyle}>
          <span style={countChipStyle}>Pending {counts.pending}</span>
          <span style={countChipStyle}>Failed delivery {counts.failed}</span>
        </div>
      ) : null}

      <div style={toolbarStyle}>
        <label style={filterLabelStyle}>
          View
          <select
            style={selectStyle}
            value={filter}
            onChange={(e) =>
              setFilter(e.target.value as "unacknowledged" | "all")
            }
          >
            <option value="unacknowledged">Unacknowledged</option>
            <option value="all">All</option>
          </select>
        </label>
        <label style={filterLabelStyle}>
          Severity
          <select
            style={selectStyle}
            value={severityFilter}
            onChange={(e) =>
              setSeverityFilter(e.target.value as Severity | "ALL")
            }
          >
            <option value="ALL">All</option>
            <option value="CRITICAL">Critical</option>
            <option value="HIGH">High</option>
            <option value="WARNING">Warning</option>
            <option value="INFO">Info</option>
          </select>
        </label>
      </div>

      {error ? <div style={errorBoxStyle}>{error}</div> : null}

      {!teamId ? (
        <p style={mutedStyle}>Switch to a workspace to view notifications.</p>
      ) : !notifications ? (
        <p style={mutedStyle}>Loading notifications…</p>
      ) : notifications.length === 0 ? (
        <p style={mutedStyle}>No notifications match the current filter.</p>
      ) : (
        <section style={cardStyle}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Severity</th>
                <th style={thStyle}>Kind</th>
                <th style={thStyle}>Summary</th>
                <th style={thStyle}>Occurrences</th>
                <th style={thStyle}>Delivery</th>
                <th style={thStyle}>Last seen</th>
                <th style={thStyle}>Action</th>
              </tr>
            </thead>
            <tbody>
              {notifications.map((n) => (
                <tr key={n.id}>
                  <td style={tdStyle}>
                    <span style={severityBadgeStyle(n.severity)}>
                      {n.severity}
                    </span>
                  </td>
                  <td style={tdStyle}>
                    <code style={codeStyle}>{n.kind}</code>
                  </td>
                  <td style={tdStyle}>
                    <div style={{ fontWeight: 600 }}>{n.title}</div>
                    <div style={mutedStyle}>{n.summary}</div>
                  </td>
                  <td style={tdStyle}>
                    {n.occurrenceCount.toLocaleString()}
                  </td>
                  <td style={tdStyle}>
                    <span style={deliveryBadgeStyle(n.deliveryStatus)}>
                      {n.deliveryStatus}
                    </span>
                    {n.deliveryAttempts > 0 ? (
                      <div style={mutedStyle}>
                        {n.deliveryAttempts} attempt
                        {n.deliveryAttempts === 1 ? "" : "s"}
                      </div>
                    ) : null}
                  </td>
                  <td style={tdStyle}>
                    {new Date(n.lastSeenAtUtc).toLocaleString()}
                  </td>
                  <td style={tdStyle}>
                    {n.acknowledgedAtUtc ? (
                      <span style={ackBadgeStyle}>Acknowledged</span>
                    ) : (
                      <button
                        type="button"
                        style={ackButtonStyle}
                        onClick={() => acknowledge(n)}
                      >
                        Acknowledge
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}

// -----------------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------------

const pageStyle: React.CSSProperties = {
  maxWidth: 1200,
  margin: "0 auto",
  padding: "32px 24px",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  color: "#0f172a",
};
const titleStyle: React.CSSProperties = {
  fontSize: 26,
  fontWeight: 700,
  marginBottom: 4,
  letterSpacing: -0.4,
};
const mutedStyle: React.CSSProperties = { fontSize: 12, color: "#64748b" };
const navStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 16,
  marginTop: 12,
  fontSize: 13,
};
const navLinkStyle: React.CSSProperties = {
  color: "#4338ca",
  fontWeight: 600,
  textDecoration: "none",
};
const countsStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  marginTop: 12,
};
const countChipStyle: React.CSSProperties = {
  padding: "4px 12px",
  fontSize: 12,
  fontWeight: 600,
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  color: "#334155",
  borderRadius: 999,
};
const toolbarStyle: React.CSSProperties = {
  display: "flex",
  gap: 12,
  marginTop: 12,
  marginBottom: 8,
};
const filterLabelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 12,
  color: "#475569",
};
const selectStyle: React.CSSProperties = {
  padding: "8px 12px",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  fontSize: 14,
  fontFamily: "inherit",
  color: "#0f172a",
  background: "#fff",
};
const cardStyle: React.CSSProperties = {
  marginTop: 16,
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  background: "#fff",
  overflow: "hidden",
};
const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13,
};
const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "12px 16px",
  background: "#f8fafc",
  borderBottom: "1px solid #e2e8f0",
  fontWeight: 600,
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  color: "#475569",
};
const tdStyle: React.CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid #f1f5f9",
  verticalAlign: "top",
};
const codeStyle: React.CSSProperties = {
  fontFamily:
    "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  fontSize: 11,
  color: "#475569",
};
const ackButtonStyle: React.CSSProperties = {
  padding: "5px 10px",
  fontWeight: 500,
  color: "#0f172a",
  background: "#f1f5f9",
  border: "1px solid #cbd5e1",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
};
const ackBadgeStyle: React.CSSProperties = {
  padding: "3px 10px",
  fontSize: 11,
  fontWeight: 600,
  background: "#ecfdf5",
  border: "1px solid #bbf7d0",
  color: "#166534",
  borderRadius: 999,
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

function severityBadgeStyle(severity: Severity): React.CSSProperties {
  const palette: Record<Severity, [string, string, string]> = {
    INFO: ["#eff6ff", "#bfdbfe", "#1e40af"],
    WARNING: ["#fffbeb", "#fcd34d", "#92400e"],
    HIGH: ["#fff7ed", "#fed7aa", "#9a3412"],
    CRITICAL: ["#fef2f2", "#fca5a5", "#991b1b"],
  };
  const [bg, border, color] = palette[severity];
  return {
    padding: "3px 10px",
    fontSize: 11,
    fontWeight: 600,
    background: bg,
    border: `1px solid ${border}`,
    color,
    borderRadius: 999,
    display: "inline-block",
  };
}

function deliveryBadgeStyle(status: DeliveryStatus): React.CSSProperties {
  const palette: Record<DeliveryStatus, [string, string, string]> = {
    PENDING: ["#eff6ff", "#bfdbfe", "#1e40af"],
    SENT: ["#ecfdf5", "#bbf7d0", "#166534"],
    SUPPRESSED: ["#f8fafc", "#e2e8f0", "#475569"],
    FAILED: ["#fef2f2", "#fca5a5", "#991b1b"],
  };
  const [bg, border, color] = palette[status];
  return {
    padding: "3px 10px",
    fontSize: 11,
    fontWeight: 600,
    background: bg,
    border: `1px solid ${border}`,
    color,
    borderRadius: 999,
    display: "inline-block",
  };
}
