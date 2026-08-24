/**
 * EVIDENCE LIBRARY ROW — presentation contract.
 *
 * The row was simplified: the generic review-state bucket ("Operational notes"
 * / "Reviewer action recommended" / "Stable review state" / "Critical
 * follow-up") is removed, and the Case relationship is shown as labelled TEXT
 * ("Case: <name>") instead of a bare capsule. These guards read the shipped
 * row + CSS so the two changes cannot silently regress.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

const ROW = read("apps/web/app/(app)/evidence/components/EvidenceLibraryRow.tsx");
const CSS = read("apps/web/app/(app)/evidence/evidence-library.css");
const PAGE = read("apps/web/app/(app)/evidence/page.tsx");
const LIST = read("apps/web/app/(app)/evidence/components/EvidenceList.tsx");

/**
 * The declared rule body for a selector, read from the CSS.
 *
 * Anchored at the start of a line so it returns the element's OWN rule and not
 * an earlier compound selector that merely ends with the same class (e.g. the
 * `[dir="rtl"] .evidence-library-row__case` block that precedes it).
 */
function rule(selector: string): string {
  const start = CSS.indexOf(`\n${selector} {`);
  assert.ok(start >= 0, `no rule for ${selector}`);
  const from = start + 1;
  return CSS.slice(from, CSS.indexOf("}", from));
}

// ===========================================================================
// A / B. Case association is shown when present, omitted when absent
// ===========================================================================

test("A. an Evidence WITH a case renders `Case: <name>` as labelled text", () => {
  // The relationship is a labelled key + the name, rendered only when a case
  // name is present.
  assert.match(ROW, /\{caseName \?/);
  assert.match(ROW, /className="evidence-library-row__case-label">Case:<\/span>/);
  assert.match(ROW, /className="evidence-library-row__case-name">\{caseName\}<\/span>/);
  // The tooltip carries the same "Case: <name>" reading for a truncated name.
  assert.match(ROW, /title=\{`Case: \$\{caseName\}`\}/);
});

test("B. an Evidence WITHOUT a case renders no Case metadata (no placeholder/warning)", () => {
  // The case block is guarded by `caseName ? … : null`, so an unlinked record
  // simply omits it — no "Unassigned", no "No case assigned", no empty slot.
  assert.match(ROW, /\{caseName \?[\s\S]*?: null\}/);
  assert.doesNotMatch(ROW, /Unassigned|No case assigned|Not assigned/);
  // The name is resolved upstream and passed as null when there is no case —
  // the row invents no case authority of its own.
  assert.match(LIST, /caseName=\{item\.caseId \? caseMap\.get\(item\.caseId\) \?\? null : null\}/);
});

// ===========================================================================
// C. The generic review-state bucket is gone
// ===========================================================================

test("C. no generic review-state bucket text or logic remains in the row", () => {
  for (const phrase of [
    "Stable review state",
    "Operational notes",
    "Reviewer action recommended",
    "Critical follow-up",
    "buildReviewPriority",
    "getReviewPriorityTone",
    "priority.label",
    "data-evidence-row-priority",
    "reviewStateTitle",
  ]) {
    assert.doesNotMatch(ROW, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `row still references "${phrase}"`);
  }
});

// ===========================================================================
// D. Case presentation: text-only, compact, canonical blue
// ===========================================================================

test("D. the Case is text-only — no capsule/badge, canonical blue name, compact size", () => {
  // No capsule: the old `.app-chip` is gone from the case element.
  assert.doesNotMatch(ROW, /app-chip[^"]*evidence-library-row__case|evidence-library-row__case[^"]*app-chip/);
  const caseRule = rule(".evidence-library-row__case");
  assert.doesNotMatch(caseRule, /background|border(?!-)|box-shadow|border-radius/);
  // Compact metadata size, matching the id beside it — never a heading.
  assert.match(caseRule, /font-size: 12px;/);
  // The name is the canonical blue token; the label is a quiet neutral.
  assert.match(rule(".evidence-library-row__case-name"), /color: var\(--info\);/);
  assert.doesNotMatch(rule(".evidence-library-row__case-name"), /#[0-9A-Fa-f]{3,6}\b/);
  assert.match(rule(".evidence-library-row__case-label"), /color: var\(--app-ink-secondary\);/);
});

// ===========================================================================
// E. Lifecycle status still renders
// ===========================================================================

test("E. the Evidence lifecycle status still renders as text, unchanged", () => {
  assert.match(ROW, /data-tone=\{getStatusBadgeTone\(item\)\}/);
  assert.match(ROW, /\{getRecordStatusLabel\(item\.status\)\}/);
  // The badges zone still carries the lifecycle status (one label now).
  const badges = rule(".evidence-library-row__badges");
  assert.match(badges, /display: flex;/);
});

// ===========================================================================
// F. Sorting/filtering is not regressed — the resolver is retained
// ===========================================================================

test("F. the Priority sort still consumes the retained review-priority resolver", () => {
  // Removing the row label must not change ordering: the canonical resolver is
  // kept and the priority sort still reads it.
  assert.match(PAGE, /import \{ buildReviewPriority \} from "\.\/lib\/evidence-library-alerts";/);
  assert.match(PAGE, /filters\.sort === "priority"/);
  assert.match(PAGE, /buildReviewPriority\(a,/);
  assert.match(PAGE, /buildReviewPriority\(b,/);
  // And the resolver itself is untouched (still exported from its one home).
  assert.match(
    read("apps/web/app/(app)/evidence/lib/evidence-library-alerts.ts"),
    /export function buildReviewPriority\(/,
  );
});

// ===========================================================================
// G. Grid rebalanced — no empty column left where the bucket lived
// ===========================================================================

test("G. the badges track was narrowed after the bucket removal (no reserved gap)", () => {
  // The badges column used to reserve two-label width; with only the lifecycle
  // status it is narrowed so the identity zone reclaims the room. Pin that the
  // old wide reservation is gone.
  assert.doesNotMatch(CSS, /clamp\(190px, 26%, 300px\)/);
  assert.doesNotMatch(CSS, /clamp\(190px, 30%, 280px\)/);
  assert.match(CSS, /clamp\(96px, 12%, 160px\)/);
  assert.match(CSS, /clamp\(96px, 16%, 150px\)/);
});
