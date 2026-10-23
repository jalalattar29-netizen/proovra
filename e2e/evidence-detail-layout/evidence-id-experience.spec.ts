/**
 * EVIDENCE ID — the reported record, its attention, its rail and its review
 * flow, in the production bundle (2026-10-23).
 *
 * The record is the one in the reported screenshot: no flagged integrity
 * issue, an imported upload, an old file timestamp, no case, review not
 * started. The fixture carries the server's `attention` and `availableActions`
 * computed by the SAME shared authorities the API runs.
 *
 *   1. desktop and phone: "What needs attention" holds ONE recommended item;
 *      the benign facts are not in it; the rail's Risk Signals is one
 *      compact advisory row; Case reads "None · Optional"; nothing reads
 *      "Not available"; nothing scrolls sideways;
 *   2. Start review CLAIMS the review: one POST, the record is re-read, the
 *      strip becomes "No action required" and the Review tab names "You";
 *   3. Escalate asks for a reason in the page, then shows Escalated;
 *   4. the Integrity tab's legal-hold row reads the lifecycle projection.
 */

import { expect, test, type Page } from "@playwright/test";

import { EVIDENCE_ID, envelopeFor, installApi, makeWorkspace } from "./_fixtures";

type Json = Record<string, any>;

/**
 * A stateful review-workspace read layered over the fixture: after a claim
 * or a decision the NEXT read reflects it, exactly as the API's would.
 */
async function statefulReview(page: Page) {
  const state = { claimed: false, stage: "NOT_STARTED" as string, posts: [] as string[] };
  await installApi(page, "organization");
  // A workspace whose plan includes reviewer operations, so the Review tab
  // mounts its review actions.
  await page.route("**/v1/platform/context", async (route) => {
    const env = envelopeFor("organization") as Json;
    env.planFeatures = { ...env.planFeatures, reviewerOperationsIncluded: true };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(env) });
  });
  await page.route("**/v1/evidence/*/review-workspace", async (route) => {
    const w = makeWorkspace() as Json;
    if (state.claimed) {
      const actions = (w.reviewWorkflow.availableActions as Json[]).map((a) => {
        if (a.action === "CLAIM") return { ...a, enabled: false, blockedBy: "ALREADY_YOURS" };
        if (a.action === "ESCALATE") return { ...a, enabled: state.stage !== "ESCALATED", blockedBy: state.stage === "ESCALATED" ? "NOT_FROM_STAGE" : null };
        return a;
      });
      w.reviewWorkflow = {
        ...w.reviewWorkflow,
        status: state.stage,
        assignedTo: { id: "user-1", displayName: "Reviewer", email: "reviewer@example.invalid" },
        availableActions: actions,
      };
      w.attention = {
        ...w.attention,
        items: (w.attention.items as Json[]).filter((i) => i.code !== "REVIEW_NOT_STARTED"),
        headline: "NO_ACTION",
      };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(w) });
  });
  await page.route("**/v1/review-operations/evidence/*/**", async (route) => {
    const req = route.request();
    state.posts.push(`${req.method()} ${new URL(req.url()).pathname}`);
    if (req.url().endsWith("/claim")) {
      state.claimed = true;
      state.stage = "ASSIGNED";
    } else {
      const body = JSON.parse(req.postData() ?? "{}") as Json;
      if (body.decision === "ESCALATE") state.stage = "ESCALATED";
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ workflow: {} }) });
  });
  return state;
}

for (const vp of [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "1366", width: 1366, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`${vp.name}: the reported record asks for ONE thing and the rail is compact`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await statefulReview(page);
    await page.goto(`/evidence/${EVIDENCE_ID}`);
    const strip = page.locator("[data-evidence-attention-strip]");
    await expect(strip).toHaveAttribute("data-evidence-attention-strip", "ACTION_RECOMMENDED");
    await expect(strip.locator("[data-evidence-attention-code]")).toHaveCount(1);
    await expect(strip).toContainText("Review not started");
    for (const benign of ["Review ready", "No flagged issues", "Imported upload", "File timestamp note", "No case assigned"]) {
      await expect(strip).not.toContainText(benign);
    }
    const risk = page.locator('[data-evidence-side="risk-signals"]');
    await expect(risk.locator("[data-evidence-risk-code]")).toHaveCount(1);
    await expect(risk).toContainText("File timestamp note");
    await expect(risk.locator(".evidence-detail-signal-card")).toHaveCount(0);
    await expect(page.locator("[data-evidence-rail-case]")).toHaveText("None · Optional");
    await expect(page.locator('[data-evidence-sidebar="status-and-next-action"]')).not.toContainText("Not available");
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(sideways, "no horizontal page scroll").toBeLessThanOrEqual(0);
    await page.screenshot({ path: `test-results/evidence-id-${vp.name}-overview.png`, fullPage: false });
  });
}

