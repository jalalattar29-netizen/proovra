/**
 * UC-LCH-004 / owner mandate B — PWA manifest + service-worker policy.
 *
 * Manifest: installable by Chromium criteria — 192 and 512 PNG icons whose
 * pixels match their declared size, a maskable pair, standalone display,
 * start_url inside scope.
 *
 * Service worker: the policy file the worker importScripts is loaded here in a
 * VM context and asked about real requests. Never cached: API (/v1 and the
 * API origin), presigned storage URLs, cross-origin anything, non-GET, page
 * navigations (network-only with an offline fallback). Cached: hashed build
 * assets and the static shell. Update: no unconditional skipWaiting.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(WEB, "public");

type Decision = { strategy: string };
type Policy = {
  decide: (r: { method?: string; url: string; mode?: string; origin: string }) => Decision;
  cacheable: (r: { status: number; type: string; headers: { get(n: string): string | null } }) => boolean;
  PRECACHE: string[];
};

function loadPolicy(): Policy {
  const ctx: Record<string, unknown> = { URL };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(join(PUBLIC, "sw-policy.js"), "utf8"), ctx);
  return (ctx as { ProovraSwPolicy: Policy }).ProovraSwPolicy;
}

/** PNG width/height from the IHDR chunk. */
function pngSize(file: string): { width: number; height: number } {
  const b = readFileSync(file);
  assert.equal(b.toString("ascii", 1, 4), "PNG", `${file} is not a PNG`);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

const ORIGIN = "https://app.proovra.com";
const P = loadPolicy();
const decide = (url: string, extra: Partial<{ method: string; mode: string }> = {}) =>
  P.decide({ method: "GET", mode: "no-cors", origin: ORIGIN, url, ...extra }).strategy;

test("manifest is installable: 192 + 512 PNG (any) and a maskable pair whose pixels match", () => {
  const manifest = JSON.parse(readFileSync(join(PUBLIC, "manifest.webmanifest"), "utf8"));
  assert.equal(manifest.display, "standalone");
  assert.ok(manifest.name && manifest.short_name);
  assert.ok(String(manifest.start_url).startsWith(manifest.scope ?? "/"));
  const icons = manifest.icons as Array<{ src: string; sizes: string; type: string; purpose: string }>;
  for (const [size, purpose] of [
    ["192x192", "any"],
    ["512x512", "any"],
    ["192x192", "maskable"],
    ["512x512", "maskable"],
  ]) {
    const icon = icons.find((i) => i.sizes === size && i.purpose.split(" ").includes(purpose));
    assert.ok(icon, `missing ${purpose} icon ${size}`);
    assert.equal(icon!.type, "image/png");
    const file = join(PUBLIC, icon!.src);
    assert.ok(existsSync(file), `${icon!.src} is not committed`);
    const { width, height } = pngSize(file);
    assert.equal(`${width}x${height}`, size, `${icon!.src} pixels do not match its declared size`);
  }
  assert.ok(!icons.some((i) => i.sizes === "any"), "'sizes: any' is only meaningful for SVG");
});

test("the root layout links the manifest and mounts the service-worker prompt", () => {
  const layout = readFileSync(join(WEB, "app/layout.tsx"), "utf8");
  assert.match(layout, /manifest: "\/manifest\.webmanifest"/);
  assert.match(layout, /<ServiceWorkerUpdatePrompt \/>/);
});

test("API, storage and every cross-origin request are never intercepted", () => {
  assert.equal(decide(`${ORIGIN}/v1/evidence/abc/report/latest`), "bypass");
  assert.equal(decide(`${ORIGIN}/v1`), "bypass");
  assert.equal(decide(`${ORIGIN}/api/anything`), "bypass");
  assert.equal(decide("https://api.proovra.com/v1/evidence"), "bypass");
  assert.equal(
    decide("https://bucket.s3.eu-central-1.amazonaws.com/evidence/x/parts/000-a.png?X-Amz-Signature=abc"),
    "bypass",
  );
  assert.equal(decide(`${ORIGIN}/assets/branding/logo.png?X-Amz-Signature=abc`), "bypass");
  assert.equal(decide("https://accounts.google.com/gsi/client"), "bypass");
});

test("non-GET requests are never intercepted", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(decide(`${ORIGIN}/_next/static/chunks/main.js`, { method }), "bypass");
  }
});

test("navigations are network-only (authenticated pages are never cached)", () => {
  for (const path of ["/home", "/capture", "/evidence/123", "/settings", "/login", "/"]) {
    assert.equal(decide(`${ORIGIN}${path}`, { mode: "navigate" }), "navigate-network");
  }
});

test("only the static shell is cacheable", () => {
  assert.equal(decide(`${ORIGIN}/_next/static/chunks/app-123abc.js`), "cache-first");
  assert.equal(decide(`${ORIGIN}/icons/icon-192.png`), "stale-while-revalidate");
  assert.equal(decide(`${ORIGIN}/manifest.webmanifest`), "stale-while-revalidate");
  assert.equal(decide(`${ORIGIN}/offline.html`), "stale-while-revalidate");
  // Not shell → untouched.
  assert.equal(decide(`${ORIGIN}/_next/data/build/home.json`), "bypass");
  assert.equal(decide(`${ORIGIN}/evidence/123`), "bypass");
});

test("a response is stored only when it is a plain 200 same-origin response without no-store/private", () => {
  const h = (cc: string | null) => ({ get: (n: string) => (n.toLowerCase() === "cache-control" ? cc : null) });
  assert.equal(P.cacheable({ status: 200, type: "basic", headers: h("public, max-age=31536000, immutable") }), true);
  assert.equal(P.cacheable({ status: 200, type: "basic", headers: h("no-store") }), false);
  assert.equal(P.cacheable({ status: 200, type: "basic", headers: h("private, max-age=0") }), false);
  assert.equal(P.cacheable({ status: 200, type: "opaque", headers: h(null) }), false);
  assert.equal(P.cacheable({ status: 200, type: "cors", headers: h(null) }), false);
  assert.equal(P.cacheable({ status: 206, type: "basic", headers: h(null) }), false);
});

test("precache holds only static, content-free files", () => {
  for (const url of P.PRECACHE) {
    assert.ok(existsSync(join(PUBLIC, url)), `precached ${url} must be a committed static file`);
    assert.doesNotMatch(url, /^\/(v1|api|home|evidence|capture|settings)/);
  }
});

test("update safety: skipWaiting only on the page's message; logout clears caches", () => {
  const sw = readFileSync(join(PUBLIC, "sw.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const skips = sw.match(/skipWaiting\(\)/g) ?? [];
  assert.equal(skips.length, 1, "exactly one skipWaiting call");
  assert.match(sw, /data\.type === "SKIP_WAITING"\) \{\s*self\.skipWaiting\(\);/);
  assert.match(sw, /data\.type === "CLEAR_CACHES"/);
  assert.match(sw, /importScripts\("\/sw-policy\.js"\)/);
  const appLayout = readFileSync(join(WEB, "app/(app)/layout.tsx"), "utf8");
  assert.match(appLayout, /clearServiceWorkerCaches\(\)/);
  const client = readFileSync(join(WEB, "lib/pwa/serviceWorkerClient.ts"), "utf8");
  assert.match(client, /process\.env\.NODE_ENV === "production"/, "never registered in dev");
});

test("the offline page claims nothing the product did not do", () => {
  const html = readFileSync(join(PUBLIC, "offline.html"), "utf8");
  assert.doesNotMatch(html, /<script|onclick=/i, "CSP: no inline script on a cached page");
  assert.doesNotMatch(html, /saved offline|queued|will upload automatically/i);
});
