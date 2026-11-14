/**
 * F-21 (Free-user audit) — /operations/batch-analysis and /operations/quotas are
 * PROFESSIONAL surfaces, as their registry entries and tier rules always said.
 *
 * On 2c84cad83 the PROFESSIONAL rules were keyed to the retired /dashboard/*
 * URLs (308-redirected by next.config.js), the live pages fell to the CORE
 * /operations prefix and neither page wrapped SurfaceGate, so a Free account
 * loaded both by URL. The batch console also polled every 4 s forever.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { getDirectAccessDecision, type SurfaceUserContext } from "../lib/surface/access";
import { findSurfaceTierRule } from "../lib/surface/tiers";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, "..", rel), "utf8");

const FREE: SurfaceUserContext = {
  isPlatformAdmin: false,
  isEnterpriseWorkspace: false,
  planFeatures: { professionalSurfacesIncluded: false } as never,
};
const PRO: SurfaceUserContext = {
  isPlatformAdmin: false,
  isEnterpriseWorkspace: false,
  planFeatures: { professionalSurfacesIncluded: true } as never,
};

for (const path of ["/operations/batch-analysis", "/operations/quotas"]) {
  test(`${path} resolves to its PROFESSIONAL rule, not the CORE /operations prefix`, () => {
    assert.equal(findSurfaceTierRule(path)?.tier, "PROFESSIONAL");
  });

  test(`${path}: a plan without professional surfaces is redirected; one with them is allowed`, () => {
    assert.deepEqual(
      { kind: getDirectAccessDecision(FREE, path).kind },
      { kind: "redirect" },
    );
    assert.equal(getDirectAccessDecision(PRO, path).kind, "allow");
  });
}

test("the tenant Operations console itself stays CORE", () => {
  assert.equal(findSurfaceTierRule("/operations")?.tier, "CORE");
  assert.equal(getDirectAccessDecision(FREE, "/operations").kind, "allow");
});

test("both pages wrap SurfaceGate around their PageRouteGate", () => {
  for (const rel of ["app/(app)/operations/batch-analysis/page.tsx", "app/(app)/operations/quotas/page.tsx"]) {
    const src = read(rel);
    assert.match(src, /<SurfaceGate>\s*<PageRouteGate routeId="dashboard\.(batch_analysis|quotas)">/, rel);
  }
});

test("the batch console polls only while a job is running, and not while hidden", () => {
  const src = read("app/(app)/operations/batch-analysis/page.tsx");
  assert.match(src, /if \(!hasActiveJobs\) return;/);
  assert.match(src, /document\.visibilityState === "hidden"\) return;/);
  assert.ok(!/setInterval\(\(\) => \{\s*void loadJobs\(\);\s*\}, 4000\)/.test(src), "the unconditional 4 s poll must not return");
});
