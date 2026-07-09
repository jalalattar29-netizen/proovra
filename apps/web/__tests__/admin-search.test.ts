/**
 * Platform Control Center (item I) — Global Search page contract.
 *
 * File-text contract (node:test) matching the admin-organizations-roster
 * style. Pins that the search page:
 *   • exists and renders through the shared PageShell + AdminConsoleNav;
 *   • is wrapped in the <PageRouteGate routeId="platform.admin"> gate;
 *   • has a search input + result type badges + a data-testid hook;
 *   • enforces a client-side minimum query length;
 *   • calls the real /v1/admin/search endpoint via apiFetch;
 *   • surfaces errors ONLY through toSafeUserError and renders honest
 *     empty states ("No matches" / "Enter at least 2 characters");
 *   • carries no marketing hero / legacy chrome.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(resolve(APP_ROOT, rel), "utf8");

const PAGE = "app/(app)/admin/search/page.tsx";

const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("search page exists and renders through the shared shell", () => {
  const src = read(PAGE);
  assert.match(src, /PageShell/, "must use the shared PageShell");
  assert.match(src, /PageHeader/, "must render a PageHeader");
  assert.match(src, /AdminConsoleNav/, "must render the admin console nav");
  assert.match(src, /data-testid="admin-search"/, "must expose the test hook");
});

test("search page is wrapped in the platform.admin PageRouteGate", () => {
  const src = read(PAGE);
  assert.match(src, /PageRouteGate/, "must import + use PageRouteGate");
  assert.match(
    src,
    /routeId="platform\.admin"/,
    "must gate on the platform.admin route",
  );
});

test("search page has a search input + result type badges", () => {
  const src = read(PAGE);
  assert.match(src, /FilterBar\.Search/, "must render a search input");
  assert.match(src, /Badge/, "must render result type badges");
  // The type→label map that drives the badges must be present.
  assert.match(src, /TYPE_LABEL/, "must map entity types to human labels");
});

test("search page enforces a minimum query length guard", () => {
  const src = read(PAGE);
  assert.match(src, /MIN_QUERY_LENGTH/, "must define a min-length constant");
  assert.match(
    src,
    /Enter at least 2 characters/,
    "must render an honest min-length prompt",
  );
});

test("search page calls the real /v1/admin/search endpoint via apiFetch", () => {
  const src = read(PAGE);
  assert.match(src, /apiFetch\(/, "must fetch through apiFetch");
  assert.match(src, /\/v1\/admin\/search\?/, "must call the search endpoint");
});

test("search page renders honest empty states", () => {
  const src = read(PAGE);
  assert.match(src, /EmptyState/, "must use an honest EmptyState");
  assert.match(src, /No matches/, "honest zero-results title");
});

test("search page surfaces errors through toSafeUserError (no raw message)", () => {
  const src = read(PAGE);
  assert.match(src, /toSafeUserError\(/, "must sanitise errors");
  assert.doesNotMatch(
    src,
    /addToast\(\s*err\.message/,
    "must NOT pass raw error.message to the user",
  );
});

test("search page uses no marketing hero or legacy chrome", () => {
  const src = stripComments(read(PAGE));
  assert.doesNotMatch(src, /app-hero/, "no marketing app-hero");
  assert.doesNotMatch(src, /cc-page/, "no legacy cc-page shell");
  assert.doesNotMatch(src, /className="btn-|"btn-/, "no legacy btn- classes");
});
