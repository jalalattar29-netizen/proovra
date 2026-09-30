/**
 * UC-4 — REAL keyframe producer integration (executes ffmpeg via ffmpeg-static).
 *
 * Generates a synthetic MP4 with ffmpeg (no customer data) and extracts bounded
 * keyframes from it with the real producer — proving actual media decoding, bounded
 * output, and deterministic offsets. Skips only if ffmpeg is genuinely unavailable
 * on the host (then keyframe RUNTIME acceptance is deferred, not faked).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectFfmpegCapability } from "../src/ffmpeg-capability.js";
import {
  getFfmpegVersion,
  pngDimensions,
  produceVideoKeyframes,
} from "../src/ffmpeg-derived-assets.js";

let ffmpegPath: string | null = null;
let sampleMp4: Buffer | null = null;

let phoneMp4: Buffer | null = null;

async function makeSyntheticMp4(ffmpeg: string, seconds: number, size = "320x240"): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "uc4-mp4-"));
  const out = join(dir, "sample.mp4");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpeg, [
      "-y", "-f", "lavfi",
      "-i", `testsrc=duration=${seconds}:size=${size}:rate=10`,
      "-pix_fmt", "yuv420p", out,
    ], { stdio: ["ignore", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))));
  });
  const bytes = await readFile(out);
  await rm(dir, { recursive: true, force: true });
  return bytes;
}

beforeAll(async () => {
  const cap = await detectFfmpegCapability();
  if (cap.ok) {
    ffmpegPath = cap.ffmpegPath;
    sampleMp4 = await makeSyntheticMp4(cap.ffmpegPath, 6);
    // A phone-shaped portrait screen recording (1080 x 2400).
    phoneMp4 = await makeSyntheticMp4(cap.ffmpegPath, 3, "1080x2400");
  } else if (process.env.CI) {
    // UC-TQ-003 — in CI the ffmpeg-static dependency MUST be installed; a
    // missing binary is a broken gate, not a reason to skip the runtime proof.
    throw new Error(`ffmpeg unavailable in CI: ${cap.reason}`);
  }
}, 60_000);

describe("UC-4 real keyframe producer (ffmpeg)", () => {
  it("extracts bounded, deterministic keyframes from a real MP4", async (ctx) => {
    if (!ffmpegPath || !sampleMp4) return ctx.skip(); // runtime deferred, not faked
    const res = await produceVideoKeyframes({
      sourceBytes: sampleMp4,
      sourceMimeType: "video/mp4",
      intervalMs: 1500,
      maxKeyframes: 10,
    });
    expect(res.status, JSON.stringify(res)).toBe("ok");
    if (res.status !== "ok") return;
    // 6s at one frame / 1.5s → ~4 keyframes.
    expect(res.keyframes.length).toBeGreaterThanOrEqual(3);
    expect(res.keyframes.length).toBeLessThanOrEqual(10);
    // Deterministic offsets by interval index.
    expect(res.keyframes.map((k) => k.offsetMs).slice(0, 3)).toEqual([0, 1500, 3000]);
    for (const k of res.keyframes) {
      expect(k.bytes.length).toBeGreaterThan(0);
      expect(k.sizeBytes).toBe(k.bytes.length);
      expect(k.derivedSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(k.contentType).toBe("image/webp");
      // Real WebP magic ("RIFF"...."WEBP").
      expect(k.bytes.subarray(0, 4).toString("latin1")).toBe("RIFF");
      expect(k.bytes.subarray(8, 12).toString("latin1")).toBe("WEBP");
    }
  }, 60_000);

  it("enforces the maxKeyframes bound (PARTIAL, never unbounded)", async (ctx) => {
    if (!ffmpegPath || !sampleMp4) return ctx.skip();
    const res = await produceVideoKeyframes({
      sourceBytes: sampleMp4,
      sourceMimeType: "video/mp4",
      intervalMs: 250, // fine sampling → would produce many
      maxKeyframes: 3,
    });
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.keyframes.length).toBe(3);
    expect(res.boundsReached).toBe(true);
  }, 60_000);

  it("DER-003: OCR reads a native-resolution rendition while the persisted review keyframe stays <=256px", async (ctx) => {
    if (!ffmpegPath || !phoneMp4) return ctx.skip();
    const res = await produceVideoKeyframes({
      sourceBytes: phoneMp4,
      sourceMimeType: "video/mp4",
      intervalMs: 1500,
      maxKeyframes: 4,
    });
    expect(res.status, JSON.stringify(res).slice(0, 200)).toBe("ok");
    if (res.status !== "ok") return;
    for (const k of res.keyframes) {
      // The OCR rendition is the full 1080-px width (under the 1600-px ceiling)…
      expect(k.ocrBytes, "an OCR rendition exists").toBeTruthy();
      expect(pngDimensions(k.ocrBytes!)).toEqual({ widthPx: 1080, heightPx: 2400 });
      expect(k.ocrWidthPx).toBe(1080);
      expect(k.ocrHeightPx).toBe(2400);
      // …and differs from the persisted thumbnail, which is a small WebP.
      expect(k.bytes.subarray(8, 12).toString("latin1")).toBe("WEBP");
      expect(k.bytes.equals(k.ocrBytes!)).toBe(false);
      // VP8/VP8L header width of the review keyframe is <= 256.
      expect(webpWidth(k.bytes)).toBeLessThanOrEqual(256);
    }
  }, 60_000);

  it("DER-005: the ffmpeg version is PROBED from the binary, not a constant", async (ctx) => {
    if (!ffmpegPath) return ctx.skip();
    const v = await getFfmpegVersion();
    expect(v).toBeTruthy();
    expect(v).not.toBe("ffmpeg-v0-phase31-20");
    // ffmpeg -version first line: "ffmpeg version <version> Copyright …"
    const probed = await new Promise<string>((resolve) => {
      let out = "";
      const child = spawn(ffmpegPath!, ["-version"], { stdio: ["ignore", "pipe", "ignore"] });
      child.stdout.on("data", (d) => (out += String(d)));
      child.on("exit", () => resolve(out));
    });
    expect(probed.split("\n")[0]).toContain(`ffmpeg version ${v}`);
  }, 30_000);

  it("rejects a non-video mime as unsupported (never FAILED)", async () => {
    const res = await produceVideoKeyframes({
      sourceBytes: Buffer.from("not a video"),
      sourceMimeType: "text/plain",
      intervalMs: 1500,
      maxKeyframes: 5,
    });
    expect(res.status).toBe("unsupported");
  });
});

/** Width from a WebP header (VP8 lossy, VP8L lossless or VP8X extended). */
function webpWidth(b: Buffer): number {
  const chunk = b.subarray(12, 16).toString("latin1");
  if (chunk === "VP8 ") return b.readUInt16LE(26) & 0x3fff;
  if (chunk === "VP8L") return 1 + (((b[22]! & 0x3f) << 8) | b[21]!);
  if (chunk === "VP8X") return 1 + b.readUIntLE(24, 3);
  return Number.NaN;
}
