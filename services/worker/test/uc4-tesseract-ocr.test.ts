/**
 * UC-4 — local Tesseract OCR adapter. The TSV parser (the deterministic heart) is
 * unit-tested without the binary; actual tesseract execution is gated on the runtime
 * being installed (deferred, not faked, when absent).
 */
import { describe, it, expect } from "vitest";

import {
  parseTesseractTsv,
  createTesseractOcrProvider,
} from "../src/tesseract-ocr-provider.js";
import { detectTesseractCapability } from "../src/tesseract-capability.js";

const TSV = [
  "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
  "1\t1\t0\t0\t0\t0\t0\t0\t320\t240\t-1\t", // page (level 1) ignored
  "5\t1\t1\t1\t1\t1\t10\t10\t40\t20\t95\tHello",
  "5\t1\t1\t1\t1\t2\t55\t10\t40\t20\t91\tworld",
  "5\t1\t1\t2\t1\t1\t10\t50\t22\t18\t88\tOK",
  "5\t1\t1\t3\t1\t1\t10\t90\t30\t18\t-1\t", // empty/non-text word dropped
].join("\n");

describe("UC-4 tesseract TSV parser (pure, deterministic)", () => {
  it("groups words into ordered lines with union bbox + mean confidence", () => {
    const regions = parseTesseractTsv(TSV);
    expect(regions.map((r) => r.text)).toEqual(["Hello world", "OK"]);
    expect(regions.map((r) => r.rowOrder)).toEqual([0, 1]);
    // First line union box spans both words; confidence is the mean/100.
    expect(regions[0].bbox).toEqual({ top: 10, left: 10, width: 85, height: 20 });
    expect(regions[0].confidence).toBeCloseTo(0.93, 2);
    expect(regions[0].kind).toBe("TEXT");
    // Non-text / empty words are dropped (never fabricated text).
    expect(regions.find((r) => r.text === "")).toBeUndefined();
  });

  it("orders lines by vertical position regardless of TSV row order", () => {
    const shuffled = [
      "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
      "5\t1\t1\t2\t1\t1\t10\t80\t20\t18\t90\tsecond",
      "5\t1\t1\t1\t1\t1\t10\t10\t20\t18\t90\tfirst",
    ].join("\n");
    expect(parseTesseractTsv(shuffled).map((r) => r.text)).toEqual(["first", "second"]);
  });

  it("returns [] for empty or malformed TSV (never throws, never fabricates)", () => {
    expect(parseTesseractTsv("")).toEqual([]);
    expect(parseTesseractTsv("garbage-no-tabs")).toEqual([]);
  });

  it("provider reports name/version/local; extract throws when runtime absent (degrade, not fake)", async () => {
    const provider = await createTesseractOcrProvider();
    expect(provider.name).toBe("tesseract");
    expect(provider.local).toBe(true);
    const cap = await detectTesseractCapability();
    if (!cap.ok) {
      // Runtime deferred on this host — extract() must FAIL CLOSED, never fake output.
      await expect(provider.extract({ imageRef: "/tmp/does-not-matter.webp" })).rejects.toThrow(
        /OCR_RUNTIME_UNAVAILABLE/,
      );
    } else {
      expect(typeof provider.version).toBe("string");
    }
  });
});
