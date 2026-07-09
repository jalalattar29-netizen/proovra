/**
 * Platform Control Center P1 — Evidence Operations page contract.
 *
 * Source-contract tests (node:test convention, matching
 * admin-console-ux.test.ts). They pin:
 *   - the page exists at /admin/evidence-ops,
 *   - it renders through the shared PageShell (no marketing app-hero),
 *   - it renders AdminConsoleNav (inherits the platform.admin gate),
 *   - honest null/degraded states ("Not measured" / "Not connected"),
 *   - degraded tone is used only for real problem values,
 *   - errors go through toSafeUserError,
 *   - it links to the queue console.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string =>
  readFileSync(resolve(APP_ROOT, rel), "utf8");

const PAGE = "app/(app)/admin/evidence-ops/page.tsx";

test("evidence-ops page exists and renders through the shared PageShell", () => {
  const src = read(PAGE);
  assert.match(src, /PageShell/, "must use the shared PageShell");
  assert.match(src, /PageHeader/, "must use the shared PageHeader");
  assert.match(src, /Evidence Operations/, "must carry the page title");
});

test("evidence-ops page does NOT use the marketing hero or banned classes", () => {
  const src = read(PAGE);
  assert.doesNotMatch(src, /app-hero-full|className="app-hero/, "no app-hero");
  assert.doesNotMatch(src, /cc-page/, "no cc-page class");
  assert.doesNotMatch(src, /className="btn-|"btn-/, "no btn- classes");
});

test("evidence-ops page renders AdminConsoleNav (platform.admin gate inheritance)", () => {
  assert.match(read(PAGE), /AdminConsoleNav/);
});

test("evidence-ops page renders honest null / not-connected states", () => {
  const src = read(PAGE);
  assert.match(src, /Not measured/, "must render 'Not measured' for null metrics");
  assert.match(src, /Not connected/, "must render 'Not connected' for absent queue inventory");
});

test("degraded tone is used ONLY when a real value > 0 (null stays neutral)", () => {
  const src = read(PAGE);
  // The tone selector must branch on null -> neutral before any risk tone.
  assert.match(
    src,
    /value\s*==\s*null[\s\S]*?tone:\s*"neutral"/,
    "null value must map to a neutral 'Not measured' tone, not risk",
  );
  assert.match(
    src,
    /value\s*>\s*0[\s\S]*?"risk"/,
    "risk/degraded tone must require a real value > 0",
  );
});

test("evidence-ops page surfaces errors through toSafeUserError", () => {
  assert.match(read(PAGE), /toSafeUserError/);
});

test("evidence-ops page links to the queue console", () => {
  assert.match(read(PAGE), /operations\/queues|detailHref/);
});

test("evidence-ops page reads ONLY aggregate health, never evidence contents", () => {
  const src = read(PAGE);
  for (const forbidden of [
    "signatureBase64",
    "fileSha256",
    "storageKey",
    "fingerprintHash",
  ]) {
    assert.doesNotMatch(
      src,
      new RegExp(forbidden),
      `page must not reference evidence content field ${forbidden}`,
    );
  }
});
