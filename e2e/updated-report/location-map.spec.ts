/**
 * THE RECORDED-LOCATION MAP, end to end on the real stack (production API +
 * worker images, production web build) — 2026-10-18.
 *
 * The map draws the real OpenStreetMap tiles it used until ebea6a075, but only
 * after the viewer explicitly presses "Load interactive map" (the one map
 * policy: `resolveInteractiveMapTileSource`). The report worker still refuses
 * every public provider.
 *
 * Playwright answers tile.openstreetmap.org itself (generated tiles, nothing
 * leaves the machine) unless REAL_MAP_TILES=1, which lets the requests through
 * to OpenStreetMap for screenshots with real geography.
 *
 *   1. Owner Evidence: the card and the consent control; NO tile request
 *      before the click; after it, real tiles at the recorded z/x/y, marker,
 *      accuracy radius, attribution — desktop and phone.
 *   2. Tiles failing after consent: the Recorded location card, facts kept.
 *   3. Public Verify of a record whose owner decided to show its recorded
 *      location (CONTENT_PREVIEW + show_recorded_location): the Recorded
 *      Location card, consent first.
 *   4. Public Verify of a VERIFICATION_ONLY record: no coordinates in the API
 *      answer or the page, no consent control, no tile request.
 */
import { deflateSync } from "node:zlib";

import { test, expect, type BrowserContext, type Page } from "@playwright/test";

import { API_BASE, clearTestRateLimits, createGuestSession, type GuestSession } from "../helpers/api-client";
import { signIn } from "./_browser";
import { createFinalizedEvidence, personalTeamId, sql, waitForPair } from "./_stack";

test.describe.configure({ mode: "serial" });

const LAT = 52.520008;
const LNG = 13.404954;
const ACCURACY = 12;
const TILE_HOST = "https://tile.openstreetmap.org";
const REAL = process.env.REAL_MAP_TILES === "1";
/** Real-mode HTTP statuses from OpenStreetMap (asserted all 200). */
const realStatuses: number[] = [];

let A: GuestSession;
let evidenceId = "";
let ref = "";

