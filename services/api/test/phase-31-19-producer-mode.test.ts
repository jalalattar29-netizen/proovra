/**
 * Phase 31.19 — OCR / transcript producer mode unit tests.
 *
 * Hard contracts:
 *   * Unknown / malformed env collapses to NOT_CONFIGURED.
 *   * The getter NEVER throws.
 *   * Default mode is NOT_CONFIGURED so the platform never silently
 *     transmits data off-prem.
 *   * The combined `summariseProducerModes` reports
 *     `producesNewContent: false` for the default and for any
 *     INDEX_EXISTING_ONLY combination.
 */

import { describe, expect, it } from "vitest";

import {
  getOcrProducerMode,
  getTranscriptProducerMode,
  summariseProducerModes,
  OCR_PRODUCER_MODES,
  TRANSCRIPT_PRODUCER_MODES,
} from "../src/services/media-intelligence/producer-mode.js";

describe("Phase 31.19 — OCR producer mode", () => {
  it("default is NOT_CONFIGURED (no env)", () => {
    expect(getOcrProducerMode({})).toBe("NOT_CONFIGURED");
  });

  it("returns the env value when it is a known mode", () => {
    for (const mode of OCR_PRODUCER_MODES) {
      expect(getOcrProducerMode({ OCR_PRODUCER_MODE: mode })).toBe(mode);
    }
  });

  it("unknown / malformed values collapse to NOT_CONFIGURED", () => {
    expect(getOcrProducerMode({ OCR_PRODUCER_MODE: "bogus" })).toBe(
      "NOT_CONFIGURED",
    );
    expect(getOcrProducerMode({ OCR_PRODUCER_MODE: "" })).toBe(
      "NOT_CONFIGURED",
    );
    expect(getOcrProducerMode({ OCR_PRODUCER_MODE: "NOT_configured" })).toBe(
      "NOT_CONFIGURED",
    );
  });
});

describe("Phase 31.19 — Transcript producer mode", () => {
  it("default is NOT_CONFIGURED (no env)", () => {
    expect(getTranscriptProducerMode({})).toBe("NOT_CONFIGURED");
  });

  it("returns the env value when it is a known mode", () => {
    for (const mode of TRANSCRIPT_PRODUCER_MODES) {
      expect(getTranscriptProducerMode({ TRANSCRIPT_PRODUCER_MODE: mode })).toBe(
        mode,
      );
    }
  });

  it("unknown / malformed values collapse to NOT_CONFIGURED", () => {
    expect(
      getTranscriptProducerMode({ TRANSCRIPT_PRODUCER_MODE: "deepgram-cloud" }),
    ).toBe("NOT_CONFIGURED");
    expect(getTranscriptProducerMode({ TRANSCRIPT_PRODUCER_MODE: "" })).toBe(
      "NOT_CONFIGURED",
    );
  });
});

describe("Phase 31.19 — combined summary", () => {
  it("default summary reports producesNewContent: false", () => {
    const s = summariseProducerModes({});
    expect(s).toEqual({
      ocr: "NOT_CONFIGURED",
      transcript: "NOT_CONFIGURED",
      producesNewContent: false,
    });
  });

  it("INDEX_EXISTING_ONLY mode still reports producesNewContent: false", () => {
    const s = summariseProducerModes({
      OCR_PRODUCER_MODE: "INDEX_EXISTING_ONLY",
      TRANSCRIPT_PRODUCER_MODE: "INDEX_EXISTING_ONLY",
    });
    expect(s.producesNewContent).toBe(false);
  });

  it("only flips producesNewContent: true when BOTH sides are producing", () => {
    expect(
      summariseProducerModes({
        OCR_PRODUCER_MODE: "LOCAL_TESSERACT",
        TRANSCRIPT_PRODUCER_MODE: "NOT_CONFIGURED",
      }).producesNewContent,
    ).toBe(false);
    expect(
      summariseProducerModes({
        OCR_PRODUCER_MODE: "NOT_CONFIGURED",
        TRANSCRIPT_PRODUCER_MODE: "LOCAL_WHISPER",
      }).producesNewContent,
    ).toBe(false);
    expect(
      summariseProducerModes({
        OCR_PRODUCER_MODE: "LOCAL_TESSERACT",
        TRANSCRIPT_PRODUCER_MODE: "LOCAL_WHISPER",
      }).producesNewContent,
    ).toBe(true);
    expect(
      summariseProducerModes({
        OCR_PRODUCER_MODE: "VENDOR_CLOUD",
        TRANSCRIPT_PRODUCER_MODE: "VENDOR_CLOUD",
      }).producesNewContent,
    ).toBe(true);
  });

  it("returns flat object shape (no extra keys leaked)", () => {
    const s = summariseProducerModes({});
    expect(Object.keys(s).sort()).toEqual([
      "ocr",
      "producesNewContent",
      "transcript",
    ]);
  });
});
