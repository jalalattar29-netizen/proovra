/**
 * Stage D (team remediation) — Review surfaces: plain status text, one
 * priority map, launcher clearance.
 *
 *   T-071  no informational capsule on a Review surface: no <Badge>, no
 *          <StatusBadge>, no `.app-chip` — the canonical `AppStatusText`
 *          (`.app-status-text`: no background, border, shadow or radius) is
 *          used instead. The shared Badge / StatusBadge / .app-chip are NOT
 *          restyled (Enterprise Matter, Inbox and Search keep them).
 *   T-070  ONE priority map: Low / Normal neutral, High amber, Urgent red; no
 *          other priority tone map on a Review surface.
 *   T-089  every Review page reserves the assistant launcher's clearance.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { priorityLabel, priorityTone } from "../lib/reviewer-workspace/review-status";
import { INBOX_TITLE, INBOX_VIEW_LABELS } from "../lib/reviewer-workspace/inbox-views";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(resolve(web, rel), "utf8");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

const REVIEW_SURFACES = [
  "components/reviewer-experience/ReviewInbox.tsx",
  "components/reviewer-experience/queueIntelligence.tsx",
  "components/reviewer-experience/ReviewHubNav.tsx",
  "components/reviewer-experience/ReviewEvidencePreview.tsx",
  "components/reviewer-experience/ReviewCodingSection.tsx",
  "components/reviewer-experience/ChallengeDecision.tsx",
  "components/reviewer-experience/ReviewerSlaPolicyPanel.tsx",
  "components/ai-copilot/ReviewerCopilotPanel.tsx",
  "components/ai-copilot/QcSamplingPanel.tsx",
  "app/(app)/reviewer-ops/[reviewId]/page.tsx",
  "app/(app)/reviewer-ops/[reviewId]/_components/DecisionLineagePanel.tsx",
  "app/(app)/reviewer-ops/[reviewId]/_components/DecisionPanel.tsx",
  "app/(app)/reviewer-ops/[reviewId]/_components/InspectorActions.tsx",
  "app/(app)/reviewer-ops/sla/page.tsx",
  "app/(app)/reviewer-ops/sla/_sections.tsx",
  "app/(app)/reviewer-ops/escalations/_section.tsx",
  "app/(app)/review/qc/_section.tsx",
  "app/(app)/review/metrics/_section.tsx",
  "app/(app)/review/schemas/_section.tsx",
  "app/(app)/review/settings/page.tsx",
  "app/(app)/review/disagreements/page.tsx",
  "app/(app)/evidence-requests/_components/EvidenceRequestReviewQueue.tsx",
];

test("T-071 — no informational capsule on a Review surface; plain status text instead", () => {
  const offenders: string[] = [];
  for (const rel of REVIEW_SURFACES) {
    const src = stripComments(read(rel));
    if (/<Badge\b/.test(src)) offenders.push(`${rel}: <Badge>`);
    if (/<StatusBadge\b/.test(src)) offenders.push(`${rel}: <StatusBadge>`);
    if (/["'`\s]app-chip(--[a-z]+)?["'`\s]/.test(src)) offenders.push(`${rel}: .app-chip`);
  }
  assert.deepEqual(offenders, []);
  // The canonical plain style keeps its no-capsule contract.
  const css = read("components/app-primitives/app-primitives.css");
  const block = css.slice(css.indexOf(".app-status-text {"), css.indexOf("}", css.indexOf(".app-status-text {")));
  for (const rule of ["background: none", "border: 0", "box-shadow: none", "border-radius: 0"]) {
    assert.ok(block.includes(rule), `.app-status-text keeps ${rule}`);
  }
  // The shared components are untouched (direction 9): Badge stays a capsule.
  assert.match(read("components/ui/Badge.tsx"), /borderRadius/);
});

test("T-070 — one priority map: Low / Normal neutral, High amber, Urgent red", () => {
  assert.equal(priorityTone("NORMAL"), "slate");
  assert.equal(priorityTone("LOW"), "slate");
  assert.equal(priorityTone("HIGH"), "amber");
  assert.equal(priorityTone("URGENT"), "red");
  assert.equal(priorityTone(undefined), "slate");
  assert.equal(priorityLabel("URGENT"), "Urgent priority");
  // There is no other priority tone map on a Review surface (the queues
  // page's NORMAL -> "pending" yellow, the console's and the request panel's
  // copies are gone).
  for (const rel of REVIEW_SURFACES) {
    const src = stripComments(read(rel));
    assert.doesNotMatch(src, /function (queue)?[pP]riorityTone\(/, rel);
    assert.doesNotMatch(src, /PRIORITY_TONE\s*[:=]/, rel);
    assert.doesNotMatch(src, /case "MEDIUM":/, `${rel}: no non-existent MEDIUM priority`);
  }
});

test("T-089 — every Review page reserves the assistant launcher's clearance", () => {
  for (const rel of [
    "components/reviewer-experience/ReviewInbox.tsx",
    "app/(app)/reviewer-ops/[reviewId]/page.tsx",
    "app/(app)/reviewer-ops/sla/page.tsx",
    "app/(app)/review/settings/page.tsx",
  ]) {
    assert.match(read(rel), /review-launcher-clearance/, rel);
  }
  const css = read("components/reviewer-experience/review-surfaces.css");
  const rule = css.slice(css.indexOf(".review-launcher-clearance {"));
  const px = Number(/var\(--review-launcher-clearance,\s*(\d+)px\)/.exec(rule)?.[1] ?? 0);
  // The launcher sits 1.5rem (24 px) above the bottom edge (assistant.css).
  assert.ok(px >= 72, `clearance ${px}px clears the launcher`);
});

test("T-092 — one label per Inbox view: 'Assigned to me' is the only name for MY_REVIEWS", () => {
  assert.equal(INBOX_VIEW_LABELS.MY_REVIEWS, "Assigned to me");
  assert.equal(INBOX_TITLE, "Inbox");
  for (const rel of REVIEW_SURFACES) {
    const src = stripComments(read(rel));
    for (const stale of ['"My reviews"', ">My reviews<", "Assigned (mine)", "Open my queue"]) {
      assert.ok(!src.includes(stale), `${rel} still says ${stale}`);
    }
  }
});
