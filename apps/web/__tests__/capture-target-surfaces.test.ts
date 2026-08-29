/**
 * CAPTURE — the target surfaces, and the invariant that keeps them honest.
 *
 * Phase 2 built four presentation surfaces the page did not have: the trust
 * strip, blocker/warning progressive disclosure, the collapsed session-activity
 * log, and Final Readiness. None of them decides anything.
 *
 * THE INVARIANT WORTH THE MOST HERE
 * ---------------------------------------------------------------------------
 * `session-workflow.ts` gates Review & Sign on
 * `finishDisabled = busy || !sessionReadiness.canFinalize`. Final Readiness
 * renders `!busy && readiness.canFinalize` — the exact negation of the same
 * two values, on the same objects. They cannot contradict each other because
 * neither evaluates a rule; `computeSessionReadiness` decided before either
 * saw it. These tests pin that, and pin that no second engine appeared.
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
const TRUST = read("apps/web/app/(app)/capture/_lib/CaptureTrustStrip.tsx");
const SIGNALS = read("apps/web/app/(app)/capture/_lib/CaptureReadinessSignals.tsx");
const FINAL = read("apps/web/app/(app)/capture/_lib/CaptureFinalReadiness.tsx");
const ACTIVITY = read("apps/web/app/(app)/capture/_lib/CaptureActivityDisclosure.tsx");
const PANEL = read("apps/web/components/capture-v2/CaptureSessionPanel.tsx");
const WORKFLOW = read("apps/web/app/(app)/capture/_lib/session-workflow.ts");
const READINESS = read("apps/web/app/(app)/capture/_lib/session-readiness.ts");

// ---------------------------------------------------------------------------
// Trust strip
// ---------------------------------------------------------------------------

test("the trust strip carries the three intended items and no legal claim", () => {
  for (const [title, detail] of [
    ["Integrity by design", "Hash, map, and verify automatically"],
    ["End-to-end protected", "Encrypted storage and verifiable audit trail"],
    ["Verifiable audit trail", "Recorded evidence operations and preservation history"],
  ] as const) {
    assert.ok(TRUST.includes(title), `trust strip missing "${title}"`);
    assert.ok(TRUST.includes(detail), `trust strip missing "${detail}"`);
  }
  for (const banned of [
    "Court-ready",
    "Legally admissible",
    "Court approved",
    "Authenticity proven",
    "Truth verified",
  ]) {
    assert.ok(
      !code(TRUST).includes(banned),
      `trust strip must not claim "${banned}"`,
    );
  }
  assert.match(PAGE, /<CaptureTrustStrip \/>/);
  // Explanatory copy only — it reads no session state and decides nothing.
  assert.doesNotMatch(code(TRUST), /readiness|canFinalize|sessionItems/);
});

// ---------------------------------------------------------------------------
// Blockers and warnings
// ---------------------------------------------------------------------------

test("blockers and warnings render from the readiness authority, never reclassified", () => {
  assert.match(SIGNALS, /readiness\.blockers/);
  assert.match(SIGNALS, /readiness\.warnings/);
  assert.doesNotMatch(
    code(SIGNALS),
    /severity === "blocker"|computeSessionReadiness/,
    "the signals component must not classify or re-derive issues",
  );
  // ONE HOME. The rail already answered "what is blocking me?" in this
  // position; the component replaced those two hand-rolled sections rather
  // than adding a third copy in the main column.
  assert.match(PANEL, /<CaptureReadinessSignals readiness=\{sessionReadiness\} \/>/);
  assert.doesNotMatch(
    code(PAGE),
    /CaptureReadinessSignals/,
    "blockers and warnings must not also render in the main column",
  );
  assert.doesNotMatch(
    code(PANEL),
    /capture-issue-row|visibleBlockers|overflowWarnings/,
    "the panel must not keep a second, hand-rolled issue renderer",
  );
});

test("the rail's four-item cap and overflow line moved with the component", () => {
  assert.match(SIGNALS, /const VISIBLE_LIMIT = 4;/);
  assert.ok(SIGNALS.includes("issues.slice(0, VISIBLE_LIMIT)"));
  assert.ok(SIGNALS.includes("more {title.toLowerCase()}"));
});

test("zero blockers and zero warnings collapse to ONE compact row", () => {
  assert.match(
    SIGNALS,
    /const clear = blockers\.length === 0 && warnings\.length === 0;/,
  );
  assert.match(SIGNALS, /data-capture-signals="clear"/);
  assert.match(SIGNALS, /No blockers/);
  assert.match(SIGNALS, /No warnings/);
  assert.match(CSS, /\.capture-signals--clear \{/);
});

test("a blocker or a warning is surfaced expanded, never behind a disclosure", () => {
  // Rendered by a plain conditional on length — there is no collapsed state to
  // open, which is the point: a blocker the operator must hunt for reaches
  // them as a disabled button with no explanation.
  assert.match(SIGNALS, /\{blockers\.length > 0 \? \(/);
  assert.match(SIGNALS, /\{warnings\.length > 0 \? \(/);
  assert.doesNotMatch(SIGNALS, /useState/, "issues must not be collapsible");
  assert.match(CSS, /\[data-capture-signal-group="blockers"\][\s\S]{0,160}--capture-red/);
  assert.match(CSS, /\[data-capture-signal-group="warnings"\][\s\S]{0,160}--capture-orange/);
});

// ---------------------------------------------------------------------------
// Final Readiness — the invariant
// ---------------------------------------------------------------------------

test("Final Readiness projects the SAME predicate that gates Review & Sign", () => {
  assert.match(
    WORKFLOW,
    /const finishDisabled = busy \|\| !sessionReadiness\.canFinalize;/,
  );
  assert.match(FINAL, /const ready = !busy && readiness\.canFinalize;/);
  // Both the bar and the summary are handed the same objects.
  assert.match(
    PAGE,
    /<CaptureFinalReadiness readiness=\{sessionReadiness\} busy=\{busy\} \/>/,
  );
  assert.match(PAGE, /finishDisabled=\{finishDisabled\}/);
  assert.doesNotMatch(
    code(FINAL),
    /computeSessionReadiness|computeCaptureReadiness|requiredSteps|mappedStepIds/,
    "Final Readiness must not recompute readiness",
  );
});

test("Final Readiness states both verdicts in words, with truthful reasons", () => {
  assert.match(FINAL, /"Ready to finalize"/);
  assert.match(FINAL, /"Not ready to finalize"/);
  // The not-ready reason is the authority's own first blocker.
  assert.match(FINAL, /const first = readiness\.blockers\[0\];/);
  assert.match(FINAL, /readiness\.summary/);
  for (const banned of ["Court-ready", "Legally admissible", "Authenticity proven"]) {
    assert.ok(!FINAL.includes(banned));
  }
  // The verdict is text; colour repeats it and never carries it alone.
  assert.match(FINAL, /data-capture-final-readiness=\{ready \? "ready" : "not_ready"\}/);
});

test("busy is presented as work in flight, not as a failure", () => {
  assert.match(FINAL, /if \(busy\) return "Finishing the current operation\.";/);
  assert.match(CSS, /\[data-capture-busy="true"\][\s\S]{0,180}--capture-muted/);
});

// ---------------------------------------------------------------------------
// Session activity
// ---------------------------------------------------------------------------

test("session activity is a collapsed disclosure over canonical timeline state", () => {
  assert.match(PAGE, /<CaptureActivityDisclosure events=\{sessionTimeline\} \/>/);
  assert.match(ACTIVITY, /events: ReadonlyArray<SessionTimelineEvent>/);
  assert.match(
    ACTIVITY,
    /const \[open, setOpen\] = useState\(false\)/,
    "collapsed by default",
  );
  assert.doesNotMatch(
    code(ACTIVITY),
    /apiFetch|fetch\(|useEffect/,
    "the disclosure must not fetch or re-load on open",
  );
  // The source is real session state recorded by the orchestration hook.
  const ORCH = read(
    "apps/web/app/(app)/capture/_hooks/useCaptureSessionOrchestration.ts",
  );
  assert.match(ORCH, /recordTimelineEvent/);
  assert.match(ORCH, /setSessionTimeline/);
});

test("the activity disclosure is a real keyboard-operable button", () => {
  assert.match(ACTIVITY, /<button/);
  assert.match(ACTIVITY, /type="button"/);
  assert.match(ACTIVITY, /aria-expanded=\{open\}/);
  assert.match(ACTIVITY, /aria-controls=\{panelId\}/);
  assert.match(CSS, /\.capture-activity__toggle:focus-visible \{/);
});

// ---------------------------------------------------------------------------
// AI stays advisory
// ---------------------------------------------------------------------------

test("AI advisory stays outside deterministic integrity and readiness", () => {
  for (const [name, body] of [
    ["final readiness", FINAL],
    ["readiness signals", SIGNALS],
    ["trust strip", TRUST],
  ] as const) {
    assert.doesNotMatch(
      code(body),
      /aiRecommended|captureAiSummary|AiReview/,
      `${name} must not consume an AI signal`,
    );
  }
  // The authority exposes an AI field, and it is advisory: `canFinalize` is
  // decided without it.
  assert.match(READINESS, /aiRecommendedReview/);
  assert.doesNotMatch(
    READINESS,
    /canFinalize[^;\n]*aiRecommendedReview|aiRecommendedReview[^;\n]*canFinalize/,
    "AI review must never gate finalization",
  );
});

// ---------------------------------------------------------------------------
// Dead code + tokens
// ---------------------------------------------------------------------------

test("the dead capture-only CSS is gone, and its live groupmates survived", () => {
  for (const dead of [
    "capture-enterprise-step",
    "capture-enterprise-steps",
    "capture-enterprise-step-number",
    "capture-enterprise-security-card",
    "capture-security-shield",
  ]) {
    assert.ok(
      !CSS.includes(dead),
      `${dead} has zero consumers and must not remain in the sheet`,
    );
  }
  // Every class that shared a grouped selector with one of those is still
  // styled — the deletion split the groups rather than dropping them whole.
  for (const live of [
    "capture-requirement-index",
    "capture-enterprise-title-card",
    "capture-setup-strip",
    "capture-materials-board",
    "capture-main-panel",
    "capture-dropzone",
  ]) {
    assert.ok(CSS.includes(`.${live}`), `${live} lost its styling`);
  }
});

test("the new surfaces use canonical tokens, not invented colour", () => {
  const block = CSS.slice(CSS.indexOf("PHASE 2 — TARGET SURFACES"));
  assert.ok(block.length > 0, "the phase 2 block must exist");
  const hexes = [...block.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) =>
    m[0].toLowerCase(),
  );
  // Only token fallbacks, each matching the canonical value it falls back to.
  const allowed = new Set(["#ffffff", "#6d28d9", "#f2ecfe", "#067647"]);
  for (const hex of hexes) {
    assert.ok(allowed.has(hex), `${hex} is not a canonical value; use a token`);
  }
  assert.match(block, /var\(--capture-red\)/);
  assert.match(block, /var\(--capture-orange\)/);
  assert.match(block, /var\(--accent-600/);
});
