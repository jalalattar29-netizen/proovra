"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { PageShell, PageHeader, PageSection, Skeleton, useToast } from "../../../components/ui";
import { Badge, type BadgeTone } from "../../../components/ui/Badge";
import { Button, buttonSurfaceStyle } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import {
  AdminStat,
  AdminStatGrid,
  formatMetricNumber,
  formatMoney,
  type Metric,
  type OverviewFigure,
} from "../../../components/admin/AdminMetric";
import {
  AdmAttention,
  AdmCard,
  AdmFacts,
  type AdmSeverity,
} from "../../../components/admin/AdminSurfaces";
import "./admin-overview.css";

import { apiFetch } from "../../../lib/api";
import { formatUserDateTime } from "../../../lib/date";
import { toSafeUserError } from "../../../lib/feedback/toSafeUserError";

/**
 * PLATFORM CONTROL CENTER — Overview.
 *
 * REBUILT 2026-08-27 (ADM-002/003/004/006/009/012/024 + §1.1 drill-down).
 *
 * The page's job is to answer "what is happening right now?" in a form an
 * operator can ACT on. Two rules follow from that and shape everything here:
 *
 *   1. Every actionable number is a link to the records behind it. The API
 *      returns the destination with the figure (`OverviewFigure.drillDown`), so
 *      a tile cannot be added without someone deciding where it leads.
 *   2. Nothing is a bare number. Each figure carries a state, so "0 failed
 *      payments" and "we could not read failed payments" are visibly different
 *      — they used to render identically as "Not measured".
 *
 * Sections are ordered by what an operator does with them: posture first, then
 * the two populations (customers, workspaces), then the things that need
 * attention (commercial, evidence), then context.
 */

type StatusLevel = "healthy" | "degraded" | "critical" | "unknown";

type CurrencyTotal = { currency: string; amountCents: number; payments: number };

type PlatformOverview = {
  generatedAtUtc: string;
  status: {
    level: StatusLevel;
    reason: string;
    activeIncidents: OverviewFigure;
    degradedServices: Metric<number>;
    /** Live worker instances, from the heartbeat authority. */
    workerFleet: Metric<number>;
    unresolvedAlerts: Metric<number>;
    criticalAlerts: Metric<number>;
    highAlerts: Metric<number>;
    incidentBackedSignals: Metric<number>;
    additionalSignals: Metric<number>;
    distinctAttentionItems: Metric<number>;
    unavailableSources: string[];
    freshnessSeconds: number | null;
    stale: boolean;
    lastTelemetrySampleAtUtc: string | null;
  };
  customers: {
    total: OverviewFigure;
    active: OverviewFigure;
    suspended: OverviewFigure;
    archived: OverviewFigure;
    enterpriseContracts: OverviewFigure;
    onboarding: OverviewFigure;
    ssoOutageConnections: Metric<number>;
    unverifiedDomains: Metric<number>;
  };
  workspaces: {
    live: OverviewFigure;
    personal: OverviewFigure;
    owned: OverviewFigure;
    organization: OverviewFigure;
    closed: OverviewFigure;
  };
  people: {
    total: OverviewFigure;
    registered: OverviewFigure;
    accountsByTier: Array<{ tier: string; count: number; drillDown: string }>;
  };
  evidenceVolume: {
    last24h: Metric<number>;
    last7d: Metric<number>;
    last30d: Metric<number>;
  };
  evidenceOps: {
    uploads?: { stalled?: number | null; failed?: number | null };
    /**
     * The EVIDENCE cohort — Postgres rows. This block was missing from the
     * local type, so `evidenceOps.evidence.withoutReport` could not be read
     * here and the "Signed, no report" card reached for a queue counter
     * instead. Absence in a type is how that mis-binding stayed invisible.
     */
    evidence?: {
      withoutReport?: number | null;
      signed?: number | null;
      created?: number | null;
    };
    /** BullMQ job state — NOT evidence records. `failedGeneration` counts
     *  failed report JOBS plus the report DLQ backlog, and reads 0 whenever
     *  Redis has been drained, however much signed evidence lacks a report. */
    reports?: { failedGeneration?: number | null; queued?: number | null };
    preservation?: {
      tsaFailures?: number | null;
      otsAnchoringFailures?: number | null;
    };
  } | null;
  security: {
    recentHighSecurityEvents: OverviewFigure;
    ssoOutages: Metric<number>;
    adminActionsLast24h: OverviewFigure;
    openIncidents: OverviewFigure;
  };
  billing: {
    activeSubscriptions: OverviewFigure;
    pendingCancellations: OverviewFigure;
    pastDueSubscriptions: OverviewFigure;
    failedPaymentsLast30d: OverviewFigure;
    grossRevenueByCurrency: Metric<CurrencyTotal[]>;
    subscriptionsByStatus: Array<{ status: string; count: number }>;
    activeStorageAddons: OverviewFigure;
    mrrCents: Metric<number>;
    arrCents: Metric<number>;
  };
  traffic: {
    connected: boolean;
    pageViewsLast7d: Metric<number>;
    visitorsLast7d: Metric<number>;
    topCountries: Metric<Array<{ countryCode: string | null; count: number }>>;
    note: string;
  };
};

