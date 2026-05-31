/**
 * PROOVRA Phase 3A Elite Closure — Video tracking heuristic.
 *
 * Bounded "group per-frame detections into tracks" service. Takes a
 * stream of frame-anchored Rekognition (or other) detections and
 * groups them into bounded `VideoTrack` rows + per-frame anchors.
 *
 * The grouping algorithm is intentionally simple + bounded:
 *
 *   * Detections of the same `kind` whose bboxes overlap with IoU
 *     ≥ 0.3 on consecutive frames are joined into the same track.
 *   * A track terminates when there is no overlapping detection in
 *     the next sampled frame.
 *   * Aggregate confidence is the bounded `classifyConfidence` of
 *     the mean raw confidence across detections.
 *
 * The heuristic ships as the bounded default; workspaces may swap
 * in a future ML tracker by overriding the binding (single seam
 * left open at the orchestrator layer). The bounded contract
 * stays the same.
 */

import type { PrismaClient } from "@prisma/client";

import {
  classifyConfidence,
  type BboxNormalized,
  type RedactionMethod,
  type VideoTrackKind,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../../db.js";
import {
  appendTrackDetection,
  createVideoTrack,
} from "./video-track.service.js";

export type GroupingDetectionInput = {
  frameId: string;
  frameIndex: number;
  bbox: BboxNormalized;
  rawConfidence: number;
};

export type GroupDetectionsIntoTracksInput = {
  prisma?: PrismaClient;
  teamId: string;
  evidenceId: string;
  versionId?: string | null;
  kind: VideoTrackKind;
  label?: string | null;
  method?: RedactionMethod;
  /**
   * Per-frame detections, in arbitrary order. Bounded ≤ 5000 per call.
   */
  detections: ReadonlyArray<GroupingDetectionInput>;
  authoredByUserId?: string | null;
  iouThreshold?: number;
};

export type GroupDetectionsIntoTracksResult = {
  ok: true;
  trackIds: ReadonlyArray<string>;
  trackCount: number;
};

export async function groupDetectionsIntoTracks(
  input: GroupDetectionsIntoTracksInput,
): Promise<GroupDetectionsIntoTracksResult> {
  const prisma = input.prisma ?? defaultPrisma;
  const iouThreshold = input.iouThreshold ?? 0.3;
  if (input.detections.length === 0) {
    return { ok: true, trackIds: [], trackCount: 0 };
  }
  if (input.detections.length > 5000) {
    return { ok: true, trackIds: [], trackCount: 0 };
  }
  // Sort by frame index ascending — tracks extend forward only.
  const sorted = [...input.detections].sort(
    (a, b) => a.frameIndex - b.frameIndex,
  );

  type OpenTrack = {
    trackId: string;
    startFrame: number;
    lastFrame: number;
    lastBbox: BboxNormalized;
    confidences: number[];
    detectionsAppended: number;
  };
  const open: OpenTrack[] = [];
  const closedTrackIds: string[] = [];

  for (const det of sorted) {
    let bestMatch: { idx: number; iou: number } | null = null;
    for (let i = 0; i < open.length; i++) {
      const o = open[i];
      if (det.frameIndex - o.lastFrame > 5) continue; // bounded gap
      const score = iou(o.lastBbox, det.bbox);
      if (score >= iouThreshold && (!bestMatch || score > bestMatch.iou)) {
        bestMatch = { idx: i, iou: score };
      }
    }
    if (bestMatch) {
      const o = open[bestMatch.idx];
      await appendTrackDetection({
        prisma,
        teamId: input.teamId,
        trackId: o.trackId,
        frameId: det.frameId,
        bbox: det.bbox,
        rawConfidence: det.rawConfidence,
      });
      o.lastFrame = det.frameIndex;
      o.lastBbox = det.bbox;
      o.confidences.push(det.rawConfidence);
      o.detectionsAppended++;
      // Extend the track's end frame at the DB layer so subsequent
      // bounds checks see the new range.
      await prisma.videoTrack.update({
        where: { id: o.trackId },
        data: { endFrame: det.frameIndex },
      });
      continue;
    }
    // No open track matched — open a new one.
    const meanConf = det.rawConfidence;
    const created = await createVideoTrack({
      prisma,
      teamId: input.teamId,
      evidenceId: input.evidenceId,
      versionId: input.versionId ?? null,
      kind: input.kind,
      label: input.label ?? input.kind,
      method: input.method ?? defaultMethodForKind(input.kind),
      startFrame: det.frameIndex,
      endFrame: det.frameIndex,
      confidenceBand: classifyConfidence(meanConf),
      authoredByUserId: input.authoredByUserId ?? null,
    });
    if (!created.ok) continue;
    await appendTrackDetection({
      prisma,
      teamId: input.teamId,
      trackId: created.trackId,
      frameId: det.frameId,
      bbox: det.bbox,
      rawConfidence: det.rawConfidence,
    });
    open.push({
      trackId: created.trackId,
      startFrame: det.frameIndex,
      lastFrame: det.frameIndex,
      lastBbox: det.bbox,
      confidences: [det.rawConfidence],
      detectionsAppended: 1,
    });
    closedTrackIds.push(created.trackId);
  }

  // Recompute aggregate confidence band per track.
  for (const o of open) {
    const mean =
      o.confidences.reduce((a, b) => a + b, 0) / o.confidences.length;
    await prisma.videoTrack.update({
      where: { id: o.trackId },
      data: { confidenceBand: classifyConfidence(mean) },
    });
  }

  return {
    ok: true,
    trackIds: closedTrackIds,
    trackCount: closedTrackIds.length,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests.
// ---------------------------------------------------------------------------

export function iou(a: BboxNormalized, b: BboxNormalized): number {
  const ax2 = a.x + a.width;
  const ay2 = a.y + a.height;
  const bx2 = b.x + b.width;
  const by2 = b.y + b.height;
  const interX = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
  const interY = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
  const inter = interX * interY;
  const union = a.width * a.height + b.width * b.height - inter;
  if (union <= 0) return 0;
  return inter / union;
}

function defaultMethodForKind(kind: VideoTrackKind): RedactionMethod {
  switch (kind) {
    case "FACE":
      return "BLUR";
    case "LICENSE_PLATE":
    case "TEXT":
    case "SCREEN_CONTENT":
      return "BLACKOUT";
    default:
      return "BLUR";
  }
}
