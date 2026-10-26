/**
 * REV-04 — a Collaboration Team task that points at a REVIEW is not a second
 * reviewer-assignment system with its own, weaker eligibility rule.
 *
 * The two concepts stay separate (owner: do not merge). A Collaboration Team
 * task is an internal TASK held by a group member; the reviewer workflow
 * assignment (`evidence_review_workflows.assigned_to_user_id`) is who carries
 * the review. A REVIEW-target task only POINTS at a workflow. But handing
 * someone a task "about this review" is handing them review work, so its
 * assignee must pass the same authority the reviewer assignment does
 * (`assertWorkAssigneeEligible` with `evidence_request.review` and the
 * evidence's reach): a group member whose workspace role cannot review — a
 * VIEWER — must be refused, exactly as the review console refuses them.
 *
 * The task writer (services/collaboration-team/collaboration-team.service.ts,
 * `assertTaskAssigneeEligible`) currently checks group role and record reach
 * only; the first case below fails until it calls the canonical authority for
 * a REVIEW target. Driven over HTTP against a real PostgreSQL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { placeInCollaborationTeam } from "./support/place-in-collaboration-team.js";

describe("REV-04 — Collaboration Team REVIEW tasks obey the reviewer assignee authority", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let legal: typeof import("../src/legal/legal-versioning.js");
  const A = () => h.fixtures.teamA;
  const owner = () => A().ownerUserId;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as import("@prisma/client").PrismaClient;
    ({ signJwt } = await import("../src/services/jwt.js"));
    legal = await import("../src/legal/legal-versioning.js");
    await prisma.team.update({ where: { id: A().teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } as never });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const tag = () => randomUUID().slice(0, 8);

  async function person(role: "MEMBER" | "VIEWER") {
    const email = `rev04-${tag()}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, firstName: "Task", lastName: "Holder", provider: "EMAIL", providerUserId: email },
      select: { id: true },
    });
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(legal.REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion: policyVersion as string,
        source: "integration-harness",
      })),
    });
    await prisma.teamMember.create({ data: { teamId: A().teamId, userId: user.id, role, status: "ACTIVE" } });
    const token = signJwt(
      { sub: user.id, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      process.env.AUTH_JWT_SECRET as string,
      3600,
    );
    return { id: user.id, token };
  }

  async function reviewWorkflow() {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    const evidence = await prisma.evidence.create({
      data: {
        title: `REV-04 ${tag()}`,
        type: "PHOTO",
        status: "CREATED",
        teamId: A().teamId,
        organizationId: team.organizationId,
        ownerUserId: owner(),
      } as never,
      select: { id: true },
    });
    return prisma.evidenceReviewWorkflow.create({
      data: { teamId: A().teamId, evidenceId: evidence.id, workspaceType: "TEAM", status: "QUEUED" as never },
      select: { id: true },
    });
  }

  /** A group the workspace owner leads, so the owner may create its tasks. */
  async function ownerLedGroup(userIds: string[]) {
    const groupId = await placeInCollaborationTeam(prisma, { workspaceId: A().teamId, createdByUserId: owner(), userIds });
    await prisma.collaborationTeamMember.create({ data: { teamId: groupId, userId: owner(), role: "LEAD", status: "ACTIVE" } as never });
    return groupId;
  }

  const createTask = (groupId: string, targetId: string, assigneeUserId: string) =>
    h.app.inject({
      method: "POST",
      url: `/v1/collaboration-teams/${groupId}/assignments`,
      // The group lives in team A, so the request names that workspace.
      headers: { authorization: `Bearer ${A().ownerToken}`, "x-proovra-workspace-id": A().teamId },
      payload: { targetType: "REVIEW", targetId, assigneeUserId },
    });

  it("a group member whose workspace role cannot review (VIEWER) is refused a REVIEW task; a reviewer-capable member is accepted", async () => {
    const viewer = await person("VIEWER");
    const reviewer = await person("MEMBER");
    const groupId = await ownerLedGroup([viewer.id, reviewer.id]);
    const wf = await reviewWorkflow();

    const refused = await createTask(groupId, wf.id, viewer.id);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.body).toContain("TASK_ASSIGNEE_NOT_ELIGIBLE");
    expect(await prisma.collaborationTeamAssignment.count({ where: { targetId: wf.id, assigneeUserId: viewer.id } })).toBe(0);

    const ok = await createTask(groupId, wf.id, reviewer.id);
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it("a workspace member who is not in the group (so not placed by it) is refused a REVIEW task", async () => {
    const outsider = await person("MEMBER");
    const insider = await person("MEMBER");
    const groupId = await ownerLedGroup([insider.id]);
    const wf = await reviewWorkflow();
    const refused = await createTask(groupId, wf.id, outsider.id);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.body).toContain("TASK_ASSIGNEE_NOT_ELIGIBLE");
  });
});