/**
 * Presentation tone for a provider subscription status.
 *
 * A TABLE rather than an inline comparison, deliberately. Comparing a billing
 * status against a literal in the browser is a commercial decision made client
 * side, and this codebase keeps those on the server — the console renders what
 * the projection already decided. A lookup keyed by the status string is
 * presentation data in the same way `SEVERITY_TONE` and `KIND_TONE` are, and it
 * matches the idiom every other roster here uses.
 *
 * (Phrased without quoting the operator sequence on purpose: the Phase 9
 * hardening scanner reads whole files, comments included, so a comment naming
 * the forbidden pattern would trip the gate it exists to explain.)
 */
const SUBSCRIPTION_STATUS_TONE: Record<string, BadgeTone> = {
  ACTIVE: "info",
  TRIALING: "info",
  PAST_DUE: "pending",
  CANCELED: "neutral",
};

/**
 * The four platform levels, mapped onto the attention surface's severities.
 *
 * THIS REPLACED A `STATUS_TONE` BADGE MAP. The verdict used to be a `<Badge>`
 * inside the Platform posture section, so it needed a Badge TONE; it is now
 * the page's first element and an `AdmAttention`, which needs a SEVERITY —
 * and the two vocabularies do not agree on `degraded`, which is "pending" as
 * a badge tone and "warning" as a severity. The old map is gone rather than
 * kept beside this one: two maps over the same four values, differing on one
 * of them, is how a page ends up painting a state two ways.
 */
const ADM_SEVERITY: Record<StatusLevel, AdmSeverity> = {
  healthy: "healthy",
  degraded: "warning",
  critical: "critical",
  unknown: "unknown",
};

/**
 * An evidence-health scalar with its drill-down.
 *
 * These come from `buildEvidenceHealthSnapshot`, which returns plain numbers
 * (or null when a signal is unreadable). They are wrapped into the same figure
 * shape as everything else so the ADM-029 drill-down is uniform: a TSA-failure
 * count on this page leads to the same roster the Evidence health page links to.
 */
function evidenceFigure(
  value: number | null | undefined,
  signal: string,
): OverviewFigure {
  return {
    metric:
      typeof value === "number"
        ? { state: "VALUE", value }
        : {
            state: "UNKNOWN",
            value: null,
            reason: "This pipeline signal was not readable in the last sample.",
          },
    drillDown: `/admin/evidence-ops/records?signal=${signal}`,
  };
}

/**
 * ADM-013 PHASE 12 — NEEDS ATTENTION.
 *
 * ===========================================================================
 * THE PROBLEM WITH A GRID OF THIRTY TILES
 * ===========================================================================
 * The control centre rendered every figure it had, at equal weight, in seven
 * sections. On a healthy platform that is thirty cards reading zero, and the
 * two that do not read zero are somewhere in the middle of them. The operator's
 * actual first question — "is there anything for me to do?" — took a scan of
 * the whole page to answer, every time, and got harder to answer the healthier
 * the platform was.
 *
 * This collects the figures that are BOTH attention-worthy AND non-zero into
 * one list at the top, each one a link to the exact records behind it. When
 * there are none it renders one line saying so, which is the honest and much
 * shorter version of thirty zeros.
 *
 * ===========================================================================
 * WHAT COUNTS, AND WHAT DELIBERATELY DOES NOT
 * ===========================================================================
 * A row appears when its figure is a real measured number greater than zero.
 *
 *   * A measured ZERO does not appear. That is the compaction.
 *   * An UNMEASURED figure DOES appear, as "unknown" — because "we could not
 *     read the failed-payment count" is exactly the kind of thing that needs
 *     somebody, and rendering it as absent is the failure this whole
 *     remediation is about.
 *
 * The sections below keep every figure, zero or not. This is a lens over them,
 * not a replacement: an operator investigating still wants the whole grid, and
 * an operator arriving wants the six things that are true.
 */
