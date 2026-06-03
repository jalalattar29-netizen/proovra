/**
 * PROOVRA Phase 3A Elite Closure — Video tracking verification manifest.
 *
 * Bounded shape for the verification package's
 * `video-tracking-manifest.json` entry. One row per evidence with
 * aggregate track + decision counts and bounded per-kind breakdown.
 *
 * Hard rules:
 *   * NEVER per-track geometry, NEVER per-frame bytes.
 *   * Workspace-anchored.
 *   * Offline-verifiable counts only.
 */
import { prisma as defaultPrisma } from "../../../db.js";
export async function buildVideoTrackingVerificationEntry(input) {
    const prisma = input.prisma ?? defaultPrisma;
    const tracks = await prisma.videoTrack.findMany({
        where: {
            teamId: input.teamId,
            evidenceId: input.evidenceId,
            ...(input.versionId === undefined ? {} : { versionId: input.versionId }),
        },
        select: { kind: true, state: true },
    });
    const totalFrames = await prisma.videoFrame.count({
        where: { teamId: input.teamId, evidenceId: input.evidenceId },
    });
    const perKind = {};
    let accepted = 0;
    let rejected = 0;
    for (const t of tracks) {
        perKind[t.kind] =
            (perKind[t.kind] ?? 0) + 1;
        if (t.state === "ACCEPTED")
            accepted++;
        if (t.state === "REJECTED")
            rejected++;
    }
    return {
        evidenceId: input.evidenceId,
        versionId: input.versionId ?? null,
        totalFrames,
        totalTracks: tracks.length,
        acceptedTracks: accepted,
        rejectedTracks: rejected,
        perTrackKind: perKind,
    };
}
