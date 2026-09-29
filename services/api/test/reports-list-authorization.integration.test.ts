/**
 * ET-SEC-18 — the reports lists read only workspaces THE authorization
 * decision admits. Live PostgreSQL 16, the real routes.
 *
 * On a40ca76f GET /v1/reports (and the /v1/reports/artifacts aggregator)
 * admitted any ACTIVE-status membership row, so a member whose access had
 * EXPIRED still listed the workspace's reports; the unscoped owner arm listed
 * records the caller owned in workspaces they could no longer enter; and a
 * primary-query error fell back to a query without the deletedAt/lifecycle
 * filters.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("reports lists honour the authorization decision (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  const get = (url: string, token: string) =>
    h.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

  async function signedIn(teamId: string, ownerUserId: string) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    return (
      await prisma.evidence.create({
        data: { title: `rpt ${randomUUID().slice(0, 6)}`, type: "PHOTO", status: "SIGNED", mimeType: "image/jpeg", teamId, organizationId: team.organizationId, ownerUserId },
        select: { id: true },
      })
    ).id;
  }
  const ids = (body: string) => (JSON.parse(body) as { items: Array<{ evidenceId: string }> }).items.map((i) => i.evidenceId);

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
  }, 180_000);
  afterAll(async () => {
    await prisma.teamMember
      .update({
        where: { teamId_userId: { teamId: h.fixtures.teamA.teamId, userId: h.fixtures.teamA.memberUserId } },
        data: { accessExpiresAtUtc: null },
      })
      .catch(() => null);
    await h?.cleanup();
  });

  it("an EXPIRED member lists nothing from the workspace — scoped (404), unscoped (absent) and the aggregator (404) — even for records they own", async () => {
    const A = h.fixtures.teamA;
    const owned = await signedIn(A.teamId, A.memberUserId);

    // Live member: both lists show it.
    expect(ids((await get(`/v1/reports?teamId=${A.teamId}`, A.memberToken)).body)).toContain(owned);
    expect(ids((await get(`/v1/reports`, A.memberToken)).body)).toContain(owned);

    await prisma.teamMember.update({
      where: { teamId_userId: { teamId: A.teamId, userId: A.memberUserId } },
      data: { accessExpiresAtUtc: new Date(Date.now() - 60_000) },
    });
    try {
      const scoped = await get(`/v1/reports?teamId=${A.teamId}`, A.memberToken);
      expect(scoped.statusCode, scoped.body).toBe(404);
      const unscoped = await get(`/v1/reports`, A.memberToken);
      expect(unscoped.statusCode, unscoped.body).toBe(200);
      expect(ids(unscoped.body)).not.toContain(owned);
      const aggregator = await get(`/v1/reports/artifacts?teamId=${A.teamId}`, A.memberToken);
      expect(aggregator.statusCode, aggregator.body).toBe(404);
    } finally {
      await prisma.teamMember.update({
        where: { teamId_userId: { teamId: A.teamId, userId: A.memberUserId } },
        data: { accessExpiresAtUtc: null },
      });
    }
  });

  it("a trashed record is never listed", async () => {
    const A = h.fixtures.teamA;
    const trashed = await signedIn(A.teamId, A.ownerUserId);
    await prisma.evidence.update({ where: { id: trashed }, data: { lifecycleState: "TRASHED" } as never });
    expect(ids((await get(`/v1/reports?teamId=${A.teamId}`, A.ownerToken)).body)).not.toContain(trashed);
  });
});
