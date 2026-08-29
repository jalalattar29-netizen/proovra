/**
 * CAPTURE — resuming a draft actually resumes it.
 *
 * THE BUG THIS PINS
 * ---------------------------------------------------------------------------
 * `GET /v1/capture/sessions/:id` returns five restorable things: `templateId`,
 * `planMode`, `internalNotes`, `useLocation`, and the `itemsSnapshot` holding
 * every staged material's file name, type, size, role, source label and the
 * requirement it was mapped to. `fetchDetail` mapped all five into
 * `CaptureDraftDetail`. The effect that applied the draft read THREE of them
 * and never touched the other two.
 *
 * So `useLocation` was dropped, and the entire item snapshot was dropped. And
 * because `sessionItems` stayed empty, the "you have unfinished sessions"
 * banner stayed on screen. In the common case — a draft on the default
 * template in the default mode with no notes — the three fields that WERE
 * applied already held the values being written, so pressing Resume changed
 * nothing at all while a toast announced that the draft had been restored.
 *
 * These tests drive the real UI against the real read-route shape, so each
 * assertion below fails on the old code for the reason it names.
 */

import { expect, test } from "@playwright/test";

import { openCapture } from "./_fixtures";

async function resumeTheDraft(page: import("@playwright/test").Page) {
  await page.locator(".capture-drafts-trigger").click();
  const resume = page
    .locator(".capture-drafts-modal-item")
    .first()
    .locator("button", { hasText: "Resume" });
  await expect(resume).toBeVisible();
  await resume.click();
}

test.describe("capture — draft resume", () => {
  test("the draft surface appears, and Resume restores the draft's own state", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openCapture(page, { drafts: true });

    // 1–3. A draft exists and the resume surface offers it.
    const banner = page.locator(".capture-resume-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("unfinished capture session");

    // The state BEFORE resuming, so the assertions after it are about change
    // and not about defaults that happened to match.
    const location = page.locator(".capture-setup-location input");
    await expect(location).not.toBeChecked();
    await expect(
      page.locator(".capture-setup-mode", { hasText: "Guided" }),
    ).not.toHaveClass(/active/);

    // 4. Resume.
    await resumeTheDraft(page);

    // 5–6. The draft's own values are on screen. Every one of these is a field
    // the read route returned; `useLocation` and the item snapshot are the two
    // that used to be discarded.
    await expect(page.locator(".capture-drafts-modal")).toHaveCount(0);

    // planMode — CHECKLIST_REQUIRED, not the FLEXIBLE default.
    await expect(
      page.locator(".capture-setup-mode", { hasText: "Guided" }),
    ).toHaveClass(/active/);

    // useLocation — persisted, returned, and previously thrown away.
    await expect(location).toBeChecked();

    // internalNotes — restored into the private note field.
    await expect(page.locator(".capture-notes-card textarea")).toHaveValue(
      "Insurer reference 88213.",
    );

    // 7. NOT A SILENT NO-OP. The item snapshot the draft holds is surfaced,
    // with each file named and its mapping shown, rather than dropped.
    const notice = page.locator("[data-capture-reattach]");
    await expect(notice).toHaveAttribute("data-capture-reattach-count", "2");
    await expect(notice).toContainText("front-door-damage.jpg");
    await expect(notice).toContainText("loss-context.pdf");
    await expect(notice).toContainText("2 materials to re-attach");
  });

  test("the notice tells the truth about what could NOT be restored", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openCapture(page, { drafts: true });
    await resumeTheDraft(page);

    const notice = page.locator("[data-capture-reattach]");
    // The mapping each file had, so re-attaching is a known job rather than a
    // guess. The first item was mapped to a required step; the second was not.
    await expect(notice).toContainText("Not mapped to a requirement");

    // It does NOT claim the files themselves came back, and it does not claim
    // anything is verified.
    await expect(notice).not.toContainText(/verified|restored files|uploaded/i);

    // And a listed file is NOT a staged material: readiness still refuses,
    // because nothing has actually been attached.
    await expect(page.locator("[data-capture-final-readiness]")).toHaveAttribute(
      "data-capture-final-readiness",
      "not_ready",
    );
  });

  test("resume announces success only after the draft has been applied", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openCapture(page, { drafts: true });
    await resumeTheDraft(page);

    // The toast fired from the click handler before, ahead of any state being
    // applied. It now names the work that remains, and it appears alongside
    // the applied state rather than instead of it.
    const toast = page.getByText(/Draft restored/i).first();
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("Re-attach 2 files");
    await expect(page.locator(".capture-setup-location input")).toBeChecked();
  });

  test("the draft controls carry destructive and neutral semantics correctly", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1200 });
    await openCapture(page, { drafts: true });
    await page.locator(".capture-drafts-trigger").click();

    const item = page.locator(".capture-drafts-modal-item").first();
    const resume = item.locator("button", { hasText: "Resume" });
    const del = item.locator(".capture-draft-delete-button");

    const rgb = (s: string) =>
      (s.match(/\d+/g) ?? []).slice(0, 3).map(Number) as [number, number, number];

    // Resume is dark ink with a white label — a navigation action, not a
    // success state, so not green.
    const resumeBg = rgb(
      await resume.evaluate((el) => getComputedStyle(el).backgroundColor),
    );
    expect(Math.max(...resumeBg), "Resume must be dark ink").toBeLessThan(80);

    // Delete is white-with-red, and STAYS red on hover. It used to turn
    // violet, because `.capture-bulk-button:hover:not(:disabled)` scores
    // (0,3,0) and beat `.capture-draft-delete-button:hover` at (0,2,0) — the
    // generic hover won on specificity regardless of source order.
    const delColour = () =>
      del.evaluate((el) => {
        const cs = getComputedStyle(el);
        return `${cs.color}|${cs.backgroundColor}`;
      });

    const before = rgb((await delColour()).split("|")[0]);
    expect(before[0], "Delete label must be red").toBeGreaterThan(before[2]);

    await del.hover();
    const after = (await delColour()).split("|");
    const hoverInk = rgb(after[0]);
    const hoverBg = rgb(after[1]);
    expect(hoverInk[0], "Delete must stay red on hover").toBeGreaterThan(
      hoverInk[2],
    );
    // Violet has more blue than red; a red wash has more red than blue.
    expect(
      hoverBg[0],
      "Delete hover must not become violet",
    ).toBeGreaterThanOrEqual(hoverBg[2]);
  });
});
