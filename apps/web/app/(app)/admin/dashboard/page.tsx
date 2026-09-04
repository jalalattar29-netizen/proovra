"use client";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import Link from "next/link";

import { useEffect, useMemo, useState } from "react";
import { PageShell, PageHeader, PageSection, DataTable } from "../../../../components/ui";
import { Card } from "../../../../components/ui/Card";
import { Badge } from "../../../../components/ui/Badge";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { apiFetch } from "../../../../lib/api";
import { ResultCount } from "../../../../components/ui/ResultCount";
import { useToast } from "../../../../components/ui";
import { formatUserDateTime } from "../../../../lib/date";

type AdminSummary = {
  totalUsers: number;
  registeredUsers: number;
  guestUsers: number;
  activeUsers: number;
  usersWithEvidence: number;
  totalEvidence: number;
  reportsGenerated: number;
  /**
   * ADM-009 — ACCOUNT tiers. An Entitlement row is keyed by userId, so every
   * number here counts USERS. The old field was named `subscriptionBreakdown`
   * and its `team` value was rendered as "Team-Plan Workspaces", which it has
   * never been.
   */
  accountTierBreakdown: {
    free: number;
    payg: number;
    pro: number;
    team: number;
  };
  evidenceByType: {
    photos: number;
    videos: number;
    documents: number;
    other: number;
  };
  billing: {
    activeSubscriptions: number;
    trialingSubscriptions: number;
    pastDueSubscriptions: number;
    canceledSubscriptions: number;
    successfulPayments: number;
    failedPayments: number;
    refundedPayments: number;
    /** ADM-012 — one total PER CURRENCY. Never one cross-currency sum. */
    grossRevenueByCurrency: Array<{
      currency: string;
      amountCents: number;
      payments: number;
    }>;
  };
  /** ADM-004 — LIVE workspaces only. Closed workspaces are excluded. */
  workspaces: {
    total: number;
    active: number;
    pastDue: number;
    canceled: number;
    inactive: number;
    overSeatLimit: number;
  };
  workspaceHealth: {
    storageNearLimitTeams: number;
    storageLimitReachedTeams: number;
    seatNearLimitTeams: number;
    seatLimitReachedTeams: number;
  };
};

type GeoItem = {
  name: string | null;
  count: number;
  share?: number;
  countryCode?: string | null;
  normalized?: string | null;
};

type GeographyResponse = {
  total?: number;
  countries: GeoItem[];
  cities: GeoItem[];
};

type TopPage = {
  path: string | null;
  routeType?: string | null;
  views: number;
  share?: number;
};

type RecentEvent = {
  eventType: string;
  label?: string;
  eventClass?: string | null;
  routeType?: string | null;
  severity?: string | null;
  path: string | null;
  country: string | null;
  countryCode?: string | null;
  city: string | null;
  cityNormalized?: string | null;
  createdAt: string;
  sessionId?: string | null;
  userId?: string | null;
};

type TrendPoint = {
  date: string;
  pageViews: number;
  sessions: number;
  eventType?: string | null;
};

type FunnelStep = {
  key: string;
  label: string;
  /** Null when the stage is not instrumented. Never 0 for an absent emitter. */
  count: number | null;
  measured: boolean;
  notMeasuredReason: string | null;
  conversionFromPrevious: number | null;
  dropOffFromPrevious: number | null;
};

type AdminBundle = {
  summary: AdminSummary;
  geography: GeographyResponse;
  pages: TopPage[];
  recent: RecentEvent[];
  trends: TrendPoint[];
  funnel: FunnelStep[];
};

type DateRangeKey = "24h" | "7d" | "30d";

const DATE_RANGES: ReadonlyArray<{ key: DateRangeKey; label: string }> = [
  { key: "24h", label: "24 hours" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
];

// ---------------------------------------------------------------------------
// Presentation helpers (token-driven; no hard-coded pearl palette).
// ---------------------------------------------------------------------------

const INK_PRIMARY = "var(--ink-primary, #0f172a)";
const INK_SECONDARY = "var(--ink-secondary, #475569)";
const INK_MUTED = "var(--ink-muted, #94a3b8)";

function formatTimestamp(value: string) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return formatUserDateTime(value);
}

function formatCount(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return null;
  return new Intl.NumberFormat().format(value);
}

type BadgeTone = "verified" | "pending" | "risk" | "neutral" | "governance" | "info";

