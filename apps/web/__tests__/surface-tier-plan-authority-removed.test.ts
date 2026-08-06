/**
 * PHASE 12B Track 1A — stays-removed guard for the client raw-plan
 * surface-tier authority.
 *
 * The frontend surface system consumes SERVER-projected booleans only
 * (planFeatures.professionalSurfacesIncluded / isEnterpriseWorkspace /
 * isPlatformAdmin). The raw-plan authority must never return:
 *   - `tiersAllowedByPlan` (plan-name → tier table) stays deleted;
 *   - `SurfaceUserContext` carries no `plan` field;
 *   - lib/surface never imports WorkspacePlan;
 *   - the orphaned lib/surface/resolveHomeSurface twin stays deleted
 *     (the live decision is components/home-experience/resolveHomeSurface).
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SURFACE_DIR = join(APP_ROOT, "lib", "surface");

test("tiersAllowedByPlan (raw-plan tier authority) stays deleted", () => {
  for (const f of readdirSync(SURFACE_DIR)) {
    const src = readFileSync(join(SURFACE_DIR, f), "utf8");
    assert.ok(
      !/export function tiersAllowedByPlan/.test(src),
      `${f} re-introduces tiersAllowedByPlan`,
    );
  }
});

test("SurfaceUserContext carries no raw plan field", () => {
  const access = readFileSync(join(SURFACE_DIR, "access.ts"), "utf8");
  const typeBlock = access.slice(
    access.indexOf("export type SurfaceUserContext"),
    access.indexOf("ANONYMOUS_SURFACE_CONTEXT"),
  );
  assert.ok(!/\bplan\s*:/.test(typeBlock), "SurfaceUserContext regained a plan field");
});

test("lib/surface never imports WorkspacePlan (no plan-name typing back-door)", () => {
  for (const f of readdirSync(SURFACE_DIR)) {
    const src = readFileSync(join(SURFACE_DIR, f), "utf8");
    assert.ok(!/WorkspacePlan/.test(src), `${f} re-imports WorkspacePlan`);
  }
});

test("the orphaned lib/surface/resolveHomeSurface twin stays deleted", () => {
  assert.equal(existsSync(join(SURFACE_DIR, "resolveHomeSurface.ts")), false);
});
