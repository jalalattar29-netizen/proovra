/**
 * GUARD — NATIVE ROUTE REACHABILITY (derived from the real navigation graph).
 *
 * Replaces the reachability half of `native-surface-contract.test.mjs`, which
 * compared the route tree against a hand-declared `reachability` field. A
 * screen could be declared REACHABLE while nothing navigated to it, and the
 * guard would agree. This one DERIVES reachability: it scans every native
 * source file for the navigation targets actually present (nav items,
 * `router.push` / `router.replace` / `<Link href>`, and expo-router `<Redirect>`)
 * and proves each route file is either a layout, the boot gate, or the target of
 * a real navigation.
 *
 * The product-classification tests that used to live here are gone: deciding
 * which surfaces exist is the derived manifest's job, not a native table's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, relative } from "node:path";

const MOBILE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = join(MOBILE_ROOT, "app");
const SRC_DIR = join(MOBILE_ROOT, "src");

/** Every route file under app/, POSIX-relative to app/. */
function walkRoutes(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      out.push(...walkRoutes(full));
      continue;
    }
    if (!/\.(t|j)sx?$/.test(entry.name) || entry.name.endsWith(".d.ts")) continue;
    out.push(relative(APP_DIR, full).split("\\").join("/"));
  }
  return out;
}

/** Every source file that could contain a navigation target. */
function walkSources(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      out.push(...walkSources(full));
      continue;
    }
    if (/\.(t|j)sx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** Route file → the expo-router URL path it serves. */
function routeFileToPath(routeFile) {
  const noExt = routeFile.replace(/\.(t|j)sx?$/, "");
  const segs = noExt
    .split("/")
    .filter((s) => !(s.startsWith("(") && s.endsWith(")")));
  const last = segs[segs.length - 1];
  if (last === "index") segs.pop();
  return "/" + segs.join("/");
}

/**
 * Collapse `[id]` / template holes AND strip expo-router groups so a pushed
 * target matches its route file. Navigation code addresses screens both ways —
 * `router.push("/capture")` and the deep-link resolver's `"/(stack)/case/c-9"` —
 * and both are the same destination.
 */
function shape(path) {
  const segs = path
    .split("/")
    .filter((s) => s.length > 0 && !(s.startsWith("(") && s.endsWith(")")))
    .map((s) => s.replace(/\[[^\]]+\]/g, "*").replace(/\$\{[^}]*\}/g, "*"));
  // A concrete id in a pushed URL (`/case/c-9`) addresses a dynamic route.
  return "/" + segs.join("/");
}

const diskRoutes = walkRoutes(APP_DIR);
const sources = [...walkSources(APP_DIR), ...walkSources(SRC_DIR)];
const allText = sources.map((f) => readFileSync(f, "utf8")).join("\n");

/** Navigation targets actually present in the code. */
const navTargets = new Set();
for (const re of [
  /router\.(?:push|replace|navigate)\(\s*[`"']([^`"']+)[`"']/g,
  /router\.(?:push|replace|navigate)\(\s*\{\s*pathname:\s*[`"']([^`"']+)[`"']/g,
  /href:\s*[`"']([^`"']+)[`"']/g,
  /<Link\s[^>]*href=[{]?[`"']([^`"']+)[`"']/g,
  /<Redirect\s[^>]*href=[{]?[`"']([^`"']+)[`"']/g,
  // Route tables build their destinations as bare string/template literals
  // (e.g. `/(stack)/verify-email?token=${t}` in the deep-link families), so a
  // scan limited to call sites would call those screens unreachable. Any
  // literal that names a route group is a navigation target.
  /[`"'](\/\((?:stack|tabs)\)\/[^`"'\s]*)[`"']/g,
]) {
  for (const m of allText.matchAll(re)) {
    if (m[1].startsWith("/")) navTargets.add(shape(m[1].split("?")[0]));
  }
}

const isLayout = (f) => /(^|\/)_layout\.(t|j)sx?$/.test(f);
const isBootGate = (f) => f === "index.tsx" || f === "index.jsx";

test("guard the guard: the route tree and navigation graph both parsed", () => {
  assert.ok(diskRoutes.length >= 15, `expected >=15 route files, found ${diskRoutes.length}`);
  assert.ok(navTargets.size >= 10, `expected >=10 navigation targets, found ${navTargets.size}`);
});

test("every native route file is reachable by real navigation", () => {
  const unreachable = [];
  for (const f of diskRoutes) {
    if (isLayout(f) || isBootGate(f)) continue;
    const target = shape(routeFileToPath(f));
    const reachable =
      navTargets.has(target) ||
      // A dynamic route is reachable when anything pushes its shape.
      [...navTargets].some((t) => t === target || t.startsWith(target + "/"));
    if (!reachable) unreachable.push(`${f} (serves ${target})`);
  }
  assert.deepEqual(
    unreachable,
    [],
    "route files nothing navigates to — link them or delete them; an orphan screen is dead product",
  );
});

test("no parallel or legacy route tree exists", () => {
  const parallel = diskRoutes.filter((f) => /(^|\/|-)(v2|new|legacy|copy|old)(-|\/|\.)/i.test(f));
  assert.deepEqual(parallel, [], `parallel/duplicate route tree detected: ${parallel.join(", ")}`);
});

test("the superseded hand-authored surface contract is gone", () => {
  assert.equal(
    existsSync(join(MOBILE_ROOT, "src/product/native-surface-contract.ts")),
    false,
    "native-surface-contract.ts is superseded by the derived manifest and must not return",
  );
});
