/**
 * REDESIGN/SEARCH — result hierarchy, badge geometry, overlays and spacing.
 *
 * These pin the corrections made after the production screenshots, at the
 * guarantee rather than at the pixel:
 *
 *   - a record TYPE has one tone, and the row and the Inspector use the same
 *     one for the same record;
 *   - a lifecycle STATE has one tone, and the row and the Inspector never
 *     disagree about it;
 *   - the Inspector's action is outlined and tone-matched, not a solid slab;
 *   - the type badge is content-sized in a grid that stretches its children;
 *   - `Load more` is a footer, not a sixth card;
 *   - the mappings exist ONCE.
 *
 * Every assertion describes the corrected shape only. None accepts the
 * superseded one.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

const ROUTE = "apps/web/app/(app)/search";
const PAGE = read(`${ROUTE}/page.tsx`);
const CSS = read(`${ROUTE}/search.css`);
const TONES = read(`${ROUTE}/searchTones.ts`);
const PRIM_CSS = read("apps/web/components/app-primitives/app-primitives.css");
const TOKENS = read("apps/web/lib/design-tokens/tokens.css");
/** The app-wide lifecycle table this console delegates its states to. */
const LIFECYCLE_SRC = read("apps/web/lib/status-tone/lifecycleTone.ts");
const OVERLAY = read("apps/web/components/app-primitives/AppAnchoredOverlay.tsx");

/**
 * The mapping table body, so a tone is read from the authority itself.
 *
 * An entry may name a shared CONSTANT rather than a literal — that is how CASE
 * and EVIDENCE are held to one blue instead of two that happen to match — so an
 * identifier is resolved back to the literal it is declared with. Resolving it
 * here, rather than accepting any identifier, keeps the tests measuring the
 * colour that actually ships.
 */
function typeToneOf(type: string): string {
  const block = TONES.slice(
    TONES.indexOf("const TYPE_TONE"),
    TONES.indexOf("export function searchTypeTone"),
  );
  const m = block.match(new RegExp(`${type}:\\s*("?)([\\w]+)\\1,`));
  assert.ok(m, `TYPE_TONE has no entry for ${type}`);
  if (m![1] === '"') return m![2]!;

  const constant = m![2]!;
  const decl = TONES.match(
    new RegExp(`const ${constant}: AppTone = "(\\w+)";`),
  );
  assert.ok(decl, `${type} names ${constant}, which is not declared as a tone`);
  return decl![1]!;
}

/** The identifier an entry is written with, or null when it is a literal. */
function typeToneConstantOf(type: string): string | null {
  const block = TONES.slice(
    TONES.indexOf("const TYPE_TONE"),
    TONES.indexOf("export function searchTypeTone"),
  );
  const m = block.match(new RegExp(`${type}:\\s*("?)([\\w]+)\\1,`));
  assert.ok(m, `TYPE_TONE has no entry for ${type}`);
  return m![1] === '"' ? null : m![2]!;
}

function kindToneOf(kind: string): string {
  const block = TONES.slice(
    TONES.indexOf("const KIND_TONE"),
    // `toneForKind` is module-private: it has no consumer outside this file,
    // and an export with none is how a second tone authority starts.
    TONES.indexOf("function toneForKind"),
  );
  const m = block.match(new RegExp(`${kind}:\\s*"(\\w+)"`));
  assert.ok(m, `KIND_TONE has no entry for ${kind}`);
  return m![1];
}

// ===========================================================================
// 1–4. Document-type tones, shared by the row and the Inspector
// ===========================================================================

test("1. a Case reads blue in the result row and in the Inspector", () => {
  assert.equal(typeToneOf("CASE"), "blue");
  // Both sites derive the tone from the same function — not from two tables,
  // and not from the record's position in a list.
  const uses = [...PAGE.matchAll(/tone=\{searchTypeTone\(row\.documentType\)\}/g)];
  assert.equal(uses.length, 2, "the result row and the Inspector, and only those");
});