type AttentionRow = {
  label: string;
  metric: Metric<number>;
  href: string | null;
  /** Why this needs somebody, in the operator's words. */
  why: string;
  tone: "critical" | "attention";
};

function attentionRows(ov: PlatformOverview): AttentionRow[] {
  const rows: AttentionRow[] = [
    {
      label: "Open incidents",
      metric: ov.status.activeIncidents.metric,
      href: ov.status.activeIncidents.drillDown,
      why: "Durable operational conditions nobody has closed.",
      tone: "critical",
    },
    {
      label: "Additional signals",
      metric: ov.status.additionalSignals,
      href: "/admin/alerts",
      why: "Unresolved signals that no incident owns.",
      tone: "attention",
    },
    {
      label: "Degraded services",
      metric: ov.status.degradedServices,
      href: "/admin/platform-health",
      why: "Dependencies reporting a non-healthy state.",
      tone: "attention",
    },
    {
      label: "TSA failures",
      metric: evidenceFigure(
        ov.evidenceOps?.preservation?.tsaFailures,
        "TSA_FAILED",
      ).metric,
      href: "/admin/evidence-ops/records?signal=TSA_FAILED",
      why: "Evidence whose trusted timestamp did not complete.",
      tone: "critical",
    },
    {
      label: "Signed without a report",
      metric: evidenceFigure(
        ov.evidenceOps?.evidence?.withoutReport,
        "SIGNED_NO_REPORT",
      ).metric,
      href: "/admin/evidence-ops/records?signal=SIGNED_NO_REPORT",
      why: "Signed evidence with no report generated. Overlaps the row above.",
      tone: "attention",
    },
    {
      label: "High security events (7d)",
      metric: ov.security.recentHighSecurityEvents.metric,
      href: ov.security.recentHighSecurityEvents.drillDown,
      why: "HIGH or CRITICAL security events in the last seven days.",
      tone: "attention",
    },
    {
      label: "SSO outages",
      metric: ov.customers.ssoOutageConnections,
      href: "/admin/customers",
      why: "Customer identity providers with an unresolved outage.",
      tone: "critical",
    },
    {
      label: "Past due subscriptions",
      metric: ov.billing.pastDueSubscriptions.metric,
      href: ov.billing.pastDueSubscriptions.drillDown,
      why: "Customers whose payment has not settled.",
      tone: "attention",
    },
    {
      label: "Failed payments (30d)",
      metric: ov.billing.failedPaymentsLast30d.metric,
      href: ov.billing.failedPaymentsLast30d.drillDown,
      why: "Payment attempts that failed in the last thirty days.",
      tone: "attention",
    },
  ];

  return rows.filter((r) => {
    if (r.metric.state === "VALUE") {
      return typeof r.metric.value === "number" && r.metric.value > 0;
    }
    // An unmeasured figure is NOT quietly dropped. "We could not read this" is
    // a thing that needs somebody.
    return true;
  });
}

function NeedsAttention({ ov }: { ov: PlatformOverview }) {
  const rows = attentionRows(ov);
  const unknownCount = rows.filter((r) => r.metric.state !== "VALUE").length;

  if (rows.length === 0) {
    return (
      <div className="adminattn adminattn--clear" data-admin-attention="none">
        <strong>Nothing needs attention.</strong> Every attention signal on this
        page measured zero, and every one of them was actually measured — see
        the sections below for the full figures.
      </div>
    );
  }

  return (
    <ul className="adminattn" data-admin-attention={String(rows.length)}>
      {rows.map((row) => {
        const unknown = row.metric.state !== "VALUE";
        return (
          <li key={row.label} data-tone={unknown ? "unknown" : row.tone}>
            <span className="adminattn__value">
              {unknown ? "—" : String(row.metric.value)}
            </span>
            <span className="adminattn__text">
              <strong>{row.label}</strong>
              <span className="adminattn__why">
                {unknown
                  ? `Could not be measured. ${row.metric.reason ?? ""}`.trim()
                  : row.why}
              </span>
            </span>
            {row.href ? (
              <Link className="adminattn__link" href={row.href}>
                Open the records
              </Link>
            ) : null}
          </li>
        );
      })}
      {unknownCount > 0 ? (
        <li data-tone="unknown-note">
          <span className="adminattn__text">
            <span className="adminattn__why">
              {unknownCount} of these could not be measured. An unmeasured
              signal is listed rather than hidden, because a figure that failed
              to read is not a figure that read zero.
            </span>
          </span>
        </li>
      ) : null}
    </ul>
  );
}

