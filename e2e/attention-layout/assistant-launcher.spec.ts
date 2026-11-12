/**
 * THE FLOATING ASSISTANT LAUNCHER (2026-11-12, owner decision).
 *
 * The launcher floats at the viewport's bottom-right again (as it did before
 * 99f296c94 moved it into the header), stays fixed while the page scrolls, and
 * the header carries no assistant entry. Measured in a real Chromium against
 * the production bundle; the API is intercepted (fixtures) and EVERY other
 * request off the local web server is aborted, so nothing reaches a live
 * service or an AI provider.
 *
 * Also pins the post-sign-in Terms step's trigger from the client side: an
 * account whose acceptances match the required versions never sees it.
 */

import { expect, test, type Page, type Route } from "@playwright/test";

import { installApi } from "./_fixtures";

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

const REQUIRED = { terms: "2026-06-23", privacy: "2026-06-23", cookies: "2026-11-08" };

type Opts = { legalOutstanding?: boolean };
type Seen = { chat: Array<Record<string, unknown>>; availability: number; external: string[] };

async function boot(page: Page, size: { width: number; height: number }, opts: Opts = {}): Promise<Seen> {
  const seen: Seen = { chat: [], availability: 0, external: [] };
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  // Lowest priority: anything that leaves the local web server is refused.
  await page.route(
    (url) => url.hostname !== "127.0.0.1" && url.hostname !== "localhost",
    (route) => {
      seen.external.push(new URL(route.request().url()).hostname);
      return route.abort();
    },
  );
  await page.addInitScript((v: string) => {
    document.cookie = `cc_cookie=${encodeURIComponent(v)};path=/`;
  }, CONSENT);
  await page.setViewportSize(size);
  await installApi(page, "personal-pro", { homeCollections: true });

  // Highest priority: the signed-in user (the layout mounts the assistant only
  // with a session) and the assistant and legal endpoints this spec reads.
  await page.route("**/v1/users/me", (route) =>
    json(route, { user: { id: "user-self-0001", email: "operator@example.invalid", displayName: "Operator" } }),
  );
  await page.route("**/v1/ai/availability", (route) => {
    seen.availability += 1;
    return json(route, { data: { available: true, decision: "ALLOWED" } });
  });
  await page.route("**/v1/ai/chat", (route) => {
    seen.chat.push(JSON.parse(route.request().postData() ?? "{}"));
    return json(route, {
      data: { status: "ok", summary: "Open Capture, choose a file, then sign it.", suggestions: [], warnings: [] },
    });
  });
  await page.route("**/v1/users/legal-status", (route) =>
    json(route, {
      ok: !opts.legalOutstanding,
      requiresReacceptance: Boolean(opts.legalOutstanding),
      missingPolicies: opts.legalOutstanding ? ["cookies"] : [],
      acceptedVersions: opts.legalOutstanding ? { ...REQUIRED, cookies: "2026-06-26" } : REQUIRED,
      requiredVersions: REQUIRED,
    }),
  );
  return seen;
}

async function openHome(page: Page) {
  await page.goto("/home");
  await page.waitForSelector('[data-self-serve-home-state="ready"]', { timeout: 30_000 });
  await page.locator(".assistant-launcher").waitFor({ state: "visible" });
}

const launcherBox = (page: Page) =>
  page.evaluate(() => {
    const r = document.querySelector<HTMLElement>(".assistant-launcher")!.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, vw: innerWidth, vh: innerHeight };
  });

const SHOTS = process.env.ASSISTANT_SHOTS_DIR;
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

