/**
 * GUARD — canonical platform-context projection (Native Convergence, Law of One).
 *
 * projectPlatformContext is the ONE reader of GET /v1/platform/context. It must
 * resolve the active workspace id (`teamId`) from activeSpace.id, read the active
 * space type/plan, and default personalSpaceAllowed to allowed unless the server
 * explicitly says false. Pure function → transpile-and-import the TS.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
// Inline the tiny personal-space dependency so the pure projection imports clean.
const gateSrc = readFileSync(resolve(HERE, "../src/personal-space.ts"), "utf8");
const ctxSrc = readFileSync(resolve(HERE, "../src/product/platform-context.ts"), "utf8")
  .replace(/^import .*$/gm, "") // drop react/api/auth/personal-space imports
  .replace(/export function usePlatformContext[\s\S]*$/m, ""); // drop the RN hook
// Re-attach just the pure gate the projection uses.
const gatePure = gateSrc.match(/export function isPersonalSpaceDisallowed[\s\S]*?\n}/)[0];
const combined = gatePure + "\n" + ctxSrc;
const js = ts.transpileModule(combined, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { projectPlatformContext } = await import(`data:text/javascript,${encodeURIComponent(js)}`);

test("resolves the active teamId from activeSpace.id", () => {
  const p = projectPlatformContext({
    activeSpace: { type: "ORGANIZATION", id: "ws_123", displayName: "Acme", plan: "TEAM" },
  });
  assert.equal(p.activeTeamId, "ws_123");
  assert.equal(p.activeSpaceType, "ORGANIZATION");
  assert.equal(p.activeSpacePlan, "TEAM");
  assert.equal(p.displayName, "Acme");
});

test("personal space with a null id yields a null teamId (personal scope)", () => {
  const p = projectPlatformContext({
    activeSpace: { type: "PERSONAL", id: null, displayName: "Personal Space", plan: "FREE" },
    personalSpaceAllowed: true,
  });
  assert.equal(p.activeTeamId, null);
  assert.equal(p.activeSpaceType, "PERSONAL");
  assert.equal(p.personalSpaceAllowed, true);
});

test("personalSpaceAllowed defaults to allowed; only explicit false blocks", () => {
  assert.equal(projectPlatformContext({}).personalSpaceAllowed, true);
  assert.equal(projectPlatformContext({ personalSpaceAllowed: false }).personalSpaceAllowed, false);
});

test("garbage / missing envelope fails safely", () => {
  for (const bad of [null, undefined, 42, "x", { activeSpace: null }]) {
    const p = projectPlatformContext(bad);
    assert.equal(p.activeTeamId, null);
    assert.equal(p.activeSpaceType, null);
    assert.equal(p.personalSpaceAllowed, true);
  }
});

/* --------------------------------------------- F-02 reviewer operations -- */

test("reviewer operations read their own entitlement, not the enterprise flag", () => {
  // THE DEFECT. The catalog includes reviewer operations for TEAM and above
  // (PlanCapabilities.reviewerOperationsIncluded) and the server enforces that
  // field (reviewer-workspace.routes.ts:430). Both clients gated the surface on
  // enterpriseSurfaces, so a TEAM workspace paid for reviewer comments, legal
  // notes and annotations and could not see any of them.
  const team = projectPlatformContext({
    activeSpace: { type: "ORGANIZATION", id: "t1", plan: "TEAM" },
    flags: { isEnterpriseWorkspace: false },
    planFeatures: { reviewerOperationsIncluded: true },
  });
  assert.equal(team.reviewerOperations, true, "a TEAM workspace is entitled");
  assert.equal(team.enterpriseSurfaces, false, "and is not an enterprise surface");
});

test("a plan without reviewer operations does not get them", () => {
  const free = projectPlatformContext({
    activeSpace: { type: "PERSONAL", id: null, plan: "FREE" },
    planFeatures: { reviewerOperationsIncluded: false },
  });
  assert.equal(free.reviewerOperations, false);
});

test("an enterprise workspace is not, by itself, the authority", () => {
  // The two flags are independent: the envelope decides each one. A surface
  // that inferred either from the other would be a second authority.
  const enterpriseNoFlag = projectPlatformContext({
    flags: { isEnterpriseWorkspace: true },
    planFeatures: { reviewerOperationsIncluded: false },
  });
  assert.equal(enterpriseNoFlag.enterpriseSurfaces, true);
  assert.equal(enterpriseNoFlag.reviewerOperations, false);
});

test("a platform admin passes, exactly as usePlanFeatureGate does on the web", () => {
  const admin = projectPlatformContext({ platform: { isPlatformAdmin: true } });
  assert.equal(admin.reviewerOperations, true);
  assert.equal(admin.enterpriseSurfaces, true);
});

test("an absent entitlement withholds rather than offers", () => {
  for (const bad of [null, undefined, 42, {}, { planFeatures: null }]) {
    assert.equal(projectPlatformContext(bad).reviewerOperations, false);
  }
});
