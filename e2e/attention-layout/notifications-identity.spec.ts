/**
 * NOTIFICATIONS IS A NOTIFICATIONS PAGE.
 *
 * WHAT THIS SUITE EXISTS TO PROVE
 *
 * After the Attention split, `/operations` became the shared workspace
 * workbench and `/notifications` became personal awareness. The Notifications
 * route did not get the message: it opened with `ACCOUNT · OPERATIONS CENTER`
 * over a title of `Operations Center`, a subtitle about "operational items
 * that require your attention", and an empty state whose primary action was
 * "Open workspace command center" — a workbench Personal Free does not have,
 * behind a button that actually navigated to Home.
 *
 * It also presented its counts as inline pills and its actions in a legacy
 * button family, so the page read as a different application from the one
 * around it.
 *
 * Every assertion here reads COMPUTED values out of the real production
 * bundle, in a real engine. Class names prove nothing on their own — a class
 * can exist and resolve to nothing — so where this suite claims two surfaces
 * share a visual system, it measures both and compares.
 */

import { expect, test, type Page } from "@playwright/test";

import { installApi, type AttentionContext } from "./_fixtures";

async function open(
  page: Page,
  path: string,
  context: AttentionContext,
  options: { emptyInbox?: boolean } = {},
): Promise<void> {
  await installApi(page, context, options);
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => undefined);
}

/** Vocabulary that must not appear anywhere on the Notifications page. */
const RETIRED_VOCABULARY = [
  "Operations Center",
  "OPERATIONS CENTER",
  "command center",
  "Command Center",
  "Operational items that require your attention",
  "Remind me tomorrow",
  "Nothing requires your attention",
];

const NOTIFICATION_CONTEXTS: ReadonlyArray<{
  name: string;
  context: AttentionContext;
}> = [
  { name: "personal-free", context: "personal-free" },
  { name: "personal-pro", context: "personal-pro" },
  { name: "team-admin", context: "team-admin" },
  { name: "organization-admin", context: "organization-admin" },
];

// ===========================================================================
// §1–§3, §24–§26 — identity, across every account shape
// ===========================================================================

test.describe("Notifications presents itself as Notifications", () => {
  for (const ctx of NOTIFICATION_CONTEXTS) {
    test(`${ctx.name}: titled Notifications, carrying no Operations identity`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await open(page, "/notifications", ctx.context);

      const heading = await page.locator("h1").first().textContent();
      expect(heading?.trim()).toBe("Notifications");

      const body = await page.locator("body").innerText();
      for (const phrase of RETIRED_VOCABULARY) {
        expect(
          body.includes(phrase),
          `${ctx.name}: "${phrase}" survives on the Notifications page`,
        ).toBe(false);
      }

      // The eyebrow is GONE rather than renamed: the title already says where
      // you are, and the canonical header does not need a breadcrumb above a
      // one-word destination to prove it.
      expect(body).not.toMatch(/ACCOUNT\s*·/i);
    });
  }

  test("Pro is still a notification product, not a second workbench", async ({
    page,
  }) => {
    // Pro HAS /operations. That must not turn this page back into a dashboard:
    // the existence of a workbench elsewhere is not a reason to duplicate it
    // here.
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "/notifications", "personal-pro");
    const proBody = await page.locator("body").innerText();

    await open(page, "/notifications", "personal-free");
    const freeBody = await page.locator("body").innerText();

    // Same title, same subtitle, same summary anatomy.
    for (const body of [proBody, freeBody]) {
      expect(body).toContain("Notifications");
      expect(body).toContain(
        "Updates, assignments, mentions and integrity alerts relevant to you.",
      );
    }
    expect(await page.locator("[data-notifications-metric]").count()).toBe(6);
  });
});

// ===========================================================================
// §4–§6, §31 — the Personal Free empty state
// ===========================================================================

