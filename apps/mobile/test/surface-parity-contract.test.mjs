/**
 * PERMANENT GUARD N6 — Web↔Native product parity contract.
 *
 * Grounds WEB_SURFACE_PARITY on BOTH sides so it is not two hand-written lists:
 *  - every webRoute is a real directory under apps/web/app (stale web ref → fail);
 *  - every non-web-only nativeRouteFile is a real NATIVE_SURFACES entry, and those
 *    are disk-verified by GUARD F (removed native route → fail);
 *  - every WEB-ONLY-INTENTIONAL entry has a rationale and no native route;
 *  - every MATCHED/ADAPTED entry has a native route;
 *  - no duplicate webRoute (duplicate canonical owner);
 *  - every REQUIRED_NATIVE_ROUTE_FILES surface is present and mapped (no hole).
 * Contract as text + filesystem walk; no device, no compile.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT = resolve(HERE, "../src/product/native-surface-contract.ts");
const WEB_APP_DIR = resolve(HERE, "../../web/app");

// Transpile-and-import the contract to read its arrays as real data.
const src = readFileSync(CONTRACT, "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { WEB_SURFACE_PARITY, REQUIRED_NATIVE_ROUTE_FILES, NATIVE_SURFACES } = await import(
  `data:text/javascript,${encodeURIComponent(js)}`
);

const nativeRouteFiles = new Set(NATIVE_SURFACES.map((s) => s.routeFile));

test("the parity table is substantial", () => {
  assert.ok(WEB_SURFACE_PARITY.length >= 20, `expected >=20 parity rows, got ${WEB_SURFACE_PARITY.length}`);
});

test("every webRoute exists on disk under apps/web/app (no stale web reference)", () => {
  const missing = WEB_SURFACE_PARITY.filter((e) => !existsSync(join(WEB_APP_DIR, e.webRoute)));
  assert.deepEqual(missing.map((e) => e.webRoute), [], "webRoute directories not found on disk");
});

test("no duplicate webRoute (one canonical parity owner per web surface)", () => {
  const seen = new Set();
  const dupes = [];
  for (const e of WEB_SURFACE_PARITY) {
    if (seen.has(e.webRoute)) dupes.push(e.webRoute);
    seen.add(e.webRoute);
  }
  assert.deepEqual(dupes, [], "duplicate webRoute entries");
});

test("MATCHED/ADAPTED map to a real native route; WEB-ONLY has a reason and no native route", () => {
  for (const e of WEB_SURFACE_PARITY) {
    if (e.parity === "WEB-ONLY-INTENTIONAL") {
      assert.equal(e.nativeRouteFile, null, `${e.webRoute} web-only must have no native route`);
      assert.ok(e.reason && e.reason.length > 0, `${e.webRoute} web-only must have a rationale`);
    } else {
      assert.ok(e.nativeRouteFile, `${e.webRoute} (${e.parity}) must have a native route`);
      assert.ok(
        nativeRouteFiles.has(e.nativeRouteFile),
        `${e.webRoute} → ${e.nativeRouteFile} is not a NATIVE_SURFACES entry (required native route removed?)`,
      );
    }
  }
});

test("every required native surface is present and mapped by an applicable parity row", () => {
  const mappedNative = new Set(
    WEB_SURFACE_PARITY.filter((e) => e.parity !== "WEB-ONLY-INTENTIONAL").map((e) => e.nativeRouteFile),
  );
  for (const rf of REQUIRED_NATIVE_ROUTE_FILES) {
    assert.ok(nativeRouteFiles.has(rf), `required native surface ${rf} missing from NATIVE_SURFACES`);
    assert.ok(mappedNative.has(rf), `required native surface ${rf} not mapped by any MATCHED/ADAPTED parity row`);
  }
});
