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

import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import Link from "next/link";
import { useEffect, useState } from "react";

import { apiFetch } from "../../../../lib/api";
import { formatUserDateTime } from "../../../../lib/date";
import { useTeamId } from "../../../../lib/platform-context";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { PageShell, PageHeader, PageSection } from "../../../../components/ui/PageShell";
import { Button } from "../../../../components/ui/Button";
import { Badge } from "../../../../components/ui/Badge";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { FilterBar } from "../../../../components/ui/FilterBar";
import { DataTable, type DataTableColumn } from "../../../../components/ui/DataTable";

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

// Phase 38.11 — wrap in canonical PageRouteGate.
export default function GovernanceNotificationsPage() {
  return (
    <PageRouteGate routeId="governance.notifications">
      <GovernanceNotificationsPageInner />
    </PageRouteGate>
  );
}

function GovernanceNotificationsPageInner() {
  const teamId = useTeamId();
  const [notifications, setNotifications] = useState<Notification[] | null>(null);
  const [counts, setCounts] = useState<{ pending: number; failed: number } | null>(null);
  const [filter, setFilter] = useState<"unacknowledged" | "all">("unacknowledged");
  const [severityFilter, setSeverityFilter] = useState<Severity | "ALL">("ALL");
  const [error, setError] = useState<string | null>(null);

  
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
        setError(toSafeUserError(err, { message: "Unable to load notifications." }).message);
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
      alert(toSafeUserError(e, { message: "Could not acknowledge notification." }).message);
    }
  }

  const columns: DataTableColumn<Notification>[] = [
    {
      key: "severity",
      header: "Severity",
      render: (n) => (
        <span style={severityBadgeStyle(n.severity)}>{n.severity}</span>
      ),
    },
    {
      key: "kind",
      header: "Kind",
      render: (n) => <code style={codeStyle}>{n.kind}</code>,
    },
    {
      key: "summary",
      header: "Summary",
      render: (n) => (
        <div>
          <div style={{ fontWeight: 600 }}>{n.title}</div>
          <div style={mutedStyle}>{n.summary}</div>
        </div>
      ),
    },
    {
      key: "occurrences",
      header: "Occurrences",
      align: "right",
      render: (n) => n.occurrenceCount.toLocaleString(),
    },
    {
      key: "delivery",
      header: "Delivery",
      render: (n) => (
        <div>
          <span style={deliveryBadgeStyle(n.deliveryStatus)}>
            {n.deliveryStatus}
          </span>
          {n.deliveryAttempts > 0 ? (
            <div style={mutedStyle}>
              {n.deliveryAttempts} attempt
              {n.deliveryAttempts === 1 ? "" : "s"}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: "lastSeen",
      header: "Last seen",
      nowrap: true,
      render: (n) => formatUserDateTime(n.lastSeenAtUtc),
    },
  ];

  return (
    <PageShell
      header={
        <PageHeader
          eyebrow="Governance"
          title="Governance notifications"
          subtitle="Deduped operator alerts for governance events. Same-key emissions collapse into a single row with a live occurrence count."
          contextStrip={
            counts ? (
              <>
                <Badge tone="neutral">Pending {counts.pending}</Badge>
                <Badge tone={counts.failed > 0 ? "risk" : "neutral"}>
                  Failed delivery {counts.failed}
                </Badge>
              </>
            ) : null
          }
        />
      }
    >
      <nav style={navStyle}>
        <Link href="/governance/lifecycle" style={navLinkStyle}>
          ← Governance operations
        </Link>
        <Link href="/governance/analytics" style={navLinkStyle}>
          Analytics →
        </Link>
      </nav>

      <PageSection
        title="Notifications"
        action={
          <FilterBar>
            <FilterBar.Select
              label="View"
              showLabel
              value={filter}
              onChange={(v) => setFilter(v as "unacknowledged" | "all")}
              options={[
                { value: "unacknowledged", label: "Unacknowledged" },
                { value: "all", label: "All" },
              ]}
            />
            <FilterBar.Select
              label="Severity"
              showLabel
              value={severityFilter}
              onChange={(v) => setSeverityFilter(v as Severity | "ALL")}
              options={[
                { value: "ALL", label: "All" },
                { value: "CRITICAL", label: "Critical" },
                { value: "HIGH", label: "High" },
                { value: "WARNING", label: "Warning" },
                { value: "INFO", label: "Info" },
              ]}
            />
          </FilterBar>
        }
      >
        {error ? <div style={errorBoxStyle}>{error}</div> : null}

        {!teamId ? (
          <EmptyState
            framed
            title="No workspace selected"
            purpose="Switch to an organization workspace to view its governance notifications."
          />
        ) : (
          <DataTable
            ariaLabel="Governance notifications"
            columns={columns}
            rows={notifications ?? []}
            getRowId={(n) => n.id}
            loading={!notifications}
            rowActions={(n) =>
              n.acknowledgedAtUtc ? (
                <Badge tone="verified">Acknowledged</Badge>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => acknowledge(n)}
                >
                  Acknowledge
                </Button>
              )
            }
            emptyState={
              <EmptyState
                title="No notifications"
                purpose="No notifications match the current filter. Deduped governance alerts will appear here as events occur."
              />
            }
          />
        )}
      </PageSection>
    </PageShell>
  );
}

// -----------------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------------

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
const codeStyle: React.CSSProperties = {
  fontFamily:
    "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  fontSize: 11,
  color: "#475569",
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
