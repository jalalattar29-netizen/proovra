/**
 * ET-SEC-16 — ONE case-link authority for every link and unlink path.
 * Live PostgreSQL 16, real HTTP.
 *
 * On a40ca76f bulk ADD_TO_CASE admitted any ACTIVE member of the case's
 * workspace, bulk REMOVE_FROM_CASE checked no case at all, and the single
 * POST /v1/cases/:id/evidence ignored a case's CaseAccess list; the case
 * workspace link routes applied the full rule. A member kept OUT of a case by
 * its access list could still link records into it and detach records from it.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("case-link authority (live PostgreSQL 16, real HTTP)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const createdEvidence: string[] = [];
  const createdCases: string[] = [];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
  }, 180_000);

  afterAll(async () => {
    if (createdCases.length) {
      await prisma?.caseEvidenceLink.deleteMany({ where: { caseId: { in: createdCases } } }).catch(() => undefined);
      await prisma?.caseAccess.deleteMany({ where: { caseId: { in: createdCases } } }).catch(() => undefined);
      await prisma?.case.deleteMany({ where: { id: { in: createdCases } } }).catch(() => undefined);
    }
    if (createdEvidence.length) {
      await prisma?.evidence
        .updateMany({ where: { id: { in: createdEvidence } }, data: { deletedAt: new Date() } })
        .catch(() => undefined);
    }
    await h?.cleanup();
  });

  const A = () => h.fixtures.teamA;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  /** A workspace case whose access list names the admin only: the member is kept out. */
  async function restrictedCase(): Promise<string> {
    const { id } = await prisma.case.create({
      data: { name: `sec16-${randomUUID().slice(0, 8)}`, teamId: A().teamId, ownerUserId: A().ownerUserId } as never,
      select: { id: true },
    });
    createdCases.push(id);
    await prisma.caseAccess.create({ data: { caseId: id, userId: A().adminUserId } });
    return id;
  }

  async function record(ownerUserId: string): Promise<string> {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    const { id } = await prisma.evidence.create({
      data: {
        title: "Case-link authority fixture",
        type: "PHOTO",
        status: "SIGNED",
        teamId: A().teamId,
        organizationId: team.organizationId,
        ownerUserId,
        sizeBytes: 1_000n,
      } as never,
      select: { id: true },
    });
    createdEvidence.push(id);
    return id;
  }

  const bulk = (token: string, payload: Record<string, unknown>) =>
    h.app.inject({ method: "POST", url: "/v1/evidence/bulk", headers: auth(token), payload });
  const links = (caseId: string) => prisma.caseEvidenceLink.count({ where: { caseId } });

  it("bulk ADD_TO_CASE: a member kept out by the case's access list gets 404 and links nothing", async () => {
    const caseId = await restrictedCase();
    const ev = await record(A().memberUserId);

    const res = await bulk(A().memberToken, { action: "ADD_TO_CASE", caseId, evidenceIds: [ev] });
    expect(res.statusCode, res.body).toBe(404);
    expect(await links(caseId)).toBe(0);

    // The admin, on the list, links it (control).
    const admin = await bulk(A().adminToken, { action: "ADD_TO_CASE", caseId, evidenceIds: [ev] });
    expect(admin.statusCode, admin.body).toBe(200);
    expect(admin.json()).toMatchObject({ successCount: 1, failedCount: 0 });
    expect(await links(caseId)).toBe(1);
  });

  it("bulk ADD_TO_CASE: a VIEWER is refused by the case mutation matrix (403)", async () => {
    const { id: caseId } = await prisma.case.create({
      data: { name: `sec16-open-${randomUUID().slice(0, 8)}`, teamId: A().teamId, ownerUserId: A().ownerUserId } as never,
      select: { id: true },
    });
    createdCases.push(caseId);
    const ev = await record(A().ownerUserId);

    const res = await bulk(A().viewerToken, { action: "ADD_TO_CASE", caseId, evidenceIds: [ev] });
    expect(res.statusCode, res.body).toBe(403);
    expect(await links(caseId)).toBe(0);
  });

  it("bulk REMOVE_FROM_CASE: the case is checked; a member kept out of it detaches nothing", async () => {
    const caseId = await restrictedCase();
    const ev = await record(A().memberUserId);
    await prisma.caseEvidenceLink.create({ data: { caseId, evidenceId: ev } as never });

    const res = await bulk(A().memberToken, { action: "REMOVE_FROM_CASE", evidenceIds: [ev] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ successCount: 0, failedCount: 1, results: [{ evidenceId: ev, ok: false, reason: "Case not found" }] });
    expect(await links(caseId)).toBe(1);
  });

  it("single POST /v1/cases/:id/evidence: the access list applies there too (404, nothing linked)", async () => {
    const caseId = await restrictedCase();
    const ev = await record(A().memberUserId);

    const res = await h.app.inject({
      method: "POST",
      url: `/v1/cases/${caseId}/evidence`,
      headers: auth(A().memberToken),
      payload: { evidenceId: ev },
    });
    expect(res.statusCode, res.body).toBe(404);
    expect(await links(caseId)).toBe(0);
  });
});
