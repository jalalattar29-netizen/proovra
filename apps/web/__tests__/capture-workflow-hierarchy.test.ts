/**
 * CAPTURE — one stepper, one ingestion point, one screenful of context.
 *
 * WHAT THIS PINS
 * ---------------------------------------------------------------------------
 * Two duplications had grown on the page, and both cost the operator the same
 * thing: a second answer to a question the page had already answered.
 *
 *   THE STEPPER. `page.tsx` rendered its own four-step list — Intake method /
 *   Requirements / Evidence capture / Review & Sign — directly above the
 *   canonical five-stage `CaptureIntakeRail`. Two trackers, different models,
 *   and only the rail derives its state from the session.
 *
 *   THE UPLOAD. The hero carried a primary "Upload evidence" button opening
 *   the same picker as the Evidence Materials section below, which already
 *   owns Files / Folder / Photo / Video / Audio and the drop zone. The page's
 *   most prominent control bypassed the surface that shows what was added,
 *   what it mapped to, and what is still required.
 *
 * These are SOURCE assertions, which is what this repository's web suite uses
 * for composition facts. They prove the duplicates are gone and — the half
 * that matters more — that the survivors are still there.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

/** Strip comments — a prose mention of a retired pattern is not a usage. */
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");

const PAGE = read("apps/web/app/(app)/capture/page.tsx");
const GLOBALS = read("apps/web/app/globals.css");
const PANEL = read("apps/web/components/capture-v2/CaptureSessionPanel.tsx");
const READINESS_PANEL = read("apps/web/app/(app)/capture/_lib/CaptureReadinessPanel.tsx");
const SUGGESTIONS = read("apps/web/app/(app)/capture/_lib/CaptureSuggestionsPanel.tsx");
const CSS = read("apps/web/components/capture-v2/capture-v2.css");
const WORKSPACE = read("apps/web/components/capture-v2/capture-workspace.css");
const RAIL = read("apps/web/app/(app)/capture/_lib/CaptureIntakeRail.tsx");
const STAGES = read("apps/web/app/(app)/capture/_lib/captureIntakeStages.ts");

// ---------------------------------------------------------------------------
// One stepper
// ---------------------------------------------------------------------------

test("the page-local four-step list is gone", () => {
  const body = code(PAGE);
  assert.doesNotMatch(
    body,
    /className="capture-enterprise-steps"/,
    "the duplicate stepper section must not render",
  );
  // Its labels were the tell that it modelled a different flow.
  assert.doesNotMatch(body, /"Intake method", "Choose how to collect"/);
  assert.doesNotMatch(
    body,
    /activeWorkflowStep/,
    "the state that drove only the duplicate list must not linger",
  );
});

