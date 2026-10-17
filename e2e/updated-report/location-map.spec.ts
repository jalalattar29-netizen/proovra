/**
 * THE RECORDED-LOCATION MAP, end to end on the real stack (production API +
 * worker images, production web build).
 *
 * The web build names an APPROVED tile endpoint (NEXT_PUBLIC_CAPTURE_LOCATION_
 * TILE_URL=http://tiles.rga.test/{z}/{x}/{y}.png — a stand-in for the
 * deployment's own tile server; AUD-025 refuses public providers). Playwright
 * answers that host with generated tiles, so nothing leaves the machine.
 *
 *   1. Owner Evidence: a REAL map — tiles requested at the recorded position,
 *      a marker, the recorded accuracy radius, attribution; desktop and phone.
 *   2. Tiles failing: the Recorded location card, never a pseudo-map.
 *   3. Public Verify of a PUBLISHED record: the same location facts and map.
 *   4. Public Verify of an UNPUBLISHED record: no coordinates in the API
 *      answer or the page — nothing to draw.
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
const TILE_HOST = "http://tiles.rga.test";

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

/** Serve (or fail) the approved tile host; returns the requested z/x/y paths. */
async function serveTiles(target: Page | BrowserContext, ok: boolean): Promise<string[]> {
  const seen: string[] = [];
  await target.unroute(`${TILE_HOST}/**`).catch(() => {});
  await target.route(`${TILE_HOST}/**`, (route) => {
    seen.push(new URL(route.request().url()).pathname);
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

test("OWNER EVIDENCE: a real map at the recorded position, with marker, accuracy radius and attribution — desktop and phone", async ({ page }) => {
  test.setTimeout(300_000);
  const seen = await serveTiles(page, true);
  await signIn(page, A.email);
  await openIntegrity(page);
  const panel = page.locator('[data-capture-location-map="tiles"]');
  await expect(panel).toBeVisible({ timeout: 60_000 });
  const map = panel.locator("[data-capture-location-map-view]");
  await expect(map).toHaveAttribute("role", "img");
  await expect(map).toHaveAttribute("aria-label", /Map of the recorded location at 52\.52/);
  const z = Number(await map.getAttribute("data-map-zoom"));
  await expect.poll(() => seen.includes(tileOf(LAT, LNG, z)), { timeout: 30_000 }).toBe(true);
  await expect(panel.locator("[data-map-marker]")).toBeVisible();
  await expect(panel.locator("[data-map-accuracy-radius]")).toHaveAttribute("data-map-accuracy-radius", String(ACCURACY));
  await expect(panel.locator("[data-map-attribution]")).toContainText("OpenStreetMap contributors");
  await expect(panel.locator("[data-capture-location-coordinates]")).toContainText("52.520008");
  await expect(panel.locator('[data-map-action="open-in-map"]')).toHaveAttribute("href", /^https:\/\/www\.openstreetmap\.org\/\?mlat=52\.52/);
  // Nothing about client-reported coordinates reads as verified.
  await expect(panel).not.toContainText(/verified/i);
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("evidence-location-map-desktop.png"), fullPage: false });

  await page.setViewportSize({ width: 390, height: 844 });
  await openIntegrity(page);
  await expect(page.locator('[data-capture-location-map="tiles"]')).toBeVisible({ timeout: 60_000 });
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over).toBeLessThanOrEqual(0);
  await page.locator('[data-capture-location-map="tiles"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("evidence-location-map-phone.png"), fullPage: false });
});

test("TILES FAIL: the Recorded location card with the same facts — never the pseudo-map, never 'blocked'", async ({ page }) => {
  test.setTimeout(300_000);
  await serveTiles(page, false);
  await signIn(page, A.email);
  await openIntegrity(page);
  const panel = page.locator('[data-capture-location-map="fallback"]');
  await expect(panel).toBeVisible({ timeout: 60_000 });
  await expect(panel).toContainText("Map preview unavailable");
  await expect(panel).toContainText("52.520008");
  await expect(panel).not.toContainText(/blocked|Map imagery unavailable/i);
  await expect(panel.locator("img")).toHaveCount(0);
  await expect(panel.locator('[data-map-action="copy-coordinates"]')).toBeVisible();
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("evidence-location-fallback.png"), fullPage: false });
});

test("PUBLIC VERIFY, published: the same recorded-location facts and map; unpublished: no coordinates anywhere", async ({ browser }) => {
  test.setTimeout(300_000);
  await clearTestRateLimits();
  sql(`UPDATE evidence SET public_verify_state = 'PUBLISHED' WHERE id = $1`, [evidenceId]);
  const pub = (await (await fetch(`${API_BASE}/public/verify/${ref}`)).json()) as { captureContext?: { lat: number; lng: number; accuracyMeters: number } };
  expect(pub.captureContext).toMatchObject({ lat: LAT, lng: LNG, accuracyMeters: ACCURACY });

  const anon = await browser.newContext();
  try {
    await serveTiles(anon, true);
    const p = await anon.newPage();
    await p.goto(`/verify/${ref}`);
    const panel = p.locator('[data-capture-location-map="tiles"]');
    await expect(panel).toBeVisible({ timeout: 90_000 });
    await expect(panel.locator("[data-capture-location-coordinates]")).toContainText("52.520008");
    await expect(panel.locator("[data-map-accuracy-radius]")).toHaveAttribute("data-map-accuracy-radius", String(ACCURACY));
    await panel.scrollIntoViewIfNeeded();
    await p.screenshot({ path: test.info().outputPath("public-verify-published-location.png"), fullPage: false });

    // UNPUBLISHED: the API withholds the location, so the page has nothing to draw.
    sql(`UPDATE evidence SET public_verify_state = 'NOT_PUBLISHED' WHERE id = $1`, [evidenceId]);
    await clearTestRateLimits();
    const raw = await (await fetch(`${API_BASE}/public/verify/${ref}`)).text();
    for (const leak of ["52.52", "13.40", '"captureContext":{']) expect(raw, `the API leaks ${leak}`).not.toContain(leak);
    const q = await anon.newPage();
    await q.goto(`/verify/${ref}`);
    await expect(q.locator("[data-verify-canonical-reference]").first()).toHaveText(ref, { timeout: 90_000 });
    await expect(q.locator("[data-capture-location-map]")).toHaveCount(0);
    expect(await q.content()).not.toContain("52.52");
    await q.screenshot({ path: test.info().outputPath("public-verify-unpublished-no-location.png"), fullPage: false });
  } finally {
    await anon.close();
  }
});
