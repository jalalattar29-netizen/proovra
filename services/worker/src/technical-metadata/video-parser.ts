/**
 * Video / audio technical-metadata parser (worker side).
 *
 * Uses ffprobe (via the detected ffmpeg capability) against a temp
 * file. ffprobe needs a seekable input (the moov atom can live at the
 * end of an MP4), so we write the downloaded bytes to a temp file,
 * probe, then unlink. Never throws — degrades to UNSUPPORTED when
 * ffprobe is unavailable and FAILED on a probe error.
 *
 * Privacy: location/GPS in container metadata is reduced to a
 * `gpsPresent` boolean; raw coordinates are never emitted.
 */

import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TECHNICAL_METADATA_SCHEMA_VERSION,
  classifyMediaKind,
  unparsedMetadata,
  type MetadataStatus,
  type TechnicalMetadata,
} from "@proovra/shared-runtime/technical-metadata";
import { detectFfmpegCapability } from "../ffmpeg-capability.js";
import { logger } from "../logger.js";

const PARSER_VERSION = "ffprobe";
const PROBE_TIMEOUT_MS = 15_000;

type FfprobeJson = {
  format?: {
    format_name?: string;
    duration?: string;
    bit_rate?: string;
    tags?: Record<string, string>;
  };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    r_frame_rate?: string;
    duration?: string;
    bit_rate?: string;
    tags?: Record<string, string>;
  }>;
};

function parseFrameRate(v: string | undefined): number | null {
  if (!v || v === "0/0") return null;
  const [num, den] = v.split("/").map((x) => Number(x));
  if (!num || !den) return null;
  const fps = num / den;
  return Number.isFinite(fps) ? Math.round(fps * 1000) / 1000 : null;
}

function hasLocationTag(tags: Record<string, string> | undefined): boolean {
  if (!tags) return false;
  return Object.keys(tags).some((k) =>
    /location|gps|geo|coordinate/i.test(k),
  );
}

function runFfprobe(
  ffprobePath: string,
  filePath: string,
): Promise<FfprobeJson | null> {
  return new Promise((resolve) => {
    const proc = spawn(
      ffprobePath,
      [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        filePath,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve(null);
    }, PROBE_TIMEOUT_MS);
    proc.stdout.on("data", (d) => {
      out += String(d);
      if (out.length > 2_000_000) {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    });
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    proc.on("close", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out) as FfprobeJson);
      } catch {
        resolve(null);
      }
    });
  });
}

export async function parseVideoMetadata(
  bytes: Buffer,
  mimeType: string | null,
): Promise<TechnicalMetadata> {
  const cap = await detectFfmpegCapability();
  if (!cap.ok || !cap.ffprobePath) {
    // No ffprobe → we cannot deterministically parse container facts.
    return unparsedMetadata(mimeType, "UNSUPPORTED", PARSER_VERSION, "n/a");
  }

  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "proovra-tm-"));
    const filePath = join(dir, "media.bin");
    await writeFile(filePath, bytes);
    const probe = await runFfprobe(cap.ffprobePath, filePath);
    if (!probe) {
      return unparsedMetadata(mimeType, "FAILED", PARSER_VERSION, "n/a");
    }

    const streams = probe.streams ?? [];
    const video = streams.find((s) => s.codec_type === "video");
    const audio = streams.find((s) => s.codec_type === "audio");
    const fmt = probe.format ?? {};

    const durationSec =
      Number(fmt.duration ?? video?.duration ?? audio?.duration ?? NaN);
    const durationMs = Number.isFinite(durationSec)
      ? Math.round(durationSec * 1000)
      : null;
    const bitrate = Number(fmt.bit_rate ?? NaN);
    const gpsPresent =
      hasLocationTag(fmt.tags) ||
      streams.some((s) => hasLocationTag(s.tags));
    const creationTime =
      fmt.tags?.creation_time ?? video?.tags?.creation_time ?? null;

    const mediaKind = classifyMediaKind(mimeType);
    const hasCore = Boolean(video?.codec_name || audio?.codec_name);
    const metadataStatus: MetadataStatus = hasCore ? "PRESENT" : "PARTIAL";

    return {
      schemaVersion: TECHNICAL_METADATA_SCHEMA_VERSION,
      mediaKind: mediaKind === "AUDIO" ? "AUDIO" : "VIDEO",
      mimeType,
      parseResult: "OK",
      metadataStatus,
      parserName: "ffprobe",
      parserVersion: PARSER_VERSION,
      widthPx: video?.width ?? null,
      heightPx: video?.height ?? null,
      container: fmt.format_name ?? null,
      durationMs,
      videoCodec: video?.codec_name ?? null,
      audioCodec: audio?.codec_name ?? null,
      frameRate: parseFrameRate(video?.avg_frame_rate ?? video?.r_frame_rate),
      bitrate: Number.isFinite(bitrate) ? bitrate : null,
      creationTime: creationTime ? String(creationTime).slice(0, 64) : null,
      streamCount: streams.length,
      gpsPresent,
    };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message.slice(0, 120) : "unknown" },
      "technical_metadata.video.probe_failed",
    );
    return unparsedMetadata(mimeType, "FAILED", PARSER_VERSION, "n/a");
  } finally {
    if (dir) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}