test("Start review claims the review: one POST, the record re-read, the strip calms, the panel names You", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = await statefulReview(page);
  await page.goto(`/evidence/${EVIDENCE_ID}`);
  const start = page.locator('[data-evidence-attention-action="START_REVIEW"]');
  await start.click();
  await expect(page.locator('[data-evidence-attention-strip="no-action"]')).toHaveText("No action required");
  expect(state.posts.filter((p) => p.endsWith("/claim"))).toHaveLength(1);
  // Refresh keeps the server truth.
  await page.reload();
  await expect(page.locator('[data-evidence-attention-strip="no-action"]')).toBeVisible();
  await page.goto(`/evidence/${EVIDENCE_ID}?tab=review`);
  await expect(page.locator("[data-evidence-review-assignee]")).toHaveText("Reviewer: You");
  await expect(page.locator('[data-evidence-review-action="CLAIM"]')).toHaveCount(0);
  await page.screenshot({ path: "test-results/evidence-id-desktop-review-claimed.png", fullPage: false });
});

test("Escalate asks for a reason in the page, then shows Escalated and stops offering Escalate", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = await statefulReview(page);
  state.claimed = true;
  state.stage = "IN_REVIEW";
  await page.goto(`/evidence/${EVIDENCE_ID}?tab=review`);
  await page.locator('[data-evidence-review-action="ESCALATE"]').click();
  const form = page.locator('[data-evidence-review-reason="ESCALATE"]');
  await expect(form).toContainText("appears under Escalated in the team review queue");
  await form.locator("textarea").fill("Needs counsel review");
  await form.locator("[data-evidence-review-reason-submit]").click();
  await expect(page.locator("[data-evidence-review-stage]")).toHaveText("Escalated");
  await expect(page.locator('[data-evidence-review-outcome="success"]')).toContainText("Review escalated");
  await expect(page.locator('[data-evidence-review-action="ESCALATE"]')).toHaveCount(0);
  expect(state.posts.filter((p) => p.endsWith("/decision"))).toHaveLength(1);
  await page.screenshot({ path: "test-results/evidence-id-desktop-review-escalated.png", fullPage: false });
});

test("phone: the review panel is usable and nothing scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await statefulReview(page);
  await page.goto(`/evidence/${EVIDENCE_ID}?tab=review`);
  await expect(page.locator("[data-evidence-review-decisions]")).toBeVisible();
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(sideways).toBeLessThanOrEqual(0);
  await page.locator("[data-evidence-review-decisions]").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/evidence-id-phone-review.png", fullPage: false });
});

test("Integrity: legal hold and retention come from the lifecycle projection, never 'metadata recorded'", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await installApi(page, "organization", {
    lifecycle: {
      productState: "ACTIVE",
      canArchive: true,
      canUnarchive: false,
      canTrash: false,
      canRestoreFromTrash: false,
      canRestoreFromArchive: false,
      trashBlockReason: "LEGAL_HOLD",
      archiveBlockReason: null,
      trashGraceUntilUtc: null,
      appRetentionUntilUtc: null,
      objectLockRetainUntilUtc: "2034-07-04T03:47:43.000Z",
      effectiveRetentionUntilUtc: "2034-07-04T03:47:43.000Z",
      objectLockCompliance: true,
      legalHold: true,
      legalHoldState: "ACTIVE",
      destructionEligibleAtUtc: null,
      destructionBlockReason: "LEGAL_HOLD",
    },
  });
  await page.goto(`/evidence/${EVIDENCE_ID}?tab=integrity`);
  const body = page.locator("body");
  await expect(body).toContainText("Active legal hold");
  await expect(body).toContainText("Retained until");
  await expect(body).not.toContainText("No legal hold metadata recorded");
  await expect(body).not.toContainText("No record-level retention deadline recorded");
});
