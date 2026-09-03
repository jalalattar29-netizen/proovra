/**
 * THE FIVE CONTRACTS THIS PASS ADDED.
 *
 * Each is a decision that is invisible in a screenshot a week later: which
 * token a metric resolves to, whether a colour is keyed by category or by
 * position, whether a range selector offers what it claims to. The pixels are
 * measured in the browser projects; these pin the reasons.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { KPI_VOCABULARY } from "../lib/intake-links/vocabulary";
import { ACTIVITY_RANGES } from "../components/home-experience/home-view-model";
import { ANALYTICS_PALETTE } from "../components/home-experience/home-theme";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(resolve(APP, rel), "utf8");

/**
 * Source with its comments removed.
 *
 * These files EXPLAIN the things they no longer do — a comment naming a retired
 * `<select>` is prose about an element, not the element, and an assertion that
 * cannot tell the two apart fails on the explanation it asked for.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const SETTINGS_CSS = read("app/(app)/settings/settings.css");
const INTAKE_CSS = read("app/(app)/intake-links/intake-links.css");
const REPORTS_CSS = read("components/reports-experience/reports.css");
const REPORTS_INDEX = read("components/reports-experience/ReportsIndex.tsx");
const HOME_CSS = read("components/home-experience/home.css");
const DONUT = read("components/home-experience/AnnotatedDonut.tsx");
const DASH = read("components/home-experience/HomeDashboardSections.tsx");
const SECTIONS = read("components/home-experience/HomeSections.tsx");

// ===========================================================================
// 1. SETTINGS — the white rectangle behind the hovered label
// ===========================================================================

test("the sign-out button owns its background; its children do not", () => {
  /*
   * The defect: one rule set `background: var(--set-panel-solid)` — solid
   * #ffffff — on the button AND on `*`. At rest both agree. On hover only the
   * BUTTON repaints, so the label span kept its own opaque white and sat on
   * top of the hover tint as a rectangle exactly the width of the text.
   */
  const childRule = SETTINGS_CSS.slice(
    SETTINGS_CSS.indexOf(".settings-page-shell .set-main [data-cc-revoke-others] * {"),
  );
  const childDecls = childRule.slice(0, childRule.indexOf("}"));
  assert.match(
    childDecls,
    /background: transparent/,
    "a child painting an opaque background is the artifact itself",
  );
  assert.doesNotMatch(childDecls, /--set-panel-solid/);

  // The button still paints, and hover still changes it.
  assert.match(
    SETTINGS_CSS,
    /\[data-cc-revoke-others\] \{\s*background: var\(--set-panel-solid\)/,
  );
  assert.match(
    SETTINGS_CSS,
    /\[data-cc-revoke-others\]:hover:not\(:disabled\) \{[^}]*background: var\(--set-danger-soft\)/,
  );
});

// ===========================================================================
// 2. INTAKE LINKS — the two metric tones
// ===========================================================================

