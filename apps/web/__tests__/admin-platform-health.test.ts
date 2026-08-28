/**
 * PROOVRA Platform Admin — Platform Health page contract.
 *
 * Source-contract tests (node:test convention, matching
 * admin-evidence-ops.test.ts). They pin:
 *   - the page exists at /admin/platform-health,
 *   - it wraps the return in <PageRouteGate routeId="platform.admin"> (CR0),
 *   - it renders through the shared PageShell (no marketing app-hero),
 *   - it renders AdminConsoleNav,
 *   - it carries the required data-testid,
 *   - honest "Not connected" / "Not measured" states are present,
 *   - it surfaces errors through toSafeUserError,
 *   - it does NOT fabricate uptime and does NOT leak secret fields.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string =>
  readFileSync(resolve(APP_ROOT, rel), "utf8");

const PAGE = "app/(app)/admin/platform-health/page.tsx";

test("platform-health page exists and renders through the shared PageShell", () => {
  const src = read(PAGE);
  assert.match(src, /PageShell/, "must use the shared PageShell");
  assert.match(src, /PageHeader/, "must use the shared PageHeader");
  assert.match(
    src,
    /Platform Health & Service Status/,
    "must carry the page title",
  );
});

test("platform-health page wraps in PageRouteGate routeId=platform.admin (CR0)", () => {
  const src = read(PAGE);
  assert.match(src, /PageRouteGate/, "must import + use PageRouteGate");
  assert.match(
    src,
    /<PageRouteGate\s+routeId="platform\.admin">/,
    "must wrap the return in the platform.admin gate",
  );
});

test("platform-health page carries the required data-testid", () => {
  assert.match(read(PAGE), /data-testid="admin-platform-health"/);
});

test("the admin layout provides the console nav this page inherits", () => {
  // AdminConsoleNav moved to app/(app)/admin/layout.tsx (ADM-025): one nav for every admin page, so none can be added without one
  assert.match(read("app/(app)/admin/layout.tsx"), /AdminConsoleNav/);
  assert.doesNotMatch(
    read(PAGE),
    /<AdminConsoleNav/,
    "a page-level nav would double-render beneath the layout’s",
  );
});

test("platform-health page does NOT use the marketing hero or banned classes", () => {
  const src = read(PAGE);
  assert.doesNotMatch(src, /app-hero-full|className="app-hero/, "no app-hero");
  assert.doesNotMatch(src, /cc-page/, "no cc-page class");
  assert.doesNotMatch(src, /className="btn-|"btn-/, "no btn- classes");
});

test("platform-health page renders honest not-connected / not-measured states", () => {
  const src = read(PAGE);
  assert.match(src, /Not connected/, "must render an honest 'Not connected' label");
  assert.match(src, /Not measured/, "must render an honest 'Not measured' label");
});

test("platform-health page surfaces errors through toSafeUserError", () => {
  assert.match(read(PAGE), /toSafeUserError/);
});

test("platform-health page never fabricates uptime", () => {
  const src = read(PAGE);
  assert.doesNotMatch(src, /uptime/i, "must not claim uptime");
  assert.doesNotMatch(src, /99\.9/, "must not fabricate an uptime percentage");
});

test("platform-health page never references secret-looking fields", () => {
  const src = read(PAGE);
  for (const forbidden of [
    "secretCiphertext",
    "connectionString",
    "DATABASE_URL",
    "privateKey",
    "accessKey",
  ]) {
    assert.doesNotMatch(
      src,
      new RegExp(forbidden),
      `page must not reference secret field ${forbidden}`,
    );
  }
});
