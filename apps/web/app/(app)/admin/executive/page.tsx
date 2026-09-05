"use client";

/**
 * PROOVRA Platform Admin — Executive Dashboard (READ-ONLY).
 *
 * Honest platform KPIs in one glance. Every value is read live from
 * `/v1/admin/executive`. The whole point of this surface is honesty:
 *
 *   REAL cards (measured from live rows):
 *     - Gross revenue (all-time + this-month vs last-month)
 *     - Active customers (organizations + billing teams)
 *     - Enterprise customers
 *     - Leads (demo + contact-sales)
 *     - Evidence / Reports / Packages this-month vs last-month
 *     - Top customers by usage (DataTable)
 *     - At-risk customers (DataTable, labelled rule)
 *     - Failed operations
 *
 *   HONEST "Not measured" cards (NEVER fabricated):
 *     - Growth rate %  — no MRR/ARR baseline is modelled
 *     - MRR            — Subscription carries no amount column
 *     - ARR            — follows from MRR
 *
 * Gated by the shared `platform.admin` PageRouteGate (from admin/layout.tsx)
 * AND its own PageRouteGate wrapper here. Errors surface via
 * `toSafeUserError`. Uses only shared UI primitives — no legacy hero/page
 * chrome classes.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import {
  PageShell,
  PageHeader,
  PageSection,
  DataTable,
  useToast,
} from "../../../../components/ui";
import type { DataTableColumn } from "../../../../components/ui";
import { Card } from "../../../../components/ui/Card";
import { Badge } from "../../../../components/ui/Badge";
import type { BadgeTone } from "../../../../components/ui/Badge";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { ResultCount } from "../../../../components/ui/ResultCount";
import { Button } from "../../../../components/ui/Button";
import {
  AdmCard,
  AdmFacts,
} from "../../../../components/admin/AdminSurfaces";
import { apiFetch } from "../../../../lib/api";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";

type NotMeasured = { value: null; notMeasured: string };

type PeriodCount = { thisMonth: number; lastMonth: number };

type TopCustomer = {
  teamId: string;
  name: string;
  plan: string;
  billingStatus: string;
  evidenceCount: number;
};

type AtRiskCustomer = {
  teamId: string;
  name: string;
  plan: string;
  billingStatus: string;
  reasons: string[];
};

/** A money total in exactly ONE currency. Never aggregated across currencies. */
type CurrencyTotal = {
  currency: string;
  amountCents: number;
  payments: number;
};

type ExecutiveDashboard = {
  generatedAtUtc: string;
  // ADM-012 — the top-level `currency` constant is GONE. It asserted a
  // denomination for a cross-currency sum, which is the shape of the defect.
  // Currency now travels with each amount.
  revenue: {
    allTimeByCurrency: CurrencyTotal[];
    thisMonthByCurrency: CurrencyTotal[];
    lastMonthByCurrency: CurrencyTotal[];
    successfulPaymentsAllTime: number;
    growthRatePct: NotMeasured;
  };
  mrrCents: NotMeasured;
  arrCents: NotMeasured;
  renewalRiskCents: NotMeasured;
  customers: {
    /** CUSTOMER organizations with status ACTIVE (ADM-002). */
    activeCustomers: number;
    /** LIVE workspaces with billingStatus ACTIVE (ADM-004). */
    activeBillingWorkspaces: number;
    /** EnterpriseContract rows with status ACTIVE (ADM-003). */
    enterpriseContracts: number;
  };
  leads: {
    demoRequestsByStatus: Record<string, number>;
    demoRequestsTotal: number;
    contactSalesByStatus: Record<string, number>;
    contactSalesTotal: number;
  };
  usage: {
    evidence: PeriodCount;
    reports: PeriodCount;
    packages: PeriodCount;
  };
  topCustomers: TopCustomer[];
  atRisk: {
    rule: string;
    items: AtRiskCustomer[];
    /** The slice bound on `items` — the worst N by reason count. */
    limit: number;
  };
  failedOperations: {
    evidenceHashMismatch: number;
    evidenceVerificationFailed: number;
    reportGenerationFailures: NotMeasured;
  };
};

