/**
 * AUD-39 (2026-10-20) — the operational seed. Live PostgreSQL 16, the real
 * route and service.
 *
 * Before this phase: a request without `dryRun` WROTE (dryRun defaulted to
 * false); the seed attached backdated review workflows to whatever existing
 * evidence the workspace had — customers' records; and cleanup deleted every
 * event on those workflows, including review work people did after the seed.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "../integration-harness.js";

const SECRET = "aud39-throwaway-seed-secret-0123456789";

describe("AUD-39 operational seed (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../../src/db.js"))["prisma"];
  let seed: typeof import("../../src/services/ops/operational-seed.service.js");
  const seeded: string[] = [];

  async function evidence(teamId: string): Promise<string> {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true, ownerUserId: true } });
    const id = randomUUID();
    await prisma.evidence.create({
      data: {
        id,
        teamId,
        organization: { connect: { id: team.organizationId } },
        type: "PHOTO",
        ownerUserId: team.ownerUserId,
        uploadedByUserId: team.ownerUserId,
        status: "SIGNED",
        title: "aud39",
      },
    });
    seeded.push(id);
    return id;
  }

  beforeAll(async () => {
    process.env.OPERATIONAL_SEEDING_ENABLED = "true";
    process.env.OPERATIONAL_SEEDING_SECRET = SECRET;
    const { bootIntegrationHarness } = await import("../integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../../src/db.js"));
    seed = await import("../../src/services/ops/operational-seed.service.js");
    // Workspace A is the designated seed workspace; B is a customer workspace.
    process.env.OPERATIONAL_SEEDING_TEAM_IDS = h.fixtures.teamA.teamId;
    for (let i = 0; i < 2; i += 1) await evidence(h.fixtures.teamA.teamId);
    await evidence(h.fixtures.teamB.teamId);
  }, 180_000);
  afterAll(async () => {
    delete process.env.OPERATIONAL_SEEDING_TEAM_IDS;
    delete process.env.OPERATIONAL_SEEDING_ENABLED;
    delete process.env.OPERATIONAL_SEEDING_SECRET;
    await h?.cleanup();
  });

  it("a request that does not say dryRun: false writes nothing", async () => {
    const A = h.fixtures.teamA;
    const before = await prisma.evidenceReviewWorkflow.count({ where: { teamId: A.teamId } });
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/ops/seed/reviewer-ops",
      headers: { authorization: `Bearer ${A.ownerToken}`, "content-type": "application/json", "x-operational-seed-secret": SECRET },
      payload: { teamId: A.teamId, scenario: "baseline", count: 1 },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body).dryRun).toBe(true);
    expect(await prisma.evidenceReviewWorkflow.count({ where: { teamId: A.teamId } })).toBe(before);
  });

  it("a real run into a workspace not designated for seeding is refused, and nothing is written", async () => {
    const B = h.fixtures.teamB;
    const before = await prisma.evidenceReviewWorkflow.count({ where: { teamId: B.teamId } });
    await expect(
      seed.runOperationalSeed({ teamId: B.teamId, scenario: "sla_breach", count: 1, dryRun: false, actorUserId: B.ownerUserId }),
    ).rejects.toMatchObject({ code: "SEEDING_TEAM_NOT_DESIGNATED" });
    expect(await prisma.evidenceReviewWorkflow.count({ where: { teamId: B.teamId } })).toBe(before);
  });

  it("cleanup keeps a seeded workflow a person acted on after the seed, with its events", async () => {
    const A = h.fixtures.teamA;
    const run = await seed.runOperationalSeed({ teamId: A.teamId, scenario: "baseline", count: 2, dryRun: false, actorUserId: A.ownerUserId });
    expect(run.created.workflowIds.length).toBeGreaterThanOrEqual(2);
    const [touched, untouched] = run.created.workflowIds;
    const wf = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: touched! }, select: { evidenceId: true } });
    // A reviewer's real action, after the seed finished.
    const human = await prisma.evidenceReviewWorkflowEvent.create({
      data: { workflowId: touched!, evidenceId: wf.evidenceId, actorUserId: A.adminUserId, eventType: "REVIEW_STARTED", createdAt: new Date(Date.now() + 1000) },
    });
    const result = await seed.cleanupSeedRun({ seedRunId: run.seedRunId, teamId: A.teamId, actorUserId: A.ownerUserId });
    expect(result.kept.workflows).toBe(1);
    expect(await prisma.evidenceReviewWorkflow.findUnique({ where: { id: touched! } })).not.toBeNull();
    expect(await prisma.evidenceReviewWorkflowEvent.findUnique({ where: { id: human.id } })).not.toBeNull();
    expect(await prisma.evidenceReviewWorkflow.findUnique({ where: { id: untouched! } })).toBeNull();
  });

  it("PRO-079 — an admin of workspace A cannot clean up workspace B's seed run; B's own admin can", async () => {
    const A = h.fixtures.teamA;
    const B = h.fixtures.teamB;
    process.env.OPERATIONAL_SEEDING_TEAM_IDS = `${A.teamId},${B.teamId}`;
    try {
      const run = await seed.runOperationalSeed({ teamId: B.teamId, scenario: "sla_breach", count: 1, dryRun: false, actorUserId: B.ownerUserId });
      const counts = async () => ({
        workflows: await prisma.evidenceReviewWorkflow.count({ where: { id: { in: run.created.workflowIds } } }),
        escalations: await prisma.reviewEscalation.count({ where: { id: { in: run.created.escalationIds } } }),
        incidents: await prisma.operationalIncident.count({ where: { id: { in: run.created.incidentIds } } }),
      });
      const seededRows = await counts();
      expect(seededRows.workflows).toBeGreaterThan(0);

      const del = (token: string, teamId: string) =>
        h.app.inject({
          method: "DELETE",
          url: `/v1/ops/seed/reviewer-ops/${run.seedRunId}?teamId=${teamId}`,
          headers: { authorization: `Bearer ${token}`, "x-operational-seed-secret": SECRET },
        });

      // Attack: authorized in A (with the secret), naming B's run.
      const attack = await del(A.ownerToken, A.teamId);
      expect(attack.statusCode, attack.body).toBe(200);
      expect(JSON.parse(attack.body)).toMatchObject({ notFound: true, deleted: { workflows: 0, escalations: 0, incidents: 0 } });
      await h.handlersSettled();
      expect(await counts(), "a foreign workspace's seed rows were deleted").toEqual(seededRows);
      // The refused attempt is recorded against the caller's own workspace.
      const attackAudit = await prisma.adminAuditLog.findFirst({
        where: { action: { contains: "seed" }, resourceId: run.seedRunId, userId: A.ownerUserId },
        orderBy: { createdAt: "desc" },
        select: { workspaceId: true },
      });
      expect(attackAudit?.workspaceId).toBe(A.teamId);

      // Positive control: B's owner, authorized in B, cleans up B's run.
      const own = await del(B.ownerToken, B.teamId);
      expect(own.statusCode, own.body).toBe(200);
      expect(JSON.parse(own.body).notFound).toBe(false);
      const after = await counts();
      expect(after.workflows).toBe(0);
      expect(after.incidents).toBe(0);
    } finally {
      process.env.OPERATIONAL_SEEDING_TEAM_IDS = A.teamId;
    }
  });
});
