import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { liveWorkspaceWhere } from "@proovra/shared-runtime";
import { metricNotMeasured, metricValue, type Metric } from "./metric-state.js";

/**
 * PLATFORM ADMIN — BILLING CONTROL PLANE (ADM-016, ADM-030, ADM-032).
 *
 * WHAT WAS WRONG
 * ---------------------------------------------------------------------------
 * `/v1/admin/billing/detail` was accurate about money and useless about people.
 *
 *   * `renewalPressure` returned `{ id, plan, status, currentPeriodEnd }`. The
 *     one list an operator would actually act on carried NO customer — no user,
 *     no email, no workspace. There was nobody to contact.
 *   * `failedPayments` carried `userEmail` and no `userId`, so even a correct
 *     instinct ("open this customer") had no link to follow.
 *   * `cancelAtPeriodEnd` was never selected anywhere, so a subscriber who had
 *     already left and was running out their paid period rendered as an
 *     ordinary ACTIVE subscriber — the single state a retention motion exists
 *     to catch.
 *   * Reconciliation was cron-only and invisible.
 *
 * FOUR DISTINCT CONCEPTS, KEPT DISTINCT
 * ---------------------------------------------------------------------------
 * The console used to blur these into one ambiguous "status". They are not one
 * thing and this service never merges them:
 *
 *   ACCOUNT ENTITLEMENT   what the user is granted (`Entitlement`)
 *   PROVIDER SUBSCRIPTION what Stripe/PayPal confirmed (`Subscription`)
 *   WORKSPACE PROJECTION  what the workspace row stores (`Team.billing*`)
 *   ENTERPRISE CONTRACT   what was purchased (`EnterpriseContract`)
 */

export type BillingSubject = {
  userId: string | null;
  userEmail: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  customerId: string | null;
  customerName: string | null;
  billingOwnerUserId: string | null;
  billingOwnerEmail: string | null;
};

/**
 * ADM-029 — a storage add-on is an IDENTIFIABLE record, so the Overview tile
 * that counts them must lead to the rows themselves. It previously led to a
 * page that showed the same number again, and `orphanedCount` — an actionable
 * condition — had no way to answer WHICH add-ons were orphaned.
 */
export type AdminBillingAddonRow = BillingSubject & {
  id: string;
  amountCents: number;
  currency: string | null;
  billingCycle: string;
  /** The owning workspace is live but carries no ACTIVE/TRIALING subscription. */
  orphaned: boolean;
};

export type AdminBillingAttentionRow = BillingSubject & {
  id: string;
  provider: string;
  plan: string;
  status: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  canceledAtUtc: string | null;
  providerStateAtUtc: string | null;
  /** Masked — an operator can correlate, but this is not a live handle. */
  providerSubRefMasked: string;
};

export type AdminBillingPaymentRow = BillingSubject & {
  id: string;
  provider: string;
  amountCents: number;
  currency: string;
  status: string;
  createdAt: string;
};

function maskRef(ref: string): string {
  return ref.length <= 8 ? "***" : `${ref.slice(0, 4)}…${ref.slice(-4)}`;
}

/**
 * Resolve WHO is behind a set of subscriptions / payments, in three batched
 * queries regardless of row count.
 *
 * This is the whole point of ADM-030: every attention row must be able to
 * answer "who is affected?" without the operator leaving the page.
 */
