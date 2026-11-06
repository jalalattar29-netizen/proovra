/**
 * INGEST-010 — a secure intake link does not outlive its creator (live PostgreSQL).
 *
 * No membership path touched `workflow_intake_links`: a link whose creator was
 * removed or suspended stayed ACTIVE in the operator's list while every new
 * contributor's first file was refused (the record is created in the
 * creator's name). Intake links now follow the creator-scoped rule owner share
 * links already follow (members-and-access-model §5.3): they end, with the
 * reason, when the creator is removed or suspended. A role change does not end
 * them.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("INGEST-010 — intake links and their creator (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let rbac: typeof import("../src/services/identity/rbac.service.js");
  let links: typeof import("../src/services/workflow-intake-link.service.js");
  const A = () => h.fixtures.teamA;

  beforeAll(async () => {
    process.env.WORKFLOW_INTAKE_LINKS_ENABLED = "true";
    process.env.WORKFLOW_INTAKE_TOKEN_SECRET ??= "integration-only-intake-secret-ingest010-0123456789abcdef";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as import("@prisma/client").PrismaClient;
    rbac = await import("../src/services/identity/rbac.service.js");
    links = await import("../src/services/workflow-intake-link.service.js");
    await prisma.team.updateMany({ where: { id: A().teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  async function person(role: "ADMIN" | "MEMBER") {
    const { REQUIRED_LEGAL_VERSIONS } = await import("../src/legal/legal-versioning.js");
    const email = `intake-${randomUUID().slice(0, 8)}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, displayName: "Intake creator", provider: "EMAIL", providerUserId: email },
      select: { id: true },
    });
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion: policyVersion as string,
        source: "integration-harness",
      })),
    });
    const m = await prisma.teamMember.create({ data: { teamId: A().teamId, userId: user.id, role, status: "ACTIVE" } });
    return { id: user.id, memberId: m.id };
  }

  const mint = async (creatorUserId: string) =>
    (
      await links.createWorkflowIntakeLink(
        {
          teamId: A().teamId,
          workflowTemplateSlug: "general-evidence-record",
          intakeMode: "EXTERNAL_ONE_TIME",
          expiresAtUtc: new Date(Date.now() + 7 * 86_400_000),
        } as never,
        { actorUserId: creatorUserId },
        prisma,
      )
    ).link.id;

  const row = (id: string) =>
    prisma.workflowIntakeLink.findUniqueOrThrow({ where: { id }, select: { status: true, revokedReason: true, revokedAtUtc: true } });

  it("removing the creator revokes their live intake links, with the reason", async () => {
    const creator = await person("ADMIN");
    const id = await mint(creator.id);
    const other = await mint(A().ownerUserId);
    await rbac.revokeMember({ teamId: A().teamId, teamMemberId: creator.memberId, actorUserId: A().ownerUserId });
    expect(await row(id)).toMatchObject({ status: "REVOKED", revokedReason: "creator_removed" });
    // Positive control: another creator's link is untouched.
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

  it("a role change alone leaves the link live", async () => {
    const creator = await person("ADMIN");
    const id = await mint(creator.id);
    await rbac.changeMemberRole({ teamId: A().teamId, teamMemberId: creator.memberId, actorUserId: A().ownerUserId, newRole: "MEMBER" });
    expect((await row(id)).status).toBe("ACTIVE");
  });
});