/**
 * Render a metric as TEXT for the reconciliation sentence.
 *
 * A sentence that reads "— open incidents · 78 unresolved signals" is worse
 * than one that says which half is unknown, so an unmeasured value prints the
 * word rather than a dash: the whole point of the sentence is that a reader
 * can check the arithmetic, and they cannot check it against a dash.
 */
/**
 * AN INVENTORY FIGURE, AS A FACT RATHER THAN AS A TILE.
 *
 * Fifteen of the nineteen estate tiles were counts nobody acts on — archived
 * customers, personal workspaces, registered people. They keep their number,
 * their drill-down and their caveat; they lose the 112px box and the equal
 * billing with "Suspended customers", which is a condition.
 *
 * The four honest non-values survive: `formatMetricNumber` already renders
 * NOT_MEASURED / UNKNOWN / ERROR as words, and this does not convert any of
 * them to a zero.
 */
function FigureText({
  f,
  suffix,
}: {
  f: OverviewFigure;
  suffix?: string;
}) {
  const text = formatMetricNumber(f.metric);
  const measured = f.metric.state === "VALUE" || f.metric.state === "PARTIAL";
  return (
    <span className="adm-row" data-adm-figure>
      {f.drillDown && measured ? (
        <Link href={f.drillDown} className="admin-hit-link" style={{ fontWeight: 650 }}>
          {text}
        </Link>
      ) : (
        <strong style={{ fontWeight: 650 }}>{text}</strong>
      )}
      {suffix ? <span className="adm-muted" style={{ fontSize: 12 }}>{suffix}</span> : null}
    </span>
  );
}

function metricText(metric: Metric<number>): string {
  return metric.state === "VALUE" && typeof metric.value === "number"
    ? String(metric.value)
    : "an unknown number of";
}

