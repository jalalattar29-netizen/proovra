/**
 * Phase 2 blocker 2 — enterprise surface gating by plan (locked model).
 *
 * Proves at the surface-access layer (the real `canAccessSurface` used by
 * the sidebar, command palette, and direct-URL middleware):
 *   1. FREE / PAYG / PRO / TEAM do NOT unlock any ENTERPRISE-tier surface.
 *   2. ENTERPRISE does unlock ENTERPRISE-tier surfaces.
 *   3. TEAM (and PRO) keep their PROFESSIONAL surfaces; everyone keeps CORE.
 *
 * `isEnterpriseWorkspace` is derived from the plan the same way the backend
 * now derives it (ENTERPRISE_PLAN_KEYS = {"ENTERPRISE"} only): true iff the
 * plan is ENTERPRISE. TEAM is a subscription plan in a PERSONAL workspace and
 * is never an enterprise workspace.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  canAccessSurface,
  type SurfaceUserContext,
} from "../lib/surface/access";
import type { WorkspacePlan } from "../lib/platform-context/types";

const ALL_PLANS: WorkspacePlan[] = ["FREE", "PAYG", "PRO", "TEAM", "ENTERPRISE"];
const NON_ENTERPRISE: WorkspacePlan[] = ["FREE", "PAYG", "PRO", "TEAM"];
const PROFESSIONAL_PLANS: WorkspacePlan[] = ["PRO", "TEAM"];

// Mirror the backend derivation: an enterprise workspace is one on the
// ENTERPRISE plan. Nothing else.
function ctxFor(plan: WorkspacePlan): SurfaceUserContext {
  return {
    plan,
    role: "OWNER",
    isPlatformAdmin: false,
    isEnterpriseWorkspace: plan === "ENTERPRISE",
  };
}

const ENTERPRISE_SURFACES = [
  "/governance",
  "/reviewer-ops",
  "/security-center",
  "/investigation",
];
const PROFESSIONAL_SURFACE = "/intake-links";
const CORE_SURFACE = "/home";

test("FREE / PAYG / PRO / TEAM do NOT unlock any ENTERPRISE surface", () => {
  for (const plan of NON_ENTERPRISE) {
    const ctx = ctxFor(plan);
    for (const href of ENTERPRISE_SURFACES) {
      assert.equal(
        canAccessSurface(ctx, href),
        false,
        `${plan} must NOT access enterprise surface ${href}`,
      );
    }
  }
});

test("TEAM plan (locked-model regression) cannot reach governance/SSO/review-ops", () => {
  const team = ctxFor("TEAM");
  assert.equal(canAccessSurface(team, "/governance"), false);
  assert.equal(canAccessSurface(team, "/security-center"), false);
  assert.equal(canAccessSurface(team, "/reviewer-ops"), false);
});

test("ENTERPRISE unlocks every ENTERPRISE surface", () => {
  const ent = ctxFor("ENTERPRISE");
  for (const href of ENTERPRISE_SURFACES) {
    assert.equal(
      canAccessSurface(ent, href),
      true,
      `ENTERPRISE must access ${href}`,
    );
  }
});

test("PRO / TEAM / ENTERPRISE keep PROFESSIONAL surfaces; FREE / PAYG do not", () => {
  for (const plan of PROFESSIONAL_PLANS) {
    assert.equal(
      canAccessSurface(ctxFor(plan), PROFESSIONAL_SURFACE),
      true,
      `${plan} must keep professional surface ${PROFESSIONAL_SURFACE}`,
    );
  }
  assert.equal(canAccessSurface(ctxFor("ENTERPRISE"), PROFESSIONAL_SURFACE), true);
  for (const plan of ["FREE", "PAYG"] as WorkspacePlan[]) {
    assert.equal(
      canAccessSurface(ctxFor(plan), PROFESSIONAL_SURFACE),
      false,
      `${plan} must not access professional surface`,
    );
  }
});

test("every plan keeps CORE surfaces", () => {
  for (const plan of ALL_PLANS) {
    assert.equal(
      canAccessSurface(ctxFor(plan), CORE_SURFACE),
      true,
      `${plan} must access core surface ${CORE_SURFACE}`,
    );
  }
});
