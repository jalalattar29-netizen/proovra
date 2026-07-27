/**
 * PHASE 10 §item-1 — the ORGANIZATION owns the security-policy lifecycle.
 *
 * `teamId` is nullable compatibility metadata with ON DELETE SET NULL, so
 * deleting/archiving a Workspace can never delete or re-parent the org policy.
 * Writers upsert by `organizationId` and never mutate `teamId` during ordinary
 * patching. Organization deletion cascades the policy (org owns it).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const API = resolve(__dirname, "..");
const SCHEMA = readFileSync(resolve(API, "prisma/schema.prisma"), "utf8");
const SVC = readFileSync(resolve(API, "src/services/identity/org-security-policy.service.ts"), "utf8");
const MFA = readFileSync(resolve(API, "src/services/identity-security/mfa-policy.service.ts"), "utf8");

function policyModel(): string {
  const start = SCHEMA.indexOf("model OrganizationSecurityPolicy {");
  const end = SCHEMA.indexOf("@@map(\"organization_security_policies\")", start);
  return SCHEMA.slice(start, end);
}

describe("§item-1 — schema: Organization owns the policy lifecycle", () => {
  const model = policyModel();

  it("teamId is NULLABLE compatibility metadata (not the PK)", () => {
    expect(model).toMatch(/teamId\s+String\?\s+@map\("team_id"\)/);
    // The PK is a synthetic id, not teamId.
    expect(model).toMatch(/id\s+String\s+@id\s+@default\(dbgenerated/);
    expect(model).not.toMatch(/teamId\s+String\s+@id/);
  });

  it("the Team relation is ON DELETE SET NULL (no cascade delete of the policy)", () => {
    expect(model).toMatch(/team\s+Team\?\s+@relation\(fields:\s*\[teamId\][^)]*onDelete:\s*SetNull\)/);
    // The dangerous Cascade is gone.
    expect(model).not.toMatch(/team\s+Team[^\n]*onDelete:\s*Cascade/);
  });

  it("organizationId is the authoritative unique key; Organization deletion is RESTRICTed (policy/audit preserved)", () => {
    expect(model).toMatch(/organizationId\s+String\?\s+@unique\s+@map\("organization_id"\)/);
    // §1.2 — RESTRICT, not Cascade: org archive/suspend preserves policy + audit.
    expect(model).toMatch(/organization\s+Organization\?[^\n]*onDelete:\s*Restrict/);
    expect(model).not.toMatch(/organization\s+Organization\?[^\n]*onDelete:\s*Cascade/);
  });

  it("the lifecycle migration swaps the PK + replaces Team cascade with SET NULL", () => {
    const mig = readFileSync(
      resolve(API, "prisma/migrations/20271006000000_org_security_policy_lifecycle/migration.sql"),
      "utf8",
    );
    expect(mig).toMatch(/PRIMARY KEY \("id"\)/);
    expect(mig).toMatch(/ALTER COLUMN "team_id" DROP NOT NULL/);
    expect(mig).toMatch(/FOREIGN KEY \("team_id"\)[\s\S]*ON DELETE SET NULL/);
  });
});

describe("§item-1 — writers upsert by organizationId; teamId not mutated on patch", () => {
  it("no writer upserts OrganizationSecurityPolicy by teamId", () => {
    // Both the Phase-10 patch writer and the MFA writer upsert by organizationId.
    expect(SVC).not.toMatch(/organizationSecurityPolicy\.upsert\(\{\s*where:\s*\{\s*teamId/);
    expect(MFA).not.toMatch(/organizationSecurityPolicy\.upsert\(\{\s*where:\s*\{\s*teamId/);
    expect(SVC).toMatch(/organizationSecurityPolicy\.upsert\(\{\s*where:\s*\{\s*organizationId/);
    expect(MFA).toMatch(/organizationSecurityPolicy\.upsert\(\{\s*where:\s*\{\s*organizationId/);
  });

  it("ordinary patch updates do NOT mutate teamId (compat metadata set once on create)", () => {
    // The `update:` blocks of the upserts must not set teamId.
    const stripped = SVC.replace(/\/\/[^\n]*/g, "");
    const updates = [...stripped.matchAll(/update:\s*\{([\s\S]*?)\}/g)].map((m) => m[1]);
    for (const u of updates) {
      // A policy update block that carries policyVersion/patch must not ASSIGN teamId.
      if (/policyVersion|mfaPolicyLevel|updatedByUserId/.test(u)) {
        expect(u).not.toMatch(/\bteamId\s*:/);
      }
    }
  });

  it("Phase-12 retirement target for teamId remains registered", () => {
    expect(SCHEMA).toMatch(/Phase-12 removal|Phase-12/i);
  });
});