test("Total links leads in the brand accent and Active is the attention orange", () => {
  assert.equal(KPI_VOCABULARY.total.tone, "indigo", "the headline count, in brand purple");
  assert.equal(KPI_VOCABULARY.active.tone, "orange", "attention, not brand");

  // …and those tone names resolve to the canonical values, not new literals.
  assert.match(
    INTAKE_CSS,
    /--ilk-tone-indigo: var\(--accent-600\)/,
    "indigo IS the brand purple, by reference",
  );
  assert.match(
    INTAKE_CSS,
    /--ilk-tone-orange: var\(--orange-500\)/,
    "orange IS the Notifications High value, by reference",
  );
  assert.match(INTAKE_CSS, /\[data-ilk-tone="orange"\] \{\s*--ilk-tone: var\(--ilk-tone-orange\)/);

  // The retired burnt orange must not be what `orange` means here.
  assert.doesNotMatch(INTAKE_CSS, /--ilk-tone-orange:\s*#?[cC]2410[cC]/);
});

// ===========================================================================
// 3. REPORTS — pending is attention, and amber keeps its own job
// ===========================================================================

test("Reports pending takes the shared attention orange", () => {
  assert.match(
    REPORTS_INDEX,
    /key: "reports_pending"[^}]*tone: "orange"/,
    "pending must not sit on the caution amber",
  );
  assert.match(
    REPORTS_CSS,
    /\[data-rpt-tone="orange"\] \{\s*--rpt-tone: var\(--tone-orange\)/,
  );
  // Amber still exists and still means what it meant — this added a tone, it
  // did not redefine one under its existing users.
  assert.match(REPORTS_CSS, /\[data-rpt-tone="amber"\] \{\s*--rpt-tone: var\(--tone-amber\)/);
  // The other states are untouched.
  assert.match(REPORTS_INDEX, /key: "reports_ready"[^}]*tone: "blue"/);
  assert.match(REPORTS_INDEX, /key: "packages_blocked"[^}]*tone: "red"/);
});

// ===========================================================================
// 4. HOME OVERVIEW — the row shares a footline
// ===========================================================================

test("the overview row stretches on desktop and is content-driven on a phone", () => {
  const grid = HOME_CSS.slice(HOME_CSS.indexOf(".self-serve-home .home-overview-grid {"));
  assert.match(
    grid.slice(0, grid.indexOf("}")),
    /align-items: stretch/,
    "the grid harmonises the row; a card never states a height",
  );
  // No hand-typed height anywhere in the attention card's rules.
  const attn = HOME_CSS.slice(HOME_CSS.indexOf(".self-serve-home .home-attn {"));
  assert.doesNotMatch(
    attn.slice(0, attn.indexOf("}")),
    /min-height|height:/,
    "padding a card to a fixed height is the thing this must not become",
  );
  // One column has no neighbour to match, so it returns to its content.
  const mobile = HOME_CSS.slice(HOME_CSS.indexOf("@media (max-width: 860px)"));
  assert.match(mobile.slice(0, 300), /align-items: start/);
});

// ===========================================================================
// 5. ANALYTICS
// ===========================================================================

test("the range selector offers exactly the four periods, with sane buckets", () => {
  assert.deepEqual(
    ACTIVITY_RANGES.map((r) => r.label),
    ["Last 14 days", "Last month", "Last 3 months", "Last 6 months"],
  );
  // A range is a window AND a bucket: 182 daily columns is not a chart.
  for (const r of ACTIVITY_RANGES) {
    const columns = Math.ceil(r.days / r.bucketDays);
    assert.ok(
      columns <= 31,
      `${r.label} would render ${columns} columns — unreadable on a card`,
    );
    assert.ok(columns >= 7, `${r.label} would render only ${columns} columns`);
  }
  // The wider ranges group; the short ones stay daily.
  assert.equal(ACTIVITY_RANGES[0]!.bucketDays, 1);
  assert.equal(ACTIVITY_RANGES[1]!.bucketDays, 1);
  assert.ok(ACTIVITY_RANGES[2]!.bucketDays > 1);
  assert.ok(ACTIVITY_RANGES[3]!.bucketDays > ACTIVITY_RANGES[2]!.bucketDays);
});

test("a category's colour is keyed by NAME, so a missing type shifts nothing", () => {
  const map = DASH.slice(DASH.indexOf("const DONUT_COLOR_BY_KEY"));
  const body = map.slice(0, map.indexOf("};"));
  for (const key of ["images", "documents", "videos", "audio", "archives"]) {
    assert.ok(body.includes(`${key}:`), `${key} must have its own entry`);
  }
  // Never by index — that is what makes a workspace with no audio paint
  // documents in the videos colour.
  assert.doesNotMatch(body, /\[\s*index\s*\]|slices\[/);
  // An unknown key takes a neutral rather than another category's colour.
  assert.match(
    DASH,
    /DONUT_COLOR_BY_KEY\[key\.toLowerCase\(\)\] \?\? "#94A3B8"/,
    "an unrecognised type must not borrow the archives orange",
  );

  // Five hues, not five shades of one.
  const five = [
    ANALYTICS_PALETTE.images,
    ANALYTICS_PALETTE.documents,
    ANALYTICS_PALETTE.videos,
    ANALYTICS_PALETTE.audio,
    ANALYTICS_PALETTE.archives,
  ];
  assert.equal(new Set(five).size, 5, "every category needs its own colour");
  assert.equal(
    ANALYTICS_PALETTE.archives.toUpperCase(),
    "#EA580C",
    "archives takes the shared attention orange",
  );
});

test("the donut draws truthful arcs, separated, and labels them from the data", () => {
  // The gap is taken OFF an arc and can never exceed it — a 1% slice must not
  // invert into a negative sweep.
  assert.match(DONUT, /Math\.min\(GAP_DEG, sweep \* 0\.6\)/);
  // Arc length is the share, always. No minimum is imposed on the geometry.
  assert.match(DONUT, /const sweep = \(s\.count \/ sum\) \* 360;/);
  // What makes a tiny slice findable is the cap, not a padded angle.
  assert.match(DONUT, /strokeLinecap="round"/);
  // Labels are computed from each slice's own mid-angle.
  assert.match(DONUT, /const anchor = polar\(mid, LEAVE\)/);
  assert.doesNotMatch(DONUT, /123|73%|Images"/, "no sample value may be baked in");
  // Same-side labels are pushed apart rather than allowed to collide.
  assert.match(DONUT, /function spread\(/);
  assert.match(DONUT, /LABEL_PITCH/);
});

test("the Records / Preserved files switch survives, and both modes share one chart", () => {
  assert.match(DASH, /data-evidence-types-tab="records"/);
  assert.match(DASH, /data-evidence-types-tab="files"/);
  // ONE component renders both — the old list is not a fallback for either.
  const uses = DASH.match(/<AnnotatedDonut/g) ?? [];
  assert.equal(uses.length, 1, "one chart, parameterised by mode");
  assert.match(DASH, /centreLabel=\{isFilesMode \? "Files" : "Records"\}/);
});

test("an activity row carries a glyph for its kind, and the same one every time", () => {
  const map = SECTIONS.slice(SECTIONS.indexOf("const ACTIVITY_GLYPH"));
  const body = map.slice(0, map.indexOf("};"));
  for (const kind of [
    "evidence_finalized",
    "report_generated",
    "package_generated",
    "verification_published",
    "hold_placed",
    "destruction_review",
    "incident_opened",
  ]) {
    assert.ok(body.includes(`${kind}:`), `${kind} needs its own glyph`);
  }
  // Deterministic: a lookup by kind, never a rotation or a hash.
  assert.match(SECTIONS, /return ACTIVITY_GLYPH\[kind\] \?\? null;/);
  // The colour table it pairs with is keyed the same way.
  assert.match(SECTIONS, /function activityDot\(kind: string\): string/);
  // The count marker stays a marker.
  assert.match(HOME_CSS, /\.home-act__count \{[^}]*color-mix\(in srgb, currentColor 10%/);
});

// ===========================================================================
// 6. THE ONBOARDING CARD, THE PERIOD CONTROL, AND UNREAD
// ===========================================================================

test("the empty-state card offers two first steps as real buttons", () => {
  const card = SECTIONS.slice(SECTIONS.indexOf("export function GettingStartedChecklist("));
  const body = card.slice(0, card.indexOf("\n// ====="));

  // The checklist is gone: no tick-boxes, no line-through, no done-state paint.
  assert.doesNotMatch(body, /✓/, "a tick-box makes the card read as state");
  assert.doesNotMatch(body, /lineThrough|line-through/);
  assert.doesNotMatch(body, /visible\.map\(/, "four rows is what this replaced");

  // Two actions, and only the two a new workspace can actually do. "Generate
  // report" needs a record; "Share verification" pointed at the empty list the
  // reader just came from.
  assert.match(body, /capture_first/);
  assert.match(body, /create_first_case/);
  assert.doesNotMatch(body, /first_report|share_verification/);

  // The product's own primitives, not a local button.
  assert.match(body, /className="app-primary-action"/);
  assert.match(body, /className="app-secondary-action"/);
  // Hrefs still come from the projection, so the card cannot drift from it.
  assert.match(body, /href=\{capture\.href\}/);
  assert.match(body, /href=\{createCase\.href\}/);
});

test("the period control is the shared listbox, not a native select", () => {
  assert.match(DASH, /<AppListbox/, "the canonical selector");
  // Comments stripped first: this file EXPLAINS why a native select was wrong,
  // and prose about a retired element is not the element.
  const chartCode = stripComments(
    DASH.slice(DASH.indexOf("export function EvidenceActivityChart(")),
  );
  assert.doesNotMatch(
    chartCode,
    /<select/,
    "a native select paints the host OS's control and its own blue highlight",
  );
  // Its options come from the same table the aggregation reads.
  assert.match(DASH, /const RANGE_OPTIONS = ACTIVITY_RANGES\.map\(/);
  // The accessible name survives the loss of the visible <label>.
  assert.match(DASH, /ariaLabel="Activity period"/);
  // And the subtitle no longer repeats what the trigger already says.
  const header = DASH.slice(DASH.indexOf("<h2 style={activityTitleStyle}>"));
  assert.doesNotMatch(
    header.slice(0, 700),
    /\{range\.label\}/,
    "the selected range must not be printed twice",
  );
});

test("Unread is the informational blue, not the brand purple", () => {
  const NOTIF = read("components/notifications/notifications.css");
  assert.match(
    NOTIF,
    /\[data-ops-metric-tone="unread"\]\s*\{ --app-metric-tone: var\(--info\); \}/,
  );
  // The other tones on that strip are untouched by this pass.
  assert.match(NOTIF, /\[data-ops-metric-tone="high"\]\s*\{ --app-metric-tone: var\(--orange-500\); \}/);
  assert.match(NOTIF, /\[data-ops-metric-tone="critical"\]\s*\{ --app-metric-tone: var\(--error\); \}/);
  assert.match(NOTIF, /\[data-ops-metric-tone="warning"\]\s*\{ --app-metric-tone: var\(--accent-600\); \}/);
});
