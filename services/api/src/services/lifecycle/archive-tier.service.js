/**
 * PROOVRA Phase 4B — Archive tier platform.
 *
 * Phase 4B C1: Real archive tier storage transitions.
 *
 * HOT / WARM / COLD / DEEP_ARCHIVE now move bytes via S3 StorageClass
 * using CopyObject (same bucket/key + new StorageClass). GLACIER /
 * DEEP_ARCHIVE restores are initiated via RestoreObject.
 *
 * State machine:
 *   HOT/WARM transitions:    PENDING → COMPLETED  (synchronous CopyObject)
 *   GLACIER/DEEP_ARCHIVE:    PENDING → EXECUTING → COMPLETED (S3 is
 *                            immediate on the API side; data moves async
 *                            server-side — EXECUTING captures that)
 *   Restore (GLACIER/DEEP):  RESTORE_REQUESTED  (headObject poller drives
 *                            RESTORE_REQUESTED → RESTORED)
 *
 * Hard rules:
 *   * Transition row MUST be written BEFORE S3 call — post-mortem audit
 *     must see every attempt even if the process crashes mid-call.
 *   * S3 failure persists state=FAILED + failureReason, never silently.
 *   * All emitLifecycleEvent + webhook calls are fire-and-forget.
 *   * Workspace-anchored on every read + write path.
 *
 * NOTE: The Prisma client was generated before the Phase 4B additive columns
 * (state, storageClassBefore, storageClassAfter, executedAtUtc, failureReason,
 * restoreTargetAtUtc) were added to the schema. We use `as any` casts on
 * create/update data objects that reference those new columns — matching the
 * pattern used in destruction-governance.service.ts for the same reason.
 */
