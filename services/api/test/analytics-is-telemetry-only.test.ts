/**
 * THE ANALYTICS PLAN DERIVATION IS TELEMETRY. IT MUST NEVER BECOME AUTHORITY.
 *
 * ===========================================================================
 * WHAT IS BEING TOLERATED, AND WHY IT NEEDS A GUARD
 * ===========================================================================
 * `computeTeamWorkspaceHealth` in `analytics.routes.ts` derives a plan from
 * the raw columns:
 *
 *     isTeamBillingActive(team.billingStatus) ? team.billingPlan : "FREE"
 *
 * That is a second derivation of something the platform has exactly one
 * authority for (`resolveCommercialContext`). It is kept because the sweep
 * spans every live workspace on the platform to fill four counters on ONE
 * internal admin tile, and resolving a canonical envelope per workspace would
 * mean usage rollups, lifecycle verdicts and Enterprise contract loads across
 * the whole estate to compute numbers nobody is billed by.
 *
 * A tolerance is only honest while it is BOUNDED. The bound is: this value may
 * describe, and may not decide. These cases hold that bound at the two places
 * it can break — the value's blast radius inside the module, and the audience
 * of the route that returns it.
 *
 * If a product decision ever needs to consult this number, the answer is not
 * to widen the tolerance: it is to call the canonical resolver, and to delete
 * the allowlist entry in `commercial-plan-authority-drift.test.ts`.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const API_SRC = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
);

const read = (rel: string) => readFileSync(resolve(API_SRC, rel), "utf8");

/** Source with comments stripped — prose must not satisfy or break a rule. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const ANALYTICS = codeOnly(read("routes/analytics.routes.ts"));

describe("the analytics plan derivation is named for what it is", () => {
  it("is not called `effectivePlan` — that name belongs to the canonical answer", () => {
    /*
     * A duplicate authority is rarely written on purpose. It is usually
     * inherited: someone looking for "the effective plan" finds a variable
     * with that name, and reuses it. The derivation here is a REPORTING
     * BASELINE and must read as one at every use site.
     */
    expect(ANALYTICS).toMatch(/const reportingPlanBaseline\s*=/);
    expect(
      ANALYTICS,
      "analytics must not present a local derivation under the canonical name",
    ).not.toMatch(/\beffectivePlan\b/);
  });
});

describe("the derived value cannot decide anything", () => {
  /**
   * Everything the baseline touches, read from the source rather than assumed.
   * Two consumers: the plan CAPABILITY row it feeds, and the seat rule.
   */
  const uses = [...ANALYTICS.matchAll(/reportingPlanBaseline/g)];

  it("has a small, enumerated set of use sites", () => {
    // One declaration + two reads. A third read is not automatically wrong,
    // but it is exactly the moment to re-ask whether this is still telemetry.
    expect(uses.length).toBe(3);
  });

  it("feeds only counters — never a grant, a refusal or a throw", () => {
    /*
     * The window is the whole `computeTeamWorkspaceHealth` body. Nothing in it
     * may deny, gate, enqueue or persist: the function reads rows and
     * increments integers.
     */
    const start = ANALYTICS.indexOf("async function computeTeamWorkspaceHealth");
    expect(start).toBeGreaterThan(-1);
    const end = ANALYTICS.indexOf("async function getSummary", start);
    expect(end).toBeGreaterThan(start);
    const body = ANALYTICS.slice(start, end);

    // No authorization or entitlement decision.
    expect(body).not.toMatch(/authorizeOrFail|assert[A-Z]\w*|requirePermission/);
    // No denial.
    expect(body).not.toMatch(/throw new (DomainError|Error)/);
    expect(body).not.toMatch(/statusCode\s*=|httpStatus:/);
    // No write of any kind — a report may not mutate commercial state.
    expect(body).not.toMatch(
      /prisma\.\w+\.(create|update|updateMany|upsert|delete|deleteMany)\b/,
    );
    // No queue work scheduled off a reporting number.
    expect(body).not.toMatch(/enqueue|\.add\(/);
  });

  it("does not reach the output-entitlement or admission authorities", () => {
    // Importing any of these into a telemetry sweep would mean the number had
    // started answering a product question.
    expect(ANALYTICS).not.toMatch(/resolveEvidenceOutputEntitlements/);
    expect(ANALYTICS).not.toMatch(/resolvePersonalEvidenceAdmission/);
    expect(ANALYTICS).not.toMatch(/resolveEvidenceOutputEligibility/);
    expect(ANALYTICS).not.toMatch(/resolveEvidenceFunding/);
  });
});

describe("the value never reaches a customer", () => {
  it("every analytics dashboard route is platform-admin only", () => {
    /*
     * `workspaceHealth` is returned by `GET /v1/admin/analytics/dashboard`.
     * The guard is the preHandler, so it is pinned here: a customer-visible
     * projection of a non-canonical plan derivation is precisely the defect
     * the commercial closure removed everywhere else.
     */
    expect(ANALYTICS).toMatch(
      /const ADMIN_PRE\s*=\s*\{\s*preHandler:\s*requirePlatformAdmin\s*\}/,
    );
    const dashboard = ANALYTICS.indexOf('"/v1/admin/analytics/dashboard"');
    expect(dashboard).toBeGreaterThan(-1);
    expect(ANALYTICS.slice(dashboard, dashboard + 120)).toContain("ADMIN_PRE");
  });

  it("the projected shape carries counters, not a plan", () => {
    // `workspaceHealth` is four integers. If a plan name ever appears on this
    // envelope it has left telemetry and entered presentation.
    const start = ANALYTICS.indexOf("workspaceHealth: {");
    expect(start).toBeGreaterThan(-1);
    const shape = ANALYTICS.slice(start, ANALYTICS.indexOf("}", start));
    expect(shape).not.toMatch(/\bplan\b/);
  });
});
