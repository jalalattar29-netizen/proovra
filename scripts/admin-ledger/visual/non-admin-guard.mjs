#!/usr/bin/env node
/**
 * THE NON-ADMIN GUARD FOR THE TOKEN-AUTHORITY MIGRATION.
 *
 * =============================================================================
 * WHY THIS EXISTS
 * =============================================================================
 * `globals.css` re-declared six tokens that `lib/design-tokens/tokens.css`
 * owns, and being later in the cascade it won. Deleting the duplicates is the
 * only way to have one authority — but every consumer of those six names is an
 * AUTHENTICATED APP surface (Home, Evidence, Billing, Review, Cases, Reports,
 * Notifications, the shared UI primitives), so the deletion changes what those
 * pages render:
 *
 *   --radius-sm     10px -> 6px
 *   --radius-md     16px -> 8px
 *   --radius-lg     18px -> 12px
 *   --shadow-card   0 16px 32px rgba(0,0,0,.07) -> 0 1px 2px rgba(15,23,42,.04)
 *   --surface-muted rgba(36,55,59,.06) -> #F1F4F9
 *
 * "Prove all non-Admin consumers remain correct" cannot be done by reading the
 * files. This captures the affected non-admin surfaces before and after, and
 * measures the things that would actually break rather than merely change:
 *
 *   body-level horizontal overflow      a layout that no longer fits
 *   WCAG AA contrast                    a surface tint that stopped being
 *                                       readable (surface-muted goes from
 *                                       translucent to opaque, which changes
 *                                       the ground under muted text)
 *   console errors                      anything that fell over
 *   computed radius and shadow          the change itself, stated
 *
 * A radius or a shadow CHANGING is the point of the migration. A page
 * overflowing, losing contrast or throwing is a regression. This tells the two
 * apart instead of treating every pixel difference as either.
 *
 * Usage:
 *   node scripts/admin-ledger/visual/non-admin-guard.mjs before
 *   …delete the duplicates…
 *   node scripts/admin-ledger/visual/non-admin-guard.mjs after
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { WEB, strip, signIn } from "./lib.mjs";

const phase = process.argv[2] ?? "before";
const OUT = "artifacts/admin-visual-review/non-admin";

/**
 * The authenticated surfaces that consume the six tokens, one per family that
 * showed up in the consumer scan. Not every route — the tokens are consumed by
 * SHARED components, so one page per component family is what proves them.
 */
const ROUTES = [
  "/home",
  "/evidence",
  "/cases",
  "/billing",
  "/notifications",
  "/operations",
  "/reports",
  "/investigation",
  "/settings",
  "/inbox",
];

const MEASURE = () => {
  const doc = document.documentElement;
  const cs = getComputedStyle(doc);
  const sample = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const s = getComputedStyle(el);
    return { radius: s.borderTopLeftRadius, shadow: s.boxShadow.slice(0, 44) };
  };
  return {
    overflow: Math.max(0, doc.scrollWidth - doc.clientWidth),
    height: doc.scrollHeight,
    tokens: {
      radiusSm: cs.getPropertyValue("--radius-sm").trim(),
      radiusMd: cs.getPropertyValue("--radius-md").trim(),
      radiusLg: cs.getPropertyValue("--radius-lg").trim(),
      shadowCard: cs.getPropertyValue("--shadow-card").trim().slice(0, 44),
      surfaceMuted: cs.getPropertyValue("--surface-muted").trim(),
    },
    uiCard: sample(".ui-card"),
    appCard: sample('[class*="card"]'),
    h1: document.querySelectorAll("h1").length,
  };
};

