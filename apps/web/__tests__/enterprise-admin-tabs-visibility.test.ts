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
import {
  ADMIN_TABS,
  visibleAdminTabsForRole,
} from "../app/(app)/organizations/[id]/admin/layout";
import { ALL_ORG_ROLES } from "../app/(app)/organizations/[id]/admin/_lib/orgRoles";

// ---------------------------------------------------------------------------
// 1. Enterprise-only surface gate.
// ---------------------------------------------------------------------------

const NON_ENTERPRISE: WorkspacePlan[] = ["FREE", "PAYG", "PRO", "TEAM"];

function ctxFor(plan: WorkspacePlan): SurfaceUserContext {
  return {
    plan,
    role: "OWNER",
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
// 2. Per-role tab visibility (pure filter).
// ---------------------------------------------------------------------------

function idsFor(role: Parameters<typeof visibleAdminTabsForRole>[0]): string[] {
  return visibleAdminTabsForRole(role).map((t) => t.id);
}

test("the 3 new tabs are wired into ADMIN_TABS with the expected labels", () => {
  const bySegment = new Map(ADMIN_TABS.map((t) => [t.segment, t]));
  assert.equal(bySegment.get("roles")?.label, "Roles & permissions");
  assert.equal(bySegment.get("billing")?.label, "Billing & seats");
  assert.equal(bySegment.get("integrations")?.label, "API & integrations");
});

test("ORG_OWNER and ORG_ADMIN see every tab", () => {
  const allIds = ADMIN_TABS.map((t) => t.id);
  assert.deepEqual(idsFor("ORG_OWNER"), allIds);
  assert.deepEqual(idsFor("ORG_ADMIN"), allIds);
});

test("ORG_SECURITY_ADMIN sees security + domains but NOT billing", () => {
  const ids = idsFor("ORG_SECURITY_ADMIN");
  assert.ok(ids.includes("security"), "security tab visible");
  assert.ok(ids.includes("domains"), "domains tab visible");
  assert.ok(ids.includes("overview"), "overview tab visible");
  assert.ok(!ids.includes("billing"), "billing tab hidden for security admin");
});

test("ORG_BILLING_ADMIN sees billing but NOT security / domains", () => {
  const ids = idsFor("ORG_BILLING_ADMIN");
  assert.ok(ids.includes("billing"), "billing tab visible");
  assert.ok(ids.includes("overview"), "overview tab visible");
  assert.ok(!ids.includes("security"), "security tab hidden for billing admin");
  assert.ok(!ids.includes("domains"), "domains tab hidden for billing admin");
});

test("ORG_AUDITOR sees audit + overview (read) and no member/dept mutation surfaces", () => {
  const ids = idsFor("ORG_AUDITOR");
  assert.ok(ids.includes("audit"), "audit tab visible");
  assert.ok(ids.includes("overview"), "overview tab visible");
  // Auditor is read-only: the admin-only mutation surfaces (departments,
  // integrations) are hidden.
  assert.ok(!ids.includes("departments"), "departments hidden for auditor");
  assert.ok(!ids.includes("integrations"), "integrations hidden for auditor");
});

test("ORG_MEMBER is minimal — only read-only reference surfaces, no admin tabs", () => {
  const ids = idsFor("ORG_MEMBER");
  // Member never sees the admin-only surfaces.
  for (const hidden of [
    "departments",
    "integrations",
    "billing",
    "security",
    "domains",
    "governance",
    "access-reviews",
    "retention",
  ]) {
    assert.ok(!ids.includes(hidden), `${hidden} hidden for plain member`);
  }
  // Member does keep the read-only reference surfaces.
  assert.ok(ids.includes("overview"), "overview visible for member");
  assert.ok(ids.includes("roles"), "roles reference visible for member");
});

test("every ADMIN_TABS entry declares at least one visible role from the canonical role set", () => {
  const roleSet = new Set<string>(ALL_ORG_ROLES);
  for (const tab of ADMIN_TABS) {
    assert.ok(tab.roles.length > 0, `${tab.id} must be visible to some role`);
    for (const r of tab.roles) {
      assert.ok(
        roleSet.has(r),
        `${tab.id} references unknown role ${r}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 3. SCOPE-K — governance-family tab visibility matrix.
//
// The governance-related tabs (governance, retention, access-reviews) follow
// the same visibility contract:
//   - ORG_OWNER / ORG_ADMIN         full
//   - ORG_SECURITY_ADMIN            visible (security posture oversight)
//   - ORG_AUDITOR                   visible (read-only governance/audit)
//   - ORG_BILLING_ADMIN            EXCLUDED (billing specialist, no governance)
//   - ORG_MEMBER                    EXCLUDED (no governance)
// ---------------------------------------------------------------------------

const GOVERNANCE_FAMILY = ["governance", "retention", "access-reviews"] as const;

test("SCOPE-K — OWNER and ADMIN see every governance-family tab", () => {
  for (const role of ["ORG_OWNER", "ORG_ADMIN"] as const) {
    const ids = idsFor(role);
    for (const tab of GOVERNANCE_FAMILY) {
      assert.ok(ids.includes(tab), `${role} must see governance tab ${tab}`);
    }
  }
});

test("SCOPE-K — SECURITY_ADMIN sees the governance-family tabs (security oversight)", () => {
  const ids = idsFor("ORG_SECURITY_ADMIN");
  for (const tab of GOVERNANCE_FAMILY) {
    assert.ok(
      ids.includes(tab),
      `ORG_SECURITY_ADMIN must see governance tab ${tab}`,
    );
  }
});

test("SCOPE-K — AUDITOR has read-only governance + audit visibility", () => {
  const ids = idsFor("ORG_AUDITOR");
  for (const tab of GOVERNANCE_FAMILY) {
    assert.ok(
      ids.includes(tab),
      `ORG_AUDITOR must see governance tab ${tab} (read-only)`,
    );
  }
  assert.ok(ids.includes("audit"), "ORG_AUDITOR must see audit");
});

test("SCOPE-K — BILLING_ADMIN is EXCLUDED from every governance-family tab", () => {
  const ids = idsFor("ORG_BILLING_ADMIN");
  for (const tab of GOVERNANCE_FAMILY) {
    assert.ok(
      !ids.includes(tab),
      `ORG_BILLING_ADMIN must NOT see governance tab ${tab}`,
    );
  }
});

test("SCOPE-K — MEMBER is EXCLUDED from every governance-family tab", () => {
  const ids = idsFor("ORG_MEMBER");
  for (const tab of GOVERNANCE_FAMILY) {
    assert.ok(
      !ids.includes(tab),
      `ORG_MEMBER must NOT see governance tab ${tab}`,
    );
  }
});

test("filtering is monotonic — a full admin's tab set is a superset of every other role's", () => {
  const adminIds = new Set(idsFor("ORG_ADMIN"));
  for (const role of ALL_ORG_ROLES) {
    for (const id of idsFor(role)) {
      assert.ok(
        adminIds.has(id),
        `role ${role} sees tab ${id} that ORG_ADMIN does not — filter is inconsistent`,
      );
    }
  }
});
