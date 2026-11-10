/**
 * AUD-0017 (TXP-013 / TXP-014 / TXP-016) — membership writes above the
 * database pool size.
 *
 * Adding people to a Collaboration Team and accepting workspace invitations
 * both take a lock inside a transaction and then resolved the workspace's
 * commercial context (plan, seats, contract) on the GLOBAL client — a second
 * pooled connection per request while the first was held. With the pool at 4,
 * a burst of 10 left every transaction holding a connection and waiting for
 * another (the audit's repro #5: P2028 after the 5 s interactive timeout). The
 * commercial context is now resolved on the transaction's own connection.
 *
 * Real routes and PostgreSQL; the pool is set before the client module loads.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const POOL = 4;
const N = POOL * 2 + 2;
const WS = "x-proovra-workspace-id";

describe(`AUD-0017 membership writes above the pool size (live PostgreSQL, pool ${POOL})`, () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let ct: typeof import("../src/services/collaboration-team/collaboration-team.service.js");
  let legalVersions: Record<string, string>;
  let signJwt: (typeof import("../src/services/jwt.js"))["signJwt"];
  const poolBefore = process.env.DATABASE_POOL_MAX;

  beforeAll(async () => {
    process.env.DATABASE_POOL_MAX = String(POOL);
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ct = await import("../src/services/collaboration-team/collaboration-team.service.js");
    legalVersions = (await import("../src/legal/legal-versioning.js")).REQUIRED_LEGAL_VERSIONS as Record<string, string>;
    ({ signJwt } = await import("../src/services/jwt.js"));
    for (const t of [h.fixtures.teamA, h.fixtures.teamB]) {
      await prisma.team.update({ where: { id: t.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
    }
  }, 300_000);

  afterAll(async () => {
    if (poolBefore === undefined) delete process.env.DATABASE_POOL_MAX;
    else process.env.DATABASE_POOL_MAX = poolBefore;
    await h?.cleanup();
  }, 300_000);

  const tag = () => randomUUID().slice(0, 8);

  async function person(teamId: string | null): Promise<{ id: string; email: string; token: string }> {
    const email = `pool-${tag()}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, firstName: "Pool", lastName: "Member", provider: "EMAIL", providerUserId: email, emailVerifiedAt: new Date() },
      select: { id: true },
    });
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(legalVersions).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion,
        source: "integration-harness",
      })),
    });
    if (teamId) await prisma.teamMember.create({ data: { teamId, userId: user.id, role: "MEMBER", status: "ACTIVE" } });
    const token = signJwt(
      { sub: user.id, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) } as never,
      process.env.AUTH_JWT_SECRET!,
      3600,
    );
    const { registerSessionForToken } = await import("./point7/product-fixtures.js");
    await registerSessionForToken({ prisma: prisma as never, tag: "pool", mintToken: () => token }, user.id, token);
    return { id: user.id, email, token };
  }

  it(`${N} concurrent adds to ONE Collaboration Team all succeed (TXP-016)`, async () => {
    const A = h.fixtures.teamA;
    await prisma.collaborationTeam.updateMany({
      where: { workspaceId: A.teamId, status: "ACTIVE" },
      data: { status: "ARCHIVED", archivedAtUtc: new Date() },
    });
    const group = await ct.createCollaborationTeam({ workspaceId: A.teamId, actorUserId: A.ownerUserId, name: `pool ${tag()}` });
    const people = [];
    for (let i = 0; i < N; i += 1) people.push(await person(A.teamId));

    const t0 = Date.now();
    const results = await Promise.all(
      people.map((p) =>
        h.app.inject({
          method: "POST",
          url: `/v1/collaboration-teams/${group.id}/members`,
          headers: { authorization: `Bearer ${A.ownerToken}`, [WS]: A.teamId },
          payload: { userId: p.id },
        }),
      ),
    );
    const elapsed = Date.now() - t0;
    const codes = results.map((r) => r.statusCode);
    // Capacity may refuse some adds (409) — a decision, not a wedge. None may fail.
    expect(codes.filter((c) => c >= 500), results.map((r) => r.body.slice(0, 160)).join("\n")).toEqual([]);
    const added = await prisma.collaborationTeamMember.count({
      where: { teamId: group.id, userId: { in: people.map((p) => p.id) }, status: "ACTIVE" },
    });
    expect(added).toBe(codes.filter((c) => c < 300).length);
    expect(added).toBeGreaterThan(POOL);
    expect(elapsed).toBeLessThan(5_000 * 2);
  }, 120_000);

  it(`${POOL * 2} concurrent workspace invitation accepts all succeed (TXP-013 / TXP-014)`, async () => {
    const B = h.fixtures.teamB;
    const n = POOL * 2;
    const invitees = [];
    for (let i = 0; i < n; i += 1) {
      const p = await person(null);
      const raw = randomBytes(24).toString("hex");
      await prisma.teamInvite.create({
        data: {
          teamId: B.teamId,
          email: p.email,
          role: "MEMBER",
          tokenHash: createHash("sha256").update(raw).digest("hex"),
          expiresAt: new Date(Date.now() + 86_400_000),
          invitedByUserId: B.ownerUserId,
        },
      });
      invitees.push({ ...p, raw });
    }

    const t0 = Date.now();
    const results = await Promise.all(
      invitees.map((p) =>
        h.app.inject({
          method: "POST",
          url: `/v1/teams/invites/${p.raw}/accept`,
          headers: { authorization: `Bearer ${p.token}` },
        }),
      ),
    );
    const elapsed = Date.now() - t0;
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c >= 500), results.map((r) => r.body.slice(0, 160)).join("\n")).toEqual([]);
    const joined = await prisma.teamMember.count({
      where: { teamId: B.teamId, userId: { in: invitees.map((p) => p.id) }, status: "ACTIVE" },
    });
    expect(joined).toBe(codes.filter((c) => c < 300).length);
    expect(joined).toBeGreaterThan(POOL);
    expect(elapsed).toBeLessThan(5_000 * 2);
  }, 120_000);
});
