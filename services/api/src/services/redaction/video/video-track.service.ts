/**
 * PROOVRA Phase 3A Elite Closure — Video track lifecycle.
 *
 * Bounded service for tracks (a tracked region across frames) and
 * the per-frame detections that anchor each track. Implements:
 *
 *   * `createVideoTrack` (operator manual) + `createVideoTrackBatch`
 *     (used by the Rekognition grouping heuristic).
 *   * `appendTrackDetection` — bounded per-frame bbox.
 *   * `decideVideoTrack` — bounded reviewer verdict that propagates
 *     to every detection across the track range.
 *   * `mergeTracks` / `splitTrack` — bounded operator actions for
 *     tracking corrections.
 *   * `propagateRangeDecision` — bounded bulk "apply this verdict
 *     to every track that overlaps frames X..Y".
 *
 * Hard rules:
 *   * Workspace-anchored.
 *   * Track state changes flow through `emitVideoTimelineEvent`
 *     so the timeline UI sees every action.
 *   * Decisions on a track do NOT mutate per-frame bboxes; they
 *     stamp the track's `state` and emit a timeline event.
 *   * NEVER mutates the original video — tracks are metadata.
 */

import type { PrismaClient } from "@prisma/client";

import {
  VIDEO_TRACK_KINDS,
  VIDEO_TRACK_STATES,
  classifyConfidence,
  isValidBboxNormalized,
  type RedactionConfidenceBand,
  type RedactionDenialReason,
  type RedactionMethod,
  type VideoTrackKind,
  type VideoTrackProjection,
  type VideoTrackState,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../../db.js";
import { emitVideoTimelineEvent } from "./video-timeline.service.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CreateVideoTrackInput = {
  prisma?: PrismaClient;
  teamId: string;
  evidenceId: string;
  versionId?: string | null;
  kind: VideoTrackKind;
  label?: string | null;
  method?: RedactionMethod;
  startFrame: number;
  endFrame: number;
  confidenceBand?: RedactionConfidenceBand;
  authoredByUserId?: string | null;
};

export type CreateVideoTrackResult =
  | { ok: true; trackId: string }
  | { ok: false; denial: RedactionDenialReason };

export type AppendTrackDetectionInput = {
  prisma?: PrismaClient;
  teamId: string;
  trackId: string;
  frameId: string;
  bbox: { x: number; y: number; width: number; height: number };
  rawConfidence: number;
};

export type DecideVideoTrackInput = {
  prisma?: PrismaClient;
  teamId: string;
  trackId: string;
  toState: Extract<VideoTrackState, "ACCEPTED" | "REJECTED" | "MODIFIED">;
  decidedByUserId: string;
  rationale?: string | null;
};

export type DecideVideoTrackResult =
  | { ok: true; state: VideoTrackState }
  | { ok: false; denial: RedactionDenialReason };

export type MergeTracksInput = {
  prisma?: PrismaClient;
  teamId: string;
  trackIds: ReadonlyArray<string>;
  actorUserId: string;
};

export type MergeTracksResult =
  | { ok: true; mergedTrackId: string; mergedSourceIds: ReadonlyArray<string> }
  | { ok: false; denial: RedactionDenialReason };

export type SplitTrackInput = {
  prisma?: PrismaClient;
  teamId: string;
  trackId: string;
  splitAfterFrame: number;
  actorUserId: string;
};

