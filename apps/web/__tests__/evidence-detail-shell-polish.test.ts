/**
 * EVIDENCE DETAIL — production polish, shell + artifacts.
 *
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * The redesign shipped its canonical classes on top of the ORIGINAL Evidence
 * Detail stylesheet without removing it, and every surviving rule won: element
 * selectors outrank classes, and four of them carried `!important`. Production
 * therefore rendered the old design with the new markup underneath it —
 * a 57.6px marketing title, coral download buttons, a floating tab bar and a
 * near-black rail.
 *
 * Deleting a rule is not enough on its own: nothing stops the next pass from
 * reintroducing one, and the failure mode is silent because the markup looks
 * correct in source. So each deleted override is pinned here by the property
 * that made it harmful.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CSS = readFileSync(
  path.join(ROOT, "app", "(app)", "evidence", "[id]", "evidence-detail.css"),
  "utf8",
);
const PAGE = readFileSync(
  path.join(ROOT, "app", "(app)", "evidence", "[id]", "page.tsx"),
  "utf8",
);

/** The body of the ONE rule declaring `selector`, or null. */
function rule(selector: string): string | null {
  const idx = CSS.indexOf(`\n${selector} {`);
  if (idx < 0) return null;
  const start = CSS.indexOf("{", idx);
  let depth = 1;
  let i = start + 1;
  while (i < CSS.length && depth > 0) {
    if (CSS[i] === "{") depth += 1;
    else if (CSS[i] === "}") depth -= 1;
    i += 1;
  }
  return CSS.slice(start + 1, i - 1);
}

// ---------------------------------------------------------------------------
// The superseded overrides are gone
// ---------------------------------------------------------------------------

test("the display-scale hero title rule is deleted", () => {
  // `.evidence-detail-hero h1` (0-1-1) outranked `.evidence-detail-title`
  // (0-1-0), so the redesign's 26px heading never applied and the filename
  // rendered at clamp(2.45rem, 4vw, 3.85rem) = 57.6px at 1440.
  assert.equal(rule(".evidence-detail-hero h1"), null);
  assert.ok(!CSS.includes("clamp(2.45rem, 4vw, 3.85rem)"));
  assert.ok(!CSS.includes("clamp(2.1rem, 9vw, 3rem)"));
});

test("the title is an application heading at the canonical scale", () => {
  // Exactly one declaration: the superseded 26px rule was deleted rather than
  // left to be out-cascaded, which is how the 57.6px override survived.
  assert.equal(CSS.split("\n.evidence-detail-title {").length - 1, 1);
  const body = rule(".evidence-detail-title");
  assert.ok(body, ".evidence-detail-title must exist");
  // 32px floor / 40px ceiling on desktop.
  assert.match(body!, /font-size:\s*clamp\(2rem,\s*2\.2vw,\s*2\.5rem\)/);
  // A real line box — `line-height: 1` is what clipped the descenders.
  assert.match(body!, /line-height:\s*1\.18/);
  // Two deliberate lines, and a long unbroken filename may not widen the page.
  assert.match(body!, /line-clamp:\s*2/);
  assert.match(body!, /overflow-wrap:\s*anywhere/);
});

test("the full filename survives the two-line clamp", () => {
  // The heading truncates, so the complete value has to stay reachable.
  assert.match(
    PAGE,
    /<h1\s+className="evidence-detail-title"\s+title=\{evidence\.displayTitle \|\| evidence\.title\}/,
  );
});

test("the coral download override is deleted", () => {
  // Positional (`:first-child`, `:nth-child(2)`) and `!important`, forcing the
  // legacy marketing token over the canonical action primitives.
  assert.ok(!CSS.includes("--btn-primary-bg"));
  assert.ok(!CSS.includes(".evidence-detail-hero-actions button:first-child"));
  assert.ok(!CSS.includes("button:not(:first-child):not(:nth-child(2))"));
});

test("no !important survives in the shell's button rules", () => {
  for (const forbidden of [
    "border-radius: 12px !important",
    "box-shadow: none !important",
    "background: #ffffff !important",
  ]) {
    assert.ok(!CSS.includes(forbidden), `${forbidden} must be gone`);
  }
});

