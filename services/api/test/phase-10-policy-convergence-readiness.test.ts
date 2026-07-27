/**
 * PHASE 10 §item-2 — EXECUTABLE conflict detection.
 *
 * `checkOrgSecurityPolicyReadiness` queries the conflict view and fails closed on
 * any divergent-conflict Organization. The migration preflight RAISES before any
 * collapsing write, and a deployment readiness command exits non-zero.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { checkOrgSecurityPolicyReadiness } from "../src/services/identity/org-security-policy-readiness.js";

const API = resolve(__dirname, "..");

function stub(conflictRows: Array<{ organization_id: string }>) {
  let called = 0;
  const prisma = {
    $queryRawUnsafe: async () => { called += 1; return conflictRows; },
  } as never;
  return { prisma, calls: () => called };
}

describe("§item-2 — readiness check queries the conflict view", () => {
  it("zero conflicts → ready", async () => {
    const { prisma } = stub([]);
    const r = await checkOrgSecurityPolicyReadiness(prisma);
    expect(r.ready).toBe(true);
    expect(r.conflictOrganizationIds).toEqual([]);
  });

  it("divergent conflicts → NOT ready, returns internal org ids", async () => {
    const { prisma } = stub([{ organization_id: "org-A" }, { organization_id: "org-B" }]);
    const r = await checkOrgSecurityPolicyReadiness(prisma);
    expect(r.ready).toBe(false);
    expect(r.conflictOrganizationIds).toEqual(["org-A", "org-B"]);
  });

  it("repeated preflight is idempotent (pure read, no writes)", async () => {
    const { prisma, calls } = stub([]);
    await checkOrgSecurityPolicyReadiness(prisma);
    await checkOrgSecurityPolicyReadiness(prisma);
    expect(calls()).toBe(2); // read-only each time; no mutation
  });
});

describe("§item-2 — migration preflight + deployment command (source contracts)", () => {
  const MIGRATION = readFileSync(
    resolve(API, "prisma/migrations/20271005000000_org_security_policy_org_scoped/migration.sql"),
    "utf8",
  );
  const COMMAND = readFileSync(resolve(API, "prisma/scripts/org-security-policy-readiness.ts"), "utf8");

  it("the migration RAISES on divergent conflicts BEFORE the collapsing write", () => {
    const preflightIdx = MIGRATION.indexOf("RAISE EXCEPTION 'org_security_policy_convergence_conflict");
    const collapseIdx = MIGRATION.indexOf("UPDATE \"organization_security_policies\" p\nSET \"organization_id\"");
    expect(preflightIdx).toBeGreaterThan(-1);
    // The preflight precedes the collapse UPDATE.
    expect(preflightIdx).toBeLessThan(collapseIdx === -1 ? MIGRATION.length : collapseIdx);
    // Divergent detection uses distinct security-material postures.
    expect(MIGRATION).toMatch(/COUNT\(DISTINCT \(p\."sso_required"/);
  });

  it("the deployment command exits NON-ZERO on conflict and reads the checker", () => {
    expect(COMMAND).toMatch(/checkOrgSecurityPolicyReadiness/);
    expect(COMMAND).toMatch(/process\.exit\(1\)/);
    expect(COMMAND).toMatch(/process\.exit\(0\)/);
  });
});
