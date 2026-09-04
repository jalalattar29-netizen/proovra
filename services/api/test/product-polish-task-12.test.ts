/**
 * PRODUCT POLISH (2026-09-04) — the seven UI closures, pinned at the source.
 *
 * These are source-contract tests, the pattern the rest of this suite uses for
 * web surfaces: they read the shipped file and assert the property that was
 * actually wrong, with enough of the reasoning that somebody undoing one has to
 * read why it exists first.
 *
 * Every assertion here was verified in a real browser against the local fixture
 * before it was written down — the numbers in the comments are measured, not
 * predicted. What a test file can hold is the SHAPE that produced them; the
 * measurements themselves are in the change's own report.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WEB = resolve(REPO_ROOT, "apps/web");

const read = (rel: string) => readFileSync(resolve(WEB, rel), "utf8");

const SHELL_CSS = read("components/app-shell-v2/app-shell-v2.css");
const SIDEBAR = read("components/app-shell-v2/AppSidebarV2.tsx");
const PALETTE = read("components/navigation/CommandPalette.tsx");
const ROUTE_ICONS = read("lib/navigation/routeIcons.ts");
const REPORTS = read("components/reports-experience/ReportsIndex.tsx");
const MAP_PANEL = read("components/capture-location/CaptureLocationMapPanel.tsx");
const EXPORT_ACTION = read("components/governance/GovernedExportAction.tsx");
const API_CLIENT = read("lib/api.ts");

// ===========================================================================
// B — the header's workspace and account triggers
// ===========================================================================
describe("header triggers: content-driven width, left-aligned labels", () => {
  const copyRule = (() => {
    const start = SHELL_CSS.indexOf(".app-topbar-v2-workspace-copy,\n.app-topbar-v2-user-copy {");
    return SHELL_CSS.slice(start, SHELL_CSS.indexOf("}", start));
  })();

  it("the label column is aligned from the leading edge, logically", () => {
    /*
     * The symptom was labels floating in the middle of a wide pill. The cause
     * was not a layout rule at all: `<button>` computes `text-align: center`
     * by default and the column inherited it. `start`, not `left`, so the
     * Arabic build reads from its own leading edge.
     */
    expect(copyRule).toContain("text-align: start;");
    expect(copyRule).not.toContain("text-align: left;");
  });

  it("the column may shrink but never grow past its content", () => {
    expect(copyRule).toContain("flex: 0 1 auto;");
    expect(copyRule).toContain("min-width: 0;");
  });

  it("it does not use align-items to say 'left' — that breaks truncation", () => {
    /*
     * `align-items: flex-start` sizes each line to its own max-content, so
     * `text-overflow: ellipsis` has nothing to clip against and a long
     * organization name spills out of the capped trigger instead of
     * truncating. Measured at 317px of text inside a 220px button.
     */
    expect(copyRule).not.toContain("align-items: flex-start");
  });

  it("both lines still carry the ellipsis they truncate with", () => {
    const nameRule = SHELL_CSS.slice(
      SHELL_CSS.indexOf(".app-topbar-v2-user-copy strong,"),
      SHELL_CSS.indexOf(".app-topbar-v2-workspace-copy [data-workspace-scope-line],"),
    );
    expect(nameRule).toContain("text-overflow: ellipsis;");
    expect(nameRule).toContain("white-space: nowrap;");
  });

  it("narrow viewports drop the secondary line rather than overlap the header", () => {
    /*
     * Measured at 768x900 in an organization workspace: the right zone wanted
     * 657px of a 753px header, the grid's centre track collapsed to 0, and the
     * search button painted across the navigation hamburger and under New
     * Case. The scope line was also the WIDER of the trigger's two lines, so
     * it — not the workspace name — was setting the width.
     */
    const narrow = SHELL_CSS.slice(SHELL_CSS.indexOf("HEADER TRIGGERS — NARROW-VIEWPORT COMPACTION"));
    expect(narrow).toContain("@media (max-width: 900px)");
    expect(narrow).toContain("[data-context-chip-scope-line]");
    expect(narrow).toContain(".app-topbar-v2-user-copy span");
  });

  it("the narrow-header hiding outranks the touch floor that had un-hidden it", () => {
    /*
     * The 980px block hides the topbar's New Case, runtime pill and language
     * button. The touch-floor block at the end of the file sets
     * `display: inline-flex` on those same elements to centre an icon in a
     * 44px target, later in the file and at equal-or-higher specificity — so
     * a sizing rule was silently resurrecting three controls a responsive
     * rule had removed, and that is what overflowed the 768px header.
     *
     * Every selector in that block is prefixed with `.app-account-toolbar` to
     * outrank it. Removing a prefix restores the overlap.
     */
    const block = SHELL_CSS.slice(
      SHELL_CSS.indexOf("@media (max-width: 980px)"),
      SHELL_CSS.indexOf("@media (max-width: 419px)"),
    );
    for (const selector of [
      ".app-account-toolbar .app-header-zone-right .app-header-primary-action",
      ".app-account-toolbar .app-topbar-v2-runtime",
      ".app-account-toolbar .app-topbar-v2-language",
    ]) {
      expect(block, `${selector} must stay prefixed`).toContain(selector);
    }
  });
});

