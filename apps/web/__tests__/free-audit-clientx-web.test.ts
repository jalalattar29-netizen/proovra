/**
 * CLIENT-X (free audit 0ea0) — web halves of API-lane cross-lane requests
 * that are pure logic (no rendering): B6-F-29 allowance reset copy and
 * B5B-F-205 redaction surface authority.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { classifyAssistantError } from "../lib/ai/assistant-state";
import { canAccessSurface, getDirectAccessDecision, type SurfaceUserContext } from "../lib/surface/access";
import { findSurfaceTierRule } from "../lib/surface/tiers";

test("B6-F-29: the COST_GUARD copy says the allowance resets at the next UTC calendar month, not a billing period", () => {
  const monthly = classifyAssistantError({ code: "AI_MONTHLY_LIMIT_REACHED", statusCode: 429 });
  assert.equal(monthly.kind, "COST_GUARD");
  assert.match(monthly.body, /resets at the start of the next calendar month \(UTC\)/);
  assert.doesNotMatch(monthly.body, /billing period/);
  const budget = classifyAssistantError({ code: "AI_BUDGET_LIMIT_EXCEEDED", statusCode: 429 });
  assert.equal(budget.body, monthly.body);
});

function ctx(planFeatures: SurfaceUserContext["planFeatures"], isEnterpriseWorkspace = false): SurfaceUserContext {
  return { isPlatformAdmin: false, isEnterpriseWorkspace, planFeatures };
}

const BASE = { intakeIncluded: false, professionalSurfacesIncluded: false, reviewerOperationsIncluded: false };

test("B5B-F-205: /redaction follows planFeatures.redactionIncluded when the API projects it", () => {
  const rule = findSurfaceTierRule("/redaction/abc");
  assert.equal(rule?.entitlementOverride, "redactionIncluded");
  // Entitled non-enterprise workspace: allowed.
  assert.equal(getDirectAccessDecision(ctx({ ...BASE, redactionIncluded: true }), "/redaction").kind, "allow");
  assert.equal(canAccessSurface(ctx({ ...BASE, redactionIncluded: true }), "/redaction/p1"), true);
  // Enterprise workspace the server says is NOT entitled: hidden.
  assert.equal(canAccessSurface(ctx({ ...BASE, redactionIncluded: false }, true), "/redaction"), false);
  assert.equal(getDirectAccessDecision(ctx({ ...BASE, redactionIncluded: false }, true), "/redaction").kind, "notFound");
});

test("B5B-F-205: an older API (no redactionIncluded) keeps the ENTERPRISE tier fallback", () => {
  assert.equal(canAccessSurface(ctx({ ...BASE }), "/redaction"), false);
  assert.equal(canAccessSurface(ctx({ ...BASE, redactionIncluded: null }, true), "/redaction"), true);
  assert.equal(canAccessSurface(ctx(null, true), "/redaction"), true);
});
