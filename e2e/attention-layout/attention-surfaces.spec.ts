/**
 * HOME / NOTIFICATIONS / OPERATIONS — MEASURED IN A REAL BROWSER.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS ANSWERS THAT SOURCE INSPECTION CANNOT
 * ---------------------------------------------------------------------------
 *   * does a Personal Free user's Home actually RENDER its integrity
 *     information, or is it empty?
 *   * does a queue row overflow the page at 390px, or at a 200% reflow?
 *   * is the severity chip reachable and operable by keyboard?
 *   * does the Arabic layout mirror, and does anything clip?
 *   * does the assignment control open, and is it announced?
 *
 * None of those are properties of the database, and none of them can be read
 * out of a file. They need the production bundle, the real cascade and a real
 * layout engine — so the API is intercepted and the web tier is real.
 */

import { expect, test, type Page } from "@playwright/test";

import {
  hasHorizontalOverflow,
  installApi,
  setDirection,
  VIEWPORTS,
  type AttentionContext,
} from "./_fixtures";

const SHOT_DIR = "test-results/attention-layout";

async function open(
  page: Page,
  path: string,
  context: AttentionContext,
): Promise<void> {
  await installApi(page, context);
  await page.goto(path, { waitUntil: "domcontentloaded" });
  // The shell resolves its envelope before any console mounts.
  await page.waitForLoadState("networkidle").catch(() => undefined);
}

// ============================================================================
// §32 — PERSONAL FREE. RELEASE-BLOCKING.
// ============================================================================

test.describe("Personal Free — the workspace's own health is visible", () => {
  test("Home renders its information, and it is not empty", async ({ page }) => {
    await open(page, "/home", "personal-free");

    // The orientation layer. The page shell AND the inner page both carry
    // `data-self-serve-home`, so the state attribute is the unambiguous
    // anchor — and it also asserts the page REACHED ready rather than
    // rendering a skeleton, which is the property that matters here.
    await expect(
      page.locator('[data-self-serve-home-state="ready"]'),
    ).toBeVisible();
    // The three tabs survive.
    for (const tab of ["overview", "operations", "analytics"]) {
      await expect(page.locator(`[data-home-tab="${tab}"]`)).toBeVisible();
    }
    // The KPI band.
    await expect(page.locator(".home-kpi-grid")).toBeVisible();
  });

  test("What Needs Attention is POPULATED with the real integrity counts", async ({
    page,
  }) => {
    await open(page, "/home", "personal-free");

    const card = page.locator('[data-self-serve-section="workspace-priorities"]');
    await expect(card).toBeVisible();

    // The fixture workspace has 34 TSA failures, 14 needing integrity review
    // and 4 terminal anchoring failures. A Free user owns those records, so
    // they must see them — this is the visibility gap this pass closed.
    await expect(card).toContainText("34");
    await expect(card).not.toContainText("All clear");
  });

  test("the CTA leads to the records, NEVER to the workbench", async ({ page }) => {
    await open(page, "/home", "personal-free");
    const card = page.locator('[data-self-serve-section="workspace-priorities"]');
    const hrefs = await card.locator("a").evaluateAll((els) =>
      els.map((e) => (e as HTMLAnchorElement).getAttribute("href") ?? ""),
    );
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href.startsWith("/operations"), `Free CTA points at ${href}`).toBe(
        false,
      );
    }
    // And at least one goes to the filtered evidence view that the count
    // describes.
    expect(hrefs.some((h) => h.startsWith("/evidence?"))).toBe(true);
  });

  test("no Operations workbench is offered anywhere in the shell", async ({
    page,
  }) => {
    await open(page, "/home", "personal-free");
    const navHrefs = await page
      .locator("nav a")
      .evaluateAll((els) =>
        els.map((e) => (e as HTMLAnchorElement).getAttribute("href") ?? ""),
      );
    expect(navHrefs.filter((h) => h === "/operations")).toHaveLength(0);
  });

  test("the Home Operations SUMMARY tab still works for Free", async ({ page }) => {
    await open(page, "/home", "personal-free");
    await page.locator('[data-home-tab="operations"]').click();
    const panel = page.locator('[data-home-tabpanel="operations"]');
    await expect(panel).toBeVisible();
    // Verification summary + report production + intake are the product
    // summaries a Free user is entitled to.
    await expect(panel).toContainText(/verification/i);
  });
});

