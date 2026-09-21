/**
 * GUARD — PROTECTED NATIVE CAPTURE ENGINE.
 *
 * Asserts every file in the protection register still exists, so UI/product
 * work cannot delete or rename a proven native capture source as collateral.
 *
 * Previously this regex-extracted the path list out of the source text of
 * `native-surface-contract.ts`. It now imports the register as real data, so a
 * malformed register fails at import rather than silently matching nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

import { PROTECTED_NATIVE_PATHS } from "../src/product/protected-native-paths.mjs";

const MOBILE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("the protection register is substantial and free of duplicates", () => {
  assert.ok(PROTECTED_NATIVE_PATHS.length >= 16, `register shrank to ${PROTECTED_NATIVE_PATHS.length} entries`);
  assert.equal(new Set(PROTECTED_NATIVE_PATHS).size, PROTECTED_NATIVE_PATHS.length, "duplicate entries");
});

test("every protected native capture source still exists on disk", () => {
  const missing = PROTECTED_NATIVE_PATHS.filter((p) => !existsSync(join(MOBILE_ROOT, p)));
  assert.deepEqual(missing, [], "protected native capture sources deleted or renamed");
});

test("the register covers both platforms and the JS boundary", () => {
  const joined = PROTECTED_NATIVE_PATHS.join("\n");
  assert.match(joined, /ios\/ProovraScreenCaptureModule\.swift/, "iOS ReplayKit module unprotected");
  assert.match(joined, /android\/src\/main\/java.*ProovraScreenCaptureModule\.kt/, "Android engine unprotected");
  assert.match(joined, /modules\/proovra-screen-capture\/index\.ts/, "JS boundary unprotected");
  assert.match(joined, /plugins\/broadcast-extension\/SampleHandler\.swift/, "Broadcast Extension unprotected");
});
