/**
 * AUDIT-ONLY journey seed. Not product code.
 *
 * Creates the actors the runtime journeys need on a DISPOSABLE local database:
 *   ownerA  — ORG_OWNER of an ENTERPRISE organization workspace (tenant A)
 *   viewerA — VIEWER member of tenant A
 *   ownerB  — ORG_OWNER of a second ENTERPRISE organization workspace (tenant B)
 *   freeU   — a user whose personal workspace is provisioned by the PRODUCT
 *             bootstrap (ensurePersonalWorkspace), i.e. the real FREE path.
 *
 * Refuses any non-loopback database or a database name that does not read as
 * disposable. Prints one JSON line.
 */
import { signJwt } from "../../../../../services/api/src/services/jwt.js";
import { REQUIRED_LEGAL_VERSIONS } from "../../../../../services/api/src/legal/legal-versioning.js";

function assertDisposable(raw: string | undefined): void {
  if (!raw) throw new Error("DATABASE_URL is required");
  const url = new URL(raw);
  if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase())) {
    throw new Error(`REFUSED: DATABASE_URL host '${url.hostname}' is not loopback`);
  }
  if (!/(test|fixture|local|dev|acceptance)/i.test(url.pathname)) {
    throw new Error(`REFUSED: database '${url.pathname}' does not read as disposable`);
  }
}

async function main(): Promise<void> {
  assertDisposable(process.env.DATABASE_URL);
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret) throw new Error("AUTH_JWT_SECRET is required");
  const { prisma } = await import("../../../../../services/api/src/db.js");
  const { ensurePersonalWorkspace } = await import(
    "../../../../../services/api/src/services/platform-context/workspace-bootstrap.service.js"
  );
  const stamp = Date.now();

  async function mkUser(tag: string) {
    const email = `uca-${tag}-${stamp}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, firstName: "UCA", lastName: tag, provider: "EMAIL", providerUserId: email },
      select: { id: true, email: true },
    });
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion: policyVersion as string,
        source: "uca-journey-seed",
      })),
    });
    return { id: user.id, email: user.email ?? email };
  }

  async function mkOrgWorkspace(ownerId: string, tag: string) {
    const org = await prisma.organization.create({
      data: { name: `UCA-${tag}-${stamp}`, billingOwnerUserId: ownerId, status: "ACTIVE", kind: "CUSTOMER" },
      select: { id: true },
    });
    await prisma.organizationMembership.create({
      data: { organizationId: org.id, userId: ownerId, role: "ORG_OWNER" },
    });
    const team = await prisma.team.create({
      data: {
        name: `UCA-${tag}-${stamp}`,
        ownerUserId: ownerId,
        isPersonal: false,
        organizationId: org.id,
        workspaceKind: "ORGANIZATION",
        billingPlan: "ENTERPRISE",
        billingStatus: "ACTIVE",
      } as never,
      select: { id: true },
    });
    await prisma.teamMember.create({ data: { teamId: team.id, userId: ownerId, role: "OWNER", status: "ACTIVE" } });
    return { orgId: org.id, teamId: team.id };
  }

  const bearer = (u: { id: string; email: string }) =>
    signJwt(
      { sub: u.id, provider: "EMAIL", email: u.email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      secret,
      60 * 60 * 3,
    );

  const ownerA = await mkUser("ownerA");
  const wsA = await mkOrgWorkspace(ownerA.id, "A");
  const viewerA = await mkUser("viewerA");
  await prisma.organizationMembership.create({
    data: { organizationId: wsA.orgId, userId: viewerA.id, role: "ORG_MEMBER" } as never,
  });
  await prisma.teamMember.create({ data: { teamId: wsA.teamId, userId: viewerA.id, role: "VIEWER", status: "ACTIVE" } });
  const memberA = await mkUser("memberA");
  await prisma.organizationMembership.create({
    data: { organizationId: wsA.orgId, userId: memberA.id, role: "ORG_MEMBER" } as never,
  });
  await prisma.teamMember.create({ data: { teamId: wsA.teamId, userId: memberA.id, role: "MEMBER", status: "ACTIVE" } });
  const ownerB = await mkUser("ownerB");
  const wsB = await mkOrgWorkspace(ownerB.id, "B");
  const freeU = await mkUser("free");
  const personal = await ensurePersonalWorkspace({ userId: freeU.id });
  const personalTeam = await prisma.team.findUnique({
    where: { id: personal.teamId },
    select: { id: true, billingPlan: true, workspaceKind: true } as never,
  });

  process.stdout.write(
    JSON.stringify({
      ownerA: { ...ownerA, teamId: wsA.teamId, bearer: bearer(ownerA) },
      viewerA: { ...viewerA, teamId: wsA.teamId, bearer: bearer(viewerA) },
      memberA: { ...memberA, teamId: wsA.teamId, bearer: bearer(memberA) },
      ownerB: { ...ownerB, teamId: wsB.teamId, bearer: bearer(ownerB) },
      free: { ...freeU, teamId: personal.teamId, personalTeam, bearer: bearer(freeU) },
    }) + "\n",
  );
  await prisma.$disconnect();
}

main().catch((err) => {
  process.stderr.write(`seed-journeys FAILED: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
