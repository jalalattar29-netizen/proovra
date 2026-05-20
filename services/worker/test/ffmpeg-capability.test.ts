/**
 * Phase 31.19 — ffmpeg capability detection unit tests.
 *
 * Hard contracts under test:
 *   * NEVER throws — failure surfaces as `{ ok: false, reason }`.
 *   * On hosts WITHOUT ffmpeg installed (CI, most dev boxes), the
 *     detection completes within the probe timeout and returns
 *     `{ ok: false }`.
 *   * Cached after the first call.
 */

import { describe, expect, it, beforeEach } from "vitest";

import {
  detectFfmpegCapability,
  __resetFfmpegCapabilityForTests,
} from "../src/ffmpeg-capability.js";

describe("Phase 31.19 — ffmpeg capability detection", () => {
  beforeEach(() => {
    __resetFfmpegCapabilityForTests();
  });

  it("never throws — returns a bounded discriminated union", async () => {
    let threw = false;
    try {
      const r = await detectFfmpegCapability();
      expect(r).toBeDefined();
      expect(typeof r.ok).toBe("boolean");
      if (r.ok) {
        expect(typeof r.ffmpegPath).toBe("string");
        expect(r.source === "ffmpeg-static" || r.source === "system").toBe(true);
      } else {
        expect(typeof r.reason).toBe("string");
        // The reason string is bounded (no user input, no PII).
        expect(r.reason.length).toBeLessThan(120);
      }
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  it("caches the result across calls", async () => {
    const first = await detectFfmpegCapability();
    const second = await detectFfmpegCapability();
    // Object identity equality — cached, not re-probed.
    expect(first).toBe(second);
  });

  it("reason is one of the bounded codes when unavailable", async () => {
    const r = await detectFfmpegCapability();
    if (!r.ok) {
      // Today the only NOT-found code is ffmpeg_not_installed. If a
      // package import fails partway, we still treat it as not
      // installed (the cache stores the final reason).
      expect(r.reason).toMatch(/^ffmpeg_not_installed$|^ffmpeg_unavailable:/);
    }
  });
});
