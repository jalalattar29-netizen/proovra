/**
 * BROWSER VERIFICATION — the Evidence Library review-state labels + colours.
 *
 * The audit proved (by executing the shipped resolver) that in the library a
 * row is `Operational notes` when it has NO case assigned and `Stable review
 * state` when a case is assigned. This drives two records — identical except
 * for `caseId` — through the REAL production bundle and reads the computed ink,
 * so the colour contract (Stable -> blue, Operational -> orange) and the
 * text-only treatment are verified against what the browser actually paints.
 */

import { expect, test, type Page } from "@playwright/test";

import { envelopeFor } from "./_fixtures";

/** Two Reported records, alike but for the one field the audit found decisive. */
function evidenceRow(i: number, caseId: string | null) {
  return {
    id: `ev-${i}`,
    title: `incident-${i}.jpg`,
    displayTitle: `incident-${i}.jpg`,
    status: "REPORTED",
    statusLabel: "Reported",
    verificationStatus: null,
    createdAt: "2026-08-20T11:22:33.456Z",
    updatedAt: "2026-08-20T11:22:33.456Z",
    deletedAt: null,
    archivedAt: null,
    caseId,
    reportReady: true,
    mimeType: "image/jpeg",
    sizeBytes: 12345,
  };
}

async function installLibraryApi(page: Page): Promise<void> {
  const envelope = envelopeFor("organization");
  const items = [evidenceRow(1, "case-1"), evidenceRow(2, null)];

  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

    if (path.endsWith("/v1/platform/context")) return json(envelope);
    if (path.endsWith("/v1/auth/me") || path.endsWith("/v1/users/me")) {
      return json({ id: "user-1", email: "reviewer@example.invalid" });
    }
    if (path.endsWith("/v1/evidence")) {
      return json({ scope: "active", items, totalCount: items.length });
    }
    if (path.endsWith("/v1/evidence/library-summary")) {
      return json({ scope: "active", totalActive: items.length, totalTrash: 0 });
    }
    if (path.endsWith("/v1/evidence/saved-views")) return json({ views: [] });
    if (path.endsWith("/v1/cases")) return json({ cases: [], items: [] });
    // Everything else the shell touches: a well-formed empty answer.
    return json({});
  });
}

async function openLibrary(page: Page): Promise<void> {
  await installLibraryApi(page);
  await page.goto("/evidence");
  await page.waitForSelector("[data-evidence-row-priority]", { timeout: 30_000 });
}

async function reviewState(page: Page, level: "stable" | "informational") {
  return page.locator(`[data-evidence-row-priority="${level}"]`).first();
}

async function inkOf(el: import("@playwright/test").Locator): Promise<string> {
  return el.evaluate((n) => getComputedStyle(n as Element).color);
}

async function boxOf(el: import("@playwright/test").Locator) {
  return el.evaluate((n) => {
    const s = getComputedStyle(n as Element);
    return {
      background: s.backgroundColor,
      radius: [s.borderTopLeftRadius, s.borderBottomRightRadius].join(" "),
      padding: [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft].join(" "),
    };
  });
}

test("library: Stable review state renders blue, text-only", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLibrary(page);
  const el = await reviewState(page, "stable");
  await expect(el, "no Stable row rendered").toHaveCount(1);
  await expect(el).toHaveText("Stable review state");
  expect(await inkOf(el), "Stable is not the canonical blue --info").toBe("rgb(37, 99, 235)");
  const box = await boxOf(el);
  expect(box.background, "Stable painted a capsule").toBe("rgba(0, 0, 0, 0)");
  expect(box.radius).toBe("0px 0px");
  expect(box.padding).toBe("0px 0px 0px 0px");
});

test("library: Operational notes renders orange, text-only, and is explainable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLibrary(page);
  const el = await reviewState(page, "informational");
  await expect(el, "no Operational row rendered").toHaveCount(1);
  await expect(el).toHaveText("Operational notes");
  expect(await inkOf(el), "Operational is not the canonical orange --orange-ink").toBe(
    "rgb(194, 65, 12)",
  );
  const box = await boxOf(el);
  expect(box.background, "Operational painted a capsule").toBe("rgba(0, 0, 0, 0)");
  // Explainable at the point of display: the concrete note is on the label's
  // tooltip, so the reader learns WHY without opening the record.
  const title = await el.getAttribute("title");
  expect(title, "the label carries no explanation").toContain("No case assigned");
});

test("library: the two labels differ ONLY because of case assignment", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLibrary(page);
  // Both rows are Reported; the sole difference is caseId, and that is exactly
  // what flips the review state. This is the user's scenario, reproduced live.
  const stable = await reviewState(page, "stable");
  const operational = await reviewState(page, "informational");
  await expect(stable).toHaveCount(1);
  await expect(operational).toHaveCount(1);
  expect(await inkOf(stable)).not.toBe(await inkOf(operational));
});