test("the downloads use the canonical action hierarchy", () => {
  // Solid purple primary for the report; purple outlined secondary for the
  // package. Both come from the canonical action authority, so neither can
  // reintroduce an Evidence-Detail-only colour. Anchored on the action's own
  // data attribute rather than on a character distance, which the added
  // disabled-reason wiring changes.
  const around = (marker: string) => {
    const i = PAGE.indexOf(marker);
    assert.ok(i > 0, `${marker} must exist`);
    return PAGE.slice(Math.max(0, i - 900), i + 600);
  };

  const report = around('data-evidence-action="download-report"');
  assert.match(report, /className="app-primary-action"/);
  assert.match(report, /Download Report PDF/);

  const pkg = around('data-evidence-action="download-package"');
  assert.match(pkg, /className="app-secondary-action"/);
  assert.match(pkg, /Download Verification Package ZIP/);
});

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

test("the tab bar does not follow the reader", () => {
  assert.ok(!CSS.includes("position: sticky;\n  top: 72px"));
  // ONE declaration, on the canonical selector. The cleanup removed the
  // `.evidence-detail-page ...` override that used to carry these.
  assert.equal(CSS.split("\n.evidence-detail-tabs {").length - 1, 1);
  assert.ok(!CSS.includes(".evidence-detail-page .evidence-detail-tabs {"));
  const body = rule(".evidence-detail-tabs");
  assert.ok(body, "the corrected tab rule must exist");
  assert.match(body!, /position:\s*static/);
});

test("the tab bar cannot scroll vertically", () => {
  const body = rule(".evidence-detail-tabs")!;
  // `overflow-x: auto` with `overflow-y: visible` COMPUTES to auto on both
  // axes — that is where the internal vertical scrollbar came from. Pinning
  // `hidden` is the fix.
  assert.match(body, /overflow-x:\s*auto/);
  assert.match(body, /overflow-y:\s*hidden/);
  // The horizontal scrollbar is hidden visually; scrolling itself is intact.
  assert.match(body, /scrollbar-width:\s*none/);
  assert.ok(CSS.includes(".evidence-detail-tabs::-webkit-scrollbar"));
});

test("the tab bar keeps its tablist semantics", () => {
  assert.match(PAGE, /role="tablist"/);
  assert.match(PAGE, /aria-selected=\{activeTab === tab\.id\}/);
  assert.match(PAGE, /event\.key === "ArrowRight"/);
  assert.match(PAGE, /event\.key === "Home"/);
});

// ---------------------------------------------------------------------------
// Rail tonal hierarchy
// ---------------------------------------------------------------------------

test("headings are no longer painted near-black by an element selector", () => {
  // The rail headings are <h2>, so `.evidence-detail-page h2 { color: ... }`
  // (0-1-1) beat `.evidence-detail-rail-heading` (0-1-0) and flattened four
  // tonal levels into one.
  const body = rule(".evidence-detail-page h1,\n.evidence-detail-page h2,\n.evidence-detail-page h3,\n.evidence-detail-page h4");
  assert.ok(body, "the typeface rule should remain");
  assert.ok(!/color:/.test(body!), "it must no longer set a colour");
});

test("the rail declares four deliberate tonal levels", () => {
  // Headings: medium dark neutral, not full primary black.
  assert.match(
    rule(".evidence-detail-sidebar .evidence-detail-rail-heading")!,
    /color:\s*var\(--app-ink-label\)/,
  );
  // Labels muted, values primary ink — on the rail's REAL classes. An earlier
  // pass added rules for `evidence-detail-field-label` / `-value`, which the
  // rail never renders, so they styled nothing and have been deleted.
  assert.match(rule(".evidence-detail-rail-field__label")!, /color:\s*var\(--app-ink-secondary\)/);
  assert.match(rule(".evidence-detail-rail-field__value")!, /color:\s*var\(--app-ink-heading\)/);
  assert.ok(
    !CSS.includes("evidence-detail-field-label"),
    "the invented label class must not come back",
  );
  // No blanket opacity on the rail or a section.
  assert.ok(!/\.evidence-detail-sidebar\s*\{[^}]*opacity:/.test(CSS));
});

