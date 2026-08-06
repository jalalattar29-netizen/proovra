/**
 * PHASE 12 — POINT 4, STEP 1: the frontend decides nothing.
 *
 * Focused behavioural proof for the executable role / plan / tenant / policy /
 * commercial decisions that were removed from the browser this pass. Each
 * block states what the browser used to decide, which SERVER projection now
 * decides it, and that the surface FAILS CLOSED while that projection is
 * missing.
 *
 * These are runtime assertions against the production modules — no source
 * regexes, no mocks of the behaviour being claimed.
 *
 * The API keeps its own gate on every one of these decisions; those gates are
 * pinned in the API suite and are unchanged by this pass.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { deriveSettingsUiContext } from "../lib/settings/settingsUiContext";
import type { SettingsUiContextInput } from "../lib/settings/settingsUiContext";
import { deriveAiSettingsMode } from "../lib/ai/aiAssistanceView";
import { ANONYMOUS_SURFACE_CONTEXT } from "../lib/surface/access";

// ---------------------------------------------------------------------------
// Settings — billing authority (was: activeOrgRole === "OWNER" || "ADMIN")
// ---------------------------------------------------------------------------

function orgInput(over: Partial<SettingsUiContextInput> = {}): SettingsUiContextInput {
  return {
    activeSpace: { type: "ORGANIZATION", id: "o-1", displayName: "Acme Legal" },
    workspacePlan: "TEAM",
    accountPlan: "FREE",
    canManageBilling: null,
    canManageWorkspaceSettings: null,
    isEnterpriseWorkspace: false,
    organizations: [
      {
        id: "o-1",
        name: "Acme Legal",
        membershipStatus: "ACTIVE",
        // The role is still carried for the display name lookup. It must
        // never move the billing or admin-link decision.
        role: "OWNER",
        plan: "TEAM",
      },
    ],
    planFeatures: {
      reviewerOperationsIncluded: true,
      aiAssistanceMonthlyOperations: 100,
    },
    ...over,
  };
}

test("org billing authority comes from BILLING_MANAGE, not the membership role", () => {
  // OWNER of the active org, but the server withheld the capability.
  const withheld = deriveSettingsUiContext(orgInput({ canManageBilling: false }));
  assert.equal(withheld.billing.canManageBilling, false);
  assert.equal(withheld.billing.billingHref, null);

  // Same role, capability granted.
  const granted = deriveSettingsUiContext(orgInput({ canManageBilling: true }));
  assert.equal(granted.billing.canManageBilling, true);
  assert.equal(granted.billing.billingHref, "/billing");
});

test("billing FAILS CLOSED while the capability projection is unknown", () => {
  // Envelope loading / degraded. The pre-fix resolver read the role and would
  // have offered the billing action to an OWNER immediately.
  const loading = deriveSettingsUiContext(orgInput({ canManageBilling: null }));
  assert.equal(loading.billing.canManageBilling, false);
  assert.equal(loading.billing.billingHref, null);
});

test("personal billing is the same projection — no unconditional true", () => {
  const base: SettingsUiContextInput = {
    activeSpace: { type: "PERSONAL", id: "p-1", displayName: "Personal Space" },
    workspacePlan: "PRO",
    accountPlan: "PRO",
    canManageBilling: null,
    canManageWorkspaceSettings: null,
    isEnterpriseWorkspace: false,
    organizations: [],
    planFeatures: {
      reviewerOperationsIncluded: false,
      aiAssistanceMonthlyOperations: 100,
    },
  };
  assert.equal(deriveSettingsUiContext(base).billing.canManageBilling, false);
  assert.equal(deriveSettingsUiContext(base).billing.billingHref, null);
  const ready = deriveSettingsUiContext({ ...base, canManageBilling: true });
  assert.equal(ready.billing.canManageBilling, true);
  assert.equal(ready.billing.billingHref, "/billing");
});

test("the enterprise-contract classification is the SERVER flag, not a plan name", () => {
  // A workspace whose plan STRING says ENTERPRISE but whose server flag is
  // false is NOT treated as a contract — the browser is not the commercial
  // authority. The plan string still drives the display label.
  const planNameOnly = deriveSettingsUiContext(
    orgInput({
      workspacePlan: "ENTERPRISE",
      isEnterpriseWorkspace: false,
      canManageBilling: true,
    }),
  );
  assert.equal(planNameOnly.billing.contextType, "organization");
  assert.equal(planNameOnly.billing.scopeLabel, "Organization plan");
  assert.equal(planNameOnly.billing.displayPlan, "ENTERPRISE");
  assert.equal(planNameOnly.billing.billingHref, "/billing");

  // The server flag alone flips it, and an enterprise contract never offers
  // a self-service upgrade CTA even to a BILLING_MANAGE holder.
  const contract = deriveSettingsUiContext(
    orgInput({ isEnterpriseWorkspace: true, canManageBilling: true }),
  );
  assert.equal(contract.billing.contextType, "enterprise-contract");
  assert.equal(contract.billing.scopeLabel, "Organization agreement");
  assert.equal(contract.billing.canManageBilling, true);
  assert.equal(contract.billing.billingHref, null);
});

test("organization-admin links come from SETTINGS_MANAGE and fail closed", () => {
  assert.equal(
    deriveSettingsUiContext(orgInput({ canManageWorkspaceSettings: null }))
      .showOrgAdminLinks,
    false,
  );
  assert.equal(
    deriveSettingsUiContext(orgInput({ canManageWorkspaceSettings: false }))
      .showOrgAdminLinks,
    false,
  );
  const granted = deriveSettingsUiContext(
    orgInput({ canManageWorkspaceSettings: true }),
  );
  assert.equal(granted.showOrgAdminLinks, true);
  assert.equal(granted.orgAdminOrgId, "o-1");
});

test("a PERSONAL workspace never shows organization-admin links", () => {
  const personal = deriveSettingsUiContext({
    activeSpace: { type: "PERSONAL", id: "p-1", displayName: "Personal Space" },
    workspacePlan: "PRO",
    accountPlan: "PRO",
    canManageBilling: true,
    // Personal-space owners hold SETTINGS_MANAGE for their own space; that
    // must not surface ORGANIZATION administration.
    canManageWorkspaceSettings: true,
    isEnterpriseWorkspace: false,
    organizations: [],
    planFeatures: {
      reviewerOperationsIncluded: false,
      aiAssistanceMonthlyOperations: 100,
    },
  });
  assert.equal(personal.showOrgAdminLinks, false);
  assert.equal(personal.orgAdminOrgId, null);
});

// ---------------------------------------------------------------------------
// AI settings — policy-edit authority (was: orgRole === "OWNER" || "ADMIN")
// ---------------------------------------------------------------------------

test("AI governance editing requires the SERVER capability, in every allowance state", () => {
  for (const monthlyAllowance of [null, 0, 100, undefined]) {
    assert.equal(
      deriveAiSettingsMode({
        workspaceKind: "ORGANIZATION",
        monthlyAllowance,
        canManageWorkspaceAiPolicy: false,
      }),
      "org-readonly",
      `allowance ${String(monthlyAllowance)} must not grant editing`,
    );
    assert.equal(
      deriveAiSettingsMode({
        workspaceKind: "ORGANIZATION",
        monthlyAllowance,
        canManageWorkspaceAiPolicy: null,
      }),
      "org-readonly",
      `allowance ${String(monthlyAllowance)} must fail closed while unknown`,
    );
    assert.equal(
      deriveAiSettingsMode({
        workspaceKind: "ORGANIZATION",
        monthlyAllowance,
        canManageWorkspaceAiPolicy: true,
      }),
      "org-governance",
    );
  }
});

// ---------------------------------------------------------------------------
// Surface tier — no role field survives at all
// ---------------------------------------------------------------------------

test("the surface access context carries no role and no plan name", () => {
  const keys = Object.keys(ANONYMOUS_SURFACE_CONTEXT).sort();
  assert.deepEqual(keys, [
    "isEnterpriseWorkspace",
    "isPlatformAdmin",
    "planFeatures",
  ]);
  assert.equal("role" in ANONYMOUS_SURFACE_CONTEXT, false);
  assert.equal("plan" in ANONYMOUS_SURFACE_CONTEXT, false);
});
