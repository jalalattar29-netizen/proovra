/**
 * ET-ACQ-06 — record-cap admission is serialized per capacity subject.
 * Live PostgreSQL 16, real HTTP.
 *
 * On a40ca76f the record count was read with no lock before the insert, so
 * concurrent creates at cap-1 were all admitted; a SHARED workspace was never
 * settled again at completion, so its overshoot stood.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("record-cap admission is serialized (live PostgreSQL 16, real HTTP)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let clearRates: () => Promise<unknown>;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
  }, 180_000);

  beforeEach(async () => {
    await clearRates();
  });

  afterAll(async () => {
    await h?.cleanup();
  });

  const create = (token: string, teamId?: string) =>
    h.app.inject({
      method: "POST",
      url: "/v1/evidence",
      headers: { authorization: `Bearer ${token}` },
      payload: { type: "PHOTO", mimeType: "image/jpeg", ...(teamId ? { teamId } : {}) },
    });

  async function race(token: string, teamId?: string): Promise<number[]> {
    const res = await Promise.all(Array.from({ length: 5 }, () => create(token, teamId)));
    return res.map((r) => r.statusCode).sort();
  }

  it("a SHARED TEAM workspace one record below its rolling allowance admits exactly one of five concurrent creates", async () => {
    const B = h.fixtures.teamB;
    await prisma.team.update({ where: { id: B.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
    const team = await prisma.team.findUniqueOrThrow({ where: { id: B.teamId }, select: { organizationId: true } });
    const since = new Date(Date.now() - 30 * 24 * 3600_000);
    const existing = await prisma.evidence.count({ where: { teamId: B.teamId, deletedAt: null, createdAt: { gte: since } } });
    const toSeed = 499 - existing;
    expect(toSeed).toBeGreaterThan(0);
    await prisma.evidence.createMany({
      data: Array.from({ length: toSeed }, (_, i) => ({
        title: `cap-${i}`,
        type: "PHOTO",
        status: "SIGNED",
        teamId: B.teamId,
        organizationId: team.organizationId,
        ownerUserId: B.ownerUserId,
      })) as never,
    });

    const statuses = await race(B.ownerToken, B.teamId);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s !== 201).every((s) => s === 409 || s === 402)).toBe(true);
  });

  it("a FREE Personal Space one record below its lifetime cap admits exactly one of five concurrent creates", async () => {
    const P = h.fixtures.personal;
    const personalTeam = await prisma.team.findUniqueOrThrow({ where: { id: P.teamId }, select: { organizationId: true } });
    const existing = await prisma.evidence.count({ where: { ownerUserId: P.userId, deletedAt: null } });
    const toSeed = 2 - existing;
    if (toSeed > 0) {
      await prisma.evidence.createMany({
        data: Array.from({ length: toSeed }, (_, i) => ({
          title: `cap-p-${i}`,
          type: "PHOTO",
          status: "SIGNED",
          teamId: P.teamId,
          organizationId: personalTeam.organizationId,
          ownerUserId: P.userId,
        })) as never,
      });
    }

    const statuses = await race(P.token);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
  });
});
