/**
 * HOME'S SEMANTIC SURFACES, MEASURED.
 *
 * These properties are all cascade or geometry: which token a status resolves
 * to, whether a capsule is still behind a word, whether a label agrees with the
 * number beside it, and how many intake rows render. jsdom resolves no cascade,
 * so a jsdom proof of any of them is a proof of nothing.
 *
 * The reference for every orange here is the Notifications severity card
 * "High / Important, not urgent.", which paints `--orange-500`. That card is
 * asserted in `notifications-reference-orange.spec.ts`; this file asserts the
 * surfaces that must agree with it.
 */

import { expect, test } from "@playwright/test";

import { installApi } from "./_fixtures";

const REFERENCE_ORANGE = "rgb(234, 88, 12)";
const CANONICAL_RED = "rgb(220, 38, 38)";
const CANONICAL_BLUE = "rgb(37, 99, 235)";
const CANONICAL_GREEN = "rgb(21, 128, 61)";
const CANONICAL_NAVY = "rgb(15, 23, 42)";

const CONSENT = JSON.stringify({
  categories: ["necessary"],
  revision: 1,
  data: null,
  consentTimestamp: "2026-08-29T19:14:00.000Z",
  consentId: "fixture-consent",
  services: { necessary: [], preferences: [], analytics: [], marketing: [] },
  languageCode: "en",
  lastConsentTimestamp: "2026-08-29T19:14:00.000Z",
  expirationTime: 4102444800000,
});

async function openHome(page: import("@playwright/test").Page) {
  await page.addInitScript((v: string) => {
    document.cookie = `cc_cookie=${encodeURIComponent(v)};path=/`;
  }, CONSENT);
  await page.setViewportSize({ width: 1440, height: 1400 });
  await installApi(page, "personal-pro", { homeCollections: true });
  await page.goto("/home");
  await page.waitForSelector('[data-self-serve-home-state="ready"]', { timeout: 30_000 });
}

// ===========================================================================
// WHAT NEEDS ATTENTION
// ===========================================================================
test("a priority title stays navy while its severity carries the colour", async ({ page }) => {
  await openHome(page);
  const items = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".home-attn__item")).map((i) => {
      const title = i.querySelector<HTMLElement>(".home-attn__title")!;
      const pill = i.querySelector<HTMLElement>(".home-attn__pill")!;
      const action = i.querySelector<HTMLElement>("a")!;
      return {
        titleColor: getComputedStyle(title).color,
        status: pill.textContent?.trim(),
        statusColor: getComputedStyle(pill).color,
        // A capsule would paint one. Plain text paints nothing.
        statusBg: getComputedStyle(pill).backgroundColor,
        statusBorder: getComputedStyle(pill).borderTopWidth,
        actionColor: getComputedStyle(action).color,
      };
    }),
  );

  expect(items.length).toBeGreaterThan(0);
  for (const i of items) {
    expect(i.titleColor, "severity must not leak into the title").toBe(CANONICAL_NAVY);
    expect(i.actionColor, "one action blue").toBe(CANONICAL_BLUE);
    expect(i.statusBg, "no capsule behind the severity").toBe("rgba(0, 0, 0, 0)");
    expect(i.statusBorder).toBe("0px");
    if (i.status === "Critical") expect(i.statusColor).toBe(CANONICAL_RED);
    if (i.status === "Warning") expect(i.statusColor).toBe(REFERENCE_ORANGE);
  }
  expect(items.some((i) => i.status === "Warning")).toBe(true);
});

// ===========================================================================
// WORKSPACE HEALTH — the label belongs to its number
// ===========================================================================
test("a health label wears the same colour as the value beside it", async ({ page }) => {
  await openHome(page);
  const rows = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-health-metric]")).map((r) => ({
      tone: r.getAttribute("data-tone"),
      label: r.querySelector<HTMLElement>(".home-row__label")!.textContent?.trim(),
      labelColor: getComputedStyle(r.querySelector<HTMLElement>(".home-row__label")!).color,
      valueColor: getComputedStyle(r.querySelector<HTMLElement>(".home-row__value")!).color,
    })),
  );

  expect(rows.length).toBeGreaterThan(0);
  const coloured = rows.filter((r) => r.tone && r.tone !== "neutral");
  expect(coloured.length, "the fixture must produce at least one toned row").toBeGreaterThan(0);
  for (const r of coloured) {
    expect(r.labelColor, `${r.label}: label and value must agree`).toBe(r.valueColor);
  }
  // And the tones are the canonical ones, not a Home-only palette.
  for (const r of coloured) {
    if (r.tone === "bad") expect(r.valueColor).toBe(CANONICAL_RED);
    if (r.tone === "warn") expect(r.valueColor).toBe(REFERENCE_ORANGE);
    if (r.tone === "ok") expect(r.valueColor).toBe(CANONICAL_GREEN);
  }
});

