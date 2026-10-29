/**
 * 2026-10-29 — THE combine: verified ORIGINAL segment files on local disk →
 * ONE DERIVED MP4 on local disk, plus the lineage that explains it.
 *
 * Inputs are files the caller already streamed from storage and verified
 * against their sealed digests (combined-recording.handler.ts). This module
 * never reads storage, the database or the network.
 *
 *   1. Probe every segment (stream header, packet count, parameter sets).
 *   2. Plan (pure, `planScreenRecordingCombine`):
 *        * one compatible group (same codec/profile/pixel format/size/rotation,
 *          byte-identical parameter sets, same audio layout) ⇒ REMUX: the
 *          original packets are copied, never re-encoded;
 *        * otherwise ⇒ TRANSCODE each segment onto ONE canvas (the largest
 *          displayed width × height across segments): letterboxed, never
 *          cropped or stretched, frame timing passed through (no fps resample);
 *        * the timeline: each segment starts where the recorder said it started
 *          relative to the previous one (manifest offsets), never earlier than
 *          the previous segment's real end. A real gap stays a gap in time — no
 *          frame is invented to fill it (a player holds the last picture; the
 *          chapters and the lineage say "No recording: X s").
 *   3. Join with the concat demuxer (`-c copy`), chapters + DERIVED labelling
 *      embedded, `+faststart` for streaming playback.
 *   4. Verify the output: one video stream, the planned canvas, and the exact
 *      number of video packets the sources held (frame conservation).
 *
 * Fail closed: anything unexpected is a FAILED outcome with a bounded reason;
 * nothing partial is ever returned as a combined recording.
 */

import { createHash } from "node:crypto";
import { writeFile, stat, rm } from "node:fs/promises";
import * as path from "node:path";

import {
  SCREEN_RECORDING_COMBINE_BOUNDS,
  SCREEN_RECORDING_COMBINE_STATEMENT,
  SCREEN_RECORDING_COMBINE_TRANSFORMATION,
  screenRecordingGapLabel,
  screenRecordingSourceSetCanonical,
  type ScreenRecordingCombineCompleteness,
  type ScreenRecordingCombineLineage,
  type ScreenRecordingCombineMode,
  type ScreenRecordingCombineSource,
  type ScreenRecordingGap,
} from "@proovra/shared";

import {
  probeMediaFile,
  readParameterSets,
  readVideoPackets,
  runFfmpeg,
  type MediaProbe,
} from "./media-tools.js";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** What the continuity manifest (digest-verified) says about the session. */
export type CombineManifestFacts = {
  partIndex: number;
  sha256: string;
  schemaVersion: string;
  recordedSegmentCount: number | null;
  totalDurationMs: number | null;
  sessionCompleteness: string;
  limitations: string[];
};

/** One held, verified segment file. */
export type CombineSegmentFile = {
  partIndex: number;
  sequence: number;
  sha256: string;
  sizeBytes: number;
  versionId: string | null;
  startedAtOffsetMs: number;
  durationMs: number;
  file: string;
};

/** A segment after probing (the planner's input). */
export type ProbedSegment = Omit<CombineSegmentFile, "file"> & {
  probe: MediaProbe & { video: NonNullable<MediaProbe["video"]> };
  packets: number;
  parameterSetsSha256: string | null;
  /** The segment's real length (container duration; manifest duration when absent). */
  actualDurationMs: number;
};

export type CombinePlan = {
  mode: ScreenRecordingCombineMode;
  modeReason: string;
  canvas: { widthPx: number; heightPx: number; letterboxed: boolean };
  /** Per segment (sequence order): its start on the combined timeline. */
  combinedStartMs: number[];
  /** Per segment except the last: the concat `duration` (its slot until the next segment starts). */
  slotMs: number[];
  /** Per segment: scale needed to fit the canvas (TRANSCODE only). */
  scaleToFit: boolean[];
  audio: "ALL" | "NONE" | "MIXED";
  gaps: ScreenRecordingGap[];
  completeness: ScreenRecordingCombineCompleteness;
  limitations: string[];
  chapters: Array<{ startMs: number; endMs: number; title: string }>;
};

// ---------------------------------------------------------------------------
// Plan (pure)
// ---------------------------------------------------------------------------

function even(n: number): number {
  return n % 2 === 0 ? n : n + 1;
}