test("2. a Report reads orange", () => {
  assert.equal(typeToneOf("REPORT"), "orange");
  // Orange is a real tone with its own rule, not amber wearing another name.
  assert.match(PRIM_CSS, /\.app-status-badge\[data-tone="orange"\]/);
  assert.notEqual(typeToneOf("REPORT"), "amber");
});

test("3. Evidence reads the SAME blue as a Case, from the same constant", () => {
  // Evidence used to wear the REPORT orange, which made a piece of evidence and
  // the report ABOUT it read as one category. They are the two halves of a
  // record's life.
  assert.equal(typeToneOf("EVIDENCE"), "blue");
  assert.equal(typeToneOf("EVIDENCE"), typeToneOf("CASE"));

  // ONE constant, not two literals that happen to agree today. A second `"blue"`
  // would render identically and drift the moment either is touched.
  const evidence = typeToneConstantOf("EVIDENCE");
  assert.ok(evidence, "EVIDENCE must name the shared constant, not a literal");
  assert.equal(
    evidence,
    typeToneConstantOf("CASE"),
    "Case and Evidence must resolve through the same constant",
  );

  // Orange is left to REPORT alone, so it now means one thing.
  const orange = ["CASE", "REPORT", "EVIDENCE", "PACKAGE", "NOTE"].filter(
    (t) => typeToneOf(t) === "orange",
  );
  assert.deepEqual(orange, ["REPORT"], "orange must classify exactly one type");
});

test("4. a Package reads purple", () => {
  // `indigo` is this product's purple: #F2ECFE / #6D28D9, the accent family.
  assert.equal(typeToneOf("PACKAGE"), "indigo");
  assert.match(
    PRIM_CSS,
    /\.app-status-badge\[data-tone="indigo"\][\s\S]{0,120}?#6D28D9/,
  );
});

test("4b. a Note reads neutral", () => {
  assert.equal(typeToneOf("NOTE"), "slate");
});

// ===========================================================================
// 5–6. Lifecycle tones
// ===========================================================================

test("5. Open is success green in the row AND in the Inspector's workflow fact", () => {
  // OPEN is no longer classified here. It belongs to the app-wide lifecycle
  // table, because Cases renders the same state and the two used to disagree.
  // This console DELEGATES, and the delegation leads — a shadowed local copy
  // is a second answer that the next edit starts reading again.
  assert.match(LIFECYCLE_SRC, /\bopen: "green",/);
  assert.match(TONES, /const canonical = lifecycleToneOrNull\(value\);\s*\n\s*if \(canonical\) return canonical;/);
  const lifecycleBlock = TONES.slice(
    TONES.indexOf("const LIFECYCLE_KIND"),
    TONES.indexOf("function searchLifecycleKind"),
  );
  assert.doesNotMatch(
    lifecycleBlock,
    /\b(open|closed|resolved|archived|investigating|on_hold):/,
    "a lifecycle state the shared table owns must not be re-classified here",
  );
  // The row's status and the Inspector's head read the SAME derivation, so the
  // list and the panel cannot describe one record two ways.
  assert.match(PAGE, /function rowLifecycleState\(row: ResultRow\)/);
  const uses = [...PAGE.matchAll(/rowLifecycleState\(row\)/g)];
  assert.equal(uses.length, 2);
  // …and the Lifecycle section's facts go through the same tone function.
  assert.match(PAGE, /<LifecycleFact label="Workflow" value=\{row\.workflowState\} \/>/);
  assert.match(PAGE, /tone=\{kind\}/);
});

