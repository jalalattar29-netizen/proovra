/**
 * Admin Console UX contract — no marketing hero inside internal admin
 * pages, a clear Provision CTA on /admin, and honest analytics.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(resolve(APP_ROOT, rel), "utf8");

const ADMIN = "app/(app)/admin/page.tsx";
const DASHBOARD = "app/(app)/admin/dashboard/page.tsx";
const PROVISIONING = "app/(app)/admin/provisioning/page.tsx";

test("/admin shows a clear Provision Enterprise Customer CTA linking to /admin/provisioning", () => {
  const src = read(ADMIN);
  assert.match(src, /data-testid="admin-provision-cta"/, "provision CTA must exist");
  assert.match(src, /href="\/admin\/provisioning"/, "CTA must link to /admin/provisioning");
});

test("internal admin pages do NOT use the marketing hero layout", () => {
  for (const rel of [ADMIN, DASHBOARD, PROVISIONING]) {
    const src = read(rel);
    assert.doesNotMatch(
      src,
      /className="app-hero app-hero-full"|app-hero-full/,
      `${rel} must not render the marketing app-hero`,
    );
    assert.doesNotMatch(src, /admin-hero-note/, `${rel} must not use the old admin-hero tiles`);
  }
});

test("admin pages render through the shared PageShell", () => {
  for (const rel of [ADMIN, DASHBOARD, PROVISIONING]) {
    assert.match(read(rel), /PageShell/, `${rel} must use the shared PageShell`);
  }
});

test("/admin/dashboard renders HONEST unavailable states (no fabricated analytics)", () => {
  const src = read(DASHBOARD);
  // Honest empty/not-connected states must exist for absent analytics signals.
  assert.match(
    src,
    /admin-analytics-not-connected|Analytics not connected|Not connected/i,
    "dashboard must have an honest analytics-not-connected state",
  );
  assert.match(
    src,
    /Not measured|admin-geography-empty|admin-signal-not-connected/,
    "dashboard must render honest 'Not measured' / not-connected signals",
  );
  // No fabricated fake positives baked in as literals.
  assert.doesNotMatch(src, /99\.9%\s*uptime/i);
  assert.doesNotMatch(src, /"100%\s*uptime"/i);
});

test("/admin/provisioning keeps the fixed hook + no 'admin workspace' copy", () => {
  const src = read(PROVISIONING);
  assert.match(src, /useActiveWorkspaceId\(\)/);
  assert.doesNotMatch(src, /useTeamId\(\)/);
  assert.doesNotMatch(src, /admin workspace/i);
});