/** A 256×256 RGB PNG: a pale ground with a faint street grid (test tiles, not geography). */
function tilePng(): Buffer {
  const size = 256;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const street = x % 64 < 3 || y % 64 < 3;
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = street ? 255 : 236;
      raw[o + 1] = street ? 255 : 233;
      raw[o + 2] = street ? 255 : 223;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    let c = ~0;
    for (const b of td) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(~c >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const TILE = tilePng();

/** Serve (or fail) OpenStreetMap tile requests; returns the requested z/x/y paths. */
async function serveTiles(target: Page | BrowserContext, ok: boolean): Promise<string[]> {
  const seen: string[] = [];
  await target.unroute(`${TILE_HOST}/**`).catch(() => {});
  await target.route(`${TILE_HOST}/**`, async (route) => {
    seen.push(new URL(route.request().url()).pathname);
    if (ok && REAL) {
      // Real OpenStreetMap: the tile must be served (200), not an "Access
      // blocked" tile, and the Referer must be the ORIGIN only.
      const referer = route.request().headers()["referer"] ?? "";
      expect(referer, "the tile request must carry the site origin only").toMatch(/^https?:\/\/[^/]+\/?$/);
      const response = await route.fetch();
      realStatuses.push(response.status());
      return route.fulfill({ response });
    }
    return ok
      ? route.fulfill({ status: 200, contentType: "image/png", body: TILE })
      : route.fulfill({ status: 503, body: "" });
  });
  return seen;
}

/** The slippy-map tile that contains the point at zoom z. */
function tileOf(lat: number, lng: number, z: number) {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const r = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return `/${z}/${x}/${y}.png`;
}

async function openIntegrity(page: Page) {
  await page.goto(`/evidence/${evidenceId}`);
  await page.waitForSelector(".evidence-detail-hero", { timeout: 60_000 });
  await page.getByRole("tab", { name: "Integrity" }).click();
}

test.beforeAll(async () => {
  test.setTimeout(600_000);
  await clearTestRateLimits();
  A = await createGuestSession();
  const teamId = await personalTeamId(A.api);
  evidenceId = (
    await createFinalizedEvidence(A.api, teamId, "location-map", undefined, {
      gps: { lat: LAT, lng: LNG, accuracyMeters: ACCURACY },
    })
  ).id;
  await waitForPair(A.api, evidenceId, 1, 300_000);
  ref = sql<{ r: string }>(`SELECT verification_ref AS r FROM evidence WHERE id = $1`, [evidenceId])[0]!.r;
});

test("OWNER EVIDENCE: no tile before the explicit choice; after it the real map with marker, accuracy radius and attribution — desktop and phone", async ({ page }) => {
  test.setTimeout(300_000);
  const seen = await serveTiles(page, true);
  await signIn(page, A.email);
  await openIntegrity(page);
  const consent = page.locator('[data-capture-location-map="consent"]');
  await expect(consent).toBeVisible({ timeout: 60_000 });
  await expect(consent.locator("[data-capture-location-coordinates]")).toContainText("52.520008");
  await expect(consent).toContainText("Loading the map sends the approximate viewed location and your IP address to OpenStreetMap.");
  // Nothing has asked OpenStreetMap for anything yet.
  await page.waitForTimeout(1_500);
  expect(seen, "a tile was requested before consent").toEqual([]);
  await expect(consent.locator("img")).toHaveCount(0);
  await consent.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("evidence-before-consent.png"), fullPage: false });

  await consent.locator('[data-map-action="load-interactive-map"]').click();
  const panel = page.locator('[data-capture-location-map="tiles"]');
  await expect(panel).toBeVisible();
  const map = panel.locator("[data-capture-location-map-view]");
  await expect(map).toHaveAttribute("aria-label", /Map of the recorded location at 52\.52/);
  const z = Number(await map.getAttribute("data-map-zoom"));
  await expect.poll(() => seen.includes(tileOf(LAT, LNG, z)), { timeout: 30_000 }).toBe(true);
  await expect(map).toHaveAttribute("data-map-loaded", "true", { timeout: 30_000 });
  await expect(panel.locator("[data-map-marker]")).toBeVisible();
  await expect(panel.locator("[data-map-accuracy-radius]")).toHaveAttribute("data-map-accuracy-radius", String(ACCURACY));
  await expect(panel.locator("[data-map-attribution]")).toContainText("OpenStreetMap contributors");
  await expect(panel.locator('[data-map-action="open-in-map"]')).toHaveAttribute("href", /^https:\/\/www\.openstreetmap\.org\/\?mlat=52\.52/);
  await expect(panel).not.toContainText(/verified/i);
  await page.waitForTimeout(REAL ? 2_500 : 300);
  if (REAL) expect(realStatuses.length > 0 && realStatuses.every((st) => st === 200), `OpenStreetMap statuses: ${realStatuses.join(",")}`).toBe(true);
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("evidence-after-consent-desktop.png"), fullPage: false });

  // Phone width: consent again (the choice is this view's only), then the map.
  await page.setViewportSize({ width: 390, height: 844 });
  await openIntegrity(page);
  await page.locator('[data-map-action="load-interactive-map"]').click();
  await expect(page.locator('[data-capture-location-map="tiles"] [data-capture-location-map-view]')).toHaveAttribute("data-map-loaded", "true", { timeout: 30_000 });
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over).toBeLessThanOrEqual(0);
  await page.waitForTimeout(REAL ? 2_500 : 300);
  await page.locator('[data-capture-location-map="tiles"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("evidence-after-consent-phone.png"), fullPage: false });
});