const INK_PRIMARY = "var(--ink-primary, #0f172a)";
const INK_SECONDARY = "var(--ink-secondary, #475569)";
const INK_MUTED = "var(--ink-muted, #94a3b8)";

function formatMoneyCents(cents: number | null | undefined, currency = "EUR") {
  if (cents == null) return null;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function formatCount(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return null;
  return new Intl.NumberFormat().format(value);
}

function momSub(period: PeriodCount): string {
  return `${formatCount(period.thisMonth) ?? 0} this month · ${formatCount(period.lastMonth) ?? 0} last month`;
}

// A metric tile — `value === null` renders an honest "Not measured" using
// the supplied reason. Never estimates.
function MetricTile({
  label,
  value,
  sub,
  notMeasuredReason,
  accent,
  testId,
}: {
  label: string;
  value: string | null;
  sub?: string;
  notMeasuredReason?: string;
  accent?: string;
  testId?: string;
}) {
  const measured = value != null;
  return (
    <Card padding="comfortable" style={{ minWidth: 0 }} data-testid={testId}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: INK_MUTED,
        }}
      >
        {label}
      </div>
      {/*
        A NON-VALUE IS RENDERED AS WORDS, NOT AS A NUMERAL.

        "Not measured" was set at 30px/750 in the same slot as the figures, and
        six of this page's sixteen tiles are non-values — two in the top-line
        row and a whole section of four. The result was that the largest, most
        emphatic text on the Executive Dashboard said "Not measured", six
        times, while "Active customers 2" sat beside it at the same weight.

        The honesty was already right and is untouched: the state is still
        stated, still unestimated, still carries its reason. What changes is
        that a 15px sentence and a 30px numeral no longer read as the same kind
        of thing — which is the point of distinguishing them at all. This is
        the same treatment `.adm-kpi__value[data-state]` applies across the
        rest of the console.
      */}
      <div
        data-state={measured ? undefined : "NOT_MEASURED"}
        style={{
          marginTop: 10,
          fontSize: measured ? 30 : 15,
          lineHeight: measured ? 1.05 : 1.4,
          fontWeight: measured ? 750 : 600,
          letterSpacing: measured ? "-0.02em" : 0,
          color: measured ? accent ?? INK_PRIMARY : INK_MUTED,
          overflowWrap: "anywhere",
        }}
      >
        {measured ? value : "Not measured"}
      </div>
      <div
        style={{
          marginTop: 8,
          fontSize: 12.5,
          lineHeight: 1.5,
          color: measured ? INK_SECONDARY : INK_MUTED,
        }}
      >
        {measured
          ? sub ?? ""
          : notMeasuredReason ?? "Not safely derivable from the schema."}
      </div>
    </Card>
  );
}

function planTone(plan: string): BadgeTone {
  const v = plan.toUpperCase();
  if (v === "ENTERPRISE") return "governance";
  if (v === "TEAM") return "info";
  if (v === "PRO") return "verified";
  return "neutral";
}

function billingTone(status: string): BadgeTone {
  const v = status.toUpperCase();
  if (v === "ACTIVE") return "verified";
  if (v === "PAST_DUE") return "risk";
  if (v === "CANCELED") return "neutral";
  return "pending";
}

