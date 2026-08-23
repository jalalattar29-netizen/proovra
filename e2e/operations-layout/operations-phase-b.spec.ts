/**
 * PHASE B — the actionability surfaces, in a real browser against the
 * PRODUCTION bundle.
 *
 * The server-side proofs for these live against live PostgreSQL. What can
 * only be established HERE is that the projections actually become controls:
 * that an action the server withheld leaves no button behind, that "Accepted
 * and queued" is what the operator reads rather than "Done", and that a
 * shared view a reader does not own offers them no way to delete it.
 *
 * Every one of these is a rendering decision, and a rendering decision that
 * disagrees with its projection is invisible to every server test.
 */

import { expect, test } from "@playwright/test";

import { openOperations, type OpsContext } from "./_fixtures";

// ===========================================================================
// REMEDIATION
// ===========================================================================

test.describe("remediation", () => {
  test("an operator is offered the projected action, with what it starts", async ({
    page,
  }) => {
    await openOperations(page, "owned-workspace");
    await page.locator("[data-ops-open]").first().click();

    const panel = page.locator("[data-ops-remediation]");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute(
      "data-ops-remediation",
      "DIRECT_REMEDIATION",
    );

    const action = page.locator('[data-ops-remediate="ots.resume_anchoring"]');
    await expect(action).toBeVisible();
    // The sentence beside the control says what pressing it starts. A button
    // whose only description is its own label leaves the operator to guess
    // whether it is safe.
    await expect(panel).toContainText("Queues the anchoring step again");
    // Asynchronous work says so BEFORE it is started, not only after.
    await expect(panel).toContainText("runs in the background");
  });

  test("a reader is offered NOTHING — withheld, not disabled", async ({
    page,
  }) => {
    await openOperations(page, "viewer");
    await page.locator("[data-ops-open]").first().click();
    await expect(page.locator("[data-ops-inspector]")).toBeVisible();

    // A disabled control still teaches the reader that the action exists and
    // that they are the problem. A withheld one says nothing at all.
    await expect(page.locator("[data-ops-remediate]")).toHaveCount(0);
  });

  test("the workbench never offers a TSA retry, in any context", async ({
    page,
  }) => {
    // The §1 boundary, checked where an operator would actually see it: a
    // later timestamp asserts something untrue about when the evidence
    // existed, so no control may imply one can be taken.
    for (const context of [
      "owned-workspace",
      "team-admin",
      "viewer",
    ] as OpsContext[]) {
      await openOperations(page, context);
      const body = await page.locator("body").innerText();
      for (const forbidden of [
        "Retry TSA",
        "Repair TSA",
        "Refresh timestamp",
        "Reprocess TSA",
        "Restamp",
      ]) {
        expect(
          body,
          `${context} must never be offered ${forbidden}`,
        ).not.toContain(forbidden);
      }
    }
  });
});

// ===========================================================================
// SLA POSTURE
// ===========================================================================

test.describe("sla posture", () => {
  test("lateness is a WORD, not only a colour", async ({ page }) => {
    await openOperations(page, "owned-workspace");
    // An operator who cannot distinguish the two reds still has to triage.
    const badge = page.locator("[data-ops-sla-badge]").first();
    await expect(badge).toBeVisible();
    const text = (await badge.innerText()).trim();
    expect(["Overdue", "Due soon"]).toContain(text);
  });

  test("ONE time signal per row — the heuristic yields to the policy", async ({
    page,
  }) => {
    await openOperations(page, "owned-workspace");
    // With a policy present, the age-heuristic badge must not also render:
    // two "Overdue" badges from different thresholds would eventually
    // disagree on the same row and the reader could not tell which to trust.
    await expect(page.locator("[data-ops-overdue-badge]")).toHaveCount(0);
  });

  test("the drawer states the promise, not only the verdict", async ({
    page,
  }) => {
    await openOperations(page, "owned-workspace");
    await page.locator("[data-ops-open]").first().click();
    const fact = page.locator("[data-ops-sla-fact]");
    await expect(fact).toBeVisible();
    // "Overdue" alone leaves the reader guessing whether the workspace
    // promised four hours or four days.
    await expect(page.locator("[data-ops-inspector]")).toContainText(
      "This workspace allows",
    );
  });
});