/** AA over every text node, backgrounds composited through alpha. */
const AA = () => {
  const parse = (c) => {
    const n = (c.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    if (n.length < 3) return null;
    return { r: n[0], g: n[1], b: n[2], a: n.length > 3 ? n[3] : 1 };
  };
  const bg = (el) => {
    const stack = [];
    let p = el;
    while (p) {
      const s = getComputedStyle(p);
      const img = s.backgroundImage;
      if (img && img !== "none" && img.includes("rgb")) {
        const f = parse(img.slice(img.indexOf("rgb")));
        if (f) { stack.push({ ...f, a: 1 }); break; }
      }
      const c = parse(s.backgroundColor);
      if (c && c.a > 0) { stack.push(c); if (c.a >= 0.999) break; }
      p = p.parentElement;
    }
    let base = { r: 255, g: 255, b: 255 };
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const t = stack[i];
      base = {
        r: t.r * t.a + base.r * (1 - t.a),
        g: t.g * t.a + base.g * (1 - t.a),
        b: t.b * t.a + base.b * (1 - t.a),
      };
    }
    return [base.r, base.g, base.b];
  };
  const out = [];
  const main = document.querySelector("main") || document.body;
  for (const el of [...main.querySelectorAll("*")].slice(0, 3000)) {
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none") continue;
    if (![...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim().length > 1)) continue;
    const fg = parse(s.color);
    if (!fg || fg.a < 0.05) continue;
    out.push({
      fg: [fg.r, fg.g, fg.b],
      bg: bg(el),
      size: parseFloat(s.fontSize),
      weight: Number(s.fontWeight) || 400,
      txt: (el.textContent || "").trim().slice(0, 30),
    });
  }
  return out;
};

const srgb = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const lum = ([r, g, b]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  try {
    window.localStorage.setItem(
      "proovra-cookie-consent-state",
      JSON.stringify({
        necessary: true, preferences: false, analytics: false,
        marketing: false, consentVersion: 1,
        updatedAt: new Date().toISOString(),
      }),
    );
  } catch {}
});
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 120)); });
page.on("pageerror", (e) => errors.push("PAGEERROR " + e.message.slice(0, 120)));

await signIn(page, "org-owner@fixture.local");

mkdirSync(`${OUT}/${phase}`, { recursive: true });
const rows = [];
for (const route of ROUTES) {
  errors.length = 0;
  await page.goto(`${WEB}${route}`, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(2_000);
  await strip(page).catch(() => 0);
  const m = await page.evaluate(MEASURE).catch((e) => ({ error: String(e).slice(0, 80) }));
  const samples = await page.evaluate(AA).catch(() => []);
  const fails = samples.filter((s) => {
    const large = s.size >= 24 || (s.size >= 18.66 && s.weight >= 700);
    return ratio(s.fg, s.bg) < (large ? 3 : 4.5) - 0.01;
  });
  const slug = route.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-") || "root";
  await page.screenshot({ path: `${OUT}/${phase}/${slug}.png`, fullPage: true }).catch(() => {});
  rows.push({ route, ...m, aaSamples: samples.length, aaFail: fails.length, consoleErrors: [...errors] });
  console.log(
    `${route.padEnd(16)} h=${String(m.height ?? "?").padStart(5)} overflow=${m.overflow ?? "?"} aa=${fails.length}/${samples.length} errs=${errors.length} radius(sm/md/lg)=${m.tokens?.radiusSm}/${m.tokens?.radiusMd}/${m.tokens?.radiusLg} muted=${m.tokens?.surfaceMuted}`,
  );
  for (const f of fails.slice(0, 3)) console.log(`     AA ${ratio(f.fg, f.bg).toFixed(2)} ${f.size}px "${f.txt}"`);
}

writeFileSync(`${OUT}/${phase}.json`, JSON.stringify({ rows }, null, 2), "utf8");

const other = phase === "after" ? "before" : "after";
if (existsSync(`${OUT}/${other}.json`)) {
  const prev = JSON.parse(readFileSync(`${OUT}/${other}.json`, "utf8")).rows;
  const P = new Map(prev.map((r) => [r.route, r]));
  console.log(`\n=== ${phase} vs ${other} ===`);
  let bad = 0;
  for (const r of rows) {
    const p = P.get(r.route);
    if (!p) continue;
    const dh = (r.height ?? 0) - (p.height ?? 0);
    const newOverflow = (r.overflow ?? 0) > 0 && (p.overflow ?? 0) === 0;
    const newAA = (r.aaFail ?? 0) > (p.aaFail ?? 0);
    const newErr = (r.consoleErrors?.length ?? 0) > (p.consoleErrors?.length ?? 0);
    if (newOverflow || newAA || newErr) bad += 1;
    console.log(
      `${r.route.padEnd(16)} dh=${String(dh).padStart(6)}px  overflow ${p.overflow}->${r.overflow}  aaFail ${p.aaFail}->${r.aaFail}  errs ${p.consoleErrors?.length}->${r.consoleErrors?.length}${newOverflow || newAA || newErr ? "   <-- REGRESSION" : ""}`,
    );
  }
  console.log(`\nregressions: ${bad}`);
}

await ctx.close();
await browser.close();