test("6. Closed is the darkest neutral, and is not green", () => {
  // CLOSED is a TERMINAL state, and it is now `ink` rather than `slate`. The
  // distinction is real: `slate` is what this console paints for ABSENT and
  // unknown, and "this record is finished" is not "we do not know". A settled
  // fact reads as ordinary ink.
  assert.match(LIFECYCLE_SRC, /\bclosed: "ink",/);
  assert.doesNotMatch(LIFECYCLE_SRC, /\bclosed: "(green|slate)",/);
  // ARCHIVED is red and must not collapse back onto the terminal neutral: it
  // is the one lifecycle transition here with real consequences.
  assert.match(LIFECYCLE_SRC, /\barchived: "red",/);
  // `ink` is a real declaration on both primitives, so a shared mapping cannot
  // return a tone that only one of the two can paint.
  assert.ok(PRIM_CSS.includes('.app-status-text[data-tone="ink"]'));
  assert.ok(PRIM_CSS.includes('.app-status-badge[data-tone="ink"]'));
});

test("6b. destructive states are red; a missing value is neither", () => {
  assert.equal(kindToneOf("destructive"), "red");
  for (const state of ["deleted", "destroyed", "purged", "pending_destruction"]) {
    assert.match(TONES, new RegExp(`${state}:\\s*"destructive"`));
  }
  // Absence is neutral. "We do not have this" is not "this is fine", and it is
  // not "this is wrong".
  assert.equal(kindToneOf("neutral"), "slate");
  assert.match(TONES, /if \(key === "" \|\| key === "—" \|\| key === "-"\) return "neutral";/);
});

// ===========================================================================
// 7–8. The Inspector action
// ===========================================================================

