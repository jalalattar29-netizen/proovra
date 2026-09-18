/**
 * UC-4 — the canonical LOCAL Tesseract OcrProvider adapter.
 *
 * Implements the shared `OcrProvider` interface with the system `tesseract` binary
 * (LOCAL / self-hosted / deterministic; NO network, NO training on evidence). It runs
 * tesseract in TSV mode over ONE bounded keyframe image file and parses the output
 * into ordered text regions with geometry. All parsing is a PURE function
 * (`parseTesseractTsv`) so the OCR-to-observation logic is fully unit-testable
 * without the binary; only the spawn/execution needs the runtime.
 *
 * Safety: bounded subprocess timeout, no shell (argv spawn — no injection), safe temp
 * arguments, Unicode-preserving (no translation, no semantic rewriting), confidence
 * only when tesseract actually returns it. OCR text is UNTRUSTED DATA — never executed.
 */
import { spawn } from "node:child_process";

import type { OcrProvider, OcrRegion, OcrExtractResult } from "@proovra/shared";

import { detectTesseractCapability } from "./tesseract-capability.js";

const OCR_TIMEOUT_MS = 30_000;
/** Bound the number of regions returned per keyframe (defence against pathological input). */
export const MAX_OCR_REGIONS_PER_FRAME = 2000;

/**
 * PURE: parse tesseract TSV output into ordered OCR regions. Words (level 5) are
 * grouped into their source line (block/paragraph/line), ordered by vertical
 * position; each line becomes one region with union bbox and mean confidence. No
 * network, no side effects — the deterministic heart of the adapter.
 */
export function parseTesseractTsv(tsv: string): OcrRegion[] {
  const lines = tsv.split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split("\t");
  const col = (name: string) => header.indexOf(name);
  const iLevel = col("level");
  const iBlock = col("block_num");
  const iPar = col("par_num");
  const iLine = col("line_num");
  const iLeft = col("left");
  const iTop = col("top");
  const iWidth = col("width");
  const iHeight = col("height");
  const iConf = col("conf");
  const iText = col("text");
  if ([iLevel, iLeft, iTop, iText].some((x) => x < 0)) return [];

  type Word = { left: number; top: number; width: number; height: number; conf: number; text: string };
  const byLine = new Map<string, Word[]>();
  for (let r = 1; r < lines.length; r += 1) {
    const cells = lines[r].split("\t");
    if (cells.length <= iText) continue;
    if (Number(cells[iLevel]) !== 5) continue; // words only
    const text = cells[iText] ?? "";
    if (text.trim() === "") continue;
    const conf = Number(cells[iConf]);
    if (Number.isFinite(conf) && conf < 0) continue; // tesseract uses -1 for non-text
    const key = `${cells[iBlock]}/${cells[iPar]}/${cells[iLine]}`;
    const w: Word = {
      left: Number(cells[iLeft]) || 0,
      top: Number(cells[iTop]) || 0,
      width: Number(cells[iWidth]) || 0,
      height: Number(cells[iHeight]) || 0,
      conf: Number.isFinite(conf) ? conf : 0,
      text,
    };
    const list = byLine.get(key) ?? [];
    list.push(w);
    byLine.set(key, list);
  }

  const regions: Array<OcrRegion & { _top: number }> = [];
  for (const words of byLine.values()) {
    words.sort((a, b) => a.left - b.left);
    const text = words.map((w) => w.text).join(" ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const left = Math.min(...words.map((w) => w.left));
    const top = Math.min(...words.map((w) => w.top));
    const right = Math.max(...words.map((w) => w.left + w.width));
    const bottom = Math.max(...words.map((w) => w.top + w.height));
    const meanConf = words.reduce((s, w) => s + w.conf, 0) / words.length;
    regions.push({
      text,
      kind: "TEXT",
      rowOrder: 0,
      bbox: { top, left, width: right - left, height: bottom - top },
      confidence: Number.isFinite(meanConf) ? Math.round(meanConf) / 100 : null,
      _top: top,
    });
  }

  regions.sort((a, b) => a._top - b._top);
  return regions.slice(0, MAX_OCR_REGIONS_PER_FRAME).map((r, i) => {
    const { _top, ...region } = r;
    void _top;
    return { ...region, rowOrder: i };
  });
}

function spawnTesseractTsv(bin: string, imageRef: string, lang: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    let child;
    try {
      // argv spawn (no shell) — imageRef is a caller-controlled LOCAL temp path.
      child = spawn(bin, [imageRef, "stdout", "-l", lang, "--psm", "6", "tsv"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error("ocr_spawn_failed"));
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      reject(new Error("ocr_timeout"));
    }, OCR_TIMEOUT_MS);
    child.stdout?.on("data", (d) => (out += d.toString("utf8")));
    child.stderr?.on("data", (d) => (err += String(d)));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`ocr_exit_${code}:${err.slice(0, 60)}`));
    });
  });
}

/**
 * Create the local Tesseract OcrProvider. `lang` defaults to English; the worker
 * image installs the language packs UC-4 advertises. If the runtime is unavailable
 * every extract() throws OCR_RUNTIME_UNAVAILABLE (the caller degrades that frame),
 * never a silent success.
 */
export async function createTesseractOcrProvider(lang = "eng"): Promise<OcrProvider> {
  const cap = await detectTesseractCapability();
  return {
    name: "tesseract",
    version: cap.ok ? cap.version ?? "unknown" : "unavailable",
    local: true,
    async extract(input: { imageRef: string }): Promise<OcrExtractResult> {
      const live = await detectTesseractCapability();
      if (!live.ok) throw new Error("OCR_RUNTIME_UNAVAILABLE");
      const tsv = await spawnTesseractTsv(live.tesseractPath, input.imageRef, lang);
      return { regions: parseTesseractTsv(tsv), language: lang };
    },
  };
}