// ===========================================================================
// C — one route→icon authority, read by both surfaces
// ===========================================================================
describe("route icons: one map, two consumers", () => {
  it("the sidebar no longer keeps a private icon map", () => {
    expect(SIDEBAR).not.toContain("ICON_BY_ROUTE_ID");
    expect(SIDEBAR).toContain('from "../../lib/navigation/routeIcons"');
    expect(SIDEBAR).toContain("routeIconFor(route.id)");
  });

  it("the command palette reads the same authority", () => {
    expect(PALETTE).toContain('from "../../lib/navigation/routeIcons"');
    expect(PALETTE).toContain("routeIconFor(item.route.id)");
  });

  it("every palette result row renders an icon", () => {
    expect(PALETTE).toContain("data-command-palette-result-icon");
    // Decorative: the title beside it already names the destination.
    const iconBlock = PALETTE.slice(
      PALETTE.indexOf("data-command-palette-result-icon"),
      PALETTE.indexOf("<ResultIcon"),
    );
    expect(iconBlock).toContain("flex: \"0 0 auto\"");
  });

  it("the icon is 16-18px and the selected row's is the highlight ink", () => {
    expect(PALETTE).toContain("<ResultIcon size={17}");
    expect(PALETTE).toContain('isHighlighted ? "#4338ca" : "#64748b"');
  });

  it("no route id can fall through without an icon", () => {
    // Explicit entry, then registry namespace, then the default. The helper
    // never returns null, so a caller can render the result directly.
    expect(ROUTE_ICONS).toContain("export function routeIconFor(routeId: string): RouteIcon {");
    expect(ROUTE_ICONS).toContain("?? DEFAULT_ROUTE_ICON;");
  });

  it("the sidebar's own destinations all kept an explicit glyph", () => {
    for (const id of [
      "workspace.home",
      "workspace.capture",
      "workspace.evidence",
      "workspace.cases",
      "workspace.reports",
      "workspace.search",
      "workspace.collaboration_teams",
      "workspace.operations",
      "account.notifications",
      "account.billing",
      "account.settings",
    ]) {
      expect(ROUTE_ICONS, `${id} lost its explicit icon`).toContain(`"${id}":`);
    }
  });
});

// ===========================================================================
// D — the Reports empty state
// ===========================================================================
describe("reports empty state is one surface", () => {
  it("the wrapper no longer borrows the Cases empty-state box", () => {
    /*
     * `cases-empty` paints its own border, radius and 32px padding. Inside the
     * section card, around an `EmptyState framed` that draws its own frame,
     * that made three nested boxes for one sentence.
     */
    const empty = REPORTS.slice(REPORTS.indexOf("data-reports-empty={filter}") - 800);
    expect(empty.slice(0, 1200)).not.toContain('className="cases-empty"');
    expect(REPORTS).toContain("data-reports-empty-kind");
  });

  it("it still uses the shared primitive rather than a local one", () => {
    expect(REPORTS).toContain('import { EmptyState } from "../ui/EmptyState";');
    expect(REPORTS).toContain("<EmptyState\n        framed");
  });
});