async function resolveSubjects(
  client: PrismaClient,
  rows: Array<{ userId: string | null; teamId: string | null }>,
): Promise<{
  userById: Map<string, { email: string | null }>;
  teamById: Map<
    string,
    {
      name: string;
      billingOwnerUserId: string | null;
      organization: { id: string; name: string; kind: string } | null;
    }
  >;
}> {
  const userIds = Array.from(
    new Set(rows.map((r) => r.userId).filter((v): v is string => !!v)),
  );
  const teamIds = Array.from(
    new Set(rows.map((r) => r.teamId).filter((v): v is string => !!v)),
  );

  const [users, teams] = await Promise.all([
    userIds.length
      ? client.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, email: true },
        })
      : Promise.resolve([]),
    teamIds.length
      ? client.team.findMany({
          where: { id: { in: teamIds } },
          select: {
            id: true,
            name: true,
            billingOwnerUserId: true,
            organization: { select: { id: true, name: true, kind: true } },
          },
        })
      : Promise.resolve([]),
  ]);

  // The billing owner may not appear among the row users; fetch the remainder.
  const ownerIds = Array.from(
    new Set(
      teams
        .map((t) => t.billingOwnerUserId)
        .filter((v): v is string => !!v && !userIds.includes(v)),
    ),
  );
  const owners = ownerIds.length
    ? await client.user.findMany({
        where: { id: { in: ownerIds } },
        select: { id: true, email: true },
      })
    : [];

  return {
    userById: new Map(
      [...users, ...owners].map((u) => [u.id, { email: u.email ?? null }] as const),
    ),
    teamById: new Map(
      teams.map(
        (t) =>
          [
            t.id,
            {
              name: t.name,
              billingOwnerUserId: t.billingOwnerUserId ?? null,
              organization: t.organization
                ? {
                    id: t.organization.id,
                    name: t.organization.name,
                    kind: String(t.organization.kind),
                  }
                : null,
            },
          ] as const,
      ),
    ),
  };
}

function toSubject(
  row: { userId: string | null; teamId: string | null },
  maps: Awaited<ReturnType<typeof resolveSubjects>>,
): BillingSubject {
  const team = row.teamId ? maps.teamById.get(row.teamId) : undefined;
  const ownerId = team?.billingOwnerUserId ?? null;
  return {
    userId: row.userId,
    userEmail: row.userId ? maps.userById.get(row.userId)?.email ?? null : null,
    workspaceId: row.teamId,
    workspaceName: team?.name ?? null,
    // Only a CUSTOMER organization is a customer. A SYSTEM container is the
    // workspace's own bootstrap row and naming it here would put an internal
    // artefact in front of an operator as though it were an account.
    customerId:
      team?.organization && team.organization.kind === "CUSTOMER"
        ? team.organization.id
        : null,
    customerName:
      team?.organization && team.organization.kind === "CUSTOMER"
        ? team.organization.name
        : null,
    billingOwnerUserId: ownerId,
    billingOwnerEmail: ownerId ? maps.userById.get(ownerId)?.email ?? null : null,
  };
}

export type AdminBillingDetail = {
  generatedAtUtc: string;
  subscriptions: {
    byStatus: Array<{ status: string; count: number }>;
    /** ADM-016 — ACTIVE, but winding down. Its own bucket, deliberately. */
    pendingCancellation: number;
  };
  /** ONE ENTRY PER CURRENCY. Never a cross-currency total (ADM-012). */
  revenueByCurrency: Array<{
    currency: string;
    succeededCents: number;
    succeededPayments: number;
    refundedPayments: number;
    failedPayments: number;
  }>;
  attention: {
    /** ADM-016 — subscriptions that will not renew. */
    pendingCancellation: AdminBillingAttentionRow[];
    pastDue: AdminBillingAttentionRow[];
    renewalWindow: AdminBillingAttentionRow[];
    failedPayments: AdminBillingPaymentRow[];
  };
  storageAddons: {
    activeCount: number;
    /** Recurring add-on revenue, per currency. No rate is applied. */
    mrrByCurrency: Array<{ currency: string; amountCents: number }>;
    /** Add-ons whose owning workspace has no live subscription. */
    orphanedCount: number;
    /**
     * The add-ons themselves, orphans first. Capped at `limit`; the counts
     * above are exact and unbounded, so `rows.length < activeCount` means the
     * list is truncated, not that the count is wrong. `truncated` says so.
     */
    rows: AdminBillingAddonRow[];
    truncated: boolean;
  };
  webhooks: {
    stripe: { total: number; failed: number; lastReceivedAt: string | null };
    paypal: { total: number; failed: number; lastReceivedAt: string | null };
  };
  reconciliation: AdminBillingReconciliation;
  mrrCents: Metric<number>;
  arrCents: Metric<number>;
};

