"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Card, Button, Skeleton, useToast } from "../../../components/ui";
import { apiFetch } from "../../../lib/api";
import { dashboardStyles } from "../../../components/dashboard/styles";

const ADMIN_NAV = [
  { href: "/admin", label: "Console Home" },
  { href: "/admin/dashboard", label: "Platform Analytics" },
  { href: "/admin/audit", label: "Audit Integrity" },
  { href: "/admin/demo-requests", label: "Demo Requests" },
] as const;

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

type GeographyItem = {
  name: string | null;
  count: number;
  share?: number;
  countryCode?: string | null;
  normalized?: string | null;
};

type GeographyResponse = {
  total?: number;
  countries: GeographyItem[];
  cities: GeographyItem[];
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

export default function AdminPage() {
  const pathname = usePathname();
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
          err instanceof Error ? err.message : "Failed to load admin console";
        addToast(message, "error");
        setBundle(null);
      } finally {
        setLoading(false);
      }
    };

    void run();
  }, [addToast]);

  const cards = useMemo(() => {
    const summary = bundle?.summary;

    return [
      {
        href: "/admin/dashboard",
        title: "Admin Dashboard",
        body:
          summary != null
            ? `${summary.totalUsers} users, ${summary.totalEvidence} evidence items, ${summary.reportsGenerated} reports, and ${summary.billing.activeSubscriptions} active subscriptions visible from one analytics surface.`
            : "Global analytics, funnel visibility, geography, top routes, billing health, and recent platform activity.",
        accent: "#2d5b59",
        eyebrow: "Analytics",
        meta: summary
          ? [
              { label: "Users", value: summary.totalUsers, tone: "green" as const },
              {
                label: "Revenue",
                value: formatMoneyCents(summary.billing.grossRevenueCents),
                tone: "gold" as const,
              },
            ]
          : [],
      },
      {
        href: "/admin/audit",
        title: "Audit Console",
        body:
          summary != null
            ? `${summary.workspaceHealth.storageLimitReachedTeams} storage-critical teams, ${summary.workspaceHealth.seatLimitReachedTeams} seat-critical teams, and privileged action review from the tamper-evident audit chain.`
            : "Tamper-evident administrative audit log, integrity verification, and privileged action review.",
        accent: "#8a6e57",
        eyebrow: "Integrity",
        meta: summary
          ? [
              {
                label: "Storage Risk",
                value: summary.workspaceHealth.storageLimitReachedTeams,
                tone: "red" as const,
              },
              {
                label: "Seat Risk",
                value: summary.workspaceHealth.seatLimitReachedTeams,
                tone: "gold" as const,
              },
            ]
          : [],
      },
      {
        href: "/admin/demo-requests",
        title: "Demo Requests",
        body:
          summary != null
            ? `${summary.teams.total} team workspaces, ${summary.teams.active} active billed teams, and a controlled path for reviewing inbound commercial demand alongside platform growth.`
            : "Review inbound demo requests, inspect source context, assess spam signals, and move qualified leads through the internal pipeline.",
        accent: "#2f6965",
        eyebrow: "Pipeline",
        meta: summary
          ? [
              {
                label: "Teams",
                value: summary.teams.total,
                tone: "neutral" as const,
              },
              {
                label: "Past Due",
                value: summary.teams.pastDue,
                tone: "red" as const,
              },
            ]
          : [],
      },
    ] as const;
  }, [bundle]);

  const headlineStats = useMemo(() => {
    const summary = bundle?.summary;

    return {
      modules: cards.length,
      routes: ADMIN_NAV.length,
      totalUsers: summary?.totalUsers ?? 0,
      totalEvidence: summary?.totalEvidence ?? 0,
      activeSubscriptions: summary?.billing.activeSubscriptions ?? 0,
      activeTeams: summary?.teams.active ?? 0,
      overSeatLimit: summary?.teams.overSeatLimit ?? 0,
      storageRisk:
        (summary?.workspaceHealth.storageLimitReachedTeams ?? 0) +
        (summary?.workspaceHealth.storageNearLimitTeams ?? 0),
    };
  }, [bundle, cards.length]);

  return (
    <div className="admin-console-page">
      <style jsx global>{`
        .admin-console-page .admin-shell {
          display: grid;
          gap: 18px;
          padding-bottom: 72px;
        }

        .admin-console-page .admin-nav-row {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
        }

        .admin-console-page .admin-summary-grid {
          display: grid;
          grid-template-columns: minmax(0, 1.08fr) minmax(0, 0.92fr);
          gap: 18px;
          align-items: stretch;
        }

        .admin-console-page .admin-cards-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 18px;
        }

        .admin-console-page .admin-card {
          position: relative;
          overflow: hidden;
          border-radius: 30px;
          border: 1px solid rgba(79, 112, 107, 0.16);
          background: transparent;
          box-shadow:
            0 18px 38px rgba(0, 0, 0, 0.08),
            inset 0 1px 0 rgba(255, 255, 255, 0.48);
        }

        .admin-console-page .admin-card-overlay {
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

        .admin-console-page .admin-card-shine {
          position: absolute;
          inset: 0;
          background: radial-gradient(
            circle at 16% 12%,
            rgba(255, 255, 255, 0.34),
            transparent 28%
          );
          opacity: 0.9;
        }

        .admin-console-page .admin-card-inner {
          position: relative;
          z-index: 10;
          padding: 24px;
          height: 100%;
          display: flex;
          flex-direction: column;
          min-width: 0;
        }

        .admin-console-page .admin-card-title {
          font-size: 1.08rem;
          font-weight: 700;
          letter-spacing: -0.02em;
          color: #21353a;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .admin-console-page .admin-card-copy {
          margin-top: 8px;
          color: #5d6d71;
          line-height: 1.7;
          font-size: 0.94rem;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .admin-console-page .admin-card-eyebrow {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          min-height: 30px;
          padding: 6px 12px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          border: 1px solid rgba(183, 157, 132, 0.16);
          background:
            linear-gradient(
              180deg,
              rgba(214, 184, 157, 0.12) 0%,
              rgba(255, 255, 255, 0.44) 100%
            );
          color: #8a6e57;
          width: fit-content;
          max-width: 100%;
        }

        .admin-console-page .admin-dot {
          width: 7px;
          height: 7px;
          border-radius: 999px;
          background: #b79d84;
          flex-shrink: 0;
        }

        .admin-console-page .admin-hero-note {
          border: 1px solid rgba(183, 157, 132, 0.14);
          background: linear-gradient(
            135deg,
            rgba(214, 184, 157, 0.1),
            rgba(255, 255, 255, 0.36)
          );
          border-radius: 22px;
          padding: 18px;
          min-width: 0;
        }

        .admin-console-page .admin-hero-note-title {
          font-size: 0.82rem;
          font-weight: 800;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: #7b6a5d;
        }

        .admin-console-page .admin-hero-note-value {
          margin-top: 10px;
          font-size: 1.9rem;
          line-height: 1;
          font-weight: 800;
          letter-spacing: -0.05em;
          color: #8a6e57;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .admin-console-page .admin-hero-note-copy {
          margin-top: 10px;
          font-size: 0.85rem;
          line-height: 1.65;
          color: #6f665d;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .admin-console-page .admin-note-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 12px;
          margin-top: 18px;
        }

        .admin-console-page .admin-card-actions {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          margin-top: auto;
          padding-top: 18px;
        }

        .admin-console-page .admin-card-link {
          text-decoration: none;
        }

        .admin-console-page .admin-card-meta-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 12px;
          margin-top: 18px;
        }

        .admin-console-page .admin-card-meta-pill {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 34px;
          padding: 8px 14px;
          border-radius: 999px;
          font-size: 0.82rem;
          font-weight: 800;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          text-align: center;
        }

        @media (max-width: 980px) {
          .admin-console-page .admin-summary-grid,
          .admin-console-page .admin-cards-grid {
            grid-template-columns: 1fr;
          }
        }

        @media (max-width: 720px) {
          .admin-console-page .admin-card-inner {
            padding: 20px;
          }

          .admin-console-page .admin-nav-row {
            display: grid;
            grid-template-columns: 1fr;
            gap: 10px;
          }

          .admin-console-page .admin-nav-row a,
          .admin-console-page .admin-nav-row a > * {
            width: 100%;
          }

          .admin-console-page .admin-card-actions {
            flex-direction: column;
            align-items: stretch;
          }

          .admin-console-page .admin-card-actions a,
          .admin-console-page .admin-card-actions a > * {
            width: 100%;
          }

          .admin-console-page .admin-card-meta-grid {
            grid-template-columns: 1fr;
          }
        }

        @media (max-width: 640px) {
          .admin-console-page .admin-note-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>

      <div className="app-hero app-hero-full">
        <div className="container">
          <div className="page-title app-page-title" style={{ marginBottom: 0 }}>
            <div style={{ maxWidth: 860 }}>
              <div style={dashboardStyles.heroChip}>
                <span style={dashboardStyles.heroDot} />
                Admin Console
              </div>

              <h1 className="mt-5 max-w-[820px] text-[1.72rem] font-medium leading-[1.01] tracking-[-0.045em] text-[#edf1ef] md:text-[2.28rem] lg:text-[2.95rem]">
                Global operations, audit, and
                <span className="text-[#bfe8df]"> platform visibility</span>.
              </h1>

              <p className="mt-5 max-w-[780px] text-[0.98rem] leading-[1.82] text-[#c7cfcc]">
                Use the admin console to review platform-wide analytics, billing posture,
                audit integrity, route activity, and operational oversight from one
                controlled surface.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="app-body app-body-full">
        <div className="container admin-shell">
          <div className="admin-nav-row">
            {ADMIN_NAV.map((item) => {
              const active = pathname === item.href;

              return (
                <Link key={item.href} href={item.href} className="admin-card-link">
                  <Button
                    className="app-responsive-btn rounded-[999px] border px-5 py-2.5 text-[0.88rem] font-semibold"
                    style={
                      active
                        ? dashboardStyles.primaryButton
                        : dashboardStyles.secondaryButton
                    }
                  >
                    {item.label}
                  </Button>
                </Link>
              );
            })}
          </div>

          {loading ? (
            <div className="admin-summary-grid">
              <Card className="admin-card" style={dashboardStyles.outerCard}>
                <div className="admin-card-inner">
                  <Skeleton width="100%" height="250px" />
                </div>
              </Card>
              <Card className="admin-card" style={dashboardStyles.outerCard}>
                <div className="admin-card-inner">
                  <Skeleton width="100%" height="250px" />
                </div>
              </Card>
            </div>
          ) : (
            <div className="admin-summary-grid">
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
                  <div className="admin-card-title">Admin entry point</div>
                  <div className="admin-card-copy">
                    Move between analytics, audit oversight, and commercial admin
                    workflows from one clean control surface with live platform totals.
                  </div>

                  <div className="admin-note-grid">
                    <div className="admin-hero-note">
                      <div className="admin-hero-note-title">Modules</div>
                      <div className="admin-hero-note-value">
                        {headlineStats.modules}
                      </div>
                      <div className="admin-hero-note-copy">
                        Analytics, audit integrity, and demo request operations are
                        available from here.
                      </div>
                    </div>

                    <div className="admin-hero-note">
                      <div className="admin-hero-note-title">Admin Routes</div>
                      <div className="admin-hero-note-value">
                        {headlineStats.routes}
                      </div>
                      <div className="admin-hero-note-copy">
                        Navigate quickly across console home, dashboard, audit, and demo
                        request pages.
                      </div>
                    </div>

                    <div className="admin-hero-note">
                      <div className="admin-hero-note-title">Platform Users</div>
                      <div className="admin-hero-note-value">
                        {headlineStats.totalUsers}
                      </div>
                      <div className="admin-hero-note-copy">
                        Registered and guest identities currently visible in the admin
                        analytics summary.
                      </div>
                    </div>

                    <div className="admin-hero-note">
                      <div className="admin-hero-note-title">Evidence Items</div>
                      <div className="admin-hero-note-value">
                        {headlineStats.totalEvidence}
                      </div>
                      <div className="admin-hero-note-copy">
                        Stored evidence volume across the platform, excluding deleted
                        records.
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
                  <div className="admin-card-title">Operational overview</div>
                  <div className="admin-card-copy">
                    Choose the surface that matches your task: analytics for
                    platform-level visibility, audit for integrity review, or pipeline
                    tools for commercial follow-up.
                  </div>

                  <div
                    style={{
                      display: "grid",
                      gap: 12,
                      marginTop: 18,
                    }}
                  >
                    <div
                      style={{
                        border: "1px solid rgba(79,112,107,0.10)",
                        background:
                          "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
                        borderRadius: 20,
                        padding: 16,
                        boxShadow:
                          "inset 0 1px 0 rgba(255,255,255,0.42), 0 12px 26px rgba(0,0,0,0.06)",
                      }}
                    >
                      <div className="admin-card-eyebrow">
                        <span className="admin-dot" />
                        Analytics
                      </div>
                      <div
                        style={{
                          marginTop: 10,
                          fontSize: 13,
                          lineHeight: 1.7,
                          color: "#67777c",
                        }}
                      >
                        {bundle?.summary
                          ? `${headlineStats.activeSubscriptions} active subscriptions, ${headlineStats.activeTeams} active teams, and live platform activity are available inside the analytics dashboard.`
                          : "Review funnel performance, geography, top routes, and platform activity."}
                      </div>
                    </div>

                    <div
                      style={{
                        border: "1px solid rgba(79,112,107,0.10)",
                        background:
                          "linear-gradient(180deg, rgba(255,255,255,0.58) 0%, rgba(243,245,242,0.90) 100%)",
                        borderRadius: 20,
                        padding: 16,
                        boxShadow:
                          "inset 0 1px 0 rgba(255,255,255,0.42), 0 12px 26px rgba(0,0,0,0.06)",
                      }}
                    >
                      <div className="admin-card-eyebrow">
                        <span className="admin-dot" />
                        Integrity
                      </div>
                      <div
                        style={{
                          marginTop: 10,
                          fontSize: 13,
                          lineHeight: 1.7,
                          color: "#67777c",
                        }}
                      >
                        {bundle?.summary
                          ? `${headlineStats.storageRisk} storage-risk teams and ${headlineStats.overSeatLimit} over-seat-limit teams need the most urgent administrative attention.`
                          : "Inspect tamper-evident audit entries and verify the current chain status."}
                      </div>
                    </div>
                  </div>
                </div>
              </Card>
            </div>
          )}

          <div className="admin-cards-grid">
            {cards.map((card) => (
              <Card
                key={card.href}
                className="admin-card"
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
                  <div className="admin-card-eyebrow">
                    <span className="admin-dot" />
                    {card.eyebrow}
                  </div>

                  <div
                    className="admin-card-title"
                    style={{ marginTop: 16, color: card.accent }}
                  >
                    {card.title}
                  </div>

                  <p className="admin-card-copy">{card.body}</p>

                  {card.meta.length > 0 ? (
                    <div className="admin-card-meta-grid">
                      {card.meta.map((item) => (
                        <div
                          key={`${card.href}-${item.label}`}
                          className="admin-card-meta-pill"
                          style={pillTone(item.tone)}
                        >
                          {item.label}: {item.value}
                        </div>
                      ))}
                    </div>
                  ) : null}

                  <div className="admin-card-actions">
                    <Link href={card.href} className="admin-card-link">
                      <Button
                        className="app-responsive-btn rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                        style={dashboardStyles.primaryButton}
                      >
                        Open
                      </Button>
                    </Link>

                    <Link href={card.href} className="admin-card-link">
                      <Button
                        className="app-responsive-btn rounded-[999px] border px-5 py-3 text-[0.92rem] font-semibold"
                        style={dashboardStyles.secondaryButton}
                      >
                        Review
                      </Button>
                    </Link>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}