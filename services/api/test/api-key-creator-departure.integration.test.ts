/**
 * A2-10 — an integration API key does not outlive its creator's membership
 * (live PostgreSQL).
 *
 * `requireApiKey` checks the key's status, IP, organization lifecycle and rate
 * limit — never its creator — and no membership path touched `api_credentials`,
 * so an ADMIN who minted a key and was then removed kept reading the workspace
 * through it. Keys now follow the creator-scoped rule intake links and owner
 * share links already follow: they end, with the reason, when the creator is
 * removed or suspended. A role change does not end them, and another member's
 * key is untouched.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";

describe("A2-10 — integration API keys and their creator (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let rbac: typeof import("../src/services/identity/rbac.service.js");
  let legalVersions: Record<string, string>;
  let stepUp: ReturnType<typeof createStepUpCeremony>;
  let signJwt: typeof import("../src/services/jwt.js")["signJwt"];
  let upsertEntitlementGrant: typeof import("../src/services/packaging/entitlement.service.js")["upsertEntitlementGrant"];
  const A = () => h.fixtures.teamA;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as import("@prisma/client").PrismaClient;
    rbac = await import("../src/services/identity/rbac.service.js");
    legalVersions = (await import("../src/legal/legal-versioning.js")).REQUIRED_LEGAL_VERSIONS as Record<string, string>;
    ({ signJwt } = await import("../src/services/jwt.js"));
    ({ upsertEntitlementGrant } = await import("../src/services/packaging/entitlement.service.js"));
    stepUp = createStepUpCeremony({ prisma, inject: h.app.inject.bind(h.app) as never });
    // Seats for the members this file adds and restores.
    await prisma.team.updateMany({ where: { id: A().teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  async function person(role: "ADMIN" | "MEMBER") {
    const email = `a210-${randomUUID().slice(0, 8)}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, displayName: "Key creator", provider: "EMAIL", providerUserId: email },
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
    const m = await prisma.teamMember.create({ data: { teamId: A().teamId, userId: user.id, role, status: "ACTIVE" } });
    return { id: user.id, memberId: m.id };
  }

  /** A live key held in the creator's name (the row the key service writes). */
  const mint = async (creatorUserId: string) =>
    (
      await prisma.apiCredential.create({
        data: {
          teamId: A().teamId,
          name: "a210 key",
          keyPrefix: `pwk_${randomBytes(4).toString("hex")}`,
          keyHash: randomBytes(32).toString("hex"),
          scopes: ["integration.evidence.read"],
          createdByUserId: creatorUserId,
        },
        select: { id: true },
      })
    ).id;

  const row = (id: string) =>
    prisma.apiCredential.findUniqueOrThrow({
      where: { id },
      select: { status: true, revokedReason: true, revokedAtUtc: true },
    });

  it("removing the creator revokes their live keys, with the reason", async () => {
    const creator = await person("ADMIN");
    const id = await mint(creator.id);
    const other = await mint(A().ownerUserId);
    await rbac.revokeMember({ teamId: A().teamId, teamMemberId: creator.memberId, actorUserId: A().ownerUserId });
    const after = await row(id);
    expect(after).toMatchObject({ status: "REVOKED", revokedReason: "creator_removed" });
    expect(after.revokedAtUtc).not.toBeNull();
    // Positive control: another member's key is untouched.
    expect((await row(other)).status).toBe("ACTIVE");
  });

  it("suspension revokes them too, and a restore does not revive them", async () => {
    const creator = await person("ADMIN");
    const id = await mint(creator.id);
    await rbac.suspendMember({ teamId: A().teamId, teamMemberId: creator.memberId, actorUserId: A().ownerUserId });
    expect(await row(id)).toMatchObject({ status: "REVOKED", revokedReason: "creator_suspended" });
    await rbac.restoreMember({ teamId: A().teamId, teamMemberId: creator.memberId, actorUserId: A().ownerUserId });
    expect((await row(id)).status).toBe("REVOKED");
  });

  it("a role change alone leaves the key live", async () => {
    const creator = await person("ADMIN");
    const id = await mint(creator.id);
    await rbac.changeMemberRole({ teamId: A().teamId, teamMemberId: creator.memberId, actorUserId: A().ownerUserId, newRole: "MEMBER" });
    expect((await row(id)).status).toBe("ACTIVE");
  });

  /*
   * Audit round 3 (slice COM) — RECOVERY after a suspension, through the real
   * routes: the suspended creator's key stops authenticating, a restore does not
   * revive it, and the way back is an ORDINARY new key under the plan's key
   * allowance (INTEGRATION_API_KEYS_MAX). There is no un-revoke path.
   */
  it("recovery after suspension is an ordinary new key under the plan allowance; the revoked key never comes back", async () => {
    const previousEnv = { INTEGRATIONS_ENABLED: process.env.INTEGRATIONS_ENABLED, API_KEY_SECRET: process.env.API_KEY_SECRET };
    process.env.INTEGRATIONS_ENABLED = "true";
    process.env.API_KEY_SECRET = process.env.API_KEY_SECRET ?? "ef".repeat(32);
    try {
      const creator = await person("ADMIN");
      const email = (await prisma.user.findUniqueOrThrow({ where: { id: creator.id }, select: { email: true } })).email!;
      const tokenFor = () =>
        signJwt(
          { sub: creator.id, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          process.env.AUTH_JWT_SECRET!,
          60 * 60,
        );
      // A workspace allowance of exactly one more key than it holds now.
      const held = await prisma.apiCredential.count({ where: { teamId: A().teamId, status: "ACTIVE" } });
      await upsertEntitlementGrant({
        teamId: A().teamId,
        key: "INTEGRATION_API_KEYS_MAX",
        value: held + 1,
        kind: "LIMIT",
        source: "CUSTOM",
        grantedByUserId: A().ownerUserId,
      });
      const create = async () => {
        const token = tokenFor();
        const header = await stepUp.approvedHeader({
          token,
          userId: creator.id,
          teamId: A().teamId,
          purpose: "INTEGRATION_API_KEY_CREATE",
          resourceKind: "team",
          resourceId: A().teamId,
        });
        return h.app.inject({
          method: "POST",
          url: "/v1/integrations/api-keys",
          headers: { authorization: `Bearer ${token}`, ...header },
          payload: { teamId: A().teamId, name: `a210 recovery ${randomUUID().slice(0, 6)}`, scopes: ["integration.evidence.read"] },
        });
      };
      const use = (raw: string) =>
        h.app.inject({ method: "GET", url: "/v1/integrations/api/evidence", headers: { authorization: `Bearer ${raw}` } });

      const first = await create();
      expect(first.statusCode, first.body).toBe(201);
      const firstBody = first.json() as { rawKey: string; apiKey: { id: string } };
      expect((await use(firstBody.rawKey)).statusCode).not.toBe(401);
      // The allowance is full: a second key is refused, the first keeps working.
      const refused = await create();
      expect(refused.statusCode, refused.body).toBe(429);
      expect((refused.json() as { error: { code: string } }).error.code).toBe("api_key_limit_reached");

      await rbac.suspendMember({ teamId: A().teamId, teamMemberId: creator.memberId, actorUserId: A().ownerUserId });
      expect(await row(firstBody.apiKey.id)).toMatchObject({ status: "REVOKED", revokedReason: "creator_suspended" });
      expect((await use(firstBody.rawKey)).statusCode).toBe(401);

      await rbac.restoreMember({ teamId: A().teamId, teamMemberId: creator.memberId, actorUserId: A().ownerUserId });
      expect((await row(firstBody.apiKey.id)).status).toBe("REVOKED");
      expect((await use(firstBody.rawKey)).statusCode).toBe(401);

      // The revoked key freed its place: the ordinary create path issues a new one.
      // (The suspension also ended the member's sessions: sign in again, i.e. a
      // token issued after that second.)
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const second = await create();
      expect(second.statusCode, second.body).toBe(201);
      const secondBody = second.json() as { rawKey: string; apiKey: { id: string } };
      expect(secondBody.apiKey.id).not.toBe(firstBody.apiKey.id);
      expect((await use(secondBody.rawKey)).statusCode).not.toBe(401);
      expect((await use(firstBody.rawKey)).statusCode).toBe(401);
      expect(
        await prisma.apiCredential.groupBy({
          by: ["status"],
          where: { teamId: A().teamId, createdByUserId: creator.id },
          _count: { _all: true },
          orderBy: { status: "asc" },
        }),
      ).toEqual([
        { status: "ACTIVE", _count: { _all: 1 } },
        { status: "REVOKED", _count: { _all: 1 } },
      ]);
    } finally {
      await prisma.entitlementGrant.deleteMany({ where: { teamId: A().teamId, key: "INTEGRATION_API_KEYS_MAX" } });
      for (const [k, v] of Object.entries(previousEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