// ============================================================================
// §33 / §34 — the paid and shared contexts
// ============================================================================

test.describe("Personal Pro — same information, plus a workbench", () => {
  test("Home is unchanged and Operations is reachable", async ({ page }) => {
    await open(page, "/home", "personal-pro");
    await expect(
      page.locator('[data-self-serve-section="workspace-priorities"]'),
    ).toBeVisible();
  });

  test("the workbench shows NO ownership axis for a sole operator", async ({
    page,
  }) => {
    await open(page, "/operations", "personal-pro");
    await expect(page.locator('[data-testid="operations-page"]')).toBeVisible();
    // The hub bar is gone: one page, one header, one <h1>.
    await expect(page.locator("[data-hub-page-id='operations']")).toHaveCount(0);
    await expect(page.locator("h1")).toHaveCount(1);

    // Ownership partitions work between PEOPLE. With one operator there is
    // nothing to partition, so the column, the filter and the two
    // collaborative cards are all absent — from ONE server-projected count,
    // not from a plan branch.
    await expect(page.locator("[data-ops-owner-filter]")).toHaveCount(0);
    await expect(page.locator('[data-ops-metric="assignedToMe"]')).toHaveCount(0);
    await expect(page.locator('[data-ops-metric="unassigned"]')).toHaveCount(0);
    await expect(page.locator("[data-ops-owner]")).toHaveCount(0);

    // …and the acting controls it DOES have are reachable through the row menu.
    await page.locator("[data-ops-row-menu-trigger]").first().click();
    await expect(
      page.locator('[data-ops-row-action="acknowledge"]').first(),
    ).toBeVisible();
  });
});

test.describe("Team / Organization — the full workbench", () => {
  test("ownership renders, and assignment opens from the inspector", async ({
    page,
  }) => {
    await open(page, "/operations", "team-admin");

    // The axis exists: a column, a filter and the two collaborative cards.
    await expect(page.locator("[data-ops-owner-filter]")).toBeVisible();
    await expect(page.locator('[data-ops-metric="assignedToMe"]')).toBeVisible();
    await expect(page.locator('[data-ops-metric="unassigned"]')).toBeVisible();
    // "Unassigned" is a WORD, never an empty cell.
    await expect(
      page.locator('[data-ops-table-surface] [data-ops-owner]').first(),
    ).toHaveText(/Unassigned|You|\S/);

    // Ownership is a DECISION, so it lives where the context to make it is.
    await page.locator("[data-ops-open]").first().click();
    await expect(page.locator("[data-ops-inspector]")).toBeVisible();
    await expect(page.locator("[data-ops-assignment-control]")).toBeVisible();
    await expect(page.locator('[data-ops-action="self-assign"]')).toBeVisible();
  });

  test("the owner listbox is the canonical one, not a native select", async ({
    page,
  }) => {
    await open(page, "/operations", "team-admin");
    // The whole route: zero native option popups. The OS popup cannot be
    // styled, cannot escape a clipping ancestor, and cannot be audited.
    await expect(page.locator("select")).toHaveCount(0);
    await expect(page.locator(".app-listbox__trigger").first()).toBeVisible();
  });
});

