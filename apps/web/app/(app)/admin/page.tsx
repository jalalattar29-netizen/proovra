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
import { EmptyState } from "../../../components/ui/EmptyState";
import { apiFetch } from "../../../lib/api";
import { formatUserDateTime } from "../../../lib/date";
import { ADMIN_NAV_ITEMS } from "../../../components/admin/admin-nav-config";

// Platform Admin Control Center — Overview (item A).
//
// The `/admin/*` gate lives in `apps/web/app/(app)/admin/layout.tsx` so every
// admin page inherits the canonical `platform.admin` gate; backend RBAC on
// `/v1/admin/*` is the authoritative gate. This page is a read-only control
// center: every figure is REAL (a live count from `/v1/admin/overview`) or an
// honest `null` rendered as "Not measured" / "Not connected" — never fabricated.

type StatusLevel = "healthy" | "degraded" | "critical" | "unknown";

type PlatformOverview = {
  generatedAtUtc: string;
  status: {
    level: StatusLevel;
    activeIncidents: number | null;
    degradedServices: number | null;
    unresolvedAlerts: number | null;
    criticalAlerts: number | null;
    highAlerts: number | null;
    lastTelemetrySampleAtUtc: string | null;
  };
  customers: {
    totalOrganizations: number | null;
    activeOrganizations: number | null;
    suspendedOrganizations: number | null;
    archivedOrganizations: number | null;
    enterpriseWorkspaces: number | null;
    onboardingOrganizations: number | null;
    ssoOutageConnections: number | null;
    unverifiedDomains: number | null;
  };
  evidenceOps: {
    uploads?: { inProgress: number | null; stalled: number | null; failed: number | null };
    reports?: { failedGeneration: number | null; queued: number | null };
    packages?: { failed: number | null; queued: number | null; verificationBacklog: number | null };
    preservation?: { tsaFailures: number | null; otsAnchoringFailures: number | null };
  } | null;
  evidenceVolume: { last24h: number | null; last7d: number | null; last30d: number | null };
  security: {
    recentHighSecurityEvents: number | null;
    ssoOutages: number | null;
    adminActionsLast24h: number | null;
    openIncidents: number | null;
  };
  billing: {
    activeSubscriptions: number | null;
    failedPaymentsLast30d: number | null;
    grossRevenueCents: number | null;
    planMix: Array<{ plan: string; count: number }> | null;
    activeStorageAddons: number | null;
  };
  traffic: {
    connected: boolean;
    pageViewsLast7d: number | null;
    visitorsLast7d: number | null;
    topCountries: Array<{ countryCode: string | null; count: number }> | null;
    note: string;
  };
};

/** Honest null renderer — never coerces an absent signal to 0. */
function num(v: number | null | undefined): string {
  return typeof v === "number" ? new Intl.NumberFormat().format(v) : "Not measured";
}

function money(cents: number | null | undefined): string {
  if (typeof cents !== "number") return "Not measured";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

const STATUS_TONE: Record<StatusLevel, BadgeTone> = {
  healthy: "verified",
  degraded: "pending",
  critical: "risk",
  unknown: "neutral",
};

const QUICK_ACTIONS: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/admin/provisioning", label: "Provision enterprise" },
  { href: "/admin/organizations", label: "Open customers" },
  { href: "/admin/users", label: "Open users" },
  { href: "/admin/evidence-ops", label: "Open evidence ops" },
  { href: "/admin/security", label: "Open security" },
  { href: "/admin/billing", label: "Open billing" },
  { href: "/admin/platform-health", label: "Open platform health" },
  { href: "/admin/audit", label: "Open audit" },
];

type Stat = { label: string; value: string; tone?: BadgeTone; hint?: string };

function StatGrid({ stats }: { stats: Stat[] }) {
  return (
    <div className="admin-stat-grid">
      {stats.map((s) => (
        <Card key={s.label} variant="summary">
          <div className="admin-stat-label">{s.label}</div>
          <div className="admin-stat-value">{s.value}</div>
          {s.hint ? <div className="admin-stat-hint">{s.hint}</div> : null}
        </Card>
      ))}
    </div>
  );
}

