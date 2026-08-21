/**
 * SEARCH CLASSIFICATION COLOUR — regression proofs.
 *
 * Three changes are pinned here, each of which had already been made once and
 * drifted back:
 *
 *   1. The classification orange is the EXACT reference fill (#F97316), not an
 *      approximation chosen to clear a contrast threshold. Its contrast is
 *      recorded as measured — 2.80:1, below AA — rather than asserted to pass.
 *   2. EVIDENCE shares ONE blue with CASE, through one constant.
 *   3. Match reasons are tinted per reason, from ONE tone function, rendered
 *      identically in the result row and in the Inspector.
 *
 * These read the shipped source. A test that reproduces the mapping it is
 * checking proves only that it can copy.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");
const read = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

const ROUTE = "apps/web/app/(app)/search";
const PAGE = read(`${ROUTE}/page.tsx`);
const CSS = read(`${ROUTE}/search.css`);
const TONES = read(`${ROUTE}/searchTones.ts`);
const TOKENS = read("apps/web/lib/design-tokens/tokens.css");

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

/** The declared rule body for a selector, so a claim is read from the CSS. */
function rule(selector: string): string {
  const start = CSS.indexOf(`${selector} {`);
  assert.ok(start >= 0, `no rule for ${selector}`);
  return CSS.slice(start, CSS.indexOf("}", start));
}

// ===========================================================================
// 1–3. The classification orange
// ===========================================================================