/**
 * ADM-032 — reconciliation visibility, told truthfully.
 *
 * The scheduled billing sweep (`jobs/billing-reconciliation.job.ts`) persists NO
 * run row. It writes its outcomes onto the `Subscription` and
 * `WorkspaceStorageAddon` rows it corrects and logs the rest. There is
 * therefore no run history to project, and inventing a `lastRunAt` from
 * anything else would be a fabricated measurement.
 *
 * What IS observable is `Subscription.providerStateAtUtc` — the provider's own
 * timestamp for the state each row last recorded, written only by a
 * reconciliation or a webhook. That is a genuine freshness signal for
 * provider agreement, and it is reported as exactly that: not as "the sweep
 * ran", which nothing here can prove.
 */
export type AdminBillingReconciliation = {
  runHistory: Metric<
    Array<{
      id: string;
      kind: string;
      status: string;
      startedAtUtc: string;
      finishedAtUtc: string | null;
      scanned: number;
      failed: number;
    }>
  >;
  providerAgreement: {
    subscriptionsWithProviderState: number;
    subscriptionsNeverConfirmed: number;
    oldestConfirmationAtUtc: string | null;
    note: string;
  };
};

const DAY_MS = 24 * 60 * 60 * 1000;

export async function buildAdminBillingDetail(
  input: { renewalWindowDays?: number; attentionLimit?: number } = {},
  client: PrismaClient = defaultPrisma,
): Promise<AdminBillingDetail> {
  const renewalWindowDays = Math.min(120, Math.max(1, input.renewalWindowDays ?? 14));
  const limit = Math.min(200, Math.max(1, input.attentionLimit ?? 50));
  const now = new Date();
  const renewalEnd = new Date(now.getTime() + renewalWindowDays * DAY_MS);

  const attentionSelect = {
    id: true,
    userId: true,
    teamId: true,
    provider: true,
    plan: true,
    status: true,
    cancelAtPeriodEnd: true,
    currentPeriodEnd: true,
    canceledAtUtc: true,
    providerStateAtUtc: true,
    providerSubId: true,
  } as const;

  const [
    byStatus,
    pendingCancellationCount,
    pendingCancellationRows,
    pastDueRows,
    renewalRows,
    failedPaymentRows,
    paymentTotals,
    addons,
    orphanedAddons,
    stripeGroups,
    stripeLast,
    paypalGroups,
    paypalLast,
    runHistory,
    providerStateStats,
    neverConfirmed,
  ] = await Promise.all([
    client.subscription.groupBy({ by: ["status"], _count: { _all: true } }),
    client.subscription.count({
      where: { status: "ACTIVE", cancelAtPeriodEnd: true },
    }),
    client.subscription.findMany({
      where: { status: "ACTIVE", cancelAtPeriodEnd: true },
      orderBy: { currentPeriodEnd: "asc" },
      take: limit,
      select: attentionSelect,
    }),
    client.subscription.findMany({
      where: { status: "PAST_DUE" },
      orderBy: { currentPeriodEnd: "asc" },
      take: limit,
      select: attentionSelect,
    }),
    client.subscription.findMany({
      where: {
        status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] },
        currentPeriodEnd: { gte: now, lte: renewalEnd },
      },
      orderBy: { currentPeriodEnd: "asc" },
      take: limit,
      select: attentionSelect,
    }),
    client.payment.findMany({
      where: { status: "FAILED" },
      orderBy: { createdAt: "desc" },
      take: limit,
      // providerPaymentId DELIBERATELY omitted — it is a provider handle.
      select: {
        id: true,
        userId: true,
        teamId: true,
        provider: true,
        amountCents: true,
        currency: true,
        status: true,
        createdAt: true,
      },
    }),
    client.payment.groupBy({
      by: ["currency", "status"],
      _sum: { amountCents: true },
      _count: { _all: true },
    }),
    client.workspaceStorageAddon.findMany({
      where: { status: "ACTIVE" },
      select: {
        id: true,
        amountCents: true,
        billingCycle: true,
        teamId: true,
        currency: true,
      },
    }),
    // IDs, not a count: the same predicate now has to mark individual rows as
    // orphaned as well as total them, and running it twice could disagree.
    client.workspaceStorageAddon.findMany({
      where: {
        status: "ACTIVE",
        teamId: { not: null },
        team: {
          is: {
            ...liveWorkspaceWhere(),
            subscriptions: { none: { status: { in: ["ACTIVE", "TRIALING"] } } },
          },
        },
      },
      select: { id: true },
    }),
    client.stripeWebhookEvent.groupBy({
      by: ["processingStatus"],
      _count: { _all: true },
    }),
    client.stripeWebhookEvent.findFirst({
      orderBy: { receivedAt: "desc" },
      select: { receivedAt: true },
    }),
    client.paypalWebhookEvent.groupBy({
      by: ["processingStatus"],
      _count: { _all: true },
    }),
    client.paypalWebhookEvent.findFirst({
      orderBy: { receivedAt: "desc" },
      select: { receivedAt: true },
    }),
    client.governanceReconciliationRun
      .findMany({
        orderBy: { startedAtUtc: "desc" },
        take: 25,
        select: {
          id: true,
          kind: true,
          status: true,
          startedAtUtc: true,
          finishedAtUtc: true,
          scannedCount: true,
          failedCount: true,
        },
      })
      .catch(() => null),
    client.subscription.aggregate({
      where: { providerStateAtUtc: { not: null } },
      _count: { _all: true },
      _min: { providerStateAtUtc: true },
    }),
    client.subscription.count({ where: { providerStateAtUtc: null } }),
  ]);

  const attentionMaps = await resolveSubjects(client, [
    ...pendingCancellationRows,
    ...pastDueRows,
    ...renewalRows,
    ...failedPaymentRows,
  ]);

  const toAttention = (
    r: (typeof pendingCancellationRows)[number],
  ): AdminBillingAttentionRow => ({
    ...toSubject(r, attentionMaps),
    id: r.id,
    provider: String(r.provider),
    plan: String(r.plan),
    status: String(r.status),
    cancelAtPeriodEnd: r.cancelAtPeriodEnd,
    currentPeriodEnd: r.currentPeriodEnd?.toISOString() ?? null,
    canceledAtUtc: r.canceledAtUtc?.toISOString() ?? null,
    providerStateAtUtc: r.providerStateAtUtc?.toISOString() ?? null,
    providerSubRefMasked: maskRef(r.providerSubId),
  });

  // ---- Revenue, per currency (ADM-012) ------------------------------------
  const revenueMap = new Map<
    string,
    {
      currency: string;
      succeededCents: number;
      succeededPayments: number;
      refundedPayments: number;
      failedPayments: number;
    }
  >();
  for (const row of paymentTotals) {
    const currency = (row.currency ?? "").toUpperCase() || "UNKNOWN";
    const bucket = revenueMap.get(currency) ?? {
      currency,
      succeededCents: 0,
      succeededPayments: 0,
      refundedPayments: 0,
      failedPayments: 0,
    };
    const count = row._count._all;
    if (row.status === "SUCCEEDED") {
      bucket.succeededCents += row._sum.amountCents ?? 0;
      bucket.succeededPayments += count;
    } else if (row.status === "REFUNDED") {
      bucket.refundedPayments += count;
    } else if (row.status === "FAILED") {
      bucket.failedPayments += count;
    }
    revenueMap.set(currency, bucket);
  }

  // `orphanedAddons` is now the ID list behind the count, so the number and
  // the rows it drills into come from ONE query rather than two that could
  // disagree between them.
  const orphanedAddonIds = new Set(orphanedAddons.map((a) => a.id));

  const addonMaps = await resolveSubjects(
    client,
    addons.map((a) => ({ userId: null, teamId: a.teamId })),
  );

  // Orphans first: they are the actionable ones, so a truncated list must not
  // be able to hide them behind ordinary add-ons.
  const addonRows: AdminBillingAddonRow[] = addons
    .map((a) => ({
      ...toSubject({ userId: null, teamId: a.teamId }, addonMaps),
      id: a.id,
      amountCents: a.amountCents ?? 0,
      currency: a.currency,
      billingCycle: a.billingCycle,
      orphaned: orphanedAddonIds.has(a.id),
    }))
    .sort((x, y) => Number(y.orphaned) - Number(x.orphaned));

  // Only MONTHLY add-ons are recurring revenue. ONE_TIME is not MRR.
  //
  // PER CURRENCY, because `WorkspaceStorageAddon.currency` is a real column and
  // this platform has no exchange-rate authority. Summing mixed currencies into
  // one figure and labelling it EUR — which is what this did — is not an
  // approximation, it is a fabricated number.
  const storageMrrByCurrency = new Map<string, number>();
  for (const a of addons) {
    if (a.billingCycle !== "MONTHLY") continue;
    const cur = a.currency ?? "UNKNOWN";
    storageMrrByCurrency.set(
      cur,
      (storageMrrByCurrency.get(cur) ?? 0) + (a.amountCents ?? 0),
    );
  }

  const failedProcessing = (
    groups: Array<{ processingStatus: string; _count: { _all: number } }>,
  ) => {
    let total = 0;
    let failed = 0;
    for (const g of groups) {
      total += g._count._all;
      const v = g.processingStatus.trim().toUpperCase();
      if (
        v === "FAILED" ||
        v === "ERROR" ||
        v === "ERRORED" ||
        v === "DEAD_LETTER" ||
        v === "REJECTED" ||
        v === "FAILED_PERMANENT"
      ) {
        failed += g._count._all;
      }
    }
    return { total, failed };
  };

  const stripe = failedProcessing(stripeGroups);
  const paypal = failedProcessing(paypalGroups);

  return {
    generatedAtUtc: now.toISOString(),
    subscriptions: {
      byStatus: byStatus
        .map((g) => ({ status: String(g.status), count: g._count._all }))
        .sort((a, b) => b.count - a.count),
      pendingCancellation: pendingCancellationCount,
    },
    revenueByCurrency: Array.from(revenueMap.values()).sort(
      (a, b) => b.succeededCents - a.succeededCents,
    ),
    attention: {
      pendingCancellation: pendingCancellationRows.map(toAttention),
      pastDue: pastDueRows.map(toAttention),
      renewalWindow: renewalRows.map(toAttention),
      failedPayments: failedPaymentRows.map((p) => ({
        ...toSubject(p, attentionMaps),
        id: p.id,
        provider: String(p.provider),
        amountCents: p.amountCents,
        currency: p.currency,
        status: String(p.status),
        createdAt: p.createdAt.toISOString(),
      })),
    },
    storageAddons: {
      activeCount: addons.length,
      mrrByCurrency: Array.from(storageMrrByCurrency.entries())
        .map(([currency, amountCents]) => ({ currency, amountCents }))
        .sort((x, y) => y.amountCents - x.amountCents),
      orphanedCount: orphanedAddonIds.size,
      rows: addonRows.slice(0, limit),
      truncated: addonRows.length > limit,
    },
    webhooks: {
      stripe: {
        total: stripe.total,
        failed: stripe.failed,
        lastReceivedAt: stripeLast?.receivedAt?.toISOString() ?? null,
      },
      paypal: {
        total: paypal.total,
        failed: paypal.failed,
        lastReceivedAt: paypalLast?.receivedAt?.toISOString() ?? null,
      },
    },
    reconciliation: {
      runHistory: runHistory
        ? metricValue(
            runHistory.map((r) => ({
              id: r.id,
              kind: String(r.kind),
              status: String(r.status),
              startedAtUtc: r.startedAtUtc.toISOString(),
              finishedAtUtc: r.finishedAtUtc?.toISOString() ?? null,
              scanned: r.scannedCount,
              failed: r.failedCount,
            })),
          )
        : metricNotMeasured(
            "The reconciliation run table could not be read this cycle.",
          ),
      providerAgreement: {
        subscriptionsWithProviderState: providerStateStats._count._all,
        subscriptionsNeverConfirmed: neverConfirmed,
        oldestConfirmationAtUtc:
          providerStateStats._min.providerStateAtUtc?.toISOString() ?? null,
        note:
          "The scheduled billing sweep persists no run row — it writes its corrections onto the subscription and add-on rows and logs the rest. These figures are provider-agreement FRESHNESS (Subscription.providerStateAtUtc, written only by a reconciliation or a webhook). They do not assert that a sweep ran, which nothing in the schema can currently prove.",
      },
    },
    // Unchanged and correct: `Subscription` carries no billed amount.
    mrrCents: metricNotMeasured(
      "Subscription rows carry no billed-amount column, so recurring monthly revenue is not derivable from the schema. Not estimated. Storage add-on MRR IS derivable and is reported separately.",
    ),
    arrCents: metricNotMeasured(
      "ARR follows from MRR, which is not derivable (Subscription has no amount column). Not estimated.",
    ),
  };
}
