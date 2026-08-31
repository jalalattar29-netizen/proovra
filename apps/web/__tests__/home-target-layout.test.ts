/**
 * HOME — the structural contracts of the redesigned workspace views.
 *
 * These assert SHAPE, not pixels: which element owns a decision, whether a
 * card holds rows or a grid of tinted tiles, whether the view switcher is in
 * normal flow. The visual comparison against the reference is done by
 * rendering the page; a unit test that pinned colours or byte counts would
 * fail on every legitimate design change and prove nothing about layout.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(resolve(APP, rel), "utf8");

const DASH = read("components/home-experience/SelfServeHomeDashboard.tsx");
const SECTIONS = read("components/home-experience/HomeSections.tsx");
const CARDS = read("components/home-experience/HomeDashboardSections.tsx");
const HOME_CSS = read("components/home-experience/home.css");
const SHELL_CSS = read("components/app-shell-v2/app-shell-v2.css");

/** CSS with comments stripped — prose about a retired rule is not a rule. */
const live = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

// ------------------------------------------------------------------ NAV

test("the view switcher is in normal flow, on every stylesheet that touches it", () => {
  // THE DEFECT: `.home-tabs { position: sticky; top: var(--header-h) }` in
  // the shell stylesheet. The switcher detached and rode the viewport down
  // the page, floating over the cards it introduces.
  const shellRule = live(SHELL_CSS).slice(
    live(SHELL_CSS).indexOf(".home-tabs {"),
  );
  const shellBlock = shellRule.slice(0, shellRule.indexOf("}"));
  assert.doesNotMatch(
    shellBlock,
    /position:\s*sticky|position:\s*fixed/,
    ".home-tabs must not be stuck to the viewport",
  );
  assert.doesNotMatch(shellBlock, /top:\s*var\(--header-h/);

  // …and Home re-states it, so a future sticky rule elsewhere cannot win.
  assert.match(
    live(HOME_CSS),
    /\.home-tabs \{[\s\S]{0,200}position: static/,
    "Home must assert normal flow for its own switcher",
  );
});

test("the switcher keeps its tab semantics and keyboard affordance", () => {
  assert.match(DASH, /role="tablist"/);
  assert.match(DASH, /role="tab"\n?\s*aria-selected=\{tab === t\.id\}/);
  assert.match(DASH, /role="tabpanel"/);
  assert.match(
    live(HOME_CSS),
    /\.home-tab\[aria-selected="true"\]:focus-visible \{[\s\S]{0,120}box-shadow/,
    "the selected tab must keep a visible focus ring",
  );
});

test("the selected tab is a light fill with dark text, not a solid slab", () => {
  const block = live(HOME_CSS).slice(
    live(HOME_CSS).indexOf('.home-tab[aria-selected="true"] {'),
  );
  const rule = block.slice(0, block.indexOf("}"));
  assert.match(rule, /background: var\(--home-info-soft\)/);
  assert.match(rule, /color: var\(--home-ink\)/, "the label stays dark");
  assert.doesNotMatch(rule, /#fff|#FFF|white/, "the label is never reversed out");
});

// -------------------------------------------------------------- OVERVIEW

test("the critical banner is a white card with a red rail, not a dark hero", () => {
  // It was `.ops-banner-card` — a dark navy surface with the PROOVRA mark as
  // artwork and a reserved column for it.
  assert.doesNotMatch(
    CARDS,
    /ops-banner-card/,
    "the dark banner shell must be gone from Home",
  );
  assert.match(CARDS, /className="home-alert"/);
  assert.match(CARDS, /className="home-alert__action"/);

  const alert = live(HOME_CSS).slice(live(HOME_CSS).indexOf(".home-alert {"));
  const rule = alert.slice(0, alert.indexOf("}"));
  assert.match(rule, /background: var\(--home-card\)/, "the surface is white");
  assert.match(rule, /border-inline-start: 4px solid var\(--home-bad\)/);

  // The action is OUTLINED. A filled red slab reads as the page's primary
  // action and pulls the eye off the record it is about.
  const act = live(HOME_CSS).slice(live(HOME_CSS).indexOf(".home-alert__action {"));
  const actRule = act.slice(0, act.indexOf("}"));
  assert.match(actRule, /background: var\(--home-card\)/);
  assert.match(actRule, /color: var\(--home-bad\)/);
});

test("the banner still renders every part of the decision it is given", () => {
  for (const hook of [
    "data-exec-status={summary.overallStatus}",
    "data-exec-status-chip",
    "data-exec-title",
    "data-exec-sentence",
    "data-exec-secondary",
    "data-exec-action",
  ]) {
    assert.ok(CARDS.includes(hook), `the banner must keep ${hook}`);
  }
});

test("the KPI band is five equal cards with per-position hues", () => {
  assert.match(CARDS, /data-home-kpi-index=\{index\}/);
  const css = live(HOME_CSS);
  for (let i = 0; i < 5; i += 1) {
    assert.match(
      css,
      new RegExp(`\\.home-kpi\\[data-home-kpi-index="${i}"\\]`),
      `KPI position ${i} must have its own surface`,
    );
  }
  assert.match(
    live(SHELL_CSS),
    /\.home-kpi-grid \{[\s\S]{0,200}grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/,
    "five equal columns",
  );
  assert.match(
    live(HOME_CSS),
    /\.home-kpi \{[\s\S]{0,300}min-height: 168px/,
    "equal height, so no card is short",
  );
});

test("Workspace Health is a list of rows, not a grid of tinted tiles", () => {
  // Every metric used to sit in its own filled, rounded cell in a 2-column
  // grid: eight little cards for eight numbers.
  const card = SECTIONS.slice(SECTIONS.indexOf("export function WorkspaceHealthCard("));
  const body = card.slice(0, card.indexOf("\nconst HEALTH_ROW_TONE"));
  assert.match(body, /className="home-rows"/);
  assert.match(body, /className="home-row"/);
  assert.doesNotMatch(
    body,
    /gridTemplateColumns: "repeat\(2, 1fr\)"/,
    "the two-column tile grid must be gone",
  );
  // The tone moved into the VALUE, where a number's meaning belongs.
  assert.match(body, /className="home-row__value"\n?\s*data-tone=/);
  // …and the per-metric contract is unchanged.
  assert.match(body, /data-health-metric=\{m\.key\}/);
  assert.match(body, /data-health-tone=\{m\.tone\}/);
});

test("What Needs Attention is a clean list with the pill on the right", () => {
  assert.match(CARDS, /className="home-attn"/);
  assert.match(CARDS, /className="home-attn__item"/);
  assert.match(CARDS, /className="home-attn__pill"/);
  // Order in the DOM: title, then pill, then description, then action —
  // the pill is placed by grid, not by sitting before the title.
  const item = CARDS.slice(CARDS.indexOf('className="home-attn__item"'));
  const titleAt = item.indexOf("home-attn__title");
  const pillAt = item.indexOf("home-attn__pill");
  assert.ok(titleAt < pillAt, "the title leads the row, not the severity chip");
  assert.match(
    live(HOME_CSS),
    /\.home-attn__pill \{[\s\S]{0,300}grid-column: 2/,
    "the pill is aligned to the right column",
  );
  // Severity and links are unchanged.
  assert.match(CARDS, /data-priority-severity=\{p\.severity\}/);
  assert.match(CARDS, /data-priority-action=\{p\.key\}/);
});

test("the Overview body is one three-column row under two headings", () => {
  assert.match(DASH, /className="home-overview-heads"/);
  assert.match(DASH, /className="home-overview-grid"/);
  assert.match(DASH, /What needs you now/);
  assert.match(DASH, /Your recent work/);
  // Recent evidence and matters stack in the third column.
  const grid = DASH.slice(DASH.indexOf('className="home-overview-grid"'));
  const col = grid.slice(grid.indexOf('className="home-overview-col"'));
  const evAt = col.indexOf("RecentEvidenceCard");
  const amAt = col.indexOf("ActiveMatters");
  assert.ok(evAt >= 0 && amAt > evAt, "Active Matters sits under Recent Evidence");
  assert.match(
    live(HOME_CSS),
    /\.home-overview-grid \{[\s\S]{0,260}grid-template-columns: minmax\(0, 0\.85fr\) minmax\(0, 1\.15fr\) minmax\(0, 1fr\)/,
    "three columns on the desktop reference",
  );
});

// ------------------------------------------------------------ OPERATIONS

test("Operations keeps its four cards in two balanced rows", () => {
  const panel = DASH.slice(DASH.indexOf('data-home-tabpanel="operations"'));
  const ops = panel.slice(0, panel.indexOf('data-home-tabpanel="analytics"'));
  for (const card of [
    "VerificationHealthCard",
    "TrustStateCard",
    "ReportProductionCard",
    "IntakePipelineCard",
  ]) {
    assert.ok(ops.includes(card), `${card} must remain on Operations`);
  }
  assert.match(ops, /className="home-ops-row"/);
  assert.match(ops, /className="home-ops-row-2"/);
});

test("the verification summary colours values, not whole rows", () => {
  const card = SECTIONS.slice(SECTIONS.indexOf('testId="trust-state"'));
  const body = card.slice(0, card.indexOf("</SectionCard>"));
  assert.match(body, /className="home-rows"/);
  assert.match(body, /className="home-row__value" style=\{\{ color: ts\.value \}\}/);
  // The full-bleed tinted row + matching border are gone.
  assert.doesNotMatch(body, /background: ts\.bg/);
  assert.doesNotMatch(body, /border: `1px solid \$\{ts\.border\}`/);
  // The legal boundary survives, in its own quiet strip, unchanged in wording.
  assert.match(body, /className="home-note"/);
  assert.match(
    body,
    /PROOVRA records integrity signals; it does not determine factual truth or legal admissibility\./,
  );
});

// -------------------------------------------------------------- ANALYTICS

test("the donut is a chart, not a thumbnail", () => {
  // It was pinned to 128x128 — a 96px ring carrying five categories.
  assert.match(CARDS, /className="home-donut"\n?\s*width="260"/);
  assert.match(
    live(HOME_CSS),
    /\.home-donut \{[\s\S]{0,140}inline-size: min\(100%, 260px\)/,
    "it must scale down rather than overflow a phone",
  );
  // The geometry it draws is untouched.
  assert.match(CARDS, /viewBox="0 0 128 128"/);
});

test("the type switch is a light selected state, never a dark one", () => {
  const sw = live(HOME_CSS).slice(
    live(HOME_CSS).indexOf('.home-switch__btn[aria-pressed="true"] {'),
  );
  const rule = sw.slice(0, sw.indexOf("}"));
  assert.match(rule, /background: var\(--home-info-soft\)/);
  assert.match(rule, /color: var\(--home-ink\)/);
});

test("the activity feed marks each row by event TYPE and keeps truthful grouping", () => {
  const feed = SECTIONS.slice(SECTIONS.indexOf("export function ActivityFeed("));
  // The empty-state branch closes its own SectionCard first, so the populated
  // body is what follows the LAST one inside this component.
  const body = feed.slice(0, feed.indexOf("export function", 10));
  assert.match(body, /className="home-act__icon"/);
  assert.match(body, /const tone = activityDot\(e\.kind\)/, "colour comes from the existing type table");
  assert.match(body, /data-activity-kind=\{e\.kind\}/);
  // The count badge appears ONLY where the data actually collapsed repeats.
  assert.match(body, /e\.repeatCount && e\.repeatCount > 1/);
  assert.match(body, /data-activity-repeat=\{e\.repeatCount\}/);
  // The old single-colour rail is gone.
  assert.doesNotMatch(body, /borderLeft: "2px solid rgba\(15,23,42,0\.07\)"/);
});

test("the activity card keeps its honest empty state", () => {
  const feed = SECTIONS.slice(SECTIONS.indexOf("export function ActivityFeed("));
  assert.match(
    feed.slice(0, 600),
    /groups\.length === 0[\s\S]{0,400}EmptyState/,
    "no data must render the empty state, never fabricated rows",
  );
});

// ----------------------------------------------------------------- SCOPE

test("Home styles reach Home only", () => {
  // Every rule is scoped, so this stylesheet cannot repaint another route.
  for (const line of live(HOME_CSS).split("\n")) {
    const t = line.trim();
    if (!t.endsWith("{") || t.startsWith("@") || t.startsWith("/*")) continue;
    if (t.startsWith(":root")) continue;
    assert.ok(
      t.includes(".self-serve-home"),
      `unscoped Home rule: ${t}`,
    );
  }
});

test("the page background belongs to the app shell, not to Home", () => {
  // The reference images are transparent outside the cards; that is the
  // viewer, not a black page. Home must not paint a page background.
  assert.doesNotMatch(
    live(HOME_CSS),
    /\.self-serve-home \{[^}]*background:\s*(#0|black|rgb\(0)/i,
    "Home must never set a dark page background",
  );
});