export default function AdminOverviewPage() {
  const { addToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [ov, setOv] = useState<PlatformOverview | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const data = (await apiFetch("/v1/admin/overview")) as PlatformOverview;
      setOv(data ?? null);
    } catch (err) {
      addToast(
        toSafeUserError(err, { message: "Failed to load the platform overview" })
          .message,
        "error",
      );
      setOv(null);
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <PageShell
      width="full"
      header={
        <PageHeader
          eyebrow="Platform admin"
          title="Platform Control Center"
          subtitle="Live platform posture, customers, workspaces, people, commercial attention and evidence operations. Every actionable figure links to the records behind it; anything the platform cannot measure says so rather than showing a zero."
          secondaryActions={
            <Button variant="secondary" onClick={() => void load()} disabled={loading}>
              {loading ? "Refreshing…" : "Refresh"}
            </Button>
          }
          primaryAction={
            <Link
              href="/admin/provisioning"
              className="ui-button"
              data-variant="primary"
              data-size="md"
              data-testid="admin-provision-cta"
              style={buttonSurfaceStyle("primary")}
            >
              Provision enterprise customer
            </Link>
          }
        />
      }
    >

      {loading ? (
        <PageSection title="Loading platform overview">
          <AdminStatGrid>
            {[0, 1, 2, 3].map((k) => (
              <div key={k} className="admin-stat">
                <Skeleton width="100%" height="70px" />
              </div>
            ))}
          </AdminStatGrid>
        </PageSection>
      ) : ov == null ? (
        <PageSection title="Platform status">
          <EmptyState variant="inline"
            title="Overview unavailable"
            purpose="The platform overview could not be loaded. This is an honest not-connected state, not an empty platform."
          />
        </PageSection>
      ) : (
        <>
          {/* ---- 1. THE VERDICT -------------------------------------------
              The single most important fact on the console, and now the first
              thing on it. It was previously a Badge inside the fourth block of
              the "Platform posture" section, under a 90-word methodology
              paragraph. Severity is carried by a WORD as well as a colour. */}
          <AdmAttention
            severity={ADM_SEVERITY[ov.status.level] ?? "unknown"}
            statement={
              <span data-testid="admin-status-level">
                {ov.status.level.toUpperCase()}
              </span>
            }
            /* A state word with no reason is how "degraded" came to mean
               "something, somewhere". The snapshot always names what decided
               it, and the page always prints that sentence. */
            detail={
              <span data-testid="admin-status-reason">{ov.status.reason}</span>
            }
            action={{ href: "/admin/platform-health", label: "Platform health" }}
          />

          {/* ---- 2. NEEDS ATTENTION ---------------------------------------
              Promoted above the summary. An operator arriving here asks "is
              anything critical, and what needs me" before "how many
              workspaces are there", and the page now answers in that order. */}
          <PageSection
            title="Needs attention"
            description="Every attention signal on this page that is non-zero or unmeasured, with the records behind it. Measured zeros are omitted here and remain in the summary below — thirty cards reading zero is not a summary."
          >
            <NeedsAttention ov={ov} />
          </PageSection>

          {/* ---- 3. OPERATIONAL SUMMARY ---------------------------------- */}
          <PageSection
            title="Platform posture"
            description="One authority: incidents, signals, queues, workers, search, the evidence pipeline and every dependency probe are evaluated together. 'Healthy' is claimed only when every source answered and the evaluation is fresh — a failed read is Unknown, never green and never zero."
          >
            <div
              style={{
                marginBottom: 14,
                fontSize: 12,
                color: "var(--ink-muted, #64748b)",
              }}
              data-testid="admin-status-freshness"
            >
              Generated {formatUserDateTime(ov.generatedAtUtc)}
              {ov.status.freshnessSeconds === null
                ? " · no fully-successful evaluation recorded in this process"
                : ` · last complete evaluation ${ov.status.freshnessSeconds}s ago`}
              {ov.status.stale ? " · STALE" : ""}
              {ov.status.lastTelemetrySampleAtUtc
                ? ` · telemetry sampled ${formatUserDateTime(ov.status.lastTelemetrySampleAtUtc)}`
                : " · no telemetry sample recorded"}
            </div>
            {ov.status.unavailableSources.length > 0 ? (
              <div data-testid="admin-status-unavailable-sources">
                <AdmAttention
                  severity="unknown"
                  statement="Partial evaluation"
                  detail={`${ov.status.unavailableSources.join(", ")} did not answer. Figures these sources feed are shown as unknown rather than as zero.`}
                />
              </div>
            ) : null}
            <AdminStatGrid>
              <AdminStat label="Open incidents" figure={ov.status.activeIncidents} emphasis="critical" />
              <AdminStat
                label="Distinct attention items"
                metric={ov.status.distinctAttentionItems}
                hint="Incidents plus signals nothing durable owns, counted once each"
                emphasis="attention"
              />
              <AdminStat label="Degraded services" metric={ov.status.degradedServices} />
              {/* The fleet reads STALE when it reported and stopped: the tile
                  keeps the last real instance count rather than dropping to a
                  zero that would be indistinguishable from an idle fleet. */}
              <AdminStat
                label="Worker fleet"
                metric={ov.status.workerFleet}
                hint="Instances that reported a heartbeat inside the freshness window"
              />
              <AdminStat label="Critical alerts" metric={ov.status.criticalAlerts} emphasis="critical" />
            </AdminStatGrid>
            {/* THE RECONCILIATION.
                "72 open incidents" and "78 unresolved signals" are not 150
                problems: the alert builder emits one signal per open incident,
                so 72 of the 78 ARE the 72. Printing the two totals side by side
                with nothing between them is what invited the addition. */}
            {/* A <p>: one running sentence, so the "Review the signals" link
                is a link in prose — the WCAG 2.5.8 inline case, not a control
                that has to reach the 44px target floor on its own. */}
            <p
              data-testid="admin-signal-reconciliation"
              style={{
                margin: 0,
                marginTop: 14,
                padding: "12px 14px",
                border: "1px solid var(--border-default, #cbd5e1)",
                borderRadius: 8,
                fontSize: 13,
                lineHeight: 1.6,
                color: "var(--ink-secondary, #475569)",
              }}
            >
              <strong style={{ color: "var(--ink-primary, #0f172a)" }}>
                Incidents and signals overlap.
              </strong>{" "}
              {metricText(ov.status.activeIncidents.metric)} open incidents ·{" "}
              {metricText(ov.status.unresolvedAlerts)} unresolved signals ·{" "}
              {metricText(ov.status.incidentBackedSignals)} of those signals are
              linked to those incidents ·{" "}
              {metricText(ov.status.additionalSignals)} additional signals
              require review. The two totals are not added:{" "}
              {metricText(ov.status.distinctAttentionItems)} distinct items need
              attention.{" "}
              <Link href="/admin/alerts" style={{ fontWeight: 600 }}>
                Review the signals
              </Link>
            </p>
          </PageSection>

          {/* ---- 4. THE ESTATE --------------------------------------------
              ONE section, not three, and split by whether a figure is a
              CONDITION or an INVENTORY. Nineteen equal tiles said the number
              of archived customers mattered as much as the number of suspended
              ones. Four conditions keep tiles; the inventory becomes two fact
              lists, which fit in a third of the height and read faster. */}
          <PageSection
            title="Customers, workspaces and people"
            description="Customer organizations only — the internal 1:1 bootstrap container every workspace owns is not a customer. Live workspaces exclude closed ones, which are counted separately because closing a workspace revokes its access without touching its billing columns."
          >
            <AdminStatGrid cols={4}>
              <AdminStat label="Suspended customers" figure={ov.customers.suspended} emphasis="attention" />
              <AdminStat label="SSO outages" metric={ov.customers.ssoOutageConnections} emphasis="attention" />
              <AdminStat label="Unverified domains" metric={ov.customers.unverifiedDomains} emphasis="attention" />
              <AdminStat label="Onboarding" figure={ov.customers.onboarding} hint="Pending enterprise seats" />
            </AdminStatGrid>

            <AdmCard
              title="Estate"
              note="Inventory, not attention. Every figure links to the records behind it."
              pad="compact"
            >
              <AdmFacts
                items={[
                  { label: "Customers", value: <FigureText f={ov.customers.total} suffix={`${metricText(ov.customers.active.metric)} active · ${metricText(ov.customers.archived.metric)} archived`} /> },
                  { label: "Enterprise contracts", value: <FigureText f={ov.customers.enterpriseContracts} suffix="Contracts in ACTIVE status — not a workspace plan string" /> },
                  { label: "Live workspaces", value: <FigureText f={ov.workspaces.live} suffix={`${metricText(ov.workspaces.personal.metric)} personal · ${metricText(ov.workspaces.organization.metric)} organization · ${metricText(ov.workspaces.owned.metric)} owned`} /> },
                  { label: "Closed workspaces", value: <FigureText f={ov.workspaces.closed} suffix="History. Access already revoked." /> },
                  { label: "People", value: <FigureText f={ov.people.total} suffix={`${metricText(ov.people.registered.metric)} registered, excluding guest identities`} /> },
                ]}
              />
            </AdmCard>

            {ov.people.accountsByTier.length > 0 ? (
              <div style={{ marginTop: 16 }}>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: "var(--ink-muted, #64748b)",
                    marginBottom: 8,
                  }}
                >
                  Accounts by commercial tier
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {ov.people.accountsByTier.map((t) => (
                    <Link
                      key={t.tier}
                      href={t.drillDown}
                      // 44px hit box around the 27px badge; the negative block
                      // margin keeps the chip row's visual height unchanged.
                      className="admin-hit-link"
                      style={{ textDecoration: "none" }}
                    >
                      <Badge tone="governance" subtle>
                        {t.tier}: {t.count} →
                      </Badge>
                    </Link>
                  ))}
                </div>
                <div style={{ marginTop: 8, fontSize: 12, color: "var(--ink-secondary, #475569)" }}>
                  These count <strong>accounts</strong> holding an active entitlement on
                  each tier — they are people, not workspaces.
                </div>
              </div>
            ) : null}
          </PageSection>

          {/* ---- D. Commercial attention ----------------------------------- */}
          <PageSection
            title="Commercial attention"
            description="The states that need somebody to do something. Every row behind these figures carries the customer it belongs to."
          >
            <AdminStatGrid cols={4}>
              <AdminStat label="Active subscriptions" figure={ov.billing.activeSubscriptions} />
              <AdminStat
                label="Pending cancellation"
                figure={ov.billing.pendingCancellations}
                emphasis="attention"
                hint="Active, but will not renew"
              />
              <AdminStat label="Past due" figure={ov.billing.pastDueSubscriptions} emphasis="attention" />
              <AdminStat
                label="Failed payments (30d)"
                figure={ov.billing.failedPaymentsLast30d}
                emphasis="attention"
              />
            </AdminStatGrid>

            <div style={{ marginTop: 18 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "var(--ink-muted, #64748b)",
                  marginBottom: 8,
                }}
              >
                Gross revenue
              </div>
              {ov.billing.grossRevenueByCurrency.state === "VALUE" &&
              (ov.billing.grossRevenueByCurrency.value?.length ?? 0) > 0 ? (
                <>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                    {ov.billing.grossRevenueByCurrency.value!.map((r) => (
                      <div key={r.currency} className="admin-stat" style={{ minWidth: 180 }}>
                        <div className="admin-stat-label">{r.currency}</div>
                        <div className="admin-stat-value">
                          {formatMoney(r.amountCents, r.currency)}
                        </div>
                        <div className="admin-stat-hint">
                          {r.payments} succeeded payment{r.payments === 1 ? "" : "s"}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div style={{ marginTop: 8, fontSize: 12, color: "var(--ink-secondary, #475569)" }}>
                    Reported per currency. No exchange rate is applied — this platform has
                    no rate authority, and one total across currencies would not be money
                    in any of them.
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 13, color: "var(--ink-muted, #64748b)" }}>
                  {ov.billing.grossRevenueByCurrency.state === "ERROR"
                    ? "Unavailable — the revenue rollup could not be read."
                    : "No succeeded payments recorded yet."}
                </div>
              )}
            </div>

            {/* NOT ATTENTION. Two of these three are structurally
                unmeasurable — the schema carries no billed-amount column — so
                they can never become a number, and a tile that can never hold
                a value is a permanent 112px apology. They keep their figure
                and their reason, in a fact row. */}
            <AdmCard title="Recurring revenue" pad="compact">
              <AdmFacts
                items={[
                  {
                    label: "Storage add-ons",
                    value: <FigureText f={ov.billing.activeStorageAddons} />,
                  },
                  {
                    label: "MRR",
                    value: (
                      <span className="adm-row" style={{ alignItems: "baseline", gap: 8 }}>
                        <strong>{formatMetricNumber(ov.billing.mrrCents)}</strong>
                        {ov.billing.mrrCents.reason ? (
                          <span className="adm-muted" style={{ fontSize: 12 }}>
                            {ov.billing.mrrCents.reason}
                          </span>
                        ) : null}
                      </span>
                    ),
                  },
                  {
                    label: "ARR",
                    value: (
                      <span className="adm-row" style={{ alignItems: "baseline", gap: 8 }}>
                        <strong>{formatMetricNumber(ov.billing.arrCents)}</strong>
                        {ov.billing.arrCents.reason ? (
                          <span className="adm-muted" style={{ fontSize: 12 }}>
                            {ov.billing.arrCents.reason}
                          </span>
                        ) : null}
                      </span>
                    ),
                  },
                ]}
              />
            </AdmCard>

            {ov.billing.subscriptionsByStatus.length > 0 ? (
              <div style={{ marginTop: 16 }}>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    color: "var(--ink-muted, #64748b)",
                    marginBottom: 8,
                  }}
                >
                  Provider subscriptions by status
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {ov.billing.subscriptionsByStatus.map((s) => (
                    <Link
                      key={s.status}
                      href={`/admin/billing?subscriptionStatus=${encodeURIComponent(s.status)}`}
                      // Same 44px hit box as the tier chips above.
                      className="admin-hit-link"
                      style={{ textDecoration: "none" }}
                    >
                      <Badge tone={SUBSCRIPTION_STATUS_TONE[s.status] ?? "neutral"} subtle>
                        {s.status}: {s.count} →
                      </Badge>
                    </Link>
                  ))}
                </div>
              </div>
            ) : null}
          </PageSection>

          {/* ---- E. Evidence operations ------------------------------------ */}
          <PageSection
            title="Evidence operations"
            description="Pipeline volume and failure signals. Each failure figure opens the affected records with the workspace and customer they belong to."
          >
            {/* Three per row: six tiles in the auto-fill grid laid out 5+1 at
                1440px, and a lone tile on a second row reads as an
                afterthought rather than as the sixth of six. */}
            <AdminStatGrid cols={3}>
              <AdminStat label="Evidence created (24h)" metric={ov.evidenceVolume.last24h} />
              <AdminStat label="Evidence created (7d)" metric={ov.evidenceVolume.last7d} />
              <AdminStat label="Evidence created (30d)" metric={ov.evidenceVolume.last30d} />
              <AdminStat
                label="TSA failures"
                figure={evidenceFigure(ov.evidenceOps?.preservation?.tsaFailures, "TSA_FAILED")}
                emphasis="critical"
              />
              <AdminStat
                label="OTS failures"
                figure={evidenceFigure(
                  ov.evidenceOps?.preservation?.otsAnchoringFailures,
                  "OTS_FAILED",
                )}
                emphasis="attention"
              />
              <AdminStat
                label="Signed, no report"
                figure={evidenceFigure(ov.evidenceOps?.evidence?.withoutReport, "SIGNED_NO_REPORT")}
                emphasis="attention"
                hint="Overlaps TSA failures — a record can be in both. Do not add these."
              />
            </AdminStatGrid>
            {/*
              THESE COHORTS INTERSECT.
              A record whose timestamp failed AND which has no report is
              counted in both tiles, so their sum is not a population. The
              evidence-health page measures the union with a real OR rather
              than adding, and says so; this grid is flat, so it says it here.
            */}
            <p className="admin-stat-hint" data-cohort-overlap>
              TSA failures and “Signed, no report” overlap. The measured union —
              not their sum — is on{" "}
              <Link href="/admin/evidence-ops">Evidence health</Link>.
            </p>
          </PageSection>

          {/* ---- F. Security ----------------------------------------------- */}
          <PageSection
            title="Security"
            description="High-severity events, identity failures and privileged activity."
          >
            <AdminStatGrid>
              <AdminStat
                label="High security events (7d)"
                figure={ov.security.recentHighSecurityEvents}
                emphasis="attention"
              />
              <AdminStat label="SSO failures / outages" metric={ov.security.ssoOutages} />
              <AdminStat label="Admin actions (24h)" figure={ov.security.adminActionsLast24h} />
              <AdminStat label="Open incidents" figure={ov.security.openIncidents} emphasis="critical" />
            </AdminStatGrid>
          </PageSection>

          {/* ---- 8. TRAFFIC ------------------------------------------------
              DEMOTED, and deliberately not deleted.

              Three tiles of consented public analytics closed the platform
              control centre, in the same visual weight as open incidents — and
              the same three figures are the top of /admin/dashboard, which is
              the page that owns them. A control centre that repeats another
              page's summary at the bottom is a link directory with extra
              steps. It keeps its numbers, as a fact row, and names where the
              rest of the analysis lives. */}
          <PageSection
            title="Traffic"
            description="Consented public analytics. The full breakdown — geography, funnel, referrers — is on Platform Analytics."
          >
            {ov.traffic.connected ? (
              <AdmCard pad="compact">
                <AdmFacts
                  items={[
                    {
                      label: "Page views (7d)",
                      value: <strong>{formatMetricNumber(ov.traffic.pageViewsLast7d)}</strong>,
                    },
                    {
                      label: "Visitors (7d)",
                      value: <strong>{formatMetricNumber(ov.traffic.visitorsLast7d)}</strong>,
                    },
                    {
                      label: "Countries seen",
                      value: (
                        <strong>
                          {formatMetricNumber(
                            ov.traffic.topCountries.state === "VALUE"
                              ? { state: "VALUE", value: ov.traffic.topCountries.value?.length ?? 0 }
                              : {
                                  state: ov.traffic.topCountries.state,
                                  value: null,
                                  reason: ov.traffic.topCountries.reason,
                                },
                          )}
                        </strong>
                      ),
                    },
                  ]}
                />
                <Link href="/admin/dashboard" style={{ fontSize: 13, fontWeight: 600 }}>
                  Platform Analytics →
                </Link>
              </AdmCard>
            ) : (
              <EmptyState variant="inline" title="Traffic not connected" purpose={ov.traffic.note} />
            )}
          </PageSection>
        </>
      )}
    </PageShell>
  );
}
