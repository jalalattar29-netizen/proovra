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
// Phase EVIDENCE-IA-DECOMPOSE — page.tsx was split into _tabs/*;
// concatenate the orchestrator + every tab body so source-shape
// assertions still find the capture-note section snippet.
const EVIDENCE_DETAIL_CSS = readFileSync(
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
    "evidence-detail.css",
  ),
  "utf8",
);

const PAGE_SRC = [
  "page.tsx",
  "_tabs/_lib.tsx",
  "_tabs/EvidenceOverviewTab.tsx",
  "_tabs/EvidenceIntegrityTab.tsx",
  "_tabs/EvidenceCustodyTab.tsx",
  "_tabs/EvidenceReviewTab.tsx",
  "_tabs/EvidenceArtifactsTab.tsx",
  "_tabs/EvidenceDiscussionTab.tsx",
  "_tabs/EvidenceTechnicalAppendixTab.tsx",
  // The redesign extracted three single-responsibility surfaces out of the
  // orchestrator and the appendix tab. They are part of the same page body,
  // so source-shape assertions must keep seeing them.
  "_tabs/EvidenceRecordRail.tsx",
  "_tabs/technical-appendix/TrustDecisionSummary.tsx",
  "_tabs/technical-appendix/TechnicalDisclosure.tsx",
]
  .map((rel) =>
    readFileSync(
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
        rel,
      ),
      "utf8",
    ),
  )
  .join("\n\n");

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
    // pre-wrap moved from an inline style object onto the canonical
    // .evidence-detail-capture-note class when the route's inline styles were
    // removed. The guarantee — the note renders verbatim with its whitespace
    // preserved — is asserted against the class AND the stylesheet rule.
    expect(PAGE_SRC).toMatch(
      /data-evidence-section="capture-note"[\s\S]{0,800}?evidence-detail-capture-note[\s\S]{0,200}?evidence\.internalNotes/,
    );
    expect(EVIDENCE_DETAIL_CSS).toMatch(
      /\.evidence-detail-capture-note\s*\{[\s\S]{0,240}white-space:\s*pre-wrap/,
    );
  });

  it("Overview surface carries the privacy disclaimer (public-verify / report / package excluded)", () => {
    expect(PAGE_SRC).toMatch(
      /data-evidence-section="capture-note"[\s\S]{0,800}?Excluded\s*\n?\s*from public verification[\s\S]{0,200}?verification package/,
    );
  });

  it("Review tab still carries the canonical 'Private session note' surface (no regression)", () => {
    // The Review surface keeps the same heading and the same value; the
    // heading is now a titled BoundaryNote rather than a bare <strong>.
    expect(PAGE_SRC).toMatch(
      /Private session note[\s\S]{0,300}?\{evidence\.internalNotes\}/,
    );
  });
});
