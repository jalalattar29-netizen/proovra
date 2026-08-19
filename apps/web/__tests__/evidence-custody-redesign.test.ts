/**
 * Evidence Detail — Custody tab redesign + shared right-rail grouping.
 *
 * The Custody tab carries TWO chronologies that must never be merged: the
 * forensic lifecycle (what happened to the record) and access activity (who
 * read or downloaded it). Merging them would let a download appear to be a
 * custody event, so the separation is pinned here rather than left to
 * review.
 *
 * The right rail is ONE shared authority for every tab. `Case` and `Due date`
 * used to live inside Review Workflow, which read as if they described the
 * workflow rather than the record; they are now their own `Attributes`
 * section. This file pins the four-section structure so a later tab cannot
 * quietly regroup or duplicate it.
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

const CUSTODY = read("app/(app)/evidence/[id]/_tabs/EvidenceCustodyTab.tsx");
const RAIL = read("app/(app)/evidence/[id]/_tabs/EvidenceRecordRail.tsx");
const PAGE = read("app/(app)/evidence/[id]/page.tsx");
const LIB = read("app/(app)/evidence/[id]/_tabs/_lib.tsx");
const CSS = read("app/(app)/evidence/[id]/evidence-detail.css");

/**
 * Prose is not code. "Must not survive" assertions run against the source
 * with comments stripped, so a JSDoc line that NAMES the retired thing (for
 * historical context) cannot fail the check that it is gone.
 */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}
const CUSTODY_CODE = code(CUSTODY);
const LIB_CODE = code(LIB);

// ---------------------------------------------------------------------------
// A) The two chronologies stay separate
// ---------------------------------------------------------------------------

test("Custody renders exactly two timelines, from two DIFFERENT event sources", () => {
  assert.match(CUSTODY, /events=\{workspace\.custodyLifecycle\.forensicEvents\}/);
  assert.match(CUSTODY, /events=\{workspace\.custodyLifecycle\.accessEvents\}/);

  // Exactly two timeline cards — never a third, never a merged one.
  const cards = CUSTODY.match(/<EventTimelineCard\b/g) ?? [];
  assert.equal(cards.length, 2, `expected 2 timeline cards, got ${cards.length}`);
});