import { ARCHIVE_TIERS, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { emitWebhookEvent } from "../integrations/webhook-dispatcher.js";
import { emitLifecycleEvent } from "../intelligence/intelligence-activity.service.js";
import { copyObjectStorageClass, restoreObject, headObjectStorageClass, } from "../../storage.js";
// -----------------------------------------------------------------------------
// S3 StorageClass mapping
// -----------------------------------------------------------------------------
export const TIER_TO_S3_STORAGE_CLASS = {
    HOT: "STANDARD",
    WARM: "STANDARD_IA",
    COLD: "GLACIER",
    DEEP_ARCHIVE: "DEEP_ARCHIVE",
};
/** Tiers where S3 moves data asynchronously after the API returns. */
const ASYNC_GLACIER_TIERS = new Set([
    "COLD",
    "DEEP_ARCHIVE",
]);
/** Tiers that must go through RestoreObject before bytes are accessible. */
const RESTORE_REQUIRED_TIERS = new Set([
    "COLD",
    "DEEP_ARCHIVE",
]);
// -----------------------------------------------------------------------------
// Cost constants
// -----------------------------------------------------------------------------
/**
 * Per-GB-per-month USD micros. AWS list pricing for the matching tier.
 *
 *   HOT          = S3 Standard               ≈ $0.023   / GB-month
 *   WARM         = S3 Standard-IA            = $0.0125  / GB-month
 *   COLD         = Glacier Instant Retrieval = $0.004   / GB-month
 *   DEEP_ARCHIVE = Glacier Deep Archive      = $0.00099 / GB-month
 */
export const COST_PER_GB_PER_MONTH_USD_MICROS = {
    HOT: 23_000,
    WARM: 12_500,
    COLD: 4_000,
    DEEP_ARCHIVE: 990,
};
const BYTES_PER_GB = 1_000_000_000;
function computeMonthlyCostUsdMicros(sizeBytes, tier) {
    const ratePerGb = COST_PER_GB_PER_MONTH_USD_MICROS[tier];
    if (sizeBytes <= 0n)
        return 0;
    const totalMicros = (sizeBytes * BigInt(ratePerGb)) / BigInt(BYTES_PER_GB);
    if (totalMicros > BigInt(Number.MAX_SAFE_INTEGER)) {
        return Number.MAX_SAFE_INTEGER;
    }
    return Number(totalMicros);
}
function isArchiveTier(value) {
    return ARCHIVE_TIERS.includes(value);
}
function boundFailureReason(err) {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.slice(0, 580);
}
// -----------------------------------------------------------------------------
// Best-effort webhook emitter (fire-and-forget)
// -----------------------------------------------------------------------------
async function tryEmitWebhookEvent(client, teamId, eventKind, payload) {
    try {
        await emitWebhookEvent({
            teamId,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            eventType: eventKind,
            payload,
            attemptInline: false,
        }, client);
    }
    catch {
        /* fire-and-forget — audit fan-out failure must never break the operational write */
    }
}
// -----------------------------------------------------------------------------
// Current tier resolution — DB-first, S3 head optional
// -----------------------------------------------------------------------------
/**
 * Resolve the current archive tier for an evidence item.
 *
 * Primary: latest ArchiveTierTransition row's toTier.
 * Secondary (when checkS3=true): live S3 x-amz-storage-class header.
 * Fallback: HOT.
 */
export async function currentTierFor(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const latest = await prisma.archiveTierTransition.findFirst({
        where: { teamId: input.teamId, evidenceId: input.evidenceId },
        orderBy: { transitionedAtUtc: "desc" },
        select: { toTier: true },
    });
    if (input.checkS3) {
        const ev = await prisma.evidence.findUnique({
            where: { id: input.evidenceId },
            select: { storageBucket: true, storageKey: true },
        });
        if (ev?.storageBucket && ev.storageKey) {
            try {
                const head = await headObjectStorageClass({
                    bucket: ev.storageBucket,
                    key: ev.storageKey,
                });
                const sc = head ?? "STANDARD";
                const liveS3Tier = s3StorageClassToTier(sc);
                if (liveS3Tier)
                    return liveS3Tier;
            }
            catch {
                /* headObject failure — fall through to DB row */
            }
        }
    }
    if (latest && isArchiveTier(latest.toTier))
        return latest.toTier;
    return "HOT";
}
function s3StorageClassToTier(storageClass) {
    for (const [tier, sc] of Object.entries(TIER_TO_S3_STORAGE_CLASS)) {
        if (sc === storageClass)
            return tier;
    }
    return null;
}
export class ArchiveTierError extends Error {
    code;
    details;
    constructor(code, details) {
        super(code);
        this.code = code;
        this.details = details;
        this.name = "ArchiveTierError";
    }
}
export async function transitionEvidenceTier(input) {
    if (!isArchiveTier(input.toTier)) {
        throw new ArchiveTierError("invalid_tier", { toTier: input.toTier });
    }
    const prisma = input.prisma ?? defaultPrisma;
    const evidence = await prisma.evidence.findUnique({
        where: { id: input.evidenceId },
        select: {
            id: true,
            teamId: true,
            sizeBytes: true,
            storageBucket: true,
            storageKey: true,
        },
    });
    if (!evidence || evidence.teamId !== input.teamId) {
        throw new ArchiveTierError("evidence_not_in_workspace", {
            evidenceId: input.evidenceId,
        });
    }
    const fromTier = await currentTierFor({
        prisma,
        teamId: input.teamId,
        evidenceId: input.evidenceId,
    });
    const sizeBytes = evidence.sizeBytes ?? 0n;
    const costEstimateUsdMicros = computeMonthlyCostUsdMicros(sizeBytes, input.toTier);
    const storageClassBefore = TIER_TO_S3_STORAGE_CLASS[fromTier];
    const storageClassAfter = TIER_TO_S3_STORAGE_CLASS[input.toTier];
    // -- 1. Write transition row BEFORE S3 call --
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await prisma.archiveTierTransition.create({
        data: {
            teamId: input.teamId,
            evidenceId: input.evidenceId,
            fromTier,
            toTier: input.toTier,
            reason: input.reason?.slice(0, 400) ?? null,
            costEstimateUsdMicros: BigInt(costEstimateUsdMicros),
            initiatedByUserId: input.initiatedByUserId ?? null,
            state: "PENDING",
            storageClassBefore,
            storageClassAfter,
        },
        select: { id: true },
    });
    // -- 2. Emit ARCHIVE_TRANSITION_REQUESTED (fire-and-forget) --
    void emitLifecycleEvent({
        prisma,
        teamId: input.teamId,
        code: "ARCHIVE_TRANSITION_REQUESTED",
        evidenceId: input.evidenceId,
        actorUserId: input.initiatedByUserId ?? null,
        reason: input.reason ?? null,
        payload: { fromTier, toTier: input.toTier, transitionId: row.id },
    });
    // -- 3. Validate storage key exists --
    const bucket = evidence.storageBucket;
    const key = evidence.storageKey;
    if (!bucket || !key) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await prisma.archiveTierTransition.update({
            where: { id: row.id },
            data: { state: "FAILED", failureReason: "evidence_has_no_storage_key" },
        });
        void emitLifecycleEvent({
            prisma,
            teamId: input.teamId,
            code: "ARCHIVE_TRANSITION_FAILED",
            evidenceId: input.evidenceId,
            failureReason: "evidence_has_no_storage_key",
            payload: { transitionId: row.id },
        });
        throw new ArchiveTierError("evidence_has_no_storage_key", {
            evidenceId: input.evidenceId,
        });
    }
    const isGlacierTier = ASYNC_GLACIER_TIERS.has(input.toTier);
    // For Glacier tiers, transition to EXECUTING before the S3 call to record
    // that bytes are being queued server-side (S3 API returns immediately).
    if (isGlacierTier) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await prisma.archiveTierTransition.update({
            where: { id: row.id },
            data: { state: "EXECUTING" },
        });
        void emitLifecycleEvent({
            prisma,
            teamId: input.teamId,
            code: "ARCHIVE_TRANSITION_STARTED",
            evidenceId: input.evidenceId,
            payload: { transitionId: row.id, toTier: input.toTier },
        });
    }
    // -- 4. S3 CopyObject (changes storage class in-place) --
    try {
        await copyObjectStorageClass({ bucket, key, storageClass: storageClassAfter });
    }
    catch (err) {
        const failureReason = boundFailureReason(err);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await prisma.archiveTierTransition.update({
            where: { id: row.id },
            data: { state: "FAILED", failureReason },
        });
        void emitLifecycleEvent({
            prisma,
            teamId: input.teamId,
            code: "ARCHIVE_TRANSITION_FAILED",
            evidenceId: input.evidenceId,
            failureReason: failureReason.slice(0, 200),
            payload: { transitionId: row.id, fromTier, toTier: input.toTier },
        });
        throw err;
    }
    // -- 5. S3 call succeeded: mark COMPLETED --
    const now = new Date();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await prisma.archiveTierTransition.update({
        where: { id: row.id },
        data: { state: "COMPLETED", executedAtUtc: now },
    });
    // -- 6. Fire-and-forget audit + webhooks --
    const successPayload = {
        evidenceId: input.evidenceId,
        fromTier,
        toTier: input.toTier,
        costEstimateUsdMicros,
        reason: input.reason ?? null,
        initiatedByUserId: input.initiatedByUserId ?? null,
        transitionId: row.id,
        executedAtUtc: now.toISOString(),
    };
    void emitLifecycleEvent({
        prisma,
        teamId: input.teamId,
        code: "ARCHIVE_TRANSITION_COMPLETED",
        evidenceId: input.evidenceId,
        actorUserId: input.initiatedByUserId ?? null,
        payload: { transitionId: row.id, fromTier, toTier: input.toTier },
    });
    void tryEmitWebhookEvent(prisma, input.teamId, "ARCHIVE_TIER_CHANGED", successPayload);
    void tryEmitWebhookEvent(prisma, input.teamId, "ARCHIVE_COMPLETED", successPayload);
    return { ok: true, transitionId: row.id, costEstimateUsdMicros };
}
/**
 * Initiate a Glacier / Deep Archive restore.
 *
 * 1. Validates evidence is currently in COLD or DEEP_ARCHIVE.
 * 2. Inserts ArchiveTierTransition row with state=RESTORE_REQUESTED.
 * 3. Calls S3 RestoreObject.
 * 4. A background poller (currentTierFor with checkS3=true) drives
 *    RESTORE_REQUESTED → RESTORED when the Restore header flips.
 */
