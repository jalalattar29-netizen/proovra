/**
 * UC-4 — local Tesseract OCR runtime capability probe.
 *
 * The canonical UC-4 OCR engine is the SYSTEM `tesseract` binary bundled into the
 * worker image (apt `tesseract-ocr` + language packs) — LOCAL, self-hosted,
 * deterministic, no network at runtime, no training on evidence. This probe mirrors
 * `ffmpeg-capability`: it resolves the binary once so callers spawn it directly, and
 * distinguishes OCR_RUNTIME_AVAILABLE from OCR_RUNTIME_UNAVAILABLE instead of
 * discovering absence via an opaque ENOENT mid-processing.
 */
import { spawn } from "node:child_process";

export type TesseractCapability =
  | { ok: true; tesseractPath: string; version: string | null }
  | { ok: false; reason: string };

let cached: TesseractCapability | null = null;

function tryVersion(binPath: string): Promise<{ ok: boolean; version: string | null }> {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(binPath, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve({ ok: false, version: null });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve({ ok: false, version: null });
    }, 5000);
    child.stdout?.on("data", (d) => (out += String(d)));
    child.stderr?.on("data", (d) => (out += String(d)));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, version: null });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      // `tesseract --version` prints "tesseract 5.3.0 …" and may exit 0 or non-zero
      // across builds; treat a recognisable banner as available.
      const m = /tesseract\s+v?([0-9][0-9.]*)/i.exec(out);
      resolve({ ok: code === 0 || Boolean(m), version: m ? m[1] : null });
    });
  });
}

/**
 * Resolve the local tesseract binary. Honours `TESSERACT_PATH`, else `tesseract` on
 * PATH. Cached for the process lifetime after the first successful probe.
 */
export async function detectTesseractCapability(): Promise<TesseractCapability> {
  if (cached && cached.ok) return cached;
  const candidates = [process.env.TESSERACT_PATH?.trim(), "tesseract"].filter(
    (c): c is string => Boolean(c),
  );
  for (const candidate of candidates) {
    const v = await tryVersion(candidate);
    if (v.ok) {
      cached = { ok: true, tesseractPath: candidate, version: v.version };
      return cached;
    }
  }
  return { ok: false, reason: "OCR_RUNTIME_UNAVAILABLE" };
}

/** Reset the cache (tests). */
export function _resetTesseractCapabilityCache(): void {
  cached = null;
}