for (const size of [
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "laptop-1024", width: 1024, height: 768 },
  { name: "edge-981", width: 981, height: 768 },
  { name: "mobile-390", width: 390, height: 844 },
  { name: "mobile-360", width: 360, height: 740 },
  { name: "reflow-320", width: 320, height: 800 },
]) {
  test(`${size.name}: the launcher floats bottom-right, stays put on scroll, and the header has no assistant`, async ({ page }) => {
    const seen = await boot(page, size);
    await openHome(page);
    await shot(page, `${size.name}-home`);

    const before = await launcherBox(page);
    // 1.5rem from the right and bottom edges (0.75rem on a phone), 3rem square.
    const inset = size.width <= 640 ? 12 : 24;
    expect(Math.round(before.vw - before.right)).toBe(inset);
    expect(Math.round(before.vh - before.bottom)).toBe(inset);
    expect(Math.round(before.right - before.left)).toBe(48);
    expect(await page.locator(".assistant-dock").evaluate((el) => getComputedStyle(el).position)).toBe("fixed");

    // The header carries no assistant entry, and no empty slot for one.
    expect(await page.locator(".app-account-toolbar .assistant-launcher").count()).toBe(0);
    expect(await page.locator("#app-header-assistant-slot").count()).toBe(0);

    // Scrolling moves the page, not the launcher.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(150);
    const after = await launcherBox(page);
    expect(after.top).toBeCloseTo(before.top, 0);
    expect(after.left).toBeCloseTo(before.left, 0);
    await shot(page, `${size.name}-home-scrolled`);

    // At the foot of the page the last content clears the launcher.
    const lastContentBottom = await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>(".app-shell-v2-content") ?? document.querySelector("main")!;
      let bottom = 0;
      for (const el of Array.from(main.querySelectorAll<HTMLElement>("a,button,input,select,textarea,[role=button]"))) {
        if (el.closest(".assistant-dock")) continue;
        const r = el.getBoundingClientRect();
        if (r.width && r.height) bottom = Math.max(bottom, r.bottom);
      }
      return bottom;
    });
    expect(lastContentBottom).toBeLessThanOrEqual(after.top);

    // The header's own controls never overlap one another.
    const overlaps = await page.evaluate(() => {
      const bar = document.querySelector<HTMLElement>(".app-account-toolbar")!;
      const items = Array.from(bar.querySelectorAll<HTMLElement>("a,button,input"))
        .filter((el) => !el.closest("[role=menu],[role=dialog],[role=listbox]"))
        .map((el) => ({ name: el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 20) ?? el.tagName, r: el.getBoundingClientRect() }))
        .filter((x) => x.r.width > 0 && x.r.height > 0);
      const out: string[] = [];
      for (let i = 0; i < items.length; i++)
        for (let j = i + 1; j < items.length; j++) {
          const a = items[i]!.r, b = items[j]!.r;
          const contains = (p: DOMRect, q: DOMRect) => p.left <= q.left && p.right >= q.right && p.top <= q.top && p.bottom >= q.bottom;
          if (contains(a, b) || contains(b, a)) continue; // nested controls
          if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1)
            out.push(`${items[i]!.name} × ${items[j]!.name}`);
        }
      return out;
    });
    expect(overlaps).toEqual([]);

    // The header row still fits: no page-level horizontal scroll.
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    expect(seen.external).toEqual([]);
  });

  test(`${size.name}: open, send, close`, async ({ page }) => {
    const seen = await boot(page, size);
    await openHome(page);

    await page.locator(".assistant-launcher").click();
    const panel = page.locator("[data-assistant-panel]");
    await expect(panel).toBeVisible();
    await expect.poll(() => seen.availability).toBe(1);

    const p = await panel.boundingBox();
    expect(p!.x).toBeGreaterThanOrEqual(0);
    expect(p!.x + p!.width).toBeLessThanOrEqual(size.width + 0.5);
    expect(p!.y).toBeGreaterThanOrEqual(0);
    expect(p!.y + p!.height).toBeLessThanOrEqual(size.height + 0.5);

    const field = panel.locator("textarea");
    await field.fill("How do I capture evidence?");
    await field.press("Enter");
    await expect(panel).toContainText("Open Capture, choose a file, then sign it.");
    expect(seen.chat).toHaveLength(1);
    expect(seen.chat[0]!.messages).toEqual([{ role: "user", content: "How do I capture evidence?" }]);
    expect(seen.chat[0]!.pageContext).toMatchObject({ path: "/home" });
    await shot(page, `${size.name}-panel-answered`);

    // The launcher closes it again.
    await page.locator(".assistant-launcher").click();
    await expect(panel).toHaveCount(0);
    await expect(page.locator(".assistant-launcher")).toHaveAttribute("aria-expanded", "false");
    expect(seen.external).toEqual([]);
  });
}

test("navigating between app pages keeps the launcher and the conversation", async ({ page }) => {
  const seen = await boot(page, { width: 1440, height: 900 });
  await openHome(page);
  await page.locator(".assistant-launcher").click();
  const panel = page.locator("[data-assistant-panel]");
  await panel.locator("textarea").fill("What is a verification package?");
  await panel.locator("textarea").press("Enter");
  await expect(panel).toContainText("Open Capture, choose a file, then sign it.");

  // A client-side navigation through the sidebar, as a person does it.
  const link = page.locator('nav a[href="/notifications"]').first();
  await link.click();
  await page.waitForURL("**/notifications");
  await expect(page.locator(".assistant-launcher")).toBeVisible();
  await expect(page.locator("[data-assistant-panel]")).toContainText("What is a verification package?");
  await shot(page, "desktop-1440-after-navigation");

  // A send from the new page reports the new page's safe path.
  await panel.locator("textarea").fill("What does TSA failed mean?");
  await panel.locator("textarea").press("Enter");
  await expect.poll(() => seen.chat.length).toBe(2);
  expect(seen.chat[1]!.pageContext).toMatchObject({ path: "/notifications" });
  expect(seen.external).toEqual([]);
});

test("the Terms step: never shown to an account that accepted the required versions", async ({ page }) => {
  await boot(page, { width: 1440, height: 900 });
  await openHome(page);
  await page.waitForTimeout(500);
  expect(await page.locator("[data-legal-step]").count()).toBe(0);
  await page.reload();
  await page.waitForSelector('[data-self-serve-home-state="ready"]', { timeout: 30_000 });
  await page.waitForTimeout(500);
  expect(await page.locator("[data-legal-step]").count()).toBe(0);
});

test("the Terms step: shown when a required version is outstanding", async ({ page }) => {
  await boot(page, { width: 1440, height: 900 }, { legalOutstanding: true });
  await page.goto("/home");
  await expect(page.locator("[data-legal-step]")).toBeVisible({ timeout: 30_000 });
});
