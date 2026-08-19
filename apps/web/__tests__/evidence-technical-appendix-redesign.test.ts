/**
 * Evidence Detail — Technical Appendix redesign.
 *
 * This tab renders a technical CONCLUSION and the material behind it, so the
 * failure modes that matter are re-interpreting a result in presentation code
 * and dressing an absent value as a real one. Both are pinned here.
 *
 * The tab also spans several files, and the previous build had newly styled
 * upper sections sitting above legacy lower ones. These assertions cover the
 * WHOLE live surface — the decision card, the per-signal rows, the ten
 * context cards and the four lower disclosures — so a future change cannot
 * leave half of it behind.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const WEB = resolve(REPO_ROOT, "apps/web");
const read = (p: string) => readFileSync(resolve(WEB, p), "utf8");

/** Prose is not code: "must not survive" checks run on comment-free source. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const TA = "app/(app)/evidence/[id]/_tabs/technical-appendix";
const TAB = read("app/(app)/evidence/[id]/_tabs/EvidenceTechnicalAppendixTab.tsx");
const TAB_CODE = code(TAB);
const DECISION = read(`${TA}/TrustDecisionSummary.tsx`);
const DECISION_CODE = code(DECISION);
const DISCLOSURE = read(`${TA}/TechnicalDisclosure.tsx`);
const CONTEXT = read(`${TA}/EvidenceTechnicalAppendix.tsx`);
const CARD = read(`${TA}/TechnicalAppendixCard.tsx`);
const ROWS = read(`${TA}/MetadataRow.tsx`);
const EXIF = read(`${TA}/FullExifAccordion.tsx`);
const LOCATION = read(`${TA}/LocationContextCard.tsx`);
const INTEGRITY = read(`${TA}/IntegrityContextCard.tsx`);
const PARTS = read(`${TA}/EvidencePartMetadataTable.tsx`);
const RAIL = read("app/(app)/evidence/[id]/_tabs/EvidenceRecordRail.tsx");
const PAGE = read("app/(app)/evidence/[id]/page.tsx");
const CSS = read("app/(app)/evidence/[id]/evidence-detail.css");

const ALL_TA_FILES = [
  ["tab", TAB_CODE],
  ["decision", DECISION_CODE],
  ["disclosure", code(DISCLOSURE)],
  ["context", code(CONTEXT)],
  ["card", code(CARD)],
  ["rows", code(ROWS)],
  ["exif", code(EXIF)],
  ["location", code(LOCATION)],
  ["integrity", code(INTEGRITY)],
  ["parts", code(PARTS)],
] as const;

// ---------------------------------------------------------------------------
// A) The decision is read, never re-derived
// ---------------------------------------------------------------------------

test("verdict, score, confidence, reliance and anchoring come from the response", () => {
  for (const field of [
    "trust.verdictLabel",
    "trust.scoreLabel",
    "trust.confidenceLabel",
    "trust.relianceLevel",
    "trust.anchoringStatusLabel",
  ]) {
    assert.match(DECISION, new RegExp(field.replace(/\./g, "\\.")));
  }
});

test("no verdict, score or confidence is hardcoded", () => {
  // The screenshot's sample values must not appear as literals anywhere.
  assert.doesNotMatch(DECISION_CODE, /99\s*\/\s*100/);
  assert.doesNotMatch(DECISION_CODE, /"High"/);
  assert.doesNotMatch(DECISION_CODE, /"Recorded integrity verified"/);
  assert.doesNotMatch(TAB_CODE, /99\s*\/\s*100/);
});

test("presentation never re-thresholds a technical result", () => {
  // No score arithmetic, no comparison that could invent a verdict.
  assert.doesNotMatch(DECISION_CODE, /score\s*[><]=?\s*\d/);
  assert.doesNotMatch(DECISION_CODE, /Math\.(round|floor|ceil)\(/);
  assert.doesNotMatch(DECISION_CODE, /verdict\s*=\s*(score|points)/i);
  // The only arithmetic is summing declared maxPoints for the weighting line.
  const sums = DECISION_CODE.match(/\.reduce\(/g) ?? [];
  assert.equal(sums.length, 1, "only the weighting total may be computed");
});

test("a fact the response omits is not rendered as a placeholder", () => {
  assert.match(DECISION, /if \(trust\.verdictLabel\) facts\.push/);
  assert.match(DECISION, /if \(trust\.confidenceLabel\) \{/);
  assert.doesNotMatch(DECISION_CODE, /"Unknown"/);
  assert.doesNotMatch(DECISION_CODE, /verdictLabel \?\? "/);
});

// ---------------------------------------------------------------------------
// B) Signal totals and states are truthful
// ---------------------------------------------------------------------------

test("counts come from the response and an absent count is not zero", () => {
  assert.match(DECISION, /value: trust\.passedSignals/);
  assert.match(DECISION, /value: trust\.degradedSignals/);
  assert.match(DECISION, /value: trust\.failedSignals/);
  assert.match(DECISION, /total\.value == null \? "Not reported" : String\(total\.value\)/);
  // The old `?? 0` defaulted an absent count into a claim of zero.
  assert.doesNotMatch(DECISION_CODE, /passedSignals \?\? 0/);
  assert.doesNotMatch(DECISION_CODE, /failedSignals \?\? 0/);
});

test("each total keeps its own semantic tone — nothing is painted green", () => {
  assert.match(DECISION, /tone: "success"/);
  assert.match(DECISION, /tone: "warning"/);
  assert.match(DECISION, /tone: "danger"/);
  assert.match(CSS, /\.ta-decision-total\[data-tone="warning"\]/);
  assert.match(CSS, /\.ta-decision-total\[data-tone="danger"\]/);
  // The degraded and failed regions must not use the passed ground.
  const warn = CSS.slice(CSS.indexOf('.ta-decision-total[data-tone="warning"]'));
  assert.doesNotMatch(warn.slice(0, 160), /#E7F6EF/i);
});

test("the full signal-state vocabulary is supported and never colour-only", () => {
  for (const state of [
    "passed",
    "partial",
    "degraded",
    "failed",
    "pending",
    "missing",
    "unavailable",
    "not_applicable",
  ]) {
    assert.match(DECISION, new RegExp(`\\b${state}:`), `missing state: ${state}`);
  }
  for (const label of ["Passed", "Degraded", "Failed", "Pending", "Unavailable", "Not applicable"]) {
    assert.match(DECISION, new RegExp(`label: "${label}"`));
  }
  // Every state carries an icon AND a text label alongside its tone.
  assert.match(DECISION, /icon: CircleCheck/);
  assert.match(DECISION, /icon: TriangleAlert/);
  assert.match(DECISION, /icon: CircleAlert/);
  assert.match(DECISION, /<StateIcon/);
  assert.match(DECISION, /\{state\.label\}/);
});

test("an unrecognised backend status is shown verbatim, not coerced", () => {
  assert.match(
    DECISION,
    /SIGNAL_STATES\[status\] \?\? \{\s*\n?\s*label: status,\s*\n?\s*tone: "neutral"/,
  );
});

test("only the returned signals render — none are fabricated", () => {
  assert.match(DECISION, /const signals = trust\.signals \?\? \[\]/);
  assert.match(DECISION, /signals\.map\(\(signal\)/);
  // No canonical list of expected categories that could fill gaps.
  assert.doesNotMatch(DECISION_CODE, /"Core integrity"/);
  assert.doesNotMatch(DECISION_CODE, /"Bitcoin anchoring"/);
});

test("the decision empty state is honest", () => {
  assert.match(DECISION, /Trust decision is not yet available for this record\./);
  assert.match(DECISION, /data-trust-summary-empty/);
});

// ---------------------------------------------------------------------------
// C) The boundary of the conclusion is preserved
// ---------------------------------------------------------------------------

test("the boundary note is the product's copy, rendered not rewritten", () => {
  assert.match(DECISION, /\{trust\.summary\}/);
  assert.match(DECISION, /data-trust-summary-narrative/);
  assert.match(DECISION, /className="ta-decision-boundary"/);
  // The component must not author a claim of its own.
  assert.doesNotMatch(DECISION_CODE, /proof of|proves|authentic/i);
});

// ---------------------------------------------------------------------------
// D) One disclosure anatomy, accessible, no glyph chevrons
// ---------------------------------------------------------------------------

test("the disclosure is native <details> with an explicit panel relationship", () => {
  assert.match(DISCLOSURE, /<details/);
  assert.match(DISCLOSURE, /aria-expanded=\{open\}/);
  assert.match(DISCLOSURE, /aria-controls=\{panelId\}/);
  assert.match(DISCLOSURE, /id=\{panelId\}/);
  assert.match(DISCLOSURE, /role="region"/);
  assert.match(DISCLOSURE, /aria-label=\{title\}/);
  assert.match(
    DISCLOSURE,
    /onToggle=\{\(event\) => setOpen\(\(event\.target as HTMLDetailsElement\)\.open\)\}/,
  );
  assert.match(DISCLOSURE, /<ChevronDown/);
});

test("every disclosure on the tab uses that one anatomy", () => {
  // No hand-rolled <details> survives anywhere in the appendix.
  for (const [label, src] of ALL_TA_FILES) {
    if (label === "disclosure") continue;
    assert.doesNotMatch(src, /<details/, `${label} must not hand-roll a disclosure`);
  }
  const uses = TAB.match(/<TechnicalDisclosure/g) ?? [];
  assert.ok(uses.length >= 4, `expected >=4 disclosures on the tab, got ${uses.length}`);
});

test("no text-glyph chevron survives", () => {
  for (const [label, src] of ALL_TA_FILES) {
    assert.doesNotMatch(src, /[▸▾▴▹►◄]/, `${label} must not use a glyph chevron`);
  }
  assert.doesNotMatch(CSS, /content:\s*"▸|content:\s*"▾/);
});

test("the chevron mirrors by rotation, and focus stays visible", () => {
  assert.match(CSS, /details\[open\] > \.ta-accordion-summary \.ta-accordion-chevron/);
  assert.match(CSS, /\.ta-accordion-summary:focus-visible\s*\{[\s\S]{0,120}outline:/);
});

// ---------------------------------------------------------------------------
// E) Every live module is migrated — no half-styled tab
// ---------------------------------------------------------------------------

test("all four lower disclosures are still mounted", () => {
  for (const block of ["hashes", "event-counts", "custody-chain"]) {
    assert.match(TAB, new RegExp(`data-evidence-technical-block="${block}"`));
  }
  assert.match(TAB, /data-evidence-technical-block="divergence"/);
  assert.match(TAB, /data-evidence-raw-appendix="true"/);
  assert.match(TAB, /data-evidence-raw-debug-gated="true"/);
});

test("the ten technical-context cards are still mounted", () => {
  for (const section of [
    "ta-section-acquisition",
    "ta-section-capture-device",
    "ta-section-camera",
    "ta-section-location",
    "ta-section-client-env",
    "ta-section-upload-session",
    "ta-section-technical-metadata",
    "ta-section-integrity",
    "ta-section-custody-summary",
  ]) {
    assert.match(CONTEXT + LOCATION + INTEGRITY, new RegExp(section), `missing ${section}`);
  }
});

test("the media-intelligence panel keeps its tenant gate", () => {
  assert.match(TAB, /const mediaIntelligenceTeamId = workspace\.reviewWorkflow\?\.teamId \?\? null/);
  assert.match(TAB, /\{mediaIntelligenceTeamId \? \(/);
});

test("the raw snapshot stays behind the debug gate", () => {
  assert.match(TAB, /searchParams\?\.get\("debug"\) === "1"/);
  assert.match(TAB, /\{showRawDebugJson \? \(/);
});

test("no inline style object or inline hex survives anywhere in the appendix", () => {
  for (const [label, src] of ALL_TA_FILES) {
    assert.doesNotMatch(src, /style=\{\{/, `${label} still carries an inline style object`);
    assert.doesNotMatch(src, /#[0-9a-fA-F]{6}\b/, `${label} still carries an inline hex`);
    assert.doesNotMatch(src, /from "[^"]*components\/ui"/, `${label} imports the legacy ui barrel`);
    assert.doesNotMatch(src, /<Button\b/, `${label} renders a legacy Button`);
    assert.doesNotMatch(src, /teal/i, `${label} references legacy teal`);
    assert.doesNotMatch(src, /<em>|<i>|font-style:\s*italic/, `${label} uses italic`);
  }
});

test("the superseded shared primitives are gone from the tab", () => {
  for (const legacy of [
    "KeyValueGrid",
    "SectionHeading",
    "evidence-detail-note-box",
    "evidence-detail-section-header",
    "evidence-detail-raw-summary",
    "evidence-detail-pill",
  ]) {
    assert.doesNotMatch(
      TAB_CODE,
      new RegExp(legacy.replace(/-/g, "\\-")),
      `${legacy} must not survive in the tab`,
    );
  }
});

test("the appendix shell does not reuse the hero's LTR-pinned class", () => {
  // `.evidence-detail-technical` pins `direction: ltr` for the hero record id.
  // Reusing it here silently froze the entire tab LTR in Arabic.
  assert.match(TAB, /className="evidence-detail-appendix"/);
  assert.doesNotMatch(TAB, /className="evidence-detail-technical"/);
  assert.match(CSS, /\.evidence-detail-technical\s*\{[\s\S]{0,120}direction:\s*ltr/);
  const shell = CSS.slice(CSS.indexOf(".evidence-detail-appendix"));
  assert.doesNotMatch(shell.slice(0, 200), /direction:\s*ltr/);
});

// ---------------------------------------------------------------------------
// F) Truthful empty states and preserved behaviour
// ---------------------------------------------------------------------------

test("missing EXIF is an explicit empty state, never an implication", () => {
  assert.match(CONTEXT + EXIF, /No EXIF/i);
  // Absence is never described as tampering, editing or manipulation.
  for (const [, src] of ALL_TA_FILES) {
    assert.doesNotMatch(src, /manipulat|tamper|edited|doctored/i);
  }
});

test("copy and map behaviour is preserved", () => {
  assert.match(ROWS, /navigator\.clipboard\.writeText\(value\)/);
  assert.match(ROWS, /aria-label=\{label \?\? "Copy to clipboard"\}/);
  assert.match(LOCATION, /Open map/);
});

test("hash rows stay monospace and copyable", () => {
  assert.match(TAB, /mono: Boolean\(tm\.multipartManifestSha256\)/);
  assert.match(TAB, /copyable: Boolean\(tm\.tsaInputDigestHex\)/);
  assert.match(CSS, /\.ta-mono \.ta-row-value-text/);
});

test("technical values stay readable in RTL", () => {
  assert.match(CSS, /\.ta-row-value-text\s*\{[\s\S]{0,140}unicode-bidi:\s*plaintext/);
  assert.match(CSS, /\.ta-location-coords\s*\{[\s\S]{0,400}unicode-bidi:\s*plaintext/);
  assert.match(CSS, /\.ta-part-hash-value\s*\{[\s\S]{0,220}unicode-bidi:\s*plaintext/);
  // The appendix lays out with logical properties only.
  const ta = CSS.slice(CSS.indexOf(".ta-root"), CSS.indexOf(".evidence-detail-appendix"));
  assert.doesNotMatch(ta, /margin-left:|margin-right:|float:/);
});

// ---------------------------------------------------------------------------
// G) One implementation, one rail
// ---------------------------------------------------------------------------

test("Personal and Enterprise render the same appendix", () => {
  assert.doesNotMatch(TAB_CODE, /workspaceKind|isPersonal|orgKind/i);
  assert.match(PAGE, /activeTab === "technical" \? \(/);
});

test("the shared rail is reused once and the appendix does not fork it", () => {
  const mounts = PAGE.match(/<EvidenceRecordRail\b/g) ?? [];
  assert.equal(mounts.length, 1);
  assert.doesNotMatch(TAB, /evidence-detail-sidebar|EvidenceRecordRail/);
  const headings = [...RAIL.matchAll(/className="evidence-detail-rail-heading">([^<]+)</g)].map(
    (m) => m[1],
  );
  assert.deepEqual(headings, [
    "Risk Signals",
    "Review Workflow",
    "Attributes",
    "Public Verification",
  ]);
});
