/**
 * PROOVRA Phase 3A Elite Closure — Video timeline emitter +
 * aggregator.
 *
 * Bounded multi-layer timeline used by the video review workspace:
 *
 *   FRAME       — extracted frames + sampling cadence
 *   DETECTION   — provider-produced suggestions
 *   TRACKING    — track create / extend / merge / split
 *   APPROVAL    — accepted / rejected ranges
 *   CONFIDENCE  — recomputed bands
 *   COMMENT     — operator comments anchored to frame ranges
 *   DECISION    — bulk decisions
 *   DERIVATIVE  — render requests / completions
 *
 * Hard rules:
 *   * Bounded `layer` + `code` vocabulary from `@proovra/shared`.
 *   * NEVER PII in `payload`.
 *   * Workspace-anchored.
 *   * The aggregator is a single read — the UI never re-stitches
 *     timeline data client-side.
 */

import type { PrismaClient } from "@prisma/client";

import {
  VIDEO_TIMELINE_EVENT_CODES,
  VIDEO_TIMELINE_LAYERS,
  type VideoTimelineEventCode,
  type VideoTimelineLayer,
  type VideoTimelineProjection,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../../db.js";
import { listVideoTracksForEvidence } from "./video-track.service.js";
import { getVideoFrameSummary } from "./video-frame.service.js";

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

export type EmitVideoTimelineEventInput = {
  prisma?: PrismaClient;
  teamId: string;
  evidenceId: string;
  versionId?: string | null;
  trackId?: string | null;
  layer: VideoTimelineLayer;
  code: VideoTimelineEventCode;
  label?: string | null;
  startFrame: number;
  endFrame: number;
  startMs?: number;
  endMs?: number;
  payload?: Record<string, unknown>;
  actorUserId?: string | null;
};

export async function emitVideoTimelineEvent(
  input: EmitVideoTimelineEventInput,
): Promise<{ id: string }> {
  if (!(VIDEO_TIMELINE_LAYERS as ReadonlyArray<string>).includes(input.layer)) {
    throw new Error(`video-timeline: unknown layer ${input.layer}`);
  }
  if (
    !(VIDEO_TIMELINE_EVENT_CODES as ReadonlyArray<string>).includes(input.code)
  ) {
    throw new Error(`video-timeline: unknown code ${input.code}`);
  }
  const prisma = input.prisma ?? defaultPrisma;
  // Best-effort frame → ms mapping when ms not supplied. Bounded —
  // if no frame timestamps exist yet, we record 0..0 ms; the
  // timeline UI shows the frame range.
  let startMs = input.startMs;
  let endMs = input.endMs;
  if (startMs === undefined || endMs === undefined) {
    const frames = await prisma.videoFrame.findMany({
      where: {
        teamId: input.teamId,
        evidenceId: input.evidenceId,
        frameIndex: { in: [input.startFrame, input.endFrame] },
      },
      select: { frameIndex: true, timestampMs: true },
    });
    // BigInt → number (timestamps bounded to safe integer range; ffmpeg frames fit)
    const map = new Map(frames.map((f: (typeof frames)[number]) => [f.frameIndex, f.timestampMs === null ? null : Number(f.timestampMs)]));
    if (startMs === undefined) startMs = map.get(input.startFrame) ?? 0;
    if (endMs === undefined) endMs = map.get(input.endFrame) ?? startMs ?? 0;
  }
  const row = await prisma.videoTimelineEvent.create({
    data: {
      teamId: input.teamId,
      evidenceId: input.evidenceId,
      versionId: input.versionId ?? null,
      trackId: input.trackId ?? null,
      layer: input.layer,
      code: input.code,
      label: input.label?.slice(0, 80) ?? null,
      startFrame: input.startFrame,
      endFrame: input.endFrame,
      startMs: startMs ?? 0,
      endMs: endMs ?? 0,
      payload: (input.payload ?? null) as never,
      actorUserId: input.actorUserId ?? null,
    },
    select: { id: true },
  });
  return { id: row.id };
}

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

export async function projectVideoTimeline(input: {
  prisma?: PrismaClient;
  teamId: string;
  evidenceId: string;
}): Promise<VideoTimelineProjection> {
  const prisma = input.prisma ?? defaultPrisma;
  const summary = await getVideoFrameSummary({
    prisma,
    teamId: input.teamId,
    evidenceId: input.evidenceId,
  });
  const events = await prisma.videoTimelineEvent.findMany({
    where: { teamId: input.teamId, evidenceId: input.evidenceId },
    orderBy: [{ startMs: "asc" }, { occurredAtUtc: "asc" }],
    take: 5000,
  });
  const tracks = await listVideoTracksForEvidence({
    prisma,
    teamId: input.teamId,
    evidenceId: input.evidenceId,
  });
  const layers: VideoTimelineProjection["layers"] = {};
  for (const layer of VIDEO_TIMELINE_LAYERS) {
    layers[layer] = [];
  }
  for (const e of events) {
    const layer = e.layer as VideoTimelineLayer;
    (layers[layer] as Array<{
      id: string;
      code: VideoTimelineEventCode;
      label: string | null;
      startFrame: number;
      endFrame: number;
      startMs: number;
      endMs: number;
      trackId: string | null;
      actorUserId: string | null;
      occurredAtUtc: string;
    }>).push({
      id: e.id,
      code: e.code as VideoTimelineEventCode,
      label: e.label,
      startFrame: e.startFrame,
      endFrame: e.endFrame,
      // BigInt → number for projection contract
      startMs: Number(e.startMs),
      endMs: Number(e.endMs),
      trackId: e.trackId,
      actorUserId: e.actorUserId,
      occurredAtUtc: e.occurredAtUtc.toISOString(),
    });
  }
  return {
    schemaVersion: "PROOVRA_VIDEO_TIMELINE_V1",
    generatedAtUtc: new Date().toISOString(),
    evidenceId: input.evidenceId,
    totalFrames: summary.totalFrames,
    totalDurationMs: summary.totalDurationMs,
    layers,
    tracks,
  };
}
