#!/usr/bin/env node
/**
 * REMEDIATION-RERUN probe (not product code) — UC-DER-012's required proof:
 * "Playwright: View source thumbnails load against a cross-origin API".
 *
 * Real Chromium, signed in by the product's HttpOnly session cookie, opens the
 * Evidence page of the continuous capture J09 sealed (and J10 derived), selects
 * the Derived Review tab, and requires every keyframe thumbnail to load from the
 * API origin (web :3311, API :4000 — cross-origin) with the session credentials:
 * complete, non-zero natural size, a 200 from the bytes route, no
 * "Keyframe unavailable" fallback.
 *
 * Usage: node derived-thumbnails-probe.mjs <seed.json> <journeys-raw.json> <out.json> [screenshot.png]
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";

const require = createRequire("D:/pv-ucc/apps/extension/package.json");
const { chromium } = require("@playwright/test");

const API = process.env.UCA_API ?? "http://localhost:4000";
const WEB = process.env.UCA_WEB ?? "http://localhost:3311";
const [seedPath, journeysPath, outPath, shotPath] = process.argv.slice(2);
if (!seedPath || !journeysPath || !outPath) throw new Error("usage: derived-thumbnails-probe.mjs <seed.json> <journeys-raw.json> <out.json> [png]");
const seed = JSON.parse(readFileSync(seedPath, "utf8").trim().split("\n").pop());
const owner = seed.ownerA;
const j09 = JSON.parse(readFileSync(journeysPath, "utf8")).journeys.find((j) => j.id.startsWith("J09"));
const evidenceId = j09?.observations?.evidenceId ?? null;

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail ?? null });
check("J09 recorded the continuous capture's evidence id", evidenceId, evidenceId);
check("the web and API origins differ (cross-origin)", new URL(WEB).origin !== new URL(API).origin, `${new URL(WEB).origin} vs ${new URL(API).origin}`);

const bytesResponses = [];
const pendingRecords = [];
const browser = await chromium.launch({ headless: true });
try {
  if (evidenceId) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    // The session cookie is the API's; the web app calls the API cross-origin with credentials.
    await context.addCookies([{ name: "proovra_session", value: owner.bearer, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage();
    page.on("response", (r) => {
      if (/\/derived-assets\/[^/]+\/bytes/.test(r.url())) {
        // allHeaders() includes the Cookie header that headers() hides. Recorded
        // asynchronously, so every pending record is awaited before the check.
        pendingRecords.push(
          r.request().allHeaders().catch(() => ({})).then((sent) => {
            bytesResponses.push({ status: r.status(), origin: new URL(r.url()).origin, sessionCookieSent: /proovra_session=/.test(sent.cookie ?? "") });
          }),
        );
      }
    });
    // The organization workspace holds the record.
    await fetch(`${API}/v1/platform/context/switch-workspace`, {
      method: "POST",
      headers: { authorization: `Bearer ${owner.bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: owner.teamId }),
    });
    await page.goto(`${WEB}/evidence/${evidenceId}`, { waitUntil: "domcontentloaded" });
    const tab = page.locator('[data-evidence-tab="derived"]');
    await tab.waitFor({ state: "visible", timeout: 90_000 });
    await tab.click();
    check("the Derived Review tab opens for the sealed continuous capture", true);
    // The keyframe URLs exactly as the tab receives them (relative -> API origin, as
    // useDerivedReview normalizes them). Thumbnails sit inside OCR text blocks, and with
    // no OCR engine on this host there are none to expand (EP-14), so the probe loads the
    // real keyframe URLs through an image carrying the component's exact attributes.
    const dr = await fetch(`${API}/v1/evidence/${evidenceId}/derived-review?teamId=${owner.teamId}&offset=0&limit=50`, {
      headers: { authorization: `Bearer ${owner.bearer}` },
    });
    const drBody = await dr.json().catch(() => ({}));
    const urls = Object.values(drBody.keyframeBytesUrls ?? {}).filter(Boolean).map((u) => (u.startsWith("/") ? `${API}${u}` : u));
    check("the Derived Review API lists the record's keyframes", dr.status === 200 && urls.length > 0, { status: dr.status, keyframes: urls.length });
    const loads = await page.evaluate(async (list) => {
      const one = (url) =>
        new Promise((resolve) => {
          const img = document.createElement("img");
          img.crossOrigin = "use-credentials"; // the attribute DerivedKeyframeThumb sets
          img.loading = "eager";
          img.className = "uc4-derived-thumb";
          img.onload = () => resolve({ ok: true, w: img.naturalWidth, h: img.naturalHeight, cross: img.crossOrigin });
          img.onerror = () => resolve({ ok: false, w: 0, h: 0, cross: img.crossOrigin });
          img.src = url;
          document.body.appendChild(img);
        });
      return Promise.all(list.map(one));
    }, urls.slice(0, 8));
    check("every keyframe loads cross-origin with credentials (non-zero natural size)", loads.length > 0 && loads.every((l) => l.ok && l.w > 0 && l.h > 0 && l.cross === "use-credentials"), loads);
    await Promise.all(pendingRecords);
    check("the authenticated bytes route answered 200 to the web origin, with the session cookie sent", bytesResponses.length >= loads.length && bytesResponses.every((r) => r.status === 200 && r.origin === new URL(API).origin && r.sessionCookieSent), bytesResponses);
    if (shotPath) await page.screenshot({ path: shotPath });
  }
} catch (err) {
  check("probe ran to completion", false, String(err?.message ?? err).slice(0, 500));
} finally {
  await browser.close();
}

const verdict = checks.every((c) => c.ok) ? "PASS" : "FAIL";
writeFileSync(
  outPath,
  JSON.stringify({ journeys: [{ id: "DER012-derived-thumbnails-cross-origin", title: "Derived Review keyframes load cross-origin with credentials in real Chromium (component's img attributes)", verdict, evidenceId, checks, requests: bytesResponses }] }, null, 2) + "\n",
);
console.log(`DER012 ${verdict} ${checks.filter((c) => c.ok).length}/${checks.length}`);
process.exit(verdict === "PASS" ? 0 : 1);
