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
import { produceVideoKeyframes } from "../src/ffmpeg-derived-assets.js";

let ffmpegPath: string | null = null;
let sampleMp4: Buffer | null = null;

async function makeSyntheticMp4(ffmpeg: string, seconds: number): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "uc4-mp4-"));
  const out = join(dir, "sample.mp4");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpeg, [
      "-y", "-f", "lavfi",
      "-i", `testsrc=duration=${seconds}:size=320x240:rate=10`,
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
