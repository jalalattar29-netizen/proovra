/**
 * Phase 4 (Enterprise Administration) FINALIZATION — org-admin tab wiring +
 * visibility guarantees.
 *
 * Two layers are pinned here:
 *
 *   1. ENTERPRISE-ONLY surface gate (the real `canAccessSurface` used by the
 *      sidebar / command palette / direct-URL middleware): personal /
 *      FREE / PAYG / PRO / TEAM users cannot access ANY org-admin surface
 *      under /organizations/<id>/admin, including the three new Phase 4
 *      tabs (roles, billing, integrations). Only an enterprise workspace
 *      (or platform admin) may.
 *
 *   2. PER-ROLE tab visibility — a pure test over the exported
 *      `visibleAdminTabsForRole` filter that the admin shell layout consumes:
 *        - ORG_OWNER / ORG_ADMIN see every tab.
 *        - ORG_SECURITY_ADMIN sees security + domains, NOT billing.
 *        - ORG_BILLING_ADMIN sees billing, NOT security / domains.
 *        - ORG_AUDITOR sees audit + overview (read), no member-mutation-only
 *          admin surfaces.
 *        - ORG_MEMBER is minimal (read-only reference surfaces only).
 *
 * The backend enforces the authoritative access decision on every endpoint;
 * this is the visibility layer that sits on top of it.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  canAccessSurface,
  type SurfaceUserContext,
} from "../lib/surface/access";
import type { WorkspacePlan } from "../lib/platform-context/types";
import * as layoutModule from "../app/(app)/organizations/[id]/admin/layout";
import {
  ADMIN_TABS,
  visibleAdminTabsForSurfaces,
} from "../app/(app)/organizations/[id]/admin/layout";

/**
 * The canonical org-admin surface vocabulary, in tab-bar order. The SAME
 * literal is pinned against `listOrgAdminSurfaces("ORG_OWNER")` in
 * services/api/test/phase-12-point4-org-admin-surface-projection.test.ts.
 */
const CANONICAL_ORG_ADMIN_SURFACES = [
  "overview",
  "members",
  "roles",
  "departments",
  "integrations",
  "billing",
  "security",
  "domains",
  "governance",
  "access-reviews",
  "retention",
  "bulk-invite",
  "reports",
  "readiness",
  "audit",
  "trust",
];

// ---------------------------------------------------------------------------
// 1. Enterprise-only surface gate.
// ---------------------------------------------------------------------------

const NON_ENTERPRISE: WorkspacePlan[] = ["FREE", "PAYG", "PRO", "TEAM"];

function ctxFor(plan: WorkspacePlan): SurfaceUserContext {
  return {
    // PHASE 12B Track 1A — server-projected booleans, never the plan name.
    planFeatures: {
      intakeIncluded: null,
      professionalSurfacesIncluded:
        plan === "PRO" || plan === "TEAM" || (plan as string) === "ENTERPRISE",
    },
    isPlatformAdmin: false,
    // Mirror the backend derivation — enterprise workspace iff ENTERPRISE plan.
    isEnterpriseWorkspace: plan === "ENTERPRISE",
  };
}

// The admin surfaces under a concrete org id — every existing tab plus the
// three Phase 4 finalization tabs.
const ADMIN_SURFACES = [
  "/organizations/org_123/admin",
  "/organizations/org_123/admin/overview",
  "/organizations/org_123/admin/members",
  "/organizations/org_123/admin/roles",
  "/organizations/org_123/admin/billing",
  "/organizations/org_123/admin/integrations",
  "/organizations/org_123/admin/security",
  "/organizations/org_123/admin/domains",
  "/organizations/org_123/admin/audit",
];

test("personal / FREE / PAYG / PRO / TEAM cannot access ANY org-admin surface (incl. the 3 new tabs)", () => {
  for (const plan of NON_ENTERPRISE) {
    const ctx = ctxFor(plan);
    for (const href of ADMIN_SURFACES) {
      assert.equal(
        canAccessSurface(ctx, href),
        false,
        `${plan} must NOT access org-admin surface ${href}`,
      );
    }
  }
});

