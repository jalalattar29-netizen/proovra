/**
 * Phase CAPTURE-NOTE-OVERVIEW-FIX — P0 Bug 3 regression lock.
 *
 * After Capture, the user is redirected to /evidence/:id and lands
 * on the Overview tab. The record-level capture private note
 * (Evidence.internalNotes) was previously rendered ONLY in the
 * Review tab, so the user thought their note was lost.
 *
 * This lock asserts:
 *   1. Overview has a dedicated "Capture note (private)" surface
 *      that renders only when `evidence.internalNotes` is truthy.
 *   2. The surface uses a stable data hook for downstream tests.
 *   3. The privacy disclaimer ("Excluded from public verification…")
 *      is co-located so the user re-reads what the Capture page
 *      promised.
 *   4. The Review tab still carries the canonical "Private session
 *      note" surface — this is an ADDITIVE Overview surface, the
 *      Review one is the edit-context home.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PAGE_SRC = readFileSync(
  resolve(
    __dirname,
    "..",
    "..",
    "..",
    "apps",
    "web",
    "app",
    "(app)",
    "evidence",
    "[id]",
    "page.tsx",
  ),
  "utf8",
);

describe("Evidence Detail — Overview capture-note surface (P0 Bug 3)", () => {
  it("Overview section data hook exists", () => {
    expect(PAGE_SRC).toMatch(/data-evidence-section="capture-note"/);
  });

  it("Overview surface is gated on evidence.internalNotes truthy (no empty box)", () => {
    expect(PAGE_SRC).toMatch(
      /\{evidence\.internalNotes\s*\?\s*\(\s*<section[\s\S]{0,400}?data-evidence-section="capture-note"/,
    );
  });

  it("Overview surface renders the captured note verbatim (whitespace preserved)", () => {
    expect(PAGE_SRC).toMatch(
      /data-evidence-section="capture-note"[\s\S]{0,800}?whiteSpace:\s*"pre-wrap"[\s\S]{0,200}?evidence\.internalNotes/,
    );
  });

  it("Overview surface carries the privacy disclaimer (public-verify / report / package excluded)", () => {
    expect(PAGE_SRC).toMatch(
      /data-evidence-section="capture-note"[\s\S]{0,800}?Excluded\s*\n?\s*from public verification[\s\S]{0,200}?verification package/,
    );
  });

  it("Review tab still carries the canonical 'Private session note' surface (no regression)", () => {
    expect(PAGE_SRC).toMatch(
      /<strong>Private session note<\/strong>[\s\S]{0,200}?\{evidence\.internalNotes\}/,
    );
  });
});
