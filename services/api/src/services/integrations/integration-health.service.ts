/**
 * PHASE 5 — Integration platform health metrics.
 *
 * Computes a team-scoped health snapshot used by the Integrations admin
 * dashboard. EVERY value is derived from real DB rows — no derived
 * counters that are not backed by an existing column, no synthesised
 * latency, no fabricated success rates.
 *
 * Phase closure addition — `averageLatencyMsLast24h` is computed from
 * the new `response_duration_ms` column on `integration_webhook_deliveries`,
 * filtered to rows in the same 24h window the rest of the snapshot
 * uses. Rows for which the dispatcher never issued the outbound fetch
 * have a NULL duration and are EXCLUDED from the average — they
 * contribute neither to the numerator nor the denominator. When no
 * row in the window has a non-null duration the field is `null`, NOT
 * 0 (the frontend renders "—").
 *
 * Hard rules (HARD CONSTRAINTS in the phase brief):
 *   - Only counts/rates derived from real DB rows are reported.
 *   - When a denominator is zero the corresponding RATE / AVERAGE is
 *     `null` (NOT 0, NOT 1, NOT NaN) — the frontend renders "—".
 *   - `averageLatencyMsLast24h` reflects ONLY rows whose dispatcher
 *     attempt actually issued the outbound HTTP call (non-null
 *     `responseDurationMs`). The dispatcher MUST NOT fabricate the
 *     column value for rows that failed before the fetch.
 *   - All queries are scoped to `teamId`. There is no cross-team leakage.
 *
 * Reuse:
 *   - Consumes the canonical `prisma` client. No new clients.
 *   - Consumes existing `ApiCredential`, `ApiCredentialUsageLog`,
 *     `WebhookEndpoint`, and `IntegrationWebhookDelivery` tables. No
 *     new tables, no new queues.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";

/**
 * Window used for "last 24h" rollups. Exported so tests can pin the
 * value and so the route layer can echo it if it ever wants to
 * surface the window length to the operator.
 */
export const HEALTH_RECENT_WINDOW_HOURS = 24;

export type IntegrationsHealthSnapshot = {
  teamId: string;
  generatedAtUtc: string;
  windowHours: number;

  // API credentials.
  activeApiKeys: number;
  revokedApiKeys: number;
  keysUsedLast24h: number;

  // Webhook endpoints.
  activeWebhooks: number;
  disabledWebhooks: number;

  // Delivery counters (last 24h).
  deliveriesLast24h: number;
  successRateLast24h: number | null;
  failedDeliveriesLast24h: number;

  // Operational pressure signals.
  endpointsCurrentlyFailing: number;
  pendingOrRetryScheduledCount: number;
  oldestPendingDeliveryAt: string | null;
  lastSuccessfulDeliveryAt: string | null;
  lastFailedDeliveryAt: string | null;

  // Phase closure — average measured wall-clock response duration of
  // outbound webhook deliveries in the same 24h window. NULL when no
  // delivery in the window recorded a non-null duration (e.g. the
  // workspace has no traffic, or every attempt failed before the
  // outbound fetch). NEVER 0 to signal "no data".
  averageLatencyMsLast24h: number | null;
};

/**
 * Compute a team-scoped health snapshot.
 *
 * Each metric is computed with a single targeted query against an
 * indexed column. Total work is O(constant queries) regardless of
 * workspace size.
 *
 * Values that depend on a denominator return `null` when the
 * denominator is zero (e.g. `successRateLast24h` is `null` when no
 * deliveries occurred in the window).
 */