export type SplitTrackResult =
  | { ok: true; firstTrackId: string; secondTrackId: string }
  | { ok: false; denial: RedactionDenialReason };

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createVideoTrack(
  input: CreateVideoTrackInput,
): Promise<CreateVideoTrackResult> {
  if (!(VIDEO_TRACK_KINDS as ReadonlyArray<string>).includes(input.kind)) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  if (input.endFrame < input.startFrame || input.startFrame < 0) {
    return { ok: false, denial: "REGION_OUT_OF_BOUNDS" };
  }
  const prisma = input.prisma ?? defaultPrisma;
  const created = await prisma.videoTrack.create({
    data: {
      teamId: input.teamId,
      evidenceId: input.evidenceId,
      versionId: input.versionId ?? null,
      kind: input.kind,
      label: input.label?.slice(0, 80) ?? null,
      method: input.method ?? "BLUR",
      startFrame: input.startFrame,
      endFrame: input.endFrame,
      state: "SUGGESTED",
      confidenceBand: input.confidenceBand ?? "MEDIUM",
      authoredByUserId: input.authoredByUserId ?? null,
    },
    select: { id: true, startFrame: true, endFrame: true },
  });
  await emitVideoTimelineEvent({
    prisma,
    teamId: input.teamId,
    evidenceId: input.evidenceId,
    versionId: input.versionId ?? null,
    trackId: created.id,
    layer: "TRACKING",
    code: "TRACK_CREATED",
    label: input.label ?? input.kind,
    startFrame: created.startFrame,
    endFrame: created.endFrame,
    actorUserId: input.authoredByUserId ?? null,
  });
  return { ok: true, trackId: created.id };
}

export async function appendTrackDetection(
  input: AppendTrackDetectionInput,
): Promise<{ ok: true } | { ok: false; denial: RedactionDenialReason }> {
  if (!isValidBboxNormalized(input.bbox)) {
    return { ok: false, denial: "REGION_OUT_OF_BOUNDS" };
  }
  const prisma = input.prisma ?? defaultPrisma;
  const track = await prisma.videoTrack.findFirst({
    where: { id: input.trackId, teamId: input.teamId },
    select: { id: true },
  });
  if (!track) return { ok: false, denial: "VERSION_NOT_FOUND" };
  await prisma.videoTrackDetection.upsert({
    where: {
      trackId_frameId: { trackId: input.trackId, frameId: input.frameId },
    },
    create: {
      teamId: input.teamId,
      trackId: input.trackId,
      frameId: input.frameId,
      bbox: input.bbox as never,
      rawConfidence: input.rawConfidence,
    },
    update: {
      bbox: input.bbox as never,
      rawConfidence: input.rawConfidence,
    },
  });
  return { ok: true };
}

export async function decideVideoTrack(
  input: DecideVideoTrackInput,
): Promise<DecideVideoTrackResult> {
  if (!(VIDEO_TRACK_STATES as ReadonlyArray<string>).includes(input.toState)) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  const prisma = input.prisma ?? defaultPrisma;
  const track = await prisma.videoTrack.findFirst({
    where: { id: input.trackId, teamId: input.teamId },
    select: {
      id: true,
      evidenceId: true,
      versionId: true,
      startFrame: true,
      endFrame: true,
      kind: true,
      label: true,
    },
  });
  if (!track) return { ok: false, denial: "VERSION_NOT_FOUND" };
  await prisma.videoTrack.update({
    where: { id: input.trackId },
    data: {
      state: input.toState,
      decidedByUserId: input.decidedByUserId,
      decidedAtUtc: new Date(),
    },
  });
  await emitVideoTimelineEvent({
    prisma,
    teamId: input.teamId,
    evidenceId: track.evidenceId,
    versionId: track.versionId,
    trackId: input.trackId,
    layer: "APPROVAL",
    code: input.toState === "ACCEPTED" ? "TRACK_ACCEPTED" : "TRACK_REJECTED",
    label: track.label ?? track.kind,
    startFrame: track.startFrame,
    endFrame: track.endFrame,
    actorUserId: input.decidedByUserId,
    payload: {
      rationalePreview: input.rationale?.slice(0, 80) ?? null,
    },
  });
  return { ok: true, state: input.toState };
}

