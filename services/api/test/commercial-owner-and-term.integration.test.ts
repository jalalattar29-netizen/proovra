/**
 * The rest of the commercial batch, on real routes and a real PostgreSQL:
 * PROV-005 (an owner invite that died), PROV-013 (what a customer is told),
 * BILLING-009 (a stated end date, behind the switch), BILLING-010 (the seat count
 * a contract customer reads), PROV-017 (what a lead keeps).
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Prisma = import("@prisma/client").PrismaClient;

describe("owner invite, notice, term and lead (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let fixtures: typeof import("./point7/product-fixtures.js");
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let steps: typeof import("./helpers/operator-step-up.js");
  let provisioning: typeof import("../src/services/enterprise-provisioning.service.js");
  let seeded = 0;
  const tag = () => randomUUID().slice(0, 8);
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const switchName = "BILLING_AUTO_PLAN_LOWERING";

  const deps = () => ({
    prisma: prisma as never,
    tag: `coat-${tag()}`,
    mintToken: (userId: string, email: string) =>
      signJwt(
        { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
        process.env.AUTH_JWT_SECRET as string,
        3600,
      ),
  });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as Prisma;
    fixtures = await import("./point7/product-fixtures.js");
    ({ signJwt } = await import("../src/services/jwt.js"));
    steps = await import("./helpers/operator-step-up.js");
    provisioning = await import("../src/services/enterprise-provisioning.service.js");
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  afterEach(() => {
    delete process.env[switchName];
  });

  async function operatorId() {
    seeded += 1;
    return steps.seedOperator(h, deps(), prisma, `coat-operator-${seeded}`);
  }

  async function operatorCall(
    method: "POST" | "PATCH",
    url: string,
    orgId: string,
    payload: Record<string, unknown> = {},
    resourceKind = "organization",
  ) {
    const acting = await operatorId();
    const challengeId = await steps.approvedStepUp(h, acting, "CAPABILITY_GRANT", resourceKind, orgId);
    return h.app.inject({
      method,
      url,
      headers: { ...bearer(acting.token), "x-proovra-step-up-challenge-id": challengeId },
      payload: { teamId: acting.stepUpTeamId, ...payload },
    });
  }

  async function provision(seats = 10) {
    const d = deps();
    const owner = await fixtures.seedUser(d, "owner");
    const actor = await operatorId();
    const { result } = await provisioning.provisionEnterpriseCustomerIdempotent(
      {
        organizationName: `Customer ${tag()}`,
        ownerEmail: owner.email,
        seats,
        actorUserId: actor.userId,
        idempotencyKey: `coat-${randomUUID()}`,
      },
      prisma,
    );
    const r = result as { organizationId: string; ownerInviteToken: string };
    return { owner, orgId: r.organizationId, token: r.ownerInviteToken };
  }

  const accept = (token: string, ownerToken: string) =>
    h.app.inject({ method: "POST", url: `/v1/org-invites/${token}/accept`, headers: bearer(ownerToken) });

  async function customer(seats = 10) {
    const p = await provision(seats);
    const accepted = await accept(p.token, p.owner.token);
    expect(accepted.statusCode, accepted.body).toBe(200);
    return { ...p, workspaceId: (accepted.json() as { enterpriseWorkspaceId: string }).enterpriseWorkspaceId };
  }

  describe("PROV-005", () => {
    it("an expired owner invite is reissued to the same organization, the old link is dead, and acceptance completes once", async () => {
      const p = await provision();
      await prisma.organizationInvite.updateMany({
        where: { organizationId: p.orgId },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      const expired = await accept(p.token, p.owner.token);
      expect(expired.statusCode).toBeGreaterThanOrEqual(400);

      // The owner cannot rescue their own invitation: there is no membership yet.
      const self = await h.app.inject({
        method: "POST",
        url: `/v1/admin/orgs/${p.orgId}/owner-invite/reissue`,
        headers: bearer(p.owner.token),
        payload: { teamId: randomUUID() },
      });
      expect(self.statusCode).toBe(403);

      const organizations = await prisma.organization.count({ where: { id: p.orgId } });
      const reissued = await operatorCall("POST", `/v1/admin/orgs/${p.orgId}/owner-invite/reissue`, p.orgId);
      expect(reissued.statusCode, reissued.body).toBeLessThan(300);
      const { inviteUrl } = reissued.json() as { inviteUrl: string };
      const reissuedToken = inviteUrl.split("/")[2]!;
      expect(reissuedToken).toBeTruthy();
      expect(reissuedToken).not.toBe(p.token);
      expect(await prisma.organization.count({ where: { id: p.orgId } })).toBe(organizations);

      const accepted = await accept(reissuedToken, p.owner.token);
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(
        await prisma.organizationMembership.count({ where: { organizationId: p.orgId, role: "ORG_OWNER", status: "ACTIVE" } }),
      ).toBe(1);
      expect(await prisma.team.count({ where: { organizationId: p.orgId } })).toBe(1);
      expect(
        await prisma.organizationAuditEvent.count({
          where: { organizationId: p.orgId, eventType: "ENTERPRISE_OWNER_INVITE_REISSUED" },
        }),
      ).toBe(1);

      const again = await operatorCall("POST", `/v1/admin/orgs/${p.orgId}/owner-invite/reissue`, p.orgId);
      expect(again.statusCode).toBe(409);
      expect((again.json() as { error: { code: string } }).error.code).toBe("OWNER_NOT_PENDING");
    });
  });

  describe("PROV-013", () => {
    it("scheduling tells the owner and leaves a platform audit row; withdrawing records it too", async () => {
      const t = await customer();
      const scheduled = await operatorCall("POST", `/v1/admin/orgs/${t.orgId}/terminate`, t.orgId, {
        reason: "contract ended by agreement",
      });
      expect(scheduled.statusCode, scheduled.body).toBeLessThan(300);
      expect(
        await prisma.adminAuditLog.count({
          where: { action: "identity.organization_termination_scheduled", organizationId: t.orgId },
        }),
      ).toBe(1);
      expect(
        await prisma.notificationDelivery.count({
          where: { recipientUserId: t.owner.userId, eventType: "ORGANIZATION_TERMINATION_SCHEDULED" },
        }),
      ).toBe(1);

      const withdrawn = await operatorCall("POST", `/v1/admin/orgs/${t.orgId}/terminate/cancel`, t.orgId);
      expect(withdrawn.statusCode, withdrawn.body).toBeLessThan(300);
      expect(
        await prisma.adminAuditLog.count({
          where: { action: "identity.organization_termination_withdrawn", organizationId: t.orgId },
        }),
      ).toBe(1);
    });
  });

  describe("BILLING-009 — a stated end date", () => {
    const newEvidence = (workspaceId: string, token: string) =>
      h.app.inject({
        method: "POST",
        url: "/v1/evidence",
        headers: bearer(token),
        payload: { type: "PHOTO", mimeType: "image/png", originalFileName: "a.png", teamId: workspaceId },
      });

    it("with the switch off the date is a recorded term; with it on the contract grants nothing; moving the date restores it", async () => {
      const t = await customer();
      await prisma.enterpriseContract.update({
        where: { organizationId: t.orgId },
        data: { effectiveAtUtc: new Date(Date.now() - 86_400_000 * 30), endsAtUtc: new Date(Date.now() - 86_400_000) },
      });
      const held = await newEvidence(t.workspaceId, t.owner.token);
      expect(held.statusCode, held.body).toBeLessThan(300);

      process.env[switchName] = "on";
      const ended = await newEvidence(t.workspaceId, t.owner.token);
      expect(ended.statusCode, ended.body).toBe(409);
      expect(ended.body).toContain("ENTERPRISE_CONTRACT_REQUIRED");

      await prisma.enterpriseContract.update({
        where: { organizationId: t.orgId },
        data: { endsAtUtc: new Date(Date.now() + 86_400_000) },
      });
      const restored = await newEvidence(t.workspaceId, t.owner.token);
      expect(restored.statusCode, restored.body).toBeLessThan(300);
      expect((await prisma.enterpriseContract.findUniqueOrThrow({ where: { organizationId: t.orgId } })).status).toBe("ACTIVE");
    });
  });

  describe("BILLING-010", () => {
    it("the quota view reports the contract's seats and the real member count, not a personal figure", async () => {
      const t = await customer(40);
      const res = await h.app.inject({ method: "GET", url: "/v1/quotas", headers: bearer(t.owner.token) });
      expect(res.statusCode, res.body).toBe(200);
      const { resolveWorkspaceSeatState } = await import("../src/services/billing/workspace-seats.service.js");
      const authority = await resolveWorkspaceSeatState(t.workspaceId, prisma);
      expect(authority.limit).toBe(40);
      expect((res.json() as { data: { teamMembers: unknown } }).data.teamMembers).toEqual({
        limit: authority.limit,
        used: authority.used,
        remaining: authority.remaining,
      });
    });
  });

  describe("PROV-017", () => {
    it("a demo request keeps what the visitor answered and where they came from, and the response gives away no scoring", async () => {
      const email = `lead-${tag()}@fixture-customer.test`;
      const res = await h.app.inject({
        method: "POST",
        url: "/v1/demo-requests",
        remoteAddress: `10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
        payload: {
          fullName: "Lead Person",
          workEmail: email,
          organization: "Fixture Claims",
          useCase: "We need defensible evidence for insurance claims.",
          primaryInterest: "claims",
          organizationType: "insurer",
          source: "pricing",
          utmCampaign: "autumn",
        },
      });
      expect(res.statusCode, res.body).toBeLessThan(300);
      const row = await prisma.demoRequest.findFirstOrThrow({ where: { workEmail: email } });
      expect(row).toMatchObject({ primaryInterest: "claims", organizationType: "insurer", source: "pricing", utmCampaign: "autumn" });
      const exposed = JSON.stringify(res.json());
      for (const hidden of ["isSpam", "priority", "leadQuality", "routingTarget"]) expect(exposed).not.toContain(hidden);
    });
  });
});
