/**
 * `billing.manage` — the native Settings billing action agrees with the API.
 *
 * The envelope's BILLING_MANAGE is the canonical `billing.manage` (OWNER only,
 * the payer). For each role, Settings offers "open billing" exactly when the
 * billing routes would accept the request; a Personal Space owner is the payer
 * of their own account and is offered it. Each role's capabilities come from
 * the ONE shared authority, as the server derives them.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./support/render.mjs";

let S;
let roleHasPermission;
before(async () => {
  S = await loadModule("src/product/settings-overview.ts", []);
  ({ roleHasPermission } = await import("@proovra/shared"));
});

const caps = (role) => ({
  BILLING_VIEW: roleHasPermission(role, "billing.read"),
  BILLING_MANAGE: roleHasPermission(role, "billing.manage"),
});

const orgEnvelope = (role, over = {}) => ({
  activeSpace: { type: "ORGANIZATION", id: "o-1", displayName: "Acme Legal", plan: "TEAM" },
  organizations: [{ id: "o-1", name: "Acme Legal", membershipStatus: "ACTIVE", role, plan: "TEAM" }],
  capabilities: caps(role),
  flags: { isEnterpriseWorkspace: false },
  account: { accountPlan: "FREE" },
  ...over,
});

for (const role of ["OWNER", "ADMIN", "MEMBER", "VIEWER"]) {
  test(`organization workspace, ${role}: the billing action is offered only to the payer`, () => {
    const o = S.projectSettingsOverview(orgEnvelope(role));
    assert.equal(o.billing.canOpenBilling, role === "OWNER", role);
  });
}

test("Personal Space owner: the payer is offered their own billing", () => {
  const o = S.projectSettingsOverview({
    activeSpace: { type: "PERSONAL", id: "p-1", displayName: "Personal" },
    organizations: [],
    capabilities: caps("OWNER"),
    account: { accountPlan: "PRO" },
  });
  assert.equal(o.billing.contextType, "personal");
  assert.equal(o.billing.canOpenBilling, true);
});

test("an Enterprise contract offers no self-service billing action, even to the owner", () => {
  const o = S.projectSettingsOverview(orgEnvelope("OWNER", { flags: { isEnterpriseWorkspace: true } }));
  assert.equal(o.billing.canOpenBilling, false);
});
