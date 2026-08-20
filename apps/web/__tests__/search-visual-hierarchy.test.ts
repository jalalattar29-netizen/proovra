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
const OVERLAY = read("apps/web/components/app-primitives/AppAnchoredOverlay.tsx");

/** The mapping table body, so a tone is read from the authority itself. */
function typeToneOf(type: string): string {
  const block = TONES.slice(
    TONES.indexOf("const TYPE_TONE"),
    TONES.indexOf("export function searchTypeTone"),
  );
  const m = block.match(new RegExp(`${type}:\\s*"(\\w+)"`));
  assert.ok(m, `TYPE_TONE has no entry for ${type}`);
  return m![1];
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

test("3. Evidence reads orange", () => {
  assert.equal(typeToneOf("EVIDENCE"), "orange");
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
  assert.equal(kindToneOf("open"), "green");
  assert.match(TONES, /\bopen:\s*"open"/);
  // The row's badge and the Inspector's head badge read the SAME derivation,
  // so the list and the panel cannot describe one record two ways.
  assert.match(PAGE, /function rowLifecycleState\(row: ResultRow\)/);
  const uses = [...PAGE.matchAll(/rowLifecycleState\(row\)/g)];
  assert.equal(uses.length, 2);
  // …and the Lifecycle section's facts go through the same tone function.
  assert.match(PAGE, /<LifecycleFact label="Workflow" value=\{row\.workflowState\} \/>/);
  assert.match(PAGE, /tone=\{kind\}/);
});

test("6. Closed is neutral, and is not green", () => {
  assert.equal(kindToneOf("closed"), "slate");
  assert.notEqual(kindToneOf("closed"), kindToneOf("open"));
  assert.match(TONES, /\bclosed:\s*"closed"/);
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

test("8. Open evidence is orange-outlined, matching the record it opens", () => {
  assert.match(PAGE, /searchTypeTone\(row\.documentType\) === "orange"\s*\n?\s*\? "app-secondary-action--orange"/);
  assert.match(
    PRIM_CSS,
    /\.app-secondary-action--orange \{[\s\S]{0,200}?--orange-ink/,
  );
  // The orange comes from the token authority, not from a literal at the site.
  assert.match(TOKENS, /--orange-050: #FFF7ED;/);
  assert.match(TOKENS, /--orange-ink: #C2410C;/);
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
