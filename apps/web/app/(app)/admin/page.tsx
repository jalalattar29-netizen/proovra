"use client";
import { toSafeUserError } from "../../../lib/feedback/toSafeUserError";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Skeleton, useToast } from "../../../components/ui";
import { PageShell, PageHeader, PageSection } from "../../../components/ui";
import { Card } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { Badge, type BadgeTone } from "../../../components/ui/Badge";
import { apiFetch } from "../../../lib/api";
import { ADMIN_NAV_ITEMS } from "../../../components/admin/admin-nav-config";
// Phase Final-PageGate-Closure — `/admin/*` gate lives in
// `apps/web/app/(app)/admin/layout.tsx` so EVERY admin page (root +
// subroutes) inherits the canonical `platform.admin` gate without
// the risk of mismatched per-page wrappers. Backend RBAC remains
// the authoritative gate; this is the UX layer.
//
// Nav list is sourced from a single canonical config so this landing
// page and `AdminConsoleNav` (rendered on every admin sub-page) cannot
// drift. See `components/admin/admin-nav-config.ts`.

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
          toSafeUserError(err, { message: "Failed to load admin console" }).message;
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
        eyebrow: "Analytics",
        meta: summary
          ? [
              { label: "Users", value: summary.totalUsers, tone: "verified" as BadgeTone },
              {
                label: "Revenue",
                value: formatMoneyCents(summary.billing.grossRevenueCents),
                tone: "governance" as BadgeTone,
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
        eyebrow: "Integrity",
        meta: summary
          ? [
              {
                label: "Storage Risk",
                value: summary.workspaceHealth.storageLimitReachedTeams,
                tone: "risk" as BadgeTone,
              },
              {
                label: "Seat Risk",
                value: summary.workspaceHealth.seatLimitReachedTeams,
                tone: "pending" as BadgeTone,
              },
            ]
          : [],
      },
      {
        href: "/admin/demo-requests",
        title: "Demo Requests",
        body:
          summary != null
            ? `${summary.teams.total} workspaces, ${summary.teams.active} active billed workspaces, and a controlled path for reviewing inbound commercial demand alongside platform growth.`
            : "Review inbound demo requests, inspect source context, assess spam signals, and move qualified leads through the internal pipeline.",
        eyebrow: "Pipeline",
        meta: summary
          ? [
              {
                label: "Teams",
                value: summary.teams.total,
                tone: "neutral" as BadgeTone,
              },
              {
                label: "Past Due",
                value: summary.teams.pastDue,
                tone: "risk" as BadgeTone,
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
      routes: ADMIN_NAV_ITEMS.length,
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

  const metrics = useMemo(
    () => [
      {
        key: "modules",
        label: "Modules",
        value: headlineStats.modules,
        copy: "Analytics, audit integrity, and demo request operations available from here.",
      },
      {
        key: "routes",
        label: "Admin Routes",
        value: headlineStats.routes,
        copy: "Console home, platform analytics, audit integrity, demo requests, and identity governance.",
      },
      {
        key: "users",
        label: "Platform Users",
        value: headlineStats.totalUsers,
        copy: "Registered and guest identities visible in the admin analytics summary.",
      },
      {
        key: "evidence",
        label: "Evidence Items",
        value: headlineStats.totalEvidence,
        copy: "Stored evidence volume across the platform, excluding deleted records.",
      },
    ],
    [headlineStats],
  );

  return (
    <div className="admin-console-page">
      <style jsx global>{`
        .admin-console-page .admin-nav-row {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
        }

        .admin-console-page .admin-metric-grid {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 16px;
        }

        .admin-console-page .admin-cards-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 18px;
        }

        .admin-console-page .admin-metric-value {
          font-size: 2rem;
          line-height: 1;
          font-weight: 800;
          letter-spacing: -0.03em;
          color: var(--ink-primary, #0f172a);
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .admin-console-page .admin-metric-label {
          font-size: 0.72rem;
          font-weight: 700;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: var(--ink-muted, #64748b);
        }

        .admin-console-page .admin-metric-copy {
          margin-top: 10px;
          font-size: 0.82rem;
          line-height: 1.55;
          color: var(--ink-secondary, #475569);
        }

        .admin-console-page .admin-module-title {
          font-size: 1.06rem;
          font-weight: 700;
          letter-spacing: -0.01em;
          color: var(--ink-primary, #0f172a);
        }

        .admin-console-page .admin-module-copy {
          margin-top: 8px;
          color: var(--ink-secondary, #475569);
          line-height: 1.65;
          font-size: 0.9rem;
        }

        .admin-console-page .admin-module-meta {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-top: 16px;
        }

        .admin-console-page .admin-module-actions {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          margin-top: auto;
          padding-top: 18px;
        }

        .admin-console-page .admin-link {
          text-decoration: none;
        }

        @media (max-width: 1080px) {
          .admin-console-page .admin-metric-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }

          .admin-console-page .admin-cards-grid {
            grid-template-columns: 1fr;
          }
        }

        @media (max-width: 640px) {
          .admin-console-page .admin-metric-grid {
            grid-template-columns: 1fr;
          }

          .admin-console-page .admin-nav-row {
            display: grid;
            grid-template-columns: 1fr;
            gap: 10px;
          }

          .admin-console-page .admin-module-actions {
            flex-direction: column;
            align-items: stretch;
          }

          .admin-console-page .admin-module-actions a,
          .admin-console-page .admin-module-actions a > * {
            width: 100%;
          }
        }
      `}</style>

      <PageShell
        header={
          <PageHeader
            eyebrow="Platform admin"
            title="Admin Console"
            subtitle="Platform-wide analytics, billing posture, audit integrity, and commercial operations from one controlled surface."
            primaryAction={
              <Link href="/admin/provisioning" className="admin-link">
                <Button variant="primary" data-testid="admin-provision-cta">
                  Provision Enterprise Customer
                </Button>
              </Link>
            }
          />
        }
      >
        <nav className="admin-nav-row" aria-label="Admin sections">
          {ADMIN_NAV_ITEMS.map((item) => {
            const active = pathname === item.href;

            return (
              <Link key={item.href} href={item.href} className="admin-link">
                <Button variant={active ? "secondary" : "ghost"} size="sm">
                  {item.label}
                </Button>
              </Link>
            );
          })}
        </nav>

        <PageSection
          title="Platform at a glance"
          description="Live totals sourced from the admin analytics summary."
        >
          {loading ? (
            <div className="admin-metric-grid">
              {metrics.map((metric) => (
                <Card key={metric.key} variant="summary">
                  <Skeleton width="100%" height="120px" />
                </Card>
              ))}
            </div>
          ) : (
            <div className="admin-metric-grid">
              {metrics.map((metric) => (
                <Card key={metric.key} variant="summary">
                  <div className="admin-metric-label">{metric.label}</div>
                  <div className="admin-metric-value" style={{ marginTop: 10 }}>
                    {metric.value}
                  </div>
                  <div className="admin-metric-copy">{metric.copy}</div>
                </Card>
              ))}
            </div>
          )}
        </PageSection>

        <PageSection
          title="Admin modules"
          description="Choose the surface that matches your task."
        >
          <div className="admin-cards-grid">
            {cards.map((card) => (
              <Card
                key={card.href}
                variant="action"
                style={{ height: "100%" }}
              >
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    height: "100%",
                  }}
                >
                  <Badge tone="governance" subtle dot>
                    {card.eyebrow}
                  </Badge>

                  <div className="admin-module-title" style={{ marginTop: 14 }}>
                    {card.title}
                  </div>

                  <p className="admin-module-copy">{card.body}</p>

                  {card.meta.length > 0 ? (
                    <div className="admin-module-meta">
                      {card.meta.map((item) => (
                        <Badge
                          key={`${card.href}-${item.label}`}
                          tone={item.tone}
                          subtle
                        >
                          {item.label}: {item.value}
                        </Badge>
                      ))}
                    </div>
                  ) : null}

                  <div className="admin-module-actions">
                    <Link href={card.href} className="admin-link">
                      <Button variant="secondary" size="sm">
                        Open
                      </Button>
                    </Link>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </PageSection>
      </PageShell>
    </div>
  );
}