// ===========================================================================
// VERIFICATION SUMMARY — each count says its own thing
// ===========================================================================
test("each integrity count is coloured for what it means, not for the row", async ({ page }) => {
  await openHome(page);
  await page.locator('[data-home-tab="operations"]').first().click();
  await page.waitForSelector("[data-trust-key='tsa']");

  const segments = await page.evaluate(() => {
    const read = (key: string) =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          `[data-trust-key="${key}"] [data-trust-segment]`,
        ),
      ).map((s) => ({
        text: s.textContent?.trim(),
        tone: s.getAttribute("data-trust-segment"),
        color: getComputedStyle(s).color,
      }));
    return { tsa: read("tsa"), ots: read("ots") };
  });

  expect(segments.tsa.length, "the TSA row must be said in parts").toBeGreaterThan(1);
  // "stamped" is the good news and must not be painted as a failure.
  const stamped = segments.tsa.find((s) => s.text?.includes("stamped") && !s.text.includes("not"));
  expect(stamped?.color).toBe(CANONICAL_GREEN);
  const failed = segments.tsa.find((s) => s.text?.includes("failed"));
  if (failed) expect(failed.color).toBe(CANONICAL_RED);

  // OTS: anchored and pending are attention, not-anchored is an error.
  const anchored = segments.ots.find((s) => s.text?.includes("anchored") && !s.text.includes("not"));
  expect(anchored?.color).toBe(REFERENCE_ORANGE);
  const pending = segments.ots.find((s) => s.text?.includes("pending"));
  if (pending) expect(pending.color).toBe(REFERENCE_ORANGE);
  const notAnchored = segments.ots.find((s) => s.text?.includes("not anchored"));
  if (notAnchored) expect(notAnchored.color).toBe(CANONICAL_RED);
});

// ===========================================================================
// PLAIN-TEXT STATUSES — no capsule left behind
// ===========================================================================
test("Live, Report v-n and Package ready are words, not capsules", async ({ page }) => {
  await openHome(page);
  await page.locator('[data-home-tab="operations"]').first().click();
  await page.waitForSelector("[data-report-actions]");

  const statuses = await page.evaluate(() => {
    const wanted = /^(Live|Package ready|Report v\d+)$/;
    return Array.from(document.querySelectorAll<HTMLElement>("span"))
      .filter((n) => wanted.test(n.textContent?.trim() ?? ""))
      .map((n) => {
        const cs = getComputedStyle(n);
        return {
          text: n.textContent?.trim(),
          color: cs.color,
          bg: cs.backgroundColor,
          border: cs.borderTopWidth,
          radius: cs.borderTopLeftRadius,
        };
      });
  });

  expect(statuses.length, "the fixture must render these statuses").toBeGreaterThan(2);
  for (const s of statuses) {
    expect(s.bg, `${s.text} still has a filled capsule`).toBe("rgba(0, 0, 0, 0)");
    expect(s.border, `${s.text} still has a capsule border`).toBe("0px");
    if (s.text === "Live" || s.text === "Package ready") expect(s.color).toBe(CANONICAL_GREEN);
    if (s.text?.startsWith("Report v")) expect(s.color).toBe(CANONICAL_BLUE);
  }
});

// ===========================================================================
// INTAKE — five rows, in order, never padded
// ===========================================================================
test("intake renders up to five links, in the order it received them", async ({ page }) => {
  await openHome(page);
  await page.locator('[data-home-tab="operations"]').first().click();
  await page.waitForSelector("[data-collection-id]");

  const rows = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-collection-id]")).map((r) => ({
      id: r.getAttribute("data-collection-id"),
      label: r.querySelector<HTMLElement>("span")?.textContent?.trim(),
    })),
  );

  // The fixture serves SEVEN active links; the card shows five and offers the
  // rest behind its footer. Nothing is invented to reach five.
  expect(rows).toHaveLength(5);
  expect(rows.map((r) => r.id)).toEqual(["link-1", "link-2", "link-3", "link-4", "link-5"]);

  const footer = page.locator("[data-collection-view-all]");
  await expect(footer).toBeVisible();
  await expect(footer).toHaveAttribute("data-collection-view-all", "7");

  const actionColors = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-collection-id] a")).map(
      (a) => getComputedStyle(a).color,
    ),
  );
  for (const c of actionColors) expect(c, "intake actions are blue").toBe(CANONICAL_BLUE);
});

