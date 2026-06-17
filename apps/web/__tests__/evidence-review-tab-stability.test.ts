/**
 * REVIEW-TAB-STABILITY + ARTIFACTS-DEDUP + REVIEWER-STATUS-LABELS
 *
 * Pin the post-fix shape of /evidence/[id]:
 *
 *   - Artifacts tab: only the verify-link card on top; the Latest
 *     Report / Latest Verification Package cards (which duplicated
 *     the version history rows below) are gone.
 *   - Review tab: status-stable layout. No NOT_STARTED replacement
 *     card, no non-clickable plain-text "checklist". Same sections
 *     in the same order across every reviewer status.
 *   - Reviewer status labels: legally-safe display strings come from
 *     ONE canonical map, never the raw enum (no "IN_REVIEW",
 *     "NOT_STARTED", … in the UI).
 *   - Reviewer status disclaimer: shown next to the status surface
 *     so the user understands the marker is an internal workflow
 *     signal, not a truth claim.
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

const REVIEW_TAB = "apps/web/app/(app)/evidence/[id]/_tabs/EvidenceReviewTab.tsx";
const ARTIFACTS_TAB =
  "apps/web/app/(app)/evidence/[id]/_tabs/EvidenceArtifactsTab.tsx";
const WORKFLOW_CARD =
  "apps/web/app/(app)/evidence/[id]/components/ReviewerWorkflowCard.tsx";
const EXTERNAL_INTAKE_CARD =
  "apps/web/app/(app)/evidence/[id]/components/ExternalIntakeSourceCard.tsx";
const STATUS_LIB = "apps/web/app/(app)/evidence/lib/reviewer-status.ts";

// ============================================================================
// (A) Canonical reviewer-status labels + disclaimer copy
// ============================================================================

test("reviewer-status: canonical label map exists and covers every backend status", () => {
  const src = read(STATUS_LIB);
  for (const [enumValue, label] of [
    ["NOT_STARTED", "Needs review"],
    ["IN_REVIEW", "In review"],
    ["NEEDS_INFO", "Needs additional context"],
    ["READY_FOR_EXTERNAL_REVIEW", "Ready for external review"],
    ["APPROVED_INTERNAL", "Accepted for internal review"],
    ["ESCALATED", "Escalated for further review"],
    ["CLOSED", "Not accepted"],
  ] as Array<[string, string]>) {
    assert.match(
      src,
      new RegExp(`${enumValue}:\\s*"${label}"`),
      `REVIEWER_STATUS_LABEL missing canonical entry for ${enumValue}`,
    );
  }
});

test("reviewer-status: disclaimer copy is the legally-safe internal-marker line", () => {
  const src = read(STATUS_LIB);
  assert.match(src, /export const REVIEWER_STATUS_DISCLAIMER\s*=/);
  // The disclaimer must explicitly carve out the five things this
  // marker does NOT determine.
  assert.match(
    src,
    /does not change integrity results, public verification, authenticity, legal admissibility, or factual truth\./,
  );
});

// ============================================================================
// (B) Consumers route through the canonical map (no duplicates)
// ============================================================================

test("ExternalIntakeSourceCard reuses the canonical reviewer-status helpers", () => {
  const src = read(EXTERNAL_INTAKE_CARD);
  assert.match(src, /from "\.\.\/\.\.\/lib\/reviewer-status"/);
  assert.match(src, /REVIEWER_STATUS_LABEL/);
  assert.match(src, /REVIEWER_STATUS_PRIMARY_ACTIONS/);
  assert.match(src, /\{REVIEWER_STATUS_DISCLAIMER\}/);
  // No inline copy of the labels — those used to drift between
  // surfaces (the card hard-coded its own map).
  assert.ok(
    !/NOT_STARTED:\s*"Needs review"/.test(src),
    "External Intake card must not duplicate the label map",
  );
});

test("ReviewerWorkflowCard renders the legally-safe label + disclaimer", () => {
  const src = read(WORKFLOW_CARD);
  assert.match(src, /formatReviewerStatusLabel\(workflow\.status\)/);
  assert.match(src, /REVIEWER_STATUS_DISCLAIMER/);
  assert.match(src, /data-evidence-reviewer-disclaimer="true"/);
  // The card must NOT render the raw enum (the old
  // `workflow.status.replace(/_/g, " ")` produced "NOT STARTED",
  // "IN REVIEW" etc. which leaked the enum to users).
  assert.ok(
    !/workflow\.status\.replace\(\/_\/g, " "\)/.test(src),
    "Reviewer Workflow card must not leak the raw enum to users",
  );
});

// ============================================================================
// (C) Review tab — status-stable layout
// ============================================================================

test("Review tab — NotStartedEmptyState replacement block is gone", () => {
  const src = read(REVIEW_TAB);
  assert.ok(
    !/NotStartedEmptyState/.test(src),
    "NotStartedEmptyState component must be retired",
  );
  assert.ok(
    !/data-evidence-review-empty="NOT_STARTED"/.test(src),
    "empty-state replacement data-attr must be retired",
  );
  assert.ok(
    !/Review has not started yet/.test(src),
    "empty-state heading must be retired",
  );
});

test("Review tab — fake non-clickable plain-text 'checklist' sentences are gone", () => {
  const src = read(REVIEW_TAB);
  for (const sentence of [
    "Add a comment or legal note",
    "Attach this record to a case",
    "Open the risk signals in the sidebar",
    "Download the report PDF or verification package",
  ]) {
    assert.ok(
      !src.includes(sentence),
      `plain-text pseudo-action "${sentence}" must not be rendered`,
    );
  }
});

test("Review tab — always-rendered Review actions row has only wired buttons", () => {
  const src = read(REVIEW_TAB);
  assert.match(src, /data-evidence-section="review-actions"/);
  assert.match(src, /data-evidence-review-actions/);
  // Wired actions present.
  assert.match(src, /Attach to case/);
  assert.match(src, /Open report/);
  // Assign reviewer remains gated on canSeeReviewerOps (reviewer-ops
  // workspaces only) but lives in the same always-rendered actions
  // row, not in a status-swapped block.
  assert.match(
    src,
    /canSeeReviewerOps\s*\?\s*\(\s*\n?\s*<Button[\s\S]{0,200}Assign reviewer/,
  );
});

test("Review tab — non-reviewer-ops users still see a stable Review status section with the canonical label", () => {
  const src = read(REVIEW_TAB);
  assert.match(src, /data-evidence-section="review-status"/);
  assert.match(src, /formatReviewerStatusLabel\(reviewerStatus\)/);
  assert.match(src, /REVIEWER_STATUS_DISCLAIMER/);
  // The old "Current status: IN_REVIEW" leak is gone.
  assert.ok(
    !/Current status: \$\{workspace\.reviewWorkflow\.status\}/.test(src),
    "raw-enum status string must not be interpolated into the UI",
  );
});

// ============================================================================
// (D) Artifacts tab — dedupe report + package latest-summary cards
// ============================================================================

test("Artifacts tab — top Latest section keeps ONLY the verify-link card", () => {
  const src = read(ARTIFACTS_TAB);
  assert.match(src, /data-evidence-section="latest-artifacts"/);
  assert.match(src, /data-latest-artifact="verify"/);
  assert.ok(
    !/data-latest-artifact="report"/.test(src),
    "duplicate Latest report card must be removed",
  );
  assert.ok(
    !/data-latest-artifact="package"/.test(src),
    "duplicate Latest verification package card must be removed",
  );
});

test("Artifacts tab — ArtifactHistorySection still mounts with both download wires", () => {
  const src = read(ARTIFACTS_TAB);
  assert.match(src, /<ArtifactHistorySection/);
  assert.match(src, /onDownloadReport=\{\(\) => void downloadReport\(\)\}/);
  assert.match(
    src,
    /onDownloadVerificationPackage=\{\(\) => void downloadVerificationPackage\(\)\}/,
  );
});