export async function mergeTracks(
  input: MergeTracksInput,
): Promise<MergeTracksResult> {
  if (input.trackIds.length < 2) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  if (input.trackIds.length > 50) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  const prisma = input.prisma ?? defaultPrisma;
  const tracks = await prisma.videoTrack.findMany({
    where: { id: { in: [...input.trackIds] }, teamId: input.teamId },
  });
  if (tracks.length !== input.trackIds.length) {
    return { ok: false, denial: "VERSION_NOT_FOUND" };
  }
  // Bounded merge — all tracks must be on the same evidence + kind.
  const evidenceIds = new Set(tracks.map((t: (typeof tracks)[number]) => t.evidenceId));
  const kinds = new Set(tracks.map((t: (typeof tracks)[number]) => t.kind));
  if (evidenceIds.size !== 1 || kinds.size !== 1) {
    return { ok: false, denial: "POLICY_REJECTED" };
  }
  const startFrame = Math.min(...tracks.map((t: (typeof tracks)[number]) => t.startFrame));
  const endFrame = Math.max(...tracks.map((t: (typeof tracks)[number]) => t.endFrame));
  // Pick the highest-confidence track to inherit decisions from.
  const anchor =
    tracks
      .slice()
      .sort((a: (typeof tracks)[number], b: (typeof tracks)[number]) =>
        bandRank(a.confidenceBand) > bandRank(b.confidenceBand) ? -1 : 1,
      )[0] ?? tracks[0];

  const merged = await prisma.$transaction(async (tx) => {
    const m = await tx.videoTrack.create({
      data: {
        teamId: input.teamId,
        evidenceId: anchor.evidenceId,
        versionId: anchor.versionId,
        kind: anchor.kind,
        label: anchor.label,
        method: anchor.method,
        startFrame,
        endFrame,
        state: "SUGGESTED",
        confidenceBand: anchor.confidenceBand,
        authoredByUserId: input.actorUserId,
      },
      select: { id: true },
    });
    // Re-point per-frame detections onto the merged track.
    await tx.videoTrackDetection.updateMany({
      where: { trackId: { in: [...input.trackIds] } },
      data: { trackId: m.id },
    });
    // Stamp source tracks as MERGED.
    await tx.videoTrack.updateMany({
      where: { id: { in: [...input.trackIds] } },
      data: { state: "MERGED" },
    });
    return m;
  });

  await emitVideoTimelineEvent({
    prisma,
    teamId: input.teamId,
    evidenceId: anchor.evidenceId,
    versionId: anchor.versionId,
    trackId: merged.id,
    layer: "TRACKING",
    code: "TRACK_MERGED",
    label: anchor.label ?? anchor.kind,
    startFrame,
    endFrame,
    actorUserId: input.actorUserId,
    payload: { sourceTrackIds: input.trackIds },
  });

  return {
    ok: true,
    mergedTrackId: merged.id,
    mergedSourceIds: input.trackIds,
  };
}

export async function splitTrack(
  input: SplitTrackInput,
): Promise<SplitTrackResult> {
  const prisma = input.prisma ?? defaultPrisma;
  const track = await prisma.videoTrack.findFirst({
    where: { id: input.trackId, teamId: input.teamId },
  });
  if (!track) return { ok: false, denial: "VERSION_NOT_FOUND" };
  if (
    input.splitAfterFrame < track.startFrame ||
    input.splitAfterFrame >= track.endFrame
  ) {
    return { ok: false, denial: "REGION_OUT_OF_BOUNDS" };
  }
  const result = await prisma.$transaction(async (tx) => {
    const first = await tx.videoTrack.update({
      where: { id: track.id },
      data: { endFrame: input.splitAfterFrame, state: "SPLIT" },
      select: { id: true },
    });
    const second = await tx.videoTrack.create({
      data: {
        teamId: input.teamId,
        evidenceId: track.evidenceId,
        versionId: track.versionId,
        kind: track.kind,
        label: track.label,
        method: track.method,
        startFrame: input.splitAfterFrame + 1,
        endFrame: track.endFrame,
        state: "SUGGESTED",
        confidenceBand: track.confidenceBand,
        authoredByUserId: input.actorUserId,
      },
      select: { id: true },
    });
    return { first, second };
  });
  await emitVideoTimelineEvent({
    prisma,
    teamId: input.teamId,
    evidenceId: track.evidenceId,
    versionId: track.versionId,
    trackId: result.first.id,
    layer: "TRACKING",
    code: "TRACK_SPLIT",
    label: track.label ?? track.kind,
    startFrame: track.startFrame,
    endFrame: input.splitAfterFrame,
    actorUserId: input.actorUserId,
    payload: { secondTrackId: result.second.id },
  });
  return {
    ok: true,
    firstTrackId: result.first.id,
    secondTrackId: result.second.id,
  };
}

