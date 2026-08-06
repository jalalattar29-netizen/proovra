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
const LIB = src("_tabs/_lib.tsx");
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
    /isOpen=\{canSeeReviewerOps && workflowOpen\}\s*[\s\S]{0,200}title="Update reviewer workflow"/,
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
    /canSeeReviewerOps\s*\?\s*\(\s*\n?\s*<Button[\s\S]{0,200}Assign reviewer/,
  );
});

test("Fix 2 — WhatNeedsAttentionStrip only flags needsReviewer when canSeeReviewerOps", () => {
  // Without the gate, Personal Space records that have no
  // workflow status would show a yellow "Review not started ·
  // Start" chip that opens an enterprise modal the user cannot
  // meaningfully use.
  assert.match(
    PAGE,
    /const needsReviewer\s*=\s*\n?\s*canSeeReviewerOps\s*&&\s*\n?\s*\(!workspace\.reviewWorkflow\?\.status/,
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

test("Fix 3 — RiskSignalSeverity exposes a 'neutral' tier", () => {
  assert.match(
    LIB,
    /export type RiskSignalSeverity\s*=\s*"danger"\s*\|\s*"warning"\s*\|\s*"info"\s*\|\s*"neutral"/,
  );
});

test("Fix 3 — oldLastModified is severity 'neutral' with the new label + copy", () => {
  // The advisory chip must NOT use "warning" tone (amber) and
  // must NOT use the old "Old last-modified signal" label, which
  // sounded forensic.
  assert.match(
    LIB,
    /clientSignalsSummary\.oldLastModified[\s\S]{0,800}?severity:\s*"neutral"/,
  );
  assert.match(LIB, /title:\s*"File timestamp note"/);
  assert.match(
    LIB,
    /detail:\s*\n?\s*"Client metadata shows the file was modified before upload\. This is common for existing documents and is advisory only\.",?/,
  );
  // Old label must be gone as a JSX/object-literal value.
  assert.doesNotMatch(LIB, /title:\s*"Old last-modified signal"/);
});

test("Fix 3 — buildRiskSignals sorts signals by severity (danger → warning → info → neutral)", () => {
  // Stable severity-first sort guarantees a neutral note never
  // crowds out a real warning in the sidebar's top-4 slice.
  assert.match(LIB, /RISK_SEVERITY_ORDER:\s*Record<RiskSignalSeverity,\s*number>/);
  assert.match(LIB, /danger:\s*0[\s\S]{0,80}warning:\s*1[\s\S]{0,80}info:\s*2[\s\S]{0,80}neutral:\s*3/);
  assert.match(
    LIB,
    /signals\.sort\(\s*\n?\s*\(a,\s*b\)\s*=>\s*RISK_SEVERITY_ORDER\[a\.severity\]\s*-\s*RISK_SEVERITY_ORDER\[b\.severity\]/,
  );
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

test("Fix 3 — WhatNeedsAttentionStrip pills route neutral + info to the muted pill class", () => {
  // The attention strip used to map "info" → "neutral" via a
  // brittle ternary that left "neutral" as the implicit else
  // branch (rendered as "danger"). After the fix, both neutral
  // AND info go to the muted pill explicitly, and an unknown
  // severity does not default to the red "danger" pill.
  assert.match(
    PAGE,
    /s\.severity === "danger"[\s\S]{0,80}"danger"[\s\S]{0,200}s\.severity === "warning"[\s\S]{0,80}"warning"[\s\S]{0,200}"neutral"/,
  );
  // Severity is also surfaced via data-attribute for tests +
  // analytics.
  assert.match(PAGE, /data-evidence-attention-risk-severity=\{s\.severity\}/);
});

test("Fix 3 — backend reviewerAlerts severity is normalized through buildRiskSignals", () => {
  // Unknown / future severity strings from the backend cannot
  // accidentally over-alert. "critical" / "high" map to "danger";
  // anything else falls back to "info" (not "warning").
  assert.match(LIB, /function normalizeSeverity\(s:\s*string\s*\|\s*null\s*\|\s*undefined\)/);
  assert.match(LIB, /if\s*\(s === "critical"\s*\|\|\s*s === "high"\)\s*return\s*"danger"/);
  assert.match(LIB, /return\s*"info"/);
});
