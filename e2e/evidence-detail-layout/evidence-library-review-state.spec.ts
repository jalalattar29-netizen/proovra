/**
 * BROWSER VERIFICATION — the simplified Evidence Library row.
 *
 * The generic review-state bucket ("Operational notes" / "Reviewer action
 * recommended" / "Stable review state" / "Critical follow-up") was removed from
 * the row, and the Case relationship is now labelled TEXT ("Case: <name>") in
 * the canonical blue, omitted when there is no case. This drives two records —
 * one linked to a case, one not — through the REAL production bundle and reads
 * the computed styles, so the removal, the text-only Case treatment, its blue
 * ink, its compact size, and the clean layout are verified against what the
 * browser actually paints, at every supported width and in RTL.
 */

import { expect, test, type Locator, type Page } from "@playwright/test";

import { envelopeFor } from "./_fixtures";

/** Two Reported records: one linked to a case, one unlinked. */
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

const CASE_NAME = "Bilal";

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
    // The row's case name is resolved from the cases list (caseMap).
    if (path.endsWith("/v1/cases")) {
      return json({ cases: [{ id: "case-1", name: CASE_NAME }], items: [{ id: "case-1", name: CASE_NAME }] });
    }
    return json({});
  });
}

async function openLibrary(page: Page): Promise<void> {
  await installLibraryApi(page);
  await page.goto("/evidence");
  await page.waitForSelector("[data-evidence-row]", { timeout: 30_000 });
}

const WIDTHS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "1280", width: 1280, height: 900 },
  { name: "1024", width: 1024, height: 800 },
  { name: "768", width: 768, height: 1024 },
  { name: "390", width: 390, height: 844 },
  { name: "375", width: 375, height: 812 },
] as const;

const linkedRow = (page: Page) => page.locator('[data-evidence-row="ev-1"]');
const unlinkedRow = (page: Page) => page.locator('[data-evidence-row="ev-2"]');
const caseEl = (row: Locator) => row.locator("[data-evidence-row-case]");

async function computed(el: Locator) {
  return el.evaluate((n) => {
    const s = getComputedStyle(n as Element);
    return {
      background: s.backgroundColor,
      border: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth].join(" "),
      shadow: s.boxShadow,
      radius: [s.borderTopLeftRadius, s.borderBottomRightRadius].join(" "),
      color: s.color,
      fontSize: s.fontSize,
    };
  });
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const d = document.documentElement;
    return Math.max(0, d.scrollWidth - d.clientWidth);
  });
}

test("library: the generic review-state bucket is gone from every row", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLibrary(page);
  const body = (await page.locator("[data-evidence-list], main").first().innerText()).toLowerCase();
  for (const phrase of [
    "stable review state",
    "operational notes",
    "reviewer action recommended",
    "critical follow-up",
  ]) {
    expect(body, `row still shows "${phrase}"`).not.toContain(phrase);
  }
  // The old bucket hook is gone entirely.
  expect(await page.locator("[data-evidence-row-priority]").count()).toBe(0);
});

test("library: a linked record shows `Case: <name>` as text-only canonical blue", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLibrary(page);
  const el = caseEl(linkedRow(page));
  await expect(el, "no Case metadata rendered for the linked record").toHaveCount(1);
  await expect(el).toHaveText(/Case:\s*Bilal/);

  // The NAME carries the canonical blue (--info); the "Case:" label is neutral.
  const name = el.locator(".evidence-library-row__case-name");
  const label = el.locator(".evidence-library-row__case-label");
  expect((await computed(name)).color, "case name is not the canonical blue").toBe("rgb(37, 99, 235)");
  expect((await computed(label)).color, "the Case: label is not neutral").not.toBe("rgb(37, 99, 235)");

  // Text-only: no capsule anywhere on the case element or its name.
  for (const part of [el, name]) {
    const box = await computed(part);
    expect(box.background, "case paints a background").toBe("rgba(0, 0, 0, 0)");
    expect(box.border, "case paints a border").toBe("0px 0px 0px 0px");
    expect(box.shadow, "case paints a shadow").toBe("none");
    expect(box.radius, "case keeps a capsule radius").toBe("0px 0px");
  }
  await expect(el).not.toHaveClass(/app-chip/);

  // Compact metadata typography: the same 12px as the activity/timestamp
  // metadata line, and strictly smaller than the 14px filename heading — the
  // Case must read as secondary, never enlarged into a CTA.
  const caseSize = parseFloat((await computed(el)).fontSize);
  const metaSize = parseFloat(
    (await computed(linkedRow(page).locator(".evidence-library-row__activity-line"))).fontSize,
  );
  const titleSize = parseFloat(
    (await computed(linkedRow(page).locator(".evidence-library-row__title"))).fontSize,
  );
  expect(caseSize, "case is not the row metadata size").toBe(metaSize);
  expect(caseSize, "case grew to heading size").toBeLessThan(titleSize);
});

test("library: an unlinked record shows NO Case metadata (no placeholder/warning)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLibrary(page);
  await expect(unlinkedRow(page)).toHaveCount(1);
  await expect(caseEl(unlinkedRow(page)), "unlinked record rendered a Case slot").toHaveCount(0);
  const text = (await unlinkedRow(page).innerText()).toLowerCase();
  for (const phrase of ["case:", "unassigned", "no case"]) {
    expect(text, `unlinked row shows "${phrase}"`).not.toContain(phrase);
  }
});

test("library: the lifecycle status still renders on every row", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openLibrary(page);
  for (const row of [linkedRow(page), unlinkedRow(page)]) {
    const status = row.locator(".evidence-library-row__badges .app-status-text");
    await expect(status).toHaveText("Reported");
  }
});

for (const dir of ["ltr", "rtl"] as const) {
  for (const vp of WIDTHS) {
    test(`library: Case reads cleanly with no overflow — ${vp.name} ${dir}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openLibrary(page);
      await page.evaluate((d) => document.documentElement.setAttribute("dir", d), dir);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));

      await expect(caseEl(linkedRow(page))).toHaveText(/Case:\s*Bilal/);
      // Text-only holds at every width.
      expect((await computed(caseEl(linkedRow(page)))).background).toBe("rgba(0, 0, 0, 0)");
      expect(await horizontalOverflow(page), "the page scrolls sideways").toBeLessThanOrEqual(1);
      await page.screenshot({
        path: `test-results/evidence-library-case/${vp.name}-${dir}.png`,
      });
    });
  }
}
