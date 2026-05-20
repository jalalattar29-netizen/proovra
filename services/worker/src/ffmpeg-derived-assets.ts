/**
 * Phase 31.20 — ffmpeg-derived asset producers.
 *
 * Three asset kinds:
 *   * VIDEO_FRAME — one representative frame from a video, output as
 *                   bounded WebP (max 256px edge).
 *   * AUDIO_WAVEFORM — waveform preview rendered as a small PNG via
 *                      ffmpeg's `showwavespic` filter.
 *   * LOW_RES_PROXY — short, low-resolution clip of the source video
 *                     (capped to 30 seconds, 480p, 5 MB) for reviewer
 *                     scrubbing without pulling the full asset.
 *
 * Hard safety rules:
 *   * Capability probe required before any spawn. If ffmpeg is absent,
 *     the producer returns `{ kind: "unsupported", reason }` and the
 *     processor persists status UNSUPPORTED (not FAILED).
 *   * Per-producer timeout (60s). The ffmpeg subprocess is killed on
 *     timeout and the producer returns FAILED.
 *   * Bounded source read — videos pull up to 50 MB, audio up to
 *     16 MB. Larger sources are still handled — the bounded range is
 *     a defense against runaway temp-file writes.
 *   * Bounded output size:
 *       VIDEO_FRAME    max 1 MB
 *       AUDIO_WAVEFORM max 500 KB
 *       LOW_RES_PROXY  max 5 MB
 *     Anything larger collapses to FAILED with `output_oversize`.
 *   * Temp files written under `os.tmpdir()/proovra-ffmpeg-*` and
 *     unlinked in a try/finally — even on crash, the OS clears
 *     the tmpdir on reboot, so worst-case impact is bounded.
 *   * NEVER mutates the original evidence bytes.
 *   * NEVER identifies people; no face / object detection. Pure
 *     pixel-level processing.
 *   * NEVER stores anything off-prem.
 *
 * Output shape:
 *   `{ ok: true, bytes, contentType, widthPx?, heightPx? }` on
 *     success.
 *   `{ kind: "unsupported", reason }` when ffmpeg is unavailable or
 *     the source MIME is wrong for the asset kind.
 *   `{ kind: "failed", reason }` for transient or structural
 *     failures.
 *
 * All reasons are short (< 80 chars), bounded vocabulary. The
 * processor renders them via the existing `last_error` column on
 * `evidence_part_derived_assets`.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  detectFfmpegCapability,
  type FfmpegCapability,
} from "./ffmpeg-capability.js";

// =============================================================================
// Constants
// =============================================================================

const FFMPEG_SUBPROCESS_TIMEOUT_MS = 60_000;

// Per-asset-kind upper-bound output sizes. Anything larger collapses
// to FAILED so we never persist a runaway derived blob.
const MAX_OUTPUT_BYTES = {
  video_frame: 1 * 1024 * 1024, // 1 MB
  audio_waveform: 512 * 1024, // 500 KB
  low_res_proxy: 5 * 1024 * 1024, // 5 MB
} as const;

// Per-asset-kind source read budget.
export const SOURCE_READ_BUDGET = {
  video_frame: 50 * 1024 * 1024,
  audio_waveform: 16 * 1024 * 1024,
  low_res_proxy: 50 * 1024 * 1024,
} as const;

// =============================================================================
// Public surface — invoked from derived-assets.processor.ts
// =============================================================================

export type FfmpegProducerInput = {
  sourceBytes: Buffer;
  sourceMimeType: string;
};

export type FfmpegProducerResult =
  | {
      status: "ok";
      bytes: Buffer;
      contentType: string;
      widthPx: number | null;
      heightPx: number | null;
      derivedSha256: string;
    }
  | { status: "unsupported"; reason: string }
  | { status: "failed"; reason: string };

/**
 * Produce a representative video frame as bounded WebP. Single
 * frame at ~10% into the source so we avoid the (often-black)
 * opening frame without seeking far enough to be slow.
 */
export async function produceVideoFrame(
  input: FfmpegProducerInput,
): Promise<FfmpegProducerResult> {
  const mt = (input.sourceMimeType ?? "").toLowerCase();
  if (!mt.startsWith("video/")) {
    return { status: "unsupported", reason: "non_video_mime" };
  }
  const cap = await detectFfmpegCapability();
  if (!cap.ok) {
    return { status: "unsupported", reason: cap.reason };
  }
  return await runFfmpeg({
    cap,
    sourceBytes: input.sourceBytes,
    args: (inFile, outFile) => [
      "-y", // overwrite output (we own the temp dir)
      "-ss",
      "00:00:01", // seek to 1s — safe default that avoids most black openers
      "-i",
      inFile,
      "-frames:v",
      "1",
      "-vf",
      "scale='min(256,iw)':-2",
      "-vcodec",
      "libwebp",
      "-q:v",
      "75",
      outFile,
    ],
    outputExt: ".webp",
    contentType: "image/webp",
    maxOutputBytes: MAX_OUTPUT_BYTES.video_frame,
    kindLabel: "video_frame",
  });
}

/**
 * Produce an audio waveform preview PNG using ffmpeg's
 * `showwavespic` filter. Bounded to 600x80px.
 */
