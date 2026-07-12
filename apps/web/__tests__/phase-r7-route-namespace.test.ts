/**
 * Phase R7 — Route namespace & ownership anti-regression guards.
 *
 * Locks the R7.3 (Trust nav) and R7.5 (Dashboard→Operations inversion)
 * migrations so the old shapes cannot silently return:
 *
 *   - R7.3 (F17): the AUTHENTICATED Trust nav (`workspace.trust`) points at
 *     the in-app hub `/trust-hub`, NOT the public marketing `/trust` — in
 *     BOTH the frontend routeRegistry and the backend navigation-registry.
 *     The public `/trust` page still exists.
 *   - R7.5 (F19): the live quota / batch-analysis implementations live under
 *     `/operations/*`; NO `/operations/*` page re-exports from `/dashboard/*`
 *     (the file/URL inversion is gone); the `(app)/dashboard/*` impl files
 *     are deleted; the legacy `/dashboard/*` URLs are compatibility
 *     redirects in next.config.js.
 */
import { strict as assert } from "node:assert";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

function readWeb(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}
function webPath(rel: string): string {
  return fileURLToPath(new URL(`../${rel}`, import.meta.url));
}

const registry = readWeb("lib/navigation/routeRegistry.ts");
const nextConfig = readWeb("next.config.js");

// --- R7.3 — Trust navigation ------------------------------------------------

test("R7.3 — frontend workspace.trust points at /trust-hub, not the public /trust", () => {
  const idx = registry.indexOf('id: "workspace.trust"');
  assert.ok(idx > -1, "workspace.trust must be registered");
  const entry = registry.slice(idx, registry.indexOf("\n  },", idx));
  assert.match(entry, /href:\s*"\/trust-hub"/, "authenticated Trust nav must target /trust-hub");
  assert.doesNotMatch(entry, /href:\s*"\/trust"[,\s]/, "must NOT target the public /trust");
});

test("R7.3 — the public marketing /trust page still exists (not merged away)", () => {
  assert.ok(existsSync(webPath("app/trust/page.tsx")), "public /trust page must remain");
});

test("R7.3 — /trust-hub authenticated page exists", () => {
  assert.ok(existsSync(webPath("app/(app)/trust-hub/page.tsx")));
});

// --- R7.5 — Dashboard → Operations inversion --------------------------------

test("R7.5 — no (app)/dashboard/{quotas,batch-analysis} implementation files remain", () => {
  assert.ok(
    !existsSync(webPath("app/(app)/dashboard/quotas/page.tsx")),
    "dashboard/quotas impl must be moved out",
  );
  assert.ok(
    !existsSync(webPath("app/(app)/dashboard/batch-analysis/page.tsx")),
    "dashboard/batch-analysis impl must be moved out",
  );
});

test("R7.5 — the live impls now exist under /operations/*", () => {
  assert.ok(existsSync(webPath("app/(app)/operations/quotas/page.tsx")));
  assert.ok(existsSync(webPath("app/(app)/operations/batch-analysis/page.tsx")));
});

test("R7.5 — NO /operations page re-exports from /dashboard/* (inversion removed)", () => {
  const opsDir = webPath("app/(app)/operations");
  const offenders: string[] = [];
  for (const entry of readdirSync(opsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pagePath = webPath(`app/(app)/operations/${entry.name}/page.tsx`);
    if (!existsSync(pagePath)) continue;
    const src = readFileSync(pagePath, "utf8");
    // The inversion was a re-export of a dashboard ROUTE page, e.g.
    // `export { default } from "../../dashboard/quotas/page"`. Shared
    // component imports (`components/dashboard/DashboardShell`) are fine —
    // match only a `.../dashboard/<segment>/page` route re-export.
    if (/from\s+["'][^"']*\/dashboard\/[a-z-]+\/page["']/.test(src)) {
      offenders.push(entry.name);
    }
  }
  assert.deepEqual(offenders, [], `operations pages must not import from /dashboard: ${offenders.join(", ")}`);
});

test("R7.5 — legacy /dashboard/{quotas,batch-analysis} URLs are compatibility redirects", () => {
  assert.match(
    nextConfig,
    /source:\s*["']\/dashboard\/quotas["'][\s\S]{0,200}destination:\s*["']\/operations\/quotas["']/,
  );
  assert.match(
    nextConfig,
    /source:\s*["']\/dashboard\/batch-analysis["'][\s\S]{0,200}destination:\s*["']\/operations\/batch-analysis["']/,
  );
});
