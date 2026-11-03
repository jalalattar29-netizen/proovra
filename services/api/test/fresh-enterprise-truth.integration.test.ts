/**
 * WHAT THE FRESH-ENTERPRISE JOURNEY FOUND, THROUGH THE REAL ROUTES.
 *
 *   - Bulk invite gives the workspace the batch names, through the same accept
 *     transaction as a single invite, and refuses another tenant's workspace.
 *   - Retention posture counts every policy in force, in both tables.
 *   - The security policy read states the MFA level sign-in enforces.
 *
 * FIXTURES (labelled): the tenants come from seedOrganizationTenant and the
 * template policy from its real service function. Everything asserted is a route
 * answer plus the row it left.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { coverageKit, type CoverageKit, type Person } from "./support/coverage-actors.js";

type Prisma = import("@prisma/client").PrismaClient;

describe("fresh-enterprise repairs (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let kit: CoverageKit;
  let templates: typeof import("../src/services/lifecycle/retention-engine.service.js");
  let named: typeof import("../src/services/governance-lifecycle/retention-engine.service.js");

  let orgId: string;
  let teamId: string;
  let ownerUserId: string;
  let owner: Person;
  let member: Person;
  let otherOrgId: string;
  let otherTeamId: string;
  let otherOwner: Person;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as Prisma;
    templates = await import("../src/services/lifecycle/retention-engine.service.js");
    named = await import("../src/services/governance-lifecycle/retention-engine.service.js");
    kit = await coverageKit(h);
    const { signJwt } = await import("../src/services/jwt.js");
    const fixtures = await import("./point7/product-fixtures.js");
    const mintToken = (userId: string, email: string) =>
      signJwt(
        { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
        process.env.AUTH_JWT_SECRET as string,
        3600,
      );
    const tenant = await fixtures.seedOrganizationTenant({ prisma: prisma as never, tag: `fet-${kit.tag()}`, mintToken });
    orgId = tenant.organizationId;
    teamId = tenant.workspaceId;
    ownerUserId = tenant.owner.userId;
    const ownerRow = await prisma.user.findUniqueOrThrow({ where: { id: ownerUserId }, select: { email: true } });
    owner = { id: ownerUserId, email: ownerRow.email ?? "", token: mintToken(ownerUserId, ownerRow.email ?? "") };
    member = await kit.person(teamId, "MEMBER");
    await prisma.organizationMembership.create({ data: { organizationId: orgId, userId: member.id, role: "ORG_MEMBER" } });

    const other = await fixtures.seedOrganizationTenant({ prisma: prisma as never, tag: `fet-${kit.tag()}`, mintToken });
    otherOrgId = other.organizationId;
    otherTeamId = other.workspaceId;
    const otherRow = await prisma.user.findUniqueOrThrow({ where: { id: other.owner.userId }, select: { email: true } });
    otherOwner = { id: other.owner.userId, email: otherRow.email ?? "", token: mintToken(other.owner.userId, otherRow.email ?? "") };
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  async function inviteRows(email: string) {
    return prisma.organizationInvite.findMany({
      where: { organizationId: orgId, email },
      select: { id: true, workspaceAssignments: true },
    });
  }

  describe("bulk invite", () => {
    const body = (email: string, assignedTeamId: string, role = "VIEWER") => ({
      defaultRole: "ORG_MEMBER",
      rows: [{ email }],
      workspaceAssignments: [{ teamId: assignedTeamId, role }],
    });

    it("the accepted invitation holds the workspace the batch named, at that access", async () => {
      const invitee = await kit.person(null);
      await prisma.user.update({ where: { id: invitee.id }, data: { emailVerifiedAt: new Date() } as never });
      const sent = await kit.call("POST", `/v1/orgs/${orgId}/invites/bulk`, owner, body(invitee.email, teamId));
      expect(sent.statusCode).toBe(200);
      const row = sent.json().rows[0];
      expect(row.outcome).toBe("INVITED");
      expect((await inviteRows(invitee.email))[0]?.workspaceAssignments).toEqual([{ teamId, role: "VIEWER" }]);

      const accepted = await kit.call("POST", `/v1/org-invites/${row.token}/accept`, invitee, {});
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(accepted.json().assignedWorkspaceIds).toEqual([teamId]);
      const seat = await prisma.teamMember.findFirst({ where: { teamId, userId: invitee.id, status: "ACTIVE" } });
      expect(seat?.role).toBe("VIEWER");
    });

    it("a CSV batch carries the same assignment", async () => {
      const email = `fet-csv-${kit.tag()}@test.proovra.local`;
      const res = await kit.call("POST", `/v1/orgs/${orgId}/invites/csv`, owner, {
        csv: `email,role\r\n${email},ORG_MEMBER\r\n`,
        workspaceAssignments: [{ teamId, role: "MEMBER" }],
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().rows[0].outcome).toBe("INVITED");
      expect((await inviteRows(email))[0]?.workspaceAssignments).toEqual([{ teamId, role: "MEMBER" }]);
    });

    it("a batch naming no workspace stays governance-only", async () => {
      const email = `fet-gov-${kit.tag()}@test.proovra.local`;
      const res = await kit.call("POST", `/v1/orgs/${orgId}/invites/bulk`, owner, { rows: [{ email }] });
      expect(res.json().rows[0].outcome).toBe("INVITED");
      expect((await inviteRows(email))[0]?.workspaceAssignments ?? null).toBeNull();
    });

    it("another tenant's workspace is refused on all three doors, and no invite is written", async () => {
      const email = `fet-x-${kit.tag()}@test.proovra.local`;
      const refused = [
        await kit.call("POST", `/v1/orgs/${orgId}/invites/bulk/validate`, owner, body(email, otherTeamId)),
        await kit.call("POST", `/v1/orgs/${orgId}/invites/bulk`, owner, body(email, otherTeamId)),
        await kit.call("POST", `/v1/orgs/${orgId}/invites/csv`, owner, {
          csv: `email\r\n${email}\r\n`,
          workspaceAssignments: [{ teamId: otherTeamId, role: "ADMIN" }],
        }),
      ];
      for (const res of refused) {
        expect(res.statusCode, res.body).toBe(400);
        expect(res.json().code).toBe("invalid_workspace_assignment");
      }
      expect(await inviteRows(email)).toEqual([]);
    });

    it("a dry run writes nothing, and a plain member cannot send a batch", async () => {
      const email = `fet-dry-${kit.tag()}@test.proovra.local`;
      const dry = await kit.call("POST", `/v1/orgs/${orgId}/invites/bulk/validate`, owner, body(email, teamId));
      expect(dry.statusCode).toBe(200);
      expect(dry.json().rows[0].outcome).toBe("WOULD_INVITE");
      const denied = await kit.call("POST", `/v1/orgs/${orgId}/invites/bulk`, member, body(email, teamId));
      expect(denied.statusCode).toBe(403);
      expect(await inviteRows(email)).toEqual([]);
    });
  });

  describe("retention posture", () => {
    const center = async (who: Person, id: string) => {
      const res = await kit.call("GET", `/v1/orgs/${id}/governance/control-center`, who);
      expect(res.statusCode, res.body).toBe(200);
      return res.json().sections;
    };

    it("starts empty, counts a template policy, then both tables, and no other tenant's", async () => {
      expect((await center(owner, orgId)).retention.data.activePolicyCount).toBe(0);
      expect((await center(owner, orgId)).coverage.data.retentionCoveredWorkspaceCount).toBe(0);

      // What the setup wizard's POST /v1/lifecycle/retention/policies calls.
      const made = await templates.createRetentionPolicy({
        prisma,
        teamId,
        name: "Insurance (default)",
        template: "INSURANCE_7Y",
        scopeKind: "WORKSPACE",
        scopeTargetId: teamId,
        createdByUserId: ownerUserId,
      });
      expect(made.ok).toBe(true);

      const one = await center(owner, orgId);
      expect(one.retention.data.activePolicyCount).toBe(1);
      expect(one.retention.data.workspacesWithPolicyCount).toBe(1);
      expect(one.coverage.data.retentionCoveredWorkspaceCount).toBe(1);
      expect(one.retention.data.sample[0]).toMatchObject({
        displayName: "Insurance (default)",
        source: "LIFECYCLE_TEMPLATE",
        retentionYears: 7,
      });

      await named.createRetentionPolicy({
        teamId,
        displayName: "Named policy",
        scope: "WORKSPACE",
        retentionDays: 365,
        actorUserId: ownerUserId,
      } as never);
      const two = await center(owner, orgId);
      expect(two.retention.data.activePolicyCount).toBe(2);
      expect(two.retention.data.workspacesWithPolicyCount).toBe(1);

      const tab = await kit.call("GET", `/v1/orgs/${orgId}/policies/retention`, owner);
      expect(tab.json().workspacePolicies).toEqual({ activePolicyCount: 2, workspacesWithPolicyCount: 1 });

      const dashboard = await kit.call("GET", `/v1/governance/dashboard?teamId=${teamId}`, owner);
      expect(dashboard.statusCode, dashboard.body).toBe(200);
      expect(dashboard.json().retention.activePoliciesCount).toBe(2);

      const pageA = await kit.call("GET", `/v1/governance/retention-policies?teamId=${teamId}`, owner);
      expect(pageA.json().lifecycleTemplateCount).toBe(1);

      expect((await center(otherOwner, otherOrgId)).retention.data.activePolicyCount).toBe(0);
    });

    it("a released template policy leaves the posture", async () => {
      const row = await prisma.retentionPolicyConfig.findFirstOrThrow({ where: { teamId, state: "ACTIVE" } });
      await prisma.retentionPolicyConfig.update({ where: { id: row.id }, data: { state: "RELEASED" } });
      expect((await center(owner, orgId)).retention.data.activePolicyCount).toBe(1);
      await prisma.retentionPolicyConfig.update({ where: { id: row.id }, data: { state: "ACTIVE" } });
    });
  });

  describe("the security policy read", () => {
    it("shows the editor the configuration it can change, not blanks", async () => {
      await prisma.organizationSecurityPolicy.update({
        where: { organizationId: orgId },
        data: { restrictedIpRanges: ["203.0.113.0/24"], allowedEmailDomains: ["halden.example"], notes: "Set in review", ssoReadyFlag: true },
      });
      const res = await kit.call("GET", `/v1/security-policy?organizationId=${orgId}`, owner);
      expect(res.json().policy).toMatchObject({
        restrictedIpRanges: ["203.0.113.0/24"],
        allowedEmailDomains: ["halden.example"],
        notes: "Set in review",
        ssoReadyFlag: true,
        highSecurityMode: false,
      });
      await prisma.organizationSecurityPolicy.update({
        where: { organizationId: orgId },
        data: { restrictedIpRanges: [], allowedEmailDomains: [], notes: null, ssoReadyFlag: false },
      });
    });

    it("states the level sign-in enforces, not the legacy flag", async () => {
      await prisma.organizationSecurityPolicy.update({
        where: { organizationId: orgId },
        data: { mfaPolicyLevel: "ALL_MEMBERS", mfaRequiredFlag: false },
      });
      const res = await kit.call("GET", `/v1/security-policy?organizationId=${orgId}`, owner);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().mfaPolicyLevel).toBe("ALL_MEMBERS");

      const other = await kit.call("GET", `/v1/security-policy?organizationId=${otherOrgId}`, otherOwner);
      expect(other.json().mfaPolicyLevel).toBe("OFF");
      const refused = await kit.call("GET", `/v1/security-policy?organizationId=${orgId}`, member);
      expect(refused.statusCode).toBe(403);
    });
  });

  describe("a returning web sign-in is not suspicious for lacking a device hash", () => {
    it("scores a second password session LOW, and a hashless session after a hashed one MEDIUM", async () => {
      const inventory = await import("../src/services/access-control/session-inventory.service.js");
      const scoring = await import("../src/services/access-control/suspicious-session.service.js");
      const person = await kit.person(teamId, "MEMBER");
      const now = Math.floor(Date.now() / 1000);
      const open = (sid: string, deviceIdHash: string | null = null) =>
        inventory.recordAuthenticatedSession(
          { userId: person.id, teamId, sid, iat: now, exp: now + 3600, ipPreview: "127.0.0.x", authMethod: "PASSWORD", deviceIdHash },
          prisma,
        );
      const score = async (id: string) => {
        await scoring.detectAndScoreSession({ teamId, sessionId: id }, prisma);
        return (await prisma.authenticatedSession.findUniqueOrThrow({ where: { id }, select: { riskScore: true } })).riskScore;
      };

      const first = await open(`fet-a-${kit.tag()}`);
      expect(await score(first.id)).toBe(0);
      const second = await open(`fet-b-${kit.tag()}`);
      expect(await score(second.id), "the web never sends a device hash").toBe(0);

      // Positive control: once a device with a hash has been used, a session without one stands out.
      await open(`fet-c-${kit.tag()}`, "a".repeat(64));
      const fourth = await open(`fet-d-${kit.tag()}`);
      expect(await score(fourth.id)).toBeGreaterThanOrEqual(30);
    });
  });
});
