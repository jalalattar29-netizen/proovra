/**
 * 2026-10-29 — bounded ffmpeg primitives for the combined screen recording.
 *
 * There is no ffprobe in the worker image path we can rely on (ffmpeg-static
 * ships ffmpeg only; `ffprobe-static` is not a dependency), so every fact is
 * read from ffmpeg itself:
 *
 *   * probeMediaFile     — `ffmpeg -i <file>` stream header (stderr), parsed.
 *   * readVideoPackets   — `-map 0:v:0 -c copy -f framecrc -` (no decode): one
 *                          line per packet with its pts/duration in the
 *                          stream time base. Counting is exact and cheap.
 *   * readParameterSets  — the first packet in Annex-B (mp4toannexb inserts
 *                          the SPS/PPS(/VPS) from the sample entry), hashed:
 *                          two segments only REMUX together when these match.
 *
 * Every spawn is argv-only (no shell), drains stderr, and is killed at its
 * deadline. Nothing here reads or writes outside the paths it is given.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";

export type SpawnOutcome =
  | { ok: true; code: number; stderrTail: string[] }
  | { ok: false; reason: string; code: number | null; stderrTail: string[] };

const STDERR_TAIL_LINES = 40;

/**
 * Run ffmpeg once. `timeoutMs` is a hard kill. `acceptExitCodes` lets a probe
 * (`ffmpeg -i` with no output exits 1 by design) count as completed.
 */
