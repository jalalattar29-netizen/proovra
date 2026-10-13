/**
 * `billing.manage` — what the web OFFERS agrees with what the API ENFORCES.
 *
 * The envelope's BILLING_MANAGE is now the canonical `billing.manage`
 * (OWNER only — the payer), so for each role the Settings billing action
 * appears exactly when the billing routes would accept it. The AI cost
 * controls (provider budgets) keep their OWN authority,
 * INTELLIGENCE_POLICY_MANAGE (`intelligence.policy.manage`, OWNER/ADMIN), so an
 * administrator keeps them without being handed financial control.
 *
 * Each role's capabilities are taken from the ONE shared authority
 * (`roleHasPermission`), exactly as the server derives the envelope.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { roleHasPermission } from "@proovra/shared";

import { deriveSettingsUiContext } from "../lib/settings/settingsUiContext";
import type { SettingsUiContextInput } from "../lib/settings/settingsUiContext";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ROLES = ["OWNER", "ADMIN", "MEMBER", "VIEWER"] as const;
type Role = (typeof ROLES)[number];

/** The envelope's billing keys for a role, as the server derives them. */
function envelopeFor(role: Role) {
  return {
    BILLING_VIEW: roleHasPermission(role, "billing.read"),
    BILLING_MANAGE: roleHasPermission(role, "billing.manage"),
    INTELLIGENCE_POLICY_MANAGE: roleHasPermission(role, "intelligence.policy.manage"),
  };
}

function input(over: Partial<SettingsUiContextInput>): SettingsUiContextInput {
  return {
    activeSpace: { type: "ORGANIZATION", id: "o-1", displayName: "Acme Legal" },
    workspacePlan: "TEAM",
    accountPlan: "FREE",
    canManageBilling: null,
    canManageWorkspaceSettings: null,
    isEnterpriseWorkspace: false,
    organizations: [{ id: "o-1", name: "Acme Legal", membershipStatus: "ACTIVE", role: "OWNER", plan: "TEAM" }],
    planFeatures: { reviewerOperationsIncluded: true, aiAssistanceMonthlyOperations: 100 },
    ...over,
  };
}

test("the canonical rule per role: only the OWNER manages billing; ADMIN keeps read and AI cost controls", () => {
  assert.deepEqual(envelopeFor("OWNER"), { BILLING_VIEW: true, BILLING_MANAGE: true, INTELLIGENCE_POLICY_MANAGE: true });
  assert.deepEqual(envelopeFor("ADMIN"), { BILLING_VIEW: true, BILLING_MANAGE: false, INTELLIGENCE_POLICY_MANAGE: true });
  assert.deepEqual(envelopeFor("MEMBER"), { BILLING_VIEW: true, BILLING_MANAGE: false, INTELLIGENCE_POLICY_MANAGE: false });
  assert.deepEqual(envelopeFor("VIEWER"), { BILLING_VIEW: false, BILLING_MANAGE: false, INTELLIGENCE_POLICY_MANAGE: false });
});

for (const role of ROLES) {
  test(`Settings (organization workspace), ${role}: the billing action appears only for the payer`, () => {
    const ctx = deriveSettingsUiContext(input({ canManageBilling: envelopeFor(role).BILLING_MANAGE }));
    const expected = role === "OWNER";
    assert.equal(ctx.billing.canManageBilling, expected, role);
    assert.equal(ctx.billing.billingHref, expected ? "/billing" : null, role);
  });
}

test("Settings (Personal Space): the owner is the payer and gets the billing action", () => {
  const ctx = deriveSettingsUiContext(
    input({
      activeSpace: { type: "PERSONAL", id: "p-1", displayName: "Personal" },
      organizations: [],
      canManageBilling: envelopeFor("OWNER").BILLING_MANAGE,
    }),
  );
  assert.equal(ctx.billing.contextType, "personal");
  assert.equal(ctx.billing.billingHref, "/billing");
});

test("an Enterprise contract offers no self-service billing action, even to the owner", () => {
  const ctx = deriveSettingsUiContext(input({ isEnterpriseWorkspace: true, canManageBilling: envelopeFor("OWNER").BILLING_MANAGE }));
  assert.equal(ctx.billing.billingHref, null);
});

test("the AI provider-budget controls read INTELLIGENCE_POLICY_MANAGE, never BILLING_MANAGE", () => {
  const src = readFileSync(join(WEB_ROOT, "components", "intelligence", "ProviderBudgetPanel.tsx"), "utf8");
  assert.ok(src.includes('can("INTELLIGENCE_POLICY_MANAGE")'), "budget form gates on its own authority");
  assert.ok(!src.includes('can("BILLING_MANAGE")'), "budget form no longer borrows BILLING_MANAGE");
});
