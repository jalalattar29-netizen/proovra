/**
 * UC-4 — local Tesseract OCR runtime capability probe.
 *
 * The canonical UC-4 OCR engine is the SYSTEM `tesseract` binary bundled into the
 * worker image (apk `tesseract-ocr` + language packs) — LOCAL, self-hosted,
 * deterministic, no network at runtime, no training on evidence. This probe mirrors
 * `ffmpeg-capability`: it resolves the binary once so callers spawn it directly, and
 * distinguishes OCR_RUNTIME_AVAILABLE from OCR_RUNTIME_UNAVAILABLE instead of
 * discovering absence via an opaque ENOENT mid-processing.
 *
 * AUD-019 — the binary being present says nothing about which language models
 * are. The probe also runs `tesseract --list-langs`, and `resolveOcrLanguages`
 * intersects the requested models with the installed ones, so the worker runs
 * (and records) only a language that actually exists on this image.
 */
import { spawn } from "node:child_process";

import type { LocalOcrCapabilityReport, ScreenOcrLanguages } from "@proovra/shared";

export type TesseractCapability =
  | {
      ok: true;
      tesseractPath: string;
      version: string | null;
      /** Installed language models (`tesseract --list-langs`), e.g. ["ara","deu","eng","osd"]. */
      languages: string[];
    }
  | { ok: false; reason: string };

/**
 * The PROOVRA locales' OCR models — what the worker image installs and asks
 * for by default. ORDER MATTERS: tesseract's first model leads recognition.
 * German first, because its Latin set is English plus ä/ö/ü/ß — English first
 * reads "Größe … prüfen" as "GroBe … priifen" (measured in the worker image by
 * scripts/smoke-ocr-languages.mjs), while German first reads all three scripts.
 */
export const DEFAULT_OCR_LANGUAGES = "deu+eng+ara";

/** The REQUESTED OCR models: UC4_OCR_LANG, else the PROOVRA locales. */
export function requestedOcrLanguages(): string {
  return process.env.UC4_OCR_LANG?.trim() || DEFAULT_OCR_LANGUAGES;
}

let cached: TesseractCapability | null = null;

function runProbe(binPath: string, args: string[]): Promise<{ code: number | null; out: string } | null> {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(binPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve(null);
    }, 5000);
    child.stdout?.on("data", (d) => (out += String(d)));
    child.stderr?.on("data", (d) => (out += String(d)));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

async function tryVersion(binPath: string): Promise<{ ok: boolean; version: string | null }> {
  const r = await runProbe(binPath, ["--version"]);
  if (!r) return { ok: false, version: null };
  // `tesseract --version` prints "tesseract 5.3.0 …" and may exit 0 or non-zero
  // across builds; treat a recognisable banner as available.
  const m = /tesseract\s+v?([0-9][0-9.]*)/i.exec(r.out);
  return { ok: r.code === 0 || Boolean(m), version: m ? m[1] : null };
}

/**
 * PURE: parse `tesseract --list-langs` output. The first line is a header
 * ("List of available languages in "/usr/share/tessdata/" (3):"); every other
 * non-empty line is one model name. Sorted, de-duplicated, bounded.
 */
export function parseTesseractLanguageList(out: string): string[] {
  const langs = new Set<string>();
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^list of available languages/i.test(line)) continue;
    if (/^[A-Za-z0-9_]{2,32}$/.test(line)) langs.add(line);
  }
  return [...langs].sort().slice(0, 256);
}

/**
 * PURE: requested ∩ installed. `requested` is tesseract's "+"-joined form
 * ("deu+eng+ara"). The effective set keeps the request order; a requested
 * model that is not installed is MISSING and is never recorded as run.
 */
export function resolveOcrLanguages(requested: string, installed: ReadonlyArray<string>): ScreenOcrLanguages {
  const wanted = [
    ...new Set(
      requested
        .split("+")
        .map((l) => l.trim())
        .filter((l) => /^[A-Za-z0-9_]{2,32}$/.test(l)),
    ),
  ];
  const have = new Set(installed);
  const effective = wanted.filter((l) => have.has(l));
  return {
    requested: wanted.length > 0 ? wanted.join("+") : null,
    effective: effective.length > 0 ? effective.join("+") : null,
    missing: wanted.filter((l) => !have.has(l)),
  };
}

/**
 * Resolve the local tesseract binary and its installed language models.
 * Honours `TESSERACT_PATH`, else `tesseract` on PATH. Cached for the process
 * lifetime after the first successful probe.
 */
export async function detectTesseractCapability(): Promise<TesseractCapability> {
  if (cached && cached.ok) return cached;
  const candidates = [process.env.TESSERACT_PATH?.trim(), "tesseract"].filter(
    (c): c is string => Boolean(c),
  );
  for (const candidate of candidates) {
    const v = await tryVersion(candidate);
    if (v.ok) {
      const list = await runProbe(candidate, ["--list-langs"]);
      cached = {
        ok: true,
        tesseractPath: candidate,
        version: v.version,
        // A failed listing is "no language known to be installed", never a guess.
        languages: list && list.code === 0 ? parseTesseractLanguageList(list.out) : [],
      };
      return cached;
    }
  }
  return { ok: false, reason: "OCR_RUNTIME_UNAVAILABLE" };
}

/**
 * AUD-019 — the bounded, credential-free report this worker publishes on its
 * heartbeat so the API states what the engine really is (never a constant).
 */
export async function probeLocalOcrCapabilityReport(now = new Date()): Promise<LocalOcrCapabilityReport> {
  const cap = await detectTesseractCapability();
  const langs = resolveOcrLanguages(requestedOcrLanguages(), cap.ok ? cap.languages : []);
  return {
    engine: "tesseract",
    available: cap.ok,
    version: cap.ok ? cap.version : null,
    installedLanguages: cap.ok ? cap.languages : [],
    requested: langs.requested,
    effective: cap.ok ? langs.effective : null,
    missing: langs.missing,
    observedAtUtc: now.toISOString(),
  };
}

/** Reset the cache (tests). */
export function _resetTesseractCapabilityCache(): void {
  cached = null;
}
