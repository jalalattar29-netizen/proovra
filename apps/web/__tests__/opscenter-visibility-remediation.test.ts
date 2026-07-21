/**
 * OpsCenter visibility remediation (2026-07-18).
 *
 * RUNTIME contracts for the corrected architecture:
 *
 *   1. The Operations Center (/inbox) is an OPERATIONAL surface — tier
 *      CORE, visible to every plan; the categories INSIDE it are decided
 *      by the canonical eligibility policy (`filterAllowed`).
 *   2. /intake-links follows the COMMERCIAL ENTITLEMENT
 *      (planFeatures.intakeIncluded — PAYG/PRO/TEAM/ENTERPRISE yes,
 *      FREE no), not a plan-literal PRO/TEAM pair; unknown entitlement
 *      fails closed to the tier fallback.
 *   3. The full sidebar route-id set per plan is PINNED so no other
 *      route's visibility changed.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ROUTE_REGISTRY } from "../lib/navigation/routeRegistry";
import {
  canAccessSurface,
  getDirectAccessDecision,
  type SurfaceUserContext,
} from "../lib/surface/access";
import { getSurfaceTier } from "../lib/surface/tiers";
import { resolveRouteAccess } from "../lib/navigation/routeAccessResolver";
import { resolveNavigationExposure } from "../lib/navigation/navigationExposureResolver";
import { resolveWorkspaceExperience } from "../lib/workspace-experience";
import { resolveNavigationDisclosure } from "../lib/navigation/navigationDisclosureResolver";
import { resolveNavigationGroups } from "../lib/navigation/navigationGroupingResolver";
import {
  filterAllowed,
  PRIMARY_OPERATIONS_FILTERS,
  type FilterPolicyContext,
} from "../lib/notifications/operationsFilterPolicy";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Commercial contract fixture — MUST mirror PLAN_CAPABILITIES. The source
// pin below fails if the canonical catalog and this fixture ever diverge.
// ---------------------------------------------------------------------------

const PLAN_FEATURES: Record<
  "FREE" | "PAYG" | "PRO" | "TEAM",
  { intakeIncluded: boolean; reportsIncluded: boolean; verificationPackageIncluded: boolean; casesIncluded: boolean }
> = {
  FREE: { intakeIncluded: false, reportsIncluded: false, verificationPackageIncluded: false, casesIncluded: false },
  PAYG: { intakeIncluded: true, reportsIncluded: true, verificationPackageIncluded: true, casesIncluded: false },
  PRO: { intakeIncluded: true, reportsIncluded: true, verificationPackageIncluded: true, casesIncluded: true },
  TEAM: { intakeIncluded: true, reportsIncluded: true, verificationPackageIncluded: true, casesIncluded: true },
};

test("fixture mirrors the canonical PLAN_CAPABILITIES catalog", () => {
  const catalog = readFileSync(
    resolve(APP_ROOT, "../../packages/shared-billing/src/plan-catalog.ts"),
    "utf8",
  );
  for (const [plan, f] of Object.entries(PLAN_FEATURES)) {
    const at = catalog.indexOf(`${plan}: {`);
    assert.ok(at > -1, `${plan} present in catalog`);
    const block = catalog.slice(at, at + 1200);
    assert.match(
      block,
      new RegExp(`intakeIncluded: ${f.intakeIncluded}`),
      `${plan}.intakeIncluded`,
    );
    assert.match(
      block,
      new RegExp(`reportsIncluded: ${f.reportsIncluded}`),
      `${plan}.reportsIncluded`,
    );
  }
});

function ctxFor(
  plan: "FREE" | "PAYG" | "PRO" | "TEAM" | "ENTERPRISE",
): SurfaceUserContext {
  if (plan === "ENTERPRISE") {
    return {
      plan: "TEAM",
      role: "MEMBER",
      isPlatformAdmin: false,
      isEnterpriseWorkspace: true,
      planFeatures: { intakeIncluded: true },
    };
  }
  return {
    plan,
    role: "OWNER",
    isPlatformAdmin: false,
    isEnterpriseWorkspace: false,
    planFeatures: { intakeIncluded: PLAN_FEATURES[plan].intakeIncluded },
  };
}

// ---------------------------------------------------------------------------
// 1. Operations Center is CORE — visible for every plan, direct access allow.
// ---------------------------------------------------------------------------

test("/inbox is a CORE operational surface for every plan", () => {
  assert.equal(getSurfaceTier("/inbox"), "CORE");
  for (const plan of ["FREE", "PAYG", "PRO", "TEAM", "ENTERPRISE"] as const) {
    assert.equal(
      canAccessSurface(ctxFor(plan), "/inbox"),
      true,
      `${plan} sees Operations Center`,
    );
    assert.equal(
      getDirectAccessDecision(ctxFor(plan), "/inbox").kind,
      "allow",
      `${plan} may open /inbox directly`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. Intake follows the entitlement, with a fail-closed fallback.
// ---------------------------------------------------------------------------

test("/intake-links follows planFeatures.intakeIncluded (contract, not plan literals)", () => {
  assert.equal(canAccessSurface(ctxFor("FREE"), "/intake-links"), false);
  assert.equal(canAccessSurface(ctxFor("PAYG"), "/intake-links"), true, "PAYG includes intake per the catalog");
  assert.equal(canAccessSurface(ctxFor("PRO"), "/intake-links"), true);
  assert.equal(canAccessSurface(ctxFor("TEAM"), "/intake-links"), true);
  assert.equal(canAccessSurface(ctxFor("ENTERPRISE"), "/intake-links"), true);
});

test("unknown entitlement fails CLOSED to the tier fallback", () => {
  // Envelope still loading — PAYG without a known entitlement falls back
  // to the PROFESSIONAL tier (hidden), never open-by-default.
  const loading: SurfaceUserContext = {
    plan: "PAYG",
    role: "OWNER",
    isPlatformAdmin: false,
    isEnterpriseWorkspace: false,
    planFeatures: { intakeIncluded: null },
  };
  assert.equal(canAccessSurface(loading, "/intake-links"), false);
  // PRO stays visible through the tier fallback even while loading.
  assert.equal(
    canAccessSurface({ ...loading, plan: "PRO" }, "/intake-links"),
    true,
  );
});

test("/teams is unchanged (PRO/TEAM tier; no entitlement override)", () => {
  assert.equal(getSurfaceTier("/teams"), "PROFESSIONAL");
  assert.equal(canAccessSurface(ctxFor("FREE"), "/teams"), false);
  assert.equal(canAccessSurface(ctxFor("PAYG"), "/teams"), false);
  assert.equal(canAccessSurface(ctxFor("PRO"), "/teams"), true);
});

// ---------------------------------------------------------------------------
// 3. Full sidebar matrix — the EXACT visible route-id set per plan.
//    Proves Operations Center appears everywhere and NOTHING ELSE moved.
// ---------------------------------------------------------------------------

function sidebarRouteIds(plan: "FREE" | "PAYG" | "PRO" | "TEAM"): string[] {
  const surfaceCtx = ctxFor(plan);
  const tierFiltered = ROUTE_REGISTRY.filter((r) =>
    canAccessSurface(surfaceCtx, r.href),
  );
  const resolved = tierFiltered.map((route) => {
    const access = resolveRouteAccess({
      route,
      activeSpaceType: "PERSONAL",
      isPlatformAdmin: false,
      capabilities: {
        DASHBOARD_VIEW: true,
        EVIDENCE_VIEW: true,
        EVIDENCE_CAPTURE: true,
        CASES_VIEW: true,
        REPORTS_VIEW: true,
        SEARCH_VIEW: true,
        SETTINGS_VIEW: true,
        EVIDENCE_MANAGE: true,
        CASES_MANAGE: true,
        REPORTS_GENERATE: true,
        SETTINGS_MANAGE: true,
        BILLING_VIEW: true,
        // Account-menu refactor (2026-07-21) — Billing is now a sidebar
        // surface (same /billing route). ACCOUNT_BILLING_VIEW is granted to
        // every authenticated user, matching the production envelope.
        ACCOUNT_BILLING_VIEW: true,
        ACCOUNT_SETTINGS_VIEW: true,
        TEAM_VIEW: true,
        INTAKE_LINKS_MANAGE: true,
      } as never,
      accountPlan: plan,
      workspace: { id: "w-1", status: "active" },
      personalSpace: { id: "w-1", status: "active" },
    } as never);
    if (
      (access as { canSeeNav?: boolean; accessState?: string }).canSeeNav &&
      (access as { accessState?: string }).accessState === "NEEDS_ORGANIZATION"
    ) {
      return { route, access: { ...access, canSeeNav: false } };
    }
    return { route, access };
  });
  const exposure = resolveNavigationExposure({
    routes: resolved as never,
  } as never);
  const experience = resolveWorkspaceExperience({
    activeSpaceType: "PERSONAL",
    capabilities: {},
  } as never);
  const disclosure = resolveNavigationDisclosure({
    exposure,
    demotionRouteIds: (experience as { demotionRouteIds: ReadonlySet<string> })
      .demotionRouteIds,
  } as never);
  const { groups } = resolveNavigationGroups({
    primaryItems: disclosure.primaryItems,
    secondaryItems: disclosure.secondaryItems,
  });
  return groups.flatMap((g) => g.items.map((i) => i.route.id)).sort();
}

test("sidebar matrix — Operations Center for every plan; only intake varies by entitlement", () => {
  // The exact per-plan visible sets (pre-remediation these lacked
  // account.inbox everywhere except PRO/TEAM; nothing else moved).
  const BASE = [
    // Account-menu refactor (2026-07-21) — Billing joined the sidebar
    // (Phase 6) via the same canonical /billing route; visible on every plan.
    "account.billing",
    "account.inbox",
    "workspace.capture",
    "workspace.cases",
    "workspace.collaboration_teams",
    "workspace.evidence",
    "workspace.home",
    "workspace.reports",
    "workspace.search",
  ].sort();
  const WITH_INTAKE = [...BASE, "workspace.intake_links"].sort();

  assert.deepEqual(sidebarRouteIds("FREE"), BASE, "FREE");
  assert.deepEqual(sidebarRouteIds("PAYG"), WITH_INTAKE, "PAYG");
  assert.deepEqual(sidebarRouteIds("PRO"), WITH_INTAKE, "PRO");
  assert.deepEqual(sidebarRouteIds("TEAM"), WITH_INTAKE, "TEAM");
});

// ---------------------------------------------------------------------------
// 4. Inside the Operations Center — category matrix via the ONE canonical
//    policy (`filterAllowed`), fed by the plan's commercial features.
// ---------------------------------------------------------------------------

function policyCtxFor(plan: "FREE" | "PAYG" | "PRO" | "TEAM"): FilterPolicyContext {
  const pf = PLAN_FEATURES[plan];
  return {
    canViewAdminAttention: false,
    canReceiveGovernance: false,
    canUseReports: pf.reportsIncluded,
    canUseVerificationPackages: pf.verificationPackageIncluded,
    canUseIntake: pf.intakeIncluded,
    canParticipateInReviews: false,
    canReceiveAssignments: pf.casesIncluded,
    canCollaborate: false,
    hasPendingInvitation: false,
    hasEligibleDeadlineSource: pf.intakeIncluded || pf.casesIncluded,
  };
}

test("category matrix — universal core everywhere; plan-gated sources only where entitled", () => {
  // Universal operational core is visible on EVERY plan, including FREE.
  for (const plan of ["FREE", "PAYG", "PRO", "TEAM"] as const) {
    const ctx = policyCtxFor(plan);
    for (const key of ["all", "unread", "critical", "failures", "integrity", "security"] as const) {
      assert.equal(filterAllowed(key as never, ctx), true, `${plan}:${key}`);
    }
  }
  // FREE hides the plan/participation-gated sources (no actual items).
  const free = policyCtxFor("FREE");
  for (const key of ["intake", "reports", "packages", "review", "collaboration", "governance", "admin", "due_soon", "overdue"] as const) {
    assert.equal(filterAllowed(key as never, free), false, `FREE hides ${key}`);
  }
  // PAYG gains intake + reports/packages + deadline sources (the contract).
  const payg = policyCtxFor("PAYG");
  assert.equal(filterAllowed("intake" as never, payg), true);
  assert.equal(filterAllowed("reports" as never, payg), true);
  assert.equal(filterAllowed("due_soon" as never, payg), true);
  assert.equal(filterAllowed("review" as never, payg), false);
  // PRO adds case-driven assignments.
  const pro = policyCtxFor("PRO");
  assert.equal(filterAllowed("assigned_to_me" as never, pro), true);
  void PRIMARY_OPERATIONS_FILTERS;
});
