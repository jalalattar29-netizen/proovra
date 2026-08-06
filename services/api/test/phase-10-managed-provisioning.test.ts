/**
 * PHASE 10 §3 — ATOMIC managed-identity provisioning through SCIM.
 *
 * Managed identity + membership + grant are ONE atomic orchestrated outcome
 * (one $transaction). The SCIM source is the AUTHENTICATED SCIM token credential
 * (ctx.tokenId), persistence-verified inside setManagedIdentity — never
 * findFirst/caller-declared. SCIM deactivate is NOT releaseManagedIdentity.
 * These are caller/writer-authority + composition invariants → source contracts
 * (the mandate permits structural proof for authority/dependency/bypass).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const API = resolve(__dirname, "..");
const SCIM = readFileSync(resolve(API, "src/services/access-control/scim.service.ts"), "utf8");
const IDMODE = readFileSync(resolve(API, "src/services/identity/identity-mode.service.ts"), "utf8");

describe("§3 — SCIM create binds managed identity ATOMICALLY with membership/grant", () => {
  it("membership + managed binding run inside ONE $transaction via the atomic intent", () => {
    // PHASE 10 §1.1 — the create block now calls the ONE atomic
    // managed-provisioning intent (provisionManagedMembership) inside a single
    // client.$transaction. That intent internally composes setManagedIdentity +
    // seat enforcement + provisionMembership, so a managed conflict or seat
    // exhaustion rolls back the membership too (zero partial).
    const txStart = SCIM.indexOf("client.$transaction(async (tx) =>");
    const managedIdx = SCIM.indexOf("provisionManagedMembership(tx");
    expect(txStart).toBeGreaterThan(-1);
    expect(managedIdx).toBeGreaterThan(txStart);
  });

  it("the SCIM managed source is the AUTHENTICATED token (ctx.tokenId), not findFirst", () => {
    expect(SCIM).toMatch(/evidence:\s*\{\s*source:\s*"SCIM",\s*scimTokenId:\s*ctx\.tokenId\s*\}/);
    // No findFirst-based SCIM connection selection.
    expect(SCIM).not.toMatch(/ssoConnection\.findFirst[\s\S]{0,80}GENERIC_SCIM/);
  });

  it("membership is provisioned ONLY through the Membership Orchestrator (no direct writes)", () => {
    // The atomic intent composes provisionMembership; the non-managed branch
    // still calls it directly. Neither path writes TeamMember directly.
    expect(SCIM).toMatch(/provisionManagedMembership\(|provisionMembership\(/);
    // No direct TeamMember writes in the SCIM create/managed path.
    expect(SCIM).not.toMatch(/teamMember\.(create|upsert)\(/);
  });
});

describe("§3 — SCIM deactivate PRESERVES managed ownership (not releaseManagedIdentity)", () => {
  it("scimDeactivateUser never calls releaseManagedIdentity", () => {
    const deIdx = SCIM.indexOf("export async function scimDeactivateUser");
    expect(deIdx).toBeGreaterThan(-1);
    // releaseManagedIdentity is the explicit unmanage op — never routine SCIM deactivate.
    expect(SCIM).not.toMatch(/releaseManagedIdentity\(/);
  });
});

describe("§3 — persistence-verified evidence (no caller-declared source truth)", () => {
  it("SCIM evidence loads the ScimProvisioningToken and checks ACTIVE + org ownership", () => {
    expect(IDMODE).toMatch(/scimProvisioningToken\.findUnique/);
    expect(IDMODE).toMatch(/status !== "ACTIVE"/);
    // The evidence union carries an id + ceremony, never a caller-asserted org.
    expect(IDMODE).not.toMatch(/scimTenantOrganizationId|verifiedDomainOrganizationId/);
    // SAML/OIDC still load the SsoConnection; DOMAIN loads OrganizationDomain.
    expect(IDMODE).toMatch(/ssoConnection\.findUnique/);
    expect(IDMODE).toMatch(/organizationDomain\.findUnique/);
  });
});

describe("§3 — managed-identity write authority = 1", () => {
  it("only identity-mode.service.ts writes the managed-ownership columns", () => {
    // setManagedIdentity / releaseManagedIdentity (the ONLY managed writers) are
    // defined in the ONE authority; other files only CALL them.
    expect(IDMODE).toMatch(/export async function setManagedIdentity/);
    expect(IDMODE).toMatch(/export async function releaseManagedIdentity/);
    // scim.service DELEGATES to the authority — it does not re-implement it.
    //
    // PHASE 10 §1.1 folded the direct `setManagedIdentity` call into the ONE
    // atomic intent `provisionManagedMembership`, which composes it inside the
    // same $transaction as membership + seat enforcement. So SCIM no longer
    // imports the writer by name. The invariant was never "SCIM imports this
    // symbol" — it is "SCIM does not write managed ownership itself", which is
    // what the delegation check plus the negative below assert.
    expect(SCIM).toMatch(/provisionManagedMembership\(/);
    expect(SCIM).not.toMatch(/identityMode:\s*"MANAGED_ENTERPRISE"[\s\S]{0,60}user\.update/);
    expect(SCIM).not.toMatch(/managedByOrganizationId:\s*[\s\S]{0,40}user\.update/);
  });
});
