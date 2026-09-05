"use client";

/**
 * PLATFORM ADMIN — Billing (ADM-012, ADM-016, ADM-030, ADM-032).
 *
 * REBUILT 2026-08-27. The previous page was accurate about money and useless
 * about people: its renewal rows carried no customer at all, its failed-payment
 * rows carried an email with no id to open, `cancelAtPeriodEnd` was never shown
 * so a subscriber who had already left looked like an ordinary active one, and
 * gross revenue was a single cross-currency sum rendered as EUR.
 *
 * The page is organised around ATTENTION rather than around tables: the four
 * lists at the top are the ones somebody has to act on, and every row in them
 * names the person, the workspace and the customer it belongs to.
 *
 * FOUR CONCEPTS, KEPT APART
 * ---------------------------------------------------------------------------
 * Account entitlement, provider subscription, workspace projection and
 * enterprise contract are different things that can legitimately disagree. This
 * page never merges them into one "status" word.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

import {
  PageShell,
  PageHeader,
  PageSection,
  DataTable,
  Skeleton,
  useToast,
  type DataTableColumn,
} from "../../../../components/ui";
import { Badge, type BadgeTone } from "../../../../components/ui/Badge";
import { Button } from "../../../../components/ui/Button";
import { Card } from "../../../../components/ui/Card";
import { EmptyState } from "../../../../components/ui/EmptyState";
import { formatMoney } from "../../../../components/admin/AdminMetric";
import { apiFetch } from "../../../../lib/api";
import { ResultCount } from "../../../../components/ui/ResultCount";
import { formatRelativeTime, formatUserDateTime } from "../../../../lib/date";
import { humaniseResourceType } from "../../../../lib/audit/auditPresentation";
import { toSafeUserError } from "../../../../lib/feedback/toSafeUserError";

type Subject = {
  userId: string | null;
  userEmail: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  customerId: string | null;
  customerName: string | null;
  billingOwnerUserId: string | null;
  billingOwnerEmail: string | null;
};

type AddonRow = Subject & {
  id: string;
  amountCents: number;
  currency: string | null;
  billingCycle: string;
  orphaned: boolean;
};

type AttentionRow = Subject & {
  id: string;
  provider: string;
  plan: string;
  status: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  canceledAtUtc: string | null;
  providerStateAtUtc: string | null;
  providerSubRefMasked: string;
};

type PaymentRow = Subject & {
  id: string;
  provider: string;
  amountCents: number;
  currency: string;
  status: string;
  createdAt: string;
};

type Detail = {
  generatedAtUtc: string;
  subscriptions: {
    byStatus: Array<{ status: string; count: number }>;
    pendingCancellation: number;
  };
  revenueByCurrency: Array<{
    currency: string;
    succeededCents: number;
    succeededPayments: number;
    refundedPayments: number;
    failedPayments: number;
  }>;
  attention: {
    pendingCancellation: AttentionRow[];
    pastDue: AttentionRow[];
    renewalWindow: AttentionRow[];
    /** The per-bucket row cap the server read under. */
    limit: number;
    failedPayments: PaymentRow[];
  };
  storageAddons: {
    activeCount: number;
    mrrByCurrency: Array<{ currency: string; amountCents: number }>;
    orphanedCount: number;
    rows: AddonRow[];
    truncated: boolean;
  };
  webhooks: {
    stripe: { total: number; failed: number; lastReceivedAt: string | null };
    paypal: { total: number; failed: number; lastReceivedAt: string | null };
  };
  reconciliation: {
    runHistory: {
      state: string;
      value: Array<{
        id: string;
        kind: string;
        status: string;
        startedAtUtc: string;
        finishedAtUtc: string | null;
        scanned: number;
        failed: number;
      }> | null;
      reason?: string;
    };
    providerAgreement: {
      subscriptionsWithProviderState: number;
      subscriptionsNeverConfirmed: number;
      oldestConfirmationAtUtc: string | null;
      note: string;
    };
  };
  mrrCents: { state: string; value: number | null; reason?: string };
  arrCents: { state: string; value: number | null; reason?: string };
};

const STATUS_TONE: Record<string, BadgeTone> = {
  ACTIVE: "verified",
  TRIALING: "info",
  PAST_DUE: "pending",
  CANCELED: "risk",
  SUCCEEDED: "verified",
  FAILED: "risk",
  REFUNDED: "neutral",
};
/**
 * The server reads the last 25 governance reconciliation runs
 * (`billing.service.ts`), and the page said so nowhere — so the oldest line
 * read as the first run rather than as the edge of the window.
 */