test("the canonical five-stage rail survives, and still drives from session state", () => {
  assert.match(PAGE, /<CaptureIntakeRail/);
  assert.match(PAGE, /items=\{sessionItems\}/);
  assert.match(PAGE, /readiness=\{computeCaptureReadiness\(\{/);
  // The five stages are the canonical catalog, not a copy in the page.
  for (const label of [
    "Select template",
    "Add materials",
    "Add context",
    "Review readiness",
    "Finish & sign",
  ]) {
    assert.ok(
      STAGES.includes(label),
      `the canonical stage catalog must still name "${label}"`,
    );
  }
  assert.match(RAIL, /stages\.map\(/);
});

// ---------------------------------------------------------------------------
// One ingestion point
// ---------------------------------------------------------------------------

test("the hero carries no upload action", () => {
  const hero = code(
    PAGE.slice(PAGE.indexOf("<PageHeader"), PAGE.indexOf("<CaptureTrustStrip")),
  );
  assert.doesNotMatch(hero, /primaryAction=/, "the hero must not carry an action");
  assert.doesNotMatch(hero, /Upload evidence/);
  assert.doesNotMatch(hero, /openFilePicker/);
  // …and the binding that existed only for it is gone.
  assert.doesNotMatch(code(PAGE), /ActionButton/);
});

test("Evidence Materials remains the one place material enters", () => {
  // Every intake affordance the page had, still present — this test would be
  // worthless if it only proved a deletion.
  assert.match(PAGE, /<CaptureDropzone/);
  assert.match(PAGE, /openFilePicker/);
  assert.match(PAGE, /aria-label="Upload evidence files"/);
  assert.match(PAGE, /aria-label="Upload evidence folder"/);
  assert.match(PAGE, /<CaptureRequirements/);
});

test("the intake pickers are reachable and labelled", () => {
  // Accessible names on the real file inputs, not on a decorative wrapper.
  for (const label of [
    'aria-label="Upload evidence files"',
    'aria-label="Upload evidence folder"',
  ]) {
    assert.ok(PAGE.includes(label), `missing ${label}`);
  }
});

// ---------------------------------------------------------------------------
// Vertical compression
// ---------------------------------------------------------------------------

test("page-level composition has ONE authority, and it is the workspace sheet", () => {
  // `capture-v2.css` still holds the palette and the state classes. What it no
  // longer decides is where anything goes: the shell, the grid, the panel
  // rhythm and the type scale are declared once, in the sheet that loads after
  // it. Pinning the old values would pin declarations that no longer take
  // effect — which is exactly what this test used to do.
  assert.ok(WORKSPACE.includes(".capture-enterprise-grid {"));
  assert.ok(
    WORKSPACE.includes("grid-template-columns: minmax(0, 1fr) 352px !important;"),
    "the working column must dominate and the rail must be a fixed support width",
  );
  assert.ok(WORKSPACE.includes("--cap-fs-body: 0.925rem;"), "one type scale");
  assert.ok(
    GLOBALS.indexOf("capture-workspace.css") > GLOBALS.indexOf("capture-v2.css"),
    "the composition sheet must load after the sheet it supersedes",
  );
});

test("the working column is a stack of panels, not a card of cards", () => {
  const col = WORKSPACE.slice(
    WORKSPACE.indexOf(".capture-main-panel {"),
    WORKSPACE.indexOf("}", WORKSPACE.indexOf(".capture-main-panel {")),
  );
  assert.ok(
    col.includes("background: transparent !important;"),
    "the column itself must not be a surface wrapping every other surface",
  );
  // Each band inside it gets the one shared panel geometry.
  for (const panel of [
    "capture-hero",
    "capture-setup-strip",
    "capture-requirements-panel",
    "capture-drop-zone-enterprise",
    "capture-materials-board",
  ]) {
    assert.ok(
      WORKSPACE.includes(`.capture-main-panel > .${panel},`) ||
        WORKSPACE.includes(`.capture-main-panel > .${panel} {`),
      `${panel} is not on the shared panel geometry`,
    );
  }
});

test("the hero and the closing surfaces live INSIDE the working column", () => {
  // The hero used to be a full-width band above the grid with the trust strip
  // pinned to its right, and Final Readiness and the action bar used to sit
  // below the grid. All four are bands of the working column now, which is
  // what makes the column read as one workflow from title to Review & Sign.
  const grid = PAGE.indexOf('<section className="capture-enterprise-grid">');
  const mainOpen = PAGE.indexOf("capture-main-panel", grid);
  const mainClose = PAGE.indexOf("</main>", mainOpen);
  assert.ok(grid > -1 && mainOpen > -1 && mainClose > -1);

  const column = PAGE.slice(mainOpen, mainClose);
  for (const inside of [
    '<section className="capture-hero">',
    "<CaptureTrustStrip />",
    "<CaptureActivityDisclosure",
    "<CaptureFinalReadiness",
    "<CaptureBottomBar",
  ]) {
    assert.ok(column.includes(inside), `${inside} must render inside the column`);
  }
  // And the rail is the column's sibling, not part of it.
  assert.ok(PAGE.indexOf("<CaptureSessionPanel", mainClose) > mainClose);
});

test("the responsive recomposition is deliberate at every named width", () => {
  // The rail stops being a column before it becomes too narrow to read; the
  // page becomes single-column below that; the action row stacks last.
  for (const bound of ["max-width: 1180px", "max-width: 860px", "max-width: 560px"]) {
    assert.ok(WORKSPACE.includes(bound), `no recomposition at ${bound}`);
  }
  // The 1180 rule is the one that turns the rail from a column into a band.
  const band = WORKSPACE.slice(WORKSPACE.indexOf("@media (max-width: 1180px)"));
  assert.ok(band.includes(".capture-session-column {"));
  assert.ok(band.includes("grid-template-columns: repeat(auto-fit"));
});

test("the setup strip no longer clips its own controls", () => {
  // `overflow: hidden` was what turned a control row that did not fit into a
  // control row the operator could not see — no scrollbar, no wrap, just gone.
  // Removed with the layout that needed it, and asserted here so it cannot
  // come back as a mask for the next such defect.
  let cursor = CSS.indexOf(".capture-setup-strip {");
  assert.ok(cursor > -1, "the strip must still be styled");
  while (cursor > -1) {
    const rule = CSS.slice(cursor, CSS.indexOf("}", cursor));
    assert.ok(
      !rule.includes("overflow: hidden"),
      "the setup strip must not clip; wrapping is the fix, hiding is not",
    );
    cursor = CSS.indexOf(".capture-setup-strip {", cursor + 1);
  }
  assert.ok(WORKSPACE.includes("overflow: visible !important;"));
});

test("the rail leads with Session status and keeps ONE issue surface", () => {
  assert.ok(PANEL.includes('data-capture-session-status='), "no session status surface");
  assert.ok(PANEL.includes("statusChecks.map("), "the status checks must render");
  // Those checks are reads of the authority, never rules of their own.
  assert.ok(!PANEL.includes("function computeStatus"));
  assert.ok(PANEL.includes("<CaptureReadinessSignals readiness={sessionReadiness} />"));
});

test("every capture capability the page had is still wired", () => {
  for (const marker of [
    "CaptureCameraOverlay",
    "CaptureSessionPanel",
    "CaptureOperationalSummary",
    "CaptureReadinessPanel",
    "CaptureBottomBar",
    "CaptureSuggestionsPanel",
    "ContextualHelp",
  ]) {
    assert.ok(PAGE.includes(marker), `capture lost ${marker}`);
  }
});

test("readiness still has ONE author", () => {
  // The page projects `computeCaptureReadiness`; it does not decide.
  assert.match(PAGE, /computeCaptureReadiness/);
  assert.doesNotMatch(
    code(PAGE),
    /function computeReadiness|const readinessVerdict =/,
    "the page must not grow a second readiness calculation",
  );
});

test("no prohibited legal claim appears on the capture surface", () => {
  for (const banned of [
    "Court-ready",
    "Legally admissible",
    "Court approved",
    "Authenticity proven",
  ]) {
    assert.ok(!PAGE.includes(banned), `capture must not claim "${banned}"`);
    assert.ok(!CSS.includes(banned), `capture must not claim "${banned}"`);
  }
});

// ---------------------------------------------------------------------------
// Top-of-page order, and the two blocks that left
// ---------------------------------------------------------------------------

test("the page states its identity before it gives advice", () => {
  // Help, Capture readiness and Suggested next steps used to render in the
  // band above the grid — so a reader met "what to do next" before "where am
  // I". Order is the whole point of this test: positions, not presence.
  const hero = PAGE.indexOf('<section className="capture-hero">');
  const trust = PAGE.indexOf("<CaptureTrustStrip />");
  const help = PAGE.indexOf("<ContextualHelp");
  const readiness = PAGE.indexOf("<CaptureReadinessPanel");
  const suggestions = PAGE.indexOf("<CaptureSuggestionsPanel");
  const setup = PAGE.indexOf('<section className="capture-setup-strip">');
  const requirements = PAGE.indexOf("<CaptureRequirements");
  const materials = PAGE.indexOf("<CaptureDropzone");
  const activity = PAGE.indexOf("<CaptureActivityDisclosure");
  const finalReadiness = PAGE.indexOf("<CaptureFinalReadiness");
  const actions = PAGE.indexOf("<CaptureBottomBar");
  const rail = PAGE.indexOf("<CaptureIntakeRail");

  const order = [
    ["intake plan", rail],
    ["hero", hero],
    ["trust strip", trust],
    ["help", help],
    ["capture readiness", readiness],
    ["suggested next steps", suggestions],
    ["collection setup", setup],
    ["requirements", requirements],
    ["evidence materials", materials],
    ["session activity", activity],
    ["final readiness", finalReadiness],
    ["review & sign", actions],
  ] as const;

  for (const [name, index] of order) {
    assert.ok(index > -1, `${name} is not on the page at all`);
  }
  for (let i = 1; i < order.length; i++) {
    assert.ok(
      order[i][1] > order[i - 1][1],
      `${order[i][0]} must come after ${order[i - 1][0]}`,
    );
  }
});

test("the workspace storage banner is gone from Capture", () => {
  // "Captured evidence will be stored in Personal Space · Personal Space" —
  // the app shell already names the workspace in its own header, and this said
  // it again, in weaker type, above the page's own title. The shared component
  // is untouched; only Capture's use of it is removed.
  assert.doesNotMatch(code(PAGE), /WorkspaceContextBanner/);
  assert.ok(!PAGE.includes("Captured evidence will be stored in"));
});

test("there is exactly ONE help block, and it is the compact disclosure", () => {
  // Two instructional blocks used to open the page: the collapsed
  // "Help · What capture does" disclosure, and a long "Capture, hash, verify"
  // panel that restated it with a checklist and a template recommendation.
  const body = code(PAGE);
  assert.equal(
    body.split("<ContextualHelp").length - 1,
    1,
    "exactly one contextual help block",
  );
  assert.doesNotMatch(body, /CaptureWorkflowGuidance/);
  assert.ok(!PAGE.includes("Capture, hash, verify"));
  assert.ok(!PAGE.includes("Recommended templates"));
});

test("the deleted guidance block left no source behind", () => {
  // The component and the module that fed it had no other consumer, so both
  // went with the block rather than lingering as dead code.
  for (const gone of [
    "apps/web/app/(app)/capture/_lib/CaptureWorkflowGuidance.tsx",
    "apps/web/app/(app)/capture/_lib/workflowGuidance.ts",
  ]) {
    assert.ok(!existsSync(resolve(ROOT, gone)), `${gone} should be deleted`);
  }
});

test("the hero carries the route's own identity mark", () => {
  const hero = PAGE.slice(
    PAGE.indexOf('<section className="capture-hero">'),
    PAGE.indexOf("<CaptureTrustStrip"),
  );
  assert.match(hero, /capture-hero__mark/);
  assert.match(hero, /<Camera size=\{22\}/);
  assert.match(WORKSPACE, /\.capture-hero__mark \{/);
  // Still no ingestion control in the hero.
  assert.doesNotMatch(code(hero), /openFilePicker|primaryAction=/);
});

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

test("Capture opts out of the white page canvas, and only Capture", () => {
  // `.ui-page-shell` paints white for every page that uses it. The opt-out is
  // scoped by this surface's own class so it cannot reach another route.
  const rule = WORKSPACE.slice(
    WORKSPACE.indexOf(".capture-page-shell.capture-enterprise-page"),
  );
  assert.ok(rule.startsWith(".capture-page-shell.capture-enterprise-page"));
  assert.ok(
    rule.slice(0, 400).includes("background: transparent !important;"),
    "the page shell must not paint its own canvas",
  );
  assert.ok(
    !WORKSPACE.includes(".ui-page-shell {"),
    "the shared page primitive must not be restyled globally",
  );
});

test("panels are translucent surfaces, not white sheets", () => {
  assert.match(WORKSPACE, /--cap-panel: rgba\(255, 255, 255, 0\.74\);/);
  assert.match(WORKSPACE, /--cap-panel-quiet: rgba\(255, 255, 255, 0\.5\);/);
  // Rows and tiles inside a panel take no fill of their own.
  assert.match(WORKSPACE, /--cap-inset: transparent;/);
});

test("no decorative shadow survives on a Capture surface", () => {
  // The audit list is explicit so a new surface has to be added to it rather
  // than quietly arriving with a shadow.
  const block = WORKSPACE.slice(WORKSPACE.indexOf("§20 — SHADOWS"));
  for (const surface of [
    "capture-requirement-row",
    "capture-trust-item",
    "capture-setup-mode",
    "capture-readiness-card",
    "capture-command-section",
    "capture-status-card",
    "capture-final-readiness",
    "capture-bottom-bar-inner",
  ]) {
    assert.ok(block.includes(`.${surface},`), `${surface} is not in the shadow audit`);
  }
});

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

test("requirement rows carry ONE meaning per colour", () => {
  const block = WORKSPACE.slice(WORKSPACE.indexOf("§9-§12 — REQUIREMENTS"));
  // The row itself is neutral in every state; the state is its leading rail.
  assert.ok(block.includes("border-inline-start-color: var(--capture-red) !important;"));
  assert.ok(
    block.includes("border-inline-start-color: var(--success, #067647) !important;"),
  );
  assert.ok(
    block.includes("border-inline-start-color: var(--capture-orange) !important;"),
  );
  // The index is a number, not a status — it had been accent-coloured.
  const index = block.slice(block.indexOf(".capture-requirement-index"));
  assert.ok(index.slice(0, 260).includes("color: var(--capture-muted) !important;"));
  // Accepted media types are information, so they are neutral.
  assert.ok(block.includes("span:not(.mapped):not(.missing):not(.optional)"));
});

test("the final action zone reads heading, then verdict, then one action", () => {
  // §14 — the section title is heading ink; it had been rendering in the
  // accent and competing with the button beside it.
  assert.match(
    WORKSPACE,
    /\.capture-bottom-bar-inner > div:first-child strong \{\s*color: var\(--capture-ink\) !important;/,
  );
  // §16 — one primary action, canonical accent, white label.
  const finish = WORKSPACE.slice(WORKSPACE.indexOf(".capture-finish-button:not(:disabled)"));
  assert.ok(finish.slice(0, 420).includes("background: var(--capture-accent) !important;"));
  assert.ok(finish.slice(0, 420).includes("color: #ffffff !important;"));
  // §15 — destructive secondary: light surface, red text, red border, never
  // filled and never louder than the action beside it.
  const clear = WORKSPACE.slice(WORKSPACE.indexOf(".capture-clear-button,"));
  assert.ok(clear.slice(0, 420).includes("background: #ffffff !important;"));
  assert.ok(clear.slice(0, 420).includes("color: var(--capture-red-dark) !important;"));
});

test("the readiness surfaces are tinted for attention, not for alarm", () => {
  // §8 — same three levels and the same semantics, at a third of the
  // saturation. `computeCaptureReadiness` is untouched.
  assert.match(READINESS_PANEL, /developing: \{\s*bg: "rgba\(247, 144, 9, 0\.045\)"/);
  assert.match(READINESS_PANEL, /ready: \{\s*bg: "rgba\(6, 118, 71, 0\.045\)"/);
  assert.match(READINESS_PANEL, /computeCaptureReadiness|CaptureReadinessSummary/);
});

test("the pipeline disclaimer is stated once", () => {
  // Readiness and Suggestions carried the same sentence one box apart, which
  // taught the reader to skip both. It stays on the surface that introduces
  // the idea; the meaning is unchanged.
  assert.ok(READINESS_PANEL.includes("capture pipeline (hashing"));
  assert.ok(!SUGGESTIONS.includes("capture pipeline (hashing"));
  // Suggestions still say what they are.
  assert.match(SUGGESTIONS, /data-capture-suggestions/);
});