function ExecutiveDashboardBody() {
  const { addToast } = useToast();
  const [data, setData] = useState<ExecutiveDashboard | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await apiFetch(`/v1/admin/executive`);
      setData(res ?? null);
    } catch (err) {
      const message = toSafeUserError(err, {
        message: "We couldn't load the executive dashboard.",
      }).message;
      addToast(message, "error");
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * ADM-012 — revenue is reported per currency.
   *
   * The headline tiles show the LARGEST currency by volume and say so; the full
   * per-currency breakdown is rendered underneath. Picking one silently, or
   * summing them, is the defect this replaced.
   */
  const primaryRevenue = data?.revenue.allTimeByCurrency[0] ?? null;

  const revenueMetrics = useMemo(() => {
    if (!data) return [];
    return [
      {
        label: primaryRevenue
          ? `Gross revenue (all-time, ${primaryRevenue.currency})`
          : "Gross revenue (all-time)",
        value: primaryRevenue
          ? formatMoneyCents(primaryRevenue.amountCents, primaryRevenue.currency)
          : null,
        sub: `${formatCount(data.revenue.successfulPaymentsAllTime) ?? 0} successful payments${
          data.revenue.allTimeByCurrency.length > 1
            ? ` across ${data.revenue.allTimeByCurrency.length} currencies`
            : ""
        }`,
        accent: "var(--ink-primary)",
        testId: "admin-executive-revenue-all-time",
      },
      {
        label: primaryRevenue
          ? `Gross revenue (this month, ${primaryRevenue.currency})`
          : "Gross revenue (this month)",
        value: (() => {
          if (!primaryRevenue) return null;
          const row = data.revenue.thisMonthByCurrency.find(
            (r) => r.currency === primaryRevenue.currency,
          );
          return formatMoneyCents(row?.amountCents ?? 0, primaryRevenue.currency);
        })(),
        sub: (() => {
          if (!primaryRevenue) return "—";
          const row = data.revenue.lastMonthByCurrency.find(
            (r) => r.currency === primaryRevenue.currency,
          );
          return `${formatMoneyCents(row?.amountCents ?? 0, primaryRevenue.currency) ?? "—"} last month`;
        })(),
        accent: "var(--ink-primary)",
        testId: "admin-executive-revenue-mom",
      },
      {
        label: "Active customers",
        value: formatCount(data.customers.activeCustomers),
        sub: `${formatCount(data.customers.activeBillingWorkspaces) ?? 0} live workspaces billing ACTIVE`,
        accent: "var(--ink-primary)",
        testId: "admin-executive-active-customers",
      },
      {
        label: "Enterprise customers",
        value: formatCount(data.customers.enterpriseContracts),
        // ADM-003 — the contract, not a plan string.
        sub: "Customers holding an ACTIVE enterprise contract",
        accent: "var(--ink-primary)",
        testId: "admin-executive-enterprise",
      },
      {
        label: "Leads",
        value: formatCount(
          data.leads.demoRequestsTotal + data.leads.contactSalesTotal
        ),
        sub: `${formatCount(data.leads.demoRequestsTotal) ?? 0} demo · ${formatCount(data.leads.contactSalesTotal) ?? 0} contact-sales`,
        accent: "var(--ink-primary)",
        testId: "admin-executive-leads",
      },
    ];
  }, [data, primaryRevenue]);

  const usageMetrics = useMemo(() => {
    if (!data) return [];
    /* Computed once, so the tone below and the value cannot disagree about
       whether there is anything to be alarmed about. */
    const failedOperationsCount =
      data.failedOperations.evidenceHashMismatch +
      data.failedOperations.evidenceVerificationFailed;
    return [
      {
        label: "Evidence",
        value: formatCount(data.usage.evidence.thisMonth),
        sub: momSub(data.usage.evidence),
        accent: "var(--ink-primary)",
        testId: "admin-executive-usage-evidence",
      },
      {
        label: "Reports",
        value: formatCount(data.usage.reports.thisMonth),
        sub: momSub(data.usage.reports),
        accent: "var(--ink-primary)",
        testId: "admin-executive-usage-reports",
      },
      {
        label: "Packages",
        value: formatCount(data.usage.packages.thisMonth),
        sub: momSub(data.usage.packages),
        accent: "var(--ink-primary)",
        testId: "admin-executive-usage-packages",
      },
      {
        label: "Failed operations",
        value: formatCount(
          data.failedOperations.evidenceHashMismatch +
            data.failedOperations.evidenceVerificationFailed
        ),
        sub: `${formatCount(data.failedOperations.evidenceHashMismatch) ?? 0} hash-mismatch · ${formatCount(data.failedOperations.evidenceVerificationFailed) ?? 0} verification FAILED`,
        /*
         * RED IS EARNED BY THE VALUE, NOT BY THE LABEL.
         *
         * This carried `--danger-strong` unconditionally, so "Failed
         * operations 0" — the good state, and the one an operator most wants
         * to be able to trust at a glance — rendered in red. A console that
         * paints zero failures red is a console whose red stops meaning
         * anything, and then the one figure that IS a failure gets missed.
         */
        accent: failedOperationsCount > 0 ? "var(--danger-strong)" : undefined,
        testId: "admin-executive-failed-ops",
      },
    ];
  }, [data]);

  // Honest "Not measured" cards — growth, MRR, ARR. These NEVER carry a value.
  const notMeasuredCards = useMemo(() => {
    if (!data) return [];
    return [
      {
        label: "Growth rate",
        reason: data.revenue.growthRatePct.notMeasured,
        testId: "admin-executive-growth-not-measured",
      },
      {
        label: "MRR",
        reason: data.mrrCents.notMeasured,
        testId: "admin-executive-mrr-not-measured",
      },
      {
        label: "ARR",
        reason: data.arrCents.notMeasured,
        testId: "admin-executive-arr-not-measured",
      },
      {
        label: "Renewal risk",
        reason: data.renewalRiskCents.notMeasured,
        testId: "admin-executive-renewal-risk-not-measured",
      },
    ];
  }, [data]);

  const topColumns: DataTableColumn<TopCustomer>[] = [
    {
      key: "name",
      header: "Customer",
      render: (r) => (
        <span style={{ fontWeight: 650, overflowWrap: "anywhere" }}>
          {r.name}
        </span>
      ),
    },
    {
      key: "plan",
      header: "Plan",
      render: (r) => <Badge tone={planTone(r.plan)}>{r.plan}</Badge>,
    },
    {
      key: "billingStatus",
      header: "Billing",
      render: (r) => <Badge tone={billingTone(r.billingStatus)}>{r.billingStatus}</Badge>,
    },
    {
      key: "evidenceCount",
      header: "Evidence",
      align: "right",
      nowrap: true,
      render: (r) => (
        <span style={{ fontWeight: 600 }}>{formatCount(r.evidenceCount)}</span>
      ),
    },
  ];

  const atRiskColumns: DataTableColumn<AtRiskCustomer>[] = [
    {
      key: "name",
      header: "Customer",
      render: (r) => (
        <span style={{ fontWeight: 650, overflowWrap: "anywhere" }}>
          {r.name}
        </span>
      ),
    },
    {
      key: "plan",
      header: "Plan",
      render: (r) => <Badge tone={planTone(r.plan)}>{r.plan}</Badge>,
    },
    {
      key: "billingStatus",
      header: "Billing",
      render: (r) => <Badge tone={billingTone(r.billingStatus)}>{r.billingStatus}</Badge>,
    },
    {
      key: "reasons",
      header: "Why at risk",
      render: (r) => (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {r.reasons.map((reason) => (
            <Badge key={reason} tone="risk" subtle>
              {reason}
            </Badge>
          ))}
        </div>
      ),
    },
  ];

  return (
    <PageShell width="full" data-testid="admin-executive">
      <PageHeader
        eyebrow="Platform admin"
        title="Executive Dashboard"
        subtitle="Read-only, honest platform KPIs. Gross revenue, customers, leads and usage are read live from real records. Growth rate, MRR, ARR and renewal-risk that are not safely derivable from the schema are shown as “Not measured” — never estimated."
        secondaryActions={
          <Button variant="secondary" onClick={() => void load()}>
            Refresh
          </Button>
        }
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
            {Array.from({ length: 5 }).map((_, i) => (
              <Card
                key={i}
                padding="comfortable"
                data-testid="admin-executive-loading-tile"
              >
                <div
                  aria-hidden="true"
                  style={{
                    height: 76,
                    borderRadius: 10,
                    background: "var(--surface-muted, #f1f4f9)",
                  }}
                />
              </Card>
            ))}
          </div>
        </PageSection>
      ) : !data ? (
        <PageSection>
          <Card variant="empty" padding="none">
            <EmptyState variant="inline"
              framed
              title="Executive dashboard not available"
              purpose="No aggregate was returned. Once revenue, customers, leads and usage records exist, the honest platform KPIs appear here."
              data-testid="admin-executive-empty"
            />
          </Card>
        </PageSection>
      ) : (
        <>
          <PageSection
            title="Top-line KPIs"
            description="Revenue, customers and leads — every value read live from real records."
          >
            <div
              data-testid="admin-executive-kpi-grid"
              style={{
                display: "grid",
                gap: 16,
                gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              }}
            >
              {revenueMetrics.map((m) => (
                <MetricTile
                  key={m.label}
                  label={m.label}
                  value={m.value}
                  sub={m.sub}
                  accent={m.accent}
                  testId={m.testId}
                />
              ))}
            </div>
          </PageSection>

          <PageSection
            title="Usage (this month vs last month)"
            description="Evidence, reports and verification packages by real createdAt / generatedAtUtc, plus failed operations."
          >
            <div
              style={{
                display: "grid",
                gap: 16,
                gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              }}
            >
              {usageMetrics.map((m) => (
                <MetricTile
                  key={m.label}
                  label={m.label}
                  value={m.value}
                  sub={m.sub}
                  accent={m.accent}
                  testId={m.testId}
                />
              ))}
            </div>
          </PageSection>

          <PageSection
            title="Not measured — honestly"
            description="These are NOT computable from the current schema. They are shown as “Not measured” with the reason — they are never fabricated or estimated."
          >
            {/*
              A LIST, NOT FOUR TILES.

              These four are STRUCTURALLY unmeasurable — the schema carries no
              billed-amount column and no renewal-opportunity model, so none of
              them can ever become a number. As four 210px metric tiles they
              occupied a whole screen band at the same visual weight as the
              revenue and customer figures above, which inverts what the page
              is for: an executive dashboard whose most prominent section is a
              list of things it cannot tell you.

              Every reason is preserved verbatim and each keeps its own test id,
              because "we do not fabricate this, and here is why" is a claim
              this page should keep making. It simply does not need four cards
              to make it.
            */}
            <AdmCard pad="compact" data-testid="admin-executive-not-measured-grid">
              <AdmFacts
                items={notMeasuredCards.map((c) => ({
                  key: c.label,
                  label: c.label,
                  value: (
                    <span data-testid={c.testId}>
                      <strong style={{ fontWeight: 650, color: INK_MUTED }}>
                        Not measured
                      </strong>
                      {c.reason ? (
                        <span
                          className="adm-secondary"
                          style={{ fontSize: 12.5, marginInlineStart: 8 }}
                        >
                          {c.reason}
                        </span>
                      ) : null}
                    </span>
                  ),
                }))}
              />
            </AdmCard>
          </PageSection>

          <PageSection
            title="Top customers by usage"
            description="Top workspaces ranked by live evidence count (real join via evidence teamId)."
          >
            <DataTable
              columns={topColumns}
              rows={data.topCustomers}
              getRowId={(r) => r.teamId}
              ariaLabel="Top customers by usage"
              emptyState={
                <EmptyState variant="inline"
                  title="No customer usage yet"
                  purpose="Once teams accumulate evidence, the highest-usage customers appear here."
                  data-testid="admin-executive-top-empty"
                />
              }
            />
          </PageSection>

          <PageSection
            title="At-risk customers"
            description={data.atRisk.rule}
          >
            <DataTable
              columns={atRiskColumns}
              rows={data.atRisk.items}
              getRowId={(r) => r.teamId}
              ariaLabel="At-risk customers"
              emptyState={
                <EmptyState variant="inline"
                  title="No at-risk customers"
                  purpose="No team currently matches the at-risk rule (PAST_DUE billing, unresolved SSO outage, or a recent failed payment)."
                  data-testid="admin-executive-at-risk-empty"
                />
              }
            />
            {/* The worst N by reason count. "No at-risk customers" and "none
                in the worst 25" are the same screen otherwise. */}
            <ResultCount
              shown={data.atRisk.items.length}
              cap={data.atRisk.limit}
              noun="at-risk customer"
              data-testid="admin-executive-at-risk-count"
            />
          </PageSection>
        </>
      )}
    </PageShell>
  );
}

export default function AdminExecutivePage() {
  return (
    <PageRouteGate routeId="platform.executive">
      <ExecutiveDashboardBody />
    </PageRouteGate>
  );
}
