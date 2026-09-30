/**
 * ET-ACQ-01 — an interactive capture into a workspace is authorized by the
 * canonical `evidence.create` decision. Live PostgreSQL 16, real HTTP.
 *
 * On a40ca76f POST /v1/evidence accepted any ACTIVE membership row for the
 * caller-supplied teamId, so a VIEWER, a member whose access had expired and
 * a member of a SUSPENDED organization all created workspace Evidence.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("evidence create authorization (live PostgreSQL 16, real HTTP)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    await prisma.team.update({
      where: { id: h.fixtures.teamA.teamId },
      data: { billingPlan: "TEAM", billingStatus: "ACTIVE" },
    });
  }, 180_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  const A = () => h.fixtures.teamA;
  const create = (token: string) =>
    h.app.inject({
      method: "POST",
      url: "/v1/evidence",
      headers: { authorization: `Bearer ${token}` },
      payload: { type: "PHOTO", teamId: A().teamId, mimeType: "image/jpeg" },
    });
  const rowsBy = (ownerUserId: string) =>
    prisma.evidence.count({ where: { teamId: A().teamId, ownerUserId } });
  const custodyBy = (ownerUserId: string) =>
    prisma.custodyEvent.count({ where: { evidence: { teamId: A().teamId, ownerUserId } } });

  it("a VIEWER (no evidence.create) is refused 403 and leaves no record or custody row", async () => {
    const before = { rows: await rowsBy(A().viewerUserId), custody: await custodyBy(A().viewerUserId) };
    const res = await create(A().viewerToken);
    expect(res.statusCode, res.body).toBe(403);
    expect(await rowsBy(A().viewerUserId)).toBe(before.rows);
    expect(await custodyBy(A().viewerUserId)).toBe(before.custody);
  });

  it("a member whose access has expired is refused 403 and leaves no record", async () => {
    const where = { teamId_userId: { teamId: A().teamId, userId: A().memberUserId } };
    const before = await rowsBy(A().memberUserId);
    await prisma.teamMember.update({ where, data: { accessExpiresAtUtc: new Date(Date.now() - 60_000) } });
    try {
      const res = await create(A().memberToken);
      expect(res.statusCode, res.body).toBe(403);
      expect(await rowsBy(A().memberUserId)).toBe(before);
    } finally {
      await prisma.teamMember.update({ where, data: { accessExpiresAtUtc: null } });
    }
  });

  it("a member of a SUSPENDED organization is refused 403 and leaves no record", async () => {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    const before = await rowsBy(A().adminUserId);
    await prisma.organization.update({ where: { id: team.organizationId! }, data: { status: "SUSPENDED" } });
    try {
      const res = await create(A().adminToken);
      expect(res.statusCode, res.body).toBe(403);
      expect(await rowsBy(A().adminUserId)).toBe(before);
    } finally {
      await prisma.organization.update({ where: { id: team.organizationId! }, data: { status: "ACTIVE" } });
    }
  });

  it("an active ADMIN of an active organization creates the record (control)", async () => {
    const before = await rowsBy(A().adminUserId);
    const res = await create(A().adminToken);
    expect(res.statusCode, res.body).toBe(201);
    expect(await rowsBy(A().adminUserId)).toBe(before + 1);
  });
});