// ===========================================================================
// THE OVERFLOW MENU'S HOVER
// ===========================================================================
test("a report overflow item takes the selection lavender on hover, keeping its text", async ({
  page,
}) => {
  await openHome(page);
  await page.locator('[data-home-tab="operations"]').first().click();
  await page.locator("[data-report-overflow-toggle]").first().click();
  await page.waitForSelector("[data-report-overflow-menu]");

  const item = page.locator(".home-menu-item").first();
  expect(await item.evaluate((n) => getComputedStyle(n).backgroundColor)).toBe(
    "rgba(0, 0, 0, 0)",
  );
  await item.hover();
  // The tint transitions over 120ms; read it after it has arrived.
  await page.waitForTimeout(250);
  const hovered = await item.evaluate((n) => ({
    bg: getComputedStyle(n).backgroundColor,
    color: getComputedStyle(n).color,
  }));
  // `--accent-050`, the tint the canonical selectors already use. Not a grey
  // block, and not a dark purple slab that would swallow the label.
  expect(hovered.bg).toBe("rgb(242, 236, 254)");
  expect(hovered.color, "the label must stay readable").toBe(CANONICAL_NAVY);
});

// ===========================================================================
// ACTIVE MATTERS — a case NAME is a record title
// ===========================================================================
test("a matter's name stays navy while its health chip carries the verdict", async ({
  page,
}) => {
  await openHome(page);
  await page.waitForSelector("[data-matter-id]");

  const matters = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-matter-id]")).map((m) => {
      const title = m.querySelector<HTMLElement>("a > div > span")!;
      const verdict = m.querySelector<HTMLElement>("[data-matter-verdict]");
      return {
        name: title.textContent?.trim(),
        nameColor: getComputedStyle(title).color,
        verdict: verdict?.getAttribute("data-matter-verdict") ?? null,
      };
    }),
  );

  expect(matters.length, "the fixture must render a matter").toBeGreaterThan(0);
  for (const m of matters) {
    // The one thing on the row that must not take a status colour. Not blue,
    // not purple, not the verdict's green — the primary ink.
    expect(m.nameColor, `${m.name} must be the canonical navy`).toBe(CANONICAL_NAVY);
  }
  expect(matters.some((m) => m.name === "Bilal")).toBe(true);
});

// ===========================================================================
// REPORT PRODUCTION — the tiles mean what they say, at non-zero
// ===========================================================================
test("ready is success, pending is attention and failed is an error", async ({ page }) => {
  await openHome(page);
  await page.locator('[data-home-tab="operations"]').first().click();
  await page.waitForSelector("[data-report-stat]");

  const tiles = await page.evaluate(() =>
    Object.fromEntries(
      Array.from(document.querySelectorAll<HTMLElement>("[data-report-stat]")).map((t) => {
        const value = t.querySelector<HTMLElement>("div")!;
        const label = t.querySelectorAll<HTMLElement>("div")[1]!;
        return [
          t.getAttribute("data-report-stat"),
          {
            count: value.textContent?.trim(),
            valueColor: getComputedStyle(value).color,
            labelColor: getComputedStyle(label).color,
          },
        ];
      }),
    ),
  );

  // A zero tile is neutral by design, so this only means anything with counts.
  for (const key of ["Reports ready", "Packages ready", "Pending", "Failed"]) {
    expect(Number(tiles[key].count), `${key} must be non-zero to prove its tone`)
      .toBeGreaterThan(0);
  }

  expect(tiles["Reports ready"].valueColor).toBe(CANONICAL_GREEN);
  expect(tiles["Packages ready"].valueColor).toBe(CANONICAL_GREEN);
  // The whole point of this pass: pending is the Notifications High orange.
  expect(tiles["Pending"].valueColor).toBe(REFERENCE_ORANGE);
  expect(tiles["Pending"].labelColor).toBe(REFERENCE_ORANGE);
  expect(tiles["Failed"].valueColor).toBe(CANONICAL_RED);
  expect(tiles["Failed"].labelColor).toBe(CANONICAL_RED);
});