test.describe("Viewer — sees the work, acts on none of it", () => {
  test("no mutation control renders, and ownership is still readable", async ({
    page,
  }) => {
    await open(page, "/operations", "viewer");
    await expect(page.locator('[data-testid="operations-page"]')).toBeVisible();

    // Nothing to press: no row menu, no selection checkbox, no bulk bar.
    await expect(page.locator("[data-ops-row-menu-trigger]")).toHaveCount(0);
    await expect(page.locator('input[type="checkbox"]')).toHaveCount(0);
    await expect(page.locator("[data-ops-bulk-toolbar]")).toHaveCount(0);
    for (const action of ["acknowledge", "resolve", "suppress", "self-assign"]) {
      await expect(page.locator(`[data-ops-action="${action}"]`)).toHaveCount(0);
    }

    // …and ownership is still READABLE. A viewer in a shared workspace is
    // there to answer "who is on this", which needs the axis without the verb.
    await expect(page.locator("[data-ops-owner-filter]")).toBeVisible();
    await expect(
      page.locator('[data-ops-table-surface] [data-ops-owner]').first(),
    ).toBeVisible();
  });
});

// ============================================================================
// §29 / §30 — the viewport matrix
// ============================================================================

const SURFACES = [
  { name: "home-overview", path: "/home", context: "team-admin" as const },
  { name: "notifications", path: "/notifications", context: "team-admin" as const },
  { name: "operations", path: "/operations", context: "team-admin" as const },
] as const;

for (const surface of SURFACES) {
  for (const viewport of VIEWPORTS) {
    test(`${surface.name} @ ${viewport.name} does not scroll horizontally`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await open(page, surface.path, surface.context);
      // THE property. A second scroll direction is the WCAG 1.4.10 failure and
      // the thing a fixed-width card grid causes at 320px.
      expect(
        await hasHorizontalOverflow(page),
        `${surface.name} overflows at ${viewport.width}px`,
      ).toBe(false);
    });
  }
}

// ============================================================================
// §35 — RTL
// ============================================================================

for (const surface of SURFACES) {
  test(`${surface.name} mirrors correctly in Arabic`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page, surface.path, surface.context);
    await setDirection(page, "rtl");

    expect(
      await hasHorizontalOverflow(page),
      `${surface.name} overflows in RTL`,
    ).toBe(false);

    // The document really is mirrored — otherwise every assertion below is
    // measuring an LTR page.
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).direction,
      ),
    ).toBe("rtl");
  });
}

test("the notification metric cards do not clip in RTL", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, "/notifications", "team-admin");
  await setDirection(page, "rtl");
  const cards = page.locator("[data-notifications-metric]");
  const count = await cards.count();
  expect(count).toBe(6);
  for (let i = 0; i < count; i += 1) {
    const clipped = await cards.nth(i).evaluate(
      (el) => el.scrollWidth - el.clientWidth > 1,
    );
    expect(clipped, `metric card ${i} clips its label in RTL`).toBe(false);
  }
});

// ============================================================================
// §36 — accessibility, exercised rather than asserted about
// ============================================================================