export async function computeIntegrationsHealthSnapshot(
  teamId: string,
  client: PrismaClient = defaultPrisma,
): Promise<IntegrationsHealthSnapshot> {
  const now = new Date();
  const windowStart = new Date(
    now.getTime() - HEALTH_RECENT_WINDOW_HOURS * 60 * 60 * 1000,
  );

  // -------------------------------------------------------------------
  // API credentials — status rollup.
  // -------------------------------------------------------------------
  const apiCredentialStatusGroups = await client.apiCredential.groupBy({
    by: ["status"],
    where: { teamId },
    _count: { _all: true },
  });
  let activeApiKeys = 0;
  let revokedApiKeys = 0;
  for (const g of apiCredentialStatusGroups) {
    const count = g._count._all;
    if (g.status === "ACTIVE") activeApiKeys += count;
    else if (g.status === "REVOKED") revokedApiKeys += count;
  }

  // -------------------------------------------------------------------
  // Distinct apiCredentialId count from usage logs in the window.
  //
  // `groupBy` with `apiCredentialId` and a window filter gives us the
  // distinct set; `length` of the result is the cardinality.
  // -------------------------------------------------------------------
  const usageGroups = await client.apiCredentialUsageLog.groupBy({
    by: ["apiCredentialId"],
    where: { teamId, createdAt: { gt: windowStart } },
    _count: { _all: true },
  });
  const keysUsedLast24h = usageGroups.length;

  // -------------------------------------------------------------------
  // Webhook endpoints — status rollup.
  // -------------------------------------------------------------------
  const webhookStatusGroups = await client.webhookEndpoint.groupBy({
    by: ["status"],
    where: { teamId },
    _count: { _all: true },
  });
  let activeWebhooks = 0;
  let disabledWebhooks = 0;
  for (const g of webhookStatusGroups) {
    const count = g._count._all;
    if (g.status === "ACTIVE") activeWebhooks += count;
    else if (g.status === "DISABLED") disabledWebhooks += count;
  }

  // Endpoints with >=5 consecutive failures AND still ACTIVE. The
  // failureCount column is reset on the next SENT delivery, so this
  // value is honest — it represents endpoints that have not had a
  // successful delivery since reaching the threshold.
  const endpointsCurrentlyFailing = await client.webhookEndpoint.count({
    where: { teamId, status: "ACTIVE", failureCount: { gte: 5 } },
  });

  // -------------------------------------------------------------------
  // Delivery rollups for the last 24h. Status groupBy gives us
  // SENT / FAILED / RETRY_SCHEDULED / PENDING / CANCELLED counts in
  // one query. The brief asks for the first four — CANCELLED is
  // excluded from the denominator since cancellation is operator
  // intent, not a delivery outcome.
  // -------------------------------------------------------------------
  const deliveryStatusGroups = await client.integrationWebhookDelivery.groupBy({
    by: ["status"],
    where: { teamId, createdAt: { gt: windowStart } },
    _count: { _all: true },
  });
  let sentLast24h = 0;
  let failedLast24h = 0;
  let retryScheduledLast24h = 0;
  let pendingLast24h = 0;
  for (const g of deliveryStatusGroups) {
    const count = g._count._all;
    if (g.status === "SENT") sentLast24h = count;
    else if (g.status === "FAILED") failedLast24h = count;
    else if (g.status === "RETRY_SCHEDULED") retryScheduledLast24h = count;
    else if (g.status === "PENDING") pendingLast24h = count;
  }
  const deliveriesLast24h =
    sentLast24h + failedLast24h + retryScheduledLast24h + pendingLast24h;
  const successRateLast24h =
    deliveriesLast24h === 0 ? null : sentLast24h / deliveriesLast24h;

  // -------------------------------------------------------------------
  // Pending or retry-scheduled count — full window, not 24h, since
  // an old stuck row matters even if it's past the 24h cutoff.
  // -------------------------------------------------------------------
  const pendingOrRetryScheduledCount =
    await client.integrationWebhookDelivery.count({
      where: { teamId, status: { in: ["PENDING", "RETRY_SCHEDULED"] } },
    });

  // -------------------------------------------------------------------
  // Oldest pending delivery — the earliest `createdAt` among rows
  // that are still PENDING or RETRY_SCHEDULED.
  // -------------------------------------------------------------------
  const oldestPending = await client.integrationWebhookDelivery.findFirst({
    where: { teamId, status: { in: ["PENDING", "RETRY_SCHEDULED"] } },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });

  // -------------------------------------------------------------------
  // Last successful / last failed delivery timestamps. These are the
  // newest sentAtUtc / failedAtUtc values across the whole workspace.
  // -------------------------------------------------------------------
  const lastSent = await client.integrationWebhookDelivery.findFirst({
    where: { teamId, status: "SENT", sentAtUtc: { not: null } },
    orderBy: { sentAtUtc: "desc" },
    select: { sentAtUtc: true },
  });
  const lastFailed = await client.integrationWebhookDelivery.findFirst({
    where: { teamId, status: "FAILED", failedAtUtc: { not: null } },
    orderBy: { failedAtUtc: "desc" },
    select: { failedAtUtc: true },
  });

  // -------------------------------------------------------------------
  // Phase closure — average response duration over the same 24h window.
  //
  // Rules:
  //   - Only rows with a non-null `responseDurationMs` contribute. The
  //     dispatcher only sets the column on attempts that actually
  //     issued the outbound HTTP call (success / 4xx / 5xx / transport
  //     error). Pre-fetch failures (e.g. signing_key_unavailable)
  //     leave the column NULL and are excluded.
  //   - The window is the SAME (createdAt > windowStart) cutoff used
  //     by the success-rate denominator above; the existing
  //     (team_id, created_at DESC) index covers it.
  //   - Returns null when the denominator is zero. NEVER 0.
  //
  // We avoid Prisma's `_avg` aggregation here because the lightweight
  // test stub doesn't ship a generalised aggregator. The findMany +
  // local average keeps the service trivially mockable and the round-
  // trip cheap (one indexed query, one column).
  // -------------------------------------------------------------------
  const durationRows = await client.integrationWebhookDelivery.findMany({
    where: {
      teamId,
      createdAt: { gt: windowStart },
      responseDurationMs: { not: null },
    },
    select: { responseDurationMs: true },
  });
  let averageLatencyMsLast24h: number | null = null;
  if (durationRows.length > 0) {
    let total = 0;
    let counted = 0;
    for (const r of durationRows) {
      const v = r.responseDurationMs;
      if (typeof v === "number" && Number.isFinite(v)) {
        total += v;
        counted += 1;
      }
    }
    if (counted > 0) {
      averageLatencyMsLast24h = Math.round(total / counted);
    }
  }

  return {
    teamId,
    generatedAtUtc: now.toISOString(),
    windowHours: HEALTH_RECENT_WINDOW_HOURS,
    activeApiKeys,
    revokedApiKeys,
    keysUsedLast24h,
    activeWebhooks,
    disabledWebhooks,
    deliveriesLast24h,
    successRateLast24h,
    failedDeliveriesLast24h: failedLast24h,
    endpointsCurrentlyFailing,
    pendingOrRetryScheduledCount,
    oldestPendingDeliveryAt:
      oldestPending?.createdAt?.toISOString() ?? null,
    lastSuccessfulDeliveryAt: lastSent?.sentAtUtc?.toISOString() ?? null,
    lastFailedDeliveryAt: lastFailed?.failedAtUtc?.toISOString() ?? null,
    averageLatencyMsLast24h,
  };
}
