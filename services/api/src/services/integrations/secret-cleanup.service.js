/**
 * PHASE 5 closure — Cron sweeper for expired previous_* integration
 * secrets.
 *
 * See secret-cleanup.service.ts for the contract.
 */
import { prisma as defaultPrisma } from "../../db.js";
import { isIntegrationsFeatureEnabled } from "./api-keys.service.js";
const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 5000;
function clampBatchSize(raw) {
    const v = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_BATCH_SIZE;
    if (v < 1)
        return 1;
    if (v > MAX_BATCH_SIZE)
        return MAX_BATCH_SIZE;
    return v;
}
export async function sweepExpiredPreviousIntegrationSecrets(input = {}, client = defaultPrisma) {
    const batchSize = clampBatchSize(input.batchSize);
    const dryRun = input.dryRun === true;
    const scannedAt = new Date();
    const summary = {
        apiKeyRowsCleared: 0,
        webhookRowsCleared: 0,
        scannedAt: scannedAt.toISOString(),
        dryRun,
    };
    if (!isIntegrationsFeatureEnabled())
        return summary;
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
            }
            else {
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
            }
            else {
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
