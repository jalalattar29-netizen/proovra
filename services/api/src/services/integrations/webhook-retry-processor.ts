/**
 * Phase 10 — Webhook retry sweeper.
 *
 * Picks N IntegrationWebhookDelivery rows where status = RETRY_SCHEDULED
 * and nextAttemptAtUtc <= now, atomically claims each (RETRY_SCHEDULED →
 * PENDING), and calls the dispatcher's `attemptDelivery` to retry. The
 * retry ladder lives in @proovra/shared/integrations.ts.
 *
 * Triggered by an external scheduler (e.g. k8s CronJob) hitting
 * `POST /v1/integrations/process-webhook-retries`, which is protected
 * by the `INTEGRATION_CRON_SECRET` middleware.
 */

import type { PrismaClient } from "@prisma/client";
import { WEBHOOK_RETRY_MAX_ATTEMPTS } from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { isIntegrationsFeatureEnabled } from "./api-keys.service.js";
import { NOT_OPERATING_DEFER_MS, attemptDelivery } from "./webhook-dispatcher.js";
import { isLiveOperatingWorkspace } from "../workspace/operating-workspace.js";
import { resolveEntitlement } from "../packaging/entitlement.service.js";
import { machineEgressRestricted, machineEgressTargetOf } from "../access/record-reach.js";

export type ProcessWebhookRetriesSummary = {
  pickedUp: number;
  delivered: number;
  rescheduled: number;
  failed: number;
};

/**
 * WS-SCHED / PRO-W2-06, PRO-G1Z-02 — THE LEASE on a PENDING delivery.
 *
 * A row is PENDING only while one process is sending it (the inline attempt
 * after `emitWebhookEvent`, or this sweep's RETRY_SCHEDULED -> PENDING claim);
 * the send is bounded by the dispatcher's 10 s timeout. A process that dies
 * (deploy, crash, OOM) or whose outcome write fails leaves the row PENDING, and
 * nothing read PENDING again — the event was silently lost (or sent and shown
 * as pending forever). Same pattern as `reclaimLostNotificationClaims`: a
 * PENDING row untouched for longer than the lease is returned to the pool with
 * the stranded attempt COUNTED (it may have reached the receiver; the
 * X-Proovra-Event-Id header lets the receiver de-duplicate), or settled FAILED
 * `stranded` when that was its last allowed attempt. Conditional on status and
 * age, so a live send inside its lease is never touched and two sweeps reclaim
 * a row once.
 */
export const WEBHOOK_DELIVERY_LEASE_MS = 15 * 60 * 1000;

export async function reclaimStrandedWebhookDeliveries(
  client: PrismaClient,
  now: Date = new Date(),
): Promise<{ retried: number; failed: number }> {
  const cutoff = new Date(now.getTime() - WEBHOOK_DELIVERY_LEASE_MS);
  const failed = await client.integrationWebhookDelivery.updateMany({
    where: { status: "PENDING", updatedAt: { lt: cutoff }, attemptCount: { gte: WEBHOOK_RETRY_MAX_ATTEMPTS - 1 } },
    data: {
      status: "FAILED",
      attemptCount: { increment: 1 },
      errorMessage: "stranded",
      failedAtUtc: now,
      nextAttemptAtUtc: null,
    },
  });
  const retried = await client.integrationWebhookDelivery.updateMany({
    where: { status: "PENDING", updatedAt: { lt: cutoff }, attemptCount: { lt: WEBHOOK_RETRY_MAX_ATTEMPTS - 1 } },
    data: {
      status: "RETRY_SCHEDULED",
      attemptCount: { increment: 1 },
      errorMessage: "stranded",
      nextAttemptAtUtc: now,
    },
  });
  return { retried: retried.count, failed: failed.count };
}