/** The REMUX compatibility key: segments with equal keys can share one sample entry. */
export function remuxCompatibilityKey(s: ProbedSegment): string | null {
  const v = s.probe.video;
  if (!s.parameterSetsSha256) return null; // cannot prove the sample entries match
  if (s.probe.videoStreamCount !== 1 || s.probe.audioStreamCount > 1) return null;
  const a = s.probe.audio;
  return [
    v.codec,
    v.profile ?? "-",
    v.pixFmt ?? "-",
    `${v.codedWidthPx}x${v.codedHeightPx}`,
    `r${v.rotationDeg}`,
    s.parameterSetsSha256,
    a ? `${a.codec}/${a.sampleRateHz ?? "-"}/${a.channels ?? "-"}` : "no-audio",
  ].join("|");
}

export function planScreenRecordingCombine(input: {
  manifest: CombineManifestFacts;
  segments: ReadonlyArray<ProbedSegment>;
  /** Sequences the manifest lists that the record does not hold. */
  missingInRecord: ReadonlyArray<number>;
  maxCanvasSidePx?: number;
  reportGapMinMs?: number;
}): CombinePlan {
  const B = SCREEN_RECORDING_COMBINE_BOUNDS;
  const maxSide = input.maxCanvasSidePx ?? B.maxCanvasSidePx;
  const reportMin = input.reportGapMinMs ?? B.reportGapMinMs;
  const segs = [...input.segments].sort((a, b) => a.sequence - b.sequence);
  if (segs.length === 0) throw new Error("plan_without_segments");
  const manifestLimitations = [...input.manifest.limitations];
  const limitations = [...manifestLimitations];

  // ---- mode ----------------------------------------------------------------
  const keys = segs.map(remuxCompatibilityKey);
  const oneGroup = keys.every((k) => k !== null && k === keys[0]);
  const mode: ScreenRecordingCombineMode = oneGroup ? "REMUX" : "TRANSCODE";
  const modeReason = oneGroup
    ? "All segments share one encoding (codec, profile, pixel format, size, rotation, parameter sets, audio layout): original packets copied."
    : keys.some((k) => k === null)
      ? "A segment's encoding parameters could not be proven identical: segments re-encoded onto one canvas."
      : `Segments differ in encoding (${new Set(keys).size} groups): segments re-encoded onto one canvas.`;

  // ---- canvas --------------------------------------------------------------
  let cw: number;
  let ch: number;
  if (mode === "REMUX") {
    cw = segs[0]!.probe.video.displayWidthPx;
    ch = segs[0]!.probe.video.displayHeightPx;
  } else {
    cw = even(Math.min(maxSide, Math.max(...segs.map((s) => s.probe.video.displayWidthPx))));
    ch = even(Math.min(maxSide, Math.max(...segs.map((s) => s.probe.video.displayHeightPx))));
  }
  const scaleToFit = segs.map(
    (s) => mode === "TRANSCODE" && (s.probe.video.displayWidthPx > cw || s.probe.video.displayHeightPx > ch),
  );
  const letterboxed =
    mode === "TRANSCODE" &&
    segs.some((s) => s.probe.video.displayWidthPx !== cw || s.probe.video.displayHeightPx !== ch);
  if (letterboxed) limitations.push("COMBINE_LETTERBOXED_TO_ONE_CANVAS");
  if (scaleToFit.some(Boolean)) limitations.push("COMBINE_SCALED_DOWN_TO_CANVAS_BOUND");
  if (mode === "TRANSCODE") limitations.push("COMBINE_RE_ENCODED");

  // ---- audio ---------------------------------------------------------------
  const withAudio = segs.filter((s) => s.probe.audio !== null).length;
  const audio: CombinePlan["audio"] = withAudio === 0 ? "NONE" : withAudio === segs.length ? "ALL" : "MIXED";
  if (audio === "MIXED") limitations.push("COMBINE_SILENCE_FOR_SEGMENTS_WITHOUT_AUDIO");

  // ---- timeline + gaps -----------------------------------------------------
  const held = new Set(segs.map((s) => s.sequence));
  const missingAll = new Set<number>(input.missingInRecord);
  const recorded = input.manifest.recordedSegmentCount;
  const lastHeld = segs[segs.length - 1]!.sequence;
  const maxSeq = Math.max(lastHeld, ...(recorded != null ? [recorded - 1] : []), ...input.missingInRecord);
  for (let q = 0; q <= maxSeq; q += 1) if (!held.has(q)) missingAll.add(q);

  const gaps: ScreenRecordingGap[] = [];
  const combinedStartMs: number[] = [0];
  const slotMs: number[] = [];
  let overlapClamped = false;
  for (let i = 1; i < segs.length; i += 1) {
    const prev = segs[i - 1]!;
    const cur = segs[i]!;
    const delta = cur.startedAtOffsetMs - prev.startedAtOffsetMs;
    const slot = Math.max(delta, prev.actualDurationMs);
    if (delta < prev.actualDurationMs - 1) overlapClamped = true;
    slotMs.push(slot);
    combinedStartMs.push(combinedStartMs[i - 1]! + slot);
    const gapMs = slot - prev.actualDurationMs;
    const between: number[] = [];
    for (let q = prev.sequence + 1; q < cur.sequence; q += 1) between.push(q);
    if (between.length > 0 || gapMs >= reportMin) {
      gaps.push({
        atMs: combinedStartMs[i - 1]! + prev.actualDurationMs,
        durationMs: Math.max(0, Math.round(gapMs)),
        cause: between.length > 0 ? "SEGMENT_MISSING" : "TIMELINE_GAP",
        missingSequences: between,
        limitations: manifestLimitations,
      });
    }
  }
  if (overlapClamped) limitations.push("COMBINE_OVERLAP_CLAMPED_TO_REAL_DURATION");
  const first = segs[0]!;
  if (first.sequence > 0) {
    const missing: number[] = [];
    for (let q = 0; q < first.sequence; q += 1) missing.push(q);
    gaps.unshift({
      atMs: null,
      durationMs: first.startedAtOffsetMs > 0 ? first.startedAtOffsetMs : null,
      cause: "HEAD_MISSING",
      missingSequences: missing,
      limitations: manifestLimitations,
    });
  }
  const tailMissing: number[] = [];
  for (let q = lastHeld + 1; q <= maxSeq; q += 1) tailMissing.push(q);
  if (tailMissing.length > 0) {
    const last = segs[segs.length - 1]!;
    const lastEnd = last.startedAtOffsetMs + last.actualDurationMs;
    const total = input.manifest.totalDurationMs;
    gaps.push({
      atMs: null,
      durationMs: total != null && total > lastEnd ? Math.round(total - lastEnd) : null,
      cause: "TAIL_MISSING",
      missingSequences: tailMissing,
      limitations: manifestLimitations,
    });
  }

  const completeness: ScreenRecordingCombineCompleteness =
    missingAll.size > 0 || input.manifest.sessionCompleteness !== "COMPLETE_SESSION" ? "PARTIAL" : "COMPLETE";
  if (missingAll.size > 0) limitations.push("COMBINE_SEGMENTS_MISSING");

  // ---- chapters: every held segment and every in-timeline gap --------------
  const chapters: CombinePlan["chapters"] = [];
  for (let i = 0; i < segs.length; i += 1) {
    const start = combinedStartMs[i]!;
    const end = start + segs[i]!.actualDurationMs;
    chapters.push({ startMs: Math.round(start), endMs: Math.round(end), title: `Recording (segment ${segs[i]!.sequence})` });
    const gap = gaps.find((g) => g.atMs !== null && Math.abs(g.atMs - end) < 1);
    if (gap && i + 1 < segs.length && combinedStartMs[i + 1]! > end) {
      chapters.push({
        startMs: Math.round(end),
        endMs: Math.round(combinedStartMs[i + 1]!),
        title: screenRecordingGapLabel(gap),
      });
    }
  }

  return {
    mode,
    modeReason,
    canvas: { widthPx: cw, heightPx: ch, letterboxed },
    combinedStartMs,
    slotMs,
    scaleToFit,
    audio,
    gaps,
    completeness,
    limitations: [...new Set(limitations)],
    chapters,
  };
}