export async function propagateRangeDecision(input: {
  prisma?: PrismaClient;
  teamId: string;
  evidenceId: string;
  startFrame: number;
  endFrame: number;
  toState: Extract<VideoTrackState, "ACCEPTED" | "REJECTED">;
  decidedByUserId: string;
  rationale?: string | null;
}): Promise<
  | { ok: true; affectedTrackIds: string[] }
  | { ok: false; denial: RedactionDenialReason }
> {
  if (input.endFrame < input.startFrame) {
    return { ok: false, denial: "REGION_OUT_OF_BOUNDS" };
  }
  const prisma = input.prisma ?? defaultPrisma;
  const tracks = await prisma.videoTrack.findMany({
    where: {
      teamId: input.teamId,
      evidenceId: input.evidenceId,
      state: "SUGGESTED",
      // Overlap test: track.startFrame ≤ input.endFrame AND
      // track.endFrame ≥ input.startFrame.
      startFrame: { lte: input.endFrame },
      endFrame: { gte: input.startFrame },
    },
    select: { id: true },
  });
  if (tracks.length === 0) {
    return { ok: true, affectedTrackIds: [] };
  }
  const ids = tracks.map((t: (typeof tracks)[number]) => t.id);
  await prisma.videoTrack.updateMany({
    where: { id: { in: ids } },
    data: {
      state: input.toState,
      decidedByUserId: input.decidedByUserId,
      decidedAtUtc: new Date(),
    },
  });
  await emitVideoTimelineEvent({
    prisma,
    teamId: input.teamId,
    evidenceId: input.evidenceId,
    versionId: null,
    trackId: null,
    layer: "DECISION",
    code: "DECISION_BULK_APPLIED",
    label: `bulk:${input.toState}`,
    startFrame: input.startFrame,
    endFrame: input.endFrame,
    actorUserId: input.decidedByUserId,
    payload: {
      toState: input.toState,
      count: ids.length,
      rationalePreview: input.rationale?.slice(0, 80) ?? null,
    },
  });
  return { ok: true, affectedTrackIds: ids };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listVideoTracksForEvidence(input: {
  prisma?: PrismaClient;
  teamId: string;
  evidenceId: string;
  state?: VideoTrackState;
}): Promise<ReadonlyArray<VideoTrackProjection>> {
  const prisma = input.prisma ?? defaultPrisma;
  const rows = await prisma.videoTrack.findMany({
    where: {
      teamId: input.teamId,
      evidenceId: input.evidenceId,
      ...(input.state ? { state: input.state } : {}),
    },
    orderBy: { startFrame: "asc" },
    include: { _count: { select: { detections: true } } },
  });
  return rows.map((r: (typeof rows)[number]) => ({
    id: r.id,
    kind: r.kind as VideoTrackKind,
    label: r.label,
    method: r.method as RedactionMethod,
    startFrame: r.startFrame,
    endFrame: r.endFrame,
    state: r.state as VideoTrackState,
    confidenceBand: r.confidenceBand as RedactionConfidenceBand,
    decisionByUserId: r.decidedByUserId,
    decidedAtUtc: r.decidedAtUtc?.toISOString() ?? null,
    detectionCount: r._count.detections,
  }));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function bandRank(band: string): number {
  switch (band) {
    case "VERY_HIGH":
      return 4;
    case "HIGH":
      return 3;
    case "MEDIUM":
      return 2;
    case "LOW":
      return 1;
    default:
      return 0;
  }
}

// Compile-time guard.
function _assertClassifyConfidenceUsed(): void {
  void classifyConfidence;
}
void _assertClassifyConfidenceUsed;
