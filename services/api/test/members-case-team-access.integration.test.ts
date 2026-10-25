/**
 * PHASE C — COLLABORATION TEAM CASE ACCESS (members audit ACC-01 / ACC-10) and
 * the case reads that decided access for themselves.
 *
 * A case granted to an ACTIVE Collaboration Team becomes restricted: the team's
 * effective members can open and export it, nobody else in the workspace can,
 * a team from another workspace cannot be granted, an archived team grants
 * nothing, and revoking the grant ends the reach. Every case drives the real
 * routes against a real PostgreSQL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("Phase C — Collaboration Team case access", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let ct: typeof import("../src/services/collaboration-team/collaboration-team.service.js");
  const W = () => h.fixtures.personal;
  const owner = () => W().userId;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as import("@prisma/client").PrismaClient;
    ({ signJwt } = await import("../src/services/jwt.js"));
    ct = await import("../src/services/collaboration-team/collaboration-team.service.js");
    await prisma.entitlement.updateMany({ where: { userId: owner() }, data: { active: false } });
    await prisma.entitlement.create({ data: { userId: owner(), plan: "TEAM", active: true, credits: 0 } });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const tag = () => randomUUID().slice(0, 8);
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  async function person() {
    const { REQUIRED_LEGAL_VERSIONS } = await import("../src/legal/legal-versioning.js");
    const email = `phase-c-cta-${tag()}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, firstName: "Case", lastName: "Access", provider: "EMAIL", providerUserId: email },
      select: { id: true },
    });
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion: policyVersion as string,
        source: "integration-harness",
      })),
    });
    await prisma.teamMember.create({ data: { teamId: W().teamId, userId: user.id, role: "MEMBER", status: "ACTIVE" } });
    const token = signJwt(
      { sub: user.id, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      process.env.AUTH_JWT_SECRET as string,
      3600,
    );
    return { id: user.id, token };
  }

  async function group(): Promise<string> {
    await prisma.collaborationTeam.updateMany({
      where: { workspaceId: W().teamId, status: "ACTIVE" },
      data: { status: "ARCHIVED", archivedAtUtc: new Date() },
    });
    return (await ct.createCollaborationTeam({ workspaceId: W().teamId, actorUserId: owner(), name: `Access ${tag()}` })).id;
  }

  async function openCase() {
    return (
      await prisma.case.create({
        data: { name: `Matter ${tag()}`, teamId: W().teamId, ownerUserId: owner() },
        select: { id: true },
      })
    ).id;
  }

  const ownerToken = () => W().token;
  const view = (caseId: string, token: string) =>
    h.app.inject({ method: "GET", url: `/v1/cases/${caseId}`, headers: bearer(token) });
  const exportCase = (caseId: string, token: string) =>
    h.app.inject({ method: "GET", url: `/v1/cases/${caseId}/export`, headers: bearer(token) });
  const grant = (caseId: string, collaborationTeamId: string, token = ownerToken()) =>
    h.app.inject({
      method: "POST",
      url: `/v1/cases/${caseId}/team-access`,
      headers: bearer(token),
      payload: { collaborationTeamId },
    });

  it("a team grant restricts the case to the team's members — view and export alike", async () => {
    const teamId = await group();
    const inside = await person();
    const outside = await person();
    await ct.addExistingMember({ teamId, actorUserId: owner(), userIdToAdd: inside.id });
    const caseId = await openCase();

    // Unrestricted until granted: every member reaches it.
    expect((await view(caseId, outside.token)).statusCode).toBe(200);

    const res = await grant(caseId, teamId);
    expect(res.statusCode).toBe(201);
    expect(res.json().teamAccess.collaborationTeamId).toBe(teamId);

    expect((await view(caseId, inside.token)).statusCode).toBe(200);
    expect((await view(caseId, outside.token)).statusCode).toBe(404);
    // The export decided for itself: "no CaseAccess rows" meant unrestricted.
    expect((await exportCase(caseId, inside.token)).statusCode).toBe(200);
    expect((await exportCase(caseId, outside.token)).statusCode).toBe(404);
  });

  it("revoking the grant ends the team's reach", async () => {
    const teamId = await group();
    const inside = await person();
    await ct.addExistingMember({ teamId, actorUserId: owner(), userIdToAdd: inside.id });
    const caseId = await openCase();
    await prisma.caseAccess.create({ data: { caseId, userId: owner() } }); // keep it restricted after revoke
    await grant(caseId, teamId);
    expect((await view(caseId, inside.token)).statusCode).toBe(200);

    const revoke = await h.app.inject({
      method: "DELETE",
      url: `/v1/cases/${caseId}/team-access/${teamId}`,
      headers: bearer(ownerToken()),
    });
    expect(revoke.statusCode).toBe(204);
    expect((await view(caseId, inside.token)).statusCode).toBe(404);
  });

  it("a team from another workspace cannot be granted, and the answer does not say which", async () => {
    const caseId = await openCase();
    const foreign = await prisma.collaborationTeam.create({
      data: { workspaceId: h.fixtures.teamB.teamId, name: `Foreign ${tag()}`, createdByUserId: h.fixtures.teamB.ownerUserId },
      select: { id: true },
    });
    const res = await grant(caseId, foreign.id);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("COLLABORATION_TEAM_NOT_FOUND");
    expect(await prisma.caseCollaborationTeamAccess.count({ where: { caseId } })).toBe(0);
    const unknown = await grant(caseId, randomUUID());
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("COLLABORATION_TEAM_NOT_FOUND");
  });

  it("an archived team can neither be granted nor carry reach", async () => {
    const teamId = await group();
    const inside = await person();
    await ct.addExistingMember({ teamId, actorUserId: owner(), userIdToAdd: inside.id });
    const caseId = await openCase();
    await grant(caseId, teamId);
    await ct.archiveCollaborationTeam({ teamId, actorUserId: owner() });
    expect((await view(caseId, inside.token)).statusCode).toBe(404);
    const second = await openCase();
    expect((await grant(second, teamId)).statusCode).toBe(409);
  });

  it("only someone who may manage the case's access may grant it to a team", async () => {
    const teamId = await group();
    const viewer = await person();
    await prisma.teamMember.updateMany({ where: { teamId: W().teamId, userId: viewer.id }, data: { role: "VIEWER" } });
    const caseId = await openCase();
    const res = await grant(caseId, teamId, viewer.token);
    expect(res.statusCode).toBeGreaterThanOrEqual(403);
    expect(await prisma.caseCollaborationTeamAccess.count({ where: { caseId } })).toBe(0);
  });
});
