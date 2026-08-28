import { prisma } from "../../db.js";
import {
  customerOrganizationWhere,
  liveWorkspaceWhere,
  liveEvidenceWith,
} from "@proovra/shared-runtime";
import { buildPlatformAlerts } from "./alerts.service.js";
import { buildEvidenceHealthSnapshot } from "../operations/evidence-health.service.js";
import {
  measure,
  metricNotMeasured,
  metricNumber,
  metricValue,
  type Metric,
} from "./metric-state.js";

/**
 * PLATFORM CONTROL CENTER — the Overview aggregate.
 *
 * REBUILT 2026-08-27 (ADM-002 / ADM-003 / ADM-004 / ADM-006 / ADM-007 /
 * ADM-012 / ADM-024). Read-only, cross-tenant, gated by `requirePlatformAdmin`.
 *
 * WHAT CHANGED AND WHY
 * ---------------------------------------------------------------------------
 * The previous version was honest about absence and wrong about population. It
 * never fabricated a number; it just counted the wrong rows, in six places:
 *
 *   customers      `organization.count()` with no `kind` predicate. Every
 *                  workspace owns a 1:1 SYSTEM container, so this was
 *                  approximately the workspace count wearing the word
 *                  "customers".
 *   enterprise     `team.count({ billingPlan: 'ENTERPRISE' })` — a plan string,
 *                  not the `EnterpriseContract` that actually governs. A
 *                  terminated contract whose workspace kept the plan still
 *                  counted as a live enterprise customer.
 *   workspaces     not reported at all, and the one place that did report them
 *                  counted closed ones as live.
 *   plan mix       `subscription.groupBy(['plan'])` with NO status filter, so
 *                  a subscription cancelled two years ago still inflated the
 *                  badge labelled with a live plan name.
 *   evidence       `deletedAtUtc: null` — a column the ordinary delete routes
 *                  never write, so deleted records counted as created ones.
 *   revenue        `SUM(amountCents)` across every currency, rendered as EUR.
 *
 * Every population predicate now comes from ONE authority — the
 * `control-plane-population` module, re-exported from the `@proovra/shared-runtime`
 * package root — so the next query written here cannot invent a seventh answer,
 * and every figure is a `Metric`
 * that distinguishes a real zero from an unmeasurable signal from a failed
 * query (ADM-024).
 *
 * WHAT IS DELIBERATELY STILL ABSENT
 * ---------------------------------------------------------------------------
 * MRR, ARR and growth. `Subscription` carries no billed amount, so any of the
 * three would be invented. They are `NOT_MEASURED` with the reason attached —
 * unchanged, and correct.
 */

type StatusLevel = "healthy" | "degraded" | "critical" | "unknown";

/** A revenue total in ONE currency. Totals are never summed across currencies. */
export type CurrencyTotal = {
  currency: string;
  amountCents: number;
  payments: number;
};

/**
 * Every actionable figure carries the roster that explains it (ADM-027 /
 * ADM-029 / §1.1). A tile with no `drillDown` is a tile an operator cannot act
 * on, and the type makes that a visible decision rather than an oversight.
 */
export type OverviewFigure = {
  metric: Metric<number>;
  /** Admin path that lists exactly the records behind this number. */
  drillDown: string | null;
};

