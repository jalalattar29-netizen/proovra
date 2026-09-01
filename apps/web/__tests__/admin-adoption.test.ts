/**
 * Platform Control Center — Feature Usage / Adoption (item H) UX contract.
 *
 * Source-contract style (matches admin-security-billing-consoles.test.ts):
 * asserts the adoption console renders through the shared PageShell (no
 * marketing hero), wraps the platform.admin PageRouteGate, shows honest
 * "Not measured" states, and never fabricates an adoption score.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(resolve(APP_ROOT, rel), "utf8");
const exists = (rel: string): boolean => existsSync(resolve(APP_ROOT, rel));

const ADOPTION = "app/(app)/admin/adoption/page.tsx";

test("adoption console page exists", () => {
  assert.ok(exists(ADOPTION), "adoption console page must exist");
});

test("adoption console wraps its own PageRouteGate", () => {
  // ADM-013 — the page now gates on its OWN registry id rather than the
  // layout's `platform.admin`. Same authority (PLATFORM_ADMIN), but the gate,
  // the breadcrumb and the command palette resolve one entry instead of two,
  // and the page can require something the layout does not.
  const src = read(ADOPTION);
  assert.match(src, /PageRouteGate/, "must import + render PageRouteGate");
  assert.match(
    src,
    /routeId="platform\.adoption"/,
    "must gate on the platform.adoption route",
  );
});

test("adoption console renders through the shared PageShell (no marketing hero)", () => {
  const src = read(ADOPTION);
  assert.match(src, /PageShell/, "must use the shared PageShell");
  assert.doesNotMatch(
    src,
    /app-hero-full|className="app-hero/,
    "must not render the marketing app-hero",
  );
  assert.doesNotMatch(src, /cc-page|btn-/, "must not use legacy cc-page/btn- classes");
  assert.match(
    readFileSync(
      resolve(APP_ROOT, "app/(app)/admin/layout.tsx"),
      "utf8",
    ),
    /AdminConsoleNav/,
    "AdminConsoleNav moved to app/(app)/admin/layout.tsx (ADM-025) — asserted there, once, for every admin page",
  );
  assert.match(src, /data-testid="admin-adoption"/, "must carry the admin-adoption test id");
});

test("adoption console renders a capability DataTable with the required columns", () => {
  const src = read(ADOPTION);
  assert.match(src, /DataTable/, "must render the DataTable");
  for (const header of [
    /header:\s*"Capability"/,
    /header:\s*"Enabled"/,
    /header:\s*"Used"/,
    /header:\s*"Never used"/,
    /header:\s*"First used"/,
    /header:\s*"Last used"/,
    /header:\s*"Count"/,
  ]) {
    assert.match(src, header, `must expose column ${header}`);
  }
});

test("adoption console shows honest 'Not measured' + empty states", () => {
  const src = read(ADOPTION);
  assert.match(src, /Not measured/i, "honest 'Not measured' for absent backing model");
  assert.match(src, /EmptyState/, "must render an EmptyState");
  assert.match(src, /No adoption data/i, "honest empty state");
});

test("adoption console routes errors through toSafeUserError (sanctioned path)", () => {
  assert.match(read(ADOPTION), /toSafeUserError/, "must use toSafeUserError");
});

test("adoption console never fabricates an adoption score", () => {
  const src = read(ADOPTION);
  // No fabricated score identifier. `hasCompositeScore` (the honesty flag that
  // is explicitly `false`) is the ONLY permitted use of the word — it proves
  // the absence of a score rather than inventing one.
  assert.doesNotMatch(src, /adoptionScore/i, "must not reference a fabricated adoption score");
  const composite = src.match(/\w*compositeScore\w*/gi) ?? [];
  assert.deepEqual(
    composite.filter((m) => !/hasCompositeScore/i.test(m)),
    [],
    "the only compositeScore reference may be the hasCompositeScore=false honesty flag",
  );
});
