"use client";

/**
 * Platform Control Center P1 — Platform Security & Incidents console.
 *
 * READ-ONLY platform-wide security surface. Renders:
 *   - severity-breakdown metric Cards (REAL counts from the aggregate),
 *   - a filterable (type / severity) security-events DataTable
 *     (SecurityEvent + AdminAuditLog unified feed),
 *   - a platform-wide OperationalIncident DataTable with unresolved rows
 *     highlighted, plus severity + unresolved KPIs,
 *   - honest EmptyState / "Not connected" states when data is absent.
 *
 * The page inherits the `platform.admin` gate from app/(app)/admin/layout.tsx.
 * Errors surface via `toSafeUserError` (the only sanctioned display path).
 */

import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useCallback, useEffect, useMemo, useState } from "react";

import { PageShell, PageHeader, PageSection, DataTable, FilterBar } from "../../../../components/ui";
import type { DataTableColumn } from "../../../../components/ui";
import { Card } from "../../../../components/ui/Card";
import { Badge } from "../../../../components/ui/Badge";
import type { BadgeTone } from "../../../../components/ui/Badge";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { Button } from "../../../../components/ui/Button";
import { apiFetch } from "../../../../lib/api";
import { useToast } from "../../../../components/ui";
import AdminConsoleNav from "../../../../components/admin/AdminConsoleNav";
import { formatUserDateTime } from "../../../../lib/date";

type SeverityBucket = "CRITICAL" | "HIGH" | "WARNING" | "INFO";

type SecurityEventRow = {
  id: string;
  origin: "SECURITY_EVENT" | "ADMIN_AUDIT";
  eventType: string;
  severity: SeverityBucket;
  outcome: string | null;
  category: string | null;
  source: string | null;
  resourceType: string | null;
  teamId: string | null;
  userId: string | null;
  createdAt: string;
};

type SecurityEventsResponse = {
  items: SecurityEventRow[];
  severityBreakdown: Record<SeverityBucket, number>;
  totalEvents: number;
};

type IncidentRow = {
  id: string;
  category: string;
  severity: string;
  status: string;
  title: string;
  safeSummary: string;
  occurrenceCount: number;
  firstSeenAtUtc: string;
  lastSeenAtUtc: string;
};

type IncidentsResponse = {
  items: IncidentRow[];
  severityBreakdown: Record<string, number>;
  statusBreakdown: Record<string, number>;
  unresolvedCount: number;
  totalIncidents: number;
};

const INK_MUTED = "var(--ink-muted, #94a3b8)";

const SEVERITY_OPTIONS = [
  { value: "all", label: "All severities" },
  { value: "CRITICAL", label: "Critical" },
  { value: "HIGH", label: "High" },
  { value: "WARNING", label: "Warning" },
  { value: "INFO", label: "Info" },
];

function severityTone(sev: string): BadgeTone {
  const v = sev.toUpperCase();
  if (v === "CRITICAL" || v === "HIGH") return "risk";
  if (v === "WARNING" || v === "MEDIUM") return "pending";
  return "info";
}

function statusTone(status: string): BadgeTone {
  const v = status.toUpperCase();
  if (v === "OPEN") return "risk";
  if (v === "ACKNOWLEDGED") return "pending";
  if (v === "RESOLVED") return "verified";
  return "neutral";
}

function isUnresolved(status: string): boolean {
  const v = status.toUpperCase();
  return v === "OPEN" || v === "ACKNOWLEDGED";
}

function formatTimestamp(value: string) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return formatUserDateTime(value);
}

function SeverityTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | null;
  tone: BadgeTone;
}) {
  const measured = value != null;
  return (
    <Card padding="comfortable" style={{ minWidth: 0 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: INK_MUTED,
        }}
      >
        {label}
      </div>
      <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{
            fontSize: 30,
            fontWeight: 750,
            letterSpacing: "-0.02em",
            color: measured ? "var(--ink-primary, #0f172a)" : INK_MUTED,
          }}
        >
          {measured ? new Intl.NumberFormat().format(value) : "—"}
        </span>
        <Badge tone={tone} dot>
          {label}
        </Badge>
      </div>
      {!measured ? (
        <div style={{ marginTop: 8, fontSize: 12.5, color: INK_MUTED }}>
          Not measured — this signal is not in the security aggregate.
        </div>
      ) : null}
    </Card>
  );
}

