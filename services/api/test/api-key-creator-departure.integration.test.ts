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

describe("A2-10 — integration API keys and their creator (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let rbac: typeof import("../src/services/identity/rbac.service.js");
  let legalVersions: Record<string, string>;
  const A = () => h.fixtures.teamA;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as import("@prisma/client").PrismaClient;
    rbac = await import("../src/services/identity/rbac.service.js");
    legalVersions = (await import("../src/legal/legal-versioning.js")).REQUIRED_LEGAL_VERSIONS as Record<string, string>;
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
});