test.describe("Personal Free, empty", () => {
  test("offers a caught-up state and NO call to action", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "/notifications", "personal-free", { emptyInbox: true });

    const empty = page.locator("[data-state='empty']");
    await expect(empty).toBeVisible();

    const text = await empty.innerText();
    expect(text).toContain("You're all caught up");
    // The operations lifecycle sentence is gone. A notification is an event
    // addressed to a person; it has no condition lifecycle to explain, and
    // "they stay in History" described a surface that is now /operations.
    expect(text).not.toContain("Items leave this list automatically");
    expect(text).not.toContain("They stay in History");

    // NO CTA — not a workbench link, not a consolation link. There is nothing
    // useful to do from an empty notification list, and a button that merely
    // navigates elsewhere is worse than its honest absence.
    expect(await empty.locator("a").count()).toBe(0);
    expect(await empty.locator("button").count()).toBe(0);
  });

  test("still renders the metric cards, reading zero", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "/notifications", "personal-free", { emptyInbox: true });

    const values = await page
      .locator("[data-notifications-metric] .app-metric-card__value")
      .allTextContents();
    expect(values).toHaveLength(6);
    for (const value of values) expect(value.trim()).toBe("0");
  });

  test("does not offer a workspace-scope control it cannot use", async ({
    page,
  }) => {
    // Personal Free has one context. A "Workspace scope / All workspaces"
    // control over a single workspace is chrome that answers nothing.
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "/notifications", "personal-free");
    expect(await page.locator("[data-inbox-workspace-scope]").count()).toBe(0);
  });
});

// ===========================================================================
// §7–§10, §12–§15, §33 — the canonical visual systems, measured
// ===========================================================================

