/**
 * F-21 (Free-user audit) — every top-level route under app/(app) is an app-host
 * path in middleware.ts. On 2c84cad83 thirteen were missing (/people,
 * /collaboration-teams, /trust-center, ...), so on a split deployment the
 * marketing host served those signed-in pages instead of redirecting them to
 * the app host.
 */
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const middleware = readFileSync(resolve(WEB, "middleware.ts"), "utf8");
const block = middleware.match(/const APP_PREFIXES = \[([\s\S]*?)\];/);

test("APP_PREFIXES covers every top-level (app) route segment", () => {
  assert.ok(block, "APP_PREFIXES literal not found");
  const prefixes = new Set([...block![1].matchAll(/"(\/[^"]+)"/g)].map((m) => m[1]));
  const segments = readdirSync(resolve(WEB, "app", "(app)"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith("(") && !d.name.startsWith("["))
    .map((d) => `/${d.name}`);
  const missing = segments.filter((s) => !prefixes.has(s));
  assert.deepEqual(missing, [], `app-tree segments missing from APP_PREFIXES: ${missing.join(", ")}`);
});