export type PlatformOverview = {
  generatedAtUtc: string;
  status: {
    level: StatusLevel;
    activeIncidents: OverviewFigure;
    degradedServices: Metric<number>;
    unresolvedAlerts: Metric<number>;
    criticalAlerts: Metric<number>;
    highAlerts: Metric<number>;
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
    /** Account commercial distribution — USERS, never workspaces (ADM-009). */
    accountsByTier: Array<{ tier: string; count: number; drillDown: string }>;
  };
  evidenceOps: unknown | null;
  evidenceVolume: {
    last24h: Metric<number>;
    last7d: Metric<number>;
    last30d: Metric<number>;
  };
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
    /** One entry PER CURRENCY. Never a single cross-currency total (ADM-012). */
    grossRevenueByCurrency: Metric<CurrencyTotal[]>;
    /** Provider subscription rows by status — labelled as exactly that. */
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

const DAY_MS = 24 * 60 * 60 * 1000;

/** Statuses that mean "this provider subscription is currently live". */
const LIVE_SUBSCRIPTION_STATUSES = ["ACTIVE", "TRIALING"] as const;

export async function buildPlatformOverview(
  onError?: (err: unknown, label: string) => void,
): Promise<PlatformOverview> {
  const now = Date.now();
  const since7d = new Date(now - 7 * DAY_MS);
  const since30d = new Date(now - 30 * DAY_MS);
  const since24h = new Date(now - DAY_MS);

  const m = <T>(label: string, fn: () => Promise<T>) =>
    measure(label, fn, onError);

  const [
    alerts,
    evidenceOps,
    customersTotal,
    customersActive,
    customersSuspended,
    customersArchived,
    enterpriseContracts,
    onboardingCustomers,
    ssoOutageConnections,
    unverifiedDomains,
    workspacesLive,
    workspacesPersonal,
    workspacesOwned,
    workspacesOrganization,
    workspacesClosed,
    usersTotal,
    usersRegistered,
    entitlementTiers,
    openIncidents,
    recentHighSecurityEvents,
    adminActionsLast24h,
    activeSubscriptions,
    pendingCancellations,
    pastDueSubscriptions,
    failedPaymentsLast30d,
    revenueByCurrency,
    subscriptionsByStatus,
    activeStorageAddons,
    pageViewsLast7d,
    visitorGroups,
    countryGroups,
    latestTelemetry,
    evidence24h,
    evidence7d,
    evidence30d,
  ] = await Promise.all([
    m("Platform alerts", () => buildPlatformAlerts()),
    m("Evidence health", () => buildEvidenceHealthSnapshot({ windowHours: 24 })),

    // ---- Customers — CUSTOMER organizations only (ADM-002) ----------------
    m("Customers", () =>
      prisma.organization.count({ where: customerOrganizationWhere() }),
    ),
    m("Active customers", () =>
      prisma.organization.count({
        where: { ...customerOrganizationWhere(), status: "ACTIVE" },
      }),
    ),
    m("Suspended customers", () =>
      prisma.organization.count({
        where: { ...customerOrganizationWhere(), status: "SUSPENDED" },
      }),
    ),
    m("Archived customers", () =>
      prisma.organization.count({
        where: { ...customerOrganizationWhere(), status: "ARCHIVED" },
      }),
    ),
    // ADM-003 — the CONTRACT is the enterprise authority, not a plan string.
    m("Enterprise contracts", () =>
      prisma.enterpriseContract.count({ where: { status: "ACTIVE" } }),
    ),
    m("Onboarding customers", () =>
      prisma.organization.count({
        where: {
          ...customerOrganizationWhere(),
          pendingEnterpriseSeats: { gt: 0 },
        },
      }),
    ),
    m("SSO outages", () =>
      prisma.ssoConnection.count({ where: { outageDetectedAtUtc: { not: null } } }),
    ),
    m("Unverified domains", () =>
      prisma.organizationDomain.count({ where: { verifiedAt: null } }),
    ),

    // ---- Workspaces — live by kind, plus closed (ADM-004) -----------------
    m("Live workspaces", () =>
      prisma.team.count({ where: liveWorkspaceWhere() }),
    ),
    m("Personal workspaces", () =>
      prisma.team.count({
        where: { ...liveWorkspaceWhere(), workspaceKind: "PERSONAL" },
      }),
    ),
    m("Owned workspaces", () =>
      prisma.team.count({
        where: { ...liveWorkspaceWhere(), workspaceKind: "OWNED" },
      }),
    ),
    m("Organization workspaces", () =>
      prisma.team.count({
        where: { ...liveWorkspaceWhere(), workspaceKind: "ORGANIZATION" },
      }),
    ),
    m("Closed workspaces", () =>
      prisma.team.count({ where: { closedAtUtc: { not: null } } }),
    ),

    // ---- People -----------------------------------------------------------
    m("Users", () => prisma.user.count()),
    m("Registered users", () =>
      prisma.user.count({ where: { provider: { not: "GUEST" } } }),
    ),
    // ADM-005 / ADM-009 — the console used to hold FOUR incompatible plan
    // authorities and none of them asked `resolveCommercialContext`. Every
    // per-subject commercial question now goes through that canonical resolver
    // (see people.service.ts and workspaces.service.ts); enterprise status
    // comes from `resolveEnterpriseContract`, never a plan string; and this
    // aggregate — the only one that is a DISTRIBUTION rather than a subject —
    // reads `Entitlement`, which is keyed by USER. So it is an ACCOUNT tier
    // distribution and is labelled as one. It was previously rendered under the
    // heading "Team-Plan Workspaces", which it has never been.
    m("Account tiers", () =>
      prisma.entitlement.groupBy({
        by: ["plan"],
        where: { active: true },
        _count: { _all: true },
      }),
    ),

    // ---- Security ---------------------------------------------------------
    m("Open incidents", () =>
      prisma.operationalIncident.count({ where: { status: "OPEN" } }),
    ),
    m("High security events", () =>
      prisma.securityEvent.count({
        where: {
          severity: { in: ["HIGH", "CRITICAL"] },
          createdAt: { gte: since7d },
        },
      }),
    ),
    m("Admin actions", () =>
      prisma.adminAuditLog.count({ where: { createdAt: { gte: since24h } } }),
    ),

    // ---- Billing ----------------------------------------------------------
    m("Active subscriptions", () =>
      prisma.subscription.count({ where: { status: "ACTIVE" } }),
    ),
    // ADM-016 — an ACTIVE subscription with `cancelAtPeriodEnd` is a customer
    // who has left and is running out their paid period. It rendered as an
    // ordinary active subscriber, which is the one state a retention motion
    // exists to catch.
    m("Pending cancellations", () =>
      prisma.subscription.count({
        where: { status: "ACTIVE", cancelAtPeriodEnd: true },
      }),
    ),
    m("Past-due subscriptions", () =>
      prisma.subscription.count({ where: { status: "PAST_DUE" } }),
    ),
    m("Failed payments", () =>
      prisma.payment.count({
        where: { status: "FAILED", createdAt: { gte: since30d } },
      }),
    ),
    // ADM-012 — grouped BY CURRENCY. `amountCents` is a minor-unit integer in
    // whatever `currency` says; summing across them produces a number that is
    // not money in any currency, and the tile then labelled it EUR.
    m("Gross revenue", () =>
      prisma.payment.groupBy({
        by: ["currency"],
        where: { status: "SUCCEEDED" },
        _sum: { amountCents: true },
        _count: { _all: true },
      }),
    ),
    m("Subscriptions by status", () =>
      prisma.subscription.groupBy({ by: ["status"], _count: { _all: true } }),
    ),
    m("Storage add-ons", () =>
      prisma.workspaceStorageAddon.count({ where: { status: "ACTIVE" } }),
    ),

    // ---- Traffic ----------------------------------------------------------
    m("Page views", () =>
      prisma.analyticsEvent.count({
        where: { eventType: "page_view", createdAt: { gte: since7d } },
      }),
    ),
    m("Visitors", () =>
      prisma.analyticsEvent.groupBy({
        by: ["visitorId"],
        where: { createdAt: { gte: since7d } },
      }),
    ),
    m("Countries", () =>
      prisma.analyticsEvent.groupBy({
        by: ["countryCode"],
        where: { createdAt: { gte: since7d }, countryCode: { not: null } },
        _count: { _all: true },
      }),
    ),
    m("Telemetry sample", () =>
      prisma.queueTelemetrySnapshot.findFirst({
        orderBy: { sampledAtUtc: "desc" },
        select: { sampledAtUtc: true },
      }),
    ),

    // ---- Evidence volume — canonical deletion semantics (ADM-007) ---------
    m("Evidence 24h", () =>
      prisma.evidence.count({
        where: liveEvidenceWith({ createdAt: { gte: since24h } }),
      }),
    ),
    m("Evidence 7d", () =>
      prisma.evidence.count({
        where: liveEvidenceWith({ createdAt: { gte: since7d } }),
      }),
    ),
    m("Evidence 30d", () =>
      prisma.evidence.count({
        where: liveEvidenceWith({ createdAt: { gte: since30d } }),
      }),
    ),
  ]);

  // ---- Status level -------------------------------------------------------
  const alertsValue = alerts.state === "VALUE" ? alerts.value : null;
  const unresolvedAlerts: Metric<number> = alertsValue
    ? metricValue(alertsValue.total)
    : { state: "ERROR", value: null, reason: "Alert rollup unavailable." };
  const criticalAlerts: Metric<number> = alertsValue
    ? metricValue(alertsValue.counts.critical)
    : { state: "ERROR", value: null, reason: "Alert rollup unavailable." };
  const highAlerts: Metric<number> = alertsValue
    ? metricValue(alertsValue.counts.high)
    : { state: "ERROR", value: null, reason: "Alert rollup unavailable." };

  const evidenceOpsValue =
    evidenceOps.state === "VALUE" ? evidenceOps.value : null;
  const degradedCount =
    (evidenceOpsValue as { workerQueues?: { degradedCount?: number | null } } | null)
      ?.workerQueues?.degradedCount ?? null;
  const degradedServices: Metric<number> =
    degradedCount === null
      ? metricNotMeasured("No worker-queue degradation signal in this sample.")
      : metricValue(degradedCount);

  const openIncidentCount = metricNumber(openIncidents);
  const criticalCount = metricNumber(criticalAlerts);
  const highCount = metricNumber(highAlerts);

  // Only claim "healthy" when every input actually answered. A failed query
  // produces "unknown", never a reassuring green.
  let level: StatusLevel;
  const haveSignals =
    alerts.state === "VALUE" &&
    openIncidents.state === "VALUE" &&
    evidenceOps.state === "VALUE";
  if (!haveSignals) {
    level = "unknown";
  } else if ((criticalCount ?? 0) > 0 || (openIncidentCount ?? 0) > 0) {
    level = "critical";
  } else if ((highCount ?? 0) > 0 || (degradedCount ?? 0) > 0) {
    level = "degraded";
  } else {
    level = "healthy";
  }

  // ---- Derived projections -------------------------------------------------
  const accountsByTier =
    entitlementTiers.state === "VALUE"
      ? entitlementTiers.value
          .map((g) => ({
            tier: String(g.plan),
            count: g._count._all,
            drillDown: `/admin/users?tier=${encodeURIComponent(String(g.plan))}`,
          }))
          .sort((a, b) => b.count - a.count)
      : [];

  const grossRevenueByCurrency: Metric<CurrencyTotal[]> =
    revenueByCurrency.state === "VALUE"
      ? metricValue(
          revenueByCurrency.value
            .map((r) => ({
              currency: (r.currency ?? "").toUpperCase() || "UNKNOWN",
              amountCents: r._sum.amountCents ?? 0,
              payments: r._count._all,
            }))
            .sort((a, b) => b.amountCents - a.amountCents),
        )
      : { state: "ERROR", value: null, reason: "Revenue rollup unavailable." };

  const subscriptionStatusRows =
    subscriptionsByStatus.state === "VALUE"
      ? subscriptionsByStatus.value
          .map((g) => ({ status: String(g.status), count: g._count._all }))
          .sort((a, b) => b.count - a.count)
      : [];

  const topCountries: Metric<Array<{ countryCode: string | null; count: number }>> =
    countryGroups.state === "VALUE"
      ? metricValue(
          countryGroups.value
            .map((g) => ({ countryCode: g.countryCode, count: g._count._all }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 5),
        )
      : { state: "ERROR", value: null, reason: "Country rollup unavailable." };

  const visitors: Metric<number> =
    visitorGroups.state === "VALUE"
      ? metricValue(visitorGroups.value.length)
      : { state: "ERROR", value: null, reason: "Visitor rollup unavailable." };

  const pageViews = metricNumber(pageViewsLast7d) ?? 0;
  const visitorCount = metricNumber(visitors) ?? 0;
  const trafficConnected = pageViews > 0 || visitorCount > 0;

  const telemetrySampledAt =
    latestTelemetry.state === "VALUE" && latestTelemetry.value?.sampledAtUtc
      ? new Date(latestTelemetry.value.sampledAtUtc).toISOString()
      : null;

  const figure = (metric: Metric<number>, drillDown: string | null): OverviewFigure => ({
    metric,
    drillDown,
  });

  return {
    generatedAtUtc: new Date(now).toISOString(),
    status: {
      level,
      activeIncidents: figure(openIncidents, "/admin/operations?status=OPEN"),
      degradedServices,
      unresolvedAlerts,
      criticalAlerts,
      highAlerts,
      lastTelemetrySampleAtUtc: telemetrySampledAt,
    },
    customers: {
      total: figure(customersTotal, "/admin/customers"),
      active: figure(customersActive, "/admin/customers?status=ACTIVE"),
      suspended: figure(customersSuspended, "/admin/customers?status=SUSPENDED"),
      archived: figure(customersArchived, "/admin/customers?status=ARCHIVED"),
      enterpriseContracts: figure(
        enterpriseContracts,
        "/admin/customers?enterprise=true",
      ),
      onboarding: figure(onboardingCustomers, "/admin/customers?health=BLOCKED"),
      ssoOutageConnections,
      unverifiedDomains,
    },
    workspaces: {
      live: figure(workspacesLive, "/admin/workspaces?lifecycle=LIVE"),
      personal: figure(
        workspacesPersonal,
        "/admin/workspaces?lifecycle=LIVE&kind=PERSONAL",
      ),
      owned: figure(workspacesOwned, "/admin/workspaces?lifecycle=LIVE&kind=OWNED"),
      organization: figure(
        workspacesOrganization,
        "/admin/workspaces?lifecycle=LIVE&kind=ORGANIZATION",
      ),
      closed: figure(workspacesClosed, "/admin/workspaces?lifecycle=CLOSED"),
    },
    people: {
      total: figure(usersTotal, "/admin/users"),
      registered: figure(usersRegistered, "/admin/users?provider=EMAIL"),
      accountsByTier,
    },
    evidenceOps: evidenceOpsValue,
    evidenceVolume: {
      last24h: evidence24h,
      last7d: evidence7d,
      last30d: evidence30d,
    },
    security: {
      recentHighSecurityEvents: figure(
        recentHighSecurityEvents,
        // `eventSeverity`, not `severity`: the Operations page already owns
        // `severity` for the INCIDENT filter. Reusing it here would have made
        // this tile filter incidents while claiming to count security events.
        "/admin/operations?tab=security&eventSeverity=HIGH",
      ),
      ssoOutages: ssoOutageConnections,
      adminActionsLast24h: figure(adminActionsLast24h, "/admin/audit"),
      openIncidents: figure(openIncidents, "/admin/operations?status=OPEN"),
    },
    billing: {
      activeSubscriptions: figure(
        activeSubscriptions,
        "/admin/billing?subscriptionStatus=ACTIVE",
      ),
      pendingCancellations: figure(
        pendingCancellations,
        "/admin/billing?pendingCancellation=true",
      ),
      pastDueSubscriptions: figure(
        pastDueSubscriptions,
        "/admin/billing?subscriptionStatus=PAST_DUE",
      ),
      failedPaymentsLast30d: figure(
        failedPaymentsLast30d,
        "/admin/billing?paymentStatus=FAILED",
      ),
      grossRevenueByCurrency,
      subscriptionsByStatus: subscriptionStatusRows,
      activeStorageAddons: figure(activeStorageAddons, "/admin/billing?tab=addons"),
      // Unchanged and correct: `Subscription` has no billed-amount column, so
      // neither figure is derivable without inventing it.
      mrrCents: metricNotMeasured(
        "Subscription rows carry no billed-amount column, so recurring monthly revenue is not derivable from the schema. Not estimated.",
      ),
      arrCents: metricNotMeasured(
        "ARR follows from MRR, which is not derivable (Subscription has no amount column). Not estimated.",
      ),
    },
    traffic: {
      connected: trafficConnected,
      pageViewsLast7d,
      visitorsLast7d: visitors,
      topCountries,
      note: trafficConnected
        ? "Consented page-view analytics from public marketing pages (last 7 days)."
        : "No consented traffic recorded yet — analytics is enabled and waiting for consented page views / edge country headers.",
    },
  };
}

// LIVE_SUBSCRIPTION_STATUSES is exported for the billing surface, which needs
// the same definition of "currently live" that this overview counts.
export { LIVE_SUBSCRIPTION_STATUSES };
