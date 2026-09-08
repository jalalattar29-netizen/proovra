/**
 * THE WORKSPACE PLAN SHOWN ON MEMBERS & ACCESS MUST BE THE RESOLVED ONE.
 *
 * The Workspace overview card read:
 *
 *     normalizePlanLabel(team?.effectivePlan ?? team?.billingPlan, "FREE")
 *
 * and both operands plus the fallback were wrong:
 *
 *   - `effectivePlan` was projected by NO route, so it was always undefined;
 *   - `billingPlan` is ADMIN-only and is the RAW column the API itself
 *     documents as not the effective plan (meaningless on a PERSONAL
 *     workspace);
 *   - so the expression collapsed to the literal `"FREE"` for every
 *     MEMBER and VIEWER, and for admins whose raw column disagreed.
 *
 * A PRO workspace told its members they were on FREE. That is a manufactured
 * commercial statement, and it is worse than showing nothing.
 *
 * These are SOURCE contracts because the defect was a source expression, not a
 * render: the component is a client page with a data dependency this suite
 * does not boot, and the property that regressed — "no path substitutes FREE"
 * — is exactly readable from the source.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dirname, "..");
const PEOPLE_PAGE = join(WEB, "app", "(app)", "teams", "[id]", "page.tsx");
const TEAMS_ROUTES = join(
  WEB,
  "..",
  "..",
  "services",
  "api",
  "src",
  "routes",
  "teams.routes.ts",
);

const page = readFileSync(PEOPLE_PAGE, "utf8");
const routes = readFileSync(TEAMS_ROUTES, "utf8");

/** Source with comments stripped — prose must not satisfy or break a rule. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const pageCode = codeOnly(page);
const routesCode = codeOnly(routes);

test("the server projects the RESOLVED plan, from the canonical authority", () => {
  // `resolveCommercialContext` is the one commercial resolver; the detail route
  // already calls it for the seat figures. Projecting its plan adds no second
  // authority — inventing a local one would.
  assert.match(routesCode, /effectivePlan:\s*workspaceScope\.plan/);
  assert.match(
    routesCode,
    /resolveCommercialContext\(\{\s*type:\s*"WORKSPACE"/,
    "the projection must come from the canonical commercial resolver",
  );
});

test("the plan projection is not gated behind ADMIN, so members are not told FREE", () => {
  /*
   * The raw commercial block (billingPlan / billingStatus / includedSeats /
   * overSeatLimit) stays ADMIN-only. `effectivePlan` must sit OUTSIDE that
   * spread — a non-admin who receives no plan is exactly the reader who was
   * being shown "FREE".
   */
  const start = routesCode.indexOf("billingPlan: team.billingPlan");
  assert.ok(start > -1, "the admin-gated commercial block moved");
  // Bounded by the CONDITIONAL SPREAD's own close (`: {}),`), not by the next
  // field — otherwise the slice swallows everything projected after it and the
  // assertion means nothing.
  const end = routesCode.indexOf(": {}),", start);
  assert.ok(end > start, "the conditional spread's close was not found");
  const adminBlock = routesCode.slice(start, end);
  assert.doesNotMatch(
    adminBlock,
    /effectivePlan/,
    "effectivePlan must not be inside the ADMIN-only spread",
  );
});

test("the page never substitutes FREE for an unknown plan", () => {
  const derivation = pageCode.slice(
    pageCode.indexOf("const effectivePlan = useMemo("),
    pageCode.indexOf("const ownerLabel"),
  );
  assert.ok(derivation.length > 0, "the plan derivation moved");
  // The exact expression that manufactured the claim.
  assert.doesNotMatch(derivation, /"FREE"/);
  assert.doesNotMatch(
    derivation,
    /normalizePlanLabel\([^)]*,\s*"FREE"\)/,
    "unknown must not default to FREE",
  );
});

test("the raw billingPlan can no longer stand in for the resolved plan", () => {
  const derivation = pageCode.slice(
    pageCode.indexOf("const effectivePlan = useMemo("),
    pageCode.indexOf("const ownerLabel"),
  );
  assert.doesNotMatch(
    derivation,
    /billingPlan/,
    "a raw column that disagrees with the resolver must never win",
  );
});

test("unknown renders as an em dash, and the row stays", () => {
  // The row must not vanish: a reader who saw a plan yesterday and no Plan row
  // today cannot tell "unknown" from "changed".
  assert.match(pageCode, /data-testid="overview-plan"/);
  assert.match(pageCode, /\{effectivePlan \?\? "—"\}/);
});

test("normalizePlanLabel still defaults to FREE only where a caller asks it to", () => {
  /*
   * The helper keeps its optional fallback parameter — other callers may
   * legitimately want one. What must not exist is a caller on THIS surface
   * passing "FREE" for a workspace whose plan is simply unknown.
   */
  assert.match(page, /function normalizePlanLabel\(value\?: string \| null, fallback = "FREE"\)/);
  // CALL sites only. The declaration's own parameter list carries the default,
  // which is the point of keeping it — matching it here would assert that the
  // helper may not have a fallback at all, which is a different (and wrong)
  // rule.
  const callSites = [
    ...pageCode.matchAll(/(?<!function )normalizePlanLabel\(([^)]*)\)/g),
  ];
  assert.ok(callSites.length > 0, "no call sites found");
  for (const site of callSites) {
    assert.doesNotMatch(
      site[1],
      /"FREE"/,
      `a call site still passes an explicit FREE fallback: ${site[0]}`,
    );
  }
});