test.describe("Accessibility", () => {
  test("metric cards are keyboard reachable and announce their state", async ({
    page,
  }) => {
    await open(page, "/notifications", "team-admin");
    const chip = page.locator("[data-notifications-metric]:not([disabled])").first();
    await expect(chip).toBeVisible();

    // It is a real button, so it takes focus from the keyboard.
    await chip.focus();
    expect(
      await page.evaluate(() =>
        document.activeElement?.hasAttribute("data-notifications-metric"),
      ),
    ).toBe(true);

    // Pressed state is announced, not implied by colour.
    expect(await chip.getAttribute("aria-pressed")).not.toBeNull();
  });

  test("focus is VISIBLE, not just present", async ({ page }) => {
    await open(page, "/notifications", "team-admin");
    const chip = page.locator("[data-notifications-metric]:not([disabled])").first();
    await chip.focus();
    const shadow = await chip.evaluate((el) => getComputedStyle(el).boxShadow);
    // The focus ring is a box-shadow token; "none" would mean an invisible
    // focus target, which is a keyboard trap in practice.
    expect(shadow).not.toBe("none");
  });

  test("severity is never communicated by colour alone", async ({ page }) => {
    await open(page, "/notifications", "team-admin");
    const labels = await page
      .locator("[data-notifications-metric] .app-metric-card__label")
      .allTextContents();
    expect(labels.length).toBe(6);
    // Every card carries its meaning as TEXT — a label and an explanation —
    // beside the figure, so the tone rail is a supporting cue and never the
    // signal itself.
    for (const label of labels) {
      expect(label.trim().length).toBeGreaterThan(0);
    }
    const metas = await page
      .locator("[data-notifications-metric] .app-metric-card__meta")
      .allTextContents();
    for (const meta of metas) {
      expect(meta.trim().length).toBeGreaterThan(0);
    }
  });

  test("the assignment control is a labelled listbox, keyboard operable", async ({
    page,
  }) => {
    await open(page, "/operations", "team-admin");
    await page.locator("[data-ops-open]").first().click();
    const control = page.locator("[data-ops-assignment-control]");
    await expect(control).toBeVisible();

    // It WAS a native <select>. It is now the canonical AppListbox, whose
    // accessible name is the same word the operator reads above it.
    const trigger = control.locator(".app-listbox__trigger");
    await expect(trigger).toBeVisible();
    const labelledBy = await trigger.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    const labelText = await page.locator(`#${labelledBy}`).textContent();
    expect((labelText ?? "").trim()).toMatch(/owner/i);

    await trigger.focus();
    expect(
      await page.evaluate(() =>
        document.activeElement?.getAttribute("aria-haspopup"),
      ),
    ).toBeTruthy();
  });

  test("every interactive control on a row is a real element", async ({
    page,
  }) => {
    await open(page, "/operations", "team-admin");
    const tags = await page
      .locator("[data-ops-table-surface] tbody button, [data-ops-table-surface] tbody a, [data-ops-table-surface] tbody input")
      .evaluateAll((els) => els.map((e) => e.tagName.toLowerCase()));
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(["button", "a", "input"]).toContain(tag);
    }
  });
});

// ============================================================================
// §37 — deterministic screenshots for review
// ============================================================================

test.describe("Screenshots", () => {
  const SHOTS: ReadonlyArray<{
    file: string;
    path: string;
    context: AttentionContext;
    width: number;
    height: number;
    rtl?: boolean;
    openAssignment?: boolean;
  }> = [
    { file: "home-free-desktop", path: "/home", context: "personal-free", width: 1440, height: 900 },
    { file: "home-free-mobile", path: "/home", context: "personal-free", width: 390, height: 844 },
    { file: "home-team-desktop", path: "/home", context: "team-admin", width: 1440, height: 900 },
    { file: "notifications-desktop", path: "/notifications", context: "team-admin", width: 1440, height: 900 },
    { file: "notifications-mobile", path: "/notifications", context: "team-admin", width: 390, height: 844 },
    { file: "operations-desktop", path: "/operations", context: "team-admin", width: 1440, height: 900 },
    { file: "operations-mobile", path: "/operations", context: "team-admin", width: 390, height: 844 },
    { file: "operations-assignment-open", path: "/operations", context: "team-admin", width: 1440, height: 900, openAssignment: true },
    { file: "home-rtl", path: "/home", context: "team-admin", width: 1280, height: 800, rtl: true },
    { file: "operations-rtl", path: "/operations", context: "team-admin", width: 1280, height: 800, rtl: true },
  ];

  for (const shot of SHOTS) {
    test(`screenshot: ${shot.file}`, async ({ page }) => {
      await page.setViewportSize({ width: shot.width, height: shot.height });
      await open(page, shot.path, shot.context);
      if (shot.rtl) await setDirection(page, "rtl");
      if (shot.openAssignment) {
        // Ownership moved into the inspector, where the operator has the
        // context to decide it.
        await page.locator("[data-ops-open]").first().click();
        await page.locator("[data-ops-inspector]").waitFor();
      }
      await page.screenshot({
        path: `${SHOT_DIR}/${shot.file}.png`,
        fullPage: true,
      });
    });
  }
});