function eventSeverityTone(severity?: string | null): BadgeTone {
  const value = (severity ?? "").toLowerCase();
  if (value === "high" || value === "critical") return "risk";
  if (value === "medium" || value === "warning") return "pending";
  return "verified";
}

// A premium top-line metric tile. `value === null` means the value is not
// present in the analytics bundle — we render an HONEST "Not measured"
// state instead of fabricating a number.
function MetricTile({
  label,
  value,
  sub,
  accent,
  href,
}: {
  label: string;
  value: string | null;
  sub?: string;
  accent?: string;
  /**
   * §1.1 — an actionable aggregate leads to its records. A tile without one is
   * a terminal number, which is the defect class this remediation removes; the
   * prop is optional only because a few tiles here (page views, session counts)
   * genuinely have no record list behind them.
   */
  href?: string;
}) {
  const measured = value != null;
  const card = (
    <Card padding="comfortable" style={{ minWidth: 0 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: INK_MUTED,
          overflowWrap: "anywhere",
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 10,
          fontSize: 30,
          lineHeight: 1.05,
          fontWeight: 750,
          letterSpacing: "-0.02em",
          color: measured ? accent ?? INK_PRIMARY : INK_MUTED,
          overflowWrap: "anywhere",
        }}
      >
        {measured ? value : "—"}
      </div>
      <div
        style={{
          marginTop: 8,
          fontSize: 12.5,
          lineHeight: 1.5,
          color: measured ? INK_SECONDARY : INK_MUTED,
          overflowWrap: "anywhere",
        }}
      >
        {measured ? sub ?? "" : "Not measured — this signal is not in the analytics bundle."}
      </div>
      {href && measured ? (
        <div
          style={{
            marginTop: 10,
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: "0.04em",
            color: "var(--accent-600, #1d4ed8)",
          }}
        >
          View records →
        </div>
      ) : null}
    </Card>
  );

  if (href && measured) {
    return (
      <Link href={href} style={{ textDecoration: "none", color: "inherit" }}>
        {card}
      </Link>
    );
  }
  return card;
}

// A small labelled distribution row (subscription mix, evidence mix, …).
function StatRow({ label, value, tone }: { label: string; value: number; tone: BadgeTone }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "10px 12px",
        borderRadius: 10,
        border: "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
        background: "var(--surface-muted, #f1f4f9)",
      }}
    >
      <span style={{ fontSize: 13.5, fontWeight: 600, color: INK_PRIMARY }}>{label}</span>
      <Badge tone={tone}>{formatCount(value) ?? "0"}</Badge>
    </div>
  );
}

// Honest "we don't collect this signal yet" card — used for referrers and
// traffic-trend-by-source, which the analytics bundle does NOT provide.
function NotConnectedCard({ title, signal }: { title: string; signal: string }) {
  return (
    <Card title={title} padding="comfortable">
      <EmptyState
        compact
        title="Not connected"
        purpose={signal}
        data-testid="admin-signal-not-connected"
      />
    </Card>
  );
}

/**
 * How many recent events the overview shows.
 *
 * It was a bare `.slice(0, 25)` in the JSX with nothing on screen saying so,
 * which made the newest 25 read as the activity.
 */
const RECENT_EVENT_ROWS = 25;