// ---------------------------------------------------------------------------
// Translucent surfaces
// ---------------------------------------------------------------------------

test("sections and cards join the shared translucent hierarchy", () => {
  assert.match(
    rule(".evidence-detail-page .evidence-detail-section")!,
    /background:\s*var\(--surface-translucent-outer\)/,
  );
  assert.match(
    rule(".evidence-detail-page .evidence-detail-card,\n.evidence-detail-page .evd-card")!,
    /background:\s*var\(--surface-translucent-inner\)/,
  );
});

test("the page no longer paints a flat white ground under them", () => {
  assert.ok(!/\.evidence-detail-page\s*\{[^}]*background:\s*#ffffff/.test(CSS));
});

test("reduced-transparency and forced-colors fallbacks exist", () => {
  assert.ok(CSS.includes("@media (prefers-reduced-transparency: reduce)"));
  assert.ok(CSS.includes("@media (forced-colors: active)"));
});

test("no page-wide opacity is used to fake translucency", () => {
  assert.ok(!/\.evidence-detail-page\s*\{[^}]*\bopacity:/.test(CSS));
});

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

test("artifact family cards share fixed grid tracks", () => {
  const body = rule(".evidence-detail-artifact-card__head")!;
  // Content-sized tracks put one card's action at x=1033 and another's at
  // x=800 on the same page. Fixed tracks are what share the axes.
  assert.match(body, /var\(--evidence-artifact-icon/);
  assert.match(body, /var\(--evidence-artifact-action-w/);
  assert.ok(!/grid-template-columns:\s*auto minmax\(0, 1fr\) auto/.test(body));
  // The tracks live on the canonical rule, not on a more-specific override.
  assert.ok(
    !CSS.includes("\n.evidence-detail-artifacts .evidence-detail-artifact-card__head {"),
    "the head override must be folded in, not stacked",
  );
});

test("the download action fills its track so buttons share both axes", () => {
  assert.match(rule(".evidence-detail-artifact-card__action")!, /justify-self:\s*stretch/);
  // And the TOP-LEVEL override that used to carry it is gone, not merely
  // out-cascaded. The copy inside `@media (max-width: 760px)` stays: that one
  // is the mobile stack, a responsive variant rather than a duplicate.
  assert.ok(
    !CSS.includes("\n.evidence-detail-artifacts .evidence-detail-artifact-card__action {"),
  );
});

test("Latest and Immutable recorded stay metadata, not green success badges", () => {
  const body = rule(".evidence-detail-artifacts [data-evidence-artifact-marker]")!;
  assert.match(body, /border:\s*0/);
  assert.match(body, /background:\s*none/);
  assert.match(body, /color:\s*var\(--app-ink-secondary\)/);
});

test("artifact focus indication is :focus-visible only, and still present", () => {
  assert.ok(
    CSS.includes(".evidence-detail-artifacts .evidence-detail-artifact-card__action > *:focus-visible"),
    "keyboard focus must remain visible",
  );
  assert.match(
    rule(".evidence-detail-artifacts .evidence-detail-artifact-card__action > *:focus-visible")!,
    /outline:\s*2px solid var\(--accent-500\)/,
  );
});

// ---------------------------------------------------------------------------
// Palette discipline
// ---------------------------------------------------------------------------

test("the shell declares no page-local copy of the canonical accent", () => {
  // The corrections must reference tokens. A literal #7C3AED here would be a
  // second copy of the accent that a token change could not move.
  const corrections = CSS.slice(CSS.indexOf("PRODUCTION POLISH — shell corrections"));
  assert.ok(!/#7C3AED/i.test(corrections));
  assert.ok(!/#6D28D9/i.test(corrections));
  assert.ok(!/#F2ECFE/i.test(corrections));
});

test("a disabled download states a real reason", () => {
  assert.match(PAGE, /reportDownloadBlockedReason/);
  assert.match(PAGE, /packageDownloadBlockedReason/);
  assert.match(PAGE, /data-evidence-download-blocked-reason/);
  // The reason comes from the authorities that hold it, never invented.
  assert.match(PAGE, /exportBlockedReason/);
  assert.match(PAGE, /artifactStatus\.verificationPackage\.blockedReason/);
});
