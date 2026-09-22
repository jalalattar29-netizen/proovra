/**
 * GUARD — DERIVED PRODUCT MANIFEST COVERAGE.
 *
 * Replaces `surface-parity-contract.test.mjs`, which validated a hand-authored
 * 33-row table against a 208-route Web product and could only ever check rows it
 * already contained. An omitted Web surface could not fail it. This guard runs
 * the derivation the other way round: it walks `apps/web/app` and asserts every
 * discovered route carries an evidence-backed disposition.
 *
 * It fails when:
 *   - a new Web route appears with no disposition (the invariant the old guard
 *     could not express),
 *   - the canonical Web route registry moves or changes shape,
 *   - a registry-gap citation goes stale (the quoted marker left the page),
 *   - a NATIVE_REQUIRED surface loses its Native destination.
 *
 * It reads real files and evaluates the real registry. It asserts nothing about
 * the TEXT of any implementation file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  buildManifest,
  discoverWebRoutes,
  loadRegistry,
  REGISTRY_GAP_RESOLUTIONS,
  MOBILE_ROOT,
} from "../tools/derive-product-manifest.mjs";
import { NATIVE_DESTINATIONS } from "../src/product/native-destinations.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MOBILE_ROOT, "../..");

const VALID = new Set([
  "NATIVE_REQUIRED",
  "ADMIN_ONLY",
  "ENTERPRISE_ONLY",
  "PUBLIC_INFORMATIONAL_ONLY",
]);

const manifest = await buildManifest();

test("the canonical Web route registry still loads as data", async () => {
  const { registry } = await loadRegistry();
  assert.ok(registry.length > 100, `expected a substantial registry, got ${registry.length}`);
});

test("every discovered Web route is classified — no UNRESOLVED, no UNKNOWN", () => {
  const bad = manifest.rows.filter((r) => !VALID.has(r.classification));
  assert.deepEqual(
    bad.map((r) => `${r.routePath} → ${r.classification}`),
    [],
    "routes with no evidence-backed disposition (add the gate in the web route registry, " +
      "do not classify them here)",
  );
});

test("classification is closed: discovered == classified", () => {
  const discovered = discoverWebRoutes().length;
  const classified = Object.entries(manifest.counts)
    .filter(([k]) => VALID.has(k))
    .reduce((n, [, v]) => n + v, 0);
  assert.equal(classified, discovered, `${discovered} routes discovered but ${classified} classified`);
});

test("every classification cites repository evidence", () => {
  for (const r of manifest.rows) {
    assert.ok(r.evidence && r.evidence.length > 10, `${r.routePath} has no evidence string`);
    assert.ok(
      /routeRegistry|middleware|redirect shim|registry gap|public product surface|marketing site|informational page/.test(r.evidence),
      `${r.routePath} evidence does not cite a canonical source: ${r.evidence}`,
    );
  }
});

test("every ADMIN_ONLY / ENTERPRISE_ONLY exclusion names a real gate", () => {
  for (const r of manifest.rows) {
    if (r.classification !== "ADMIN_ONLY" && r.classification !== "ENTERPRISE_ONLY") continue;
    assert.ok(
      /PLATFORM_ADMIN|ORGANIZATION_ONLY|ENTERPRISE_ONLY_ROUTE_IDS|domain = (GOVERNANCE|OPS|REVIEW_OPERATIONS)/.test(
        r.evidence,
      ),
      `${r.routePath} is excluded without naming an authorization/plan/domain gate: ${r.evidence}`,
    );
  }
});

test("registry-gap citations are still true of the files they quote", () => {
  for (const gap of REGISTRY_GAP_RESOLUTIONS) {
    const row = manifest.rows.find((r) => r.routePath === gap.routePath);
    assert.ok(row, `registry-gap row ${gap.routePath} no longer matches any discovered route`);
    const abs = resolve(REPO_ROOT, row.sourceFile);
    assert.ok(existsSync(abs), `${row.sourceFile} does not exist`);
    assert.ok(
      readFileSync(abs, "utf8").includes(gap.marker),
      `stale citation: "${gap.marker}" no longer appears in ${row.sourceFile}`,
    );
  }
});

test("every NATIVE_REQUIRED route has a declared Native destination", () => {
  const required = manifest.rows.filter((r) => r.classification === "NATIVE_REQUIRED");
  const missing = required.filter((r) => !NATIVE_DESTINATIONS[r.routePath]);
  assert.deepEqual(
    missing.map((r) => r.routePath),
    [],
    "NATIVE_REQUIRED routes with no entry in src/product/native-destinations.mjs",
  );
});

test("every declared Native destination points at a route file that exists", () => {
  for (const [webRoute, dest] of Object.entries(NATIVE_DESTINATIONS)) {
    if (dest.status === "NOT_STARTED") continue;
    assert.ok(dest.routeFile, `${webRoute} is ${dest.status} but declares no routeFile`);
    const abs = resolve(MOBILE_ROOT, "app", dest.routeFile);
    assert.ok(existsSync(abs), `${webRoute} → app/${dest.routeFile} does not exist on disk`);
  }
});

test("no declared Native destination maps to a route the manifest excludes", () => {
  const excluded = new Set(
    manifest.rows.filter((r) => r.classification !== "NATIVE_REQUIRED").map((r) => r.routePath),
  );
  const wrong = Object.keys(NATIVE_DESTINATIONS).filter((p) => excluded.has(p));
  assert.deepEqual(wrong, [], "Native destinations declared for ADMIN/ENTERPRISE/marketing surfaces");
});