const RECONCILIATION_RUN_CAP = 25;

/**
 * THE column every attention row needed and did not have (ADM-030).
 *
 * Renders the affected party as a chain: person → workspace → customer, each a
 * link. "Who is affected?" has to be answerable without leaving the row.
 */
function SubjectCell({ s }: { s: Subject }) {
  if (!s.userId && !s.workspaceId) {
    return <span style={{ color: "var(--ink-muted)" }}>Unattributed</span>;
  }
  return (
    <div style={{ minWidth: 0 }}>
      {s.userId ? (
        <Link href={`/admin/users/${encodeURIComponent(s.userId)}`}>
          {s.userEmail ?? "View person"}
        </Link>
      ) : (
        <span style={{ color: "var(--ink-muted)" }}>No account</span>
      )}
      <div style={{ fontSize: 12, color: "var(--ink-muted)", marginTop: 2 }}>
        {s.workspaceId ? (
          <Link href={`/admin/workspaces/${encodeURIComponent(s.workspaceId)}`}>
            {s.workspaceName ?? "workspace"}
          </Link>
        ) : (
          "Personal account"
        )}
        {s.customerId ? (
          <>
            {" · "}
            <Link href={`/admin/customers/${encodeURIComponent(s.customerId)}`}>
              {s.customerName}
            </Link>
          </>
        ) : null}
      </div>
      {s.billingOwnerEmail && s.billingOwnerUserId !== s.userId ? (
        <div style={{ fontSize: 11.5, color: "var(--ink-muted)", marginTop: 2 }}>
          Billed to {s.billingOwnerEmail}
        </div>
      ) : null}
    </div>
  );
}