export default function AdminSecurityPage() {
  const { addToast } = useToast();
  const [events, setEvents] = useState<SecurityEventsResponse | null>(null);
  const [incidents, setIncidents] = useState<IncidentsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState("");
  const [severityFilter, setSeverityFilter] = useState("all");

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      params.set("limit", "50");
      if (typeFilter.trim()) params.set("eventType", typeFilter.trim());
      if (severityFilter !== "all") params.set("severity", severityFilter);

      const [eventsData, incidentsData] = await Promise.all([
        apiFetch(`/v1/admin/security-events?${params.toString()}`),
        apiFetch(`/v1/admin/incidents?limit=100`),
      ]);
      setEvents(eventsData ?? null);
      setIncidents(incidentsData ?? null);
    } catch (err) {
      const message = toSafeUserError(err, {
        message: "We couldn't load the platform security aggregate.",
      }).message;
      addToast(message, "error");
    } finally {
      setLoading(false);
    }
  }, [addToast, typeFilter, severityFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const severityTiles = useMemo(() => {
    const b = events?.severityBreakdown ?? null;
    return [
      { label: "Critical", key: "CRITICAL" as SeverityBucket, tone: "risk" as BadgeTone },
      { label: "High", key: "HIGH" as SeverityBucket, tone: "risk" as BadgeTone },
      { label: "Warning", key: "WARNING" as SeverityBucket, tone: "pending" as BadgeTone },
      { label: "Info", key: "INFO" as SeverityBucket, tone: "info" as BadgeTone },
    ].map((t) => ({
      ...t,
      value: b ? b[t.key] ?? 0 : null,
    }));
  }, [events]);

  const eventColumns: DataTableColumn<SecurityEventRow>[] = [
    {
      key: "eventType",
      header: "Event",
      render: (r) => (
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{r.eventType}</div>
          <div style={{ fontSize: 11, color: INK_MUTED }}>
            {r.origin === "ADMIN_AUDIT" ? "Admin audit" : "Security event"}
            {r.category ? ` · ${r.category}` : ""}
          </div>
        </div>
      ),
    },
    {
      key: "severity",
      header: "Severity",
      render: (r) => <Badge tone={severityTone(r.severity)}>{r.severity}</Badge>,
    },
    {
      key: "outcome",
      header: "Outcome",
      render: (r) => (
        <span style={{ fontSize: 12, color: "var(--ink-secondary, #475569)" }}>
          {r.outcome ?? "—"}
        </span>
      ),
    },
    {
      key: "source",
      header: "Source",
      render: (r) => (
        <span style={{ fontSize: 12, color: INK_MUTED }}>{r.source ?? "—"}</span>
      ),
    },
    {
      key: "createdAt",
      header: "When",
      nowrap: true,
      render: (r) => (
        <span style={{ fontSize: 12, color: INK_MUTED }}>
          {formatTimestamp(r.createdAt)}
        </span>
      ),
    },
  ];

  const incidentColumns: DataTableColumn<IncidentRow>[] = [
    {
      key: "title",
      header: "Incident",
      render: (r) => (
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{r.title}</div>
          <div style={{ fontSize: 11, color: INK_MUTED, overflowWrap: "anywhere" }}>
            {r.safeSummary}
          </div>
        </div>
      ),
    },
    {
      key: "category",
      header: "Category",
      render: (r) => (
        <span style={{ fontSize: 12, color: "var(--ink-secondary, #475569)" }}>
          {r.category}
        </span>
      ),
    },
    {
      key: "severity",
      header: "Severity",
      render: (r) => <Badge tone={severityTone(r.severity)}>{r.severity}</Badge>,
    },
    {
      key: "status",
      header: "Status",
      render: (r) => (
        <Badge tone={statusTone(r.status)} dot={isUnresolved(r.status)}>
          {r.status}
        </Badge>
      ),
    },
    {
      key: "count",
      header: "Count",
      nowrap: true,
      render: (r) => (
        <span style={{ fontSize: 12, color: INK_MUTED }}>{r.occurrenceCount}</span>
      ),
    },
    {
      key: "lastSeen",
      header: "Last seen",
      nowrap: true,
      render: (r) => (
        <span style={{ fontSize: 12, color: INK_MUTED }}>
          {formatTimestamp(r.lastSeenAtUtc)}
        </span>
      ),
    },
  ];

  return (
    <PageShell width="full">
      <PageHeader
        eyebrow="Platform admin"
        title="Security & Incidents"
        subtitle="Platform-wide security events and operational incidents, aggregated read-only across every workspace. No secrets, credentials, or raw IP addresses are surfaced — every count is read live from the backend aggregate."
        secondaryActions={
          <Button variant="secondary" onClick={() => void load()}>
            Refresh
          </Button>
        }
      />

      <AdminConsoleNav />

      <PageSection
        title="Security event severity"
        description="Live severity breakdown across SecurityEvent + AdminAuditLog. Absent signals show “Not measured”, never estimated."
      >
        <div
          data-testid="admin-security-severity-grid"
          style={{
            display: "grid",
            gap: 16,
            gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          }}
        >
          {severityTiles.map((t) => (
            <SeverityTile key={t.key} label={t.label} value={t.value} tone={t.tone} />
          ))}
        </div>
      </PageSection>

      <PageSection
        title="Security events"
        description="Unified platform feed: suspicious logins, MFA / step-up / SSO / SCIM failures, permission-denied bursts, admin role changes, API-key changes, external-reviewer token actions."
      >
        <FilterBar
          actions={
            <Button variant="secondary" onClick={() => void load()}>
              Apply
            </Button>
          }
          style={{ marginBottom: 12 }}
        >
          <FilterBar.Search
            label="Filter by event type"
            placeholder="Filter by event type"
            value={typeFilter}
            onChange={setTypeFilter}
          />
          <FilterBar.Select
            label="Severity"
            value={severityFilter}
            onChange={setSeverityFilter}
            options={SEVERITY_OPTIONS}
          />
        </FilterBar>

        <DataTable
          columns={eventColumns}
          rows={events?.items ?? []}
          getRowId={(r) => r.id}
          loading={loading}
          ariaLabel="Platform security events"
          emptyState={
            <EmptyState
              title="No security events"
              purpose="No platform security events match the current filters. Once SecurityEvent or AdminAuditLog rows are recorded for this window, they appear here."
              data-testid="admin-security-events-empty"
            />
          }
        />
      </PageSection>

      <PageSection
        title="Operational incidents"
        description="Platform-wide OperationalIncident feed. Unresolved incidents (OPEN / ACKNOWLEDGED) are marked. Operator-safe fields only."
      >
        <div
          style={{
            display: "grid",
            gap: 16,
            gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
            marginBottom: 16,
          }}
        >
          <SeverityTile
            label="Unresolved"
            value={incidents ? incidents.unresolvedCount : null}
            tone="risk"
          />
          <SeverityTile
            label="Total incidents"
            value={incidents ? incidents.totalIncidents : null}
            tone="neutral"
          />
          <SeverityTile
            label="Critical"
            value={incidents ? incidents.severityBreakdown?.CRITICAL ?? 0 : null}
            tone="risk"
          />
          <SeverityTile
            label="High"
            value={incidents ? incidents.severityBreakdown?.HIGH ?? 0 : null}
            tone="risk"
          />
        </div>

        <DataTable
          columns={incidentColumns}
          rows={incidents?.items ?? []}
          getRowId={(r) => r.id}
          loading={loading}
          ariaLabel="Platform operational incidents"
          emptyState={
            <EmptyState
              framed
              title="No incidents recorded"
              purpose="No operational incidents were returned across the platform. The OperationalIncident table feeds this list — once incidents are opened they appear here with severity and unresolved status."
              data-testid="admin-security-incidents-empty"
            />
          }
        />
      </PageSection>
    </PageShell>
  );
}
