import { prisma } from "../../db.js";
import {
  customerOrganizationWhere,
  liveWorkspaceWhere,
} from "@proovra/shared-runtime";

/**
 * PROOVRA Platform Admin — Executive Dashboard aggregation (READ-ONLY).
 *
 * Pure aggregation over EXISTING platform models. Touches NO checkout /
 * entitlement / provisioning logic. It reads and projects honest platform
 * KPIs and is the single data source for the `/v1/admin/executive` route.
 *
 * HONESTY CONTRACT (the whole point of this surface):
 *   REAL (measured from live rows):
 *     - Gross revenue (all-time + this-month vs last-month) — sum of
 *       Payment.amountCents where status = SUCCEEDED. Same computation
 *       shape the billing/analytics aggregates already use.
 *     - Active customers — Organization rows with status = ACTIVE, and
 *       Team rows with billingStatus = ACTIVE (both reported honestly;
 *       neither is claimed to be the other).
 *     - Enterprise customers — Team rows on the ENTERPRISE plan.
 *     - Leads — DemoRequest + ContactSalesRequest counts by status.
 *     - Evidence / Reports / verification Packages this-month vs
 *       last-month (real createdAt / generatedAtUtc counts).
 *     - Top customers by usage — top N teams by live Evidence count.
 *     - At-risk customers — teams with billingStatus PAST_DUE, OR an
 *       unresolved SSO outage, OR a recent FAILED payment. The exact
 *       rule is labelled on every row so the operator can audit it.
 *     - Failed operations — FAILED_HASH_MISMATCH evidence + evidence
 *       whose verificationStatus = FAILED (real terminal states).
 *
 *   HONEST NULL (NEVER fabricated — returned as null with a reason):
 *     - Growth rate % — no historical MRR/ARR baseline is modelled, so a
 *       period-over-period growth rate is not safely derivable.
 *     - MRR — Subscription rows carry NO amount column in the schema, so
 *       recurring monthly revenue is not derivable from subscriptions.
 *     - ARR — follows from MRR; not derivable.
 *     - Renewal-risk $ — there is no renewal-opportunity model and
 *       Subscription has no amount column, so a dollar figure would be
 *       invented. Returned null.
 *
 * Every "not measured" value is null + a `notMeasured` reason string. The
 * route and page render "Not measured" — they never estimate.
 */

const FAILED_PAYMENT_LOOKBACK_DAYS = 30;
const TOP_CUSTOMERS_LIMIT = 10;
const AT_RISK_LIMIT = 25;

export type NotMeasured = {
  value: null;
  notMeasured: string;
};

function notMeasured(reason: string): NotMeasured {
  return { value: null, notMeasured: reason };
}

export type PeriodCount = {
  thisMonth: number;
  lastMonth: number;
};

/** A money total in exactly ONE currency. Never aggregated across currencies. */
export type CurrencyPeriodTotal = {
  currency: string;
  amountCents: number;
  payments: number;
};

export type TopCustomer = {
  teamId: string;
  name: string;
  plan: string;
  billingStatus: string;
  evidenceCount: number;
};

export type AtRiskCustomer = {
  teamId: string;
  name: string;
  plan: string;
  billingStatus: string;
  /** The concrete rule(s) that flagged this row (auditable, never vague). */
  reasons: string[];
};

