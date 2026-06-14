/**
 * Phase EVIDENCE-IA — acceptance test suite for the Evidence Detail
 * page refactor. Locks the source shape across Phase 0–6:
 *
 *   Phase 0 — page.tsx is no longer a multi-thousand-line monolith;
 *             tab bodies live in `_tabs/Evidence{...}Tab.tsx`.
 *
 *   Phase 1 — single-owner duplication removal:
 *             hashes only in Technical Appendix; access activity
 *             only in Custody; forensic event counts only in
 *             Technical Appendix; retention/object-lock only in
 *             Integrity + Appendix.
 *
 *   Phase 2 — 5-layer IA + structured NOT_STARTED empty state.
 *
 *   Phase 3 — "What needs attention" strip directly below hero.
 *
 *   Phase 5 — plain-language copy ("Verification & Preservation",
 *             "Timestamp proof (TSA)", "How verification hashes are
 *             computed", "Boundary updated", etc).
 *
 *   Phase 6 — Technical Appendix hardening: raw JSON + manifest +
 *             TSA imprint + hash semantics + divergence reasons
 *             only in Technical Appendix, each collapsed by default.
 *             AI categorization card hidden when DISABLED.
 *
 *   Phase 7 — anti-overclaim guard (no "authentic", "court-ready",
 *             "legally admiss" + "ible", "tamper-proof", "proven").
 *
 * The page.tsx byte-size guard prevents the monolith from coming
 * back: any future commit that crosses the cap is asked to extract
 * into _tabs/ instead.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EVIDENCE_DIR = resolve(__dirname, "../app/(app)/evidence/[id]");

function readFile(rel: string): string {
  return readFileSync(resolve(EVIDENCE_DIR, rel), "utf8");
}

const PAGE = readFile("page.tsx");
const LIB = readFile("_tabs/_lib.tsx");
const OVERVIEW = readFile("_tabs/EvidenceOverviewTab.tsx");
const INTEGRITY = readFile("_tabs/EvidenceIntegrityTab.tsx");
const CUSTODY = readFile("_tabs/EvidenceCustodyTab.tsx");
const REVIEW = readFile("_tabs/EvidenceReviewTab.tsx");
const ARTIFACTS = readFile("_tabs/EvidenceArtifactsTab.tsx");
const APPENDIX = readFile("_tabs/EvidenceTechnicalAppendixTab.tsx");

function readDirRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...readDirRecursive(full));
    else if (full.endsWith(".tsx") || full.endsWith(".ts")) out.push(full);
  }
  return out;
}
const ALL = readDirRecursive(EVIDENCE_DIR).map((p) => readFileSync(p, "utf8")).join("\n");

// ---------------------------------------------------------------------------
// Phase 0 — decomposition: page.tsx is an orchestrator, not a monolith
// ---------------------------------------------------------------------------

test("Phase 0 — page.tsx is orchestration only (under 80 KB byte-size guard)", () => {
  // Original page.tsx: 147,250 bytes. Cap chosen well above the
  // current orchestrator (~38 KB) so adding modals or a small
  // section doesn't break the guard, but well below the original
  // monolith so the next 3,000-line drift dies fast.
  const sizeBytes = Buffer.byteLength(PAGE, "utf8");
  const CAP_BYTES = 80_000;
  assert.ok(
    sizeBytes <= CAP_BYTES,
    `page.tsx is ${sizeBytes} bytes (cap ${CAP_BYTES}). Extract new sections into _tabs/ instead.`,
  );
});

test("Phase 0 — each tab body is its own component file", () => {
  for (const file of [
    "_tabs/EvidenceOverviewTab.tsx",
    "_tabs/EvidenceIntegrityTab.tsx",
    "_tabs/EvidenceCustodyTab.tsx",
    "_tabs/EvidenceReviewTab.tsx",
    "_tabs/EvidenceArtifactsTab.tsx",
    "_tabs/EvidenceDiscussionTab.tsx",
    "_tabs/EvidenceTechnicalAppendixTab.tsx",
    "_tabs/_lib.tsx",
  ]) {
    assert.ok(readFile(file).length > 0, `Expected ${file} to exist + be non-empty`);
  }
});

test("Phase 0 — orchestrator imports every tab + passes a single ctx prop", () => {
  for (const tab of [
    "EvidenceOverviewTab",
    "EvidenceIntegrityTab",
    "EvidenceCustodyTab",
    "EvidenceReviewTab",
    "EvidenceArtifactsTab",
    "EvidenceDiscussionTab",
    "EvidenceTechnicalAppendixTab",
  ]) {
    assert.match(PAGE, new RegExp(`import \\{ ${tab} \\} from "\\./_tabs/${tab}"`));
    assert.match(PAGE, new RegExp(`<${tab} ctx=\\{ctx\\} />`));
  }
});

// ---------------------------------------------------------------------------
// Phase 1 — single-owner duplication removal
// ---------------------------------------------------------------------------

test("Phase 1 — manifest SHA-256 + TSA imprint live ONLY in Technical Appendix", () => {
  // Multipart manifest SHA-256 row + TSA accepted message imprint
  // row should now live in `EvidenceTechnicalAppendixTab.tsx` as
  // object-literal `label:"..."` values and NOT be rendered as
  // labels in the Integrity tab. (Historical comments in any tab
  // may still mention them.)
  assert.match(APPENDIX, /label:\s*"Multipart manifest SHA-256"/);
  assert.match(APPENDIX, /label:\s*"Time-stamp imprint \(TSA accepted message imprint\)"/);
  assert.doesNotMatch(INTEGRITY, /label:\s*"Multipart manifest SHA-256"/);
  assert.doesNotMatch(INTEGRITY, /label:\s*"TSA accepted message imprint"/);
});

test("Phase 1 — hash semantics enum explanations live ONLY in Technical Appendix", () => {
  assert.match(APPENDIX, /Single-file SHA-256/);
  assert.match(APPENDIX, /Multipart composite \(with reproducible manifest digest\)/);
  assert.doesNotMatch(INTEGRITY, /Single-file SHA-256/);
});

test("Phase 1 — forensic event counts live ONLY in Technical Appendix", () => {
  assert.match(APPENDIX, /Forensic events at report time/);
  assert.match(APPENDIX, /Forensic events now/);
  assert.match(APPENDIX, /Access \/ view events after report/);
  assert.doesNotMatch(INTEGRITY, /Forensic events at report time/);
  assert.doesNotMatch(INTEGRITY, /Current forensic events/);
  assert.doesNotMatch(INTEGRITY, /Access events after report/);
});

test("Phase 1 — snapshot boundary divergence per-reason detail lives ONLY in Technical Appendix", () => {
  // Integrity still carries a PLAIN summary banner ("Boundary updated"
  // with a one-paragraph explanation); the per-reason list moves to
  // the Appendix's `data-evidence-technical-block="divergence"`.
  assert.match(APPENDIX, /data-evidence-technical-block="divergence"/);
  assert.match(INTEGRITY, /Boundary updated/);
});

test("Phase 1 — Custody is the single home for access + forensic event lists", () => {
  // The full forensic + access timelines render in Custody only
  // (grouped by day with a `Show raw events` expander); Integrity
  // does not re-render the lists.
  assert.match(CUSTODY, /Forensic custody/);
  assert.match(CUSTODY, /Access activity/);
  assert.doesNotMatch(INTEGRITY, /<EventTimeline/);
});

// ---------------------------------------------------------------------------
// Phase 2 — IA: 5 layers + NOT_STARTED empty state
// ---------------------------------------------------------------------------

test("Phase 2 — Review tab renders NOT_STARTED structured empty state", () => {
  assert.match(REVIEW, /data-evidence-review-empty="NOT_STARTED"/);
  assert.match(REVIEW, /Review has not started yet/);
  // Suggested actions per audit spec
  assert.match(REVIEW, /Attach to case/);
  assert.match(REVIEW, /Assign reviewer/);
  assert.match(REVIEW, /Open report/);
  assert.match(REVIEW, /data-evidence-review-empty-actions/);
});

test("Phase 2 — Artifacts tab carries a Latest summary above version history", () => {
  assert.match(ARTIFACTS, /data-evidence-section="latest-artifacts"/);
  assert.match(ARTIFACTS, /data-latest-artifact="report"/);
  assert.match(ARTIFACTS, /data-latest-artifact="package"/);
  assert.match(ARTIFACTS, /data-latest-artifact="verify"/);
});

test("Phase 2 — Custody renders the grouped-by-day default with raw expander", () => {
  // `GroupedEventTimeline` in `_lib.tsx` carries the
  // `data-grouped-timeline` + `data-grouped-timeline-raw` contract.
  assert.match(LIB, /data-grouped-timeline\b/);
  assert.match(LIB, /data-grouped-timeline-raw/);
  assert.match(LIB, /Show raw events/);
});

// ---------------------------------------------------------------------------
// Phase 3 — "What needs attention" strip
// ---------------------------------------------------------------------------

test("Phase 3 — orchestrator renders WhatNeedsAttentionStrip directly below the hero", () => {
  assert.match(PAGE, /<WhatNeedsAttentionStrip/);
  assert.match(PAGE, /data-evidence-attention-strip/);
  // Strip surfaces concrete actions
  assert.match(PAGE, /data-evidence-attention-action="assign-case"/);
  assert.match(PAGE, /data-evidence-attention-action="assign-reviewer"/);
  assert.match(PAGE, /data-evidence-attention-action="missing-report"/);
  assert.match(PAGE, /data-evidence-attention-action="missing-package"/);
});

test("Phase 3 — risk signals from buildRiskSignals feed the attention strip", () => {
  // The strip slices the same array the sidebar renders, so any
  // existing alert source is honored.
  assert.match(PAGE, /reviewSignals\.slice\(0, ?3\)/);
});

// ---------------------------------------------------------------------------
// Phase 4 — metadata simplification
// ---------------------------------------------------------------------------

test("Phase 4 — Overview renders a single consolidated Record summary", () => {
  assert.match(OVERVIEW, /data-evidence-section="record-summary"/);
  // The two prior side-by-side panels ("Technical Review Readiness"
  // + "Verification Proof") are no longer rendered as JSX kicker
  // labels — only historical comments may reference them.
  assert.doesNotMatch(OVERVIEW, /kicker="Verification Proof"/);
  assert.doesNotMatch(OVERVIEW, />Verification Proof</);
});

// ---------------------------------------------------------------------------
// Phase 5 — copy refinement
// ---------------------------------------------------------------------------

test("Phase 5 — Integrity uses 'Verification & Preservation' (not 'Preservation Matrix')", () => {
  // The new kicker exists as a JSX prop value. The old "Preservation
  // Matrix" string must not survive as a `kicker=` prop literal,
  // though the JSDoc may still reference it as historical context.
  assert.match(INTEGRITY, /kicker="Verification &amp; Preservation"/);
  assert.doesNotMatch(INTEGRITY, /kicker="Preservation Matrix"/);
});

test("Phase 5 — Integrity uses 'Timestamp proof (TSA)' instead of bare 'TSA timestamp'", () => {
  // Match the label as an object-literal value (the actual UI
  // string), not a free-text occurrence.
  assert.match(INTEGRITY, /label: "Timestamp proof \(TSA\)"/);
  // The old literal must not survive as an object-literal label.
  assert.doesNotMatch(INTEGRITY, /\blabel:\s*"TSA timestamp"/);
});

test("Phase 5 — Technical Appendix uses plain 'How verification hashes are computed' label", () => {
  assert.match(APPENDIX, /How verification hashes are computed/);
});

test("Phase 5 — Integrity uses plain 'Record boundary noted' (not 'Snapshot boundary' as a heading)", () => {
  // The plain Integrity banner reads "Record boundary noted" as
  // visible JSX text. The forensic "Snapshot boundary update"
  // heading is gone from Integrity's visible JSX (only comments may
  // mention it as historical context).
  assert.match(INTEGRITY, />Record boundary noted</);
  assert.doesNotMatch(INTEGRITY, />Snapshot boundary update</);
});

// ---------------------------------------------------------------------------
// Phase 6 — Technical Appendix hardening
// ---------------------------------------------------------------------------

test("Phase 6 — raw trustDecisionSnapshot JSON lives ONLY in the Technical Appendix, collapsed", () => {
  assert.match(APPENDIX, /data-evidence-raw-appendix/);
  assert.match(APPENDIX, /Raw technical snapshot/);
  assert.match(APPENDIX, /JSON\.stringify\(/);
  // Not anywhere else in the directory
  const others = [OVERVIEW, INTEGRITY, CUSTODY, REVIEW, ARTIFACTS].join("\n");
  assert.doesNotMatch(others, /data-evidence-raw-appendix/);
  assert.doesNotMatch(others, /Raw technical snapshot/);
  assert.doesNotMatch(others, /JSON\.stringify\(.*trustDecision/);
});

test("Phase 6 — every Technical Appendix block is collapsed by default (`<details>` without `open`)", () => {
  // Each `<details>` in the appendix MUST NOT carry `open` so the
  // technical material is opt-in.
  const detailsTags = APPENDIX.match(/<details[^>]*>/g) ?? [];
  assert.ok(detailsTags.length >= 3, "appendix should have multiple details blocks");
  for (const tag of detailsTags) {
    assert.doesNotMatch(tag, /\bopen\b/, `appendix <details> must be closed by default: ${tag}`);
  }
});

test("Phase 6 — AI categorization card is hidden when status === 'DISABLED'", () => {
  // Wrapper component probes the endpoint once and short-circuits
  // when the status is DISABLED instead of always mounting the
  // underlying card.
  assert.match(REVIEW, /AiCategorizationCardWhenActive/);
  assert.match(REVIEW, /status === "DISABLED"/);
});

// ---------------------------------------------------------------------------
// Phase 7 — anti-overclaim guard + main-action presence
// ---------------------------------------------------------------------------

test("Phase 7 — hero exposes Download Report PDF + Download Verification Package ZIP + Copy verification link", () => {
  assert.match(PAGE, /Download Report PDF/);
  assert.match(PAGE, /Download Verification Package ZIP/);
  assert.match(PAGE, /Copy verification link/);
});

test("Phase 7 — legal boundary statement is rendered near the top (in the hero)", () => {
  // The orchestrator renders `{workspace.legalBoundary}` inside
  // `evidence-detail-boundary` — keep that contract.
  assert.match(PAGE, /<div className="evidence-detail-boundary">\{workspace\.legalBoundary\}<\/div>/);
});

// Phase 7 — banned-overclaim wordlist. The literal words are split
// across string-concat so this file itself does not trip the global
// honest-mi vocabulary scanner in phase-g5-honest-mi.test.ts.
const BANNED_OVERCLAIMS = [
  "Authent" + "ic",
  "Authent" + "icated",
  "Court " + "ready",
  "Court-" + "ready",
  "Legally " + "admiss" + "ible",
  "Tamper-" + "proof",
  "Tamper " + "proof",
  "Pro" + "ven authent" + "ic",
];

for (const word of BANNED_OVERCLAIMS) {
  test(`Phase 7 — banned overclaim "${word}" never appears as a JSX text/label literal in evidence-detail/`, () => {
    // Match either `>${word}<` (JSX text node) or `label:"${word}"` /
    // `title:"${word}"` (object literal label/title). Matches inside
    // code identifiers and inside multi-word comments don't count.
    const pattern = new RegExp(
      `(?:label|title):\\s*"[^"]*${word}[^"]*"|>${word}[^<]*<`,
      "i",
    );
    assert.doesNotMatch(ALL, pattern, `${word} appears as a label/title/text literal`);
  });
}

test("Phase 7 — 'Sealed' is not used as a status label (Phase HOME-COPY already standardised on 'Signed')", () => {
  // Keep the doors closed on a regression from the Home-side fix.
  // The underlying SIGNED status keyword is allowed; only the
  // user-visible 'Sealed' wording is banned.
  assert.doesNotMatch(ALL, /(?:label|title):\s*"[^"]*\bSealed\b[^"]*"|>Sealed[^<]*</);
});
