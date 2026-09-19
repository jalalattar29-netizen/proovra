/**
 * PERMANENT GUARD F (Native Convergence, Phase 0) — surface reachability contract.
 *
 * Enforces Law of One layer L1: the canonical NATIVE_SURFACES list in
 * src/product/native-surface-contract.ts and the on-disk expo-router tree under
 * app/ agree exactly. This makes "no accidental orphan may ship" a build
 * invariant: adding a route file without classifying it here fails; a declared
 * route that no longer exists fails; a NATIVE-CORE surface may never be orphaned;
 * and no parallel `-v2`/`new-`/`legacy-` route tree may appear.
 *
 * Reads the contract as text (it imports nothing, but the guard stays uniform
 * with GUARD D/E and needs no build) and walks the filesystem. No device.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, relative } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "../app");
const CONTRACT = resolve(HERE, "../src/product/native-surface-contract.ts");
const contractSrc = readFileSync(CONTRACT, "utf8");

const ALLOWED_CLASSIFICATIONS = new Set([
  "NATIVE-CORE",
  "NATIVE-OPTIONAL",
  "PLATFORM-SPECIFIC",
  "WEB-ONLY-INTENTIONAL",
  "ORPHANED",
  "LEGACY",
  "PRODUCT-DECISION-REQUIRED",
]);
// Classes for which being unreachable-from-nav is an intentional, allowed state.
// NATIVE-OPTIONAL is included because an optional surface may legitimately be a
// deep-link-only target (e.g. public verification) rather than a nav destination.
// NATIVE-CORE and PLATFORM-SPECIFIC must NOT be orphaned — that is the accident
// this guard catches.
const MAY_BE_ORPHANED = new Set([
  "NATIVE-OPTIONAL",
  "WEB-ONLY-INTENTIONAL",
  "ORPHANED",
  "LEGACY",
  "PRODUCT-DECISION-REQUIRED",
]);

/** Parse the contract's route entries as {routeFile, classification, reachability}. */
function parseSurfaces(src) {
  const entries = [];
  const objectRe = /\{[^{}]*routeFile:\s*"([^"]+)"[^{}]*classification:\s*"([^"]+)"[^{}]*reachability:\s*"([^"]+)"[^{}]*\}/g;
  let m;
  while ((m = objectRe.exec(src)) !== null) {
    entries.push({ routeFile: m[1], classification: m[2], reachability: m[3] });
  }
  return entries;
}

/** Every routable file under app/ (POSIX-relative to app/). */
function walkRoutes(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      out.push(...walkRoutes(full));
      continue;
    }
    if (!/\.(t|j)sx?$/.test(entry.name)) continue;
    if (entry.name.endsWith(".d.ts")) continue;
    out.push(relative(APP_DIR, full).split("\\").join("/"));
  }
  return out;
}

const surfaces = parseSurfaces(contractSrc);
const diskRoutes = walkRoutes(APP_DIR);
const declaredFiles = new Set(surfaces.map((s) => s.routeFile));

test("the contract parses and covers a plausible surface set (guard the guard)", () => {
  assert.ok(surfaces.length >= 15, `expected >=15 declared surfaces, found ${surfaces.length}`);
  assert.ok(diskRoutes.length >= 15, `expected >=15 route files on disk, found ${diskRoutes.length}`);
});

test("every route file on disk is classified in the contract (no unclassified surface)", () => {
  const missing = diskRoutes.filter((f) => !declaredFiles.has(f));
  assert.deepEqual(missing, [], `route files present on disk but not in NATIVE_SURFACES: ${missing.join(", ")}`);
});

test("every contract surface points at a real file (no stale entry)", () => {
  const stale = surfaces
    .map((s) => s.routeFile)
    .filter((f) => !existsSync(join(APP_DIR, f)));
  assert.deepEqual(stale, [], `NATIVE_SURFACES entries with no file on disk: ${stale.join(", ")}`);
});

test("classifications are drawn from the allowed enum", () => {
  const bad = surfaces.filter((s) => !ALLOWED_CLASSIFICATIONS.has(s.classification));
  assert.deepEqual(bad.map((s) => `${s.routeFile}:${s.classification}`), [], "unknown classification value");
});

test("no NATIVE-CORE / NATIVE-OPTIONAL / PLATFORM-SPECIFIC surface is silently orphaned", () => {
  const accidental = surfaces.filter(
    (s) => s.reachability === "ORPHANED" && !MAY_BE_ORPHANED.has(s.classification),
  );
  assert.deepEqual(
    accidental.map((s) => s.routeFile),
    [],
    "a core/platform surface is ORPHANED — either link it or reclassify with a product decision",
  );
});

test("Law of One: no parallel -v2 / new- / legacy- route tree exists", () => {
  const parallel = diskRoutes.filter((f) => /(^|\/|-)(v2|new|legacy|copy|old)(-|\/|\.)/i.test(f));
  assert.deepEqual(parallel, [], `parallel/duplicate route tree detected: ${parallel.join(", ")}`);
});

test("the §4 product decisions are encoded in the contract (not only prose)", () => {
  for (const id of [
    "push-notifications",
    "reports",
    "archive-trash-locked",
    "locales",
    "device-attestation",
    "workspace-scope",
  ]) {
    assert.match(contractSrc, new RegExp(`id:\\s*"${id}"`), `PRODUCT_DECISIONS must record "${id}"`);
  }
});
