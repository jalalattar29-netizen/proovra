/**
 * Platform Control Center P0 — Customers / Organizations pages contract.
 *
 * File-text contract (node:test) matching the admin-users-roster test
 * style. Pins that the roster + detail pages:
 *   • exist and render through the shared PageShell (no marketing hero,
 *     no legacy cc-page / btn- / app-hero chrome);
 *   • call the real /v1/admin/customers endpoints via apiFetch;
 *   • surface errors ONLY through toSafeUserError;
 *   • render honest null states ("—" / "Not measured" / "Not connected")
 *     rather than fabricated values.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(resolve(APP_ROOT, rel), "utf8");

const ROSTER = "app/(app)/admin/customers/page.tsx";
const DETAIL = "app/(app)/admin/customers/[id]/page.tsx";

const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("roster + detail pages exist and render through the shared PageShell", () => {
  for (const p of [ROSTER, DETAIL]) {
    const src = read(p);
    assert.match(src, /PageShell/, `${p} must use the shared PageShell`);
    assert.match(src, /PageHeader/, `${p} must render a PageHeader`);
  }
});

// ADM-025 — the console nav moved from each page to app/(app)/admin/layout.tsx,
// so every admin page inherits it and none can be added without one.
test("the admin layout provides the console nav these pages inherit", () => {
  const layout = read("app/(app)/admin/layout.tsx");
  assert.match(layout, /AdminConsoleNav/, "layout must render the console nav");
});

test("roster uses FilterBar + DataTable + EmptyState primitives", () => {
  const src = read(ROSTER);
  assert.match(src, /FilterBar/, "must use FilterBar");
  assert.match(src, /DataTable/, "must use DataTable");
  assert.match(src, /EmptyState/, "must use an honest EmptyState");
  assert.match(src, /No customers yet/, "honest empty title");
});

test("pages do NOT use marketing hero or legacy chrome", () => {
  for (const p of [ROSTER, DETAIL]) {
    const src = stripComments(read(p));
    assert.doesNotMatch(src, /app-hero/, `${p}: no marketing app-hero`);
    assert.doesNotMatch(src, /cc-page/, `${p}: no legacy cc-page shell`);
    assert.doesNotMatch(src, /className="btn-|"btn-/, `${p}: no legacy btn- classes`);
  }
});

test("pages call the real /v1/admin/customers endpoints via apiFetch", () => {
  const roster = read(ROSTER);
  assert.match(roster, /apiFetch\(/, "roster must fetch through apiFetch");
  assert.match(roster, /\/v1\/admin\/customers\?/, "roster must call the list endpoint");

  const detail = read(DETAIL);
  assert.match(detail, /apiFetch\(/, "detail must fetch through apiFetch");
  assert.match(
    detail,
    /\/v1\/admin\/customers\/\$\{encodeURIComponent\(id\)\}/,
    "detail must call the by-id endpoint",
  );
});

test("roster supports search + plan/status/health/enterprise filters + pagination", () => {
  const src = read(ROSTER);
  assert.match(src, /FilterBar\.Search/, "search control");
  // The local URLSearchParams is named `qs` because the page also reads the
  // INCOMING params via useSearchParams. What matters is that each filter is
  // sent to the API, not what the builder variable is called.
  for (const key of ["plan", "status", "health", "enterprise", "page"]) {
    assert.ok(
      src.includes('qs.set("' + key + '"'),
      key + " filter must reach the API",
    );
  }
});

// ADM-017 — a drill-down that lands on an unfiltered page 1 shows a different
// population than the number that was clicked, with nothing saying so.
test("roster SEEDS its filters from the incoming URL", () => {
  const src = read(ROSTER);
  assert.match(src, /useSearchParams/, "must read the incoming URL");
  for (const key of ["status", "health", "enterprise"]) {
    assert.ok(
      src.includes('params.get("' + key + '"'),
      "?" + key + "= must seed the roster filter",
    );
  }
});

test("pages surface errors through toSafeUserError (no raw message)", () => {
  for (const p of [ROSTER, DETAIL]) {
    const src = read(p);
    assert.match(src, /toSafeUserError\(/, `${p} must sanitise errors`);
    assert.doesNotMatch(
      src,
      /addToast\(\s*err\.message/,
      `${p} must NOT pass raw error.message to the user`,
    );
  }
});

test("detail renders honest null states rather than fabricated values", () => {
  const src = read(DETAIL);
  assert.match(src, /Not measured/, "must render 'Not measured' for absent metrics");
  assert.match(src, /Not connected/, "must render 'Not connected' for absent SSO/SCIM");
  assert.match(src, /"—"/, "must render an em-dash for absent values");
  // 404 → honest not-found state, not a fabricated empty org.
  assert.match(src, /Organization not found/, "must show an honest 404 state");
});