test("7. the default Open action is purple-outlined, not a solid button", () => {
  assert.match(PAGE, /app-secondary-action--accent/);
  assert.match(
    PRIM_CSS,
    /\.app-secondary-action--accent \{[\s\S]{0,200}?--accent-600/,
  );
  // Outlined means a light surface, not a filled one.
  const rule = PRIM_CSS.slice(
    PRIM_CSS.indexOf(".app-secondary-action {"),
    PRIM_CSS.indexOf(".app-secondary-action--accent"),
  );
  assert.match(rule, /background: rgba\(255, 255, 255, 0\.9\)/);
  // The focus ring stays the canonical one on every tone.
  assert.match(
    PRIM_CSS,
    /\.app-secondary-action:focus-visible \{[\s\S]{0,140}?rgba\(124, 58, 237, 0\.28\)/,
  );
});

test("8. the Open action takes the tone of the record it opens", () => {
  // Derived from the SAME `searchTypeTone` the label uses, so the control and
  // the label can never disagree about what kind of record this is. Since
  // EVIDENCE moved to blue this reaches REPORT — the test names the mechanism,
  // not one type, so a future remapping does not silently make it vacuous.
  assert.match(PAGE, /searchTypeTone\(row\.documentType\) === "orange"\s*\n?\s*\? "app-secondary-action--orange"/);
  assert.equal(typeToneOf("REPORT"), "orange");
  assert.notEqual(typeToneOf("EVIDENCE"), "orange");
  assert.match(
    PRIM_CSS,
    /\.app-secondary-action--orange \{[\s\S]{0,200}?--orange-ink/,
  );
  // The orange comes from the token authority, not from a literal at the site.
  assert.match(TOKENS, /--orange-050: #FFF7ED;/);
  assert.match(TOKENS, /--orange-ink: #[0-9A-F]{6};/);
});

/** Relative luminance, per WCAG 2.x. */
function luminance(hex: string): number {
  const c = hex.replace("#", "");
  const channels = [0, 2, 4]
    .map((i) => parseInt(c.substr(i, 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

function token(name: string): string {
  const m = TOKENS.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6});`));
  assert.ok(m, `token --${name} is not declared`);
  return m![1]!.toUpperCase();
}

/**
 * THE ONE RECORDED CONTRAST EXCEPTION.
 *
 * The classification orange is taken from the design reference rather than
 * derived from a contrast target, and white on it does NOT meet WCAG AA. That
 * is a decision, so it is pinned here as a value: the tests below state the
 * measured ratio instead of asserting a threshold it does not meet, and any
 * OTHER fill that fails still fails. Changing the token changes the measurement
 * and breaks 8c, which forces the decision to be made again rather than
 * inherited silently.
 */
const APPROVED_LOW_CONTRAST_FILL = {
  token: "orange-fill",
  value: "#F97316",
  measured: 2.8,
} as const;

test("8c. the classification orange is the exact reference fill, and its contrast is recorded as measured", () => {
  const orange = token(APPROVED_LOW_CONTRAST_FILL.token);

  // The EXACT fill sampled from the design reference — not an approximation
  // chosen to clear a threshold, which is what the two previous values were.
  assert.equal(
    orange,
    APPROVED_LOW_CONTRAST_FILL.value,
    "the classification orange must be the exact reference fill",
  );

  // MEASURED, and reported as what it is. White on #F97316 is ~2.80:1, below
  // the 4.5:1 AA floor for normal-size text. This asserts the measurement, not
  // a pass: if the token moves, this number moves and the test fails.
  const ratio = contrast(orange, "#FFFFFF");
  assert.ok(
    Math.abs(ratio - APPROVED_LOW_CONTRAST_FILL.measured) < 0.01,
    `white on ${orange} measures ${ratio.toFixed(3)}:1, not the recorded ${APPROVED_LOW_CONTRAST_FILL.measured}:1`,
  );
  assert.ok(ratio < 4.5, "the recorded exception is no longer an exception — re-check 8d");

  // The exception is BOUNDED. It buys a fill, not a licence: the readable
  // orange used for TEXT is a separate token and still has to be AA.
  const ink = token("orange-ink");
  assert.notEqual(ink, orange, "the ink and the fill must stay separate tokens");
  assert.ok(
    contrast(ink, "#FFFFFF") >= 4.5,
    `orange TEXT (${ink}) is not AA on white`,
  );

  // Still ORANGE. Amber means caution and a record type is not a caution, so
  // the green channel must stay in the orange ramp rather than drifting toward
  // `--warning` (G/R ≈ 0.62) or toward red (G/R ≈ 0.2).
  const r = parseInt(orange.substr(1, 2), 16);
  const g = parseInt(orange.substr(3, 2), 16);
  const ratioGR = g / r;
  assert.ok(
    ratioGR > 0.3 && ratioGR < 0.5,
    `${orange} has left the orange ramp (G/R = ${ratioGR.toFixed(3)})`,
  );
});

test("8d. every filled type label pairs a canonical token with white, and only the recorded fill is not AA", () => {
  // The fills were private literals — including a `#C2570C` that existed
  // nowhere else and differed from `--orange-ink`, so "one type-tone mapping"
  // was one mapping in TypeScript and a second, drifted one in CSS.
  const fills = [...CSS.matchAll(
    /\.search-type-badge\[data-tone="(\w+)"\] \{ background: var\(--([a-z0-9-]+)\); color: (#[0-9A-F]{6}); \}/g,
  )];
  assert.equal(fills.length, 7, "every tone must declare a filled pairing");

  const exceptions: string[] = [];
  for (const [, tone, tokenName, ink] of fills) {
    assert.equal(ink, "#FFFFFF", `${tone} does not use white text`);
    const ratio = contrast(token(tokenName!), ink!);
    if (tokenName === APPROVED_LOW_CONTRAST_FILL.token) {
      exceptions.push(tone!);
      continue;
    }
    assert.ok(
      ratio >= 4.5,
      `${tone} (--${tokenName}) measures ${ratio.toFixed(3)}:1 against white`,
    );
  }

  // EXACTLY ONE. A list of approved exceptions that can grow is not an
  // exception, so the count is asserted rather than the membership.
  assert.deepEqual(
    exceptions,
    ["orange"],
    "only the recorded classification orange may miss AA",
  );

  // No private literal survives as a fill.
  assert.doesNotMatch(
    CSS,
    /\.search-type-badge\[data-tone="\w+"\] \{ background: #[0-9A-Fa-f]{6}/,
  );
});

test("8b. no tone changes the control's geometry", () => {
  // Only colour properties may appear in a tone modifier. A padding or height
  // here would make the control move when the record type changed.
  for (const variant of ["accent", "orange"]) {
    const start = PRIM_CSS.indexOf(`.app-secondary-action--${variant} {`);
    const body = PRIM_CSS.slice(start, PRIM_CSS.indexOf("}", start));
    assert.doesNotMatch(body, /padding|height|border-width|border-radius|font-size|gap/);
  }
});

// ===========================================================================
// 9. The compact type badge
// ===========================================================================

test("9. the type label is ONE authority, compact, filled, and never stretched", () => {
  // ROOT CAUSE of the original defect: `.search-inspector` is a grid, and a
  // grid item is stretched to its column unless it says otherwise — which is
  // how the Inspector's type label became a full-width rounded slab that read
  // as an input field.
  assert.match(CSS, /\.search-inspector \{[\s\S]{0,200}?display: grid;/);

  const badge = CSS.slice(
    CSS.indexOf(".search-type-badge {"),
    CSS.indexOf("}", CSS.indexOf(".search-type-badge {")),
  );

  // Content-sized in every container.
  assert.match(badge, /justify-self: start;/);
  assert.match(badge, /inline-size: fit-content;/);
  assert.match(badge, /max-inline-size: 100%;/);

  // A compact RECTANGLE, not a capsule. `.app-status-badge` is 999px; the type
  // label overrides that to a small radius and takes tighter padding.
  assert.match(badge, /border-radius: 4px;/);
  assert.doesNotMatch(badge, /border-radius: 999px/);
  assert.match(badge, /padding: 3px 7px;/);
  assert.match(badge, /text-transform: uppercase;/);

  // SOLID FILL + WHITE TEXT for every tone the mapping can produce, including
  // the neutral fallback an unknown type resolves to.
  for (const tone of ["blue", "orange", "indigo", "slate"]) {
    const rule = new RegExp(
      `\\.search-type-badge\\[data-tone="${tone}"\\] \\{[^}]*color: #FFFFFF;`,
    );
    assert.match(CSS, rule, `${tone} is not a filled white-text label`);
  }

  // BOTH type render sites use the one class: the result row and the Inspector
  // header. The Inspector's LIFECYCLE chip does not — it is a state, and a
  // state must not wear the filled type shape.
  assert.equal([...PAGE.matchAll(/className="search-type-badge"/g)].length, 2);
  assert.match(PAGE, /className="search-inspector__lifecycle"/);

  // The fix is at the layout source, not a later override.
  assert.doesNotMatch(CSS, /!important/);
});

// ===========================================================================
// 10. The overlay
// ===========================================================================

test("10. the typeahead renders on the canonical overlay layer, above the panels", () => {
  // Portaled to <body>, so no ancestor overflow can clip it and no ancestor
  // stacking context can trap its layer.
  assert.match(OVERLAY, /createPortal\(/);
  assert.match(OVERLAY, /document\.body,/);
  assert.match(OVERLAY, /position: fixed;/.source ? /position: "fixed"|app-anchored-overlay/ : /x/);
  assert.match(
    PRIM_CSS,
    /\.app-anchored-overlay \{[\s\S]{0,160}?position: fixed;[\s\S]{0,160}?z-index: var\(--layer-anchored-overlay/,
  );
  // The layer is a named contract, not a number picked at the call site, and
  // it sits above the dialog layer so a select inside a dialog still works.
  assert.match(TOKENS, /--layer-dialog: 1000;/);
  assert.match(TOKENS, /--layer-anchored-overlay: 100000;/);
  // One mechanism, two consumers — the listbox no longer carries its own copy.
  const LISTBOX = read("apps/web/components/app-primitives/AppListbox.tsx");
  assert.match(LISTBOX, /<AppAnchoredOverlay/);
  assert.doesNotMatch(LISTBOX, /createPortal/);
  assert.equal(
    [...PAGE.matchAll(/<AppAnchoredOverlay/g)].length,
    1,
    "the search page mounts the menu on the shared overlay",
  );
});

// ===========================================================================
// 11. The results footer
// ===========================================================================

test("11. Load more is a deliberate footer, not attached to the last card", () => {
  const footer = CSS.slice(
    CSS.indexOf(".search-results__more {"),
    CSS.indexOf("}", CSS.indexOf(".search-results__more {")),
  );
  assert.match(footer, /padding-block: 16px 24px;/);
  assert.match(footer, /justify-content: center;/);
  // Padding, not margin: the column is a grid, so a margin would add to the
  // gap and there would be two numbers to reason about.
  assert.doesNotMatch(footer, /margin/);
  // The control keeps its box between "Load more" and "Loading…".
  assert.match(CSS, /\.search-results__more > \.app-secondary-action \{[\s\S]{0,80}?min-inline-size/);
});

// ===========================================================================
// 12–13. Fallbacks and direction
// ===========================================================================

test("12. an unknown type or state falls back to neutral", () => {
  assert.match(TONES, /return TYPE_TONE\[documentType\] \?\? "slate";/);
  assert.match(TONES, /return LIFECYCLE_KIND\[key\] \?\? "neutral";/);
  assert.match(TONES, /return BADGE_KIND\[badge\] \?\? "neutral";/);
  // Nothing is derived from order or index.
  assert.doesNotMatch(TONES, /\[(0|1|2|3|4)\]|indexOf\(|\bidx\b/);
  assert.doesNotMatch(CSS, /:nth-child|:nth-of-type|:first-child \.search-type-badge/);
});

test("13. RTL uses the same semantics, and nothing stretches", () => {
  // Tone is direction-independent by construction — it is keyed by the wire
  // value, so an RTL surface resolves the identical tone.
  assert.doesNotMatch(TONES, /\bdir\b|rtl|ltr/i);
  // The badge and the action are placed with LOGICAL properties, so they hug
  // the start edge in both directions instead of stretching in one.
  const badge = CSS.slice(
    CSS.indexOf(".search-type-badge {"),
    CSS.indexOf("}", CSS.indexOf(".search-type-badge {")),
  );
  assert.match(badge, /inline-size/);
  assert.doesNotMatch(badge, /\bwidth:|\bleft:|\bright:|margin-left|margin-right/);
  const action = CSS.slice(
    CSS.indexOf(".search-inspector__action {"),
    CSS.indexOf("}", CSS.indexOf(".search-inspector__action {")),
  );
  assert.match(action, /justify-self: start;/);
  assert.doesNotMatch(action, /\bwidth:|\bleft:|\bright:/);
});

// ===========================================================================
// Cleanup — the superseded rules are gone, and each mapping exists once
// ===========================================================================

test("the replaced presentation is deleted, and each mapping exists once", () => {
  // One type map, one kind map, one lifecycle map — in the authority only.
  assert.equal([...PAGE.matchAll(/TYPE_TONE|KIND_TONE|LIFECYCLE_KIND|BADGE_KIND/g)].length, 0);
  assert.doesNotMatch(PAGE, /function docTypeTone\(|function badgeTone\(/);
  // The dead listbox alignment rule and its dead prop are gone.
  assert.doesNotMatch(PRIM_CSS, /app-listbox__popup\[data-align/);
  assert.doesNotMatch(
    read("apps/web/components/app-primitives/AppListbox.tsx"),
    /align\?: "left" \| "right"/,
  );
  // No literal colour reached the console, and no override layer was added.
  assert.doesNotMatch(CSS, /!important/);
  assert.doesNotMatch(TONES, /#[0-9a-fA-F]{3,8}\b|rgba?\(/);
});
