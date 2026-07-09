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
  assert.match(src, /AdminConsoleNav/, "must render the admin console nav");
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

test("/admin/users supports search + role/provider/status filters", () => {
  const src = read(USERS);
  assert.match(src, /FilterBar\.Search/, "search control");
  assert.match(src, /platformRole/, "role filter param");
  assert.match(src, /provider/, "provider filter param");
  assert.match(src, /suspended/, "status/suspended filter param");
  assert.match(src, /params\.set\("page"/, "pagination param");
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
