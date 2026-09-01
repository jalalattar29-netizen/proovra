"use client";

/**
 * Platform Control Center — Cost Dashboard (item G).
 *
 * READ-ONLY aggregation over EXISTING provider-cost models. Renders:
 *   - metric Cards: total ESTIMATED spend (USD), provider count, budgets at
 *     risk,
 *   - a per-provider cost DataTable (cost + units + operation count),
 *   - top operations by cost,
 *   - budget posture (soft / hard limits + state + recent alerts),
 *   - embeddings / semantic spend labelled honestly as EUR (a different
 *     currency — never summed into the USD total),
 *   - entitlement consumption,
 *   - honest "Not connected — no usage recorded for this category" states for
 *     unmetered categories (storage $, bandwidth, infra, email, SMS).
 *
 * Costs are ESTIMATED (from ProviderUsageEvent.estimatedCostUsdMicros), never
 * billed invoice amounts. Wrapped in the `platform.admin` PageRouteGate.
 * Errors surface via toSafeUserError. No API keys / secrets are surfaced.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { PageShell, PageHeader, PageSection, DataTable } from "../../../../components/ui";
import type { DataTableColumn } from "../../../../components/ui";
import { Card } from "../../../../components/ui/Card";
import { Badge } from "../../../../components/ui/Badge";
import type { BadgeTone } from "../../../../components/ui/Badge";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { Button } from "../../../../components/ui/Button";
import { useToast } from "../../../../components/ui";
import { PageRouteGate } from "../../../../components/navigation/PageRouteGate";
import { apiFetch } from "../../../../lib/api";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { formatUserDateTime } from "../../../../lib/date";

type ProviderCost = {
  provider: string;
  costUsdMicros: number;
  costUsd: number;
  units: number;
  operationCount: number;
};

type TopOperation = {
  provider: string;
  operation: string;
  costUsdMicros: number;
  costUsd: number;
  units: number;
  count: number;
};

type BudgetPosture = {
  id: string;
  provider: string | null;
  scope: string;
  period: string;
  state: string;
  softLimitUsd: number;
  hardLimitUsd: number;
  atRisk: boolean;
  recentAlerts: Array<{
    threshold: string;
    consumedUsd: number;
    occurredAtUtc: string;
  }>;
};

type EntitlementConsumption = {
  key: string;
  consumed: number;
  periodStartUtc: string | null;
};

type NotConnectedCategory = {
  category: string;
  notConnected: true;
  reason: string;
};

type CostDashboard = {
  windowDays: number;
  windowStartUtc: string;
  windowEndUtc: string;
  estimated: true;
  currency: "USD";
  totals: {
    estimatedCostUsd: number;
    providerCount: number;
    eventCount: number;
    budgetsAtRisk: number;
  };
  perProvider: ProviderCost[];
  topOperations: TopOperation[];
  budgets: BudgetPosture[];
  semanticSpend: {
    currency: "EUR";
    note: string;
    eurSpent: number;
    chunksEmbedded: number;
    tokensConsumed: number;
    dayCount: number;
    connected: boolean;
  };
  entitlements: EntitlementConsumption[];
  notConnectedCategories: NotConnectedCategory[];
};

const INK_PRIMARY = "var(--ink-primary, #0f172a)";
const INK_SECONDARY = "var(--ink-secondary, #475569)";
const INK_MUTED = "var(--ink-muted, #94a3b8)";

function formatMoney(value: number | null | undefined, currency: string) {
  if (value == null || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatCount(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return "0";
  return new Intl.NumberFormat().format(value);
}

function formatTimestamp(value: string) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return formatUserDateTime(value);
}

function budgetStateTone(state: string, atRisk: boolean): BadgeTone {
  if (atRisk) return "risk";
  const v = state.toUpperCase();
  if (v === "DISABLED") return "neutral";
  if (v === "EXHAUSTED") return "risk";
  return "verified";
}

function MetricTile({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <Card padding="comfortable" style={{ minWidth: 0 }}>
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
      <div
        style={{
          marginTop: 10,
          fontSize: 30,
          lineHeight: 1.05,
          fontWeight: 750,
          letterSpacing: "-0.02em",
          color: accent ?? INK_PRIMARY,
          overflowWrap: "anywhere",
        }}
      >
        {value}
      </div>
      <div
        style={{
          marginTop: 8,
          fontSize: 12.5,
          lineHeight: 1.5,
          color: INK_SECONDARY,
        }}
      >
        {sub ?? ""}
      </div>
    </Card>
  );
}

function AdminCostsInner() {
  const { addToast } = useToast();
  const [data, setData] = useState<CostDashboard | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await apiFetch(`/v1/admin/costs?windowDays=30`);
      setData(res ?? null);
    } catch (err) {
      const message = toSafeUserError(err, {
        message: "We couldn't load the cost dashboard.",
      }).message;
      addToast(message, "error");
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const metrics = useMemo(() => {
    if (!data) return [];
    return [
      {
        label: "Total estimated spend",
        value: formatMoney(data.totals.estimatedCostUsd, "USD"),
        sub: `${formatCount(data.totals.eventCount)} usage events · last ${data.windowDays} days`,
        accent: "#1e3a5f",
      },
      {
        label: "Providers with usage",
        value: formatCount(data.totals.providerCount),
        sub: "Providers that recorded metered usage in the window",
        accent: "#1e3a5f",
      },
      {
        label: "Budgets at risk",
        value: formatCount(data.totals.budgetsAtRisk),
        sub: "Budgets with a recent alert or in an exhausted state",
        accent: data.totals.budgetsAtRisk > 0 ? "#8f4c4c" : "#1e3a5f",
      },
    ];
  }, [data]);

  const providerColumns: DataTableColumn<ProviderCost>[] = [
    {
      key: "provider",
      header: "Provider",
      render: (r) => <span style={{ fontWeight: 650 }}>{r.provider}</span>,
    },
    {
      key: "costUsd",
      header: "Estimated cost",
      align: "right",
      nowrap: true,
      render: (r) => (
        <span style={{ fontWeight: 600 }}>{formatMoney(r.costUsd, "USD")}</span>
      ),
    },
    {
      key: "units",
      header: "Units",
      align: "right",
      render: (r) => formatCount(r.units),
    },
    {
      key: "operationCount",
      header: "Operations",
      align: "right",
      render: (r) => formatCount(r.operationCount),
    },
  ];

  const operationColumns: DataTableColumn<TopOperation>[] = [
    {
      key: "operation",
      header: "Operation",
      render: (r) => (
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>{r.operation}</div>
          <div style={{ fontSize: 12, color: INK_MUTED, marginTop: 2 }}>
            {r.provider}
          </div>
        </div>
      ),
    },
    {
      key: "costUsd",
      header: "Estimated cost",
      align: "right",
      nowrap: true,
      render: (r) => (
        <span style={{ fontWeight: 600 }}>{formatMoney(r.costUsd, "USD")}</span>
      ),
    },
    {
      key: "count",
      header: "Events",
      align: "right",
      render: (r) => formatCount(r.count),
    },
  ];

  const entitlementColumns: DataTableColumn<EntitlementConsumption>[] = [
    {
      key: "key",
      header: "Entitlement",
      render: (r) => <span style={{ fontWeight: 600 }}>{r.key}</span>,
    },
    {
      key: "consumed",
      header: "Consumed",
      align: "right",
      render: (r) => formatCount(r.consumed),
    },
    {
      key: "periodStartUtc",
      header: "Period start",
      nowrap: true,
      render: (r) => (
        <span style={{ fontSize: 12, color: INK_MUTED }}>
          {r.periodStartUtc ? formatTimestamp(r.periodStartUtc) : "—"}
        </span>
      ),
    },
  ];

  return (
    <PageShell width="full">
      <PageHeader
        eyebrow="Platform admin"
        title="Cost Dashboard"
        subtitle="Read-only view of estimated provider costs across every workspace. All figures are ESTIMATED at metering time (from estimatedCostUsdMicros) — they are not billed invoice amounts. Provider costs are USD; embeddings spend is EUR and is shown separately, never summed into the USD total. No API keys or provider secrets are surfaced. Unmetered categories are shown honestly as “Not connected”, never as a fabricated number."
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
            {Array.from({ length: 3 }).map((_, i) => (
              <Card key={i} padding="comfortable" data-testid="admin-costs-loading-tile">
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
            <EmptyState
              framed
              title="No cost data"
              purpose="No cost aggregate was returned. Once provider usage events exist, estimated costs, per-provider breakdown, budgets and embeddings spend appear here."
              data-testid="admin-costs-empty"
            />
          </Card>
        </PageSection>
      ) : (
        <div data-testid="admin-costs">
          <PageSection
            title="Estimated cost metrics"
            description="Every value is read live from the cost aggregate. Costs are estimated from recorded provider usage — not billed invoice amounts."
          >
            <div
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
                />
              ))}
            </div>
            <div style={{ marginTop: 12, fontSize: 12.5, color: INK_MUTED }}>
              Costs are ESTIMATED (from estimatedCostUsdMicros) and shown in USD.
              Embeddings / semantic spend is reported in EUR below and is a
              different currency — it is never summed into the USD total.
            </div>
          </PageSection>

          <PageSection
            title="Per-provider estimated cost"
            description="Estimated USD cost, units, and operation count per provider over the window (real recorded usage)."
          >
            <DataTable
              columns={providerColumns}
              rows={data.perProvider}
              getRowId={(r) => r.provider}
              ariaLabel="Per-provider estimated cost"
              emptyState={
                <EmptyState
                  title="No provider usage recorded"
                  purpose="No provider usage events were recorded in this window. Once usage is metered, per-provider estimated costs appear here."
                  data-testid="admin-costs-providers-empty"
                />
              }
            />
          </PageSection>

          <PageSection
            title="Top operations by estimated cost"
            description="The most expensive operations across all providers in the window (real recorded usage)."
          >
            <DataTable
              columns={operationColumns}
              rows={data.topOperations}
              getRowId={(r) => `${r.provider}:${r.operation}`}
              ariaLabel="Top operations by estimated cost"
              emptyState={
                <EmptyState
                  title="No operations recorded"
                  purpose="No operations were recorded in this window."
                  data-testid="admin-costs-operations-empty"
                />
              }
            />
          </PageSection>

          <PageSection
            title="Budget posture"
            description="Soft / hard budget limits and state. A budget is flagged at risk when it has a recent alert or is exhausted."
          >
            {data.budgets.length === 0 ? (
              <Card variant="empty" padding="none">
                <EmptyState
                  framed
                  title="No budgets configured"
                  purpose="No provider budgets are configured. Once budgets exist, their limits, state and recent alerts appear here."
                  data-testid="admin-costs-budgets-empty"
                />
              </Card>
            ) : (
              <div
                style={{
                  display: "grid",
                  gap: 12,
                  gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
                }}
              >
                {data.budgets.map((b) => (
                  <Card
                    key={b.id}
                    padding="comfortable"
                    title={b.provider ?? "All providers"}
                    headerAction={
                      <Badge tone={budgetStateTone(b.state, b.atRisk)} dot>
                        {b.atRisk ? "At risk" : b.state}
                      </Badge>
                    }
                  >
                    <div style={{ display: "grid", gap: 6, fontSize: 13 }}>
                      <div style={{ color: INK_SECONDARY }}>
                        Scope: {b.scope} · {b.period}
                      </div>
                      <div style={{ color: INK_PRIMARY }}>
                        Soft limit: {formatMoney(b.softLimitUsd, "USD")}
                      </div>
                      <div style={{ color: INK_PRIMARY }}>
                        Hard limit: {formatMoney(b.hardLimitUsd, "USD")}
                      </div>
                      {b.recentAlerts.length > 0 ? (
                        <div style={{ color: INK_MUTED, fontSize: 12 }}>
                          {formatCount(b.recentAlerts.length)} recent alert
                          {b.recentAlerts.length === 1 ? "" : "s"} · latest{" "}
                          {b.recentAlerts[0]?.threshold}
                        </div>
                      ) : (
                        <div style={{ color: INK_MUTED, fontSize: 12 }}>
                          No alerts in window
                        </div>
                      )}
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </PageSection>

          <PageSection
            title="Embeddings / semantic spend (EUR)"
            description="Semantic-index spend is recorded in EUR — a different currency from the USD provider costs above. It is reported separately and never summed into the USD total."
          >
            {data.semanticSpend.connected ? (
              <div
                style={{
                  display: "grid",
                  gap: 16,
                  gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                }}
              >
                <MetricTile
                  label="Semantic spend (EUR)"
                  value={formatMoney(data.semanticSpend.eurSpent, "EUR")}
                  sub={`${formatCount(data.semanticSpend.dayCount)} days recorded`}
                  accent="#1e3a5f"
                />
                <MetricTile
                  label="Chunks embedded"
                  value={formatCount(data.semanticSpend.chunksEmbedded)}
                  sub="Total chunks embedded in the window"
                />
                <MetricTile
                  label="Tokens consumed"
                  value={formatCount(data.semanticSpend.tokensConsumed)}
                  sub="Embedding tokens consumed in the window"
                />
              </div>
            ) : (
              <Card variant="empty" padding="none">
                <EmptyState
                  framed
                  title="Not connected — no embeddings spend recorded"
                  purpose="No semantic-usage rows were recorded in this window. Once the semantic index records activity, EUR spend appears here."
                  data-testid="admin-costs-semantic-not-connected"
                />
              </Card>
            )}
          </PageSection>

          <PageSection
            title="Entitlement consumption"
            description="Consumption per entitlement key for the recorded billing periods (real counters)."
          >
            <DataTable
              columns={entitlementColumns}
              rows={data.entitlements}
              getRowId={(r) => `${r.key}:${r.periodStartUtc ?? "none"}`}
              ariaLabel="Entitlement consumption"
              emptyState={
                <EmptyState
                  title="No entitlement usage recorded"
                  purpose="No entitlement consumption has been recorded. Once metered features are used, consumption appears here."
                  data-testid="admin-costs-entitlements-empty"
                />
              }
            />
          </PageSection>

          <PageSection
            title="Unmetered cost categories"
            description="These cost categories are not metered by any usage model in this system. They are shown honestly as “Not connected” — never as a fabricated number."
          >
            <div
              style={{
                display: "grid",
                gap: 12,
                gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
              }}
            >
              {data.notConnectedCategories.map((c) => (
                <Card
                  key={c.category}
                  padding="comfortable"
                  title={c.category}
                  headerAction={<Badge tone="neutral">Not connected</Badge>}
                >
                  <div style={{ fontSize: 13, color: INK_SECONDARY }}>
                    Not connected — no usage recorded for this category.
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12, color: INK_MUTED }}>
                    {c.reason}
                  </div>
                </Card>
              ))}
            </div>
          </PageSection>
        </div>
      )}
    </PageShell>
  );
}

export default function AdminCostsPage() {
  return (
    <PageRouteGate routeId="platform.costs">
      <AdminCostsInner />
    </PageRouteGate>
  );
}