export async function produceAudioWaveform(
  input: FfmpegProducerInput,
): Promise<FfmpegProducerResult> {
  const mt = (input.sourceMimeType ?? "").toLowerCase();
  if (!mt.startsWith("audio/") && !mt.startsWith("video/")) {
    return { status: "unsupported", reason: "non_audio_video_mime" };
  }
  const cap = await detectFfmpegCapability();
  if (!cap.ok) {
    return { status: "unsupported", reason: cap.reason };
  }
  return await runFfmpeg({
    cap,
    sourceBytes: input.sourceBytes,
    args: (inFile, outFile) => [
      "-y",
      "-i",
      inFile,
      "-filter_complex",
      "showwavespic=s=600x80:colors=#1e40af",
      "-frames:v",
      "1",
      outFile,
    ],
    outputExt: ".png",
    contentType: "image/png",
    maxOutputBytes: MAX_OUTPUT_BYTES.audio_waveform,
    kindLabel: "audio_waveform",
  });
}

/**
 * Produce a low-resolution reviewer proxy of a video source.
 * Caps:
 *   * First 30 seconds only (`-t 30`)
 *   * 480p height (`scale=-2:480`)
 *   * WebM/VP9 + Opus audio — universally supported in modern
 *     browsers, ~10x smaller than H.264 for the same quality.
 */
export async function produceLowResProxy(
  input: FfmpegProducerInput,
): Promise<FfmpegProducerResult> {
  const mt = (input.sourceMimeType ?? "").toLowerCase();
  if (!mt.startsWith("video/")) {
    return { status: "unsupported", reason: "non_video_mime" };
  }
  const cap = await detectFfmpegCapability();
  if (!cap.ok) {
    return { status: "unsupported", reason: cap.reason };
  }
  return await runFfmpeg({
    cap,
    sourceBytes: input.sourceBytes,
    args: (inFile, outFile) => [
      "-y",
      "-i",
      inFile,
      "-t",
      "30",
      "-vf",
      "scale=-2:480",
      "-c:v",
      "libvpx-vp9",
      "-b:v",
      "600k",
      "-c:a",
      "libopus",
      "-b:a",
      "64k",
      // Single-pass VP9 — faster, slightly larger than two-pass.
      "-deadline",
      "realtime",
      "-cpu-used",
      "5",
      outFile,
    ],
    outputExt: ".webm",
    contentType: "video/webm",
    maxOutputBytes: MAX_OUTPUT_BYTES.low_res_proxy,
    kindLabel: "low_res_proxy",
  });
}

// =============================================================================
// Internal helpers
// =============================================================================

type RunFfmpegInput = {
  cap: Extract<FfmpegCapability, { ok: true }>;
  sourceBytes: Buffer;
  args: (inFile: string, outFile: string) => string[];
  outputExt: string;
  contentType: string;
  maxOutputBytes: number;
  kindLabel: "video_frame" | "audio_waveform" | "low_res_proxy";
};

async function runFfmpeg(
  input: RunFfmpegInput,
): Promise<FfmpegProducerResult> {
  // Each invocation gets its own tmp dir so concurrent jobs don't
  // collide on filenames.
  let dir: string | null = null;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), "proovra-ffmpeg-"));
  } catch {
    return { status: "failed", reason: "tmpdir_unavailable" };
  }
  const inFile = path.join(dir, `in-${randomUUID()}`);
  const outFile = path.join(dir, `out-${randomUUID()}${input.outputExt}`);

  try {
    try {
      await writeFile(inFile, input.sourceBytes);
    } catch (err) {
      return {
        status: "failed",
        reason:
          err instanceof Error
            ? `tmp_write_failed:${err.message.slice(0, 60)}`
            : "tmp_write_failed",
      };
    }
    const args = input.args(inFile, outFile);
    const spawnResult = await spawnBounded(input.cap.ffmpegPath, args);
    if (!spawnResult.ok) {
      return {
        status: "failed",
        reason: `ffmpeg_${spawnResult.reason}`.slice(0, 80),
      };
    }
    // Read the output bytes, bounded.
    let outBytes: Buffer;
    try {
      outBytes = await readFile(outFile);
    } catch {
      // Most common cause: ffmpeg exited 0 without writing output
      // (rare — usually filter argument issue) or write failed.
      return { status: "failed", reason: "no_output_produced" };
    }
    if (outBytes.length === 0) {
      return { status: "failed", reason: "empty_output" };
    }
    if (outBytes.length > input.maxOutputBytes) {
      return { status: "failed", reason: "output_oversize" };
    }
    const derivedSha256 = createHash("sha256").update(outBytes).digest("hex");
    // For raster outputs (frame / waveform), we don't probe dimensions
    // explicitly — sharp would do it, but we don't want a sharp
    // dependency here. The dimensions stay null for ffmpeg-produced
    // assets; the DB column is nullable.
    return {
      status: "ok",
      bytes: outBytes,
      contentType: input.contentType,
      widthPx: null,
      heightPx: null,
      derivedSha256,
    };
  } finally {
    if (dir) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        /* leave cleanup to OS tmp sweep */
      }
    }
  }
}

/**
 * Spawn a bounded-timeout subprocess. Returns ok on exit 0, fails
 * with a bounded reason otherwise.
 */
function spawnBounded(
  command: string,
  args: string[],
): Promise<{ ok: true } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: { ok: true } | { ok: false; reason: string }) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let child;
    try {
      child = spawn(command, args, {
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (err) {
      finish({
        ok: false,
        reason:
          err instanceof Error
            ? `spawn_failed:${err.message.slice(0, 40)}`
            : "spawn_failed",
      });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish({ ok: false, reason: "subprocess_timeout" });
    }, FFMPEG_SUBPROCESS_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      finish({
        ok: false,
        reason: err.message ? `spawn_error:${err.message.slice(0, 40)}` : "spawn_error",
      });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        finish({ ok: true });
        return;
      }
      finish({
        ok: false,
        reason: signal ? `signal_${signal}` : `exit_${code ?? "unknown"}`,
      });
    });
  });
}
