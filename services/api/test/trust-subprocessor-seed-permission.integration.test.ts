/**
 * F-21 (Free-user audit) — POST /v1/trust/subprocessors/seed is gated like the
 * create it writes through (trust.subprocessor.manage). Live PostgreSQL 16,
 * real HTTP.
 *
 * On 2c84cad83 it ran under requireAuth alone while it UPSERTS every canonical
 * slug (state back to ACTIVE, contractRef cleared, a new version), so a VIEWER
 * could overwrite what a workspace admin had recorded.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("subprocessor seed permission (live PostgreSQL 16, real HTTP)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
  }, 180_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  const seed = (token: string, teamId: string) =>
    h.app.inject({
      method: "POST",
      url: `/v1/trust/subprocessors/seed?teamId=${teamId}`,
      headers: { authorization: `Bearer ${token}`, "x-proovra-workspace-id": teamId },
      payload: {},
    });

  it("a personal workspace's owner (a Free account) can still seed its registry", async () => {
    const P = h.fixtures.personal;
    const res = await seed(P.token, P.teamId);
    expect(res.statusCode, res.body).toBe(200);
    expect(await prisma.subprocessor.count({ where: { teamId: P.teamId } })).toBeGreaterThan(0);
  });

  it("a VIEWER cannot re-apply the seed over an admin's record, and nothing is written", async () => {
    const A = h.fixtures.teamA;
    expect((await seed(A.ownerToken, A.teamId)).statusCode).toBe(200);
    const row = await prisma.subprocessor.findFirstOrThrow({ where: { teamId: A.teamId } });
    await prisma.subprocessor.update({ where: { id: row.id }, data: { state: "DEPRECATED" } });
    const before = await prisma.subprocessor.findUniqueOrThrow({ where: { id: row.id } });

    const res = await seed(A.viewerToken, A.teamId);
    expect(res.statusCode, res.body).toBe(403);
    const after = await prisma.subprocessor.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.state).toBe("DEPRECATED");
    expect(after.version).toBe(before.version);
  });

  it("any member still self-heals an empty registry through the GET (no seed permission needed)", async () => {
    const A = h.fixtures.teamA;
    const res = await h.app.inject({
      method: "GET",
      url: `/v1/trust/subprocessors?teamId=${A.teamId}`,
      headers: { authorization: `Bearer ${A.viewerToken}`, "x-proovra-workspace-id": A.teamId },
    });
    expect(res.statusCode, res.body).toBe(200);
  });
});
