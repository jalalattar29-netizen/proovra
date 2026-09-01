/**
 * ONE colour authority, across Home, Operations, Billing and Settings.
 *
 * The product had four palettes describing the same states. `HOME_COLORS`
 * wrote `warn: #d97706`, `HOME_SEMANTIC` wrote `amber.strong: #A86612`,
 * settings.css wrote `--set-warn: #b54708`, and Operations resolved a High
 * incident through the shared `AppTone` vocabulary to `--orange-ink`
 * (#C2410C). Four oranges, none of them wrong locally, all of them wrong
 * together: the same urgency changed colour by moving between pages.
 *
 * The tone vocabulary is the authority. `AppStatusText` maps it:
 *
 *   orange -> --orange-ink       red   -> --error
 *   blue   -> --info             green -> --success-standard
 *   ink    -> --ink-primary
 *
 * These tests pin that every surface asks the vocabulary rather than mixing
 * its own hue, and that the statuses named in the brief are TEXT rather than
 * capsules.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(resolve(APP, rel), "utf8");

const PRIMITIVES = read("components/app-primitives/app-primitives.css");
const TOKENS = read("lib/design-tokens/tokens.css");
const OPS_VOCAB = read("app/(app)/operations/_lib/vocabulary.ts");
const HOME_THEME = read("components/home-experience/home-theme.ts");
const HOME_CSS = read("components/home-experience/home.css");
const HOME_SECTIONS = read("components/home-experience/HomeSections.tsx");
const SETTINGS_CSS = read("app/(app)/settings/settings.css");
const BILLING_CSS = read("app/(app)/billing/billing.css");
const CASES_CSS = read("components/cases-experience/cases-experience.css");
const CONFIRM = read("components/ui/ConfirmActionModal.tsx");

const stripCss = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const stripTs = (s: string) =>
  s
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
    .join("\n");

// --------------------------------------------------------------- THE SOURCE

test("the tone vocabulary resolves to the canonical tokens", () => {
  const css = stripCss(PRIMITIVES);
  assert.match(css, /\.app-status-text\[data-tone="orange"\][^}]*var\(--orange-ink\)/);
  assert.match(css, /\.app-status-text\[data-tone="red"\][^}]*var\(--error\)/);
  assert.match(css, /\.app-status-text\[data-tone="blue"\][^}]*var\(--info\)/);
  // …and those tokens have exactly one definition each.
  assert.match(TOKENS, /--orange-ink: #C2410C;/);
  assert.match(TOKENS, /--error: #DC2626;/);
  assert.match(TOKENS, /--info: #2563EB;/);
  assert.match(TOKENS, /--success-standard: #15803D;/);
  assert.match(TOKENS, /--ink-primary: #0F172A;/);
});

test("Operations High is the orange reference, and Overdue is informational", () => {
  // The reference the brief names: High -> tone orange -> --orange-ink.
  assert.match(OPS_VOCAB, /HIGH: "orange"/);
  assert.match(OPS_VOCAB, /CRITICAL: "red"/);
  // Overdue is a timing fact, not a failure — changed in the ONE table so the
  // SLA badge and the Overdue card cannot disagree, which is what this file's
  // own header records happening last time.
  assert.match(OPS_VOCAB, /OVERDUE: "blue"/);
  assert.doesNotMatch(OPS_VOCAB, /OVERDUE: "red"/);
});

// ----------------------------------------------------------------- NO MIXING

test("no surface mixes its own hue for a state the vocabulary names", () => {
  const RETIRED: Array<[string, string]> = [
    ["#d97706", "amber-600 — not the Operations orange"],
    ["#A86612", "the brown that made Home's pending states muddy"],
    ["#B9383E", "the muted rose that stood in for critical"],
    ["#167A5B", "a teal-green against --success-standard"],
    ["#b54708", "the Settings warning brown"],
    ["#b42318", "the Settings/Home dark red"],
    ["#B45309", "the amber used where the orange belongs"],
  ];
  const live = [
    ["home-theme.ts", stripTs(HOME_THEME)],
    ["home.css", stripCss(HOME_CSS)],
    ["settings.css", stripCss(SETTINGS_CSS)],
  ] as const;

  for (const [name, src] of live) {
    for (const [hex, why] of RETIRED) {
      assert.ok(
        !src.toLowerCase().includes(hex.toLowerCase()),
        `${name} still uses ${hex} (${why})`,
      );
    }
  }
});

test("Home reads the tokens, not its own palette", () => {
  const t = stripTs(HOME_THEME);
  assert.match(t, /warn: "var\(--orange-ink, #C2410C\)"/);
  assert.match(t, /danger: "var\(--error, #DC2626\)"/);
  assert.match(t, /ok: "var\(--success-standard, #15803D\)"/);
  assert.match(t, /action: "var\(--info, #2563EB\)"/);
  // The Operations-tab semantic table too.
  assert.match(t, /amber: \{\s*strong: "var\(--orange-ink, #C2410C\)"/);
  assert.match(t, /critical: \{\s*strong: "var\(--error, #DC2626\)"/);
  assert.match(t, /info: \{[\s\S]{0,120}strong: "var\(--info, #2563EB\)"/);

  const css = stripCss(HOME_CSS);
  assert.match(css, /--home-warn: var\(--orange-ink/);
  assert.match(css, /--home-bad: var\(--error/);
  assert.match(css, /--home-action: var\(--info/);
  assert.match(css, /--home-ok: var\(--success-standard/);
  assert.match(css, /--home-ink: var\(--ink-primary/);
});

test("every Home inline action is the one blue", () => {
  // "Open verify", "Open reports", "View intake", "Open matter" all came
  // through HOME_ACCENT.ink (#6D28D9) or HOME_COLORS.indigo, so Home's links
  // were violet while the same affordance on Notifications is blue.
  assert.match(HOME_SECTIONS, /color: HOME_COLORS\.action/);
  assert.doesNotMatch(HOME_SECTIONS, /color: HOME_COLORS\.indigo/);
  assert.doesNotMatch(HOME_SECTIONS, /color: HOME_ACCENT\.ink/);
  // The shared inline-action class resolves to the same blue.
  assert.match(
    stripCss(HOME_CSS),
    /\.home-link \{[\s\S]{0,320}color: var\(--home-action\)/,
  );
});

// ------------------------------------------------------------- NO CAPSULES

test("the statuses named in the brief are text, not capsules", () => {
  const css = stripCss(HOME_CSS);
  // CRITICAL / WARNING beside an attention item.
  const pill = css.slice(css.indexOf(".home-attn__pill {"));
  const pillRule = pill.slice(0, pill.indexOf("}"));
  assert.match(pillRule, /background: none/);
  assert.match(pillRule, /padding: 0/);
  assert.match(pillRule, /border-radius: 0/);

  // "Live" / "Report ready" / "Package ready".
  const badge = css.slice(css.indexOf(".home-badge {"));
  const badgeRule = badge.slice(0, badge.indexOf("}"));
  assert.match(badgeRule, /background: none/);
  assert.match(badgeRule, /border-radius: 0/);

  // The trailing state on a recent-evidence row.
  const trail = css.slice(css.indexOf(".home-list__trail {"));
  assert.match(trail.slice(0, trail.indexOf("}")), /background: none/);
});

test("titles stay navy; severity is stated beside them", () => {
  const css = stripCss(HOME_CSS);
  assert.match(css, /\.home-attn__title \{[\s\S]{0,120}color: var\(--home-ink\)/);
  assert.match(css, /\.home-list__title \{[\s\S]{0,120}color: var\(--home-ink\)/);
});

// ---------------------------------------------------------------- THE TABS

test("the Home switcher is the Cases strip, value for value", () => {
  const home = stripCss(HOME_CSS);
  const cases = stripCss(CASES_CSS);

  const block = (src: string, sel: string) => {
    const at = src.indexOf(sel);
    assert.ok(at > 0, `${sel} must exist`);
    return src.slice(at, src.indexOf("}", at));
  };

  // Container.
  const hTabs = block(home, ".self-serve-home .home-tabs {");
  const cSeg = block(cases, ".cases-segments {");
  for (const decl of [
    "gap: 6px",
    "padding: 4px",
    "min-height: 44px",
    "border-radius: 14px",
    "border: 1px solid rgba(15, 23, 42, 0.06)",
    "background: rgba(255, 255, 255, 0.42)",
  ]) {
    assert.ok(cSeg.includes(decl), `the Cases strip must declare ${decl}`);
    assert.ok(hTabs.includes(decl), `Home must match the Cases strip on ${decl}`);
  }

  // Chip.
  const hTab = block(home, ".self-serve-home .home-tab {");
  // The selector appears twice in cases-experience.css — once for `flex: none`
  // and once for the metrics. Take the block that carries the height.
  const chipAt = cases.indexOf(".cases-segments .cases-filter-chip {", cases.indexOf(".cases-segments .cases-filter-chip {") + 1);
  const cChip = cases.slice(chipAt, cases.indexOf("}", chipAt));
  for (const decl of [
    "height: 36px",
    "padding: 0 14px",
    "border-radius: 10px",
    "font-size: 13px",
    "font-weight: 600",
  ]) {
    assert.ok(cChip.includes(decl), `the Cases chip must declare ${decl}`);
    assert.ok(hTab.includes(decl), `Home must match the Cases chip on ${decl}`);
  }
  assert.ok(cChip.includes("#5F6878") && hTab.includes("#5f6878"));

  // Active language.
  const hActive = block(home, '.self-serve-home .home-tab[aria-selected="true"] {');
  assert.ok(hActive.includes("#f2ecfe") && hActive.includes("#d9c7fb") && hActive.includes("#6d28d9"));
  // And the switcher is still in normal flow.
  assert.match(home, /\.self-serve-home \.home-tabs \{[\s\S]{0,200}position: static/);
});

// -------------------------------------------------------- SETTINGS / BILLING

test("Settings semantics resolve to the same tokens", () => {
  const css = stripCss(SETTINGS_CSS);
  assert.match(css, /--set-warn: var\(--orange-ink/);
  assert.match(css, /--set-danger: var\(--error/);
  assert.match(css, /--set-ok: var\(--success-standard/);
});

test("the sign-out confirmation uses the canonical orange", () => {
  assert.match(CONFIRM, /bg: "var\(--orange-ink, #C2410C\)"/);
  assert.doesNotMatch(stripTs(CONFIRM), /#B45309|#B86B16/);
  assert.match(
    stripCss(PRIMITIVES),
    /\[data-confirm-action-tone="warning"\]:hover:not\(:disabled\) \{[\s\S]{0,140}var\(--orange-ink/,
  );
});

test("Settings summary is four cards again, with a compact sign-ins card", () => {
  const overview = read("app/(app)/settings/_sections/SettingsOverview.tsx");
  const gridAt = overview.indexOf('className="set-grid set-grid--summary"');
  const grid = overview.slice(gridAt, overview.indexOf("\n      </div>", gridAt));
  for (const id of ["workspace", "plan", "security", "activity"]) {
    assert.ok(grid.includes(`testId="${id}"`), `${id} must be in the summary row`);
  }
  assert.match(
    stripCss(SETTINGS_CSS),
    /\.settings-page-shell \.set-grid--summary \{[\s\S]{0,260}grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/,
  );
  // The device line is a parsed name, and the moment is readable.
  assert.match(overview, /describeUserAgent\(entry\.device\)/);
  assert.match(overview, /formatSignInMoment\(entry\.lastSeenAtUtc\)/);
  // The helper's comment names the old format it replaced; the CODE must not
  // use it. `toLocaleString()` produced "9/1/2026, 3:38:24 AM" — an ambiguous
  // numeric date and a seconds field, on a card with room for neither.
  const code = overview
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    })
    .join("\n");
  assert.doesNotMatch(code, /toLocaleString\(\)/);
});

test("Billing cards use the canonical panel surface", () => {
  const css = stripCss(BILLING_CSS);
  const at = css.indexOf(".bill-panel {");
  const rule = css.slice(at, css.indexOf("}", at));
  assert.match(rule, /box-shadow: var\(--shadow-card/, "the canonical elevation");
  assert.match(rule, /border-radius: var\(--radius-card/);
  assert.match(rule, /border: 1px solid var\(--border-default/);
  assert.doesNotMatch(rule, /0 6px 18px/, "the hand-written shadow must be gone");
});
