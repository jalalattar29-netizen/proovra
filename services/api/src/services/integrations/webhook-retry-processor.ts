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
import { attemptDelivery } from "./webhook-dispatcher.js";

export type ProcessWebhookRetriesSummary = {
  pickedUp: number;
  delivered: number;
  rescheduled: number;
  failed: number;
};

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
  const candidates = await client.integrationWebhookDelivery.findMany({
    where: {
      status: "RETRY_SCHEDULED",
      attemptCount: { lt: WEBHOOK_RETRY_MAX_ATTEMPTS },
      nextAttemptAtUtc: { lte: now },
    },
    orderBy: { nextAttemptAtUtc: "asc" },
    take: batchSize,
  });

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