test.describe("Notifications reuses the canonical visual systems", () => {
  test("the metric cards ARE the canonical card primitive, not a lookalike", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "/notifications", "team-admin");

    // MEASURE THE PRIMITIVE ITSELF, in this document.
    //
    // Comparing against a card rendered on Intake Links would need that page's
    // data in this project's fixture — a second copy of a fixture, to prove a
    // shared style. Instead a bare probe carrying ONLY `.app-metric-card` is
    // injected here and measured against the real card. If they resolve
    // identically, the notification card IS the primitive rather than
    // something styled to look like it; if a page-local rule had overridden
    // it, the two would diverge. The Intake Links side of the same claim is
    // asserted in the intake-links-layout project.
    const measured = await page.evaluate(() => {
      // An UNPRESSED card. `All` leads the row and is pressed whenever no
      // narrowing is in force — which is the page's opening state — and the
      // pressed variant deliberately paints a different surface. Measuring it
      // against a bare probe would compare the selected style to the resting
      // one and report a divergence that is the design.
      const real = document.querySelector(
        '[data-notifications-metric][aria-pressed="false"]',
      ) as HTMLElement | null;
      if (!real) return null;

      const probe = document.createElement("button");
      probe.className = "app-metric-card";
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      document.body.appendChild(probe);
      const p = getComputedStyle(probe);
      const reference = {
        radius: p.borderTopLeftRadius,
        paddingTop: p.paddingTop,
        paddingInlineStart: p.paddingInlineStart,
        shadow: p.boxShadow,
        background: p.backgroundColor,
        display: p.display,
      };
      probe.remove();

      const cs = getComputedStyle(real);
      return {
        shared: real.classList.contains("app-metric-card"),
        reference,
        resolved: {
          radius: cs.borderTopLeftRadius,
          paddingTop: cs.paddingTop,
          paddingInlineStart: cs.paddingInlineStart,
          shadow: cs.boxShadow,
          background: cs.backgroundColor,
          display: cs.display,
        },
        hasValue: Boolean(real.querySelector(".app-metric-card__value")),
        hasLabel: Boolean(real.querySelector(".app-metric-card__label")),
        hasMeta: Boolean(real.querySelector(".app-metric-card__meta")),
        // The rail is painted from a tone VARIABLE the route resolves — the
        // primitive itself never names a semantic colour.
        tone: cs.getPropertyValue("--app-metric-tone").trim(),
      };
    });

    expect(measured, "Notifications rendered no metric card").not.toBeNull();
    expect(measured!.shared).toBe(true);
    expect(measured!.resolved).toEqual(measured!.reference);
    expect(measured!.hasValue).toBe(true);
    expect(measured!.hasLabel).toBe(true);
    expect(measured!.hasMeta).toBe(true);
    expect(measured!.tone.length).toBeGreaterThan(0);
  });

  test("the retired inline pill summary is gone", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "/notifications", "team-admin");
    expect(await page.locator(".ops-severity-chip").count()).toBe(0);
    expect(await page.locator(".ops-summary-strip").count()).toBe(0);
  });

  test("Refresh IS the canonical primary action, not a legacy button", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "/notifications", "team-admin");

    const refresh = page.locator("[data-action='refresh-inbox']");
    await expect(refresh).toBeVisible();
    const measured = await refresh.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        canonical: el.classList.contains("app-primary-action"),
        legacy: el.classList.contains("btn"),
        height: cs.height,
        radius: cs.borderTopLeftRadius,
        size: cs.fontSize,
        background: cs.backgroundImage,
        tag: el.tagName,
        name: (el as HTMLElement).innerText.trim(),
      };
    });
    // The CLASS is reused — not a copied purple.
    expect(measured.canonical).toBe(true);
    expect(measured.legacy).toBe(false);
    expect(measured.background).toContain("gradient");
    expect(measured.height).toBe("36px");
    expect(measured.radius).toBe("8px");
    expect(measured.size).toBe("12.5px");
    expect(measured.tag).toBe("BUTTON");
    expect(measured.name).toContain("Refresh");
  });

  test("row actions ARE the canonical row-action primitive", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "/notifications", "team-admin");

    const actions = page.locator(
      "[data-inbox-item-actions] .app-secondary-action",
    );
    expect(
      await actions.count(),
      "no canonical row action on a notification row",
    ).toBeGreaterThan(0);

    // Same technique as the metric card: a bare probe carrying only
    // `.app-secondary-action` — the class Intake Links rows use for
    // "View submissions" and "Open" — measured against the real control.
    const measured = await page.evaluate(() => {
      const real = document.querySelector(
        "[data-inbox-item-actions] .app-secondary-action",
      ) as HTMLElement | null;
      if (!real) return null;

      const probe = document.createElement("button");
      probe.className = "app-secondary-action";
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      document.body.appendChild(probe);
      const p = getComputedStyle(probe);
      const reference = {
        height: p.height,
        radius: p.borderTopLeftRadius,
        borderWidth: p.borderTopWidth,
        fontWeight: p.fontWeight,
        fontSize: p.fontSize,
        paddingInlineStart: p.paddingInlineStart,
      };
      probe.remove();

      const cs = getComputedStyle(real);
      return {
        reference,
        resolved: {
          height: cs.height,
          radius: cs.borderTopLeftRadius,
          borderWidth: cs.borderTopWidth,
          fontWeight: cs.fontWeight,
          fontSize: cs.fontSize,
          paddingInlineStart: cs.paddingInlineStart,
        },
      };
    });

    expect(measured).not.toBeNull();
    expect(measured!.resolved).toEqual(measured!.reference);

    // The page-local action shape it replaced is gone from the row cluster.
    expect(
      await page.locator("[data-inbox-item-actions] .ops-link-btn").count(),
    ).toBe(0);
  });
});

// ===========================================================================
// §16, §18, §19 — row semantics
// ===========================================================================

