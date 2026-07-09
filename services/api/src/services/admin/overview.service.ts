import { prisma } from "../../db.js";
import { buildPlatformAlerts } from "./alerts.service.js";
import { buildEvidenceHealthSnapshot } from "../operations/evidence-health.service.js";

/**
 * Platform Admin Control-Center Overview (item A).
 *
 * READ-ONLY cross-tenant aggregation that answers the locked control-center
 * questions in one payload: platform status, customers, evidence operations,
 * security, billing, and traffic. Every figure is REAL (a live count) or an
 * honest `null` with a reason — never fabricated. Heavy health signals are
 * reused from the canonical services (buildPlatformAlerts,
 * buildEvidenceHealthSnapshot) rather than re-derived here.
 *
 * Each section is computed independently and degrades to `null` (honest
 * "not measured") if its queries fail, so a single subsystem outage never
 * fabricates a healthy-looking number for the rest.
 */

type StatusLevel = "healthy" | "degraded" | "critical" | "unknown";

export type PlatformOverview = {
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
  evidenceOps: unknown | null;
  evidenceVolume: {
    last24h: number | null;
    last7d: number | null;
    last30d: number | null;
  };
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

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function buildPlatformOverview(): Promise<PlatformOverview> {
  const now = Date.now();
  const since7d = new Date(now - 7 * DAY_MS);
  const since30d = new Date(now - 30 * DAY_MS);
  const since24h = new Date(now - DAY_MS);

  const [
    alerts,
    evidenceOps,
    totalOrganizations,
    activeOrganizations,
    suspendedOrganizations,
    archivedOrganizations,
    enterpriseWorkspaces,
    onboardingOrganizations,
    ssoOutageConnections,
    unverifiedDomains,
    openIncidents,
    recentHighSecurityEvents,
    adminActionsLast24h,
    activeSubscriptions,
    failedPaymentsLast30d,
    grossRevenue,
    planGroups,
    activeStorageAddons,
    pageViewsLast7d,
    visitorGroups,
    countryGroups,
    latestTelemetry,
    evidence24h,
    evidence7d,
    evidence30d,
  ] = await Promise.all([
    safe(() => buildPlatformAlerts()),
    safe(() => buildEvidenceHealthSnapshot({ windowHours: 24 })),
    safe(() => prisma.organization.count()),
    safe(() => prisma.organization.count({ where: { status: "ACTIVE" } })),
    safe(() => prisma.organization.count({ where: { status: "SUSPENDED" } })),
    safe(() => prisma.organization.count({ where: { status: "ARCHIVED" } })),
    safe(() => prisma.team.count({ where: { billingPlan: "ENTERPRISE" } })),
    safe(() =>
      prisma.organization.count({ where: { pendingEnterpriseSeats: { gt: 0 } } }),
    ),
    safe(() =>
      prisma.ssoConnection.count({ where: { outageDetectedAtUtc: { not: null } } }),
    ),
    safe(() =>
      prisma.organizationDomain.count({ where: { verifiedAt: null } }),
    ),
    safe(() => prisma.operationalIncident.count({ where: { status: "OPEN" } })),
    safe(() =>
      prisma.securityEvent.count({
        where: { severity: { in: ["HIGH", "CRITICAL"] }, createdAt: { gte: since7d } },
      }),
    ),
    safe(() =>
      prisma.adminAuditLog.count({ where: { createdAt: { gte: since24h } } }),
    ),
    safe(() => prisma.subscription.count({ where: { status: "ACTIVE" } })),
    safe(() =>
      prisma.payment.count({
        where: { status: "FAILED", createdAt: { gte: since30d } },
      }),
    ),
    safe(() =>
      prisma.payment.aggregate({
        _sum: { amountCents: true },
        where: { status: "SUCCEEDED" },
      }),
    ),
    safe(() =>
      prisma.subscription.groupBy({ by: ["plan"], _count: { _all: true } }),
    ),
    safe(() =>
      prisma.workspaceStorageAddon.count({ where: { status: "ACTIVE" } }),
    ),
    safe(() =>
      prisma.analyticsEvent.count({
        where: { eventType: "page_view", createdAt: { gte: since7d } },
      }),
    ),
    safe(() =>
      prisma.analyticsEvent.groupBy({
        by: ["visitorId"],
        where: { createdAt: { gte: since7d } },
      }),
    ),
    safe(() =>
      prisma.analyticsEvent.groupBy({
        by: ["countryCode"],
        where: { createdAt: { gte: since7d }, countryCode: { not: null } },
        _count: { _all: true },
      }),
    ),
    safe(() =>
      prisma.queueTelemetrySnapshot.findFirst({
        orderBy: { sampledAtUtc: "desc" },
        select: { sampledAtUtc: true },
      }),
    ),
    safe(() =>
      prisma.evidence.count({
        where: { deletedAtUtc: null, createdAt: { gte: since24h } },
      }),
    ),
    safe(() =>
      prisma.evidence.count({
        where: { deletedAtUtc: null, createdAt: { gte: since7d } },
      }),
    ),
    safe(() =>
      prisma.evidence.count({
        where: { deletedAtUtc: null, createdAt: { gte: since30d } },
      }),
    ),
  ]);

  const unresolvedAlerts = alerts ? alerts.total : null;
  const criticalAlerts = alerts ? alerts.counts.critical : null;
  const highAlerts = alerts ? alerts.counts.high : null;
  const degradedServices =
    (evidenceOps as { workerQueues?: { degradedCount?: number | null } } | null)
      ?.workerQueues?.degradedCount ?? null;

  // Status level: only claim "healthy" when we have real signals AND they are
  // all clear. Any failed query → "unknown" (never a fabricated healthy).
  let level: StatusLevel;
  const haveSignals =
    alerts !== null && openIncidents !== null && evidenceOps !== null;
  if (!haveSignals) {
    level = "unknown";
  } else if ((criticalAlerts ?? 0) > 0 || (openIncidents ?? 0) > 0) {
    level = "critical";
  } else if ((highAlerts ?? 0) > 0 || (degradedServices ?? 0) > 0) {
    level = "degraded";
  } else {
    level = "healthy";
  }

  const planMix = planGroups
    ? planGroups
        .map((g) => ({ plan: String(g.plan), count: g._count._all }))
        .sort((a, b) => b.count - a.count)
    : null;

  const topCountries = countryGroups
    ? countryGroups
        .map((g) => ({ countryCode: g.countryCode, count: g._count._all }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5)
    : null;

  const visitorsLast7d = visitorGroups ? visitorGroups.length : null;
  const trafficConnected = (pageViewsLast7d ?? 0) > 0 || (visitorsLast7d ?? 0) > 0;

  return {
    generatedAtUtc: new Date(now).toISOString(),
    status: {
      level,
      activeIncidents: openIncidents,
      degradedServices,
      unresolvedAlerts,
      criticalAlerts,
      highAlerts,
      lastTelemetrySampleAtUtc: latestTelemetry?.sampledAtUtc
        ? new Date(latestTelemetry.sampledAtUtc).toISOString()
        : null,
    },
    customers: {
      totalOrganizations,
      activeOrganizations,
      suspendedOrganizations,
      archivedOrganizations,
      enterpriseWorkspaces,
      onboardingOrganizations,
      ssoOutageConnections,
      unverifiedDomains,
    },
    evidenceOps: evidenceOps ?? null,
    evidenceVolume: {
      last24h: evidence24h,
      last7d: evidence7d,
      last30d: evidence30d,
    },
    security: {
      recentHighSecurityEvents,
      ssoOutages: ssoOutageConnections,
      adminActionsLast24h,
      openIncidents,
    },
    billing: {
      activeSubscriptions,
      failedPaymentsLast30d,
      grossRevenueCents: grossRevenue?._sum.amountCents ?? null,
      planMix,
      activeStorageAddons,
    },
    traffic: {
      connected: trafficConnected,
      pageViewsLast7d,
      visitorsLast7d,
      topCountries,
      note: trafficConnected
        ? "Consented page-view analytics from public marketing pages (last 7 days)."
        : "No consented traffic recorded yet — analytics is enabled and waiting for consented page views / edge country headers.",
    },
  };
}
