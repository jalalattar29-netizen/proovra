/**
 * Phase 31.19 — ffmpeg runtime capability detection.
 *
 * `ffmpeg` / `ffprobe` are system binaries (or shipped via the
 * `ffmpeg-static` Node package — see deployment docs). On
 * environments where neither is present we MUST NOT crash the
 * worker — the rest of the runtime is unaffected. This module
 * probes ffmpeg once at startup and caches the result.
 *
 * Hard rules:
 *   * NEVER throws. Detection that fails returns `{ ok: false }`.
 *   * Synchronous after first call (cached).
 *   * Used by future ffmpeg-derived asset processors (video frame,
 *     audio waveform, low-res proxy) to mark jobs UNSUPPORTED
 *     instead of repeatedly throwing.
 *   * NEVER touches evidence bytes — purely a system-binary
 *     availability check.
 *
 * Detection order:
 *   1. `ffmpeg-static` Node package (preferred — works without
 *      modifying the base Docker image).
 *   2. PATH-resolved `ffmpeg` binary (fallback for hosts that
 *      install the system ffmpeg package).
 *   3. Neither — `{ ok: false, reason: "ffmpeg_not_installed" }`.
 *
 * Returns `{ ok: true, ffmpegPath, ffprobePath }` with absolute
 * paths so callers can invoke `spawn(ffmpegPath, args)` without
 * any further resolution.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export type FfmpegCapability =
  | { ok: true; ffmpegPath: string; ffprobePath: string | null; source: "ffmpeg-static" | "system" }
  | { ok: false; reason: string };

let cached: FfmpegCapability | null = null;

const PROBE_TIMEOUT_MS = 4000;

/** Detect ffmpeg availability + cache. */
export async function detectFfmpegCapability(): Promise<FfmpegCapability> {
  if (cached !== null) return cached;

  // 1. ffmpeg-static package (preferred).
  try {
    const mod = (await import("ffmpeg-static")) as {
      default?: string | null;
    } & { path?: string | null };
    // ffmpeg-static exports the path as the default export. Some
    // builds also expose it as `.path`. Both are valid.
    const candidate =
      typeof mod.default === "string"
        ? mod.default
        : typeof mod.path === "string"
          ? mod.path
          : null;
    if (candidate && existsSync(candidate)) {
      const probeOk = await probeBinary(candidate, ["-version"]);
      if (probeOk) {
        // Try ffprobe-static too (separate package, OPTIONAL — not
        // in our dependencies today). The import is intentionally
        // routed through a runtime-resolved specifier so the TS
        // compiler doesn't try to load type declarations for a
        // package that may not be installed.
        let ffprobePath: string | null = null;
        try {
          const optionalSpecifier: string = "ffprobe-static";
          const probeMod = (await import(
            /* @vite-ignore */ optionalSpecifier
          )) as
            | { default?: { path?: string | null } | string | null; path?: string | null }
            | undefined;
          const raw =
            probeMod && typeof probeMod.default === "string"
              ? probeMod.default
              : probeMod && probeMod.default && typeof probeMod.default === "object"
                ? probeMod.default.path ?? null
                : probeMod && typeof probeMod.path === "string"
                  ? probeMod.path
                  : null;
          if (raw && existsSync(raw)) {
            const probeProbeOk = await probeBinary(raw, ["-version"]);
            if (probeProbeOk) ffprobePath = raw;
          }
        } catch {
          /* optional dep missing — ffprobe just stays null */
        }
        cached = {
          ok: true,
          ffmpegPath: candidate,
          ffprobePath,
          source: "ffmpeg-static",
        };
        return cached;
      }
    }
  } catch {
    /* package not installed — fall through to PATH probe */
  }

  // 2. System ffmpeg on PATH. We invoke `ffmpeg -version` directly;
  //    a non-zero exit or ENOENT means it's missing.
  const systemOk = await probeBinary("ffmpeg", ["-version"]);
  if (systemOk) {
    let ffprobePath: string | null = null;
    if (await probeBinary("ffprobe", ["-version"])) {
      ffprobePath = "ffprobe";
    }
    cached = {
      ok: true,
      ffmpegPath: "ffmpeg",
      ffprobePath,
      source: "system",
    };
    return cached;
  }

  cached = { ok: false, reason: "ffmpeg_not_installed" };
  return cached;
}

/**
 * Lightweight per-invocation binary probe. Spawns `<path> <args>`,
 * waits up to PROBE_TIMEOUT_MS for it to exit, and returns true on
 * exit code 0. Any failure (ENOENT, timeout, non-zero exit) returns
 * false — this is purely for capability detection.
 */
function probeBinary(path: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const child = spawn(path, args, {
        stdio: ["ignore", "ignore", "ignore"],
      });
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        finish(false);
      }, PROBE_TIMEOUT_MS);
      child.on("error", () => {
        clearTimeout(timer);
        finish(false);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        finish(code === 0);
      });
    } catch {
      finish(false);
    }
  });
}

/** Test-only — clear cached detection so a unit test can re-probe. */
export function __resetFfmpegCapabilityForTests(): void {
  cached = null;
}
