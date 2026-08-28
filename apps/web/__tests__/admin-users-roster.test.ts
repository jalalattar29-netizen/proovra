/**
 * Platform Control Center P1 — Platform Users roster page contract.
 *
 * File-text contract (node:test) matching the admin-console-ux test
 * style. Pins that /admin/users:
 *   • exists and renders through the shared PageShell (no marketing hero,
 *     no legacy cc-page / btn- / app-hero chrome);
 *   • calls the real GET /v1/admin/users endpoint via apiFetch;
 *   • surfaces errors ONLY through toSafeUserError;
 *   • renders honest nulls ("—" cells) rather than fabricated values.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(resolve(APP_ROOT, rel), "utf8");

const USERS = "app/(app)/admin/users/page.tsx";

// Strip block + line comments so the doc-comment prose that NAMES the
// legacy chrome (to explain it is not used) doesn't trip the anti-pattern
// assertions below.
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("/admin/users page exists and renders through the shared PageShell", () => {
  const src = read(USERS);
  assert.match(src, /PageShell/, "must use the shared PageShell");
  assert.match(src, /PageHeader/, "must render a PageHeader");
});

// ADM-025 (2026-08-27) — the console nav moved from the PAGES to the LAYOUT.
//
// This assertion used to live on each page, which is exactly why nineteen of
// the thirty-nine admin pages silently lacked a nav: a per-page assertion can
// only fail for pages somebody remembered to write it for. Pinning the LAYOUT
// makes the guarantee structural — every current and future page under
// /admin/* inherits it, the same argument the route gate already uses.
test("the admin LAYOUT renders the console nav for every admin page", () => {
  const layout = read("app/(app)/admin/layout.tsx");
  assert.match(
    readFileSync(
      resolve(APP_ROOT, "app/(app)/admin/layout.tsx"),
      "utf8",
    ),
    /AdminConsoleNav/,
    "AdminConsoleNav moved to app/(app)/admin/layout.tsx (ADM-025) — asserted there, once, for every admin page",
  );
  assert.match(
    layout,
    /PageRouteGate[\s\S]*platform\.admin/,
    "layout must keep the platform.admin gate",
  );
});

test("/admin/users does not render its own console nav (the layout owns it)", () => {
  const src = read(USERS);
  assert.doesNotMatch(
    src,
    /<AdminConsoleNav/,
    "a page-level nav would double-render beneath the layout's",
  );
});

test("/admin/users does NOT use marketing hero or legacy chrome", () => {
  const src = stripComments(read(USERS));
  assert.doesNotMatch(src, /app-hero/, "no marketing app-hero");
  assert.doesNotMatch(src, /cc-page/, "no legacy cc-page shell");
  assert.doesNotMatch(src, /className="btn-|"btn-/, "no legacy btn- classes");
});

test("/admin/users calls the real GET /v1/admin/users endpoint via apiFetch", () => {
  const src = read(USERS);
  assert.match(src, /apiFetch\(/, "must fetch through apiFetch");
  assert.match(src, /\/v1\/admin\/users\?/, "must call the users endpoint");
});

test("/admin/users supports identity AND commercial filters", () => {
  const src = read(USERS);
  assert.match(src, /FilterBar\.Search/, "search control");
  assert.match(src, /platformRole/, "role filter param");
  assert.match(src, /provider/, "provider filter param");
  assert.match(src, /qs\.set\("page"/, "pagination param");

  // ADM-028 — the commercial dimension this roster never had. "List our PRO
  // users" is the question the console could not answer at all.
  assert.match(src, /"tier"/, "account-tier filter");
  assert.match(src, /subscriptionStatus/, "subscription-status filter");
  assert.match(src, /pendingCancellation/, "pending-cancellation filter (ADM-016)");
});

// ADM-028 — the `suspended` filter is GONE, deliberately.
//
// It was derived from TeamMember.status across ALL of a user's memberships and
// rendered as "Account suspended" / "Deactivated". `User` models no
// account-level disable at all, so someone suspended from one workspace and
// active in five read as suspended platform-wide. The roster now reports
// membership counts, labelled as memberships.
test("/admin/users does not claim an account-level suspended state", () => {
  const src = stripComments(read(USERS));
  assert.doesNotMatch(
    src,
    /Account suspended|Deactivated/,
    "the platform models no account-level disable; nothing may claim one",
  );
  assert.match(src, /memberships/, "membership states are reported as memberships");
});

// ADM-017 — the other half of the inert-deep-link finding: global search emits
// ?search=, so this page must actually READ it.
test("/admin/users honours an inbound ?search= deep link", () => {
  const src = read(USERS);
  assert.match(src, /useSearchParams/, "must read the query string");
  assert.match(src, /params\.get\("search"\)/, "must seed search from the URL");
});

// ADM-028 — a roster row must open a real detail page.
test("/admin/users rows open the person detail route", () => {
  const src = read(USERS);
  assert.match(
    src,
    /\/admin\/users\/\$\{encodeURIComponent/,
    "row click must open the :id detail route",
  );
});

test("/admin/users surfaces errors through toSafeUserError (no raw message)", () => {
  const src = read(USERS);
  assert.match(src, /toSafeUserError\(/, "must sanitise errors");
  assert.doesNotMatch(
    src,
    /addToast\(\s*err\.message/,
    "must NOT pass raw error.message to the user",
  );
});

test("/admin/users renders honest nulls ('—') rather than fabricated values", () => {
  const src = read(USERS);
  assert.match(src, /"—"/, "must render an em-dash for absent values");
  // lastLogin is real-or-null: no client-side synthetic timestamp default.
  assert.doesNotMatch(
    stripComments(src),
    /lastLoginAt:\s*new Date\(\)/,
    "must not fabricate a last-login timestamp",
  );
});
