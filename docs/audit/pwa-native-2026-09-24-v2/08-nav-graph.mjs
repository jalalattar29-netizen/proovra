/**
 * V3 INSTRUMENT — the native NAVIGATION graph, and the per-web-route native
 * COUNTERPART SET (read-only).
 *
 * WHY THIS EXISTS — a defect in the first v3 comparator pass.
 *
 * The web renders `/settings` as ONE page carrying profile, security, privacy,
 * AI, notifications and reviewer criteria. Native splits the same product
 * surface across SIX screens joined by `router.push`. Comparing web `/settings`
 * against only `app/(tabs)/settings.tsx` therefore reported the entire
 * identity-security family as missing — when `app/(stack)/settings/security.tsx`
 * implements it (and `src/product/account-security.ts` documents all five
 * sections and their endpoints).
 *
 * So the native counterpart of a web route is not one file. It is:
 *
 *     {entry screen} ∪ {screens it navigates to that are NOT themselves the
 *                       declared native entry of another applicable web route}
 *
 * The exclusion is what stops `/settings` from absorbing `/billing` and
 * double-counting it. Nav edges are followed to a bounded depth; every folded-in
 * screen is recorded by name so the widening is auditable, never implicit.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "D:/digital-witness";
const OUT = `${ROOT}/docs/audit/pwa-native-2026-09-24-v2`;
const APP = `${ROOT}/apps/mobile/app`;

/** Every expo-router screen file -> its route path(s). */
export function screenIndex() {
  const files = [];
  (function w(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name).split("\\").join("/");
      if (e.isDirectory()) w(f);
      else if (/\.tsx$/.test(e.name)) files.push(f);
    }
  })(APP);

  const byRoute = new Map();   // "/settings/security" -> abs file
  for (const f of files) {
    const relp = f.replace(APP, "").split("\\").join("/");
    if (/_layout\.tsx$/.test(relp)) continue;
    // strip group segments (stack)/(tabs), strip /index, strip .tsx
    let r = relp.replace(/\.tsx$/, "").replace(/\/\([^)]+\)/g, "").replace(/^\/index$/, "/").replace(/\/index$/, "");
    if (r === "") r = "/";
    byRoute.set(r, f);
  }
  return byRoute;
}

/** router.push/replace targets declared in one file. */
export function navEdges(file) {
  const src = readFileSync(file, "utf8");
  const out = new Set();
  for (const m of src.matchAll(/router\.(?:push|replace)\(\s*[`"']([^`"'${]+)/g)) {
    let t = m[1].replace(/\/\([^)]+\)/g, "").replace(/\?.*$/, "").replace(/\/$/, "");
    if (t.startsWith("/")) out.add(t || "/");
  }
  // <Link href="..."> style
  for (const m of src.matchAll(/href=\{?\s*[`"']([^`"'${]+)/g)) {
    let t = m[1].replace(/\/\([^)]+\)/g, "").replace(/\?.*$/, "").replace(/\/$/, "");
    if (t.startsWith("/")) out.add(t || "/");
  }
  return [...out];
}

/**
 * Counterpart set for one web route.
 * @param entryFile abs path of the declared native entry
 * @param claimedByOthers Set of native entry files that belong to OTHER applicable web routes
 */
export function counterpartSet(entryFile, byRoute, claimedByOthers, maxHops = 2) {
  const chosen = new Map([[entryFile, 0]]);
  let frontier = [[entryFile, 0]];
  while (frontier.length) {
    const next = [];
    for (const [f, hop] of frontier) {
      if (hop >= maxHops) continue;
      for (const t of navEdges(f)) {
        const target = byRoute.get(t);
        if (!target || chosen.has(target)) continue;
        if (claimedByOthers.has(target)) continue;      // belongs to another audited route
        chosen.set(target, hop + 1);
        next.push([target, hop + 1]);
      }
    }
    frontier = next;
  }
  return [...chosen.entries()].map(([f, hop]) => ({ file: f, hop }));
}

/* ======================================================================= main */
if (process.argv[1] && process.argv[1].endsWith("08-nav-graph.mjs")) {
  const byRoute = screenIndex();
  const { rows } = JSON.parse(readFileSync(`${OUT}/routes.json`, "utf8"));
  const entries = new Map();
  for (const r of rows) if (r.nativeEntry) entries.set(r.route, `${ROOT}/${r.nativeEntry}`);

  const out = {};
  let widened = 0;
  for (const r of rows) {
    if (!r.nativeEntry) { out[r.route] = { entry: null, set: [] }; continue; }
    const me = `${ROOT}/${r.nativeEntry}`;
    const claimed = new Set([...entries.entries()].filter(([rt]) => rt !== r.route).map(([, f]) => f));
    const set = counterpartSet(me, byRoute, claimed);
    if (set.length > 1) widened++;
    out[r.route] = {
      entry: r.nativeEntry,
      set: set.map((s) => ({ file: s.file.replace(ROOT + "/", "").split("\\").join("/"), hop: s.hop })),
    };
  }
  writeFileSync(`${OUT}/native-counterparts.json`, JSON.stringify({ frozenSha: "71e148f34410c7c231f8930d1387d8924b10b4e5", counterparts: out }, null, 1));
  console.log("native screens indexed:", byRoute.size);
  console.log("web routes whose native counterpart is MORE than one screen:", widened);
  for (const [rt, v] of Object.entries(out)) {
    if (v.set.length > 1) console.log(`  ${rt.padEnd(34)} ${v.set.length} screens: ${v.set.map((s) => s.file.replace("apps/mobile/app/", "")).join(", ")}`);
  }
  console.log("wrote native-counterparts.json");
}
