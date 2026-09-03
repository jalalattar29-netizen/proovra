"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { PageShell, PageHeader, PageSection, Skeleton, useToast } from "../../../components/ui";
import { Badge, type BadgeTone } from "../../../components/ui/Badge";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import {
  AdminStat,
  AdminStatGrid,
  formatMoney,
  type Metric,
  type OverviewFigure,
} from "../../../components/admin/AdminMetric";
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

const STATUS_TONE: Record<StatusLevel, BadgeTone> = {
  healthy: "verified",
  degraded: "pending",
  critical: "risk",
  unknown: "neutral",
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
        ov.evidenceOps?.reports?.failedGeneration,
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
            <Link href="/admin/provisioning" style={{ textDecoration: "none" }}>
              <Button variant="primary" data-testid="admin-provision-cta">
                Provision enterprise customer
              </Button>
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
          <EmptyState
            title="Overview unavailable"
            purpose="The platform overview could not be loaded. This is an honest not-connected state, not an empty platform."
          />
        </PageSection>
      ) : (
        <>
          {/* ---- A. Posture ------------------------------------------------ */}
          <PageSection
            title="Platform posture"
            description="One authority. Incidents, signals, queues, workers, search, the evidence pipeline and every dependency probe are evaluated together by the platform health snapshot, and every global surface reads the same body. 'Healthy' is claimed only when every source answered and the evaluation is fresh — a failed read is Unknown, never green and never zero."
          >
            <div
              style={{
                marginBottom: 14,
                display: "flex",
                gap: 10,
                alignItems: "baseline",
                flexWrap: "wrap",
              }}
            >
              <Badge tone={STATUS_TONE[ov.status.level]} data-testid="admin-status-level">
                {ov.status.level.toUpperCase()}
              </Badge>
              {/* A state word with no reason is how "degraded" came to mean
                  "something, somewhere". The snapshot always names what decided
                  it, and the page always prints that sentence. */}
              <span
                style={{ fontSize: 13, color: "var(--ink-secondary, #475569)" }}
                data-testid="admin-status-reason"
              >
                {ov.status.reason}
              </span>
            </div>
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
              <div
                role="status"
                data-testid="admin-status-unavailable-sources"
                style={{
                  marginBottom: 14,
                  padding: "10px 12px",
                  border: "1px solid var(--border-default, #cbd5e1)",
                  borderRadius: 8,
                  fontSize: 13,
                  color: "var(--ink-secondary, #475569)",
                }}
              >
                <strong style={{ color: "var(--ink-primary, #0f172a)" }}>
                  Partial evaluation.
                </strong>{" "}
                {ov.status.unavailableSources.join(", ")} did not answer. Figures
                these sources feed are shown as unknown rather than as zero.
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

          {/* ---- A2. Needs attention -------------------------------------- */}
          <PageSection
            title="Needs attention"
            description="Every attention signal on this page that is non-zero or unmeasured, with the records behind it. Measured zeros are omitted here and remain in the sections below — thirty cards reading zero is not a summary."
          >
            <NeedsAttention ov={ov} />
          </PageSection>

          {/* ---- B. Customers --------------------------------------------- */}
          <PageSection
            title="Customers"
            description="Customer organizations only. The internal 1:1 bootstrap container every workspace owns is not a customer and is not counted here."
          >
            <AdminStatGrid>
              <AdminStat label="Customers" figure={ov.customers.total} />
              <AdminStat label="Active" figure={ov.customers.active} />
              <AdminStat
                label="Enterprise contracts"
                figure={ov.customers.enterpriseContracts}
                hint="Contracts in ACTIVE status — not a workspace plan string"
              />
              <AdminStat label="Onboarding" figure={ov.customers.onboarding} hint="Pending enterprise seats" />
              <AdminStat label="Suspended" figure={ov.customers.suspended} emphasis="attention" />
              <AdminStat label="Archived" figure={ov.customers.archived} />
              <AdminStat label="SSO outages" metric={ov.customers.ssoOutageConnections} emphasis="attention" />
              <AdminStat label="Unverified domains" metric={ov.customers.unverifiedDomains} />
            </AdminStatGrid>
          </PageSection>

          {/* ---- C. Workspaces --------------------------------------------- */}
          <PageSection
            title="Workspaces"
            description="Live workspaces by kind. Closed workspaces are excluded from every live figure and counted separately — closing a workspace revokes its access without touching its billing columns, so billing state was never a usable liveness signal."
          >
            <AdminStatGrid>
              <AdminStat label="Live workspaces" figure={ov.workspaces.live} />
              <AdminStat label="Personal" figure={ov.workspaces.personal} />
              <AdminStat label="Owned" figure={ov.workspaces.owned} />
              <AdminStat label="Organization" figure={ov.workspaces.organization} />
            </AdminStatGrid>
            <div style={{ marginTop: 16 }}>
              <AdminStatGrid>
                <AdminStat label="Closed (history)" figure={ov.workspaces.closed} />
                <AdminStat label="People" figure={ov.people.total} />
                <AdminStat label="Registered" figure={ov.people.registered} hint="Excludes guest identities" />
              </AdminStatGrid>
            </div>
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
            <AdminStatGrid>
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

            <div style={{ marginTop: 16 }}>
              <AdminStatGrid>
                <AdminStat label="Storage add-ons" figure={ov.billing.activeStorageAddons} />
                <AdminStat label="MRR" metric={ov.billing.mrrCents} />
                <AdminStat label="ARR" metric={ov.billing.arrCents} />
              </AdminStatGrid>
            </div>

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
            <AdminStatGrid>
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
                figure={evidenceFigure(ov.evidenceOps?.reports?.failedGeneration, "SIGNED_NO_REPORT")}
                emphasis="attention"
              />
            </AdminStatGrid>
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

          {/* ---- G. Traffic ------------------------------------------------ */}
          <PageSection
            title="Traffic"
            description="Consented public analytics."
          >
            {ov.traffic.connected ? (
              <AdminStatGrid>
                <AdminStat label="Page views (7d)" metric={ov.traffic.pageViewsLast7d} />
                <AdminStat label="Visitors (7d)" metric={ov.traffic.visitorsLast7d} />
                <AdminStat
                  label="Countries seen"
                  metric={
                    ov.traffic.topCountries.state === "VALUE"
                      ? { state: "VALUE", value: ov.traffic.topCountries.value?.length ?? 0 }
                      : { state: ov.traffic.topCountries.state, value: null, reason: ov.traffic.topCountries.reason }
                  }
                />
              </AdminStatGrid>
            ) : (
              <EmptyState title="Traffic not connected" purpose={ov.traffic.note} />
            )}
          </PageSection>
        </>
      )}
    </PageShell>
  );
}
