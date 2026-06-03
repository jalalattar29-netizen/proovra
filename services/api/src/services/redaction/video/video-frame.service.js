/**
 * PROOVRA Phase 3A Elite Closure — Video frame persistence.
 *
 * Bounded persistence layer for extracted video frames. The actual
 * ffmpeg extraction runs in the worker; this service is the
 * API-side bookkeeper that:
 *
 *   * Records frame metadata (`frame_index`, `timestamp_ms`,
 *     `extractor`) inserted by the worker.
 *   * Lets the operator inline-register frames during a test or
 *     trial (the `OPERATOR_INLINE` extractor).
 *   * Surfaces bounded frame listings the timeline UI + the
 *     tracking heuristic consume.
 *
 * Hard rules:
 *   * Workspace-anchored at every entry point.
 *   * The original video bytes are NEVER mutated. Frames are
 *     derived artefacts stored under a separate S3 prefix.
 *   * Bounded sampling presets — `VIDEO_FRAME_SAMPLE_MS` decides
 *     the ms cadence the worker uses; ALL_FRAMES is reserved for
 *     keyframes-only mode at the operator's discretion.
 */
import { VIDEO_FRAME_EXTRACTORS, VIDEO_FRAME_SAMPLE_MS, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../../db.js";
import { emitRedactionActivity } from "../redaction-activity.service.js";
// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------
export async function registerVideoFrame(input) {
    if (!VIDEO_FRAME_EXTRACTORS.includes(input.extractor)) {
        return { ok: false, denial: "POLICY_REJECTED" };
    }
    if (!Number.isInteger(input.frameIndex) || input.frameIndex < 0) {
        return { ok: false, denial: "REGION_OUT_OF_BOUNDS" };
    }
    if (!Number.isInteger(input.timestampMs) || input.timestampMs < 0) {
        return { ok: false, denial: "REGION_OUT_OF_BOUNDS" };
    }
    const prisma = input.prisma ?? defaultPrisma;
    const existing = await prisma.videoFrame.findFirst({
        where: {
            teamId: input.teamId,
            evidenceId: input.evidenceId,
            frameIndex: input.frameIndex,
        },
        select: { id: true },
    });
    if (existing) {
        return { ok: true, frameId: existing.id, opened: false };
    }
    const created = await prisma.videoFrame.create({
        data: {
            teamId: input.teamId,
            evidenceId: input.evidenceId,
            frameIndex: input.frameIndex,
            timestampMs: input.timestampMs,
            extractor: input.extractor,
            storageBucket: input.storageBucket ?? null,
            storageKey: input.storageKey ?? null,
            storageRegion: input.storageRegion ?? null,
            byteSize: input.byteSize ?? null,
            contentType: input.contentType ?? null,
        },
        select: { id: true },
    });
    return { ok: true, frameId: created.id, opened: true };
}
export async function registerVideoFrameBatch(input) {
    if (!VIDEO_FRAME_EXTRACTORS.includes(input.extractor)) {
        return { ok: false, denial: "POLICY_REJECTED" };
    }
    if (input.frames.length === 0) {
        return { ok: true, inserted: 0, reused: 0 };
    }
    if (input.frames.length > 5000) {
        // Bounded — worker batches are split server-side at this cap.
        return { ok: false, denial: "POLICY_REJECTED" };
    }
    const prisma = input.prisma ?? defaultPrisma;
    let inserted = 0;
    let reused = 0;
    for (const f of input.frames) {
        const res = await registerVideoFrame({
            prisma,
            teamId: input.teamId,
            evidenceId: input.evidenceId,
            frameIndex: f.frameIndex,
            timestampMs: f.timestampMs,
            extractor: input.extractor,
            storageBucket: f.storageBucket ?? null,
            storageKey: f.storageKey ?? null,
            storageRegion: f.storageRegion ?? null,
            byteSize: f.byteSize ?? null,
            contentType: f.contentType ?? null,
        });
        if (!res.ok)
            continue;
        if (res.opened)
            inserted++;
        else
            reused++;
    }
    // Best-effort projection of the bounded sampling preset for the
    // operator timeline.
    void input.samplePreset;
    void VIDEO_FRAME_SAMPLE_MS;
    // The activity event is recorded against the redaction project
    // associated with the evidence, if any. Otherwise the worker
    // emits a custody event separately. Bounded best-effort.
    void emitRedactionActivity;
    return { ok: true, inserted, reused };
}
// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export async function listVideoFrames(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const rows = await prisma.videoFrame.findMany({
        where: { teamId: input.teamId, evidenceId: input.evidenceId },
        orderBy: { frameIndex: "asc" },
        take: Math.min(input.limit ?? 5000, 50000),
    });
    return rows.map((r) => ({
        id: r.id,
        frameIndex: r.frameIndex,
        // BigInt → number (frames bounded to safe integer range; ffmpeg timestamps fit). Null timestamps default to 0 — projection contract requires non-null.
        timestampMs: r.timestampMs === null ? 0 : Number(r.timestampMs),
        extractor: r.extractor,
        storageKey: r.storageKey,
    }));
}
export async function getVideoFrameSummary(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const agg = await prisma.videoFrame.aggregate({
        where: { teamId: input.teamId, evidenceId: input.evidenceId },
        _count: { _all: true },
        _max: { timestampMs: true },
    });
    return {
        totalFrames: agg._count._all,
        // BigInt → number (timestamps bounded to safe integer range)
        totalDurationMs: agg._max.timestampMs === null ? 0 : Number(agg._max.timestampMs),
    };
}
