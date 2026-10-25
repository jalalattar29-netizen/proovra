/**
 * PHASE B — ONE ACCESS DECISION FOR CASES AND EVIDENCE (members audit ACC-01,
 * ACC-02, ACC-03, ACC-04, ACC-07, ACC-09, ROLE-02).
 *
 * Roles define capability; access lists define reach. Every surface below was
 * answering one of those questions on its own:
 *
 *   ACC-02  GET /v1/cases/:id returned 200 to the case OWNER or a CaseAccess
 *           holder BEFORE any membership check — a revoked member kept reading.
 *   ACC-03  the Evidence list OR-ed in "evidence I created" with no membership.
 *   ACC-04  the case list did the same for "cases I own / was granted".
 *   ACC-01  a restricted case hid itself but not its evidence: every workspace
 *           member — VIEWER included — read and downloaded it.
 *   ACC-07  the reviewer-assignee check took a stale CaseAccess row.
 *   ROLE-02 an ADMIN of any workspace could link a stranger's unlinked case.
 *
 * The rule now: membership through the canonical authority first, the
 * restricted-case rule second (case-visibility.ts), Evidence inheriting it,
 * a Collaboration Team grant counting only while the team is ACTIVE. Every
 * case runs against real routes on a real PostgreSQL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bootIntegrationHarness,
  type IntegrationHarness,
} from "./integration-harness.js";

describe("Phase B — one access decision for Cases and Evidence", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  const A = () => h.fixtures.teamA;

  beforeAll(async () => {
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as
      import("@prisma/client").PrismaClient;
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const get = (url: string, token: string) =>
    h.app.inject({ method: "GET", url, headers: bearer(token) });

  async function newCase(ownerUserId: string, teamId: string | null = A().teamId) {
    const { id } = await prisma.case.create({
      data: { name: `phase-b-${randomUUID().slice(0, 8)}`, teamId, ownerUserId } as never,
      select: { id: true },
    });
    return id;
  }
  async function newEvidence(ownerUserId: string, teamId = A().teamId) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    const { id } = await prisma.evidence.create({
      data: {
        title: `phase-b ${randomUUID().slice(0, 8)}`,
        type: "PHOTO",
        status: "SIGNED",
        teamId,
        organizationId: team.organizationId,
        ownerUserId,
        sizeBytes: 1_000n,
      } as never,
      select: { id: true },
    });
    return id;
  }
  const link = (caseId: string, evidenceId: string) =>
    prisma.caseEvidenceLink.create({ data: { caseId, evidenceId, teamId: A().teamId } as never });
  const setStatus = (userId: string, status: "ACTIVE" | "SUSPENDED" | "REVOKED") =>
    prisma.teamMember.updateMany({ where: { teamId: A().teamId, userId }, data: { status } });

  async function listedEvidenceIds(token: string): Promise<string[]> {
    const res = await get("/v1/evidence?scope=all&limit=100", token);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { items?: Array<{ id: string }> };
    return (body.items ?? []).map((e) => e.id);
  }
  async function listedCaseIds(token: string): Promise<string[]> {
    const res = await get("/v1/cases", token);
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { items: Array<{ id: string }> }).items.map((c) => c.id);
  }

  it("ACC-02 / ACC-04 — a case OWNER who is no longer an ACTIVE member cannot read or list the case", async () => {
    const member = A().memberUserId;
    const caseId = await newCase(member);
    try {
      expect((await get(`/v1/cases/${caseId}`, A().memberToken)).statusCode).toBe(200);
      expect(await listedCaseIds(A().memberToken)).toContain(caseId);
      for (const status of ["SUSPENDED", "REVOKED"] as const) {
        await setStatus(member, status);
        const res = await get(`/v1/cases/${caseId}`, A().memberToken);
        expect(res.statusCode, status).toBe(404);
        expect(res.body).not.toContain(caseId);
        expect(await listedCaseIds(A().memberToken), status).not.toContain(caseId);
      }
    } finally {
      await setStatus(member, "ACTIVE");
    }
  });

  it("ACC-02 — a stale CaseAccess row is not membership", async () => {
    const caseId = await newCase(A().ownerUserId);
    await prisma.caseAccess.create({ data: { caseId, userId: A().viewerUserId } });
    try {
      expect((await get(`/v1/cases/${caseId}`, A().viewerToken)).statusCode).toBe(200);
      await setStatus(A().viewerUserId, "REVOKED");
      expect((await get(`/v1/cases/${caseId}`, A().viewerToken)).statusCode).toBe(404);
    } finally {
      await setStatus(A().viewerUserId, "ACTIVE");
    }
  });

  it("ACC-03 — evidence a former member CREATED leaves their list with their membership", async () => {
    const evidenceId = await newEvidence(A().memberUserId);
    try {
      expect(await listedEvidenceIds(A().memberToken)).toContain(evidenceId);
      await setStatus(A().memberUserId, "SUSPENDED");
      const res = await get("/v1/evidence?scope=all&limit=100", A().memberToken);
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(evidenceId);
      expect((await get(`/v1/evidence/${evidenceId}`, A().memberToken)).statusCode).toBe(404);
    } finally {
      await setStatus(A().memberUserId, "ACTIVE");
    }
  });

  it("ACC-01 — a restricted case closes its evidence to every member not on it, OWNER and ADMIN included", async () => {
    const caseId = await newCase(A().memberUserId);
    const evidenceId = await newEvidence(A().memberUserId);
    await link(caseId, evidenceId);
    // Unrestricted: the whole workspace reads it.
    for (const token of [A().ownerToken, A().adminToken, A().viewerToken]) {
      expect((await get(`/v1/evidence/${evidenceId}`, token)).statusCode).toBe(200);
    }
    // Restrict it to the case owner and the VIEWER.
    await prisma.caseAccess.create({ data: { caseId, userId: A().viewerUserId } });
    expect((await get(`/v1/evidence/${evidenceId}`, A().memberToken)).statusCode).toBe(200); // case owner
    expect((await get(`/v1/evidence/${evidenceId}`, A().viewerToken)).statusCode).toBe(200); // on the list
    for (const [who, token] of [["OWNER", A().ownerToken], ["ADMIN", A().adminToken]] as const) {
      const res = await get(`/v1/evidence/${evidenceId}`, token);
      expect(res.statusCode, who).toBe(404);
      expect(await listedEvidenceIds(token), who).not.toContain(evidenceId);
      expect((await get(`/v1/cases/${caseId}`, token)).statusCode, who).toBe(404);
      expect(await listedCaseIds(token), who).not.toContain(caseId);
    }
  });

  it("ACC-10 — an ACTIVE Collaboration Team granted the case reaches it; archiving the team withdraws the reach", async () => {
    const caseId = await newCase(A().memberUserId);
    const evidenceId = await newEvidence(A().memberUserId);
    await link(caseId, evidenceId);
    await prisma.caseAccess.create({ data: { caseId, userId: A().memberUserId } });
    const team = await prisma.collaborationTeam.create({
      data: { workspaceId: A().teamId, name: `phase-b-team-${randomUUID().slice(0, 6)}`, createdByUserId: A().ownerUserId },
      select: { id: true },
    });
    await prisma.collaborationTeamMember.create({
      data: { teamId: team.id, userId: A().adminUserId, role: "MEMBER", status: "ACTIVE" } as never,
    });
    expect((await get(`/v1/evidence/${evidenceId}`, A().adminToken)).statusCode).toBe(404);
    await prisma.caseCollaborationTeamAccess.create({
      data: { caseId, collaborationTeamId: team.id, grantedByUserId: A().ownerUserId },
    });
    expect((await get(`/v1/evidence/${evidenceId}`, A().adminToken)).statusCode).toBe(200);
    expect((await get(`/v1/cases/${caseId}`, A().adminToken)).statusCode).toBe(200);
    expect(await listedEvidenceIds(A().adminToken)).toContain(evidenceId);
    // A team grant is RESTRICTION too: the workspace OWNER, not on it, is out.
    expect((await get(`/v1/evidence/${evidenceId}`, A().ownerToken)).statusCode).toBe(404);

    await prisma.collaborationTeam.update({ where: { id: team.id }, data: { status: "ARCHIVED" } });
    expect((await get(`/v1/evidence/${evidenceId}`, A().adminToken)).statusCode).toBe(404);
    expect(await listedEvidenceIds(A().adminToken)).not.toContain(evidenceId);
  });

  it("ROLE-02 — an ADMIN cannot link another tenant's unlinked case; the refusal discloses nothing", async () => {
    const B = h.fixtures.teamB;
    const foreign = await newCase(B.ownerUserId, null);
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/teams/${A().teamId}/cases/link`,
      headers: bearer(A().adminToken),
      payload: { caseId: foreign },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain(foreign);
    expect((await prisma.case.findUniqueOrThrow({ where: { id: foreign } })).teamId).toBeNull();

    // Control: an unlinked case owned by an ACTIVE member of A is linkable.
    const own = await newCase(A().memberUserId, null);
    const ok = await h.app.inject({
      method: "POST",
      url: `/v1/teams/${A().teamId}/cases/link`,
      headers: bearer(A().adminToken),
      payload: { caseId: own },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await prisma.case.findUniqueOrThrow({ where: { id: own } })).teamId).toBe(A().teamId);
  });
});
