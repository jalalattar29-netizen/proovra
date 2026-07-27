/**
 * Organization ownership transfer + closure contracts (lifecycle Phase 6,
 * 2026-07-17).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, rel), "utf8");
const ROUTES = read("../src/routes/organizations.routes.ts");
const PREFLIGHT = read(
  "../src/services/identity/account-lifecycle-preflight.service.ts",
);
const CLOSURE = read("../src/services/organization/org-closure.service.ts");
const ORG_ACCESS = read("../src/services/organization/org-access.ts");
const ORG_AUDIT = read("../src/services/organization/org-audit.service.ts");
const SCHEDULER = read("../src/services/notifications/digest-scheduler.ts");
const MIGRATION = read(
  "../prisma/migrations/20270921000000_organization_closure_requests/migration.sql",
);

describe("ownership transfer", () => {
  it("is ORG_OWNER-only and step-up gated with a dedicated action", () => {
    expect(ROUTES).toMatch(
      /\/v1\/orgs\/:id\/transfer-ownership[\s\S]{0,900}minRole:\s*"ORG_OWNER"/,
    );
    expect(ROUTES).toMatch(/"org_ownership_transfer"/);
  });

  it("target must be an existing member; self-transfer is rejected", () => {
    expect(ROUTES).toMatch(/target_not_member/);
    expect(ROUTES).toMatch(/transfer_to_self/);
  });

  it("swaps roles atomically in ONE transaction (never zero or two owners)", () => {
    const transferStart = ROUTES.indexOf("/v1/orgs/:id/transfer-ownership");
    const block = ROUTES.slice(transferStart, transferStart + 6000);
    expect(block).toMatch(/\$transaction/);
    // PHASE 3: atomic swap via the canonical orchestrator (both legs in
    // the same tx, provenance-recorded).
    expect(block).toMatch(/role:\s*"ORG_OWNER"/);
    expect(block).toMatch(/role:\s*"ORG_ADMIN"/);
    expect(block).toMatch(/updateOrganizationMembershipRole/);
  });

  it("billing ownership follows the owner when it pointed at the caller", () => {
    expect(ROUTES).toMatch(/billingOwnerUserId === userId/);
    expect(ROUTES).toMatch(/billingOwnerUserId:\s*body\.targetUserId/);
  });

  it("audited in the org stream and on BOTH parties' personal timelines", () => {
    expect(ORG_AUDIT).toMatch(/"ORG_OWNERSHIP_TRANSFERRED"/);
    expect(ROUTES).toMatch(/ORG_OWNERSHIP_TRANSFERRED/);
    expect(ROUTES).toMatch(/\["previous_owner"|"previous_owner"\]/);
    expect(ROUTES).toMatch(/"new_owner"/);
    expect(ROUTES).toMatch(/identity\.organization_ownership_transferred/);
  });
});

describe("organization closure preflight", () => {
  it("carries the four stable blocker codes", () => {
    expect(PREFLIGHT).toMatch(/"ORG_MEMBERS_ACTIVE"/);
    expect(PREFLIGHT).toMatch(/"BILLING_CONTRACT_ACTIVE"/);
    expect(PREFLIGHT).toMatch(/"PERSONAL_WORKSPACE_ORGANIZATION"/);
    expect(PREFLIGHT).toMatch(/evaluateOrganizationClosurePreflight/);
  });

  it("personal-workspace organizations can never close via org closure", () => {
    expect(PREFLIGHT).toMatch(/isPersonal:\s*true/);
  });

  it("active billing (incl. sales-led ENTERPRISE contract) blocks closure", () => {
    expect(PREFLIGHT).toMatch(/billingStatus:\s*\{\s*in:\s*\["ACTIVE",\s*"PAST_DUE"\]\s*\}/);
  });
});

describe("organization closure routes", () => {
  it("are ORG_OWNER-only with typed confirmation validated server-side", () => {
    expect(ROUTES).toMatch(
      /ORG_CLOSURE_CONFIRMATION_PHRASE = "close this organization"/,
    );
    expect(ROUTES).toMatch(/"org_closure_request"/);
    // Every closure route resolves owner access before acting.
    const closureStart = ROUTES.indexOf('"/v1/orgs/:id/closure"');
    const closureBlock = ROUTES.slice(closureStart);
    expect(
      (closureBlock.match(/minRole:\s*"ORG_OWNER"/g) ?? []).length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("one open request per org; cancel is status-guarded", () => {
    expect(ROUTES).toMatch(/closure_request_active/);
    expect(ROUTES).toMatch(/CANCELLABLE_ORG_CLOSURE_STATUSES/);
    expect(ROUTES).toMatch(/closure_not_cancellable/);
  });
});

describe("closure execution", () => {
  it("worker re-runs preflight and claims atomically", () => {
    expect(CLOSURE).toMatch(
      /evaluateOrganizationClosurePreflight\([\s\S]{0,600}status:\s*"BLOCKED"/,
    );
    expect(CLOSURE).toMatch(/if \(claimed\.count === 0\) continue;/);
    expect(SCHEDULER).toMatch(/processOrganizationClosures\(now\)/);
  });

  it("ARCHIVES the org and checkOrgAccess denies archived AND suspended orgs", () => {
    expect(CLOSURE).toMatch(/data:\s*\{\s*status:\s*"ARCHIVED"\s*\}/);
    // PHASE 4 §7.6 (2026-07-22) — SUSPENDED joined ARCHIVED in the deny.
    expect(ORG_ACCESS).toMatch(
      /org\.status === "ARCHIVED" \|\| org\.status === "SUSPENDED"/,
    );
  });

  it("revokes workspace memberships + machine credentials/webhooks", () => {
    // PHASE 3: closure revocation via the canonical mass helper.
    expect(CLOSURE).toMatch(/massRevokeWorkspaceMemberships/);
    expect(CLOSURE).toMatch(/apiCredential\.updateMany[\s\S]{0,300}"REVOKED"/);
    expect(CLOSURE).toMatch(/webhookEndpoint\.updateMany[\s\S]{0,200}"DISABLED"/);
  });

  it("NEVER deletes evidence, teams, orgs, or memberships", () => {
    expect(CLOSURE).not.toMatch(/\.delete\(|deleteMany\(/);
  });

  it("closure lifecycle is fully audited in both streams", () => {
    for (const t of [
      "ORG_CLOSURE_REQUESTED",
      "ORG_CLOSURE_BLOCKED",
      "ORG_CLOSURE_CANCELLED",
      "ORG_CLOSURE_COMPLETED",
    ]) {
      expect(ORG_AUDIT).toMatch(new RegExp(`"${t}"`));
    }
    expect(CLOSURE).toMatch(/identity\.organization_closure_completed/);
    expect(CLOSURE).toMatch(/identity\.organization_closure_failed/);
  });
});

describe("migration", () => {
  it("is additive-only", () => {
    expect(MIGRATION).toMatch(
      /CREATE TABLE IF NOT EXISTS "organization_closure_requests"/,
    );
    expect(MIGRATION).not.toMatch(/DROP |TRUNCATE|DELETE FROM|RENAME/i);
  });
});