export default function AdminDashboardPage() {
  const { addToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [dateRange, setDateRange] = useState<DateRangeKey>("7d");
  const [bundle, setBundle] = useState<AdminBundle | null>(null);

  useEffect(() => {
    const run = async () => {
      try {
        setLoading(true);
        const data = await apiFetch(
          `/v1/admin/analytics/dashboard?dateRange=${dateRange}`,
        );
        setBundle(data ?? null);
      } catch (err) {
        const message =
          toSafeUserError(err, { message: "Failed to load admin dashboard" }).message;
        addToast(message, "error");
      } finally {
        setLoading(false);
      }
    };

    void run();
  }, [addToast, dateRange]);

  // -------------------------------------------------------------------------
  // Top-line metrics — every value below is REAL, read directly from
  // `bundle.summary`. Where a metric is genuinely absent from the bundle
  // (storage total, demo / contact-sales requests, enterprise customers)
  // we pass `value: null` so MetricTile renders an honest "Not measured".
  // -------------------------------------------------------------------------
  const metrics = useMemo(() => {
    if (!bundle) return [];
    const s = bundle.summary;
    return [
      {
        label: "Total Users",
        value: formatCount(s.totalUsers),
        sub: `${formatCount(s.registeredUsers) ?? "not measured"} registered · ${formatCount(s.guestUsers) ?? "not measured"} guests`,
        accent: "#1e3a5f",
      },
      {
        label: "Active Users",
        value: formatCount(s.activeUsers),
        sub: "Registered users seen in analytics events",
        accent: "#1e3a5f",
      },
      {
        label: "Live Workspaces",
        value: formatCount(s.workspaces.total),
        sub: `${formatCount(s.workspaces.active) ?? "not measured"} billing active · ${formatCount(s.workspaces.pastDue) ?? "not measured"} past due`,
        accent: "#1e3a5f",
        href: "/admin/workspaces?lifecycle=LIVE",
      },
      {
        // ADM-009 — an Entitlement is per USER. Labelled for what it counts.
        label: "Team-tier Accounts",
        value: formatCount(s.accountTierBreakdown.team),
        sub: "People holding an active Team entitlement",
        accent: "#1e3a5f",
        href: "/admin/users?tier=TEAM",
      },
      {
        label: "Evidence Created",
        value: formatCount(s.totalEvidence),
        sub: `${formatCount(s.usersWithEvidence) ?? "not measured"} owners with evidence`,
        accent: "#1e3a5f",
      },
      {
        label: "Reports Generated",
        value: formatCount(s.reportsGenerated),
        sub: "Verification reports produced",
        accent: "#1e3a5f",
      },
      // ADM-012 — gross revenue is reported per currency on the Overview and
      // in Billing. A single tile cannot honestly show several currencies, so
      // this one links there instead of picking one and mislabelling it.
      {
        label: "Successful Payments",
        value: formatCount(s.billing.successfulPayments),
        sub: `Across ${s.billing.grossRevenueByCurrency.length} currenc${
          s.billing.grossRevenueByCurrency.length === 1 ? "y" : "ies"
        } — see Billing for totals`,
        accent: "#1e3a5f",
        href: "/admin/billing",
      },
      {
        label: "Active Subscriptions",
        value: formatCount(s.billing.activeSubscriptions),
        sub: `${formatCount(s.billing.trialingSubscriptions) ?? "not measured"} trialing · ${formatCount(s.billing.pastDueSubscriptions) ?? "not measured"} past due`,
        accent: "#1e3a5f",
      },
      {
        // Storage total is NOT part of the analytics bundle — kept honest.
        label: "Storage Used",
        value: null as string | null,
        sub: undefined,
        accent: undefined,
      },
      {
        // Demo / contact-sales requests are a separate admin surface, not in
        // this analytics bundle — kept honest rather than fabricated.
        label: "Demo / Sales Requests",
        value: null as string | null,
        sub: undefined,
        accent: undefined,
      },
    ];
  }, [bundle]);

  const accountTierMix = useMemo(() => {
    if (!bundle) return [];
    const b = bundle.summary.accountTierBreakdown;
    return [
      { label: "Free", value: b.free, tone: "neutral" as BadgeTone },
      { label: "Pay-as-you-go", value: b.payg, tone: "info" as BadgeTone },
      { label: "Pro", value: b.pro, tone: "verified" as BadgeTone },
      { label: "Team", value: b.team, tone: "governance" as BadgeTone },
    ];
  }, [bundle]);

  const evidenceMix = useMemo(() => {
    if (!bundle) return [];
    const e = bundle.summary.evidenceByType;
    return [
      { label: "Photos", value: e.photos, tone: "verified" as BadgeTone },
      { label: "Videos", value: e.videos, tone: "info" as BadgeTone },
      { label: "Documents", value: e.documents, tone: "pending" as BadgeTone },
      { label: "Other", value: e.other, tone: "neutral" as BadgeTone },
    ];
  }, [bundle]);

  const workspaceHealth = useMemo(() => {
    if (!bundle) return [];
    const w = bundle.summary.workspaceHealth;
    const t = bundle.summary.workspaces;
    return [
      { label: "Storage near limit", value: w.storageNearLimitTeams, tone: "pending" as BadgeTone },
      { label: "Storage limit reached", value: w.storageLimitReachedTeams, tone: "risk" as BadgeTone },
      { label: "Seats near limit", value: w.seatNearLimitTeams, tone: "pending" as BadgeTone },
      { label: "Seat limit reached", value: w.seatLimitReachedTeams, tone: "risk" as BadgeTone },
      { label: "Over seat limit", value: t.overSeatLimit, tone: "risk" as BadgeTone },
      { label: "Billing canceled", value: t.canceled, tone: "neutral" as BadgeTone },
    ];
  }, [bundle]);

  const rangeAction = (
    <div
      role="group"
      aria-label="Analytics date range"
      data-testid="admin-date-range"
      style={{
        display: "inline-flex",
        gap: 4,
        padding: 4,
        borderRadius: 12,
        border: "1px solid var(--border-default, rgba(15,23,42,0.09))",
        background: "var(--surface-muted, #f1f4f9)",
      }}
    >
      {DATE_RANGES.map((r) => {
        const active = r.key === dateRange;
        return (
          <button
            key={r.key}
            type="button"
            data-range={r.key}
            aria-pressed={active}
            disabled={loading}
            onClick={() => setDateRange(r.key)}
            style={{
              appearance: "none",
              cursor: loading ? "not-allowed" : "pointer",
              border: "1px solid transparent",
              borderRadius: 9,
              // 44px touch floor: the matrix measured these range switches at
              // 36px, and they are the only way to change what the dashboard
              // shows.
              minHeight: 44,
              padding: "7px 14px",
              fontSize: 13,
              fontWeight: 650,
              color: active ? INK_PRIMARY : INK_SECONDARY,
              background: active ? "var(--surface-card, #ffffff)" : "transparent",
              boxShadow: active
                ? "var(--shadow-card, 0 1px 2px rgba(15,23,42,0.04))"
                : "none",
            }}
          >
            {r.label}
          </button>
        );
      })}
    </div>
  );

  return (
    <PageShell width="full">
      <PageHeader
        eyebrow="Platform admin"
        title="Platform Analytics"
        subtitle="Product activity, geography, funnel and platform events for the selected window — every number is read live from the analytics bundle."
        primaryAction={rangeAction}
      />


      {loading ? (
        <PageSection>
          <div
            style={{
              display: "grid",
              gap: 16,
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            }}
          >
            {Array.from({ length: 8 }).map((_, i) => (
              <Card key={i} padding="comfortable" data-testid="admin-loading-tile">
                <div
                  aria-hidden="true"
                  style={{
                    height: 76,
                    borderRadius: 10,
                    background:
                      "linear-gradient(90deg, #f1f5f9 25%, #e2e8f0 37%, #f1f5f9 63%)",
                    backgroundSize: "400% 100%",
                    animation: "pf-indeterminate-shimmer 1.4s ease infinite",
                  }}
                />
              </Card>
            ))}
          </div>
        </PageSection>
      ) : !bundle ? (
        <PageSection>
          <Card variant="empty" padding="none">
            <EmptyState
              framed
              data-testid="admin-analytics-not-connected"
              title="Analytics not connected"
              purpose="No analytics bundle was returned for this period. Platform analytics are fed by the AnalyticsEvent table — once product events are recorded for this window, top-line metrics, geography, funnel and recent activity will appear here."
            />
          </Card>
        </PageSection>
      ) : (
        <>
          {/* -----------------------------------------------------------------
              Top-line metrics — REAL values from bundle.summary; absent
              signals render an honest "Not measured".
          ------------------------------------------------------------------ */}
          <PageSection
            title="Top-line metrics"
            description="Global platform totals. Values not present in the analytics bundle are shown as “Not measured”, never estimated."
          >
            <div
              data-testid="admin-metric-grid"
              style={{
                display: "grid",
                gap: 16,
                gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              }}
            >
              {metrics.map((m) => (
                <MetricTile
                  key={m.label}
                  label={m.label}
                  value={m.value}
                  sub={m.sub}
                  accent={m.accent}
                  href={"href" in m ? (m as { href?: string }).href : undefined}
                />
              ))}
            </div>
          </PageSection>

          {/* -----------------------------------------------------------------
              Geography — REAL from bundle.geography.countries.
          ------------------------------------------------------------------ */}
          <PageSection
            title="Geography"
            description="Country-level traffic recorded in the AnalyticsEvent table for this window."
          >
            {bundle.geography.countries.length === 0 ? (
              <Card variant="empty" padding="none">
                <EmptyState
                  framed
                  compact
                  data-testid="admin-geography-empty"
                  title="No geographic traffic recorded"
                  purpose="No country-tagged analytics events were captured for the selected period."
                />
              </Card>
            ) : (
              <DataTable
                ariaLabel="Traffic by country"
                columns={[
                  { key: "name", header: "Country", render: (c: GeoItem) => c.name ?? "Region unavailable" },
                  {
                    key: "countryCode",
                    header: "Code",
                    render: (c: GeoItem) => c.countryCode ?? "—",
                    nowrap: true,
                  },
                  {
                    key: "count",
                    header: "Events",
                    align: "right",
                    nowrap: true,
                    render: (c: GeoItem) => formatCount(c.count) ?? "0",
                  },
                  {
                    key: "share",
                    header: "Share",
                    align: "right",
                    nowrap: true,
                    render: (c: GeoItem) =>
                      c.share != null ? `${c.share.toFixed(1)}%` : "—",
                  },
                ]}
                rows={bundle.geography.countries}
                getRowId={(c, i) => `${c.countryCode ?? c.name ?? "row"}-${i}`}
              />
            )}
          </PageSection>

          {/* -----------------------------------------------------------------
              Top pages + Funnel — REAL from bundle.pages / bundle.funnel.
          ------------------------------------------------------------------ */}
          <PageSection title="Traffic & conversion">
            <div
              style={{
                display: "grid",
                gap: 16,
                gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
              }}
            >
              <Card title="Top pages" subtitle="Most-viewed routes in this window." padding="comfortable">
                {bundle.pages.length === 0 ? (
                  <EmptyState
                    compact
                    data-testid="admin-pages-empty"
                    title="No page views recorded"
                    purpose="No page_view events were captured for the selected period."
                  />
                ) : (
                  <DataTable
                    ariaLabel="Top pages"
                    columns={[
                      { key: "path", header: "Route", render: (p: TopPage) => p.path ?? "Path unavailable" },
                      {
                        key: "routeType",
                        header: "Type",
                        nowrap: true,
                        render: (p: TopPage) => (
                          <Badge tone="neutral" subtle>
                            {p.routeType ?? "unspecified"}
                          </Badge>
                        ),
                      },
                      {
                        key: "views",
                        header: "Views",
                        align: "right",
                        nowrap: true,
                        render: (p: TopPage) => formatCount(p.views) ?? "0",
                      },
                      {
                        key: "share",
                        header: "Share",
                        align: "right",
                        nowrap: true,
                        render: (p: TopPage) =>
                          p.share != null ? `${p.share.toFixed(1)}%` : "—",
                      },
                    ]}
                    rows={bundle.pages}
                    getRowId={(p, i) => `${p.path ?? "path"}-${i}`}
                  />
                )}
              </Card>

              <Card
                title="Conversion funnel"
                subtitle="Progression from page views to reports."
                padding="comfortable"
              >
                {bundle.funnel.length === 0 ? (
                  <EmptyState
                    compact
                    data-testid="admin-funnel-empty"
                    title="No funnel data"
                    purpose="No funnel events were captured for the selected period."
                  />
                ) : (
                  <div style={{ display: "grid", gap: 10 }} data-testid="admin-funnel">
                    {bundle.funnel.map((step, idx) => (
                      <div
                        key={step.key}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 12,
                          padding: "12px 14px",
                          borderRadius: 10,
                          border: "1px solid var(--border-subtle, rgba(15,23,42,0.06))",
                          background: "var(--surface-muted, #f1f4f9)",
                        }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 13.5, fontWeight: 650, color: INK_PRIMARY }}>
                            {idx + 1}. {step.label}
                          </div>
                          {/*
                            An UNINSTRUMENTED stage is not a drop-off.
                            This read "0% conversion · 100% drop-off" for a
                            stage whose event nothing emits — reporting a total
                            product collapse where the truth was a missing
                            measurement.
                          */}
                          <div
                            style={{ fontSize: 12, color: INK_SECONDARY, marginTop: 2 }}
                            data-funnel-state={step.measured ? "MEASURED" : "NOT_MEASURED"}
                          >
                            {!step.measured
                              ? (step.notMeasuredReason ??
                                "Not measured — this stage is not instrumented.")
                              : idx === 0
                                ? "Entry step"
                                : step.conversionFromPrevious != null
                                  ? `${step.conversionFromPrevious}% conversion · ${step.dropOffFromPrevious ?? 0}% drop-off`
                                  : "Not comparable — the previous stage was not measured."}
                          </div>
                        </div>
                        <div
                          style={{
                            fontSize: 20,
                            fontWeight: 750,
                            letterSpacing: "-0.02em",
                            color: INK_PRIMARY,
                            flexShrink: 0,
                          }}
                        >
                          {/* No number, rather than a zero standing in for one. */}
                          {step.measured && typeof step.count === "number"
                            ? (formatCount(step.count) ?? "0")
                            : "—"}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>
          </PageSection>

          {/* -----------------------------------------------------------------
              Signals NOT in the analytics bundle — kept explicitly honest.
          ------------------------------------------------------------------ */}
          <PageSection
            title="Additional signals"
            description="These signals are not part of the current analytics bundle and are shown as not connected rather than estimated."
          >
            <div
              style={{
                display: "grid",
                gap: 16,
                gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
              }}
            >
              <NotConnectedCard
                title="Referrers"
                signal="The analytics source does not record referrer attribution for this dashboard."
              />
              <NotConnectedCard
                title="Traffic by source"
                signal="Channel / source breakdown is not configured for this analytics signal."
              />
            </div>
          </PageSection>

          {/* -----------------------------------------------------------------
              Distributions — REAL from bundle.summary.
          ------------------------------------------------------------------ */}
          <PageSection title="Distributions">
            <div
              style={{
                display: "grid",
                gap: 16,
                gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
              }}
            >
              <Card
                title="Account tier mix"
                subtitle="People holding an active entitlement on each tier — accounts, not workspaces."
                padding="comfortable"
              >
                <div style={{ display: "grid", gap: 8 }} data-testid="admin-subscription-mix">
                  {accountTierMix.map((s) => (
                    <StatRow key={s.label} label={s.label} value={s.value} tone={s.tone} />
                  ))}
                </div>
              </Card>

              <Card title="Evidence type mix" subtitle="Stored evidence by media type." padding="comfortable">
                <div style={{ display: "grid", gap: 8 }} data-testid="admin-evidence-mix">
                  {evidenceMix.map((e) => (
                    <StatRow key={e.label} label={e.label} value={e.value} tone={e.tone} />
                  ))}
                </div>
              </Card>

              <Card
                title="Workspace health"
                subtitle="Storage and seat pressure across workspaces."
                padding="comfortable"
              >
                <div style={{ display: "grid", gap: 8 }} data-testid="admin-workspace-health">
                  {workspaceHealth.map((h) => (
                    <StatRow key={h.label} label={h.label} value={h.value} tone={h.tone} />
                  ))}
                </div>
              </Card>
            </div>
          </PageSection>

          {/* -----------------------------------------------------------------
              Recent platform activity — REAL from bundle.recent.
          ------------------------------------------------------------------ */}
          <PageSection
            title="Recent platform activity"
            description="Latest captured product events with route, place, severity and event class."
          >
            {bundle.recent.length === 0 ? (
              <Card variant="empty" padding="none">
                <EmptyState
                  framed
                  compact
                  data-testid="admin-recent-empty"
                  title="No recent activity"
                  purpose="No analytics events were captured for the selected period."
                />
              </Card>
            ) : (
              <DataTable
                ariaLabel="Recent platform activity"
                columns={[
                  {
                    key: "label",
                    header: "Event",
                    render: (e: RecentEvent) => (
                      <span style={{ fontWeight: 600, color: INK_PRIMARY }}>
                        {e.label ?? e.eventType}
                      </span>
                    ),
                  },
                  {
                    key: "severity",
                    header: "Severity",
                    nowrap: true,
                    render: (e: RecentEvent) => (
                      <Badge tone={eventSeverityTone(e.severity)} subtle>
                        {e.severity ?? "info"}
                      </Badge>
                    ),
                  },
                  {
                    key: "path",
                    header: "Route",
                    render: (e: RecentEvent) => e.path ?? "No path",
                  },
                  {
                    key: "location",
                    header: "Location",
                    render: (e: RecentEvent) => e.city ?? e.country ?? "No location",
                  },
                  {
                    key: "createdAt",
                    header: "When",
                    nowrap: true,
                    render: (e: RecentEvent) => formatTimestamp(e.createdAt),
                  },
                ]}
                rows={bundle.recent.slice(0, RECENT_EVENT_ROWS)}
                getRowId={(e, i) => `${e.eventType}-${e.createdAt}-${i}`}
              />
            )}
            {/* The slice is the PAGE's, so the page owns the disclosure. It
                was a bare `.slice(0, 25)` with nothing on screen saying so. */}
            <ResultCount
              shown={Math.min(bundle.recent.length, RECENT_EVENT_ROWS)}
              cap={RECENT_EVENT_ROWS}
              noun="recent event"
              data-testid="admin-dashboard-recent-count"
            />
          </PageSection>
        </>
      )}
    </PageShell>
  );
}
