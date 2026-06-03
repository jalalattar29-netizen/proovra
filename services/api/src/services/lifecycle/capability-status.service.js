/**
 * Lifecycle Consolidation — Capability Enforcement Status helper.
 *
 * Per-team, per-capability honest verdict that combines:
 *   1. The team's FEATURE_* entitlement (from packaging/entitlement.service).
 *   2. The worker enable flag from the worker fleet's env (`process.env`).
 *
 * Rules (bounded, audit-honest):
 *   - retention:      entitled + RETENTION_RECONCILIATION_ENABLED=true   -> FULLY_OPERATIONAL
 *                     entitled + worker off                              -> WRITES_BUT_NOT_ENFORCED
 *                     not entitled                                       -> DISABLED
 *   - legalHolds:     entitled                                           -> FULLY_OPERATIONAL  (no worker needed; compat shim reads both tables)
 *                     not entitled                                       -> DISABLED
 *   - archive:        entitled + ARCHIVE_AUTO_TRANSITION_ENABLED=true    -> FULLY_OPERATIONAL
 *                     entitled + worker off                              -> CONFIGURATION_ONLY
 *                     not entitled                                       -> DISABLED
 *   - destruction:    entitled + DESTRUCTION_ORCHESTRATOR_ENABLED=true   -> FULLY_OPERATIONAL
 *                     entitled + worker off                              -> WRITES_BUT_NOT_ENFORCED
 *                     not entitled                                       -> DISABLED
 *   - webhooks:       entitled + WEBHOOK_DISPATCHER_ENABLED=true         -> FULLY_OPERATIONAL
 *                     entitled + worker off                              -> CONFIGURATION_ONLY
 *                     not entitled                                       -> DISABLED
 *   - chainTransfers: entitled                                           -> FULLY_OPERATIONAL  (synchronous in-thread by design)
 *                     not entitled                                       -> DISABLED
 *
 * The dashboard handler wraps the call to this service in try/catch and
 * omits `capabilities` on failure — the frontend tolerates absence and
 * never crashes when this block is missing.
 */
import { assertFeatureEntitlement } from "../packaging/entitlement.service.js";
const TRUTHY = new Set(["1", "true", "TRUE", "yes", "YES", "on", "ON"]);
function envBoolean(env, key, defaultWhenUnset) {
    const raw = env[key];
    if (raw === undefined || raw === null || raw === "")
        return defaultWhenUnset;
    return TRUTHY.has(raw);
}
async function isFeatureEntitled(input) {
    try {
        const res = await assertFeatureEntitlement({
            prisma: input.prisma,
            teamId: input.teamId,
            key: input.key,
        });
        return res.ok === true;
    }
    catch {
        // Engine failure is a hard NO — never assume entitlement.
        return false;
    }
}
export async function computeLifecycleCapabilityStatus(input) {
    const { prisma, teamId } = input;
    const env = input.env ?? process.env;
    // Worker enable flags — defaults mirror the worker fleet's defaults
    // (see services/worker/src/index.ts envBoolean calls).
    const retentionWorker = envBoolean(env, "RETENTION_RECONCILIATION_ENABLED", false);
    const archiveWorker = envBoolean(env, "ARCHIVE_AUTO_TRANSITION_ENABLED", false);
    const destructionWorker = envBoolean(env, "DESTRUCTION_ORCHESTRATOR_ENABLED", false);
    const webhookWorker = envBoolean(env, "WEBHOOK_DISPATCHER_ENABLED", true);
    // Per-team feature entitlements — parallel for latency.
    const [retentionEntitled, legalHoldEntitled, archiveEntitled, destructionEntitled, webhooksEntitled, chainTransferEntitled,] = await Promise.all([
        isFeatureEntitled({ prisma, teamId, key: "FEATURE_LEGAL_HOLD" }),
        isFeatureEntitled({ prisma, teamId, key: "FEATURE_LEGAL_HOLD" }),
        isFeatureEntitled({ prisma, teamId, key: "FEATURE_ARCHIVE_TIERS" }),
        isFeatureEntitled({ prisma, teamId, key: "FEATURE_DESTRUCTION_GOVERNANCE" }),
        isFeatureEntitled({ prisma, teamId, key: "FEATURE_WEBHOOKS" }),
        isFeatureEntitled({ prisma, teamId, key: "FEATURE_CHAIN_TRANSFER" }),
    ]);
    const retention = !retentionEntitled
        ? { status: "DISABLED", reason: "Retention not entitled for this workspace" }
        : retentionWorker
            ? { status: "FULLY_OPERATIONAL" }
            : {
                status: "WRITES_BUT_NOT_ENFORCED",
                reason: "Retention reconciliation worker not enabled",
            };
    const legalHolds = legalHoldEntitled
        ? { status: "FULLY_OPERATIONAL" }
        : { status: "DISABLED", reason: "Legal holds not entitled for this workspace" };
    const archive = !archiveEntitled
        ? { status: "DISABLED", reason: "Archive tiers not entitled for this workspace" }
        : archiveWorker
            ? { status: "FULLY_OPERATIONAL" }
            : {
                status: "CONFIGURATION_ONLY",
                reason: "Auto-tier worker not enabled",
            };
    const destruction = !destructionEntitled
        ? { status: "DISABLED", reason: "Destruction governance not entitled for this workspace" }
        : destructionWorker
            ? { status: "FULLY_OPERATIONAL" }
            : {
                status: "WRITES_BUT_NOT_ENFORCED",
                reason: "Destruction orchestrator worker not enabled",
            };
    const webhooks = !webhooksEntitled
        ? { status: "DISABLED", reason: "Webhooks not entitled for this workspace" }
        : webhookWorker
            ? { status: "FULLY_OPERATIONAL" }
            : {
                status: "CONFIGURATION_ONLY",
                reason: "Webhook dispatcher worker not enabled",
            };
    const chainTransfers = chainTransferEntitled
        ? { status: "FULLY_OPERATIONAL" }
        : { status: "DISABLED", reason: "Chain transfers not entitled for this workspace" };
    return {
        retention,
        legalHolds,
        archive,
        destruction,
        webhooks,
        chainTransfers,
    };
}
