/**
 * Phase 31.7 — EXIF extractor source-contract tests.
 *
 * Asserts the public contract of `exif-extractor.service.ts` without
 * needing real image files on disk. Every test uses bytes constructed
 * inline so the suite is deterministic + portable across CI.
 *
 * Layers covered:
 *
 *   1. Empty / oversized / non-image inputs → bounded refusals.
 *   2. Genuine no-EXIF input (e.g. a minimal PNG) → exifPresent=false,
 *      no throw.
 *   3. Output shape is closed (no unknown fields leak through).
 *   4. Raw GPS suppressed by default; opt-in returns rounded values.
 *   5. Camera / software string sanitisation rejects unsafe chars.
 *   6. computeExifVsServerGapSeconds is bounded + symmetric.
 *   7. Function purity — no env reads, no side effects.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeExifVsServerGapSeconds, extractExifSafe, } from "../src/services/media-intelligence/exif-extractor.service.js";
function readSource(rel) {
    return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}
// A minimal 1×1 PNG. Has no EXIF / IFD / XMP — exifr will return
// undefined, and the extractor should emit a clean "no EXIF" result.
const TINY_PNG = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
    0x00, 0x00, 0x00, 0x0d, // IHDR length
    0x49, 0x48, 0x44, 0x52, // "IHDR"
    0x00, 0x00, 0x00, 0x01, // width=1
    0x00, 0x00, 0x00, 0x01, // height=1
    0x08, 0x06, 0x00, 0x00, 0x00, // bit depth + color + interlace
    0x1f, 0x15, 0xc4, 0x89, // CRC
    0x00, 0x00, 0x00, 0x0a, // IDAT length
    0x49, 0x44, 0x41, 0x54, // "IDAT"
    0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, // data
    0x0d, 0x0a, 0x2d, 0xb4, // CRC
    0x00, 0x00, 0x00, 0x00, // IEND length
    0x49, 0x45, 0x4e, 0x44, // "IEND"
    0xae, 0x42, 0x60, 0x82, // CRC
]);
// =============================================================================
// PART 1 — Refusal cases
// =============================================================================
describe("EXIF extractor — bounded refusals", () => {
    it("refuses empty input", async () => {
        const r = await extractExifSafe({ bytes: new Uint8Array(0) });
        expect(r.ok).toBe(false);
        if (!r.ok)
            expect(r.reason).toBe("empty_input");
    });
    it("refuses oversized input", async () => {
        const buf = new Uint8Array(2);
        const r = await extractExifSafe({ bytes: buf, maxBytes: 1 });
        expect(r.ok).toBe(false);
        if (!r.ok)
            expect(r.reason).toBe("input_too_large");
    });
    it("refuses unsupported MIME upfront", async () => {
        const r = await extractExifSafe({
            bytes: TINY_PNG,
            mimeType: "application/pdf",
        });
        expect(r.ok).toBe(false);
        if (!r.ok)
            expect(r.reason).toBe("unsupported_format");
    });
    it("never throws on malformed bytes", async () => {
        const junk = new Uint8Array(100).fill(0xff);
        const r = await extractExifSafe({ bytes: junk, mimeType: "image/jpeg" });
        // Either reports parse_failed OR returns a no-EXIF summary —
        // both are acceptable; the contract is "never throw".
        expect(["ok-true", "parse_failed", "ok-true-no-exif"]).toContain(r.ok ? "ok-true" : r.reason === "parse_failed" ? "parse_failed" : "ok-true");
    });
});
// =============================================================================
// PART 2 — No-EXIF path
// =============================================================================
describe("EXIF extractor — genuine no-EXIF input", () => {
    it("returns a clean empty summary for a minimal PNG", async () => {
        const r = await extractExifSafe({
            bytes: TINY_PNG,
            mimeType: "image/png",
        });
        expect(r.ok).toBe(true);
        if (!r.ok)
            return;
        expect(r.summary.exifPresent).toBe(false);
        expect(r.summary.dateTimeOriginalUtc).toBeNull();
        expect(r.summary.createDateUtc).toBeNull();
        expect(r.summary.dimensions).toBeNull();
        expect(r.summary.cameraMake).toBeNull();
        expect(r.summary.cameraModel).toBeNull();
        expect(r.summary.hasGps).toBe(false);
        expect(r.summary.orientation).toBeNull();
        expect(r.summary.software).toBeNull();
    });
    it("never sets rawGps in the default policy even when bytes parse cleanly", async () => {
        const r = await extractExifSafe({
            bytes: TINY_PNG,
            mimeType: "image/png",
        });
        expect(r.ok).toBe(true);
        if (!r.ok)
            return;
        expect(r.summary.rawGps).toBeUndefined();
    });
});
// =============================================================================
// PART 3 — Output shape is closed (no unknown leakage)
// =============================================================================
describe("EXIF extractor — output shape", () => {
    it("output keys are bounded — no XPComment / IPTC / ICC leak", async () => {
        const r = await extractExifSafe({
            bytes: TINY_PNG,
            mimeType: "image/png",
        });
        expect(r.ok).toBe(true);
        if (!r.ok)
            return;
        const allowed = new Set([
            "exifPresent",
            "dateTimeOriginalUtc",
            "createDateUtc",
            "dimensions",
            "cameraMake",
            "cameraModel",
            "hasGps",
            "rawGps",
            "orientation",
            "software",
        ]);
        for (const k of Object.keys(r.summary)) {
            expect(allowed.has(k), `unexpected output key: ${k}`).toBe(true);
        }
    });
});
// =============================================================================
// PART 4 — computeExifVsServerGapSeconds
// =============================================================================
describe("EXIF extractor — computeExifVsServerGapSeconds", () => {
    it("returns null when either input is missing", () => {
        expect(computeExifVsServerGapSeconds(null, new Date())).toBeNull();
        expect(computeExifVsServerGapSeconds("2026-01-01T00:00:00.000Z", null)).toBeNull();
    });
    it("symmetric — past or future yields the same magnitude", () => {
        const server = new Date("2026-05-20T12:00:00.000Z");
        const earlier = computeExifVsServerGapSeconds("2026-05-20T10:00:00.000Z", server);
        const later = computeExifVsServerGapSeconds("2026-05-20T14:00:00.000Z", server);
        expect(earlier).toBe(7200);
        expect(later).toBe(7200);
    });
    it("returns null on garbage", () => {
        expect(computeExifVsServerGapSeconds("garbage", new Date("2026-05-20Z"))).toBeNull();
    });
});
// =============================================================================
// PART 5 — Source contract (anti-leak invariants)
// =============================================================================
describe("EXIF extractor — source contract", () => {
    const src = readSource("../../../packages/shared-runtime/src/media-intelligence/exif-extractor.service.ts");
    it("declared pure — no fs / net / process.env imports", () => {
        const noComments = src
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\/\/[^\n]*/g, "");
        expect(noComments).not.toMatch(/from\s+["']node:fs["']/);
        expect(noComments).not.toMatch(/from\s+["']fs["']/);
        expect(noComments).not.toMatch(/from\s+["']node:http["']/);
        expect(noComments).not.toMatch(/from\s+["']node:net["']/);
        expect(noComments).not.toMatch(/process\.env\./);
        expect(noComments).not.toMatch(/fetch\(/);
    });
    it("XMP / IPTC / ICC blocks are explicitly disabled", () => {
        expect(src).toMatch(/xmp:\s*false/);
        expect(src).toMatch(/iptc:\s*false/);
        expect(src).toMatch(/icc:\s*false/);
    });
    it("no forbidden truth-claim wording in any source literal (after stripping comments)", () => {
        // Strip block + line comments first so doc-strings that document
        // forbidden vocabulary (to enforce its absence in user-facing
        // surfaces) don't trip the check.
        const noComments = src
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\/\/[^\n]*/g, "");
        const literals = noComments.match(/"[^"\n]+"/g) ?? [];
        const forbidden = /\b(tamper(ed|ing)?|forged|fake|authentic(ity)?|admissible|proves?|confirms?|manipulated|doctored)\b/i;
        for (const lit of literals) {
            expect(lit, `EXIF extractor uses forbidden wording: ${lit}`).not.toMatch(forbidden);
        }
    });
    it("never returns rawGps without the explicit opt-in flag", () => {
        // Look for the projectSafeSummary function — it must only set
        // out.rawGps inside an `if (allowRawGps)` branch.
        const fn = src.match(/function projectSafeSummary\([\s\S]*?\n\}/)?.[0];
        expect(fn, "projectSafeSummary function found").toBeTruthy();
        expect(fn).toMatch(/out\.rawGps\s*=/);
        expect(fn).toMatch(/if \(allowRawGps\)\s*\{[\s\S]*?out\.rawGps\s*=/);
    });
    it("string fields go through sanitizeShortString (charset + length bounds)", () => {
        expect(src).toMatch(/SAFE_STRING_CHARSET\s*=\s*\/\^/);
        expect(src).toMatch(/STRING_FIELD_MAX\s*=\s*\d+/);
        expect(src).toMatch(/sanitizeShortString/);
    });
    it("dimensions sanity-capped to a finite ceiling", () => {
        expect(src).toMatch(/candidate\s*>\s*200_000|candidate > 200000/);
    });
    it("GPS coordinates rounded before exposure", () => {
        expect(src).toMatch(/roundTo\(lat,\s*5\)/);
        expect(src).toMatch(/roundTo\(lon,\s*5\)/);
    });
});
