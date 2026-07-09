"use client";

/**
 * Platform Control Center P1 — Billing & Revenue detail console.
 *
 * READ-ONLY aggregation over EXISTING billing models. Renders:
 *   - metric Cards: active subscriptions, gross revenue, failed payments,
 *     storage add-ons, and MRR/ARR (honest "Not measured" when a value is
 *     not safely derivable from the schema),
 *   - plan-mix distribution (FREE / PAYG / PRO / TEAM / ENTERPRISE),
 *   - webhook-status Cards for Stripe + PayPal (healthy / degraded /
 *     "Not connected" — honest, from real processingStatus rows),
 *   - a recent-payments DataTable (email is the ONLY PII; no card tokens or
 *     Stripe secrets),
 *   - honest EmptyState when a source is absent.
 *
 * Inherits the `platform.admin` gate from app/(app)/admin/layout.tsx. Errors
 * surface via `toSafeUserError`.
 */

import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";
import { useCallback, useEffect, useMemo, useState } from "react";

import { PageShell, PageHeader, PageSection, DataTable } from "../../../../components/ui";
import type { DataTableColumn } from "../../../../components/ui";
import { Card } from "../../../../components/ui/Card";
import { Badge } from "../../../../components/ui/Badge";
import type { BadgeTone } from "../../../../components/ui/Badge";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { Button } from "../../../../components/ui/Button";
import { apiFetch } from "../../../../lib/api";
import { useToast } from "../../../../components/ui";
import AdminConsoleNav from "../../../../components/admin/AdminConsoleNav";
import { formatUserDateTime } from "../../../../lib/date";

type WebhookHealth = "healthy" | "degraded" | "not-connected";

type WebhookStatus = {
  provider: "STRIPE" | "PAYPAL";
  health: WebhookHealth;
  total: number;
  failed: number;
  lastReceivedAt: string | null;
};

type PaymentRow = {
  id: string;
  provider: string;
  amountCents: number;
  currency: string;
  status: string;
  createdAt: string;
  userEmail: string | null;
};

type BillingDetail = {
  activeSubscriptions: number;
  subscriptionStatus: Record<string, number>;
  planMix: Record<string, number>;
  revenue: {
    grossRevenueCents: number;
    currencies: string[];
    successfulPayments: number;
    failedPayments: number;
    refundedPayments: number;
  };
  mrr: {
    subscriptionMrrCents: number | null;
    subscriptionArrCents: number | null;
    storageAddonMrrCents: number | null;
    derivable: boolean;
    note: string | null;
  };
  failedPayments: { count: number; items: PaymentRow[] };
  recentPaymentEvents: PaymentRow[];
  stripeWebhookStatus: WebhookStatus;
  paypalWebhookStatus: WebhookStatus;
  storageAddons: { activeCount: number; mrrContributionCents: number | null };
  renewalPressure: {
    windowDays: number;
    count: number;
    items: Array<{
      id: string;
      plan: string;
      status: string;
      currentPeriodEnd: string | null;
    }>;
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

function formatTimestamp(value: string) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return formatUserDateTime(value);
}

function paymentStatusTone(status: string): BadgeTone {
  const v = status.toUpperCase();
  if (v === "SUCCEEDED") return "verified";
  if (v === "FAILED") return "risk";
  if (v === "REFUNDED") return "neutral";
  return "pending";
}

// A metric tile — `value === null` renders an honest "Not measured".
function MetricTile({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string | null;
  sub?: string;
  accent?: string;
}) {
  const measured = value != null;
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
        }}
      >
        {measured ? sub ?? "" : "Not measured — not safely derivable from the billing schema."}
      </div>
    </Card>
  );
}

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

function webhookTone(health: WebhookHealth): BadgeTone {
  if (health === "healthy") return "verified";
  if (health === "degraded") return "risk";
  return "neutral";
}

function webhookLabel(health: WebhookHealth): string {
  if (health === "healthy") return "Healthy";
  if (health === "degraded") return "Degraded";
  return "Not connected";
}

