/**
 * 2026-10-29 — the combined screen recording against REAL media.
 *
 * Nothing is mocked: fixtures are generated here with the worker's own ffmpeg
 * (ffmpeg-static) into a temp dir, the production `combineSegmentFiles` runs on
 * them, and every claim is checked by decoding the OUTPUT with ffmpeg:
 *
 *   A. REMUX with a real 3 s gap (+ audio): one video stream; decoded frame
 *      count = sum of the segments; per-frame decoded MD5s equal the segments'
 *      own (the original frames are kept); the gap is a timestamp jump with
 *      no frame inside it; the packet before the gap spans it (what a player
 *      shows: the last picture held); audio jumps the same way; seeking mid
 *      file and into the gap decodes the right original frame; the chapters
 *      say "No recording: 3.0 s".
 *   B. TRANSCODE across an orientation change 1080x1920 → 1920x1080 with a
 *      MISSING segment: one 1920x1920 letterboxed canvas, every frame kept at
 *      its own time (no fps resample), the missing sequence listed as a
 *      SEGMENT_MISSING gap, completeness PARTIAL with the manifest's
 *      limitations copied, seekable.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { screenRecordingSourceSetCanonical } from "@proovra/shared";

import { detectFfmpegCapability } from "../src/ffmpeg-capability.js";
import { combineSegmentFiles, type CombineSegmentFile } from "../src/combined-recording/combine-recording.js";
import { probeMediaFile, readVideoPackets, runFfmpeg } from "../src/combined-recording/media-tools.js";

let ff = "";
let dir = "";

async function gen(args: string[]): Promise<void> {
  const r = await runFfmpeg(ff, ["-hide_banner", "-nostdin", "-loglevel", "error", "-y", ...args], { timeoutMs: 30_000 });
  if (!r.ok) throw new Error(`fixture: ${r.reason} ${r.stderrTail.join(" | ")}`);
}

/** A segment of the test pattern: `seconds` long at 12 fps, optional 440 Hz audio. */
async function segment(name: string, size: string, seconds: number, opts: { audio?: boolean; offset?: number } = {}) {
  const file = path.join(dir, name);
  await gen([
    "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=12:duration=${seconds}`,
    ...(opts.audio ? ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`] : []),
    // Distinct pictures per segment: the pattern's clock is shifted by `offset`.
    "-vf", `setpts=PTS-STARTPTS,drawbox=x=0:y=0:w=40:h=40:color=${["red", "green", "blue", "yellow"][opts.offset ?? 0]}:t=fill`,
    // The fixture's rate is pinned, not inherited: from ffmpeg 7.0 `setpts`
    // drops the source's 12 fps and the MP4 muxer falls back to 25 fps CFR,
    // duplicating frames (49 for 2 s). ffmpeg-static ships 6.1 on Windows and
    // 7.0 on Linux, so without this the same test generated different inputs.
    "-r", "12",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "12",
    ...(opts.audio ? ["-c:a", "aac", "-shortest"] : []),
    file,
  ]);
  const bytes = await readFile(file);
  return { file, sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length };
}

/** Decoded frames (passthrough timing): pts seconds + MD5 of each picture. */
async function decodedFrames(file: string, extra: string[] = []): Promise<Array<{ t: number; md5: string }>> {
  const lines: string[] = [];
  const r = await runFfmpeg(
    ff,
    ["-hide_banner", "-nostdin", "-loglevel", "error", ...extra, "-i", file, "-map", "0:v:0", "-fps_mode", "passthrough", "-f", "framemd5", "-"],
    { timeoutMs: 60_000, onStdoutLine: (l) => lines.push(l) },
  );
  if (!r.ok) throw new Error(`decode: ${r.reason}`);
  let tb = 1;
  const out: Array<{ t: number; md5: string }> = [];
  for (const l of lines) {
    const m = /^#tb 0: (\d+)\/(\d+)/.exec(l);
    if (m) tb = Number(m[1]) / Number(m[2]);
    if (l.startsWith("#")) continue;
    const f = l.split(",").map((s) => s.trim());
    if (f.length >= 6 && f[0] === "0") out.push({ t: Number(f[2]) * tb, md5: f[5]! });
  }
  return out;
}

/** `ffmpeg -i out -f null -`: the decoder's own frame count and end time. */
async function nullDecode(file: string): Promise<{ frames: number; timeSec: number }> {
  const lines: string[] = [];
  const r = await runFfmpeg(ff, ["-hide_banner", "-nostdin", "-i", file, "-map", "0:v:0", "-fps_mode", "passthrough", "-f", "null", "-"], {
    timeoutMs: 60_000,
    onStderrLine: (l) => lines.push(l),
  });
  if (!r.ok) throw new Error(`null decode: ${r.reason}`);
  const last = lines.filter((l) => /frame=\s*\d+/.test(l)).pop() ?? "";
  const frames = Number(/frame=\s*(\d+)/.exec(last)?.[1] ?? NaN);
  const t = /time=(\d+):(\d+):([0-9.]+)/.exec(last);
  return { frames, timeSec: t ? Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]) : NaN };
}

async function chapterTitles(file: string): Promise<string[]> {
  const lines: string[] = [];
  await runFfmpeg(ff, ["-hide_banner", "-nostdin", "-i", file], {
    timeoutMs: 30_000,
    acceptExitCodes: [0, 1],
    onStderrLine: (l) => lines.push(l),
  });
  const titles: string[] = [];
  let inChapter = false;
  for (const l of lines) {
    if (/^\s*Chapter #/.test(l)) inChapter = true;
    else if (/^\s*Stream #/.test(l)) inChapter = false;
    const m = /^\s*title\s*:\s*(.*)$/.exec(l);
    if (inChapter && m) titles.push(m[1]!.trim());
  }
  return titles;
}

beforeAll(async () => {
  const cap = await detectFfmpegCapability();
  if (!cap.ok) throw new Error(`ffmpeg is required for this suite: ${cap.reason}`);
  ff = cap.ffmpegPath;
  dir = await mkdtemp(path.join(os.tmpdir(), "proovra-combine-test-"));
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const MANIFEST = {
  partIndex: 9,
  sha256: "f".repeat(64),
  schemaVersion: "PROOVRA_SCREEN_CAPTURE_CONTINUOUS_MANIFEST_V2",
};

describe("REMUX — one encoding, a real 3 s gap, audio", () => {
  let outcome: Awaited<ReturnType<typeof combineSegmentFiles>>;
  let segs: CombineSegmentFile[];
  const work = () => path.join(dir, "remux");

  beforeAll(async () => {
    await mkdir(work(), { recursive: true });
    const prevDir = dir;
    dir = work();
    const s0 = await segment("segment-0.mp4", "360x640", 2, { audio: true, offset: 0 });
    const s1 = await segment("segment-1.mp4", "360x640", 2, { audio: true, offset: 1 });
    const s2 = await segment("segment-2.mp4", "360x640", 2, { audio: true, offset: 2 });
    dir = prevDir;
    segs = [
      { partIndex: 0, sequence: 0, ...s0, versionId: null, startedAtOffsetMs: 0, durationMs: 2000 },
      { partIndex: 1, sequence: 1, ...s1, versionId: null, startedAtOffsetMs: 2000, durationMs: 2000 },
      // The recorder says segment 2 began 7 s in: 3 s with no recording.
      { partIndex: 2, sequence: 2, ...s2, versionId: "v-2", startedAtOffsetMs: 7000, durationMs: 2000 },
    ];
    outcome = await combineSegmentFiles({
      ffmpegPath: ff,
      ffmpegVersion: "test",
      workDir: work(),
      deadlineAt: Date.now() + 60_000,
      manifest: { ...MANIFEST, recordedSegmentCount: 3, totalDurationMs: 9000, sessionCompleteness: "INTERRUPTED_SESSION", limitations: ["BROADCAST_PAUSED"] },
      segments: segs,
      missingInRecord: [],
      generation: 1,
    });
  });

  it("remuxes into ONE video stream on the original canvas, labelled DERIVED", async () => {
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.lineage.mode).toBe("REMUX");
    expect(outcome.lineage.canvas).toEqual({ widthPx: 360, heightPx: 640, letterboxed: false });
    const probe = await probeMediaFile(ff, outcome.outputFile, 30_000);
    expect(probe?.videoStreamCount).toBe(1);
    expect(probe?.audioStreamCount).toBe(1);
    expect(probe?.video?.codec).toBe("h264");
    expect(outcome.lineage.sources.map((s) => s.partIndex)).toEqual([0, 1, 2]);
    expect(outcome.lineage.sourceSetSha256).toBe(
      createHash("sha256").update(screenRecordingSourceSetCanonical(segs)).digest("hex"),
    );
    expect(outcome.lineage.statement).toMatch(/^DERIVED review copy/);
    expect((await stat(outcome.outputFile)).size).toBe(outcome.sizeBytes);
  });

  it("keeps every ORIGINAL frame: decoded count and per-frame MD5s equal the segments'", async () => {
    if (outcome.status !== "ok") throw new Error("no output");
    const perSegment = await Promise.all(segs.map((s) => decodedFrames(s.file)));
    const out = await decodedFrames(outcome.outputFile);
    expect(perSegment.map((f) => f.length)).toEqual([24, 24, 24]);
    expect(out.length).toBe(72);
    expect(out.map((f) => f.md5)).toEqual(perSegment.flat().map((f) => f.md5));
    const nul = await nullDecode(outcome.outputFile);
    expect(nul.frames).toBe(72);
    expect(outcome.lineage.output.videoPackets).toBe(72);
  });

  it("preserves the gap: no frame between 4.0 s and 7.0 s, the picture before it is held across it", async () => {
    if (outcome.status !== "ok") throw new Error("no output");
    const out = await decodedFrames(outcome.outputFile);
    const inGap = out.filter((f) => f.t > 4.0 + 1e-6 && f.t < 7.0 - 1e-6);
    // The last frame of segment 1 is at 47/12 = 3.917 s; segment 2 starts at 7.000 s.
    expect(inGap.filter((f) => f.t > 3.95)).toEqual([]);
    expect(out[47]!.t).toBeCloseTo(47 / 12, 2);
    expect(out[48]!.t).toBeCloseTo(7.0, 2);
    // Timestamps are continuous inside each segment (1/12 s steps).
    for (let i = 1; i < out.length; i += 1) {
      if (i === 48) continue;
      expect(out[i]!.t - out[i - 1]!.t).toBeCloseTo(1 / 12, 3);
    }
    // What a player does across the gap: the MP4 sample before it lasts until
    // the next one, so the last recorded picture is shown (never a new one).
    const pk = await readVideoPackets(ff, outcome.outputFile, { timeoutMs: 30_000, keepTimeline: true });
    const [num, den] = pk!.timeBase;
    expect((pk!.durations[47]! * num) / den).toBeCloseTo(7.0 - 47 / 12, 2);
    // The audio track jumps over the same gap (no samples invented).
    const audio: number[] = [];
    await runFfmpeg(ff, ["-hide_banner", "-nostdin", "-loglevel", "error", "-i", outcome.outputFile, "-map", "0:a:0", "-c", "copy", "-f", "framecrc", "-"], {
      timeoutMs: 30_000,
      onStdoutLine: (l) => {
        const f = l.split(",").map((s) => s.trim());
        if (!l.startsWith("#") && f.length >= 6) audio.push(Number(f[2]) / 48000);
      },
    });
    const jumps = audio.slice(1).map((t, i) => t - audio[i]!).filter((d) => d > 0.5);
    expect(jumps).toHaveLength(1);
    expect(jumps[0]!).toBeGreaterThan(2.9);
    const nul = await nullDecode(outcome.outputFile);
    expect(nul.timeSec).toBeGreaterThan(8.8);
    expect(nul.timeSec).toBeLessThan(9.2);
  });

  it("records the gap in lineage and as a chapter", async () => {
    if (outcome.status !== "ok") throw new Error("no output");
    expect(outcome.lineage.gaps).toEqual([
      { atMs: 4000, durationMs: 3000, cause: "TIMELINE_GAP", missingSequences: [], limitations: ["BROADCAST_PAUSED"] },
    ]);
    expect(outcome.lineage.sources.map((s) => s.combinedStartMs)).toEqual([0, 2000, 7000]);
    expect(outcome.lineage.completeness).toBe("PARTIAL");
    expect(outcome.lineage.limitations).toContain("BROADCAST_PAUSED");
    expect(await chapterTitles(outcome.outputFile)).toEqual([
      "Recording (segment 0)",
      "Recording (segment 1)",
      "No recording: 3.0 s",
      "Recording (segment 2)",
    ]);
  });

  it("is seekable: mid-file and into the gap decode the right ORIGINAL frame", async () => {
    if (outcome.status !== "ok") throw new Error("no output");
    const seg2 = await decodedFrames(segs[2]!.file);
    const seg1 = await decodedFrames(segs[1]!.file);
    const mid = await decodedFrames(outcome.outputFile, ["-ss", "7.5"]);
    expect(mid[0]!.md5).toBe(seg2[6]!.md5);
    const early = await decodedFrames(outcome.outputFile, ["-ss", "3.0"]);
    expect(early[0]!.md5).toBe(seg1[12]!.md5);
    // Seeking into the gap lands on the first frame recorded after it.
    const gap = await decodedFrames(outcome.outputFile, ["-ss", "5.0"]);
    expect(gap[0]!.md5).toBe(seg2[0]!.md5);
  });
});

describe("TRANSCODE — orientation change 1080x1920 → 1920x1080 and a missing segment", () => {
  let outcome: Awaited<ReturnType<typeof combineSegmentFiles>>;
  const work = () => path.join(dir, "transcode");

  beforeAll(async () => {
    await mkdir(work(), { recursive: true });
    const prevDir = dir;
    dir = work();
    const p0 = await segment("segment-0.mp4", "1080x1920", 1, { offset: 0 });
    const p1 = await segment("segment-1.mp4", "1080x1920", 1, { offset: 1 });
    // segment 2 never reached PROOVRA.
    const l3 = await segment("segment-3.mp4", "1920x1080", 1, { offset: 3 });
    dir = prevDir;
    outcome = await combineSegmentFiles({
      ffmpegPath: ff,
      ffmpegVersion: "test",
      workDir: work(),
      deadlineAt: Date.now() + 120_000,
      manifest: {
        ...MANIFEST,
        recordedSegmentCount: 4,
        totalDurationMs: 4000,
        sessionCompleteness: "INTERRUPTED_SESSION",
        limitations: ["SEGMENT_UPLOAD_LOST", "ORIENTATION_CHANGED_DURING_CAPTURE"],
      },
      segments: [
        { partIndex: 0, sequence: 0, ...p0, versionId: null, startedAtOffsetMs: 0, durationMs: 1000 },
        { partIndex: 1, sequence: 1, ...p1, versionId: null, startedAtOffsetMs: 1000, durationMs: 1000 },
        { partIndex: 3, sequence: 3, ...l3, versionId: null, startedAtOffsetMs: 3000, durationMs: 1000 },
      ],
      missingInRecord: [],
      generation: 2,
    });
  });

  it("re-encodes onto ONE letterboxed 1920x1920 canvas — no crop, no stretch", async () => {
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.lineage.mode).toBe("TRANSCODE");
    expect(outcome.lineage.canvas).toEqual({ widthPx: 1920, heightPx: 1920, letterboxed: true });
    expect(outcome.lineage.limitations).toEqual(
      expect.arrayContaining(["SEGMENT_UPLOAD_LOST", "ORIENTATION_CHANGED_DURING_CAPTURE", "COMBINE_LETTERBOXED_TO_ONE_CANVAS", "COMBINE_RE_ENCODED", "COMBINE_SEGMENTS_MISSING"]),
    );
    const probe = await probeMediaFile(ff, outcome.outputFile, 30_000);
    expect(probe?.videoStreamCount).toBe(1);
    expect(probe?.audioStreamCount).toBe(0);
    expect([probe?.video?.displayWidthPx, probe?.video?.displayHeightPx]).toEqual([1920, 1920]);
    expect(outcome.lineage.sources.map((s) => [s.widthPx, s.heightPx])).toEqual([[1080, 1920], [1080, 1920], [1920, 1080]]);
  });

  it("keeps every frame at its own time (no fps resample) and keeps the missing segment's time as a gap", async () => {
    if (outcome.status !== "ok") throw new Error("no output");
    const out = await decodedFrames(outcome.outputFile);
    expect(out.length).toBe(36);
    expect((await nullDecode(outcome.outputFile)).frames).toBe(36);
    expect(out[23]!.t).toBeCloseTo(23 / 12, 2);
    expect(out[24]!.t).toBeCloseTo(3.0, 2);
    expect(out.filter((f) => f.t > 2.0 && f.t < 3.0 - 1e-6)).toEqual([]);
    expect(outcome.lineage.gaps).toEqual([
      {
        atMs: 2000,
        durationMs: 1000,
        cause: "SEGMENT_MISSING",
        missingSequences: [2],
        limitations: ["SEGMENT_UPLOAD_LOST", "ORIENTATION_CHANGED_DURING_CAPTURE"],
      },
    ]);
    expect(outcome.lineage.completeness).toBe("PARTIAL");
    expect(await chapterTitles(outcome.outputFile)).toContain("No recording: 1.0 s");
  });

  it("is seekable after the orientation change", async () => {
    if (outcome.status !== "ok") throw new Error("no output");
    const tail = await decodedFrames(outcome.outputFile, ["-ss", "3.5"]);
    const full = await decodedFrames(outcome.outputFile);
    // 3.5 s is frame 6 of the landscape segment (combined frame 24 + 6).
    expect(tail.length).toBe(6);
    expect(tail[0]!.md5).toBe(full[30]!.md5);
  });
});

describe("fail closed", () => {
  it("a segment that is not a video is FAILED, never combined", async () => {
    const work = path.join(dir, "corrupt");
    await mkdir(work, { recursive: true });
    await writeFile(path.join(work, "segment-0.mp4"), Buffer.from("not a video"));
    await writeFile(path.join(work, "segment-1.mp4"), Buffer.from("still not a video"));
    const res = await combineSegmentFiles({
      ffmpegPath: ff,
      ffmpegVersion: "test",
      workDir: work,
      deadlineAt: Date.now() + 30_000,
      manifest: { ...MANIFEST, recordedSegmentCount: 2, totalDurationMs: 2000, sessionCompleteness: "COMPLETE_SESSION", limitations: [] },
      segments: [0, 1].map((i) => ({
        partIndex: i, sequence: i, sha256: "0".repeat(64), sizeBytes: 11, versionId: null,
        startedAtOffsetMs: i * 1000, durationMs: 1000, file: path.join(work, `segment-${i}.mp4`),
      })),
      missingInRecord: [],
      generation: 1,
    });
    expect(res).toEqual({ status: "failed", reason: "segment_unreadable:0" });
  });
});
