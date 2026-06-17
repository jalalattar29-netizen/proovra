/**
 * Evidence Detail — Source & Capture Context display contract.
 *
 * STRICT-HONESTY RULE
 * --------------------
 * A context card renders ONLY when PROOVRA has a real collected
 * value. Missing / not-recorded / not-collected / unavailable
 * signals are HIDDEN ENTIRELY — no placeholder cards, no friendly
 * "Not recorded" fallback, no "Unavailable context" secondary row.
 *
 * The bar is intentional: the Evidence Detail page can never look
 * like it is advertising internal signals we don't actually have.
 * If we want a signal in the future, we'll implement real
 * collection (device clock, screenshot heuristic, folder-upload
 * API) and only then surface it.
 *
 * What this test pins:
 *   - The integrity tab never emits the strings "Not recorded",
 *     "Client signal not collected", "Unavailable context",
 *     "Location not provided", or the displayUnavailableSignal
 *     output.
 *   - Every per-card render is guarded by a real-value check.
 *   - The signal-hiding helper (`shouldShowContextSignal`) refuses
 *     NOT_COLLECTED, UNAVAILABLE, null, undefined, and empty.
 *   - Friendly labels for real values still pass through unchanged
 *     (External intake / Secure upload session / Contributor
 *     browser permission).
 *   - The dead-button reviewer-status fix from the prior phase is
 *     NOT regressed.
 *
 * Approach: source-contract assertions (read file + match regex),
 * matching the rest of this codebase's test pattern. No runtime
 * import — `node --test` runs without a TS loader.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..", "..", "..");

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), "utf8");
}

const HELPER = "apps/web/lib/evidence/source-display.ts";
const TAB = "apps/web/app/(app)/evidence/[id]/_tabs/EvidenceIntegrityTab.tsx";
const CARD = "apps/web/app/(app)/evidence/[id]/components/ExternalIntakeSourceCard.tsx";
const ROUTES = "services/api/src/routes/evidence.routes.ts";
const SCHEMA = "services/api/prisma/schema.prisma";

// ============================================================================
// Helper module — public surface + friendly labels for REAL values only
// ============================================================================

test("source-display helper exports the four public functions", () => {
  const src = read(HELPER);
  for (const fn of [
    "displaySourceType",
    "displayCaptureMethod",
    "shouldShowContextSignal",
    "displayUnavailableSignal",
  ]) {
    assert.match(
      src,
      new RegExp(`export function ${fn}\\(`),
      `${fn} must be exported from source-display.ts`,
    );
  }
});

test("EXTERNAL_INTAKE_UPLOAD source type → 'External intake'", () => {
  const src = read(HELPER);
  assert.match(src, /if \(cm === "EXTERNAL_INTAKE_UPLOAD"\) return "External intake";/);
});

test("EXTERNAL_INTAKE_UPLOAD capture method → 'Secure upload session'", () => {
  const src = read(HELPER);
  assert.match(
    src,
    /case "EXTERNAL_INTAKE_UPLOAD":[\s\S]{0,500}return "Secure upload session";/,
  );
});

test("MULTIPART_PACKAGE relabelled to 'Multi-file submission'", () => {
  const src = read(HELPER);
  assert.match(
    src,
    /case "MULTIPART_PACKAGE":[\s\S]{0,300}return "Multi-file submission";/,
  );
  assert.ok(
    !/return "Multipart package"/.test(src),
    "the helper must not surface 'Multipart package' to users",
  );
});

test("PROOVRA secure capture wording is preserved (no regression)", () => {
  const src = read(HELPER);
  assert.match(
    src,
    /case "SECURE_CAMERA":[\s\S]{0,200}return "Captured with PROOVRA secure camera";/,
  );
  assert.match(src, /return "PROOVRA secure capture";/);
});

test("shouldShowContextSignal hides every missing/unavailable state", () => {
  const src = read(HELPER);
  // Whitelist approach — only DETECTED + COLLECTED_FALSE pass. Every
  // other state (NOT_COLLECTED, UNAVAILABLE, null, undefined,
  // empty string, future enum value) returns false.
  assert.match(src, /return s === "DETECTED" \|\| s === "COLLECTED_FALSE";/);
});

// ============================================================================
// Integrity tab — strict-honesty render rule
// ============================================================================

test("Integrity tab imports the helpers (no inline ugly strings)", () => {
  const tab = read(TAB);
  assert.match(tab, /from "\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/lib\/evidence\/source-display"/);
  assert.match(tab, /displaySourceType\(/);
  assert.match(tab, /displayCaptureMethod\(/);
  assert.match(tab, /shouldShowContextSignal\(/);
  // The legacy raw-enum hack must be gone.
  assert.ok(
    !/sourceContext\.sourceType\.replace\(\/_\/g/.test(tab),
    "raw sourceType replace() hack must be removed",
  );
});

test("Integrity tab NEVER renders 'Not recorded' as a card value", () => {
  const tab = read(TAB);
  assert.ok(
    !/value: "Not recorded"/.test(tab),
    "'Not recorded' card value is forbidden — hide the card instead",
  );
  // No raw JSX text either.
  assert.ok(
    !/>Not recorded</.test(tab),
    "'Not recorded' must not appear as JSX text",
  );
});

test("Integrity tab NEVER renders 'Client signal not collected'", () => {
  const tab = read(TAB);
  assert.ok(
    !/Client signal not collected/.test(tab),
    "'Client signal not collected' must not appear in the integrity tab",
  );
});

test("Integrity tab does NOT render the 'Unavailable context' secondary row", () => {
  const tab = read(TAB);
  assert.ok(
    !/Unavailable context:/.test(tab),
    "The 'Unavailable context:' row was removed — missing signals are hidden, not summarised",
  );
  assert.ok(
    !/data-evidence-unavailable-context=/.test(tab),
    "the data attr that anchored the Unavailable context row must be gone",
  );
  assert.ok(
    !/displayUnavailableSignal\(/.test(tab),
    "displayUnavailableSignal() must not be used on the primary Evidence UI",
  );
});

test("Integrity tab NEVER renders 'Location not provided' (absence IS the message)", () => {
  const tab = read(TAB);
  assert.ok(
    !/"Location not provided"/.test(tab),
    "No fallback string for missing location — drop the card entirely",
  );
  // Missing location must never be framed as integrity failure.
  assert.ok(
    !/integrity.*location.*missing|location.*integrity.*failure/i.test(tab),
    "missing location must never be framed as an integrity failure",
  );
});

test("Device time card only renders when deviceTimeIso is truthy", () => {
  const tab = read(TAB);
  // Unconditional "Device time" row that previously surfaced "Not
  // recorded" must be gone.
  assert.ok(
    !/{ label: "Device time", value: formatValue\(workspace\.sourceContext\.deviceTimeIso\) }/.test(
      tab,
    ),
    "the unconditional Device time row was the source of 'Not recorded' cards",
  );
  // Guard exists. Accept either the cached `sc.` alias or the long
  // `workspace.sourceContext.` form so the test doesn't pin a
  // specific local variable name.
  assert.match(
    tab,
    /if \((sc|workspace\.sourceContext)\.deviceTimeIso\)/,
  );
});

test("Location card only renders when locationIncluded is true", () => {
  const tab = read(TAB);
  assert.match(
    tab,
    /if \((sc|workspace\.sourceContext)\.locationIncluded\)\s*\{[\s\S]{0,300}label: "Location included"/,
  );
});

test("Every describeClientSignalState call is guarded by shouldShowContextSignal", () => {
  const tab = read(TAB);
  const callsToDescribe = tab.match(/describeClientSignalState\(/g) ?? [];
  const callsToGuard = tab.match(/shouldShowContextSignal\(/g) ?? [];
  assert.ok(
    callsToGuard.length >= callsToDescribe.length,
    `every describeClientSignalState() must be guarded by shouldShowContextSignal() — found ${callsToDescribe.length} unguarded`,
  );
});

test("Source type card is suppressed when helper returns 'Source not recorded'", () => {
  const tab = read(TAB);
  assert.match(
    tab,
    /sourceTypeLabel !== "Source not recorded"/,
    "the Source type card must be hidden when the helper has no real value",
  );
});

test("Capture method card is suppressed when helper returns 'Capture method not recorded'", () => {
  const tab = read(TAB);
  assert.match(
    tab,
    /captureMethodLabel !== "Capture method not recorded"/,
    "the Capture method card must be hidden when the helper has no real value",
  );
});

test("Captured at / Uploaded at cards only render when a real timestamp resolves", () => {
  const tab = read(TAB);
  // No unconditional render that previously fell through to the
  // em-dash placeholder from formatValue.
  assert.ok(
    !/{ label: "Captured at", value: formatValue\(formatUserDateTime\(workspace\.sourceContext\.capturedAtUtc\)\) }/.test(
      tab,
    ),
    "Captured at must be conditionally rendered, not unconditional with em-dash fallback",
  );
  assert.match(tab, /if \(capturedAt\)/);
  assert.match(tab, /if \(uploadedAt\)/);
});

test("Empty grid is suppressed — render nothing rather than an empty skeleton", () => {
  const tab = read(TAB);
  assert.match(
    tab,
    /if \(items\.length === 0\) return null;/,
    "a record with zero collected signals must render no grid at all",
  );
});

test("Intake-link evidence still renders Source type + Capture method (the meaningful pair)", () => {
  // Both helpers return real strings for EXTERNAL_INTAKE_UPLOAD, so
  // the strict-render rule lets them through. This re-pins the
  // helper output that the tab depends on.
  const helper = read(HELPER);
  assert.match(helper, /return "External intake";/);
  assert.match(helper, /return "Secure upload session";/);
});

// ============================================================================
// Reviewer status buttons (regression guard from prior phase)
// ============================================================================

test("REGRESSION GUARD: reviewer-status fix still reads nested workflow.status", () => {
  const card = read(CARD);
  assert.match(
    card,
    /review\?\.workflow\?\.status/,
    "the dead-button root-cause fix from the prior phase must remain in place",
  );
  assert.ok(
    !/review\?\.status === s/.test(card),
    "the legacy review?.status read must stay removed",
  );
  assert.match(card, /data-evidence-reviewer-status-btn=\{s\}/);
  assert.match(card, /aria-pressed=\{active\}/);
  assert.match(card, /savedFlashStatus/);
});

test("REGRESSION GUARD: five legally-safe reviewer status labels remain", () => {
  // Labels moved to the canonical reviewer-status lib so every
  // surface reads the same map. The External Intake card aliases
  // REVIEWER_STATUS_LABEL to its local STATUS_LABEL.
  const card = read(CARD);
  assert.match(card, /REVIEWER_STATUS_LABEL/);
  const libSrc = read("apps/web/app/(app)/evidence/lib/reviewer-status.ts");
  for (const label of [
    "Needs review",
    "In review",
    "Needs additional context",
    "Accepted for internal review",
    "Not accepted",
  ]) {
    assert.match(
      libSrc,
      new RegExp(label.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")),
      `legally-safe label "${label}" must remain in the canonical reviewer-status lib`,
    );
  }
});

test("REGRESSION GUARD: backend reviewer-workflow route + enum unchanged", () => {
  const routes = read(ROUTES);
  assert.match(routes, /"\/v1\/evidence\/:id\/reviewer-workflow"/);
  assert.match(routes, /ReviewerWorkflowUpdateBody\.parse/);
  const schema = read(SCHEMA);
  for (const s of [
    "NOT_STARTED",
    "IN_REVIEW",
    "NEEDS_INFO",
    "APPROVED_INTERNAL",
    "CLOSED",
  ]) {
    assert.ok(
      new RegExp(`^\\s+${s}\\s*$`, "m").test(schema),
      `enum value ${s} must exist in EvidenceReviewWorkflowStatus`,
    );
  }
});

// ============================================================================
// Backend label parity (no backend behaviour changes — labels only)
// ============================================================================

test("Backend mapCaptureMethodLabel: intake gets 'Secure upload session', multi-file gets 'Multi-file submission'", () => {
  const routes = read(ROUTES);
  assert.match(routes, /case "EXTERNAL_INTAKE_UPLOAD":/);
  assert.match(routes, /return "Secure upload session"/);
  assert.match(routes, /return "Multi-file submission"/);
  assert.ok(
    !/return "Multipart package"/.test(routes),
    "the old 'Multipart package' label must be retired",
  );
});

test("Backend buildSourceContext: EXTERNAL_INTAKE_UPLOAD short-circuits to 'external_intake'", () => {
  const routes = read(ROUTES);
  assert.match(
    routes,
    /captureMethod === prismaPkg\.CaptureMethod\.EXTERNAL_INTAKE_UPLOAD\s*\?\s*"external_intake"/,
  );
});