test("an enterprise workspace CAN access every org-admin surface (incl. the 3 new tabs)", () => {
  const ent = ctxFor("ENTERPRISE");
  for (const href of ADMIN_SURFACES) {
    assert.equal(
      canAccessSurface(ent, href),
      true,
      `ENTERPRISE must access org-admin surface ${href}`,
    );
  }
});


// ---------------------------------------------------------------------------
// 2. Tab-bar projection over the SERVER's `adminSurfaces` list.
//
// PHASE 12 POINT 4 STEP 1 — the per-role visibility matrix that used to live
// here (`visibleAdminTabsForRole`) moved to the canonical authority beside
// `checkOrgAccess`; it is proven against `listOrgAdminSurfaces` in
// services/api/test/phase-12-point4-org-admin-surface-projection.test.ts.
//
// What remains here is the BROWSER's half of the contract: the shell renders
// exactly the ids the server named, in the canonical tab order, and renders
// NOTHING when the projection is missing.
// ---------------------------------------------------------------------------

test("the 3 Phase-4 tabs are wired into ADMIN_TABS with the expected labels", () => {
  const bySegment = new Map(ADMIN_TABS.map((t) => [t.segment, t]));
  assert.equal(bySegment.get("roles")?.label, "Roles & permissions");
  assert.equal(bySegment.get("billing")?.label, "Billing & seats");
  assert.equal(bySegment.get("integrations")?.label, "API & integrations");
});

test("ADMIN_TABS declares exactly the canonical org-admin surface vocabulary", () => {
  // The SAME literal list is pinned server-side against
  // `listOrgAdminSurfaces("ORG_OWNER")`. If either side gains or loses a
  // surface without the other, one of the two tests fails — a tab can never
  // silently become unrenderable, and the server can never project an id the
  // shell has no tab for.
  assert.deepEqual(ADMIN_TABS.map((t) => t.id), CANONICAL_ORG_ADMIN_SURFACES);
});

test("the shell renders exactly the surfaces the server named, in canonical order", () => {
  const projected = visibleAdminTabsForSurfaces([
    "trust",
    "overview",
    "billing",
  ]);
  assert.deepEqual(
    projected.map((t) => t.id),
    ["overview", "billing", "trust"],
    "server order is irrelevant — the tab bar keeps its declared order",
  );
});

test("an id the shell has no tab for is ignored, never rendered blank", () => {
  const projected = visibleAdminTabsForSurfaces(["overview", "not-a-surface"]);
  assert.deepEqual(projected.map((t) => t.id), ["overview"]);
});

test("a missing or empty projection renders NO tabs — the shell fails CLOSED", () => {
  // Regression guard for the pre-fix behaviour: while `/v1/orgs/:id` was in
  // flight the shell rendered the FULL tab set to every role, so an
  // ORG_MEMBER saw Billing, Security, Domains and Governance until the
  // response landed.
  assert.deepEqual(visibleAdminTabsForSurfaces(undefined), []);
  assert.deepEqual(visibleAdminTabsForSurfaces(null), []);
  assert.deepEqual(visibleAdminTabsForSurfaces([]), []);
});

test("the shell exposes no role-based tab filter at all", () => {
  // Stays-removed guard: `visibleAdminTabsForRole` was the frontend role
  // authority. Re-introducing any role-shaped filter here must fail.
  const layout = layoutModule as Record<string, unknown>;
  assert.equal(layout.visibleAdminTabsForRole, undefined);
  for (const tab of ADMIN_TABS) {
    assert.equal(
      (tab as unknown as Record<string, unknown>).roles,
      undefined,
      `${tab.id} must not carry a client-side role allowlist`,
    );
  }
});
