"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, Skeleton } from "../../../../components/ui";
import { apiFetch } from "../../../../lib/api";
import { useToast } from "../../../../components/ui";
import DashboardShell from "../../../../components/dashboard/DashboardShell";
import { dashboardStyles } from "../../../../components/dashboard/styles";

type AdminSummary = {
  totalUsers: number;
  registeredUsers: number;
  guestUsers: number;
  activeUsers: number;
  usersWithEvidence: number;
  totalEvidence: number;
  reportsGenerated: number;
  subscriptionBreakdown: {
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
    grossRevenueCents: number;
  };
  teams: {
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
  count: number;
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

function formatTimestamp(value: string) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

function formatMoneyCents(cents: number) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format((cents || 0) / 100);
}

function pillTone(kind: "green" | "gold" | "red" | "neutral") {
  if (kind === "green") {
    return {
      border: "1px solid rgba(79,112,107,0.16)",
      background:
        "linear-gradient(180deg, rgba(191,232,223,0.18) 0%, rgba(255,255,255,0.44) 100%)",
      color: "#2d5b59",
    } as const;
  }

  if (kind === "gold") {
    return {
      border: "1px solid rgba(183,157,132,0.20)",
      background:
        "linear-gradient(180deg, rgba(214,184,157,0.14) 0%, rgba(255,255,255,0.44) 100%)",
      color: "#8a6e57",
    } as const;
  }

  if (kind === "red") {
    return {
      border: "1px solid rgba(194,78,78,0.20)",
      background:
        "linear-gradient(180deg, rgba(164,84,84,0.14) 0%, rgba(255,255,255,0.44) 100%)",
      color: "#965757",
    } as const;
  }

  return {
    border: "1px solid rgba(79,112,107,0.10)",
    background:
      "linear-gradient(180deg, rgba(250,251,249,0.82) 0%, rgba(241,244,241,0.96) 100%)",
    color: "#54676b",
  } as const;
}

function eventSeverityTone(severity?: string | null) {
  const value = (severity ?? "").toLowerCase();
  if (value === "high" || value === "critical") return pillTone("red");
  if (value === "medium" || value === "warning") return pillTone("gold");
  return pillTone("green");
}

export default function AdminDashboardPage() {
  const { addToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [bundle, setBundle] = useState<AdminBundle | null>(null);

  useEffect(() => {
    const run = async () => {
      try {
        setLoading(true);
        const data = await apiFetch("/v1/admin/analytics/dashboard?dateRange=7d");
        setBundle(data ?? null);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to load admin dashboard";
        addToast(message, "error");
      } finally {
        setLoading(false);
      }
    };

    void run();
  }, [addToast]);

  const overviewCards = useMemo(() => {
    if (!bundle) return [];

    return [
      {
        label: "Total Users",
        value: bundle.summary.totalUsers,
        sub: `${bundle.summary.registeredUsers} registered · ${bundle.summary.guestUsers} guests`,
        accent: "#2d5b59",
      },
      {
        label: "Active Users",
        value: bundle.summary.activeUsers,
        sub: "Analytics active registered users",
        accent: "#4c6d70",
      },
      {
        label: "Total Evidence",
        value: bundle.summary.totalEvidence,
        sub: `${bundle.summary.usersWithEvidence} owners with evidence`,
        accent: "#8a6e57",
      },
      {
        label: "Reports Generated",
        value: bundle.summary.reportsGenerated,
        sub: "Generated verification reports",
        accent: "#7a6170",
      },
    ];
  }, [bundle]);

  const topEvidenceTypes = useMemo(() => {
    if (!bundle) return [];

    return [
      { label: "Photos", value: bundle.summary.evidenceByType.photos, tone: "green" as const },
      { label: "Videos", value: bundle.summary.evidenceByType.videos, tone: "neutral" as const },
      { label: "Documents", value: bundle.summary.evidenceByType.documents, tone: "gold" as const },
      { label: "Other", value: bundle.summary.evidenceByType.other, tone: "red" as const },
    ];
  }, [bundle]);

  const subscriptionCards = useMemo(() => {
    if (!bundle) return [];

    return [
      { label: "Free", value: bundle.summary.subscriptionBreakdown.free, tone: "neutral" as const },
      { label: "Payg", value: bundle.summary.subscriptionBreakdown.payg, tone: "gold" as const },
      { label: "Pro", value: bundle.summary.subscriptionBreakdown.pro, tone: "green" as const },
      { label: "Team", value: bundle.summary.subscriptionBreakdown.team, tone: "red" as const },
    ];
  }, [bundle]);

  const billingCards = useMemo(() => {
    if (!bundle) return [];

    return [
      {
        label: "Active Subscriptions",
        value: bundle.summary.billing.activeSubscriptions,
        sub: `${bundle.summary.billing.trialingSubscriptions} trialing · ${bundle.summary.billing.pastDueSubscriptions} past due`,
        accent: "#2d5b59",
      },
      {
        label: "Gross Revenue",
        value: formatMoneyCents(bundle.summary.billing.grossRevenueCents),
        sub: `${bundle.summary.billing.successfulPayments} successful payments`,
        accent: "#8a6e57",
      },
      {
        label: "Payment Failures",
        value: bundle.summary.billing.failedPayments,
        sub: `${bundle.summary.billing.refundedPayments} refunded payments`,
        accent: "#965757",
      },
      {
        label: "Team Workspaces",
        value: bundle.summary.teams.total,
        sub: `${bundle.summary.teams.active} active · ${bundle.summary.teams.pastDue} past due`,
        accent: "#4c6d70",
      },
    ];
  }, [bundle]);

  const healthCards = useMemo(() => {
    if (!bundle) return [];

    return [
      {
        label: "Storage Near Limit",
        value: bundle.summary.workspaceHealth.storageNearLimitTeams,
        tone: "gold" as const,
      },
      {
        label: "Storage Limit Reached",
        value: bundle.summary.workspaceHealth.storageLimitReachedTeams,
        tone: "red" as const,
      },
      {
        label: "Seat Pressure",
        value: bundle.summary.workspaceHealth.seatNearLimitTeams,
        tone: "gold" as const,
      },
      {
        label: "Seat Limit Reached",
        value: bundle.summary.workspaceHealth.seatLimitReachedTeams,
        tone: "red" as const,
      },
      {
        label: "Over Seat Limit",
        value: bundle.summary.teams.overSeatLimit,
        tone: "red" as const,
      },
      {
        label: "Canceled Teams",
        value: bundle.summary.teams.canceled,
        tone: "neutral" as const,
      },
    ];
  }, [bundle]);

  const statPillBase = useMemo(
    () =>
      ({
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: 32,
        padding: "6px 12px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 800,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        maxWidth: "100%",
        textAlign: "center",
        overflowWrap: "anywhere",
        wordBreak: "break-word",
      }) as const,
    []
  );

  return (
    <DashboardShell
      eyebrow="Admin Dashboard"
      title="Executive analytics and"
      highlight="platform visibility."
      description={
        <>
          Review global product activity, funnel performance, geography, top routes,
          billing health, workspace pressure, and recent platform events from one
          admin dashboard.
        </>
      }
    >
      <style jsx global>{`
        .admin-dashboard-page {
          display: grid;
          gap: 18px;
        }

        .admin-dashboard-page .admin-grid-4 {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 18px;
        }

        .admin-dashboard-page .admin-grid-3 {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 18px;
        }

        .admin-dashboard-page .admin-grid-2 {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 18px;
        }

        .admin-dashboard-page .admin-card {
          position: relative;
          overflow: hidden;
          border-radius: 30px;
          border: 1px solid rgba(79, 112, 107, 0.16);
          background: transparent;
          box-shadow:
            0 18px 38px rgba(0, 0, 0, 0.08),
            inset 0 1px 0 rgba(255, 255, 255, 0.48);
        }

        .admin-dashboard-page .admin-card-overlay {
          position: absolute;
          inset: 0;
          background:
            linear-gradient(
              180deg,
              rgba(255, 255, 255, 0.24) 0%,
              rgba(248, 249, 246, 0.34) 42%,
              rgba(239, 241, 238, 0.42) 100%
            );
        }

        .admin-dashboard-page .admin-card-shine {
          position: absolute;
          inset: 0;
          background: radial-gradient(
            circle at 16% 12%,
            rgba(255, 255, 255, 0.34),
            transparent 28%
          );
          opacity: 0.9;
        }

        .admin-dashboard-page .admin-card-inner {
          position: relative;
          z-index: 10;
          padding: 24px;
          min-width: 0;
        }

        .admin-dashboard-page .admin-card-title {
          font-size: 1.08rem;
          font-weight: 700;
          letter-spacing: -0.02em;
          color: #21353a;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .admin-dashboard-page .admin-card-copy {
          margin-top: 8px;
          color: #5d6d71;
          line-height: 1.7;
          font-size: 0.94rem;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .admin-dashboard-page .admin-summary-card {
          min-height: 166px;
        }

        .admin-dashboard-page .admin-summary-label {
          font-size: 0.8rem;
          font-weight: 700;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: #718186;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .admin-dashboard-page .admin-summary-value {
          margin-top: 12px;
          font-size: 2.1rem;
          line-height: 1;
          font-weight: 800;
          letter-spacing: -0.05em;
          color: #21353a;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .admin-dashboard-page .admin-summary-sub {
          margin-top: 12px;
          font-size: 0.84rem;
          color: #68787d;
          line-height: 1.65;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .admin-dashboard-page .admin-stack {
          display: grid;
          gap: 12px;
          margin-top: 18px;
        }

        .admin-dashboard-page .admin-soft-row {
          border: 1px solid rgba(79, 112, 107, 0.1);
          background:
            linear-gradient(
              180deg,
              rgba(255, 255, 255, 0.58) 0%,
              rgba(243, 245, 242, 0.9) 100%
            );
          border-radius: 22px;
          padding: 16px;
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.42),
            0 12px 26px rgba(0, 0, 0, 0.06);
          min-width: 0;
        }

        .admin-dashboard-page .admin-soft-row-tight {
          border: 1px solid rgba(79, 112, 107, 0.1);
          background:
            linear-gradient(
              180deg,
              rgba(255, 255, 255, 0.58) 0%,
              rgba(243, 245, 242, 0.9) 100%
            );
          border-radius: 20px;
          padding: 14px;
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.42),
            0 12px 26px rgba(0, 0, 0, 0.06);
          min-width: 0;
        }

        .admin-dashboard-page .admin-row-between {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 12px;
          min-width: 0;
        }

        .admin-dashboard-page .admin-item-title {
          font-size: 0.92rem;
          font-weight: 700;
          color: #21353a;
          line-height: 1.45;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .admin-dashboard-page .admin-item-sub {
          font-size: 0.8rem;
          color: #6e7e83;
          line-height: 1.6;
          margin-top: 4px;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .admin-dashboard-page .admin-item-value {
          font-size: 1.35rem;
          font-weight: 800;
          color: #2d5b59;
          letter-spacing: -0.04em;
          white-space: nowrap;
          flex-shrink: 0;
        }

        .admin-dashboard-page .admin-mini-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 12px;
          margin-top: 18px;
        }

        .admin-dashboard-page .admin-mini-stat {
          border: 1px solid rgba(183, 157, 132, 0.14);
          background: linear-gradient(
            135deg,
            rgba(214, 184, 157, 0.1),
            rgba(255, 255, 255, 0.36)
          );
          border-radius: 18px;
          padding: 14px;
          min-width: 0;
        }

        .admin-dashboard-page .admin-mini-label {
          font-size: 0.75rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.12em;
          color: #7b6a5d;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .admin-dashboard-page .admin-mini-value {
          margin-top: 8px;
          font-size: 1.45rem;
          font-weight: 800;
          letter-spacing: -0.04em;
          color: #8a6e57;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        @media (max-width: 1200px) {
          .admin-dashboard-page .admin-grid-4 {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }

          .admin-dashboard-page .admin-grid-3 {
            grid-template-columns: 1fr;
          }
        }

        @media (max-width: 900px) {
          .admin-dashboard-page .admin-grid-2,
          .admin-dashboard-page .admin-grid-4 {
            grid-template-columns: 1fr;
          }

          .admin-dashboard-page .admin-card-inner {
            padding: 20px;
          }

          .admin-dashboard-page .admin-row-between {
            flex-wrap: wrap;
          }
        }

        @media (max-width: 720px) {
          .admin-dashboard-page .admin-item-value {
            white-space: normal;
          }
        }

        @media (max-width: 640px) {
          .admin-dashboard-page .admin-mini-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>

      {loading ? (
        <div className="admin-dashboard-page">
          <Card className="admin-card" style={dashboardStyles.outerCard}>
            <div className="admin-card-inner">
              <Skeleton width="100%" height="220px" />
            </div>
          </Card>
          <Card className="admin-card" style={dashboardStyles.outerCard}>
            <div className="admin-card-inner">
              <Skeleton width="100%" height="220px" />
            </div>
          </Card>
        </div>
      ) : !bundle ? (
        <Card className="admin-card" style={dashboardStyles.outerCard}>
          <div className="absolute inset-0">
            <img
              src="/images/panel-silver.webp.png"
              alt=""
              className="h-full w-full object-cover object-center"
            />
          </div>
          <div className="admin-card-overlay" />
          <div className="admin-card-shine" />
          <div className="admin-card-inner">
            <div className="admin-card-title">No admin analytics data available</div>
            <div className="admin-card-copy">
              The dashboard could not load any analytics bundle for the selected period.
            </div>
          </div>
        </Card>
      ) : (
        <div className="admin-dashboard-page">
          <div className="admin-grid-4">
            {overviewCards.map((item) => (
              <Card
                key={item.label}
                className="admin-card admin-summary-card"
                style={dashboardStyles.outerCard}
              >
                <div className="absolute inset-0">
                  <img
                    src="/images/panel-silver.webp.png"
                    alt=""
                    className="h-full w-full object-cover object-center"
                  />
                </div>
                <div className="admin-card-overlay" />
                <div className="admin-card-shine" />
                <div className="admin-card-inner">
                  <div className="admin-summary-label">{item.label}</div>
                  <div className="admin-summary-value" style={{ color: item.accent }}>
                    {item.value}
                  </div>
                  <div className="admin-summary-sub">{item.sub}</div>
                </div>
              </Card>
            ))}
          </div>

          <div className="admin-grid-4">
            {billingCards.map((item) => (
              <Card
                key={item.label}
                className="admin-card admin-summary-card"
                style={dashboardStyles.outerCard}
              >
                <div className="absolute inset-0">
                  <img
                    src="/images/panel-silver.webp.png"
                    alt=""
                    className="h-full w-full object-cover object-center"
                  />
                </div>
                <div className="admin-card-overlay" />
                <div className="admin-card-shine" />
                <div className="admin-card-inner">
                  <div className="admin-summary-label">{item.label}</div>
                  <div className="admin-summary-value" style={{ color: item.accent }}>
                    {item.value}
                  </div>
                  <div className="admin-summary-sub">{item.sub}</div>
                </div>
              </Card>
            ))}
          </div>

          <div className="admin-grid-3">
            {healthCards.map((item) => (
              <Card key={item.label} className="admin-card" style={dashboardStyles.outerCard}>
                <div className="absolute inset-0">
                  <img
                    src="/images/panel-silver.webp.png"
                    alt=""
                    className="h-full w-full object-cover object-center"
                  />
                </div>
                <div className="admin-card-overlay" />
                <div className="admin-card-shine" />
                <div className="admin-card-inner">
                  <div className="admin-item-title">{item.label}</div>
                  <div
                    style={{
                      ...statPillBase,
                      ...pillTone(item.tone),
                      marginTop: 14,
                      minHeight: 38,
                      padding: "8px 16px",
                    }}
                  >
                    {item.value}
                  </div>
                </div>
              </Card>
            ))}
          </div>

          <div className="admin-grid-2">
            <Card className="admin-card" style={dashboardStyles.outerCard}>
              <div className="absolute inset-0">
                <img
                  src="/images/panel-silver.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center"
                />
              </div>
              <div className="admin-card-overlay" />
              <div className="admin-card-shine" />
              <div className="admin-card-inner">
                <div className="admin-card-title">Funnel</div>
                <div className="admin-card-copy">
                  Follow progression from entry to later steps and quickly spot where
                  conversion weakens or drop-off increases.
                </div>

                <div className="admin-stack">
                  {bundle.funnel.map((step, idx) => (
                    <div key={step.key} className="admin-soft-row">
                      <div className="admin-row-between">
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div className="admin-item-title">
                            {idx + 1}. {step.label}
                          </div>
                          <div className="admin-item-sub">
                            {idx === 0
                              ? "Entry step"
                              : `Conversion ${step.conversionFromPrevious ?? 0}% · Drop-off ${step.dropOffFromPrevious ?? 0}%`}
                          </div>
                        </div>
                        <div className="admin-item-value">{step.count}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>

            <Card className="admin-card" style={dashboardStyles.outerCard}>
              <div className="absolute inset-0">
                <img
                  src="/images/panel-silver.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center"
                />
              </div>
              <div className="admin-card-overlay" />
              <div className="admin-card-shine" />
              <div className="admin-card-inner">
                <div className="admin-card-title">Top Pages</div>
                <div className="admin-card-copy">
                  The most viewed routes in the current range, including their route type
                  and overall share of traffic.
                </div>

                <div className="admin-stack">
                  {bundle.pages.slice(0, 8).map((page, idx) => (
                    <div key={`${page.path}-${idx}`} className="admin-soft-row">
                      <div className="admin-row-between">
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div className="admin-item-title">{page.path ?? "Unknown"}</div>
                          <div className="admin-item-sub">
                            {page.routeType ?? "unknown"} · {page.share?.toFixed(1) ?? "0.0"}%
                            share
                          </div>
                        </div>
                        <div className="admin-item-value" style={{ color: "#8a6e57" }}>
                          {page.views}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          </div>

          <div className="admin-grid-2">
            <Card className="admin-card" style={dashboardStyles.outerCard}>
              <div className="absolute inset-0">
                <img
                  src="/images/panel-silver.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center"
                />
              </div>
              <div className="admin-card-overlay" />
              <div className="admin-card-shine" />
              <div className="admin-card-inner">
                <div className="admin-card-title">Geography</div>
                <div className="admin-card-copy">
                  Country-level traffic distribution for the selected dashboard range.
                </div>

                <div className="admin-stack">
                  {bundle.geography.countries.slice(0, 5).map((country, idx) => (
                    <div key={`${country.countryCode}-${idx}`} className="admin-soft-row">
                      <div className="admin-row-between">
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div className="admin-item-title">{country.name ?? "Unknown"}</div>
                          <div className="admin-item-sub">
                            {country.countryCode ?? "—"} ·{" "}
                            {country.share?.toFixed(1) ?? "0.0"}% share
                          </div>
                        </div>
                        <div className="admin-item-value">{country.count}</div>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="admin-mini-grid">
                  {bundle.geography.cities.slice(0, 4).map((city, idx) => (
                    <div
                      key={`${city.normalized ?? city.name}-${idx}`}
                      className="admin-mini-stat"
                    >
                      <div className="admin-mini-label">{city.name ?? "Unknown city"}</div>
                      <div className="admin-mini-value">{city.count}</div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>

            <Card className="admin-card" style={dashboardStyles.outerCard}>
              <div className="absolute inset-0">
                <img
                  src="/images/panel-silver.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center"
                />
              </div>
              <div className="admin-card-overlay" />
              <div className="admin-card-shine" />
              <div className="admin-card-inner">
                <div className="admin-card-title">Recent Platform Activity</div>
                <div className="admin-card-copy">
                  Latest captured product events with route, place, timestamp, severity,
                  and event class context.
                </div>

                <div className="admin-stack">
                  {bundle.recent.slice(0, 8).map((event, idx) => (
                    <div
                      key={`${event.eventType}-${event.createdAt}-${idx}`}
                      className="admin-soft-row"
                    >
                      <div className="admin-row-between">
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div className="admin-item-title">
                            {event.label ?? event.eventType}
                          </div>

                          <div
                            style={{
                              display: "flex",
                              flexWrap: "wrap",
                              gap: 8,
                              marginTop: 8,
                            }}
                          >
                            <span
                              style={{
                                ...statPillBase,
                                ...eventSeverityTone(event.severity),
                              }}
                            >
                              {event.severity ?? "info"}
                            </span>

                            {event.routeType ? (
                              <span
                                style={{
                                  ...statPillBase,
                                  ...pillTone("neutral"),
                                }}
                              >
                                {event.routeType}
                              </span>
                            ) : null}

                            {event.eventClass ? (
                              <span
                                style={{
                                  ...statPillBase,
                                  ...pillTone("gold"),
                                }}
                              >
                                {event.eventClass}
                              </span>
                            ) : null}
                          </div>

                          <div className="admin-item-sub" style={{ marginTop: 10 }}>
                            {event.path ?? "No path"} ·{" "}
                            {event.city ?? event.country ?? "No location"}
                          </div>
                          <div className="admin-item-sub">
                            {formatTimestamp(event.createdAt)}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          </div>

          <div className="admin-grid-2">
            <Card className="admin-card" style={dashboardStyles.outerCard}>
              <div className="absolute inset-0">
                <img
                  src="/images/panel-silver.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center"
                />
              </div>
              <div className="admin-card-overlay" />
              <div className="admin-card-shine" />
              <div className="admin-card-inner">
                <div className="admin-card-title">Subscription Mix</div>
                <div className="admin-card-copy">
                  Current account distribution by subscription tier.
                </div>

                <div className="admin-stack">
                  {subscriptionCards.map((item) => (
                    <div key={item.label} className="admin-soft-row-tight">
                      <div className="admin-row-between">
                        <div className="admin-item-title">{item.label}</div>
                        <div
                          style={{
                            ...statPillBase,
                            ...pillTone(item.tone),
                            minHeight: 34,
                            padding: "7px 14px",
                          }}
                        >
                          {item.value}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="admin-mini-grid">
                  <div className="admin-mini-stat">
                    <div className="admin-mini-label">Active Subs</div>
                    <div className="admin-mini-value">
                      {bundle.summary.billing.activeSubscriptions}
                    </div>
                  </div>
                  <div className="admin-mini-stat">
                    <div className="admin-mini-label">Canceled Subs</div>
                    <div className="admin-mini-value">
                      {bundle.summary.billing.canceledSubscriptions}
                    </div>
                  </div>
                </div>
              </div>
            </Card>

            <Card className="admin-card" style={dashboardStyles.outerCard}>
              <div className="absolute inset-0">
                <img
                  src="/images/panel-silver.webp.png"
                  alt=""
                  className="h-full w-full object-cover object-center"
                />
              </div>
              <div className="admin-card-overlay" />
              <div className="admin-card-shine" />
              <div className="admin-card-inner">
                <div className="admin-card-title">Evidence Type Mix</div>
                <div className="admin-card-copy">
                  Breakdown of stored evidence by type across the platform.
                </div>

                <div className="admin-stack">
                  {topEvidenceTypes.map((item) => (
                    <div key={item.label} className="admin-soft-row-tight">
                      <div className="admin-row-between">
                        <div className="admin-item-title">{item.label}</div>
                        <div
                          style={{
                            ...statPillBase,
                            ...pillTone(item.tone),
                            minHeight: 34,
                            padding: "7px 14px",
                          }}
                        >
                          {item.value}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="admin-mini-grid">
                  <div className="admin-mini-stat">
                    <div className="admin-mini-label">Users With Evidence</div>
                    <div className="admin-mini-value">
                      {bundle.summary.usersWithEvidence}
                    </div>
                  </div>
                  <div className="admin-mini-stat">
                    <div className="admin-mini-label">Guest Users</div>
                    <div className="admin-mini-value">{bundle.summary.guestUsers}</div>
                  </div>
                </div>
              </div>
            </Card>
          </div>
        </div>
      )}
    </DashboardShell>
  );
}