export default function AdminBillingPage() {
  const { addToast } = useToast();
  const params = useSearchParams();
  const focus = params.get("subscriptionStatus") ?? params.get("paymentStatus") ?? null;

  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<Detail | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = (await apiFetch("/v1/admin/billing/detail")) as Detail;
      setDetail(data ?? null);
    } catch (err) {
      addToast(
        toSafeUserError(err, { message: "We couldn't load billing." }).message,
        "error",
      );
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    void load();
  }, [load]);

  // ADM-017 — the Overview links here with a section in mind
  // (`?pendingCancellation=true`, `?tab=addons`, `?subscriptionStatus=PAST_DUE`).
  // Landing at the top of a long page is the same failure as landing on an
  // unfiltered roster: the operator has to go find the number they clicked.
  useEffect(() => {
    if (loading || !detail) return;
    const target =
      params.get("tab") === "addons"
        ? "addons"
        : params.get("pendingCancellation") === "true"
          ? "pendingCancellation"
          : params.get("paymentStatus")
            ? "paymentStatus"
            : params.get("subscriptionStatus")
              ? "subscriptionStatus"
              : null;
    if (!target) return;
    document
      .getElementById(target)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [loading, detail, params]);

  const attentionColumns: DataTableColumn<AttentionRow>[] = [
    { key: "subject", header: "Affected", render: (r) => <SubjectCell s={r} /> },
    {
      key: "plan",
      header: "Plan",
      render: (r) => (
        <span>
          {r.provider} {r.plan}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (r) => (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>{r.status}</Badge>
          {r.cancelAtPeriodEnd ? (
            <Badge tone="pending" title="Provider-confirmed: will not renew">
              Cancels at period end
            </Badge>
          ) : null}
        </div>
      ),
    },
    {
      key: "period",
      header: "Period ends",
      nowrap: true,
      render: (r) => (r.currentPeriodEnd ? formatUserDateTime(r.currentPeriodEnd) : "—"),
    },
    {
      key: "ref",
      header: "Provider ref",
      render: (r) => (
        <span style={{ fontFamily: "monospace", fontSize: 12 }}>
          {r.providerSubRefMasked}
        </span>
      ),
    },
  ];

  const addonColumns: DataTableColumn<AddonRow>[] = [
    { key: "subject", header: "Affected", render: (r) => <SubjectCell s={r} /> },
    {
      key: "amount",
      header: "Amount",
      nowrap: true,
      render: (r) => (
        <span style={{ fontWeight: 600 }}>
          {formatMoney(r.amountCents, r.currency ?? "EUR")}
        </span>
      ),
    },
    {
      key: "billingCycle",
      header: "Cycle",
      nowrap: true,
      render: (r) => (
        <Badge tone={r.billingCycle === "MONTHLY" ? "info" : "neutral"} subtle>
          {r.billingCycle}
        </Badge>
      ),
    },
    {
      key: "orphaned",
      header: "State",
      nowrap: true,
      render: (r) =>
        r.orphaned ? (
          <Badge tone="risk" dot title="Live workspace, no active subscription">
            Orphaned
          </Badge>
        ) : (
          <Badge tone="verified" subtle>
            Attached
          </Badge>
        ),
    },
  ];

  const paymentColumns: DataTableColumn<PaymentRow>[] = [
    { key: "subject", header: "Affected", render: (r) => <SubjectCell s={r} /> },
    {
      key: "amount",
      header: "Amount",
      nowrap: true,
      render: (r) => (
        <span style={{ fontWeight: 600 }}>{formatMoney(r.amountCents, r.currency)}</span>
      ),
    },
    { key: "provider", header: "Provider", render: (r) => r.provider },
    {
      key: "status",
      header: "Status",
      render: (r) => <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>{r.status}</Badge>,
    },
    {
      key: "createdAt",
      header: "When",
      nowrap: true,
      render: (r) => formatUserDateTime(r.createdAt),
    },
  ];

  return (
    <PageShell
      width="full"
      header={
        <PageHeader
          eyebrow="Platform control center"
          title="Billing"
          subtitle="Who pays for what, and what needs attention. Every attention row names the person, workspace and customer behind it. Revenue is reported per currency — no exchange rate is applied, because this platform has no rate authority."
          secondaryActions={
            <Button variant="secondary" onClick={() => void load()} disabled={loading}>
              {loading ? "Refreshing…" : "Refresh"}
            </Button>
          }
        />
      }
      >

      {loading ? (
        <Card>
          <Skeleton width="100%" height="220px" />
        </Card>
      ) : !detail ? (
        <EmptyState variant="inline"
          title="Billing unavailable"
          purpose="The billing aggregate could not be loaded. This is a not-connected state, not an empty platform."
        />
      ) : (
        <>
          <PageSection
            title="Revenue"
            description="Succeeded payment totals, one per currency."
          >
            {detail.revenueByCurrency.length === 0 ? (
              <EmptyState variant="inline"
                title="No payments recorded"
                purpose="No succeeded payment exists yet. This is a real zero, not an unmeasured signal."
              />
            ) : (
              <div className="admin-stat-grid">
                {detail.revenueByCurrency.map((r) => (
                  <div key={r.currency} className="admin-stat">
                    <div className="admin-stat-label">{r.currency} gross</div>
                    <div className="admin-stat-value">
                      {formatMoney(r.succeededCents, r.currency)}
                    </div>
                    <div className="admin-stat-hint">
                      {r.succeededPayments} succeeded · {r.failedPayments} failed ·{" "}
                      {r.refundedPayments} refunded
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div style={{ marginTop: 16 }} className="admin-stat-grid">
              <div className="admin-stat">
                <div className="admin-stat-label">MRR</div>
                <div className="admin-stat-value" data-state={detail.mrrCents.state}>
                  Not measured
                </div>
                <div className="admin-stat-reason">{detail.mrrCents.reason}</div>
              </div>
              {detail.storageAddons.mrrByCurrency.length === 0 ? (
                <div className="admin-stat">
                  <div className="admin-stat-label">Storage add-on MRR</div>
                  <div className="admin-stat-value">
                    {formatMoney(0, "EUR")}
                  </div>
                  <div className="admin-stat-hint">
                    No monthly add-on is active. A real zero.
                  </div>
                </div>
              ) : (
                detail.storageAddons.mrrByCurrency.map((m) => (
                  <div key={m.currency} className="admin-stat">
                    <div className="admin-stat-label">
                      {m.currency} storage add-on MRR
                    </div>
                    <div className="admin-stat-value">
                      {formatMoney(m.amountCents, m.currency)}
                    </div>
                    <div className="admin-stat-hint">
                      Derivable because add-ons DO carry a billed amount — and
                      reported per currency, because they carry that too
                    </div>
                  </div>
                ))
              )}
              <div className="admin-stat">
                <div className="admin-stat-label">Orphaned add-ons</div>
                <div
                  className="admin-stat-value"
                  data-emphasis={detail.storageAddons.orphanedCount > 0 ? "attention" : undefined}
                >
                  {detail.storageAddons.orphanedCount}
                </div>
                <div className="admin-stat-hint">
                  Active add-on on a workspace with no live subscription
                </div>
              </div>
            </div>
          </PageSection>

          <PageSection
            id="subscriptionStatus"
            title="Subscriptions"
            description="Provider subscription rows by their provider-confirmed status. A cancelled subscription is shown as cancelled and is never counted as an active one."
          >
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {detail.subscriptions.byStatus.map((s) => (
                <Badge
                  key={s.status}
                  tone={STATUS_TONE[s.status] ?? "neutral"}
                  subtle={focus !== s.status}
                >
                  {s.status}: {s.count}
                </Badge>
              ))}
              {detail.subscriptions.pendingCancellation > 0 ? (
                <Badge tone="pending">
                  Pending cancellation: {detail.subscriptions.pendingCancellation}
                </Badge>
              ) : null}
            </div>
          </PageSection>

          <PageSection
            id="pendingCancellation"
            title="Pending cancellation"
            description="Active subscriptions the provider has confirmed will not renew. These are customers who have already left; the paid period is simply still running."
          >
            <Card>
              <DataTable
                ariaLabel="Pending cancellations"
                columns={attentionColumns}
                rows={detail.attention.pendingCancellation}
                getRowId={(r) => r.id}
                emptyState={
                  <EmptyState variant="inline"
                    title="No pending cancellations"
                    purpose="No active subscription is currently set to cancel at the end of its period."
                  />
                }
              />
            </Card>
          </PageSection>

          <PageSection
            title="Past due"
            description="Subscriptions the provider reports as past due."
          >
            <Card>
              <DataTable
                ariaLabel="Past due subscriptions"
                columns={attentionColumns}
                rows={detail.attention.pastDue}
                getRowId={(r) => r.id}
                emptyState={
                  <EmptyState variant="inline"
                    title="Nothing past due"
                    purpose="No subscription is currently in a past-due state."
                  />
                }
              />
            </Card>
          </PageSection>

          <PageSection
            id="paymentStatus"
            title="Failed payments"
            description="Recent failed payments, with the account and workspace behind each one."
          >
            <Card>
              <DataTable
                ariaLabel="Failed payments"
                columns={paymentColumns}
                rows={detail.attention.failedPayments}
                getRowId={(r) => r.id}
                emptyState={
                  <EmptyState variant="inline"
                    title="No failed payments"
                    purpose="No payment has failed. This is a real zero."
                  />
                }
              />
            </Card>
          </PageSection>

          <PageSection
            title="Renewal window"
            description="Subscriptions whose period ends soon."
          >
            <Card>
              <DataTable
                ariaLabel="Renewal window"
                columns={attentionColumns}
                rows={detail.attention.renewalWindow}
                getRowId={(r) => r.id}
                emptyState={
                  <EmptyState variant="inline"
                    title="No renewals in the window"
                    purpose="No subscription renews in the configured window."
                  />
                }
              />
              {/* All four buckets read under the same per-bucket cap. A full
                  bucket has more behind it, and this is the screen somebody
                  uses to decide whether anything needs chasing. */}
              <ResultCount
                shown={detail.attention.renewalWindow.length}
                cap={detail.attention.limit}
                noun="subscription needing attention"
                pluralNoun="subscriptions needing attention"
                data-testid="admin-billing-attention-count"
              />
            </Card>
          </PageSection>

          <PageSection
            id="addons"
            title="Storage add-ons"
            description="Every active storage add-on, orphans first. An orphan is an add-on still billing on a live workspace that carries no active subscription — the condition the count above names, now with the rows behind it."
          >
            <Card>
              <DataTable
                ariaLabel="Storage add-ons"
                columns={addonColumns}
                rows={detail.storageAddons.rows}
                getRowId={(r) => r.id}
                emptyState={
                  <EmptyState variant="inline"
                    title="No active storage add-ons"
                    purpose="No workspace currently carries a storage add-on. This is a real zero, not an unmeasured signal."
                  />
                }
              />
            </Card>
            {detail.storageAddons.truncated ? (
              <p className="admin-stat-reason" style={{ marginTop: 8 }}>
                Showing the first {detail.storageAddons.rows.length} of{" "}
                {detail.storageAddons.activeCount} active add-ons, orphans first.
                The counts above are exact.
              </p>
            ) : null}
          </PageSection>

          <PageSection
            title="Provider webhooks"
            description="Delivery health from real processing-status rows."
          >
            <div className="admin-stat-grid">
              {(["stripe", "paypal"] as const).map((p) => {
                const w = detail.webhooks[p];
                return (
                  <div key={p} className="admin-stat" data-problem={w.failed > 0 || undefined}>
                    <div className="admin-stat-label">{p}</div>
                    <div
                      className="admin-stat-value"
                      data-state={w.total === 0 ? "UNKNOWN" : "VALUE"}
                      data-emphasis={w.failed > 0 ? "critical" : undefined}
                    >
                      {w.total === 0 ? "Not connected" : `${w.failed} failed`}
                    </div>
                    <div className="admin-stat-hint">
                      {w.total} event{w.total === 1 ? "" : "s"} received
                      {w.lastReceivedAt
                        ? ` · last ${formatUserDateTime(w.lastReceivedAt)}`
                        : ""}
                    </div>
                  </div>
                );
              })}
            </div>
          </PageSection>

          <PageSection
            title="Reconciliation"
            description="What the platform can honestly say about provider agreement."
          >
            <Card>
              <div
                role="note"
                style={{
                  padding: "12px 16px",
                  borderRadius: 8,
                  border: "1px solid var(--border-default)",
                  background: "var(--surface-muted)",
                  fontSize: 13,
                  lineHeight: 1.6,
                  marginBottom: 16,
                }}
              >
                {detail.reconciliation.providerAgreement.note}
              </div>

              <div className="admin-stat-grid">
                <div className="admin-stat">
                  <div className="admin-stat-label">Provider-confirmed</div>
                  <div className="admin-stat-value">
                    {detail.reconciliation.providerAgreement.subscriptionsWithProviderState}
                  </div>
                  <div className="admin-stat-hint">
                    Subscriptions carrying a provider state timestamp
                  </div>
                </div>
                <div className="admin-stat">
                  <div className="admin-stat-label">Never confirmed</div>
                  <div
                    className="admin-stat-value"
                    data-emphasis={
                      detail.reconciliation.providerAgreement.subscriptionsNeverConfirmed > 0
                        ? "attention"
                        : undefined
                    }
                  >
                    {detail.reconciliation.providerAgreement.subscriptionsNeverConfirmed}
                  </div>
                  <div className="admin-stat-hint">
                    No reconciliation or webhook has ever stamped these
                  </div>
                </div>
                <div className="admin-stat">
                  <div className="admin-stat-label">Oldest confirmation</div>
                  <div
                    className="admin-stat-value"
                    data-state={
                      detail.reconciliation.providerAgreement.oldestConfirmationAtUtc
                        ? "VALUE"
                        : "UNKNOWN"
                    }
                    style={{ fontSize: "1.05rem" }}
                  >
                    {detail.reconciliation.providerAgreement.oldestConfirmationAtUtc
                      ? formatUserDateTime(
                          detail.reconciliation.providerAgreement.oldestConfirmationAtUtc,
                        )
                      : "None recorded"}
                  </div>
                </div>
              </div>

              {detail.reconciliation.runHistory.state === "VALUE" &&
              (detail.reconciliation.runHistory.value?.length ?? 0) > 0 ? (
                <div style={{ marginTop: 20 }}>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                      color: "var(--ink-muted)",
                      marginBottom: 10,
                    }}
                  >
                    Recent governance reconciliation runs
                  </div>
                  {/*
                    TWENTY-FIVE LINES THAT SAID THE SAME THING.
                    This was the longest block on the page and carried the
                    least per row: "WORKSPACE_OPERATIONS · SUCCEEDED · scanned
                    14 · 05 Sept 2026, 18:41:00 Europe/Berlin", twenty-five
                    times, differing only in the seconds. Three faults in one
                    line — a raw enum shouted in bold, a raw status beside it,
                    and a stamp to the second where the question is "how
                    recently", which every other list in the console answers
                    with a relative time and the exact instant on the hover.
                    And the read is capped at 25 (billing.service.ts), which
                    nothing said, so the oldest line read as the first run
                    rather than as the edge of the window.
                  */}
                  <ul
                    style={{
                      margin: 0,
                      paddingInlineStart: 0,
                      listStyle: "none",
                      fontSize: 13.5,
                    }}
                  >
                    {detail.reconciliation.runHistory.value!.map((r) => (
                      <li key={r.id} style={{ marginBottom: 6 }}>
                        <strong>{humaniseResourceType(r.kind) ?? r.kind}</strong> ·{" "}
                        {humaniseResourceType(r.status) ?? r.status} · scanned{" "}
                        {r.scanned}
                        {r.failed > 0 ? `, ${r.failed} failed` : ""} ·{" "}
                        <span title={formatUserDateTime(r.startedAtUtc)}>
                          {formatRelativeTime(r.startedAtUtc)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <ResultCount
                    shown={detail.reconciliation.runHistory.value!.length}
                    cap={RECONCILIATION_RUN_CAP}
                    noun="reconciliation run"
                  />
                </div>
              ) : null}
            </Card>
          </PageSection>
        </>
      )}
    </PageShell>
  );
}
