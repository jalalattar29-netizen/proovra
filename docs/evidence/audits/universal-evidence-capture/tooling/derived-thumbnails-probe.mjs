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
const browser = await chromium.launch({ headless: true });
try {
  if (evidenceId) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    // The session cookie is the API's; the web app calls the API cross-origin with credentials.
    await context.addCookies([{ name: "proovra_session", value: owner.bearer, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage();
    page.on("response", (r) => {
      if (/\/derived-assets\/[^/]+\/bytes/.test(r.url())) {
        bytesResponses.push({ status: r.status(), origin: new URL(r.url()).origin, credentialed: Boolean(r.request().headers().cookie) });
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
    const thumbs = page.locator("img.uc4-derived-thumb");
    await thumbs.first().waitFor({ state: "attached", timeout: 90_000 });
    await page.waitForFunction(() => [...document.querySelectorAll("img.uc4-derived-thumb")].every((i) => i.complete), null, { timeout: 60_000 });
    const sizes = await thumbs.evaluateAll((els) => els.map((i) => ({ w: i.naturalWidth, h: i.naturalHeight, cross: i.crossOrigin })));
    check("keyframe thumbnails are rendered", sizes.length > 0, sizes.length);
    check("every thumbnail loaded (non-zero natural size)", sizes.length > 0 && sizes.every((s) => s.w > 0 && s.h > 0), sizes);
    check("every thumbnail requests with credentials (crossOrigin=use-credentials)", sizes.every((s) => s.cross === "use-credentials"), sizes.map((s) => s.cross));
    check("no 'Keyframe unavailable' fallback", (await page.getByText("Keyframe unavailable").count()) === 0);
    check("the bytes were served cross-origin by the API with 200", bytesResponses.length > 0 && bytesResponses.every((r) => r.status === 200 && r.origin === new URL(API).origin), bytesResponses);
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
  JSON.stringify({ journeys: [{ id: "DER012-derived-thumbnails-cross-origin", title: "Derived Review keyframe thumbnails load cross-origin with credentials (real Chromium)", verdict, evidenceId, checks, requests: bytesResponses }] }, null, 2) + "\n",
);
console.log(`DER012 ${verdict} ${checks.filter((c) => c.ok).length}/${checks.length}`);
process.exit(verdict === "PASS" ? 0 : 1);
