/**
 * PHASE 5 closure — Cron sweeper for expired previous_* integration
 * secrets.
 *
 * BACKGROUND
 *
 * Phase 2 (api-key rotation) and Phase 4 (webhook dual-signing
 * rotation) introduced a grace window where the PRIOR secret material
 * stays valid alongside the new one. Each rotation copies the old
 * material into a `previous_*` triple:
 *
 *   - ApiCredential.previousKeyHash / previousKeyPrefix /
 *     previousValidUntilUtc
 *   - WebhookEndpoint.previousSecretCiphertext / previousSecretPrefix /
 *     previousSecretValidUntilUtc
 *
 * After the grace window expires the old material MUST be cleared.
 *
 * The dispatcher already clears expired webhook-endpoint previous_*
 * rows opportunistically (see
 * `clearExpiredPreviousWebhookSecret` in webhooks.service.ts, called
 * fire-and-forget from `attemptDeliveryInner`), and the api-key verify
 * path lazily clears expired previousKey* rows during verifyApiKey.
 * Those lazy paths only fire when there is traffic; endpoints and
 * credentials that go quiet during their grace window retain stale
 * previous_* values indefinitely.
 *
 * This service is the explicit cron-driven sweep that mops up those
 * quiet rows. It is intentionally idempotent: running it twice in
 * succession returns 0 the second time, because each run only matches
 * rows whose `previous*ValidUntilUtc` is strictly in the past.
 *
 * Hard rules:
 *   - Never reads or logs raw secrets — only bounded counts.
 *   - Touches ONLY the previous_* triples; the live `keyHash` /
 *     `secretCiphertext` columns are never read or written.
 *   - LIMIT batchSize on each updateMany so a backlog does not lock
 *     the table.
 *   - `dryRun:true` returns the counts that WOULD be cleared without
 *     issuing any UPDATE.
 */

import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { isIntegrationsFeatureEnabled } from "./api-keys.service.js";

export type SweepExpiredPreviousSecretsInput = {
  batchSize?: number;
  dryRun?: boolean;
};

export type SweepExpiredPreviousSecretsSummary = {
  apiKeyRowsCleared: number;
  webhookRowsCleared: number;
  scannedAt: string;
  dryRun: boolean;
};

const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 5_000;

function clampBatchSize(raw: number | undefined): number {
  const v = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_BATCH_SIZE;
  if (v < 1) return 1;
  if (v > MAX_BATCH_SIZE) return MAX_BATCH_SIZE;
  return v;
}

/**
 * Sweep ApiCredential + WebhookEndpoint rows whose `previous_*`
 * grace window has expired.
 *
 * Idempotent: only matches rows where `previous*ValidUntilUtc IS NOT
 * NULL AND previous*ValidUntilUtc < NOW()`. Once cleared the
 * triple goes back to NULL so a second run finds nothing.
 */
export async function sweepExpiredPreviousIntegrationSecrets(
  input: SweepExpiredPreviousSecretsInput = {},
  client: PrismaClient = defaultPrisma,
): Promise<SweepExpiredPreviousSecretsSummary> {
  const batchSize = clampBatchSize(input.batchSize);
  const dryRun = input.dryRun === true;
  const scannedAt = new Date();

  const summary: SweepExpiredPreviousSecretsSummary = {
    apiKeyRowsCleared: 0,
    webhookRowsCleared: 0,
    scannedAt: scannedAt.toISOString(),
    dryRun,
  };

  // Honour the global feature flag — if the integrations surface is
  // disabled there is no reason for this sweeper to do work.
  if (!isIntegrationsFeatureEnabled()) return summary;

  // -------------------------------------------------------------------
  // ApiCredential — clear expired previous_* triples.
  // -------------------------------------------------------------------
  {
    const candidates = await client.apiCredential.findMany({
      where: {
        previousValidUntilUtc: { not: null, lt: scannedAt },
      },
      select: { id: true },
      take: batchSize,
    });
    if (candidates.length > 0) {
      if (dryRun) {
        summary.apiKeyRowsCleared = candidates.length;
      } else {
        const result = await client.apiCredential.updateMany({
          where: {
            id: { in: candidates.map((c) => c.id) },
            previousValidUntilUtc: { not: null, lt: scannedAt },
          },
          data: {
            previousKeyHash: null,
            previousKeyPrefix: null,
            previousValidUntilUtc: null,
          },
        });
        summary.apiKeyRowsCleared = result.count;
      }
    }
  }

  // -------------------------------------------------------------------
  // WebhookEndpoint — clear expired previous_* triples.
  // -------------------------------------------------------------------
  {
    const candidates = await client.webhookEndpoint.findMany({
      where: {
        previousSecretValidUntilUtc: { not: null, lt: scannedAt },
      },
      select: { id: true },
      take: batchSize,
    });
    if (candidates.length > 0) {
      if (dryRun) {
        summary.webhookRowsCleared = candidates.length;
      } else {
        const result = await client.webhookEndpoint.updateMany({
          where: {
            id: { in: candidates.map((c) => c.id) },
            previousSecretValidUntilUtc: { not: null, lt: scannedAt },
          },
          data: {
            previousSecretCiphertext: null,
            previousSecretPrefix: null,
            previousSecretValidUntilUtc: null,
          },
        });
        summary.webhookRowsCleared = result.count;
      }
    }
  }

  return summary;
}
