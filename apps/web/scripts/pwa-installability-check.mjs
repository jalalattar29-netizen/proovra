#!/usr/bin/env node
/**
 * PWA installability check (UC-LCH-004 / owner mandate B).
 *
 * Starts the PRODUCTION web server (`next start`, after `next build`) bound to
 * 127.0.0.1 with NEXT_PUBLIC_API_BASE=http://127.0.0.1:9 (a dead loopback port
 * — never the production API), opens it in Playwright Chromium, and asks
 * Chromium itself (CDP Page.getInstallabilityErrors) whether the app is
 * installable. Also asserts the service worker registered and controls the
 * page, and that its caches hold nothing under /v1. Every wait is bounded and
 * the server is always torn down.
 *
 *   node apps/web/scripts/pwa-installability-check.mjs [--port=3417]
 *
 * Requires a prior `next build` of apps/web with the same NEXT_PUBLIC_API_BASE.
 * Exit 0 only when Chromium reports zero installability errors.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const port = Number(process.argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? 3417);
const ORIGIN = `http://127.0.0.1:${port}`;

// @playwright/test is a ROOT dev dependency (not a web one).
const { chromium } = require(require.resolve("@playwright/test", { paths: [resolve(WEB, "..", "..")] }));

const env = {
  ...process.env,
  NODE_ENV: "production",
  NEXT_PUBLIC_API_BASE: "http://127.0.0.1:9",
  PORT: String(port),
};
const nextBin = require.resolve("next/dist/bin/next", { paths: [WEB] });
const server = spawn(process.execPath, [nextBin, "start", "-H", "127.0.0.1", "-p", String(port)], {
  cwd: WEB,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

const result = { origin: ORIGIN, installabilityErrors: null, swControlled: false, cacheKeys: [], cachedApiEntries: [], manifestUrl: null };
let browser;
let exitCode = 1;
try {
  let up = false;
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`${ORIGIN}/manifest.webmanifest`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        up = true;
        break;
      }
    } catch {
      /* not yet */
    }
    await sleep(1000);
  }
  if (!up) throw new Error("next start did not serve within 90s");

  browser = await chromium.launch({ headless: true, timeout: 60_000 });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await page.goto(`${ORIGIN}/`, { waitUntil: "load", timeout: 60_000 });
  // Wait (bounded) for the service worker to activate and claim the page.
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30_000 }).catch(() => {});
  await page.reload({ waitUntil: "load", timeout: 60_000 });
  result.swControlled = await page.evaluate(() => navigator.serviceWorker?.controller != null);

  const cdp = await context.newCDPSession(page);
  const manifest = await cdp.send("Page.getAppManifest");
  result.manifestUrl = manifest.url ?? null;
  const inst = await cdp.send("Page.getInstallabilityErrors");
  result.installabilityErrors = inst.installabilityErrors ?? [];

  const caches = await page.evaluate(async () => {
    const keys = await caches.keys();
    const api = [];
    for (const k of keys) {
      const c = await caches.open(k);
      for (const req of await c.keys()) {
        const u = new URL(req.url);
        if (u.pathname.startsWith("/v1") || u.origin !== location.origin) api.push(req.url);
      }
    }
    return { keys, api };
  });
  result.cacheKeys = caches.keys;
  result.cachedApiEntries = caches.api;

  const ok =
    Array.isArray(result.installabilityErrors) &&
    result.installabilityErrors.length === 0 &&
    result.swControlled &&
    result.cachedApiEntries.length === 0;
  exitCode = ok ? 0 : 1;
} catch (err) {
  result.error = String(err?.message ?? err);
} finally {
  try {
    await browser?.close();
  } catch {
    /* ignore */
  }
  server.kill();
  await sleep(500);
  if (!server.killed) server.kill("SIGKILL");
}
console.log(JSON.stringify(result, null, 2));
if (exitCode !== 0) console.log(serverLog.split("\n").slice(-20).join("\n"));
process.exit(exitCode);
