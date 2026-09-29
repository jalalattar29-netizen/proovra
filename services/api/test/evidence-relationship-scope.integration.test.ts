/**
 * ET-SEC-07 — an evidence relationship never crosses a workspace boundary.
 * Live PostgreSQL 16, real HTTP.
 *
 * On a40ca76f a user who could read records in two workspaces linked a T1
 * record to a T2 record, and every T1 reader then saw the T2 record's title,
 * status and case through the T1 record's relationship list.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("evidence relationships stay inside one workspace (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  const auth = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  async function record(teamId: string, ownerUserId: string, title: string) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    return prisma.evidence.create({
      data: { title, type: "PHOTO", status: "SIGNED", teamId, organizationId: team.organizationId, ownerUserId } as never,
      select: { id: true },
    });
  }

  it("refuses to link a record to a record in another workspace, as not found", async () => {
    const A = h.fixtures.teamA;
    const B = h.fixtures.teamB;
    // One person who can manage records in BOTH workspaces.
    await prisma.teamMember.upsert({
      where: { teamId_userId: { teamId: B.teamId, userId: A.ownerUserId } },
      create: { teamId: B.teamId, userId: A.ownerUserId, role: "ADMIN", status: "ACTIVE" } as never,
      update: { status: "ACTIVE", role: "ADMIN" } as never,
    });
    try {
      const source = await record(A.teamId, A.ownerUserId, `A-source ${randomUUID().slice(0, 6)}`);
      const secret = `B-secret ${randomUUID().slice(0, 6)}`;
      const target = await record(B.teamId, B.ownerUserId, secret);
      // Control: the dual member can read both records.
      expect((await h.app.inject({ method: "GET", url: `/v1/evidence/${target.id}`, headers: auth(A.ownerToken) })).statusCode).toBe(200);

      const res = await h.app.inject({
        method: "POST",
        url: `/v1/evidence/${source.id}/relationships`,
        headers: auth(A.ownerToken),
        payload: JSON.stringify({ targetEvidenceId: target.id, relationshipType: "RELATED" }),
      });
      expect(res.statusCode, res.body).toBe(404);
      expect(await prisma.evidenceRelationship.count({ where: { sourceEvidenceId: source.id } })).toBe(0);

      // A same-workspace link still works.
      const sibling = await record(A.teamId, A.ownerUserId, `A-sibling ${randomUUID().slice(0, 6)}`);
      const ok = await h.app.inject({
        method: "POST",
        url: `/v1/evidence/${source.id}/relationships`,
        headers: auth(A.ownerToken),
        payload: JSON.stringify({ targetEvidenceId: sibling.id, relationshipType: "RELATED" }),
      });
      expect(ok.statusCode, ok.body).toBe(201);
    } finally {
      await prisma.teamMember.delete({ where: { teamId_userId: { teamId: B.teamId, userId: A.ownerUserId } } }).catch(() => undefined);
    }
  });

  it("a cross-workspace relationship that already exists is not shown to the source workspace", async () => {
    const A = h.fixtures.teamA;
    const B = h.fixtures.teamB;
    const source = await record(A.teamId, A.ownerUserId, `A-legacy ${randomUUID().slice(0, 6)}`);
    const secret = `B-legacy-secret ${randomUUID().slice(0, 6)}`;
    const target = await record(B.teamId, B.ownerUserId, secret);
    // A row written by the old route, before the boundary existed.
    await prisma.evidenceRelationship.create({
      data: { sourceEvidenceId: source.id, targetEvidenceId: target.id, relationshipType: "RELATED", teamId: A.teamId } as never,
    });
    const list = await h.app.inject({ method: "GET", url: `/v1/evidence/${source.id}/relationships`, headers: auth(A.memberToken) });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.body).not.toContain(secret);
    expect(list.body).not.toContain(target.id);
  });
});
