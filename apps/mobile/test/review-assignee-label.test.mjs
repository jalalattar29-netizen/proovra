/**
 * Team remediation T-084 / T-086 — the mobile review panel named the assignee
 * by a user-id fragment ("assigned to 3f2a9c1d…"). It now names them the way
 * the web Review surfaces do: display name, else the masked e-mail, else a
 * neutral noun; never an id.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadModule } from "./support/render.mjs";

let M;
before(async () => {
  M = await loadModule("src/product/review-actions.ts", []);
});

test("the projection names the assignee by display name", () => {
  const ref = M.projectReviewWorkflowRef({
    reviewWorkflow: { teamId: "t", status: "IN_REVIEW", assignedTo: { id: "3f2a9c1d-0000", displayName: " Dana ", email: "dana@example.com" } },
  });
  assert.equal(ref.assignedToUserId, "3f2a9c1d-0000");
  assert.equal(ref.assigneeLabel, "Dana");
});

test("without a display name the e-mail is masked, never shown in full", () => {
  const ref = M.projectReviewWorkflowRef({
    reviewWorkflow: { teamId: "t", status: "IN_REVIEW", assignedTo: { id: "3f2a9c1d-0000", displayName: null, email: "dana@example.com" } },
  });
  assert.equal(ref.assigneeLabel, "d***@example.com");
});

test("with nothing to name, a neutral noun; unassigned has no label", () => {
  assert.equal(M.reviewAssigneeLabel(null, null), "a workspace member");
  const ref = M.projectReviewWorkflowRef({ reviewWorkflow: { teamId: "t", status: "PENDING" } });
  assert.equal(ref.assignedToUserId, null);
  assert.equal(ref.assigneeLabel, null);
});

test("the panel never prints a user-id fragment", () => {
  const src = readFileSync(new URL("../src/ui/review-actions-panel.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /assignedToUserId\.slice\(/);
  assert.match(src, /workflow\.assigneeLabel/);
});