function WebhookCard({ status }: { status: WebhookStatus }) {
  const providerLabel = status.provider === "STRIPE" ? "Stripe" : "PayPal";
  return (
    <Card
      title={`${providerLabel} webhooks`}
      headerAction={<Badge tone={webhookTone(status.health)} dot>{webhookLabel(status.health)}</Badge>}
      padding="comfortable"
    >
      {status.health === "not-connected" ? (
        <EmptyState
          compact
          title="Not connected"
          purpose={`No ${providerLabel} webhook events have been received. Once the provider delivers events, processing health appears here.`}
          data-testid={`admin-billing-${status.provider.toLowerCase()}-not-connected`}
        />
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ fontSize: 13, color: INK_SECONDARY }}>
            {formatCount(status.total)} received · {formatCount(status.failed)} failed
          </div>
          <div style={{ fontSize: 12, color: INK_MUTED }}>
            Last received: {status.lastReceivedAt ? formatTimestamp(status.lastReceivedAt) : "—"}
          </div>
        </div>
      )}
    </Card>
  );
}

export default function AdminBillingPage() {
  const { addToast } = useToast();
  const [detail, setDetail] = useState<BillingDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const data = await apiFetch(`/v1/admin/billing/detail`);
      setDetail(data ?? null);
    } catch (err) {
      const message = toSafeUserError(err, {
        message: "We couldn't load the billing detail aggregate.",
      }).message;
      addToast(message, "error");
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const revenueCurrency = detail?.revenue.currencies?.[0] ?? "EUR";

  const metrics = useMemo(() => {
    if (!detail) return [];
    return [
      {
        label: "Active subscriptions",
        value: formatCount(detail.activeSubscriptions),
        sub: `${formatCount(detail.subscriptionStatus?.TRIALING) ?? 0} trialing · ${formatCount(detail.subscriptionStatus?.PAST_DUE) ?? 0} past due`,
        accent: "#1e3a5f",
      },
      {
        label: "Gross revenue",
        value: formatMoneyCents(detail.revenue.grossRevenueCents, revenueCurrency),
        sub: `${formatCount(detail.revenue.successfulPayments) ?? 0} successful payments`,
        accent: "#1e3a5f",
      },
      {
        // Subscription MRR is NOT derivable — kept honest.
        label: "Subscription MRR",
        value: formatMoneyCents(detail.mrr.subscriptionMrrCents, revenueCurrency),
        sub: undefined,
        accent: "#1e3a5f",
      },
      {
        label: "Subscription ARR",
        value: formatMoneyCents(detail.mrr.subscriptionArrCents, revenueCurrency),
        sub: undefined,
        accent: "#1e3a5f",
      },
      {
        label: "Storage add-on MRR",
        value: formatMoneyCents(detail.mrr.storageAddonMrrCents, revenueCurrency),
        sub: `${formatCount(detail.storageAddons.activeCount) ?? 0} active add-ons`,
        accent: "#1e3a5f",
      },
      {
        label: "Failed payments",
        value: formatCount(detail.revenue.failedPayments),
        sub: `${formatCount(detail.revenue.refundedPayments) ?? 0} refunded`,
        accent: "#8f4c4c",
      },
    ];
  }, [detail, revenueCurrency]);

  const planMix = useMemo(() => {
    if (!detail) return [];
    const p = detail.planMix;
    return [
      { label: "Free", value: p.FREE ?? 0, tone: "neutral" as BadgeTone },
      { label: "Pay-as-you-go", value: p.PAYG ?? 0, tone: "info" as BadgeTone },
      { label: "Pro", value: p.PRO ?? 0, tone: "verified" as BadgeTone },
      { label: "Team", value: p.TEAM ?? 0, tone: "governance" as BadgeTone },
      { label: "Enterprise", value: p.ENTERPRISE ?? 0, tone: "pending" as BadgeTone },
    ];
  }, [detail]);

  const paymentColumns: DataTableColumn<PaymentRow>[] = [
    {
      key: "createdAt",
      header: "When",
      nowrap: true,
      render: (r) => (
        <span style={{ fontSize: 12, color: INK_MUTED }}>
          {formatTimestamp(r.createdAt)}
        </span>
      ),
    },
    {
      key: "userEmail",
      header: "Customer",
      render: (r) => (
        <span style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>
          {r.userEmail ?? "—"}
        </span>
      ),
    },
    {
      key: "provider",
      header: "Provider",
      render: (r) => (
        <span style={{ fontSize: 12, color: INK_SECONDARY }}>{r.provider}</span>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      nowrap: true,
      render: (r) => (
        <span style={{ fontWeight: 600 }}>
          {formatMoneyCents(r.amountCents, r.currency || revenueCurrency)}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (r) => <Badge tone={paymentStatusTone(r.status)}>{r.status}</Badge>,
    },
  ];

  return (
    <PageShell width="full">
      <PageHeader
        eyebrow="Platform admin"
        title="Billing & Revenue"
        subtitle="Read-only billing aggregate across every workspace. Gross revenue reuses the platform analytics computation. MRR/ARR that is not safely derivable from the schema is shown as “Not measured” — never estimated. No card tokens or provider secrets are surfaced; email is the only customer field."
        secondaryActions={
          <Button variant="secondary" onClick={() => void load()}>
            Refresh
          </Button>
        }
      />

      <AdminConsoleNav />

      {loading ? (
        <PageSection>
          <div
            style={{
              display: "grid",
              gap: 16,
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            }}
          >
            {Array.from({ length: 6 }).map((_, i) => (
              <Card key={i} padding="comfortable" data-testid="admin-billing-loading-tile">
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
      ) : !detail ? (
        <PageSection>
          <Card variant="empty" padding="none">
            <EmptyState
              framed
              title="Billing not connected"
              purpose="No billing aggregate was returned. Once Subscription / Payment / webhook rows exist, revenue, plan mix, webhook health and recent payments appear here."
              data-testid="admin-billing-not-connected"
            />
          </Card>
        </PageSection>
      ) : (
        <>
          <PageSection
            title="Top-line billing metrics"
            description="Every value is read live from the billing aggregate. Values not safely derivable from the schema render as “Not measured”."
          >
            <div
              data-testid="admin-billing-metric-grid"
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
            {detail.mrr.note ? (
              <div style={{ marginTop: 12, fontSize: 12.5, color: INK_MUTED }}>
                {detail.mrr.note}
              </div>
            ) : null}
          </PageSection>

          <PageSection
            title="Plan mix"
            description="Subscription distribution across billing plans (real counts)."
          >
            <div
              style={{
                display: "grid",
                gap: 10,
                gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              }}
            >
              {planMix.map((p) => (
                <StatRow key={p.label} label={p.label} value={p.value} tone={p.tone} />
              ))}
            </div>
          </PageSection>

          <PageSection
            title="Webhook health"
            description="Honest processing health from real StripeWebhookEvent / PaypalWebhookEvent rows. Zero rows reads as “Not connected”."
          >
            <div
              style={{
                display: "grid",
                gap: 16,
                gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              }}
            >
              <WebhookCard status={detail.stripeWebhookStatus} />
              <WebhookCard status={detail.paypalWebhookStatus} />
            </div>
          </PageSection>

          <PageSection
            title="Recent payments"
            description="Most recent payment events across the platform. Email is the only customer field; provider payment tokens are never exposed."
          >
            <DataTable
              columns={paymentColumns}
              rows={detail.recentPaymentEvents}
              getRowId={(r) => r.id}
              ariaLabel="Recent platform payments"
              emptyState={
                <EmptyState
                  title="No payments recorded"
                  purpose="No payment events were returned. Once the Payment table records activity, recent payments appear here."
                  data-testid="admin-billing-payments-empty"
                />
              }
            />
          </PageSection>
        </>
      )}
    </PageShell>
  );
}
