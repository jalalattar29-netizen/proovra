/**
 * AUD-31 (2026-10-20) — organization report exports are gated by EXPLICIT
 * role sets, not by rank. Live PostgreSQL 16, the real routes.
 *
 * ORG_SECURITY_ADMIN and ORG_BILLING_ADMIN share rank 3, so a minimum-rank
 * gate admitted the wrong specialist: a security admin downloaded the billing
 * seats export, and a billing admin downloaded the audit, governance,
 * external-access and download-audit exports.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "../integration-harness.js";

describe("AUD-31 org report exports by explicit role (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../../src/db.js"))["prisma"];
  let orgA: string;
  const tokens: Record<string, string> = {};

  async function orgMember(organizationId: string, userId: string, role: string) {
    await prisma.organizationMembership.upsert({
      where: { organization_memberships_org_user_uniq: { organizationId, userId } },
      create: { organizationId, userId, role: role as never },
      update: { role: role as never },
    });
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    const A = h.fixtures.teamA;
    orgA = (await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } })).organizationId;
    await prisma.team.update({ where: { id: A.teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } });
    const { upsertEnterpriseContract } = await import("../../src/services/organization/enterprise-contract.service.js");
    await upsertEnterpriseContract(prisma as never, { organizationId: orgA, status: "ACTIVE", activationState: "ACTIVATED", seatCount: 25 });
    await orgMember(orgA, A.adminUserId, "ORG_SECURITY_ADMIN");
    await orgMember(orgA, A.memberUserId, "ORG_BILLING_ADMIN");
    await orgMember(orgA, A.viewerUserId, "ORG_AUDITOR");
    tokens.ORG_OWNER = A.ownerToken;
    tokens.ORG_SECURITY_ADMIN = A.adminToken;
    tokens.ORG_BILLING_ADMIN = A.memberToken;
    tokens.ORG_AUDITOR = A.viewerToken;
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  const get = (file: string, role: string) =>
    h.app.inject({ method: "GET", url: `/v1/orgs/${orgA}/reports/${file}`, headers: { authorization: `Bearer ${tokens[role]}` } });

  const MATRIX: Array<[file: string, allowed: string[], denied: string[]]> = [
    ["seats.csv", ["ORG_OWNER", "ORG_BILLING_ADMIN"], ["ORG_SECURITY_ADMIN", "ORG_AUDITOR"]],
    ["audit.csv", ["ORG_OWNER", "ORG_SECURITY_ADMIN", "ORG_AUDITOR"], ["ORG_BILLING_ADMIN"]],
    ["governance.csv", ["ORG_OWNER", "ORG_SECURITY_ADMIN", "ORG_AUDITOR"], ["ORG_BILLING_ADMIN"]],
    ["external-access.csv", ["ORG_OWNER", "ORG_SECURITY_ADMIN", "ORG_AUDITOR"], ["ORG_BILLING_ADMIN"]],
    ["download-audit.csv", ["ORG_OWNER", "ORG_SECURITY_ADMIN", "ORG_AUDITOR"], ["ORG_BILLING_ADMIN"]],
    ["members.csv", ["ORG_OWNER", "ORG_SECURITY_ADMIN", "ORG_BILLING_ADMIN", "ORG_AUDITOR"], []],
  ];

  for (const [file, allowed, denied] of MATRIX) {
    it(`${file}: ${allowed.join(", ")} may export; ${denied.join(", ") || "no other org role"} may not`, async () => {
      for (const role of allowed) {
        const res = await get(file, role);
        expect(res.statusCode, `${role} ${file}: ${res.body.slice(0, 200)}`).toBe(200);
      }
      for (const role of denied) {
        const res = await get(file, role);
        expect(res.statusCode, `${role} ${file}`).toBe(403);
        expect(JSON.parse(res.body).error.code).toBe("forbidden");
      }
    });
  }
});
