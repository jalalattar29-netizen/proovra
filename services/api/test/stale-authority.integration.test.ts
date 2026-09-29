/**
 * ET-SEC-03 / ET-SEC-04 / ET-SEC-05 — Invariant D: current authority beats
 * historical identity. Live PostgreSQL 16, real HTTP. Each case was allowed on
 * a40ca76f (the legacy read gate and the case gate honoured creator identity,
 * case ownership, CaseAccess rows and ACTIVE status alone).
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("stale authority is refused (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
  }, 180_000);
  afterAll(async () => { await h?.cleanup(); });

  async function workspaceRecord(ownerUserId: string) {
    const B = h.fixtures.teamB;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: B.teamId }, select: { organizationId: true } });
    return prisma.evidence.create({
      data: { title: `stale ${randomUUID().slice(0, 6)}`, type: "PHOTO", status: "SIGNED", teamId: B.teamId, organizationId: team.organizationId, ownerUserId } as never,
      select: { id: true },
    });
  }
  const read = (id: string, token: string) => h.app.inject({ method: "GET", url: `/v1/evidence/${id}`, headers: auth(token) });
  const member = (teamId: string, userId: string) => ({ teamId_userId: { teamId, userId } });

  it("ET-SEC-03: an ACTIVE member whose access has EXPIRED can neither read nor download", async () => {
    const B = h.fixtures.teamB;
    const ev = await workspaceRecord(B.ownerUserId);
    expect((await read(ev.id, B.memberToken)).statusCode).toBe(200); // control
    await prisma.teamMember.update({ where: member(B.teamId, B.memberUserId), data: { accessExpiresAtUtc: new Date(Date.now() - 60_000) } });
    try {
      expect((await read(ev.id, B.memberToken)).statusCode).toBe(404);
      const dl = await h.app.inject({ method: "GET", url: `/v1/evidence/${ev.id}/original`, headers: auth(B.memberToken) });
      expect([403, 404]).toContain(dl.statusCode);
    } finally {
      await prisma.teamMember.update({ where: member(B.teamId, B.memberUserId), data: { accessExpiresAtUtc: null } });
    }
  });

  it("ET-SEC-03: a member of a SUSPENDED organization cannot read", async () => {
    const B = h.fixtures.teamB;
    const ev = await workspaceRecord(B.ownerUserId);
    const team = await prisma.team.findUniqueOrThrow({ where: { id: B.teamId }, select: { organizationId: true } });
    expect(team.organizationId).toBeTruthy();
    await prisma.organization.update({ where: { id: team.organizationId! }, data: { status: "SUSPENDED" } as never });
    try {
      expect((await read(ev.id, B.memberToken)).statusCode).toBe(404);
    } finally {
      await prisma.organization.update({ where: { id: team.organizationId! }, data: { status: "ACTIVE" } as never });
    }
  });

  it("ET-SEC-05: a creator who left the workspace keeps no access to the record they created", async () => {
    const B = h.fixtures.teamB;
    const ev = await workspaceRecord(B.memberUserId);
    expect((await read(ev.id, B.memberToken)).statusCode).toBe(200); // control
    await prisma.teamMember.update({ where: member(B.teamId, B.memberUserId), data: { status: "REVOKED" } as never });
    try {
      expect((await read(ev.id, B.memberToken)).statusCode).toBe(404);
    } finally {
      await prisma.teamMember.update({ where: member(B.teamId, B.memberUserId), data: { status: "ACTIVE" } as never });
    }
  });

  it("ET-SEC-04: a CaseAccess row does not stand in for membership", async () => {
    const B = h.fixtures.teamB;
    const outsider = { userId: h.fixtures.teamA.memberUserId, token: h.fixtures.teamA.memberToken };
    const ev = await workspaceRecord(B.ownerUserId);
    await prisma.caseEvidenceLink.create({ data: { teamId: B.teamId, caseId: B.caseId, evidenceId: ev.id, role: "PRIMARY", source: "USER" } as never });
    await prisma.caseAccess.create({ data: { caseId: B.caseId, userId: outsider.userId } });
    expect((await h.app.inject({ method: "GET", url: `/v1/cases/${B.caseId}/risk`, headers: auth(outsider.token) })).statusCode).toBe(404);
    expect((await read(ev.id, outsider.token)).statusCode).toBe(404);
    // A current member on the case's access list keeps access.
    await prisma.caseAccess.create({ data: { caseId: B.caseId, userId: B.memberUserId } });
    expect((await h.app.inject({ method: "GET", url: `/v1/cases/${B.caseId}/risk`, headers: auth(B.memberToken) })).statusCode).toBe(200);
  });
});