export async function processDueWebhookRetries(
  input: { batchSize?: number } = {},
  client: PrismaClient = defaultPrisma,
): Promise<ProcessWebhookRetriesSummary> {
  const batchSize = Math.min(Math.max(input.batchSize ?? 50, 1), 500);
  const summary: ProcessWebhookRetriesSummary = {
    pickedUp: 0,
    delivered: 0,
    rescheduled: 0,
    failed: 0,
  };
  if (!isIntegrationsFeatureEnabled()) return summary;

  const now = new Date();
  await reclaimStrandedWebhookDeliveries(client, now);
  const candidates = await client.integrationWebhookDelivery.findMany({
    where: {
      status: "RETRY_SCHEDULED",
      attemptCount: { lt: WEBHOOK_RETRY_MAX_ATTEMPTS },
      nextAttemptAtUtc: { lte: now },
    },
    orderBy: { nextAttemptAtUtc: "asc" },
    take: batchSize,
  });

  const entitlementByTeam = new Map<string, boolean>();
  for (const row of candidates) {
    // Atomic claim — only proceed if the row is still RETRY_SCHEDULED.
    const claim = await client.integrationWebhookDelivery.updateMany({
      where: { id: row.id, status: "RETRY_SCHEDULED" },
      data: { status: "PENDING" },
    });
    if (claim.count !== 1) continue;
    summary.pickedUp += 1;

    const refreshed = await client.integrationWebhookDelivery.findUnique({
      where: { id: row.id },
    });
    if (!refreshed) {
      summary.failed += 1;
      continue;
    }
    const endpoint = await client.webhookEndpoint.findUnique({
      where: { id: refreshed.endpointId },
    });
    // PRO-G1-09 / B7B-F02 — a workspace that is not operating (closed, or its
    // organization suspended) sends nothing; a row due in that window is
    // DEFERRED (attempt count untouched) so it delivers after the organization
    // resumes. Asked before the entitlement below: a suspended organization
    // resolves as not entitled, and that verdict is terminal. A disabled
    // endpoint (closure, workspace suspension) still ends as CANCELLED below.
    if (endpoint && endpoint.status === "ACTIVE" && !(await isLiveOperatingWorkspace(refreshed.teamId, client))) {
      await client.integrationWebhookDelivery
        .update({
          where: { id: refreshed.id },
          data: {
            status: "RETRY_SCHEDULED",
            errorMessage: "workspace_not_operating",
            nextAttemptAtUtc: new Date(Date.now() + NOT_OPERATING_DEFER_MS),
          },
        })
        .catch(() => null);
      summary.rescheduled += 1;
      continue;
    }
    // PRO-G1-14 / DEC-09 — a scheduled retry is still outbound delivery, so
    // the workspace must still hold FEATURE_WEBHOOKS when it is sent (the
    // automation sibling SKIPs a lost capability the same way). Withheld, not
    // deleted: the row says why. A retry of a delivery admitted earlier does
    // not consume the daily quota again. Fails closed.
    let entitled = entitlementByTeam.get(refreshed.teamId);
    if (entitled === undefined) {
      try {
        const projection = await resolveEntitlement({
          prisma: client,
          teamId: refreshed.teamId,
          key: "FEATURE_WEBHOOKS",
        });
        entitled = projection.value === true;
      } catch {
        entitled = false;
      }
      entitlementByTeam.set(refreshed.teamId, entitled);
    }
    if (!entitled) {
      await client.integrationWebhookDelivery
        .update({
          where: { id: refreshed.id },
          data: {
            status: "CANCELLED",
            errorMessage: "withheld:entitlement_required",
            failedAtUtc: new Date(),
            nextAttemptAtUtc: null,
          },
        })
        .catch(() => null);
      summary.failed += 1;
      continue;
    }
    if (!endpoint || endpoint.status !== "ACTIVE") {
      // Endpoint gone or disabled — give up on this delivery.
      await client.integrationWebhookDelivery
        .update({
          where: { id: refreshed.id },
          data: {
            status: "CANCELLED",
            errorMessage: "endpoint_inactive",
            failedAtUtc: new Date(),
            nextAttemptAtUtc: null,
          },
        })
        .catch(() => null);
      summary.failed += 1;
      continue;
    }

    // RG-11 / AZ-R04 (matrix review NEW-RG-11-1) — the machine-egress rule is
    // asked again at send: a delivery queued before its record or case became
    // restricted does not leave on a retry (the automation channel re-checks
    // on every send the same way). Fails closed; the row says why.
    const payload = (refreshed.payloadJson ?? {}) as { data?: unknown };
    const data =
      payload.data && typeof payload.data === "object" ? (payload.data as Record<string, unknown>) : {};
    if (await machineEgressRestricted(machineEgressTargetOf(data), client)) {
      await client.integrationWebhookDelivery
        .update({
          where: { id: refreshed.id },
          data: {
            status: "CANCELLED",
            errorMessage: "withheld:target_restricted",
            failedAtUtc: new Date(),
            nextAttemptAtUtc: null,
          },
        })
        .catch(() => null);
      summary.failed += 1;
      continue;
    }

    try {
      const outcome = await attemptDelivery(refreshed, endpoint, client);
      if (outcome === "delivered") summary.delivered += 1;
      else if (outcome === "transient") summary.rescheduled += 1;
      else summary.failed += 1;
    } catch {
      summary.failed += 1;
    }
  }

  return summary;
}