// ===========================================================================
// SAVED VIEWS
// ===========================================================================

test.describe("saved views", () => {
  test("lists the reader's own and the workspace's, and marks which is shared", async ({
    page,
  }) => {
    await openOperations(page, "owned-workspace");
    const strip = page.locator("[data-ops-saved-views]");
    await expect(strip).toBeVisible();

    await expect(page.locator('[data-ops-saved-view="view-mine"]')).toBeVisible();
    const shared = page.locator('[data-ops-saved-view="view-shared"]');
    await expect(shared).toBeVisible();
    // Said in a word: whether a colleague can see this is worth being sure
    // about before naming a view after the person you are chasing.
    await expect(shared).toContainText("Shared");
  });

  test("only the author is offered a way to delete", async ({ page }) => {
    await openOperations(page, "owned-workspace");
    // Sharing results must not also hand over the ability to remove them.
    await expect(
      page.locator('[data-testid="ops-view-menu-view-mine"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="ops-view-menu-view-shared"]'),
    ).toHaveCount(0);
  });

  test("applying a view rewrites the URL, so the queue stays shareable", async ({
    page,
  }) => {
    await openOperations(page, "owned-workspace");
    await page.locator('[data-ops-saved-view="view-mine"]').click();
    // The URL remains the ONE description of what the queue is showing; a
    // view that set state directly would leave the address bar describing
    // something else and a copied link would open a different queue.
    await expect(page).toHaveURL(/severity=CRITICAL/);
    await expect(page).toHaveURL(/owner=unassigned/);
  });

  test("there is nothing to name until something is filtered", async ({
    page,
  }) => {
    await openOperations(page, "owned-workspace");
    // "Save this view" over the default queue would save the default queue.
    await expect(page.locator("[data-ops-view-start-save]")).toHaveCount(0);

    await page.locator('[data-ops-saved-view="view-mine"]').click();
    await expect(page.locator("[data-ops-view-start-save]")).toBeVisible();
  });

  test("a saved view shows no count beside its name", async ({ page }) => {
    await openOperations(page, "owned-workspace");
    const name = await page
      .locator('[data-ops-saved-view="view-mine"]')
      .innerText();
    // A count would be true when written and stale immediately afterwards,
    // which is the false-clear this whole surface is built to avoid.
    expect(name).not.toMatch(/\d/);
  });

  test("a refused context requests no saved views either", async ({ page }) => {
    // The strip loads on the SAME gate as the queue, so a refused workspace
    // makes zero /v1/ops/* calls of ANY kind — the closure property Phase A
    // established must not be reopened by a new surface.
    const calls: string[] = [];
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (u.pathname.includes("/v1/ops/")) calls.push(u.pathname);
    });
    await openOperations(page, "personal-free");
    await page.waitForTimeout(1200);
    expect(calls, `unexpected operational reads: ${calls.join(", ")}`).toEqual(
      [],
    );
  });
});

// ===========================================================================
// BULK ASSIGNMENT
// ===========================================================================

test.describe("bulk assignment", () => {
  test("appears with a selection, and only where ownership is real", async ({
    page,
  }) => {
    await openOperations(page, "owned-workspace");
    await page.locator("[data-ops-row-mark]").first().click();
    await expect(page.locator("[data-ops-bulk-toolbar]")).toBeVisible();
    await expect(page.locator("[data-ops-bulk-assign]")).toBeVisible();
  });

  test("a solo workspace gets no assignment control", async ({ page }) => {
    await openOperations(page, "personal-pro");
    const mark = page.locator("[data-ops-row-mark]").first();
    if ((await mark.count()) === 0) return;
    await mark.click();
    // Nobody to assign to. A picker over an empty set is a control that
    // cannot succeed.
    await expect(page.locator("[data-ops-bulk-assign]")).toHaveCount(0);
  });

  test("a reader is offered no bulk verbs at all", async ({ page }) => {
    await openOperations(page, "viewer");
    const mark = page.locator("[data-ops-row-mark]").first();
    if ((await mark.count()) === 0) return;
    await mark.click();
    await expect(page.locator("[data-ops-bulk-assign]")).toHaveCount(0);
    await expect(page.locator('[data-ops-bulk-action="acknowledge"]')).toHaveCount(
      0,
    );
  });
});