// ===========================================================================
// F — the sidebar fits the screen it is on
// ===========================================================================
describe("sidebar short-viewport density", () => {
  const density = SHELL_CSS.slice(SHELL_CSS.indexOf("/* SIDEBAR SHORT-VIEWPORT DENSITY */"));

  it("is keyed on viewport height alone — never on plan, role or workspace kind", () => {
    for (const tier of [
      "@media (pointer: fine) and (max-height: 900px)",
      "@media (pointer: fine) and (max-height: 820px)",
      "@media (pointer: fine) and (max-height: 740px)",
    ]) {
      expect(density, `${tier} missing`).toContain(tier);
    }
  });

  it("never reduces a touch target — the 44px floor is for a thumb", () => {
    /*
     * Rows shrink to 40px and then 38px under `pointer: fine` only. On a
     * coarse pointer the earlier `(pointer: coarse), (max-width: 900px)` block
     * still pins 44px and those users keep the scroll, which is the correct
     * trade.
     */
    const heightTiers = density.match(/@media \(pointer: fine\)[^{]*\{/g) ?? [];
    expect(heightTiers.length).toBeGreaterThanOrEqual(3);
    expect(density).not.toMatch(/@media \(pointer: coarse\)/);
    const coarse = SHELL_CSS.slice(SHELL_CSS.indexOf("@media (pointer: coarse), (max-width: 900px) {"));
    expect(coarse).toContain(".app-sidebar-v2-link {\n    height: 44px;");
  });

  it("does not shrink type at any height", () => {
    expect(density).not.toContain("font-size");
  });

  it("hides no navigation row — only the storage readout, and only at 720p", () => {
    const tier3 = density.slice(density.indexOf("@media (pointer: fine) and (max-height: 740px)"));
    expect(tier3).toContain(".app-sidebar-v2-storage {\n    display: none;");
    expect(tier3).not.toContain(".app-sidebar-v2-link");
    expect(tier3).not.toContain(".app-sidebar-v2-help");
    expect(density).not.toContain(".app-sidebar-v2-nav {\n    display: none");
  });
});

// ===========================================================================
// E — OTS "anchored" is success
// ===========================================================================
describe("home verification summary", () => {
  const HOME = read("components/home-experience/HomeSections.tsx");

  it("anchored carries the success tone, and only anchored changed", () => {
    expect(HOME).toContain('{ text: `${trust.otsAnchored} anchored`, tone: "ok" as const }');
    expect(HOME).toContain('{ text: `${trust.otsPending} pending`, tone: "warn" as const }');
  });

  it("the tone is the existing token, not a new colour", () => {
    // `ok` resolves through trustToneStyle to HOME_SEMANTIC.success.strong —
    // the same green the TSA "stamped" segment already used.
    expect(HOME).not.toMatch(/otsAnchored[\s\S]{0,120}#[0-9a-fA-F]{6}/);
  });
});

// ===========================================================================
// G — the integrity map's two actions
// ===========================================================================
describe("capture-location map actions", () => {
  /*
   * Comments stripped first. The JSX carries a note naming the exact legacy
   * values it replaced, so an assertion that simply searched the region would
   * be matching the explanation of the fix rather than the fix.
   */
  const codeOnly = MAP_PANEL.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  /*
   * Bounded to the two ACTIONS. The map graphics above them keep their own
   * palette — the accuracy radius is a teal circle drawn over imagery, which
   * is a map symbol rather than a control, and is not what this change was
   * about.
   */
  const actions = codeOnly.slice(
    codeOnly.indexOf('data-map-action="copy-coordinates"'),
    codeOnly.indexOf("Open in map"),
  );

  it("wear the canonical tokens, not literal legacy colours", () => {
    expect(actions).toContain("var(--card, #ffffff)");
    expect(actions).toContain("var(--ink-primary, #0f172a)");
    expect(actions).toContain("var(--accent-600, #6d28d9)");
  });

  it("dropped the old dark translucent pill entirely", () => {
    for (const legacy of [
      "rgba(14,22,26,0.56)",
      "rgba(15,42,36,0.78)",
      "rgba(103, 199, 190, 0.34)",
      "backdropFilter",
      "textTransform: \"uppercase\"",
    ]) {
      expect(actions, `${legacy} must not survive`).not.toContain(legacy);
    }
  });

  it("are addressable, so a layout probe can find them", () => {
    expect(MAP_PANEL).toContain('data-map-action="copy-coordinates"');
    expect(MAP_PANEL).toContain('data-map-action="open-in-map"');
  });
});

// ===========================================================================
// H — the first-load flash, and the duplicate reads behind a slow page
// ===========================================================================
describe("governed export placeholder", () => {
  it("a compact caller gets its own control back, inert — not a white panel", () => {
    /*
     * The loading state rendered `panelStyle` unconditionally: a block-level
     * `#fff` div with a border and 0.75rem of padding, stretched to the row's
     * width. Two per row across a full Reports index is what flashed. The
     * compact placeholder is the caller's own button, so the footprint is
     * identical before and after the fetch.
     */
    const loading = EXPORT_ACTION.slice(
      EXPORT_ACTION.indexOf("if (loading) {"),
      EXPORT_ACTION.indexOf("if (!data) {"),
    );
    expect(loading).toContain("if (compactWhenAllowed) {");
    expect(loading).toContain("renderAction({ disabled: true, onClick: () => {} })");
    expect(loading).toContain('data-governed-export-loading-form="compact"');
  });

  it("the placeholder cannot become a way to export without eligibility", () => {
    const compact = EXPORT_ACTION.slice(
      EXPORT_ACTION.indexOf("if (compactWhenAllowed) {"),
      EXPORT_ACTION.indexOf('data-governed-export-loading-form="panel"'),
    );
    expect(compact).toContain("disabled: true");
    expect(compact).not.toContain("onAction");
    expect(compact).not.toContain("handleClick");
  });

  it("a non-compact caller keeps the panel, because its resolved form is one", () => {
    expect(EXPORT_ACTION).toContain('data-governed-export-loading-form="panel"');
    expect(EXPORT_ACTION).toContain("Checking eligibility for {actionLabel}…");
  });
});

describe("apiFetch shares overlapping identical reads", () => {
  it("merges only GETs, and only while they overlap", () => {
    const key = API_CLIENT.slice(
      API_CLIENT.indexOf("function readKeyFor("),
      API_CLIENT.indexOf("function cloneResult("),
    );
    expect(key).toContain('if (method !== "GET") return null;');
    expect(key).toContain("if (init.body != null) return null;");
    expect(key).toContain("if (init.signal) return null;");
  });

  it("is not a cache — the entry is dropped the moment the read settles", () => {
    const wrapper = API_CLIENT.slice(
      API_CLIENT.indexOf("export async function apiFetch("),
      API_CLIENT.indexOf("async function runApiFetch("),
    );
    expect(wrapper).toContain("} finally {");
    expect(wrapper).toContain("inFlightReads.delete(key);");
  });

  it("never shares between users — the map is switched off without a window", () => {
    /*
     * A module-level map keyed without a caller identity would be a
     * cross-request leak in a server runtime. The sharing is switched off
     * where there is no single user to share between, rather than left to
     * depend on where the module happens to load.
     */
    expect(API_CLIENT).toContain('if (typeof window === "undefined") return null;');
  });

  it("hands each extra caller its own copy of the payload", () => {
    expect(API_CLIENT).toContain("return cloneResult(await existing);");
    expect(API_CLIENT).toContain("structuredClone(value)");
  });

  it("the auth options are part of the key", () => {
    // An authenticated read and an anonymous one of the same path are
    // different requests and must not be merged.
    expect(API_CLIENT).toContain("|auth:${opts?.auth !== false}|retry:");
  });
});
