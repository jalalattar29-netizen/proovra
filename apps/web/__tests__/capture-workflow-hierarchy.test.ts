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
import { readFileSync } from "node:fs";
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
    "CaptureWorkflowGuidance",
    "ContextualHelp",
    "WorkspaceContextBanner",
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