/** PURE — the ffconcat list (relative file names, resolved against the list's directory). */
export function buildConcatList(files: ReadonlyArray<string>, slotMs: ReadonlyArray<number>): string {
  const lines = ["ffconcat version 1.0"];
  files.forEach((f, i) => {
    if (!/^[A-Za-z0-9._-]+$/.test(f)) throw new Error("concat_unsafe_file_name");
    lines.push(`file ${f}`);
    if (i < slotMs.length) lines.push(`duration ${(slotMs[i]! / 1000).toFixed(3)}`);
  });
  return lines.join("\n") + "\n";
}

function metaEscape(s: string): string {
  return s.replace(/[\\=;#\n]/g, (c) => (c === "\n" ? " " : `\\${c}`));
}

/** PURE — FFMETADATA1 with the DERIVED labelling and the chapters. */
export function buildChapterMetadata(plan: Pick<CombinePlan, "chapters">, title: string): string {
  const out = [";FFMETADATA1", `title=${metaEscape(title)}`, `comment=${metaEscape(SCREEN_RECORDING_COMBINE_STATEMENT)}`];
  for (const c of plan.chapters) {
    if (!(c.endMs > c.startMs)) continue;
    out.push("[CHAPTER]", "TIMEBASE=1/1000", `START=${c.startMs}`, `END=${c.endMs}`, `title=${metaEscape(c.title)}`);
  }
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

export type CombineOutcome =
  | {
      status: "ok";
      outputFile: string;
      sizeBytes: number;
      widthPx: number;
      heightPx: number;
      durationMs: number | null;
      plan: CombinePlan;
      lineage: ScreenRecordingCombineLineage;
    }
  | { status: "failed" | "unsupported"; reason: string };

function remaining(deadlineAt: number, capMs?: number): number {
  const left = deadlineAt - Date.now();
  return Math.max(0, capMs ? Math.min(capMs, left) : left);
}

const TRANSCODE_ENCODER = {
  videoCodec: "libx264",
  preset: "veryfast",
  crf: 20,
  maxrate: "8M",
  bufsize: "16M",
  pixFmt: "yuv420p",
  keyframeEverySeconds: 2,
  audioCodec: "aac",
  audioBitrate: "128k",
  audioSampleRateHz: 48000,
  audioChannels: 2,
  timescale: 90000,
} as const;

export async function combineSegmentFiles(input: {
  ffmpegPath: string;
  ffmpegVersion: string | null;
  workDir: string;
  deadlineAt: number;
  manifest: CombineManifestFacts;
  segments: ReadonlyArray<CombineSegmentFile>;
  missingInRecord: ReadonlyArray<number>;
  generation: number;
  maxOutputBytes?: number;
}): Promise<CombineOutcome> {
  const B = SCREEN_RECORDING_COMBINE_BOUNDS;
  const maxOutputBytes = input.maxOutputBytes ?? B.maxOutputBytes;
  const ff = input.ffmpegPath;
  const ordered = [...input.segments].sort((a, b) => a.sequence - b.sequence);
  if (ordered.length < 2) return { status: "unsupported", reason: "fewer_than_two_segments" };

  // 1. Probe.
  const probed: ProbedSegment[] = [];
  for (const s of ordered) {
    const probe = await probeMediaFile(ff, s.file, remaining(input.deadlineAt, B.probeTimeoutMs));
    if (!probe || !probe.video) return { status: "failed", reason: `segment_unreadable:${s.sequence}` };
    const packets = await readVideoPackets(ff, s.file, { timeoutMs: remaining(input.deadlineAt, B.probeTimeoutMs) });
    if (!packets || packets.count === 0) return { status: "failed", reason: `segment_no_video_packets:${s.sequence}` };
    const parameterSetsSha256 = await readParameterSets(
      ff,
      s.file,
      probe.video.codec,
      path.join(input.workDir, `ps-${s.sequence}.bin`),
      remaining(input.deadlineAt, B.probeTimeoutMs),
    );
    probed.push({
      partIndex: s.partIndex,
      sequence: s.sequence,
      sha256: s.sha256,
      sizeBytes: s.sizeBytes,
      versionId: s.versionId,
      startedAtOffsetMs: s.startedAtOffsetMs,
      durationMs: s.durationMs,
      probe: probe as ProbedSegment["probe"],
      packets: packets.count,
      parameterSetsSha256,
      actualDurationMs: probe.durationMs ?? s.durationMs,
    });
  }

  // 2. Plan.
  const plan = planScreenRecordingCombine({
    manifest: input.manifest,
    segments: probed,
    missingInRecord: input.missingInRecord,
  });

  // 3. Inputs to the join: originals (REMUX) or normalised intermediates (TRANSCODE).
  const joinFiles: string[] = [];
  const fileByName = new Map(ordered.map((s) => [s.sequence, s.file]));
  if (plan.mode === "REMUX") {
    for (const s of probed) joinFiles.push(path.basename(fileByName.get(s.sequence)!));
    for (const s of probed) {
      if (path.dirname(fileByName.get(s.sequence)!) !== input.workDir) {
        return { status: "failed", reason: "segment_outside_work_dir" };
      }
    }
  } else {
    const paramSets = new Set<string | null>();
    for (let i = 0; i < probed.length; i += 1) {
      const s = probed[i]!;
      const name = `norm-${String(s.sequence).padStart(4, "0")}.mp4`;
      const out = path.join(input.workDir, name);
      const { widthPx: cw, heightPx: chh } = plan.canvas;
      const vf = [
        plan.scaleToFit[i] ? `scale=${cw}:${chh}:force_original_aspect_ratio=decrease:force_divisible_by=2` : null,
        `pad=${cw}:${chh}:(ow-iw)/2:(oh-ih)/2:color=black`,
        "setsar=1",
      ]
        .filter(Boolean)
        .join(",");
      const needSilence = plan.audio === "MIXED" && !s.probe.audio;
      const args = [
        "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
        "-i", fileByName.get(s.sequence)!,
        ...(needSilence
          ? ["-f", "lavfi", "-t", (s.actualDurationMs / 1000).toFixed(3), "-i",
             `anullsrc=r=${TRANSCODE_ENCODER.audioSampleRateHz}:cl=stereo`]
          : []),
        "-map", "0:v:0",
        ...(plan.audio === "NONE" ? [] : needSilence ? ["-map", "1:a:0"] : ["-map", "0:a:0"]),
        "-vf", vf,
        "-fps_mode", "passthrough",
        "-c:v", TRANSCODE_ENCODER.videoCodec,
        "-preset", TRANSCODE_ENCODER.preset,
        "-crf", String(TRANSCODE_ENCODER.crf),
        "-maxrate", TRANSCODE_ENCODER.maxrate,
        "-bufsize", TRANSCODE_ENCODER.bufsize,
        "-pix_fmt", TRANSCODE_ENCODER.pixFmt,
        "-force_key_frames", `expr:gte(t,n_forced*${TRANSCODE_ENCODER.keyframeEverySeconds})`,
        ...(plan.audio === "NONE"
          ? ["-an"]
          : ["-c:a", TRANSCODE_ENCODER.audioCodec, "-b:a", TRANSCODE_ENCODER.audioBitrate,
             "-ar", String(TRANSCODE_ENCODER.audioSampleRateHz), "-ac", String(TRANSCODE_ENCODER.audioChannels)]),
        "-video_track_timescale", String(TRANSCODE_ENCODER.timescale),
        "-map_metadata", "-1",
        "-fs", String(maxOutputBytes),
        out,
      ];
      const res = await runFfmpeg(ff, args, { timeoutMs: remaining(input.deadlineAt) });
      if (!res.ok) return { status: "failed", reason: `transcode_failed:${s.sequence}:${res.reason}`.slice(0, 80) };
      const pk = await readVideoPackets(ff, out, { timeoutMs: remaining(input.deadlineAt, B.probeTimeoutMs) });
      // Frame conservation per segment: passthrough timing re-encodes every
      // source frame exactly once — never drops, never duplicates.
      if (!pk || pk.count !== s.packets) {
        return { status: "failed", reason: `transcode_frame_count_mismatch:${s.sequence}` };
      }
      const ps = await readParameterSets(ff, out, "h264", path.join(input.workDir, `nps-${s.sequence}.bin`),
        remaining(input.deadlineAt, B.probeTimeoutMs));
      paramSets.add(ps);
      joinFiles.push(name);
    }
    if (paramSets.size !== 1 || paramSets.has(null)) return { status: "failed", reason: "normalised_parameter_sets_differ" };
  }

  // 4. Join (copy) with the planned timeline, chapters and DERIVED labelling.
  const listFile = path.join(input.workDir, "concat.ffconcat");
  const metaFile = path.join(input.workDir, "chapters.ffmeta");
  const outputFile = path.join(input.workDir, "combined.mp4");
  await writeFile(listFile, buildConcatList(joinFiles, plan.slotMs), "utf8");
  await writeFile(
    metaFile,
    buildChapterMetadata(plan, `DERIVED combined screen recording (generation ${input.generation})`),
    "utf8",
  );
  const join = await runFfmpeg(
    ff,
    [
      "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
      "-f", "concat", "-safe", "0", "-i", listFile,
      "-i", metaFile,
      "-map", "0:v:0",
      ...(plan.audio === "NONE" ? [] : ["-map", "0:a:0"]),
      "-map_metadata", "1",
      "-map_chapters", "1",
      "-c", "copy",
      "-movflags", "+faststart",
      "-fs", String(maxOutputBytes),
      outputFile,
    ],
    { timeoutMs: remaining(input.deadlineAt) },
  );
  if (!join.ok) return { status: "failed", reason: `join_failed:${join.reason}`.slice(0, 80) };

  // 5. Verify.
  let sizeBytes: number;
  try {
    sizeBytes = (await stat(outputFile)).size;
  } catch {
    return { status: "failed", reason: "no_output_produced" };
  }
  // `-fs` stops writing at the limit and still exits 0: reaching it is failure.
  if (sizeBytes <= 0 || sizeBytes >= maxOutputBytes) return { status: "failed", reason: "output_oversize" };
  const outProbe = await probeMediaFile(ff, outputFile, remaining(input.deadlineAt, B.probeTimeoutMs));
  if (!outProbe?.video || outProbe.videoStreamCount !== 1) return { status: "failed", reason: "output_not_single_video" };
  if (outProbe.video.displayWidthPx !== plan.canvas.widthPx || outProbe.video.displayHeightPx !== plan.canvas.heightPx) {
    return { status: "failed", reason: "output_canvas_mismatch" };
  }
  const outPackets = await readVideoPackets(ff, outputFile, { timeoutMs: remaining(input.deadlineAt, B.probeTimeoutMs) });
  const expectedPackets = probed.reduce((n, s) => n + s.packets, 0);
  if (!outPackets || outPackets.count !== expectedPackets) {
    return { status: "failed", reason: "output_frame_count_mismatch" };
  }

  // Intermediates are not needed past this point; the caller removes the dir.
  for (const f of [listFile, metaFile]) await rm(f, { force: true }).catch(() => undefined);

  const sources: ScreenRecordingCombineSource[] = probed.map((s, i) => ({
    partIndex: s.partIndex,
    sequence: s.sequence,
    sha256: s.sha256,
    sizeBytes: s.sizeBytes,
    versionId: s.versionId,
    startedAtOffsetMs: s.startedAtOffsetMs,
    durationMs: s.durationMs,
    combinedStartMs: Math.round(plan.combinedStartMs[i]!),
    videoPackets: s.packets,
    widthPx: s.probe.video.displayWidthPx,
    heightPx: s.probe.video.displayHeightPx,
    videoCodec: s.probe.video.codec,
    hasAudio: s.probe.audio !== null,
  }));

  const lineage: ScreenRecordingCombineLineage = {
    schema: "PROOVRA_SCREEN_RECORDING_COMBINE_V1",
    transformation: SCREEN_RECORDING_COMBINE_TRANSFORMATION,
    generation: input.generation,
    tools: { ffmpeg: input.ffmpegVersion },
    mode: plan.mode,
    modeReason: plan.modeReason,
    canvas: plan.canvas,
    encoder: plan.mode === "TRANSCODE" ? { ...TRANSCODE_ENCODER } : null,
    manifest: {
      partIndex: input.manifest.partIndex,
      sha256: input.manifest.sha256,
      schemaVersion: input.manifest.schemaVersion,
      recordedSegmentCount: input.manifest.recordedSegmentCount,
    },
    sources,
    sourceSetSha256: createHash("sha256").update(screenRecordingSourceSetCanonical(sources)).digest("hex"),
    gaps: plan.gaps,
    completeness: plan.completeness,
    limitations: plan.limitations,
    output: { durationMs: outProbe.durationMs, videoPackets: outPackets.count, chapters: plan.chapters.length },
    statement: SCREEN_RECORDING_COMBINE_STATEMENT,
  };

  return {
    status: "ok",
    outputFile,
    sizeBytes,
    widthPx: plan.canvas.widthPx,
    heightPx: plan.canvas.heightPx,
    durationMs: outProbe.durationMs,
    plan,
    lineage,
  };
}
