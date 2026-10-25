/**
 * PHASE C — WHO A REVIEW MAY GO TO, AND WHO SEES IT QUEUED (members audit
 * REV-02, REV-03, REV-05).
 *
 * A review is handed only to an active, reviewer-capable member of the
 * record's workspace who can reach the evidence; a queue never lists a
 * workflow whose evidence sits on a restricted case the caller is not on; and
 * handing work out is the canonical `review.assign` capability. Every case
 * drives the real services and routes against a real PostgreSQL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("Phase C — review assignment and queue reach", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let review: typeof import("../src/services/review-operations/review-operations.service.js");
  const W = () => h.fixtures.personal;
  const owner = () => W().userId;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as import("@prisma/client").PrismaClient;
    ({ signJwt } = await import("../src/services/jwt.js"));
    review = await import("../src/services/review-operations/review-operations.service.js");
    await prisma.entitlement.updateMany({ where: { userId: owner() }, data: { active: false } });
    await prisma.entitlement.create({ data: { userId: owner(), plan: "TEAM", active: true, credits: 0 } });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const tag = () => randomUUID().slice(0, 8);

  async function person(role: "MEMBER" | "VIEWER" | null) {
    const { REQUIRED_LEGAL_VERSIONS } = await import("../src/legal/legal-versioning.js");
    const email = `phase-c-review-${tag()}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, firstName: "Review", lastName: "Member", provider: "EMAIL", providerUserId: email },
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
    if (role) {
      await prisma.teamMember.create({ data: { teamId: W().teamId, userId: user.id, role, status: "ACTIVE" } });
    }
    const token = signJwt(
      { sub: user.id, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      process.env.AUTH_JWT_SECRET as string,
      3600,
    );
    return { id: user.id, token };
  }

  async function workflow(opts: { restrictedTo?: string[] } = {}) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: W().teamId }, select: { organizationId: true } });
    const evidence = await prisma.evidence.create({
      data: {
        title: `Review ${tag()}`,
        type: "PHOTO",
        status: "CREATED",
        teamId: W().teamId,
        organizationId: team.organizationId,
        ownerUserId: owner(),
      },
      select: { id: true },
    });
    if (opts.restrictedTo) {
      const c = await prisma.case.create({
        data: { name: `Restricted ${tag()}`, teamId: W().teamId, ownerUserId: owner() },
        select: { id: true },
      });
      for (const userId of opts.restrictedTo) await prisma.caseAccess.create({ data: { caseId: c.id, userId } });
      await prisma.caseEvidenceLink.create({ data: { caseId: c.id, evidenceId: evidence.id } });
    }
    const wf = await prisma.evidenceReviewWorkflow.create({
      data: { teamId: W().teamId, evidenceId: evidence.id, workspaceType: "PERSONAL", status: "QUEUED" as never },
      select: { id: true, evidenceId: true },
    });
    return wf;
  }

  const codeOf = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: { code?: string }) => e.code ?? "unknown",
    );

  it("REV-02 — a stranger, a VIEWER and a suspended member cannot be handed a review", async () => {
    const wf = await workflow();
    const stranger = await person(null);
    const viewer = await person("VIEWER");
    const suspended = await person("MEMBER");
    await prisma.teamMember.updateMany({ where: { teamId: W().teamId, userId: suspended.id }, data: { status: "SUSPENDED" } });
    for (const assignee of [stranger, viewer, suspended]) {
      expect(
        await codeOf(review.assignReviewer({ evidenceId: wf.evidenceId, assignedToUserId: assignee.id, actorUserId: owner() })),
      ).toBe("assignee_not_eligible");
    }
    const row = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: wf.id } });
    // Nothing moved — so the assignment mail (which names the workspace)
    // was never sent to anyone outside it.
    expect(row.assignedToUserId).toBeNull();
  });

  it("REV-02 — someone off a restricted case's access list cannot be handed its evidence's review", async () => {
    const insider = await person("MEMBER");
    const outsider = await person("MEMBER");
    const wf = await workflow({ restrictedTo: [insider.id] });
    expect(
      await codeOf(review.assignReviewer({ evidenceId: wf.evidenceId, assignedToUserId: outsider.id, actorUserId: owner() })),
    ).toBe("assignee_not_eligible");
    const moved = await review.assignReviewer({ evidenceId: wf.evidenceId, assignedToUserId: insider.id, actorUserId: owner() });
    expect(moved.assignedToUserId).toBe(insider.id);
  });

  it("REV-03 — the queue leaves out workflows on restricted cases the caller is not on", async () => {
    const insider = await person("MEMBER");
    const outsider = await person("MEMBER");
    const restricted = await workflow({ restrictedTo: [insider.id] });
    const open = await workflow();
    const forOutsider = (await review.listReviewQueue({ teamId: W().teamId, viewerUserId: outsider.id, limit: 200 })).map((r) => r.id);
    const forInsider = (await review.listReviewQueue({ teamId: W().teamId, viewerUserId: insider.id, limit: 200 })).map((r) => r.id);
    expect(forOutsider).toContain(open.id);
    expect(forOutsider).not.toContain(restricted.id);
    expect(forInsider).toContain(restricted.id);

    const { listReviewerOpsQueue } = await import("../src/services/reviewer-ops/reviewer-operations-engine.service.js");
    const engine = await listReviewerOpsQueue({ teamId: W().teamId, queue: "UNASSIGNED", meUserId: outsider.id, limit: 100 } as never);
    const engineIds = engine.rows.map((r) => r.workflowId);
    expect(engineIds).toContain(open.id);
    expect(engineIds).not.toContain(restricted.id);
  });

  it("REV-05 — bulk ASSIGN is the review.assign capability: a VIEWER is refused, nothing moves", async () => {
    const wf = await workflow();
    const viewer = await person("VIEWER");
    const member = await person("MEMBER");
    const res = await h.app.inject({
      method: "POST",
      url: "/v1/review-operations/bulk",
      headers: { authorization: `Bearer ${viewer.token}` },
      payload: { teamId: W().teamId, evidenceIds: [wf.evidenceId], action: "ASSIGN", assignedToUserId: member.id },
    });
    // A member of the workspace already knows the record exists: 403, not 404.
    expect(res.statusCode).toBe(403);
    expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: wf.id } })).assignedToUserId).toBeNull();
  });
});