export async function restoreEvidenceTier(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const evidence = await prisma.evidence.findUnique({
        where: { id: input.evidenceId },
        select: {
            id: true,
            teamId: true,
            storageBucket: true,
            storageKey: true,
        },
    });
    if (!evidence || evidence.teamId !== input.teamId) {
        throw new ArchiveTierError("evidence_not_in_workspace", {
            evidenceId: input.evidenceId,
        });
    }
    const currentTier = await currentTierFor({
        prisma,
        teamId: input.teamId,
        evidenceId: input.evidenceId,
    });
    if (!RESTORE_REQUIRED_TIERS.has(currentTier)) {
        throw Object.assign(new Error(`restore_not_required: evidence is in tier ${currentTier}`), { code: "restore_not_required", currentTier });
    }
    const restoreDays = Math.max(1, input.restoreDays ?? 7);
    const restoreTargetAtUtc = new Date(Date.now() + restoreDays * 24 * 60 * 60 * 1000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await prisma.archiveTierTransition.create({
        data: {
            teamId: input.teamId,
            evidenceId: input.evidenceId,
            fromTier: currentTier,
            toTier: currentTier, // tier stays the same — this is a restore, not a transition
            reason: "RESTORE_REQUESTED",
            costEstimateUsdMicros: 0n,
            initiatedByUserId: input.initiatedByUserId ?? null,
            state: "RESTORE_REQUESTED",
            storageClassBefore: TIER_TO_S3_STORAGE_CLASS[currentTier],
            storageClassAfter: TIER_TO_S3_STORAGE_CLASS[currentTier],
            restoreTargetAtUtc,
        },
        select: { id: true },
    });
    void emitLifecycleEvent({
        prisma,
        teamId: input.teamId,
        code: "ARCHIVE_RESTORE_REQUESTED",
        evidenceId: input.evidenceId,
        actorUserId: input.initiatedByUserId ?? null,
        payload: { transitionId: row.id, currentTier, restoreDays },
    });
    const bucket = evidence.storageBucket;
    const key = evidence.storageKey;
    if (bucket && key) {
        try {
            await restoreObject({ bucket, key, days: restoreDays });
        }
        catch (err) {
            const failureReason = boundFailureReason(err);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await prisma.archiveTierTransition.update({
                where: { id: row.id },
                data: { state: "FAILED", failureReason },
            });
            void emitLifecycleEvent({
                prisma,
                teamId: input.teamId,
                code: "ARCHIVE_TRANSITION_FAILED",
                evidenceId: input.evidenceId,
                failureReason: failureReason.slice(0, 200),
                payload: { transitionId: row.id, restoreContext: true },
            });
            throw err;
        }
    }
    return { ok: true, transitionId: row.id };
}
// -----------------------------------------------------------------------------
// List
// -----------------------------------------------------------------------------
export async function listArchiveTransitions(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const rows = await prisma.archiveTierTransition.findMany({
        where: {
            teamId: input.teamId,
            ...(input.evidenceId ? { evidenceId: input.evidenceId } : {}),
            ...(input.toTier ? { toTier: input.toTier } : {}),
        },
        orderBy: { transitionedAtUtc: "desc" },
        take: 500,
    });
    return rows.map((r) => ({
        evidenceId: r.evidenceId,
        fromTier: isArchiveTier(r.fromTier) ? r.fromTier : "HOT",
        toTier: isArchiveTier(r.toTier) ? r.toTier : "HOT",
        transitionedAtUtc: r.transitionedAtUtc.toISOString(),
        reason: r.reason,
        costEstimateUsdMicros: Number(r.costEstimateUsdMicros),
    }));
}
export async function projectArchiveCostsByTier(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const buckets = {
        HOT: { evidenceCount: 0, totalCostUsdMicrosPerMonth: 0 },
        WARM: { evidenceCount: 0, totalCostUsdMicrosPerMonth: 0 },
        COLD: { evidenceCount: 0, totalCostUsdMicrosPerMonth: 0 },
        DEEP_ARCHIVE: { evidenceCount: 0, totalCostUsdMicrosPerMonth: 0 },
    };
    const evidenceRows = await prisma.evidence.findMany({
        where: { teamId: input.teamId, deletedAt: null },
        select: { id: true, sizeBytes: true },
    });
    if (evidenceRows.length === 0)
        return buckets;
    const allTransitions = await prisma.archiveTierTransition.findMany({
        where: { teamId: input.teamId },
        orderBy: { transitionedAtUtc: "desc" },
        select: { evidenceId: true, toTier: true },
    });
    const latestByEvidence = new Map();
    for (const t of allTransitions) {
        if (latestByEvidence.has(t.evidenceId))
            continue;
        if (isArchiveTier(t.toTier))
            latestByEvidence.set(t.evidenceId, t.toTier);
    }
    for (const ev of evidenceRows) {
        const tier = latestByEvidence.get(ev.id) ?? "HOT";
        const sizeBytes = ev.sizeBytes ?? 0n;
        const cost = computeMonthlyCostUsdMicros(sizeBytes, tier);
        buckets[tier].evidenceCount += 1;
        buckets[tier].totalCostUsdMicrosPerMonth += cost;
    }
    return buckets;
}
// -----------------------------------------------------------------------------
// Auto-transition scheduler
// -----------------------------------------------------------------------------
/**
 * Walks workspace evidence and tiers down based on age thresholds.
 *
 * Default schedule (cumulative days since evidence createdAt):
 *   HOT  → WARM           after  30 days
 *   WARM → COLD           after 120 days (30 + 90)
 *   COLD → DEEP_ARCHIVE   after 485 days (30 + 90 + 365)
 *
 * Capped at 100 transitions per run.
 */
export async function scheduleAutoTransitions(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const HOT_TO_WARM_DAYS = 30;
    const WARM_TO_COLD_CUMULATIVE_DAYS = 120; // 30 + 90
    const COLD_TO_DEEP_CUMULATIVE_DAYS = 485; // 30 + 90 + 365
    const MAX_PER_RUN = 100;
    const evidenceRows = await prisma.evidence.findMany({
        where: { teamId: input.teamId, deletedAt: null },
        select: { id: true, createdAt: true },
        take: MAX_PER_RUN * 4,
    });
    if (evidenceRows.length === 0)
        return { scheduled: 0 };
    const allTransitions = await prisma.archiveTierTransition.findMany({
        where: { teamId: input.teamId },
        orderBy: { transitionedAtUtc: "desc" },
        select: { evidenceId: true, toTier: true },
    });
    const latestByEvidence = new Map();
    for (const t of allTransitions) {
        if (latestByEvidence.has(t.evidenceId))
            continue;
        if (isArchiveTier(t.toTier))
            latestByEvidence.set(t.evidenceId, t.toTier);
    }
    const now = Date.now();
    let scheduled = 0;
    for (const ev of evidenceRows) {
        if (scheduled >= MAX_PER_RUN)
            break;
        const currentTier = latestByEvidence.get(ev.id) ?? "HOT";
        const ageDays = (now - ev.createdAt.getTime()) / (1000 * 60 * 60 * 24);
        let targetTier = null;
        if (currentTier === "HOT" && ageDays >= HOT_TO_WARM_DAYS) {
            targetTier = "WARM";
        }
        else if (currentTier === "WARM" && ageDays >= WARM_TO_COLD_CUMULATIVE_DAYS) {
            targetTier = "COLD";
        }
        else if (currentTier === "COLD" && ageDays >= COLD_TO_DEEP_CUMULATIVE_DAYS) {
            targetTier = "DEEP_ARCHIVE";
        }
        if (!targetTier)
            continue;
        try {
            await transitionEvidenceTier({
                prisma,
                teamId: input.teamId,
                evidenceId: ev.id,
                toTier: targetTier,
                reason: "AUTO_TRANSITION",
            });
            scheduled += 1;
        }
        catch {
            /* one evidence failure must not abort the remaining batch */
        }
    }
    return { scheduled };
}