export type ExecutiveDashboard = {
  generatedAtUtc: string;
  // ADM-012 — the top-level `currency: "EUR"` field is REMOVED. It was a
  // constant asserting a denomination for a cross-currency sum, which is the
  // exact shape of the defect. Currency now travels WITH each amount.

  revenue: {
    /**
     * REAL — SUCCEEDED payment totals, ONE ENTRY PER CURRENCY (ADM-012).
     *
     * `Payment.amountCents` is a minor-unit integer denominated by
     * `Payment.currency`. Summing across currencies produces a number that is
     * not money in any of them, and the previous single `grossRevenueCents*`
     * fields did exactly that before the page rendered the result as EUR. No
     * FX conversion is performed: this codebase has no rate authority, and
     * inventing one to make a single headline number would be the same class of
     * fabrication the honesty contract forbids everywhere else.
     */
    allTimeByCurrency: CurrencyPeriodTotal[];
    thisMonthByCurrency: CurrencyPeriodTotal[];
    lastMonthByCurrency: CurrencyPeriodTotal[];
    successfulPaymentsAllTime: number;
    /** HONEST NULL — no MRR/ARR baseline → growth rate not derivable. */
    growthRatePct: NotMeasured;
  };

  /** HONEST NULL — Subscription has no amount column. */
  mrrCents: NotMeasured;
  /** HONEST NULL — follows from MRR. */
  arrCents: NotMeasured;
  /** HONEST NULL — no renewal-opportunity model, no subscription amount. */
  renewalRiskCents: NotMeasured;

  customers: {
    /** REAL — CUSTOMER organizations with status = ACTIVE (ADM-002). */
    activeCustomers: number;
    /** REAL — LIVE workspaces with billingStatus = ACTIVE (ADM-004). */
    activeBillingWorkspaces: number;
    /** REAL — EnterpriseContract rows with status = ACTIVE (ADM-003). */
    enterpriseContracts: number;
  };

  leads: {
    /** REAL — DemoRequest counts by status. */
    demoRequestsByStatus: Record<string, number>;
    demoRequestsTotal: number;
    /** REAL — ContactSalesRequest counts by status. */
    contactSalesByStatus: Record<string, number>;
    contactSalesTotal: number;
  };

  usage: {
    /** REAL — live Evidence created this-month vs last-month. */
    evidence: PeriodCount;
    /** REAL — Reports generated (generatedAtUtc) this-month vs last-month. */
    reports: PeriodCount;
    /** REAL — verification packages generated this-month vs last-month. */
    packages: PeriodCount;
  };

  /** REAL — top N teams by live Evidence count. */
  topCustomers: TopCustomer[];

  /** REAL — teams flagged by a labelled at-risk rule. */
  atRisk: {
    rule: string;
    items: AtRiskCustomer[];
  };

  failedOperations: {
    /** REAL — Evidence in the FAILED_HASH_MISMATCH terminal state. */
    evidenceHashMismatch: number;
    /** REAL — Evidence whose verificationStatus = FAILED. */
    evidenceVerificationFailed: number;
    /**
     * HONEST NULL — a Report row is written only on SUCCESS (the worker
     * DLQs on failure without persisting a Report), so there is no
     * Report.status column to count failed report generation from here.
     */
    reportGenerationFailures: NotMeasured;
  };
};

function startOfMonthUtc(year: number, monthIndex: number): Date {
  return new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
}

/**
 * Build the honest Executive Dashboard aggregate. Pure read; no writes.
 * `now` is injectable so callers/tests can pin the month boundaries.
 */
