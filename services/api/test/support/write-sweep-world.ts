/**
 * The tenants a sweep runs in: a fixed attacker, a fixed victim and a throwaway
 * for each control, all ENTERPRISE under an ACTIVE contract so a refusal is never
 * a plan gate standing in for a tenant boundary.
 */
import { randomBytes, randomUUID } from "node:crypto";

import type { IntegrationHarness } from "../integration-harness.js";
import { coverageKit } from "./coverage-actors.js";
import { WriteSweep, installWriteLog, type Tenant } from "./write-sweep-engine.js";
import { WRITE_SWEEP_HINTS } from "./write-sweep-hints.js";
import { MACHINE_SECRETS } from "./write-sweep-token-hints.js";
import { seedOperator } from "../helpers/operator-step-up.js";

/** Builds ENTERPRISE organization tenants under an ACTIVE contract. */
export async function enterpriseTenantMaker(h: IntegrationHarness): Promise<() => Promise<Tenant>> {
  const { prisma } = await import("../../src/db.js");
  const kit = await coverageKit(h);

  const contract = (organizationId: string) =>
    prisma.enterpriseContract.upsert({
      where: { organizationId },
      create: {
        organizationId,
        status: "ACTIVE",
        seatCount: 500,
        storageGb: 1000,
        legalHoldEnabled: true,
        reviewerOperationsEnabled: true,
        collaborationTeamsMax: 100,
        collaborationTeamMembersMax: 100,
      } as never,
      update: { status: "ACTIVE", legalHoldEnabled: true } as never,
    });

  async function enterpriseTeam(teamId: string, orgId: string): Promise<void> {
    await prisma.team.update({
      where: { id: teamId },
      data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never,
    });
    await contract(orgId);
  }

  async function makeTenant(): Promise<Tenant> {
    const owner = await kit.person(null);
    const organization = await prisma.organization.create({
      data: { name: `sweep-${kit.tag()}`, billingOwnerUserId: owner.id, status: "ACTIVE", kind: "CUSTOMER" } as never,
      select: { id: true },
    });
    await prisma.organizationMembership.create({
      data: { organizationId: organization.id, userId: owner.id, role: "ORG_OWNER" } as never,
    });
    const team = await prisma.team.create({
      data: {
        name: `sweep-${kit.tag()}`,
        ownerUserId: owner.id,
        isPersonal: false,
        organizationId: organization.id,
        workspaceKind: "ORGANIZATION",
      } as never,
      select: { id: true },
    });
    await prisma.organizationSecurityPolicy.create({
      data: { organizationId: organization.id, teamId: team.id } as never,
    });
    // IDENT-013 — a directory creates accounts only in a domain its Organization
    // verified; the sweep's SCIM rows use this one (write-sweep-token-hints).
    await prisma.organizationDomain.create({
      data: {
        organizationId: organization.id,
        domain: sweepDirectoryDomain(organization.id),
        verificationToken: `sweep-${kit.tag()}`,
        verifiedAt: new Date(),
        createdByUserId: owner.id,
      } as never,
    });
    await prisma.teamMember.create({ data: { teamId: team.id, userId: owner.id, role: "OWNER", status: "ACTIVE" } as never });
    await prisma.user.update({ where: { id: owner.id }, data: { currentWorkspaceId: team.id } as never });
    const [approver, admin, admin2, member, viewer] = await Promise.all([
      kit.person(team.id, "OWNER"),
      kit.person(team.id, "ADMIN"),
      kit.person(team.id, "ADMIN"),
      kit.person(team.id, "MEMBER"),
      kit.person(team.id, "VIEWER"),
    ]);
    for (const p of [member]) {
      await prisma.organizationMembership.create({
        data: { organizationId: organization.id, userId: p.id, role: "ORG_MEMBER" } as never,
      });
    }
    await enterpriseTeam(team.id, organization.id);
    return { teamId: team.id, orgId: organization.id, owner, admin, admin2, approver, member, viewer };
  }

  return makeTenant;
}

export async function buildSweepWorld(h: IntegrationHarness): Promise<WriteSweep> {
  // Feature switches the deployment holds, on for this process with throwaway secrets.
  process.env.INTEGRATIONS_ENABLED = "true";
  process.env.API_KEY_SECRET = randomBytes(32).toString("hex");
  process.env.WORKFLOW_INTAKE_LINKS_ENABLED = "true";
  process.env.WORKFLOW_INTAKE_TOKEN_SECRET = randomBytes(32).toString("hex");
  process.env.EVIDENCE_REQUESTS_ENABLED = "true";
  process.env.MESSAGING_TRANSPORT = "recording";
  process.env.WEBAUTHN_RP_ID = "sweep.test";
  process.env.WEBAUTHN_ORIGINS = "https://sweep.test";
  process.env.APP_BASE_URL = "https://sweep.test";
  Object.assign(process.env, MACHINE_SECRETS);

  const { prisma } = await import("../../src/db.js");
  const { signJwt } = await import("../../src/services/jwt.js");
  const kit = await coverageKit(h);
  const makeTenant = await enterpriseTenantMaker(h);
  const attacker = await makeTenant();
  const victim = await makeTenant();

  const removed = await kit.person(victim.teamId, "ADMIN");
  await prisma.teamMember.updateMany({
    where: { teamId: victim.teamId, userId: removed.id },
    data: { status: "REVOKED" } as never,
  });

  await installWriteLog(prisma);

  const newOperator = () => seedOperator(
    h,
    {
      prisma,
      tag: randomUUID().slice(0, 8),
      mintToken: ((sub: string, email: string) =>
        signJwt({ sub, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) }, process.env.AUTH_JWT_SECRET as string, 3600)) as never,
    } as never,
    prisma as never,
  );

  return new WriteSweep({
    h,
    prisma,
    signToken: (user) =>
      signJwt(
        { sub: user.id, provider: "EMAIL", email: user.email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
        process.env.AUTH_JWT_SECRET as string,
        3600,
      ),
    newOperator,
    attacker,
    victim,
    throwaway: makeTenant,
    removedFromVictim: removed,
    newMember: (teamId, role) => kit.person(teamId, role),
    newPerson: () => kit.person(null),
    // A control-sized act by the attacker on its own tenant (a closure, a suspension)
    // must not read as a refusal on the next route.
    restoreAttacker: async () => {
      await prisma.organization.update({ where: { id: attacker.orgId }, data: { status: "ACTIVE" } as never });
      await prisma.team.update({
        where: { id: attacker.teamId },
        data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE", closedAtUtc: null } as never,
      });
      await prisma.enterpriseContract.update({ where: { organizationId: attacker.orgId }, data: { status: "ACTIVE" } as never });
      await prisma.teamMember.updateMany({ where: { teamId: attacker.teamId, userId: attacker.owner.id }, data: { role: "OWNER", status: "ACTIVE" } as never });
      await prisma.subscription.deleteMany({ where: { userId: attacker.owner.id } as never });
    },
    hints: WRITE_SWEEP_HINTS,
  });
}

/** IDENT-013 — the verified domain every sweep tenant holds for its directory users. */
export const sweepDirectoryDomain = (organizationId: string): string =>
  `sweep-${organizationId.slice(0, 8)}-${organizationId.slice(-4)}.verified.example`;
