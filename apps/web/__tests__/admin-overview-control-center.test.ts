/**
 * Platform Admin — Control Center Overview (item A) contract.
 *
 * The /admin landing page must be a real control center: it consumes the
 * platform overview API, renders honest "Not measured" states (no fabricated
 * numbers), keeps the Provision CTA, and every quick action + nav item routes
 * to a real page on disk.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(resolve(APP_ROOT, rel), "utf8");
const PAGE = "app/(app)/admin/page.tsx";

test("overview consumes the platform overview API (not the old analytics bundle)", () => {
  const src = read(PAGE);
  assert.match(src, /\/v1\/admin\/overview/, "must fetch /v1/admin/overview");
});

test("overview renders through the shared PageShell and NOT a marketing hero", () => {
  const src = read(PAGE);
  assert.match(src, /PageShell/, "must use PageShell");
  assert.doesNotMatch(src, /app-hero-full|admin-hero-note/, "no marketing hero");
});

test("overview keeps the Provision Enterprise CTA linking to /admin/provisioning", () => {
  const src = read(PAGE);
  assert.match(src, /data-testid="admin-provision-cta"/);
  assert.match(src, /href="\/admin\/provisioning"/);
});

test("overview renders honest 'Not measured' states (no fabricated numbers)", () => {
  const src = read(PAGE);
  assert.match(src, /Not measured/, "null figures must render as Not measured");
  assert.match(src, /Traffic not connected|not-connected|not connected/i);
});

test("overview shows the seven control-center sections", () => {
  const src = read(PAGE);
  for (const section of [
    "Platform status",
    "Customers",
    "Evidence operations",
    "Security",
    "Billing",
    "Traffic",
    "Quick actions",
  ]) {
    assert.match(src, new RegExp(section), `must have a "${section}" section`);
  }
});

test("every quick action routes to a real page on disk", () => {
  const src = read(PAGE);
  // Extract the QUICK_ACTIONS hrefs.
  const hrefs = Array.from(src.matchAll(/href:\s*"(\/admin\/[a-z-]+)"/g)).map(
    (m) => m[1],
  );
  assert.ok(hrefs.length >= 6, "expected several quick-action hrefs");
  for (const href of hrefs) {
    const page = resolve(APP_ROOT, `app/(app)${href}/page.tsx`);
    assert.ok(existsSync(page), `${href} must resolve to a page.tsx`);
  }
});

test("no fabricated uptime / growth literals baked into the overview", () => {
  const src = read(PAGE);
  assert.doesNotMatch(src, /99\.9%/);
  assert.doesNotMatch(src, /100%\s*uptime/i);
});