test("1. the classification orange is the exact reference fill, declared once", () => {
  assert.equal(token("orange-fill"), "#F97316");

  // Once, at the token authority. A second copy is how the previous two values
  // survived after the token was changed.
  const occurrences = [...read(`${ROUTE}/search.css`).matchAll(/#F97316/gi)];
  assert.equal(occurrences.length, 0, "the fill must not be re-stated in Search CSS");
  assert.match(rule('.search-type-badge[data-tone="orange"]'), /var\(--orange-fill\)/);
});

test("2. white on the classification orange is 2.80:1 — recorded, not claimed to pass", () => {
  const ratio = contrast(token("orange-fill"), "#FFFFFF");

  // The measurement, asserted as the value it is. This is BELOW the 4.5:1 AA
  // floor for normal-size text and is an approved visual-reference decision:
  // the design is the authority for this label. Stating it here means the trade
  // is visible in the test output rather than discovered by a user.
  assert.equal(ratio.toFixed(2), "2.80");
  assert.ok(ratio < 4.5, "if this now passes, the exception must be retired");

  // The token's own comment must carry the measurement, so the next person to
  // read the declaration sees the decision rather than re-deriving it.
  const decl = TOKENS.slice(
    TOKENS.lastIndexOf("/*", TOKENS.indexOf("--orange-fill")),
    TOKENS.indexOf("--orange-fill"),
  );
  assert.match(decl, /2\.80:1/);
  assert.match(decl, /BELOW/);
});

test("3. the exception buys a FILL and nothing else — orange TEXT is still AA", () => {
  const ink = token("orange-ink");
  assert.notEqual(ink, token("orange-fill"), "the ink and fill must stay distinct");
  assert.ok(
    contrast(ink, "#FFFFFF") >= 4.5,
    `orange text (${ink}) measures ${contrast(ink, "#FFFFFF").toFixed(2)}:1 on white`,
  );

  // `--orange-ink` had been lightened only to serve the badge. With the badge
  // on its own token, its only consumer is the outlined action's TEXT.
  const prim = read("apps/web/components/app-primitives/app-primitives.css");
  assert.match(prim, /\.app-secondary-action--orange \{[\s\S]{0,200}?--orange-ink/);

  // The exception is a BACKGROUND for a non-interactive label, and nothing
  // else. It used to be expressed as "--orange-fill never appears in the
  // primitives file at all", which was a proxy for the real rule and stopped
  // matching it the moment the filled label treatment was promoted out of the
  // Search route onto the shared status badge. The rule itself is pinned here
  // instead, so it still bites where it always meant to: an orange TEXT ink,
  // or an orange-filled CONTROL, both remain forbidden.
  const fillUses = [...prim.matchAll(/^([^\n{]*)\{[^}]*--orange-fill[^}]*\}/gm)].map(
    (m) => m[1]!.trim(),
  );
  assert.deepEqual(
    fillUses,
    ['.app-status-badge[data-fill="solid"][data-tone="orange"]'],
    "the sub-AA fill is the solid status label only",
  );
  for (const selector of fillUses) {
    const body = prim.slice(prim.indexOf(`${selector} {`));
    const decl = body.slice(0, body.indexOf("}"));
    // A fill, never an ink.
    assert.match(decl, /background:\s*var\(--orange-fill\)/);
    assert.doesNotMatch(decl, /color:/);
    // And never on something the operator can operate.
    assert.doesNotMatch(selector, /action|button|input|:hover|:focus/);
  }

  // The white ink it is measured against is a real declaration on the variant,
  // not an inherited accident.
  const solid = prim.slice(prim.indexOf('.app-status-badge[data-fill="solid"] {'));
  assert.match(solid.slice(0, solid.indexOf("}")), /color:\s*#ffffff/i);

  // The measurement travels with the rule that spends the exception.
  const note = prim.slice(
    prim.lastIndexOf("/*", prim.indexOf('.app-status-badge[data-fill="solid"] {')),
    prim.indexOf('.app-status-badge[data-fill="solid"] {'),
  );
  assert.match(note, /2\.80:1/);
});

// ===========================================================================
// 4–5. Evidence and Case share one blue
// ===========================================================================

test("4. EVIDENCE and CASE resolve through one constant, not two matching literals", () => {
  const table = TONES.slice(
    TONES.indexOf("const TYPE_TONE"),
    TONES.indexOf("export function searchTypeTone"),
  );
  assert.match(table, /CASE: CLASSIFICATION_BLUE,/);
  assert.match(table, /EVIDENCE: CLASSIFICATION_BLUE,/);

  // The constant is declared once, as a real tone.
  const decls = [...TONES.matchAll(/const CLASSIFICATION_BLUE: AppTone = "(\w+)";/g)];
  assert.equal(decls.length, 1);
  assert.equal(decls[0]![1], "blue");

  // And no second blue was introduced alongside it.
  assert.equal(
    [...table.matchAll(/"blue"/g)].length,
    0,
    "a literal blue beside the constant is a second blue waiting to drift",
  );
});

test("5. blue is one CSS rule, so Case and Evidence cannot render differently", () => {
  const blue = [...CSS.matchAll(/\.search-type-badge\[data-tone="blue"\]/g)];
  assert.equal(blue.length, 1, "one declaration for the blue fill");
  assert.match(rule('.search-type-badge[data-tone="blue"]'), /var\(--info\)/);

  // Nothing keys presentation off the document type directly — that is the
  // mechanism by which a per-type override reappears.
  assert.doesNotMatch(CSS, /\[data-search-type="EVIDENCE"\]/);
  assert.doesNotMatch(CSS, /\[data-search-type="CASE"\]/);
});

// ===========================================================================
// 6–9. Match reasons
// ===========================================================================

test("6. match reasons carry the exact reference tints", () => {
  assert.match(rule('.search-match-reason[data-match-tone="title"]'), /background: #F5EEFF;/);
  assert.match(rule('.search-match-reason[data-match-tone="title"]'), /color: #7C3AED;/);
  assert.match(rule('.search-match-reason[data-match-tone="summary"]'), /background: #DBEAFE;/);
  assert.match(rule('.search-match-reason[data-match-tone="summary"]'), /color: #2563EB;/);
});

test("7. each reason pair is measured, and the shortfall is recorded", () => {
  const pairs: Array<[string, string, string]> = [
    ["title", "#7C3AED", "#F5EEFF"],
    ["summary", "#2563EB", "#DBEAFE"],
    ["neutral", "#475569", "#F1F5F9"],
  ];
  const measured = pairs.map(([tone, fg, bg]) => [tone, contrast(fg, bg).toFixed(2)]);
  assert.deepEqual(measured, [
    ["title", "5.04"],
    ["summary", "4.24"],
    ["neutral", "6.92"],
  ]);

  // `summary` is 4.24:1 — BELOW AA, like the classification orange, and for the
  // same reason: the tint is the design's, not a value picked to clear a bar.
  // The reason is never carried by colour alone — every label states its
  // meaning in words — so the shortfall costs margin, not information.
  const comment = CSS.slice(
    CSS.lastIndexOf("/*", CSS.indexOf(".search-match-reason {")),
    CSS.indexOf(".search-match-reason {"),
  );
  assert.match(comment, /4\.24:1/);
  assert.match(comment, /BELOW AA/);
});

test("8. the tone comes from ONE function, with a neutral fallback", () => {
  // The mapping exists once, in the Search tone authority.
  assert.match(TONES, /export function searchMatchReasonTone\(/);
  assert.equal([...TONES.matchAll(/MATCH_REASON_TONE/g)].length, 2, "one table, one read");

  // An unrecognised reason resolves to neutral rather than to nothing — a new
  // backend reason must stay legible, not arrive unstyled.
  assert.match(TONES, /return MATCH_REASON_TONE\[reason\] \?\? "neutral";/);
  assert.match(TONES, /if \(!reason\) return "neutral";/);

  // Neutral is a real declaration, not whatever the base happens to paint —
  // the same split `.search-type-badge` uses. The base carries geometry only.
  assert.match(
    rule('.search-match-reason[data-match-tone="neutral"]'),
    /background: #F1F5F9;/,
  );
  assert.doesNotMatch(rule(".search-match-reason"), /background|color:/);
});

test("9. a match reason has exactly one rendering, and it derives its tone", () => {
  // The Inspector does not show match reasons today, so the strongest available
  // guarantee is that there is ONE site — not two that agree by coincidence. If
  // the Inspector ever renders them, this count moves and forces the second
  // site to be written against the same class and the same function.
  const classes = [...PAGE.matchAll(/className="search-match-reason"/g)];
  const derived = [...PAGE.matchAll(/data-match-tone=\{searchMatchReasonTone\(reason\)\}/g)];
  assert.equal(classes.length, 1, "one rendering of a match reason");
  assert.equal(
    derived.length,
    classes.length,
    "every rendering must derive its tone, not hard-code one",
  );

  // The replaced presentation is gone: these were `.app-chip`, one neutral
  // treatment for every reason.
  const chipNearReason = PAGE.match(
    /\{reason\}[\s\S]{0,80}?app-chip|app-chip[\s\S]{0,120}?data-search-match-reason/,
  );
  assert.equal(chipNearReason, null, "no match reason may still render as a chip");
});

// ===========================================================================
// 10. Geometry
// ===========================================================================

test("10. a match reason is a content-sized rectangle that cannot stretch", () => {
  const base = rule(".search-match-reason");

  // Content-sized in a grid or flex parent — the defect that made the type
  // label a full-width slab in the Inspector was exactly this omission.
  assert.match(base, /inline-size: fit-content;/);
  assert.match(base, /flex: 0 0 auto;/);
  assert.match(base, /justify-self: start;/);

  // A rectangle, not a capsule, and on the same restrained radius the type
  // label uses so the two read as one system.
  assert.match(base, /border-radius: 4px;/);
  assert.doesNotMatch(base, /border-radius: 999px|border-radius: 50%/);

  // No tone may change geometry: a row carrying both reasons must not shift
  // when the second appears.
  for (const tone of ["title", "summary"]) {
    const body = rule(`.search-match-reason[data-match-tone="${tone}"]`);
    assert.doesNotMatch(body, /padding|font-size|border-radius|line-height|inline-size/);
  }

  // And nothing here is forced.
  assert.doesNotMatch(base, /!important/);
});
