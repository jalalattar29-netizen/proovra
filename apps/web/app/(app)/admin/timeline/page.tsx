"use client";

/**
 * PROOVRA Platform Admin (item J) — Global PLATFORM Timeline console.
 *
 * READ-ONLY platform-admin surface. Renders a single merged, chronological
 * DataTable across the platform-operational sources (admin audit, org audit,
 * security events, operational incidents, selected billing/team analytics),
 * with source / severity / organization filters.
 *
 * SEPARATION: this is the PLATFORM operational timeline. It is DELIBERATELY
 * separate from evidence custody timelines — it never shows Evidence custody
 * chains. That separation is called out in the page copy below.
 *
 * The page inherits the `platform.admin` gate from admin/layout.tsx AND wraps
 * itself in an explicit <PageRouteGate routeId="platform.admin"> (belt-and-
 * braces, mirroring admin/provisioning). Errors surface via toSafeUserError.
 */

import { useCallback, useEffect, useState } from "react";

import {
  PageShell,
  PageHeader,
  PageSection,
  DataTable,
  FilterBar,
} from "../../../../components/ui";
import type { DataTableColumn } from "../../../../components/ui";
import { Badge } from "../../../../components/ui/Badge";
import type { BadgeTone } from "../../../../components/ui/Badge";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { Button } from "../../../../components/ui/Button";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { apiFetch } from "../../../../lib/api";
import { useToast } from "../../../../components/ui";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { formatUserDateTime } from "../../../../lib/date";

type TimelineSeverity = "critical" | "high" | "medium" | "low";

type TimelineSource =
  | "admin_audit"
  | "organization_audit"
  | "security_event"
  | "operational_incident"
  | "analytics_event";

type TimelineEntry = {
  at: string;
  source: TimelineSource;
  actor: string | null;
  eventType: string;
  severity: TimelineSeverity;
  organizationId: string | null;
  targetLabel: string | null;
  href: string | null;
};

type TimelineResponse = {
  items: TimelineEntry[];
  nextCursor: string | null;
};

const INK_MUTED = "var(--ink-muted, #94a3b8)";

const SOURCE_OPTIONS = [
  { value: "all", label: "All sources" },
  { value: "admin_audit", label: "Admin audit" },
  { value: "organization_audit", label: "Organization audit" },
  { value: "security_event", label: "Security event" },
  { value: "operational_incident", label: "Operational incident" },
  { value: "analytics_event", label: "Billing / team event" },
];

const SEVERITY_OPTIONS = [
  { value: "all", label: "All severities" },
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

const SOURCE_LABELS: Record<TimelineSource, string> = {
  admin_audit: "Admin audit",
  organization_audit: "Organization audit",
  security_event: "Security event",
  operational_incident: "Operational incident",
  analytics_event: "Billing / team event",
};

function severityTone(sev: string): BadgeTone {
  const v = sev.toLowerCase();
  if (v === "critical" || v === "high") return "risk";
  if (v === "medium") return "pending";
  return "info";
}

function formatTimestamp(value: string) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return formatUserDateTime(value);
}

function dash(value: string | null | undefined) {
  return value && value.trim() ? value : "—";
}

export default function AdminTimelinePage() {
  const { addToast } = useToast();
  const [items, setItems] = useState<TimelineEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [sourceFilter, setSourceFilter] = useState("all");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [orgFilter, setOrgFilter] = useState("");

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      params.set("limit", "50");
      if (sourceFilter !== "all") params.set("source", sourceFilter);
      if (severityFilter !== "all") params.set("severity", severityFilter);
      if (orgFilter.trim()) params.set("organizationId", orgFilter.trim());

      const data: TimelineResponse = await apiFetch(
        `/v1/admin/timeline?${params.toString()}`,
      );
      setItems(Array.isArray(data?.items) ? data.items : []);
    } catch (err) {
      const message = toSafeUserError(err, {
        message: "We couldn't load the platform timeline.",
      }).message;
      addToast(message, "error");
    } finally {
      setLoading(false);
    }
  }, [addToast, sourceFilter, severityFilter, orgFilter]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceFilter, severityFilter]);

  const columns: DataTableColumn<TimelineEntry>[] = [
    {
      key: "eventType",
      header: "Event",
      render: (r) => (
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, overflowWrap: "anywhere" }}>
            {r.eventType}
          </div>
          <div style={{ fontSize: 11, color: INK_MUTED, overflowWrap: "anywhere" }}>
            {SOURCE_LABELS[r.source] ?? r.source}
            {r.targetLabel ? ` · ${r.targetLabel}` : ""}
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
      key: "actor",
      header: "Actor",
      render: (r) => (
        <span style={{ fontSize: 12, color: INK_MUTED, overflowWrap: "anywhere" }}>
          {dash(r.actor)}
        </span>
      ),
    },
    {
      key: "organizationId",
      header: "Organization",
      render: (r) => (
        <span style={{ fontSize: 12, color: INK_MUTED, overflowWrap: "anywhere" }}>
          {dash(r.organizationId)}
        </span>
      ),
    },
    {
      key: "at",
      header: "When",
      nowrap: true,
      render: (r) => (
        <span style={{ fontSize: 12, color: INK_MUTED }}>
          {formatTimestamp(r.at)}
        </span>
      ),
    },
  ];

  return (
    <PageRouteGate routeId="platform.timeline">
      <PageShell width="full" data-testid="admin-timeline">
        <PageHeader
          eyebrow="Platform admin"
          title="Global timeline"
          subtitle="A single, read-only chronological feed of platform-operational events — admin audit actions, organization lifecycle, security events, operational incidents, and selected billing / team events. Aggregated live across every workspace. No secrets, tokens, or raw IP addresses are surfaced."
          secondaryActions={
            <Button variant="secondary" onClick={() => void load()}>
              Refresh
            </Button>
          }
        />


        <PageSection
          title="This is the PLATFORM timeline — not evidence custody"
          description="This feed covers platform operations only. It is deliberately kept SEPARATE from evidence custody timelines: it never reads or displays per-item evidence custody chains, verification ledgers, or chain-of-custody events. For evidence custody, use the evidence detail surfaces."
        >
          <FilterBar
            actions={
              <Button variant="secondary" onClick={() => void load()}>
                Apply
              </Button>
            }
            style={{ marginBottom: 12 }}
          >
            <FilterBar.Select
              label="Source"
              value={sourceFilter}
              onChange={setSourceFilter}
              options={SOURCE_OPTIONS}
            />
            <FilterBar.Select
              label="Severity"
              value={severityFilter}
              onChange={setSeverityFilter}
              options={SEVERITY_OPTIONS}
            />
            <FilterBar.Search
              label="Organization ID"
              placeholder="Filter by organization ID"
              value={orgFilter}
              onChange={setOrgFilter}
            />
          </FilterBar>

          <DataTable
            columns={columns}
            rows={items}
            getRowId={(r, index) => `${r.source}:${r.at}:${index}`}
            loading={loading}
            ariaLabel="Platform operational timeline"
            emptyState={
              <EmptyState
                framed
                title="No platform events"
                purpose="No platform-operational events match the current filters. As admin actions, organization lifecycle events, security events, incidents, or billing/team events are recorded, they appear here — evidence custody events are never included."
                data-testid="admin-timeline-empty"
              />
            }
          />
        </PageSection>
      </PageShell>
    </PageRouteGate>
  );
}
