/**
 * Phase EVIDENCE-REVIEW-VISIBILITY / EVIDENCE-STALE-BANNER-FIX /
 * EVIDENCE-RISK-TONE — acceptance lock for the three post-refactor
 * hardening fixes:
 *
 *   1. Stale banner false-positive: after a self-initiated workflow
 *      save (or after the user clicks Reload), the baseline must be
 *      bumped so CollisionWarning does not interpret the user's own
 *      write as "another operator changed this record".
 *
 *   2. Review Workflow visibility: the enterprise Update Reviewer
 *      Workflow modal + the Assign reviewer affordances only render
 *      when `canSeeReviewerOps` is true. Personal Space / self-serve
 *      contexts keep the simpler review status + notes/comments
 *      affordances.
 *
 *   3. Old last-modified signal tone: downgraded from "warning"
 *      (amber) to a new "neutral" (gray) severity tier, relabelled
 *      to "File timestamp note" with plain-English copy. The
 *      severity sort in buildRiskSignals guarantees neutral never
 *      crowds out a real warning in the sidebar's top-4 slice.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EVIDENCE_DIR = resolve(__dirname, "../app/(app)/evidence/[id]");

function src(rel: string): string {
  return readFileSync(resolve(EVIDENCE_DIR, rel), "utf8");
}

const PAGE = src("page.tsx");
// The attention strip lives in its own file; the page renders it.
const STRIP = src("_tabs/WhatNeedsAttentionStrip.tsx");
const LIB = src("_tabs/_lib.tsx");
const ATTENTION = readFileSync(
  resolve(__dirname, "../../../packages/shared/src/evidence-attention.ts"),
  "utf8",
);
const REVIEW = src("_tabs/EvidenceReviewTab.tsx");
const CSS = src("evidence-detail.css");

// ---------------------------------------------------------------------------
// Fix 1 — Stale banner baseline refresh
// ---------------------------------------------------------------------------

test("Fix 1 — loadWorkspace accepts a `bumpBaseline` opt for self-initiated reloads", () => {
  // The orchestrator's loadWorkspace function gained an opt-in
  // baseline refresh mode. Without it, initialUpdatedAtUtc is set
  // once at first mount and never moves; with it, the baseline
  // jumps to the post-fetch updatedAt so the user's own write
  // doesn't trip CollisionWarning.
  // Phase 12 Point 4 (Pass H) wrapped this loader in `useCallback` so it can
  // be an honest effect dependency. The requirement is the OPT, not whether
  // the function is a bare async or a memoised one.
  assert.match(
    PAGE,
    /loadWorkspace\s*=\s*(?:useCallback\(\s*)?async\s*\(\s*opts\?:\s*\{\s*bumpBaseline\?:\s*boolean\s*\}\s*\)/,
  );
  assert.match(
    PAGE,
    /if\s*\(\s*opts\?\.bumpBaseline\s*\)\s*\{\s*\n?\s*setInitialUpdatedAtUtc\(newUpdatedAt\)/,
  );
});

test("Fix 1 — the `prev ??` baseline guard is still in place for non-bump loads", () => {
  // Background polling + first mount must NOT bump the baseline,
  // otherwise external changes during polling would silently
  // become the new baseline and CollisionWarning would never fire.
  assert.match(
    PAGE,
    /setInitialUpdatedAtUtc\(\(prev\)\s*=>\s*prev\s*\?\?\s*newUpdatedAt\)/,
  );
});

test("Fix 1 — saveWorkflow success path passes bumpBaseline: true", () => {
  assert.match(
    PAGE,
    /addToast\("Reviewer workflow updated", "success"\)[\s\S]{0,800}?loadWorkspace\(\{\s*bumpBaseline:\s*true\s*\}\)/,
  );
});

test("Fix 1 — CollisionWarning Reload click passes bumpBaseline: true", () => {
  assert.match(
    PAGE,
    /onReload=\{[^}]*loadWorkspace\(\{\s*bumpBaseline:\s*true\s*\}\)/,
  );
});

test("Fix 1 — other user-initiated mutations stay on the no-bump default", () => {
  // Lock / archive / trash / restore / label / case-assign etc.
  // do not bump reviewWorkflow.updatedAt server-side, so they
  // intentionally call loadWorkspace() without the bump opt.
  // Pin this with a sanity check that at least one bare
  // `loadWorkspace()` call remains (the polling effect + the
  // mutations).
  const bareCalls = (PAGE.match(/\bloadWorkspace\(\)/g) ?? []).length;
  assert.ok(bareCalls >= 5, `expected ≥5 bare loadWorkspace() calls, got ${bareCalls}`);
});

// ---------------------------------------------------------------------------
// Fix 2 — Review Workflow visibility gate
// ---------------------------------------------------------------------------

test("Fix 2 — the Update Reviewer Workflow modal renders only when canSeeReviewerOps", () => {
  // The orchestrator's modal `isOpen` is now ANDed with
  // canSeeReviewerOps. A stale `workflowOpen=true` on a Personal
  // Space session can never surface enterprise controls.
  assert.match(
    PAGE,
    /open=\{canSeeReviewerOps && workflowOpen\}\s*[\s\S]{0,240}title="Update reviewer workflow"/,
  );
});

test("Fix 2 — Review tab no longer carries the NotStartedEmptyState replacement block", () => {
  // REVIEW-TAB-STABILITY — the giant NOT_STARTED replacement card
  // (with its non-clickable bullet list) was removed. Status is now
  // surfaced inline via the workflow card / status box; the four
  // fake-action sentences and the data-evidence-review-empty
  // attribute are gone.
  assert.ok(
    !/NotStartedEmptyState/.test(REVIEW),
    "NotStartedEmptyState must be retired",
  );
  assert.ok(
    !/data-evidence-review-empty="NOT_STARTED"/.test(REVIEW),
    "empty-state data-attr must be retired",
  );
  for (const sentence of [
    "Add a comment or legal note",
    "Attach this record to a case",
    "Open the risk signals in the sidebar",
    "Download the report PDF or verification package",
  ]) {
    assert.ok(
      !REVIEW.includes(sentence),
      `non-clickable plain-text "${sentence}" must be removed`,
    );
  }
});

test("Fix 2 — Assign reviewer button is gated on canSeeReviewerOps inside the always-rendered Review actions row", () => {
  // The button still hides on Personal Space (no reviewer-ops surface
  // there) — it just lives in the always-rendered Review actions
  // section now, not the deleted empty-state card.
  assert.match(REVIEW, /data-evidence-review-actions/);
  assert.match(
    REVIEW,
    /canSeeReviewerOps\s*\?\s*\(\s*\n?\s*<button[\s\S]{0,300}Assign reviewer/,
  );
});

test("Fix 2 (2026-10-23) — 'Review not started' is the SERVER's call: review applicable AND the viewer can act", () => {
  // The strip used to derive this itself from a plan flag and a status, so a
  // viewer who could not start review was still prompted to. The shared
  // classifier now decides, from the server's review applicability and the
  // viewer's review permission; the strip only renders the result.
  assert.doesNotMatch(STRIP, /needsReviewer|canSeeReviewerOps|reviewWorkflow\?\.status/);
  assert.match(STRIP, /workspace\.attention/);
  assert.match(
    ATTENTION,
    /input\.review\.applicable && input\.review\.notStarted && input\.review\.viewerCanStart/,
  );
});

test("Fix 2 — enterprise still gets the full workflow: ReviewerWorkflowCard + EvidenceReviewActionsPanel", () => {
  // Phase IA-self-serve-completion gate stays untouched —
  // canSeeReviewerOps users see the full enterprise machinery.
  // ReviewerWorkflowCard now lives in the top Review Workflow slot
  // (status-stable layout); EvidenceReviewActionsPanel still mounts
  // separately for reviewer-ops users.
  assert.match(
    REVIEW,
    /canSeeReviewerOps\s*\?\s*\(\s*\n?\s*<ReviewerWorkflowCard/,
  );
  assert.match(REVIEW, /<EvidenceReviewActionsPanel/);
});

// ---------------------------------------------------------------------------
// Fix 3 — Old-last-modified neutral severity + sort + relabel
// ---------------------------------------------------------------------------

test("Fix 3 (2026-10-23) — the page derives NO risk signals of its own", () => {
  // buildRiskSignals merged server alerts with signals the page derived from
  // source context; it is gone, and nothing on the route re-derives them.
  assert.doesNotMatch(LIB, /buildRiskSignals|RiskSignalSeverity|normalizeSeverity/);
  assert.doesNotMatch(PAGE, /buildRiskSignals|reviewSignals/);
});

test("Fix 3 (2026-10-23) — 'File timestamp note' is an ADVISORY signal in the shared authority, never a failure", () => {
  assert.match(
    ATTENTION,
    /"FILE_TIMESTAMP_NOTE",\s*\{ category: "ADVISORY", tone: "advisory", placement: "SIGNAL", action: null \},\s*"File timestamp note",\s*"The file was last modified before it was uploaded\. This is common for existing documents and does not indicate manipulation\."/,
  );
  assert.doesNotMatch(ATTENTION, /"Old last-modified signal"/);
});

test("Fix 3 (2026-10-23) — classification is by CODE and ordered required → recommended → advisory", () => {
  assert.match(ATTENTION, /CATEGORY_RANK: Record<EvidenceAttentionCategory, number> = \{\s*ACTION_REQUIRED: 0,\s*ACTION_RECOMMENDED: 1,\s*ADVISORY: 2,/);
  assert.match(ATTENTION, /add\(alert\.code, ALERT_RULES\[alert\.code\], alert\.label, alert\.detail\)/);
});

test("Fix 3 — CSS carries a neutral signal-card variant with soft-gray surface", () => {
  // The new tier needs its own visible style or it would
  // fall through to the base card (which is fine but the
  // test pins that the gray surface is intentional).
  assert.match(
    CSS,
    /\.evidence-detail-signal-card\.neutral\s*\{\s*\n?\s*background:\s*#f8fafc/,
  );
});

test("Fix 3 (2026-10-23) — the strip lists only actionable items, with the category in WORDS", () => {
  assert.match(STRIP, /attention\.items\.filter\(\(i\) => i\.placement === "ATTENTION"\)/);
  assert.match(STRIP, /item\.category === "ACTION_REQUIRED" \? "Required" : "Recommended"/);
  assert.match(STRIP, /attention\.headline === "NO_ACTION"[\s\S]{0,400}No action required/);
});

// ---------------------------------------------------------------------------
// F-02 — reviewer operations are a COMMERCIAL entitlement, not an Enterprise
// surface
// ---------------------------------------------------------------------------

test("F-02 — canSeeReviewerOps reads reviewerOperationsIncluded, not the enterprise flag", () => {
  // THE DEFECT. The catalog includes reviewer operations for TEAM and above
  // (PlanCapabilities.reviewerOperationsIncluded, plan-catalog.ts:462/492) and
  // the server enforces exactly that field
  // (workspaceIncludesReviewerOperations -> reviewer-workspace.routes.ts:430).
  // This page gated the whole surface on `enterpriseSurfaces`, so a TEAM
  // workspace paid for reviewer comments, legal notes and annotations and
  // could not see one of them.
  assert.match(PAGE, /const canSeeReviewerOps = usePlanFeatureGate\("reviewerOperationsIncluded"\)/);
  assert.ok(
    !/const canSeeReviewerOps = enterpriseSurfaces/.test(PAGE),
    "reviewer operations must not be gated on the enterprise-surface flag",
  );
});

test("F-02 — the enterprise flag still gates the surfaces that ARE enterprise", () => {
  // Governance, intelligence and investigation are unchanged: the fix narrows
  // one gate to its own authority, it does not open the others.
  for (const gate of ["canSeeGovernance", "canSeeIntelligence", "canSeeInvestigation"]) {
    assert.match(
      PAGE,
      new RegExp(`const ${gate} = enterpriseSurfaces`),
      `${gate} must remain an enterprise-surface gate`,
    );
  }
});