export async function buildExecutiveDashboard(
  now: Date = new Date()
): Promise<ExecutiveDashboard> {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();

  const thisMonthStart = startOfMonthUtc(year, month);
  const lastMonthStart = startOfMonthUtc(year, month - 1);
  const nextMonthStart = startOfMonthUtc(year, month + 1);
  const failedPaymentSince = new Date(
    now.getTime() - FAILED_PAYMENT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  );

  const [
    revenueAllTime,
    revenueThisMonth,
    revenueLastMonth,
    activeOrganizations,
    activeBillingTeams,
    enterpriseTeams,
    demoByStatus,
    contactByStatus,
    evidenceThisMonth,
    evidenceLastMonth,
    reportsThisMonth,
    reportsLastMonth,
    packagesThisMonth,
    packagesLastMonth,
    evidenceByTeam,
    hashMismatch,
    verificationFailed,
    pastDueTeams,
    ssoOutages,
    recentFailedPayments,
  ] = await Promise.all([
    // REAL gross revenue — SUCCEEDED payment totals GROUPED BY CURRENCY
    // (ADM-012). Never one cross-currency sum.
    prisma.payment.groupBy({
      by: ["currency"],
      where: { status: "SUCCEEDED" },
      _sum: { amountCents: true },
      _count: { _all: true },
    }),
    prisma.payment.groupBy({
      by: ["currency"],
      where: {
        status: "SUCCEEDED",
        createdAt: { gte: thisMonthStart, lt: nextMonthStart },
      },
      _sum: { amountCents: true },
      _count: { _all: true },
    }),
    prisma.payment.groupBy({
      by: ["currency"],
      where: {
        status: "SUCCEEDED",
        createdAt: { gte: lastMonthStart, lt: thisMonthStart },
      },
      _sum: { amountCents: true },
      _count: { _all: true },
    }),
    // REAL active-customer counts.
    //
    // ADM-002 / ADM-003 / ADM-004 (2026-08-27) — three corrections:
    //   * CUSTOMER organizations only. Without the `kind` predicate this
    //     counted the 1:1 SYSTEM container every workspace owns, so "active
    //     customers" was approximately the workspace count.
    //   * LIVE workspaces only. Closure writes neither `billingPlan` nor
    //     `billingStatus`, so a closed workspace on a paid plan kept reporting
    //     as an active billing customer indefinitely.
    //   * Enterprise is the CONTRACT, never `billingPlan === 'ENTERPRISE'`.
    prisma.organization.count({
      where: { ...customerOrganizationWhere(), status: "ACTIVE" },
    }),
    prisma.team.count({
      where: { ...liveWorkspaceWhere(), billingStatus: "ACTIVE" },
    }),
    prisma.enterpriseContract.count({ where: { status: "ACTIVE" } }),
    // REAL leads.
    prisma.demoRequest.groupBy({
      by: ["status"],
      _count: { status: true },
    }),
    prisma.contactSalesRequest.groupBy({
      by: ["status"],
      _count: { status: true },
    }),
    // REAL usage — evidence (live rows only), reports, packages MoM.
    prisma.evidence.count({
      where: {
        deletedAt: null,
        createdAt: { gte: thisMonthStart, lt: nextMonthStart },
      },
    }),
    prisma.evidence.count({
      where: {
        deletedAt: null,
        createdAt: { gte: lastMonthStart, lt: thisMonthStart },
      },
    }),
    prisma.report.count({
      where: { generatedAtUtc: { gte: thisMonthStart, lt: nextMonthStart } },
    }),
    prisma.report.count({
      where: { generatedAtUtc: { gte: lastMonthStart, lt: thisMonthStart } },
    }),
    // Verification packages: Evidence rows whose package was generated in
    // the period (verificationPackageGeneratedAtUtc is the real stamp).
    prisma.evidence.count({
      where: {
        deletedAt: null,
        verificationPackageGeneratedAtUtc: {
          gte: thisMonthStart,
          lt: nextMonthStart,
        },
      },
    }),
    prisma.evidence.count({
      where: {
        deletedAt: null,
        verificationPackageGeneratedAtUtc: {
          gte: lastMonthStart,
          lt: thisMonthStart,
        },
      },
    }),
    // REAL top-customers-by-usage — live Evidence grouped by team.
    prisma.evidence.groupBy({
      by: ["teamId"],
      where: { deletedAt: null, teamId: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { teamId: "desc" } },
      take: TOP_CUSTOMERS_LIMIT,
    }),
    // REAL failed operations.
    prisma.evidence.count({
      where: { deletedAt: null, status: "FAILED_HASH_MISMATCH" },
    }),
    prisma.evidence.count({
      where: { deletedAt: null, verificationStatus: "FAILED" },
    }),
    // At-risk signal 1 — PAST_DUE billing on a LIVE workspace.
    //
    // ADM-004 — a closed workspace mid-cancellation is not a retention target;
    // surfacing it as "at risk" sends an operator to chase a customer who has
    // already gone, and buries the ones who have not.
    prisma.team.findMany({
      where: { ...liveWorkspaceWhere(), billingStatus: "PAST_DUE" },
      select: {
        id: true,
        name: true,
        billingPlan: true,
        billingStatus: true,
      },
      take: AT_RISK_LIMIT,
    }),
    // At-risk signal 2 — unresolved SSO outage (detected, not cleared).
    prisma.ssoConnection.findMany({
      where: {
        outageDetectedAtUtc: { not: null },
        outageClearedAtUtc: null,
      },
      select: { teamId: true },
      take: AT_RISK_LIMIT,
    }),
    // At-risk signal 3 — a recent FAILED payment (last 30 days).
    prisma.payment.findMany({
      where: {
        status: "FAILED",
        createdAt: { gte: failedPaymentSince },
        teamId: { not: null },
      },
      select: { teamId: true },
      take: 500,
    }),
  ]);

  // ---- Revenue (REAL, per currency) ---------------------------------------
  const toCurrencyTotals = (
    rows: Array<{
      currency: string | null;
      _sum: { amountCents: number | null };
      _count: { _all: number };
    }>,
  ): CurrencyPeriodTotal[] =>
    rows
      .map((r) => ({
        currency: (r.currency ?? "").toUpperCase() || "UNKNOWN",
        amountCents: r._sum.amountCents ?? 0,
        payments: r._count._all,
      }))
      .sort((a, b) => b.amountCents - a.amountCents);

  const allTimeByCurrency = toCurrencyTotals(revenueAllTime);
  const thisMonthByCurrency = toCurrencyTotals(revenueThisMonth);
  const lastMonthByCurrency = toCurrencyTotals(revenueLastMonth);
  // A COUNT is currency-free, so this one total remains meaningful.
  const successfulPaymentsAllTime = allTimeByCurrency.reduce(
    (sum, r) => sum + r.payments,
    0,
  );

  // ---- Leads (REAL) --------------------------------------------------------
  const demoRequestsByStatus: Record<string, number> = {};
  let demoRequestsTotal = 0;
  for (const g of demoByStatus) {
    const key = String(g.status);
    demoRequestsByStatus[key] = g._count.status;
    demoRequestsTotal += g._count.status;
  }
  const contactSalesByStatus: Record<string, number> = {};
  let contactSalesTotal = 0;
  for (const g of contactByStatus) {
    const key = String(g.status);
    contactSalesByStatus[key] = g._count.status;
    contactSalesTotal += g._count.status;
  }

  // ---- Top customers (REAL) — resolve team names for the top team ids ------
  const topTeamIds = evidenceByTeam
    .map((g) => g.teamId)
    .filter((id): id is string => id != null);
  const topTeams = topTeamIds.length
    ? await prisma.team.findMany({
        where: { id: { in: topTeamIds } },
        select: {
          id: true,
          name: true,
          billingPlan: true,
          billingStatus: true,
        },
      })
    : [];
  const topTeamById = new Map(topTeams.map((t) => [t.id, t]));
  const topCustomers: TopCustomer[] = evidenceByTeam
    .filter((g) => g.teamId != null)
    .map((g) => {
      const t = topTeamById.get(g.teamId as string);
      return {
        teamId: g.teamId as string,
        name: t?.name ?? "—",
        plan: t?.billingPlan ?? "—",
        billingStatus: t?.billingStatus ?? "—",
        evidenceCount: g._count._all,
      };
    });

  // ---- At-risk customers (REAL, labelled rule) -----------------------------
  const AT_RISK_RULE =
    "Team is flagged at-risk when ANY of: billingStatus = PAST_DUE; an " +
    "unresolved SSO outage (outageDetected set, not cleared); or a FAILED " +
    `payment in the last ${FAILED_PAYMENT_LOOKBACK_DAYS} days.`;

  const riskReasonsByTeam = new Map<string, Set<string>>();
  const addReason = (teamId: string, reason: string) => {
    const set = riskReasonsByTeam.get(teamId) ?? new Set<string>();
    set.add(reason);
    riskReasonsByTeam.set(teamId, set);
  };
  for (const t of pastDueTeams) addReason(t.id, "Billing PAST_DUE");
  for (const c of ssoOutages) {
    if (c.teamId) addReason(c.teamId, "Unresolved SSO outage");
  }
  for (const p of recentFailedPayments) {
    if (p.teamId) {
      addReason(
        p.teamId,
        `Failed payment in last ${FAILED_PAYMENT_LOOKBACK_DAYS}d`
      );
    }
  }

  const atRiskTeamIds = Array.from(riskReasonsByTeam.keys());
  const atRiskTeams = atRiskTeamIds.length
    ? await prisma.team.findMany({
        where: { id: { in: atRiskTeamIds } },
        select: {
          id: true,
          name: true,
          billingPlan: true,
          billingStatus: true,
        },
      })
    : [];
  const atRiskTeamById = new Map(atRiskTeams.map((t) => [t.id, t]));
  const atRiskItems: AtRiskCustomer[] = atRiskTeamIds
    .map((teamId) => {
      const t = atRiskTeamById.get(teamId);
      return {
        teamId,
        name: t?.name ?? "—",
        plan: t?.billingPlan ?? "—",
        billingStatus: t?.billingStatus ?? "—",
        reasons: Array.from(riskReasonsByTeam.get(teamId) ?? []),
      };
    })
    .sort((a, b) => b.reasons.length - a.reasons.length)
    .slice(0, AT_RISK_LIMIT);

  return {
    generatedAtUtc: now.toISOString(),

    revenue: {
      allTimeByCurrency,
      thisMonthByCurrency,
      lastMonthByCurrency,
      successfulPaymentsAllTime,
      // HONEST NULL — no MRR/ARR baseline → no derivable growth rate.
      growthRatePct: notMeasured(
        "No historical MRR/ARR baseline is modelled, so a period-over-period growth rate is not safely derivable. Not estimated."
      ),
    },

    // HONEST NULL — Subscription rows carry no amount column.
    mrrCents: notMeasured(
      "Subscription rows carry no billed-amount column, so recurring monthly revenue (MRR) is not derivable from the schema. Not estimated."
    ),
    arrCents: notMeasured(
      "ARR follows from MRR, which is not derivable (Subscription has no amount column). Not estimated."
    ),
    renewalRiskCents: notMeasured(
      "There is no renewal-opportunity model and Subscription carries no amount column, so a renewal-risk dollar figure would be fabricated. Not estimated."
    ),

    customers: {
      activeCustomers: activeOrganizations,
      activeBillingWorkspaces: activeBillingTeams,
      enterpriseContracts: enterpriseTeams,
    },

    leads: {
      demoRequestsByStatus,
      demoRequestsTotal,
      contactSalesByStatus,
      contactSalesTotal,
    },

    usage: {
      evidence: { thisMonth: evidenceThisMonth, lastMonth: evidenceLastMonth },
      reports: { thisMonth: reportsThisMonth, lastMonth: reportsLastMonth },
      packages: { thisMonth: packagesThisMonth, lastMonth: packagesLastMonth },
    },

    topCustomers,

    atRisk: {
      rule: AT_RISK_RULE,
      items: atRiskItems,
    },

    failedOperations: {
      evidenceHashMismatch: hashMismatch,
      evidenceVerificationFailed: verificationFailed,
      reportGenerationFailures: notMeasured(
        "A Report row is written only on successful generation (the worker DLQs on failure without persisting a Report), so failed report generation has no Report.status column to count here. Not estimated."
      ),
    },
  };
}
