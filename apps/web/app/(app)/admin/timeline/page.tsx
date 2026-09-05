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
import { ResultCount } from "../../../../components/ui/ResultCount";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { apiFetch } from "../../../../lib/api";
import {
  presentActor,
  presentOutcome,
  presentTransition,
} from "../../../../lib/audit/auditPresentation";
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
  // PHASE 5 §6 — the identity contract, as the timeline API now returns it.
  actorType?: string | null;
  actorDisplay?: string | null;
  outcome?: string | null;
  previousState?: string | null;
  resultingState?: string | null;
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


/**
 * 25, not 50. The feed is an append-on-demand list, so a smaller first page
 * halves what a phone has to scroll before the operator can decide whether
 * to load older events — and the server cursor makes the rest reachable.
 */
const PAGE_SIZE = 25;

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
  /**
   * The cursor the API already returns and this page has been ignoring.
   *
   * `TimelineResponse` has declared `nextCursor` since it was written, and
   * nothing read it. The endpoint caps at 50 events, so the feed showed the
   * newest 50 of an unbounded stream with no count, no cursor and no
   * indication that anything older existed — a page that looks complete and is
   * not, which is worse than one that looks empty.
   */
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [sourceFilter, setSourceFilter] = useState("all");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [orgFilter, setOrgFilter] = useState("");
  /**
   * Rows whose long tail is open. The row itself is one line — event, source,
   * severity, actor, time — and the organization id, target and link sit
   * behind a per-row Details toggle rather than being printed on every row.
   */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggleExpanded = (key: string) =>
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));
      if (sourceFilter !== "all") params.set("source", sourceFilter);
      if (severityFilter !== "all") params.set("severity", severityFilter);
      if (orgFilter.trim()) params.set("organizationId", orgFilter.trim());

      const data: TimelineResponse = await apiFetch(
        `/v1/admin/timeline?${params.toString()}`,
      );
      setItems(Array.isArray(data?.items) ? data.items : []);
      setNextCursor(data?.nextCursor ?? null);
    } catch (err) {
      const message = toSafeUserError(err, {
        message: "We couldn't load the platform timeline.",
      }).message;
      addToast(message, "error");
    } finally {
      setLoading(false);
    }
  }, [addToast, sourceFilter, severityFilter, orgFilter]);

  /**
   * Append the next page. Deliberately APPEND rather than replace: this is a
   * chronological feed, and swapping the visible window under a reader who is
   * mid-scroll loses their place in an incident.
   */
  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    try {
      setLoadingMore(true);
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));
      params.set("cursor", nextCursor);
      if (sourceFilter !== "all") params.set("source", sourceFilter);
      if (severityFilter !== "all") params.set("severity", severityFilter);
      if (orgFilter.trim()) params.set("organizationId", orgFilter.trim());
      const data: TimelineResponse = await apiFetch(
        `/v1/admin/timeline?${params.toString()}`,
      );
      setItems((prev) => [...prev, ...(Array.isArray(data?.items) ? data.items : [])]);
      setNextCursor(data?.nextCursor ?? null);
    } catch (err) {
      addToast(
        toSafeUserError(err, {
          message: "We couldn't load more timeline events.",
        }).message,
        "error",
      );
    } finally {
      setLoadingMore(false);
    }
  }, [addToast, nextCursor, sourceFilter, severityFilter, orgFilter]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceFilter, severityFilter]);

  // One line per event. The source is its own column rather than a second
  // line under the event name, so a row costs one line of height on every
  // viewport; what does not fit a scan — organization, target, link — opens
  // per row on demand.
  const columns: DataTableColumn<TimelineEntry>[] = [
    {
      key: "eventType",
      header: "Event",
      render: (r) => (
        <span style={{ fontWeight: 600, overflowWrap: "anywhere" }}>{r.eventType}</span>
      ),
    },
    {
      key: "source",
      header: "Source",
      nowrap: true,
      render: (r) => (
        <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>
          {SOURCE_LABELS[r.source] ?? r.source}
        </span>
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
      // PHASE 5 §6 — this rendered `dash(r.actor)`, which is a raw UUID for a
      // human action and an em-dash for everything else. In a feed that merges
      // five sources, that made an operator decision and an automated
      // detection look identical.
      render: (r) => {
        const actor = presentActor(r);
        return (
          <span style={{ display: "grid", gap: 1, fontSize: 12 }}>
            <span
              style={{
                color: actor.unknown ? "var(--ink-muted)" : "var(--ink-primary)",
                fontStyle: actor.unknown ? "italic" : "normal",
              }}
            >
              {actor.name}
            </span>
            {/* THE KIND, ONLY WHEN IT ADDS SOMETHING.
                `presentActor` returns a name and a kind, and for a
                non-human actor they are the SAME WORDS — so every automated
                row rendered "Automated service" twice, stacked, and every
                human row carried a second line reading "Person" that the
                name above it had already implied. The kind earns its line
                when it disambiguates the name and not otherwise. */}
            {actor.kind && actor.kind !== actor.name ? (
              <span style={{ color: "var(--ink-muted)", fontSize: 11 }}>
                {actor.kind}
              </span>
            ) : null}
          </span>
        );
      },
    },
    {
      key: "outcome",
      header: "Outcome",
      // Absence is said as absence. Several timeline sources record no outcome
      // at all, and "Not recorded" is the truthful thing to show for them.
      render: (r) => {
        const o = presentOutcome(r.outcome);
        const transition = presentTransition(r);
        return (
          <span style={{ display: "grid", gap: 1, fontSize: 12 }}>
            <span
              style={{
                color: o.unknown ? "var(--ink-muted)" : "var(--ink-primary)",
                fontStyle: o.unknown ? "italic" : "normal",
              }}
            >
              {o.label}
            </span>
            {transition ? (
              <span style={{ color: "var(--ink-muted)", fontSize: 11 }}>{transition.text}</span>
            ) : null}
          </span>
        );
      },
    },
    {
      key: "at",
      header: "When",
      nowrap: true,
      render: (r) => (
        <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>
          {formatTimestamp(r.at)}
        </span>
      ),
    },
  ];

  const rowKey = (r: TimelineEntry, index: number) => `${r.source}:${r.at}:${index}`;

  const filtered =
    sourceFilter !== "all" || severityFilter !== "all" || orgFilter.trim() !== "";

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
            filtered={
              sourceFilter !== "all" || severityFilter !== "all" || orgFilter !== ""
            }
            onReset={() => {
              setSourceFilter("all");
              setSeverityFilter("all");
              setOrgFilter("");
            }}
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
            getRowId={rowKey}
            loading={loading}
            ariaLabel="Platform operational timeline"
            emptyState={
              <EmptyState variant="inline"
                framed
                title="No platform events"
                purpose="No platform-operational events match the current filters. As admin actions, organization lifecycle events, security events, incidents, or billing/team events are recorded, they appear here — evidence custody events are never included."
                data-testid="admin-timeline-empty"
              />
            }
            rowActions={(r, index) => (
              <Button
                variant="secondary"
                size="sm"
                aria-expanded={Boolean(expanded[rowKey(r, index)])}
                onClick={() => toggleExpanded(rowKey(r, index))}
                data-testid="admin-timeline-details-toggle"
              >
                {expanded[rowKey(r, index)] ? "Hide details" : "Details"}
              </Button>
            )}
            expandedContent={(r, index) =>
              expanded[rowKey(r, index)] ? (
                <dl
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                    gap: "8px 16px",
                    margin: 0,
                    fontSize: 12.5,
                  }}
                  data-testid="admin-timeline-details"
                >
                  {(
                    [
                      ["Organization", dash(r.organizationId)],
                      ["Target", dash(r.targetLabel)],
                      ["Recorded at", r.at],
                    ] as Array<[string, string]>
                  ).map(([label, value]) => (
                    <div key={label} style={{ minWidth: 0 }}>
                      <dt
                        style={{
                          fontSize: 11,
                          color: "var(--ink-muted)",
                          textTransform: "uppercase",
                          letterSpacing: "0.06em",
                        }}
                      >
                        {label}
                      </dt>
                      <dd style={{ margin: "2px 0 0", overflowWrap: "anywhere" }}>{value}</dd>
                    </div>
                  ))}
                  {r.href ? (
                    <div style={{ minWidth: 0 }}>
                      <dt
                        style={{
                          fontSize: 11,
                          color: "var(--ink-muted)",
                          textTransform: "uppercase",
                          letterSpacing: "0.06em",
                        }}
                      >
                        Open
                      </dt>
                      <dd style={{ margin: "2px 0 0" }}>
                        <a href={r.href}>{r.href}</a>
                      </dd>
                    </div>
                  ) : null}
                </dl>
              ) : null
            }
          />

          {/* HOW MANY, and whether that is all of them — the server's own
              `nextCursor` decides, so the sentence never claims a total it
              was not given. The continuation is offered rather than
              described so the feed is not a dead end. */}
          <ResultCount
            shown={items.length}
            hasMore={nextCursor !== null}
            noun="event"
            filtered={filtered}
            loading={loading}
            data-testid="admin-timeline-count"
            action={
              nextCursor ? (
                <Button
                  variant="secondary"
                  onClick={() => void loadMore()}
                  loading={loadingMore}
                  data-testid="admin-timeline-load-more"
                >
                  Load older events
                </Button>
              ) : null
            }
          />
        </PageSection>
      </PageShell>
    </PageRouteGate>
  );
}