export function runFfmpeg(
  ffmpegPath: string,
  args: ReadonlyArray<string>,
  opts: {
    timeoutMs: number;
    onStderrLine?: (line: string) => void;
    onStdoutLine?: (line: string) => void;
    acceptExitCodes?: ReadonlyArray<number>;
  },
): Promise<SpawnOutcome> {
  const accept = opts.acceptExitCodes ?? [0];
  return new Promise((resolve) => {
    let settled = false;
    const tail: string[] = [];
    const finish = (r: SpawnOutcome) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    if (!(opts.timeoutMs > 0)) {
      finish({ ok: false, reason: "deadline_exceeded", code: null, stderrTail: [] });
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(ffmpegPath, [...args], {
        stdio: ["ignore", opts.onStdoutLine ? "pipe" : "ignore", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      finish({
        ok: false,
        reason: `spawn_failed:${err instanceof Error ? err.message.slice(0, 40) : "unknown"}`,
        code: null,
        stderrTail: [],
      });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish({ ok: false, reason: "subprocess_timeout", code: null, stderrTail: tail.slice() });
    }, opts.timeoutMs);
    const lineReader = (cb: ((line: string) => void) | undefined, keepTail: boolean) => {
      let carry = "";
      return {
        push(d: Buffer | string) {
          const lines = (carry + String(d)).split(/\r?\n|\r/);
          carry = (lines.pop() ?? "").slice(-8192);
          for (const line of lines) {
            if (keepTail && line.trim()) {
              tail.push(line.slice(0, 400));
              if (tail.length > STDERR_TAIL_LINES) tail.shift();
            }
            cb?.(line);
          }
        },
        flush() {
          if (!carry) return;
          if (keepTail && carry.trim()) tail.push(carry.slice(0, 400));
          cb?.(carry);
          carry = "";
        },
      };
    };
    const err = lineReader(opts.onStderrLine, true);
    const out = lineReader(opts.onStdoutLine, false);
    child.stderr?.on("data", (d: Buffer | string) => err.push(d));
    child.stdout?.on("data", (d: Buffer | string) => out.push(d));
    child.on("error", (e) => {
      clearTimeout(timer);
      finish({ ok: false, reason: `spawn_error:${e.message.slice(0, 40)}`, code: null, stderrTail: tail.slice() });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      err.flush();
      out.flush();
      if (code !== null && accept.includes(code)) {
        finish({ ok: true, code, stderrTail: tail.slice() });
        return;
      }
      finish({
        ok: false,
        reason: signal ? `signal_${signal}` : `exit_${code ?? "unknown"}`,
        code,
        stderrTail: tail.slice(),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

export type MediaProbe = {
  durationMs: number | null;
  video: {
    codec: string;
    profile: string | null;
    pixFmt: string | null;
    /** Coded size as stored. */
    codedWidthPx: number;
    codedHeightPx: number;
    /** Rotation from the display matrix, normalised to 0/90/180/270. */
    rotationDeg: number;
    /** Size as displayed (after rotation). */
    displayWidthPx: number;
    displayHeightPx: number;
    fps: number | null;
  } | null;
  audio: { codec: string; sampleRateHz: number | null; channels: string | null } | null;
  videoStreamCount: number;
  audioStreamCount: number;
  otherStreamCount: number;
  formatName: string | null;
};

/** PURE — parse `ffmpeg -i <file>` stderr for input #0. */
export function parseFfmpegInputHeader(lines: ReadonlyArray<string>): MediaProbe | null {
  let seenInput = false;
  let formatName: string | null = null;
  let durationMs: number | null = null;
  let video: MediaProbe["video"] = null;
  let audio: MediaProbe["audio"] = null;
  let videoStreamCount = 0;
  let audioStreamCount = 0;
  let otherStreamCount = 0;
  let lastStreamWasFirstVideo = false;
  for (const raw of lines) {
    const line = raw.trim();
    const input = /^Input #0, ([^,]+(?:,[^,]+)*), from /.exec(line);
    if (input) {
      seenInput = true;
      formatName = input[1]!.slice(0, 80);
      continue;
    }
    if (/^Input #[1-9]/.test(line) || /^Output #/.test(line)) break;
    if (!seenInput) continue;
    const dur = /^Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(line);
    if (dur) {
      durationMs = Math.round((Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])) * 1000);
      continue;
    }
    const stream = /^Stream #0:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: (Video|Audio|Data|Subtitle|Attachment): (.*)$/.exec(line);
    if (stream) {
      lastStreamWasFirstVideo = false;
      const kind = stream[1]!;
      const rest = stream[2]!;
      if (kind === "Video") {
        videoStreamCount += 1;
        if (!video) {
          const codec = /^(\w+)/.exec(rest)?.[1] ?? "unknown";
          const profile = /^\w+ \(([^)]+)\)/.exec(rest)?.[1] ?? null;
          const size = /, (\d{2,5})x(\d{2,5})(?:[ ,]|$)/.exec(rest);
          const pix = /\), ([a-z0-9_]+)(?:\(|,)/.exec(rest)?.[1] ?? /, ([a-z]+[0-9a-z_]*p[0-9a-z_]*)(?:\(|,)/.exec(rest)?.[1] ?? null;
          const fps = /, ([0-9.]+) fps/.exec(rest);
          if (!size) return null;
          const w = Number(size[1]);
          const h = Number(size[2]);
          video = {
            codec,
            profile: profile && !profile.includes("/") ? profile : null,
            pixFmt: pix,
            codedWidthPx: w,
            codedHeightPx: h,
            rotationDeg: 0,
            displayWidthPx: w,
            displayHeightPx: h,
            fps: fps ? Number(fps[1]) : null,
          };
          lastStreamWasFirstVideo = true;
        }
      } else if (kind === "Audio") {
        audioStreamCount += 1;
        if (!audio) {
          audio = {
            codec: /^(\w+)/.exec(rest)?.[1] ?? "unknown",
            sampleRateHz: Number(/, (\d+) Hz/.exec(rest)?.[1] ?? NaN) || null,
            channels: /Hz, ([a-z0-9.() ]+?),/.exec(rest)?.[1] ?? null,
          };
        }
      } else {
        otherStreamCount += 1;
      }
      continue;
    }
    if (lastStreamWasFirstVideo && video) {
      const rot = /(?:displaymatrix: rotation of|rotate\s*:)\s*(-?[0-9.]+)/.exec(line);
      if (rot) {
        // The display matrix states the counter-clockwise correction; only the
        // quarter turn matters for the displayed size.
        const deg = ((Math.round(Number(rot[1]) / 90) * 90) % 360 + 360) % 360;
        video.rotationDeg = deg;
        if (deg === 90 || deg === 270) {
          video.displayWidthPx = video.codedHeightPx;
          video.displayHeightPx = video.codedWidthPx;
        }
      }
    }
  }
  if (!seenInput) return null;
  return { durationMs, video, audio, videoStreamCount, audioStreamCount, otherStreamCount, formatName };
}

export async function probeMediaFile(
  ffmpegPath: string,
  file: string,
  timeoutMs: number,
): Promise<MediaProbe | null> {
  const lines: string[] = [];
  const res = await runFfmpeg(ffmpegPath, ["-hide_banner", "-nostdin", "-i", file], {
    timeoutMs,
    // `ffmpeg -i` with no output exits 1 by design; the header is what we read.
    acceptExitCodes: [0, 1],
    onStderrLine: (l) => {
      if (lines.length < 400) lines.push(l);
    },
  });
  if (!res.ok) return null;
  return parseFfmpegInputHeader(lines);
}

// ---------------------------------------------------------------------------
// Packets (no decode)
// ---------------------------------------------------------------------------

export type VideoPacketTimeline = {
  /** Stream time base as [num, den]. */
  timeBase: [number, number];
  count: number;
  firstPts: number | null;
  lastPts: number | null;
  /** pts and duration of every packet, in time-base ticks (bounded by the caller's budget). */
  pts: number[];
  durations: number[];
};

/** PURE — parse `-f framecrc` lines for stream 0. */
export function parseFramecrc(lines: ReadonlyArray<string>, keepTimeline: boolean): VideoPacketTimeline | null {
  let tb: [number, number] | null = null;
  const pts: number[] = [];
  const durations: number[] = [];
  let count = 0;
  let firstPts: number | null = null;
  let lastPts: number | null = null;
  for (const line of lines) {
    if (line.startsWith("#")) {
      const m = /^#tb 0: (\d+)\/(\d+)/.exec(line);
      if (m) tb = [Number(m[1]), Number(m[2])];
      continue;
    }
    const f = line.split(",").map((s) => s.trim());
    if (f.length < 6 || f[0] !== "0") continue;
    const p = Number(f[2]);
    const d = Number(f[3]);
    if (!Number.isFinite(p)) continue;
    count += 1;
    if (firstPts === null) firstPts = p;
    lastPts = p;
    if (keepTimeline) {
      pts.push(p);
      durations.push(Number.isFinite(d) ? d : 0);
    }
  }
  if (!tb) return null;
  return { timeBase: tb, count, firstPts, lastPts, pts, durations };
}

export async function readVideoPackets(
  ffmpegPath: string,
  file: string,
  opts: { timeoutMs: number; keepTimeline?: boolean },
): Promise<VideoPacketTimeline | null> {
  const lines: string[] = [];
  let header: string[] = [];
  let count = 0;
  const keep = opts.keepTimeline === true;
  const res = await runFfmpeg(
    ffmpegPath,
    ["-hide_banner", "-nostdin", "-loglevel", "error", "-i", file, "-map", "0:v:0", "-c", "copy", "-f", "framecrc", "-"],
    {
      timeoutMs: opts.timeoutMs,
      onStdoutLine: (l) => {
        if (l.startsWith("#")) {
          if (header.length < 32) header.push(l);
          return;
        }
        count += 1;
        // A count-only read keeps at most two lines (first and latest).
        if (keep) lines.push(l);
        else if (lines.length === 0) lines.push(l);
        else lines[1] = l;
      },
    },
  );
  if (!res.ok) return null;
  const parsed = parseFramecrc([...header, ...lines], keep);
  header = [];
  if (!parsed) return null;
  return { ...parsed, count };
}

// ---------------------------------------------------------------------------
// Parameter sets (the REMUX compatibility proof)
// ---------------------------------------------------------------------------

/** PURE — split Annex-B into NAL units (without start codes). */
export function splitAnnexB(bytes: Buffer): Buffer[] {
  const units: Buffer[] = [];
  let i = 0;
  let start = -1;
  while (i + 3 <= bytes.length) {
    const sc3 = bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1;
    if (sc3) {
      if (start >= 0) {
        let end = i;
        if (end > start && bytes[end - 1] === 0) end -= 1; // 4-byte start code
        units.push(bytes.subarray(start, end));
      }
      i += 3;
      start = i;
      continue;
    }
    i += 1;
  }
  if (start >= 0 && start < bytes.length) units.push(bytes.subarray(start));
  return units.filter((u) => u.length > 0);
}

/**
 * PURE — the digest of the parameter-set NAL units (H.264 SPS/PPS, HEVC
 * VPS/SPS/PPS) in the order they occur, or null when there are none.
 */
export function parameterSetsDigest(annexB: Buffer, codec: "h264" | "hevc"): string | null {
  const keep = codec === "h264" ? [7, 8] : [32, 33, 34];
  const h = createHash("sha256");
  let n = 0;
  for (const u of splitAnnexB(annexB)) {
    const type = codec === "h264" ? u[0]! & 0x1f : (u[0]! >> 1) & 0x3f;
    if (!keep.includes(type)) continue;
    h.update(Buffer.from([0, 0, 0, 1]));
    h.update(u);
    n += 1;
  }
  return n > 0 ? h.digest("hex") : null;
}

export async function readParameterSets(
  ffmpegPath: string,
  file: string,
  codec: string,
  scratchFile: string,
  timeoutMs: number,
): Promise<string | null> {
  if (codec !== "h264" && codec !== "hevc") return null;
  try {
    const res = await runFfmpeg(
      ffmpegPath,
      [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-i",
        file,
        "-map",
        "0:v:0",
        "-c:v",
        "copy",
        "-bsf:v",
        codec === "h264" ? "h264_mp4toannexb" : "hevc_mp4toannexb",
        "-frames:v",
        "1",
        "-f",
        codec,
        scratchFile,
      ],
      { timeoutMs },
    );
    if (!res.ok) return null;
    const bytes = await readFile(scratchFile);
    return parameterSetsDigest(bytes, codec);
  } catch {
    return null;
  } finally {
    await rm(scratchFile, { force: true }).catch(() => undefined);
  }
}
