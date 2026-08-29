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
const CSS = read("apps/web/components/capture-v2/capture-v2.css");
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
    PAGE.slice(PAGE.indexOf("<PageHeader"), PAGE.indexOf("capture-enterprise-security-card")),
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

test("the top of the page spends less height before the first control", () => {
  // The measurable parts of the compression, asserted as the values they now
  // hold rather than as a percentage nobody can check.
  assert.match(CSS, /padding: 44px 28px 28px;/, "page top padding reduced");
  // Read the rule by its bounds rather than through a length-bounded regex:
  // the window would have to be re-tuned every time a comment in it changes.
  const shellStart = CSS.indexOf(".capture-enterprise-shell {");
  assert.ok(shellStart > -1, "the shell rule must exist");
  const shellRule = CSS.slice(shellStart, CSS.indexOf("}", shellStart));
  assert.match(
    shellRule,
    /gap: 14px;/,
    "the rhythm between stacked top sections is tightened",
  );
  // Both top cards were floored at 100px around a button that no longer
  // exists.
  assert.doesNotMatch(
    CSS,
    /\.capture-enterprise-title-card \{[\s\S]{0,200}min-height: 100px;/,
  );
  assert.doesNotMatch(
    CSS,
    /\.capture-enterprise-security-card \{[\s\S]{0,200}min-height: 100px;/,
  );
});

test("compression did not come out of the responsive rules", () => {
  // The narrow-viewport overrides for the top area must still exist; shrinking
  // desktop by breaking mobile would not be a win.
  assert.match(CSS, /@media[^{]*\{[\s\S]*?\.capture-enterprise-top \{/);
});

// ---------------------------------------------------------------------------
// Nothing else moved
// ---------------------------------------------------------------------------

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