export default function AdminPage() {
  const pathname = usePathname();
  const { addToast } = useToast();

  const [loading, setLoading] = useState(true);
  const [ov, setOv] = useState<PlatformOverview | null>(null);

  useEffect(() => {
    const run = async () => {
      try {
        setLoading(true);
        const data = (await apiFetch("/v1/admin/overview")) as PlatformOverview;
        setOv(data ?? null);
      } catch (err) {
        const message = toSafeUserError(err, {
          message: "Failed to load platform overview",
        }).message;
        addToast(message, "error");
        setOv(null);
      } finally {
        setLoading(false);
      }
    };
    void run();
  }, [addToast]);

  const statusStats = useMemo<Stat[]>(() => {
    const s = ov?.status;
    return [
      { label: "Active incidents", value: num(s?.activeIncidents) },
      { label: "Degraded services", value: num(s?.degradedServices) },
      { label: "Unresolved alerts", value: num(s?.unresolvedAlerts) },
      {
        label: "Last telemetry sample",
        value: s?.lastTelemetrySampleAtUtc
          ? formatUserDateTime(s.lastTelemetrySampleAtUtc)
          : "Not measured",
      },
    ];
  }, [ov]);

  return (
    <div className="admin-console-page">
      <style jsx global>{`
        .admin-console-page .admin-nav-row {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
        }
        .admin-console-page .admin-stat-grid {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 16px;
        }
        .admin-console-page .admin-stat-label {
          font-size: 0.72rem;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--ink-muted, #64748b);
        }
        .admin-console-page .admin-stat-value {
          margin-top: 8px;
          font-size: 1.7rem;
          line-height: 1.1;
          font-weight: 800;
          letter-spacing: -0.02em;
          color: var(--ink-primary, #0f172a);
          overflow-wrap: anywhere;
        }
        .admin-console-page .admin-stat-hint {
          margin-top: 8px;
          font-size: 0.8rem;
          line-height: 1.5;
          color: var(--ink-secondary, #475569);
        }
        .admin-console-page .admin-quick-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
        }
        .admin-console-page .admin-link {
          text-decoration: none;
        }
        @media (max-width: 1080px) {
          .admin-console-page .admin-stat-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
        }
        @media (max-width: 640px) {
          .admin-console-page .admin-stat-grid {
            grid-template-columns: 1fr;
          }
          .admin-console-page .admin-nav-row {
            display: grid;
            grid-template-columns: 1fr;
          }
        }
      `}</style>

      <PageShell
        header={
          <PageHeader
            eyebrow="Platform admin"
            title="Platform Control Center"
            subtitle="Live platform status, customers, evidence operations, security, billing, and traffic — one controlled surface. Every figure is real or honestly marked Not measured."
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

        {loading ? (
          <PageSection title="Loading platform overview">
            <div className="admin-stat-grid">
              {[0, 1, 2, 3].map((k) => (
                <Card key={k} variant="summary">
                  <Skeleton width="100%" height="90px" />
                </Card>
              ))}
            </div>
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
            <PageSection
              title="Platform status"
              description="Overall posture from live incidents, alerts, and worker telemetry."
            >
              <div style={{ marginBottom: 14 }}>
                <Badge tone={STATUS_TONE[ov.status.level]} data-testid="admin-status-level">
                  {ov.status.level.toUpperCase()}
                </Badge>
              </div>
              <StatGrid stats={statusStats} />
            </PageSection>

            <PageSection
              title="Customers"
              description="Organizations, enterprise workspaces, onboarding, and identity issues."
            >
              <StatGrid
                stats={[
                  { label: "Total organizations", value: num(ov.customers.totalOrganizations) },
                  { label: "Enterprise workspaces", value: num(ov.customers.enterpriseWorkspaces) },
                  { label: "Onboarding (pending seats)", value: num(ov.customers.onboardingOrganizations) },
                  { label: "Suspended / blocked", value: num(ov.customers.suspendedOrganizations) },
                  { label: "Active organizations", value: num(ov.customers.activeOrganizations) },
                  { label: "Archived organizations", value: num(ov.customers.archivedOrganizations) },
                  { label: "SSO outages", value: num(ov.customers.ssoOutageConnections), hint: "Connections with an active outage" },
                  { label: "Unverified domains", value: num(ov.customers.unverifiedDomains) },
                ]}
              />
            </PageSection>

            <PageSection
              title="Evidence operations"
              description="Pipeline volume and failure signals (honest Not measured where a queue signal is unreadable)."
            >
              <StatGrid
                stats={[
                  { label: "Evidence created (24h)", value: num(ov.evidenceVolume.last24h) },
                  { label: "Evidence created (7d)", value: num(ov.evidenceVolume.last7d) },
                  { label: "Evidence created (30d)", value: num(ov.evidenceVolume.last30d) },
                  { label: "Uploads stalled", value: num(ov.evidenceOps?.uploads?.stalled) },
                  { label: "Reports failed", value: num(ov.evidenceOps?.reports?.failedGeneration) },
                  { label: "Reports queued", value: num(ov.evidenceOps?.reports?.queued) },
                  { label: "TSA failures", value: num(ov.evidenceOps?.preservation?.tsaFailures) },
                  { label: "OTS failures", value: num(ov.evidenceOps?.preservation?.otsAnchoringFailures) },
                ]}
              />
            </PageSection>

            <PageSection
              title="Security"
              description="Recent high-severity events, identity failures, admin activity, and incidents."
            >
              <StatGrid
                stats={[
                  { label: "High security events (7d)", value: num(ov.security.recentHighSecurityEvents) },
                  { label: "SSO failures / outages", value: num(ov.security.ssoOutages) },
                  { label: "Admin actions (24h)", value: num(ov.security.adminActionsLast24h) },
                  { label: "Open incidents", value: num(ov.security.openIncidents) },
                ]}
              />
            </PageSection>

            <PageSection
              title="Billing"
              description="Subscriptions, revenue, failed payments, and storage add-ons."
            >
              <StatGrid
                stats={[
                  { label: "Active subscriptions", value: num(ov.billing.activeSubscriptions) },
                  { label: "Gross revenue", value: money(ov.billing.grossRevenueCents), hint: "Sum of succeeded payments" },
                  { label: "Failed payments (30d)", value: num(ov.billing.failedPaymentsLast30d) },
                  { label: "Active storage add-ons", value: num(ov.billing.activeStorageAddons) },
                ]}
              />
              {ov.billing.planMix && ov.billing.planMix.length > 0 ? (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
                  {ov.billing.planMix.map((p) => (
                    <Badge key={p.plan} tone="governance" subtle>
                      {p.plan}: {p.count}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </PageSection>

            <PageSection
              title="Traffic"
              description="Consented public analytics (honest not-connected until traffic arrives)."
            >
              {ov.traffic.connected ? (
                <>
                  <StatGrid
                    stats={[
                      { label: "Page views (7d)", value: num(ov.traffic.pageViewsLast7d) },
                      { label: "Visitors (7d)", value: num(ov.traffic.visitorsLast7d) },
                      {
                        label: "Top country",
                        value: ov.traffic.topCountries?.[0]?.countryCode ?? "Not measured",
                      },
                      {
                        label: "Countries seen",
                        value: num(ov.traffic.topCountries?.length ?? null),
                      },
                    ]}
                  />
                  {ov.traffic.topCountries && ov.traffic.topCountries.length > 0 ? (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
                      {ov.traffic.topCountries.map((c) => (
                        <Badge key={c.countryCode ?? "unknown"} tone="neutral" subtle>
                          {(c.countryCode ?? "??")}: {c.count}
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                </>
              ) : (
                <EmptyState
                  title="Traffic not connected"
                  purpose={ov.traffic.note}
                />
              )}
            </PageSection>

            <PageSection title="Quick actions" description="Jump to the operational surfaces.">
              <div className="admin-quick-actions">
                {QUICK_ACTIONS.map((a) => (
                  <Link key={a.href} href={a.href} className="admin-link">
                    <Button variant="secondary" size="sm">
                      {a.label}
                    </Button>
                  </Link>
                ))}
              </div>
            </PageSection>
          </>
        )}
      </PageShell>
    </div>
  );
}