test("TILES FAIL after consent: the Recorded location card with the same facts — never the pseudo-map, never 'blocked'", async ({ page }) => {
  test.setTimeout(300_000);
  await serveTiles(page, false);
  await signIn(page, A.email);
  await openIntegrity(page);
  await page.locator('[data-map-action="load-interactive-map"]').click();
  const panel = page.locator('[data-capture-location-map="fallback"]');
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await expect(panel).toContainText("Map preview unavailable");
  await expect(panel).toContainText("52.520008");
  await expect(panel).not.toContainText(/blocked|Map imagery unavailable/i);
  await expect(panel.locator("img")).toHaveCount(0);
  await expect(panel.locator('[data-map-action="copy-coordinates"]')).toBeVisible();
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("evidence-provider-failure.png"), fullPage: false });
});

test("PUBLIC VERIFY, published: consent first, then the same real map; unpublished: no coordinates, no control, no tile request", async ({ browser }) => {
  test.setTimeout(300_000);
  await clearTestRateLimits();
  // The owner's explicit location decision: CONTENT_PREVIEW with the recorded location shown.
  sql(`UPDATE evidence SET verification_disclosure_mode = 'CONTENT_PREVIEW', show_recorded_location = true WHERE id = $1`, [evidenceId]);
  const pub = (await (await fetch(`${API_BASE}/public/verify/${ref}`)).json()) as { captureContext?: { lat: number; lng: number; accuracyMeters: number } };
  expect(pub.captureContext).toMatchObject({ lat: LAT, lng: LNG, accuracyMeters: ACCURACY });

  const anon = await browser.newContext();
  try {
    const seen = await serveTiles(anon, true);
    const p = await anon.newPage();
    await p.goto(`/verify/${ref}`);
    const consent = p.locator('[data-capture-location-map="consent"]');
    await expect(consent).toBeVisible({ timeout: 90_000 });
    // The Recorded Location card states the location as recorded / device-reported — never verified.
    const card = p.getByTestId("verify-recorded-location");
    await expect(card).toContainText("Recorded Location");
    await expect(card).not.toContainText(/\bverified\b/i);
    await p.waitForTimeout(1_500);
    expect(seen, "Public Verify requested a tile before consent").toEqual([]);
    await consent.locator('[data-map-action="load-interactive-map"]').click();
    const panel = p.locator('[data-capture-location-map="tiles"]');
    await expect(panel.locator("[data-capture-location-map-view]")).toHaveAttribute("data-map-loaded", "true", { timeout: 30_000 });
    await expect(panel.locator("[data-capture-location-coordinates]")).toContainText("52.520008");
    await expect(panel.locator("[data-map-accuracy-radius]")).toHaveAttribute("data-map-accuracy-radius", String(ACCURACY));
    expect(seen.length).toBeGreaterThan(0);
    await p.waitForTimeout(REAL ? 2_500 : 300);
    await panel.scrollIntoViewIfNeeded();
    await p.screenshot({ path: test.info().outputPath("public-verify-published-after-consent.png"), fullPage: false });

    // UNPUBLISHED: the API withholds the location, so there is nothing to draw
    // and nothing that reveals a hidden location exists.
    sql(`UPDATE evidence SET show_recorded_location = false, verification_disclosure_mode = 'VERIFICATION_ONLY' WHERE id = $1`, [evidenceId]);
    await clearTestRateLimits();
    const raw = await (await fetch(`${API_BASE}/public/verify/${ref}`)).text();
    for (const leak of ["52.52", "13.40", '"captureContext":{']) expect(raw, `the API leaks ${leak}`).not.toContain(leak);
    seen.length = 0;
    const q = await anon.newPage();
    await q.goto(`/verify/${ref}`);
    await expect(q.locator("[data-verify-canonical-reference]").first()).toHaveText(ref, { timeout: 90_000 });
    await expect(q.locator("[data-capture-location-map]")).toHaveCount(0);
    await expect(q.locator('[data-map-action="load-interactive-map"]')).toHaveCount(0);
    expect(await q.content()).not.toContain("52.52");
    await q.waitForTimeout(1_500);
    expect(seen, "an unpublished page requested a tile").toEqual([]);
    await q.screenshot({ path: test.info().outputPath("public-verify-unpublished-no-location.png"), fullPage: false });
  } finally {
    await anon.close();
  }
});