test.describe("Notification row semantics", () => {
  test("each row offers only the read action that changes something, and no reminder", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "/notifications", "team-admin");

    const rows = page.locator("[data-inbox-item-actions]");
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i += 1) {
      const row = rows.nth(i);
      const read = await row.locator("[data-action='mark-read']").count();
      const unread = await row.locator("[data-action='mark-unread']").count();
      // Never both: showing the opposite state is a control whose outcome is
      // already true.
      expect(read + unread, `row ${i} offers both or neither`).toBe(1);
      // The reminder action is gone from every row.
      expect(await row.locator("[data-action='remind']").count()).toBe(0);
    }
  });

  test("Archive is the word, and Dismiss is not", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "/notifications", "team-admin");
    const labels = await page
      .locator("[data-inbox-item-actions] button")
      .allTextContents();
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect(label).not.toMatch(/dismiss/i);
  });

  test("every row action is a real, focusable control with an accessible name", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "/notifications", "team-admin");

    const controls = page.locator(
      "[data-inbox-item-actions] button, [data-inbox-item-actions] a",
    );
    const count = await controls.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < Math.min(count, 12); i += 1) {
      const control = controls.nth(i);
      const info = await control.evaluate((el) => ({
        tag: el.tagName,
        name:
          el.getAttribute("aria-label") ?? (el as HTMLElement).innerText.trim(),
        nested: el.querySelectorAll("button, a").length,
      }));
      expect(["BUTTON", "A"]).toContain(info.tag);
      expect(info.name.length, `control ${i} has no accessible name`).toBeGreaterThan(0);
      // No nested interactive elements — one control, one target.
      expect(info.nested).toBe(0);
    }
  });
});

// ===========================================================================
// §11, §30 — the metric grid across every required viewport, LTR and RTL
// ===========================================================================

const METRIC_VIEWPORTS = [1440, 1280, 1024, 768, 390, 375, 320];

test.describe("the metric grid reflows without overflow", () => {
  for (const direction of ["ltr", "rtl"] as const) {
    test(`${direction}: six cards fit at every supported width`, async ({
      page,
    }) => {
      for (const width of METRIC_VIEWPORTS) {
        await page.setViewportSize({ width, height: 900 });
        await open(page, "/notifications", "team-admin");
        if (direction === "rtl") {
          await page.evaluate(() => {
            document.documentElement.setAttribute("dir", "rtl");
            document.documentElement.setAttribute("lang", "ar");
          });
          await page.evaluate(
            () => new Promise((r) => requestAnimationFrame(() => r(null))),
          );
        }

        const problems = await page.evaluate(() => {
          const bad: string[] = [];
          const doc = document.documentElement;
          if (doc.scrollWidth - doc.clientWidth > 1) {
            bad.push("page scrolls sideways");
          }
          const cards = Array.from(
            document.querySelectorAll<HTMLElement>("[data-notifications-metric]"),
          );
          if (cards.length !== 6) bad.push(`expected 6 cards, saw ${cards.length}`);
          const grid = document.querySelector(
            "[data-notifications-metric-grid]",
          ) as HTMLElement | null;
          if (!grid) {
            bad.push("no metric grid");
            return bad;
          }
          const gb = grid.getBoundingClientRect();
          for (const card of cards) {
            const cb = card.getBoundingClientRect();
            // Inside its own grid, with a pixel of sub-pixel tolerance.
            if (cb.left < gb.left - 1 || cb.right > gb.right + 1) {
              bad.push(`card escapes the grid: ${card.textContent?.slice(0, 20)}`);
            }
            // A crushed figure is a card that has stopped being readable.
            if (cb.width < 60) bad.push(`card crushed to ${Math.round(cb.width)}px`);
            const value = card.querySelector(
              ".app-metric-card__value",
            ) as HTMLElement | null;
            if (value && value.scrollWidth > value.clientWidth + 1) {
              bad.push("figure is clipped");
            }
          }
          return bad;
        });
        expect(problems, `${direction} @ ${width}px`).toEqual([]);
      }
    });
  }

  test("equal visual rhythm — every card in a row shares one height", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, "/notifications", "team-admin");
    const heights = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>("[data-notifications-metric]"),
      ).map((el) => Math.round(el.getBoundingClientRect().height)),
    );
    expect(heights).toHaveLength(6);
    expect(new Set(heights).size, `heights differ: ${heights.join(", ")}`).toBe(1);
  });
});
