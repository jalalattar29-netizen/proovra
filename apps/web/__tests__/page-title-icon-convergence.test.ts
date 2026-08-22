/**
 * ONE PAGE-TITLE TREATMENT, ACROSS EVERY PAGE THAT HAS ONE.
 *
 * /cases grew a title icon first, as inline styles on a span with the hexes
 * typed out. /notifications adopted it by lifting those values into
 * `.app-title-icon`; the Evidence Library and Search now render the same pair.
 *
 * What this suite protects is REUSE, not pixels — the browser gates measure
 * the geometry, and measuring it again here would only re-assert numbers.
 * What source can prove, and a browser cannot, is that four pages resolve the
 * SAME class rather than four lookalikes that happen to agree today.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(resolve(APP_ROOT, rel), "utf8");

const PRIMITIVES = read("components/app-primitives/app-primitives.css");

/** Every page that renders a title icon, and the file that renders it. */
const TITLED_PAGES: ReadonlyArray<[string, string]> = [
  ["Cases", "components/cases-experience/CasesIndex.tsx"],
  ["Notifications", "app/(app)/inbox/page.tsx"],
  ["Evidence Library", "app/(app)/evidence/components/EvidenceLibraryHeader.tsx"],
  ["Search", "app/(app)/search/page.tsx"],
];

test("every titled page resolves the SAME canonical icon primitive", () => {
  for (const [label, file] of TITLED_PAGES) {
    const src = read(file);
    assert.match(src, /className="app-title-row"|app-title-row"/, `${label} row`);
    assert.match(src, /className="app-title-icon"/, `${label} icon`);
    // Decorative — the heading beside it already names the page, so a second
    // announcement is noise rather than an affordance.
    assert.match(src, /aria-hidden(=\{?"?true"?\}?)?\s*\n?\s*className="app-title-icon"|className="app-title-icon"/, `${label} aria`);
  }
});

test("no titled page re-declares the icon surface for itself", () => {
  // The whole point of lifting this into a primitive was that a page cannot
  // drift from it by re-typing one of its six values. A page that writes its
  // own gradient, radius or border for a title icon has forked the treatment.
  for (const [label, file] of TITLED_PAGES) {
    const src = read(file);
    assert.ok(
      !/linear-gradient\(145deg,\s*rgba\(91,\s*79,\s*233/.test(src),
      `${label} re-declares the icon gradient`,
    );
    assert.ok(
      !/rgba\(91,\s*79,\s*233,\s*0\.16\)/.test(src),
      `${label} re-declares the icon border`,
    );
  }
});

test("the icon surface is declared EXACTLY once, in the primitives sheet", () => {
  assert.match(PRIMITIVES, /\.app-title-icon \{/);
  assert.match(PRIMITIVES, /inline-size: 42px/);
  assert.match(PRIMITIVES, /border-radius: 12px/);
  assert.match(
    PRIMITIVES,
    /linear-gradient\(\s*145deg,\s*rgba\(91, 79, 233, 0\.1\),\s*rgba\(73, 184, 255, 0\.08\)\s*\)/,
  );
  // The row carries the shared page-title SCALE, so the strongest heading in
  // the product is one number rather than whichever page declared it.
  const row = PRIMITIVES.slice(PRIMITIVES.indexOf(".app-title-row {"));
  assert.match(row.slice(0, 900), /font-size: 30px/);
  assert.match(row.slice(0, 900), /font-weight: 720/);
});

// ---------------------------------------------------------------------------
// The Evidence Library header specifically
// ---------------------------------------------------------------------------

const EVIDENCE_HEADER = read(
  "app/(app)/evidence/components/EvidenceLibraryHeader.tsx",
);
const EVIDENCE_CSS = read("app/(app)/evidence/evidence-library.css");

test("Evidence Library uses an evidence glyph from the app's own icon library", () => {
  assert.match(EVIDENCE_HEADER, /from "lucide-react"/);
  assert.match(EVIDENCE_HEADER, /<Archive strokeWidth=\{1\.75\}/);
  // And no second icon library was introduced to get it.
  assert.ok(!/react-icons|@heroicons|font-awesome/.test(EVIDENCE_HEADER));
});

test("the title block and the action row are deliberately separated", () => {
  // They were sitting on one optical line, so the three buttons read as part
  // of the heading rather than as what you do once you have read it. Both
  // offsets are LOGICAL, so Arabic behaves identically.
  const block = EVIDENCE_CSS.slice(
    EVIDENCE_CSS.indexOf(".evidence-library-header .app-title-row"),
  );
  assert.match(block, /\.evidence-library-header \.app-title-row \{[\s\S]{0,120}margin-block-start: -3px/);
  assert.match(
    block,
    /\.evidence-library-header \.ui-page-header__actions \{[\s\S]{0,120}margin-block-start: 14px/,
  );
  assert.ok(
    !/margin-top:|margin-bottom:/.test(block.slice(0, 900)),
    "physical margins would not mirror in Arabic",
  );
});

test("the header's actions are untouched — this was layout polish", () => {
  // New Case still navigates to /cases, Upload / Capture still navigates to
  // /capture, and Refresh still calls the same handler with the same
  // disabled-while-refreshing contract.
  assert.match(EVIDENCE_HEADER, /href="\/cases"/);
  assert.match(EVIDENCE_HEADER, /href="\/capture"/);
  assert.match(EVIDENCE_HEADER, /onClick=\{onRefresh\}/);
  assert.match(EVIDENCE_HEADER, /disabled=\{refreshing\}/);
  assert.match(EVIDENCE_HEADER, /aria-busy=\{refreshing\}/);
  for (const probe of [
    "data-evidence-new-case",
    "data-evidence-refresh",
  ]) {
    assert.ok(EVIDENCE_HEADER.includes(probe), `${probe} must survive`);
  }
});

// ---------------------------------------------------------------------------
// The withdrawn plain-language card
// ---------------------------------------------------------------------------

test("the Ask-in-plain-language card is gone, and its stylesheet with it", () => {
  const SEARCH_PAGE = read("app/(app)/search/page.tsx");
  const SEARCH_CSS = read("app/(app)/search/search.css");

  // Not mounted, not imported, and the component file is deleted.
  assert.ok(!SEARCH_PAGE.includes("<NlSearchBox"));
  assert.ok(!/import \{ NlSearchBox \}/.test(SEARCH_PAGE));
  let componentExists = true;
  try {
    read("components/ai-copilot/NlSearchBox.tsx");
  } catch {
    componentExists = false;
  }
  assert.equal(componentExists, false, "the component file must be deleted");

  // Its selectors went with it — an orphaned rule is what the convergence
  // suite in this repository exists to catch.
  const cssCode = SEARCH_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(
    !/\.search-nl/.test(cssCode),
    "orphaned .search-nl rules survived",
  );
});