test("the two event arrays are never concatenated into one list", () => {
  // Any of these would flatten the forensic lifecycle and read access into a
  // single chronology, which is exactly the thing this tab must not do.
  assert.doesNotMatch(CUSTODY, /forensicEvents\s*[,.]?\s*\.concat\(/);
  assert.doesNotMatch(CUSTODY, /\[\s*\.\.\.\s*workspace\.custodyLifecycle\.forensicEvents\s*,/);
  assert.doesNotMatch(CUSTODY, /accessEvents\s*\]\s*\.concat\(/);
});

test("each timeline is independently addressable and independently toned", () => {
  assert.match(CUSTODY, /testid="forensic"/);
  assert.match(CUSTODY, /testid="access"/);
  assert.match(CUSTODY, /tone="forensic"/);
  assert.match(CUSTODY, /tone="access"/);
  assert.match(CUSTODY, /data-evidence-timeline=\{testid\}/);
  assert.match(CUSTODY, /data-timeline-tone=\{tone\}/);
});

test("the access timeline is visually distinguishable from the forensic one", () => {
  // Forensic markers carry the purple accent; access markers are neutral.
  assert.match(CSS, /\.evidence-detail-chrono-marker\s*\{[\s\S]{0,240}background:\s*var\(--accent-500\)/);
  assert.match(
    CSS,
    /\[data-timeline-tone="access"\]\s*\.evidence-detail-chrono-marker\s*\{[\s\S]{0,120}background:\s*#98a2b3/i,
  );
});

// ---------------------------------------------------------------------------
// B) Grouping by day, and truthful counts
// ---------------------------------------------------------------------------

test("events are bucketed by calendar day from their own timestamp", () => {
  // The ISO date prefix is the day key; an event with no timestamp is
  // "Undated" rather than being silently dropped or dated to today.
  assert.match(CUSTODY, /const day = ev\.atUtc\?\.slice\(0, 10\) \|\| "Undated"/);
  assert.match(CUSTODY, /function groupByDay\(events: TimelineEvent\[\]\): DayGroup\[\]/);
  assert.match(CUSTODY, /data-chrono-day=\{group\.day\}/);
});

test("the day total is summed from the real per-type counts, not hardcoded", () => {
  assert.match(
    CUSTODY,
    /total:\s*Array\.from\(byType\.values\(\)\)\.reduce\(\(sum, b\) => sum \+ b\.count, 0\)/,
  );
  assert.match(CUSTODY, /\{group\.total\}\s*\{group\.total === 1 \? "event" : "events"\}/);
});

test("each row shows its own type count", () => {
  assert.match(CUSTODY, /count:\s*\(prev\?\.count \?\? 0\) \+ 1/);
  assert.match(CUSTODY, /&times;\s*\{row\.count\}/);
});

test("days are ordered newest first", () => {
  assert.match(CUSTODY, /\.sort\(\(a, b\) => \(a\[0\] < b\[0\] \? 1 : -1\)\)/);
});

// ---------------------------------------------------------------------------
// C) Raw events keep their disclosure behaviour
// ---------------------------------------------------------------------------

test("each timeline owns a SEPARATE raw-events disclosure", () => {
  // One <details> per card, rendered inside EventTimelineCard, so the two
  // cards can never share one disclosure.
  const details = CUSTODY_CODE.match(/<details\b/g) ?? [];
  assert.equal(details.length, 1, "raw disclosure must be defined once, inside the card");
  assert.match(CUSTODY, /data-evidence-raw-events=\{testid\}/);
});

test("the disclosure stays native <details>/<summary> — keyboard behaviour is not reimplemented", () => {
  assert.match(CUSTODY, /<summary className="evidence-detail-raw-summary">Show raw events<\/summary>/);
  // No hand-rolled toggle that would drop Enter/Space and focus semantics.
  assert.doesNotMatch(CUSTODY, /useState<boolean>\(\s*false\s*\)/);
  assert.doesNotMatch(CUSTODY, /onClick=\{\(\) => setShowRaw/);
});

test("the raw list still carries the full technical payload per event", () => {
  // Grouping is a readability default, not a redaction: the raw rows keep
  // the event type, the full timestamp and the payload summary.
  assert.match(CUSTODY, /\{event\.eventType\.replace\(\/_\/g, " "\)\}/);
  assert.match(CUSTODY, /\{formatUserDateTime\(event\.atUtc\) \?\? "Time not recorded"\}/);
  assert.match(CUSTODY, /\{event\.payloadSummary \|\| "No event summary recorded\."\}/);
});

test("the chevron affordance does not hide the native disclosure semantics", () => {
  assert.match(CSS, /\.evidence-detail-raw-disclosure > \.evidence-detail-raw-summary/);
  assert.match(CSS, /::-webkit-details-marker\s*\{\s*display:\s*none/);
});

// ---------------------------------------------------------------------------
// D) States fail closed — no fabricated activity
// ---------------------------------------------------------------------------

test("an empty timeline renders an explicit empty state, never an invented row", () => {
  assert.match(CUSTODY, /events\.length === 0 \? \(/);
  assert.match(CUSTODY, /data-evidence-timeline-empty=\{testid\}/);
  assert.match(CUSTODY, /No forensic custody events are recorded in the current response\./);
  assert.match(CUSTODY, /No access activity is recorded in the current response\./);
});

test("the raw-events control is not offered when there is nothing to disclose", () => {
  assert.match(CUSTODY, /\{events\.length > 0 \? \(\s*<details/);
});

test("the reviewer-ops timeline stays behind BOTH its capability and its tenant", () => {
  assert.match(
    CUSTODY,
    /canSeeReviewerOps && workspace\.reviewWorkflow\?\.teamId \? \(/,
  );
  assert.match(CUSTODY, /<OperationalTimelinePanel/);
});

// ---------------------------------------------------------------------------
// E) One component for Personal and Enterprise
// ---------------------------------------------------------------------------

test("Custody has no workspace-kind branch — both kinds render the same component", () => {
  assert.doesNotMatch(CUSTODY_CODE, /workspaceKind/);
  assert.doesNotMatch(CUSTODY_CODE, /isPersonal|personalSpace|orgKind/i);
  // The route mounts exactly one Custody tab, unconditionally on tab state.
  assert.match(PAGE, /activeTab === "custody" \? <EvidenceCustodyTab ctx=\{ctx\} \/> : null/);
});

// ---------------------------------------------------------------------------
// F) The shared rail: four semantic sections, defined once
// ---------------------------------------------------------------------------

test("the rail declares exactly four sections, in order", () => {
  const sides = [...RAIL.matchAll(/data-evidence-side="([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(sides, [
    "risk-signals",
    "operational-summary",
    "attributes",
    "public-verification-shortcut",
  ]);

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

test("Case and Due date live under Attributes, NOT under Review Workflow", () => {
  const attributes = RAIL.slice(
    RAIL.indexOf('data-evidence-side="attributes"'),
    RAIL.indexOf('data-evidence-side="public-verification-shortcut"'),
  );
  assert.match(attributes, />Case</);
  assert.match(attributes, />Due date</);

  const workflow = RAIL.slice(
    RAIL.indexOf('data-evidence-side="operational-summary"'),
    RAIL.indexOf('data-evidence-side="attributes"'),
  );
  assert.doesNotMatch(workflow, />Case</);
  assert.doesNotMatch(workflow, />Due date</);
  // Review Workflow keeps its own two facts.
  assert.match(workflow, /Operational summary/);
  assert.match(workflow, />Priority</);
});

test("the rail reuses the same projections — no field was added", () => {
  assert.match(RAIL, /workspace\.reviewWorkflow\.status/);
  assert.match(RAIL, /workspace\.reviewWorkflow\.priority/);
  assert.match(RAIL, /workspace\.relationships\.caseName/);
  assert.match(RAIL, /workspace\.reviewWorkflow\.dueAt/);
  assert.match(RAIL, /workspace\.publicVerificationSummary\.state/);
});

test("the rail is defined ONCE and mounted once — no tab-specific duplicate", () => {
  const mounts = PAGE.match(/<EvidenceRecordRail\b/g) ?? [];
  assert.equal(mounts.length, 1, "the rail must be mounted exactly once by the orchestrator");

  // No tab may grow a rail of its own.
  for (const tab of [
    "EvidenceOverviewTab",
    "EvidenceIntegrityTab",
    "EvidenceCustodyTab",
  ]) {
    const src = read(`app/(app)/evidence/[id]/_tabs/${tab}.tsx`);
    assert.doesNotMatch(src, /evidence-detail-sidebar/, `${tab} must not render a rail`);
    assert.doesNotMatch(src, /EvidenceRecordRail/, `${tab} must not mount the rail`);
  }
});

test("rail sections are visually separated", () => {
  assert.match(
    CSS,
    /\.evidence-detail-side-block\s*\{[\s\S]{0,320}border-block-start:\s*1px solid/,
  );
  assert.match(CSS, /\.evidence-detail-side-block:first-child\s*\{[\s\S]{0,120}border-block-start:\s*0/);
});

test("rail tones come from the real projection values, not from string sniffing", () => {
  assert.match(LIB, /export function getWorkflowStatusTone\(/);
  assert.match(LIB, /export function getPriorityTone\(/);
  assert.match(LIB, /export function getPublicVerificationTone\(/);
  assert.match(RAIL, /getWorkflowStatusTone\(workspace\.reviewWorkflow\.status\)/);
  assert.match(RAIL, /getPriorityTone\(workspace\.reviewWorkflow\.priority\)/);
});

// ---------------------------------------------------------------------------
// G) The old presentation is gone, not hidden
// ---------------------------------------------------------------------------

test("the superseded GroupedEventTimeline is removed from _lib and unreferenced", () => {
  assert.doesNotMatch(LIB_CODE, /GroupedEventTimeline/);
  assert.doesNotMatch(CUSTODY_CODE, /GroupedEventTimeline/);
});

test("Custody no longer borrows the generic section/row presentation", () => {
  for (const legacy of [
    "SectionHeading",
    "evidence-detail-section-header",
    "evidence-detail-item-row",
    "evidence-detail-timeline-item",
    "evidence-detail-timeline-dot",
  ]) {
    assert.doesNotMatch(
      CUSTODY_CODE,
      new RegExp(legacy.replace(/[-]/g, "\\-")),
      `${legacy} must not survive in the migrated Custody tab`,
    );
  }
});

test("no legacy Button/Card import and no inline palette in Custody", () => {
  assert.doesNotMatch(CUSTODY, /from "[^"]*components\/ui"/);
  assert.doesNotMatch(CUSTODY, /\bButton\b/);
  assert.doesNotMatch(CUSTODY, /\bCard\b/);
  // No inline styles at all, and therefore no inline hex.
  assert.doesNotMatch(CUSTODY, /style=\{\{/);
  assert.doesNotMatch(CUSTODY, /#[0-9a-fA-F]{3,8}\b/);
});

test("Custody declares no teal legacy colour", () => {
  assert.doesNotMatch(CUSTODY_CODE, /teal/i);
  const custodyCss = CSS.slice(CSS.indexOf(".evidence-detail-timeline-card"));
  assert.doesNotMatch(custodyCss, /--detail-teal/);
});

test("no italic operational text in the Custody surfaces", () => {
  assert.doesNotMatch(CUSTODY, /<em>|<i>|font-style:\s*italic/);
});

// ---------------------------------------------------------------------------
// H) One timeline anatomy, expressed with logical properties
// ---------------------------------------------------------------------------

test("day heads and event rows share ONE grid track definition", () => {
  assert.match(
    CSS,
    /\.evidence-detail-chrono-day__head,\s*\n\.evidence-detail-chrono-row\s*\{[\s\S]{0,200}grid-template-columns:\s*22px minmax\(0, 1fr\) auto/,
  );
});

test("the timeline uses logical properties so it mirrors in RTL", () => {
  const custodyCss = CSS.slice(CSS.indexOf(".evidence-detail-timeline-card"));
  // Rows are placed by grid tracks, never by a physical margin/float.
  assert.doesNotMatch(custodyCss, /margin-left:|margin-right:|float:/);
  assert.doesNotMatch(custodyCss, /\btext-align:\s*(left|right)\b/);
});

test("timestamps and day totals resolve their own direction inside an RTL page", () => {
  assert.match(
    CSS,
    /\.evidence-detail-chrono-row__time\s*\{[\s\S]{0,200}unicode-bidi:\s*plaintext/,
  );
  assert.match(
    CSS,
    /\.evidence-detail-chrono-day__total\s*\{[\s\S]{0,200}unicode-bidi:\s*plaintext/,
  );
});

test("mobile stacks the row deliberately instead of squeezing the desktop grid", () => {
  const mobile = CSS.slice(CSS.indexOf("@media (max-width: 560px)"));
  assert.match(mobile, /grid-template-columns:\s*22px minmax\(0, 1fr\)/);
  assert.match(mobile, /\.evidence-detail-chrono-row__time/);
  assert.match(mobile, /grid-column:\s*2/);
});
