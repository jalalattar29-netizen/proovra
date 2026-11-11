/**
 * The command centre is a read (live PostgreSQL).
 *
 *   AUD-0030  a member who may not read security (VIEWER, no audit.read) had
 *             the security sections withheld but still received the security
 *             roll-up: the classifier status and the 7-day security-event count
 *   AUD-0031  opening the command centre (a GET, open to every member) moved
 *             operational-incident rows' updated_at
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seedIncident, sweep, type Ctx } from "./operations-truth-fixtures.js";

describe("command centre — a read, scoped to what the viewer may read", () => {
  let c: Ctx;

  beforeAll(async () => {
    // The canonical acquisition (bootIntegrationHarness), as bootOps does it.
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    const h = await bootIntegrationHarness();
    const { prisma } = await import("../src/db.js");
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    const inj = (method: string, url: string, token?: string, body?: unknown, headers: Record<string, string> = {}) =>
      h.app.inject({ method: method as never, url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body !== undefined ? { payload: body as never } : {}) });
    c = { h, prisma: prisma as never, inj } as Ctx;
    await c.prisma.team.update({ where: { id: c.h.fixtures.teamA.teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } });
  }, 300_000);

  afterAll(async () => {
    await c?.h.cleanup();
  }, 300_000);

  const get = (token: string) =>
    c.inj("GET", `/v1/dashboard/command-center?teamId=${c.h.fixtures.teamA.teamId}`, token, undefined, {
      "x-proovra-workspace-id": c.h.fixtures.teamA.teamId,
    });

  it("AUD-0030 — the VIEWER gets no security roll-up; the OWNER does", async () => {
    const A = c.h.fixtures.teamA;
    const viewer = await get(A.viewerToken);
    expect(viewer.statusCode, viewer.body).toBe(200);
    expect(viewer.json().opsHealth?.securityRollup ?? null).toBeNull();
    expect(viewer.body).not.toMatch(/canonical SecurityEvent rows/);
    const owner = await get(A.ownerToken);
    expect(owner.statusCode, owner.body).toBe(200);
    expect(owner.json().opsHealth.securityRollup).toMatchObject({ status: expect.any(String) });
  });

  it("AUD-0031 — a GET writes no operational-incident row", async () => {
    const A = c.h.fixtures.teamA;
    await seedIncident(c, A.teamId, { sourceId: "governance.notification_escalated", category: "GOVERNANCE", severity: "HIGH" });
    await sweep(A.teamId).catch(() => null);
    const snapshot = async () =>
      (
        await c.prisma.operationalIncident.findMany({
          where: { teamId: A.teamId },
          select: { id: true, updatedAt: true, status: true, occurrenceCount: true },
          orderBy: { id: "asc" },
        })
      ).map((r) => `${r.id}|${r.updatedAt.toISOString()}|${r.status}|${r.occurrenceCount}`);
    const before = await snapshot();
    await new Promise((r) => setTimeout(r, 20));
    for (const token of [A.viewerToken, A.memberToken, A.ownerToken]) {
      const res = await get(token);
      expect(res.statusCode, res.body).toBe(200);
    }
    expect(await snapshot()).toEqual(before);
  });
});
