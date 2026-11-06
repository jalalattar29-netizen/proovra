/**
 * FEATURES ROUND 3 FOLLOW-UP — executed closures for A-FEAT-7 and the ORG_OWNER
 * promotion half of PRO-097.
 *
 *   A-FEAT-7  a QC reviewer must be independent of the sampled decision (the
 *             same separation of duties WORKFLOW-018 gives the adjudicator):
 *             refused at assignment and again at the verdict, 409
 *             QC_REVIEWER_NOT_INDEPENDENT, nothing written.
 *   PRO-097   PATCH /v1/orgs/:id/members/:memberId promoting to ORG_OWNER
 *             asks the owner's account step-up, as the ORG_OWNER invite and
 *             the ownership transfer do.
 *
 * WHAT IS REAL: PostgreSQL 16 (testcontainers), the API over `inject`, the real
 * review approve route that draws the QC sample, and the real account step-up
 * (an authenticator code the test computes from the enrolled factor).
 */
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness, TeamFixture } from "./integration-harness.js";

process.env.MFA_SECRET_KEK_BASE64 = process.env.MFA_SECRET_KEK_BASE64 ?? randomBytes(32).toString("base64");
process.env.REVIEWER_QC_SAMPLE_PERCENT = "100";

type Res = { statusCode: number; body: string };
const json = <T = Record<string, unknown>>(r: Res): T => JSON.parse(r.body) as T;

describe("features round 3 follow-up (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let ceremony: ReturnType<(typeof import("./support/step-up-ceremony.js"))["createStepUpCeremony"]>;
  let A: TeamFixture;
  let orgA = "";

  const req = (method: string, url: string, token?: string, payload?: unknown) =>
    h.app.inject({
      method: method as "GET",
      url,
      payload: payload as never,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }) as unknown as Promise<Res>;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    const { createStepUpCeremony } = await import("./support/step-up-ceremony.js");
    ceremony = createStepUpCeremony({
      prisma: prisma as never,
      inject: (o) => h.app.inject({ method: o.method, url: o.url, headers: o.headers, payload: o.payload as never }) as never,
    });
    const { upsertEnterpriseContract } = await import("../src/services/organization/enterprise-contract.service.js");
    A = h.fixtures.teamA;
    for (const id of [A.ownerUserId, A.adminUserId, A.memberUserId, A.viewerUserId]) {
      await prisma.user.update({ where: { id }, data: { currentWorkspaceId: A.teamId } as never });
    }
    const team = await prisma.team.update({
      where: { id: A.teamId },
      data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never,
      select: { organizationId: true },
    });
    orgA = team.organizationId as string;
    await prisma.$transaction((tx) =>
      upsertEnterpriseContract(tx as never, {
        organizationId: orgA,
        status: "ACTIVE",
        activationState: "ACTIVATED",
        seatCount: 50,
        reviewerOperationsEnabled: true,
      } as never),
    );
  }, 600_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  async function sampledWorkflow(title: string) {
    const ev = await prisma.evidence.create({
      data: {
        title,
        displayFileName: `${title}.jpg`,
        type: "PHOTO",
        status: "SIGNED",
        teamId: A.teamId,
        organizationId: orgA,
        ownerUserId: A.ownerUserId,
      } as never,
    });
    const wf = await prisma.evidenceReviewWorkflow.create({
      data: { evidenceId: ev.id, teamId: A.teamId, workspaceType: "TEAM", status: "IN_REVIEW" } as never,
    });
    // The ADMIN makes the decision the sample checks.
    const approve = await req("POST", `/v1/reviewer-ops/reviews/${wf.id}/approve`, A.adminToken, { teamId: A.teamId, note: "decided by admin" });
    expect(approve.statusCode, approve.body).toBe(200);
    await h.handlersSettled();
    const decision = await prisma.workflowReviewDecision.findFirstOrThrow({ where: { workflowId: wf.id }, select: { reviewerUserId: true } });
    expect(decision.reviewerUserId).toBe(A.adminUserId);
    return prisma.qcSample.findFirstOrThrow({ where: { workflowId: wf.id, teamId: A.teamId } });
  }

  it("A-FEAT-7: the reviewer who decided the sampled review can neither be assigned nor render the verdict", async () => {
    const sample = await sampledWorkflow("R3QCIND");
    const q = `?teamId=${A.teamId}`;

    const selfAssign = await req("POST", `/v1/reviewer/qc/samples/${sample.id}/assign${q}`, A.adminToken, { qcReviewerUserId: A.adminUserId });
    expect(selfAssign.statusCode).toBe(409);
    expect(json<{ denial: string }>(selfAssign).denial).toBe("QC_REVIEWER_NOT_INDEPENDENT");
    const ownerAssignsDecider = await req("POST", `/v1/reviewer/qc/samples/${sample.id}/assign${q}`, A.ownerToken, { qcReviewerUserId: A.adminUserId });
    expect(ownerAssignsDecider.statusCode).toBe(409);
    expect(await prisma.qcSample.findUniqueOrThrow({ where: { id: sample.id }, select: { state: true, qcReviewerUserId: true } })).toEqual({
      state: "SAMPLED",
      qcReviewerUserId: null,
    });

    // A sample already held by its decider (assigned before the rule) cannot be graded by them.
    await prisma.qcSample.update({ where: { id: sample.id }, data: { state: "ASSIGNED", qcReviewerUserId: A.adminUserId, assignedAtUtc: new Date() } });
    const ownVerdict = await req("POST", `/v1/reviewer/qc/samples/${sample.id}/verdict${q}`, A.adminToken, { verdict: "PASS" });
    expect(ownVerdict.statusCode).toBe(409);
    expect(json<{ denial: string }>(ownVerdict).denial).toBe("QC_REVIEWER_NOT_INDEPENDENT");
    expect(await prisma.qcSample.findUniqueOrThrow({ where: { id: sample.id }, select: { state: true, verdict: true } })).toEqual({
      state: "ASSIGNED",
      verdict: null,
    });

    // Positive control: a reviewer who did not decide it is assigned and renders the verdict.
    const assigned = await req("POST", `/v1/reviewer/qc/samples/${sample.id}/assign${q}`, A.adminToken, { qcReviewerUserId: A.ownerUserId });
    expect(assigned.statusCode, assigned.body).toBe(200);
    const verdict = await req("POST", `/v1/reviewer/qc/samples/${sample.id}/verdict${q}`, A.ownerToken, { verdict: "PASS" });
    expect(verdict.statusCode, verdict.body).toBe(200);
    expect(await prisma.qcSample.findUniqueOrThrow({ where: { id: sample.id }, select: { state: true, verdict: true } })).toEqual({
      state: "VERDICT_RENDERED",
      verdict: "PASS",
    });
  });

  it("PRO-097: promoting a member to ORG_OWNER asks the owner's account step-up; other role changes do not", async () => {
    const membership = async (userId: string, role: string) => {
      const existing = await prisma.organizationMembership.findFirst({ where: { organizationId: orgA, userId } });
      if (existing) {
        return prisma.organizationMembership.update({ where: { id: existing.id }, data: { role, status: "ACTIVE" } as never });
      }
      return prisma.organizationMembership.create({ data: { organizationId: orgA, userId, role, status: "ACTIVE" } as never });
    };
    const admin = await membership(A.adminUserId, "ORG_ADMIN");
    const member = await membership(A.memberUserId, "ORG_MEMBER");
    const url = (id: string) => `/v1/orgs/${orgA}/members/${id}`;
    const roleOf = async (id: string) => (await prisma.organizationMembership.findUniqueOrThrow({ where: { id } })).role;
    const owners = () => prisma.organizationMembership.count({ where: { organizationId: orgA, role: "ORG_OWNER", status: "ACTIVE" } });
    const ownersBefore = await owners();

    // The finding: a session alone made a second owner.
    const bare = await req("PATCH", url(member.id), A.ownerToken, { role: "ORG_OWNER" });
    expect(bare.statusCode).toBe(401);
    expect(json<{ error: { code: string } }>(bare).error.code).toBe("STEP_UP_REQUIRED");
    expect(await roleOf(member.id)).toBe("ORG_MEMBER");
    await ceremony.enroll(A.ownerUserId);
    const wrong = await req("PATCH", url(member.id), A.ownerToken, { role: "ORG_OWNER", stepUp: { method: "mfa", code: "000000" } });
    expect(wrong.statusCode).toBe(401);
    expect(await owners()).toBe(ownersBefore);

    // Controls: an ORG_ADMIN is refused by the role rule (403), and a role
    // change that grants no ownership needs no proof.
    expect((await req("PATCH", url(member.id), A.adminToken, { role: "ORG_OWNER" })).statusCode).toBe(403);
    const lower = await req("PATCH", url(member.id), A.ownerToken, { role: "ORG_AUDITOR" });
    expect(lower.statusCode, lower.body).toBe(200);
    expect(await roleOf(member.id)).toBe("ORG_AUDITOR");

    // With the owner's own proof the promotion lands.
    const proved = await req("PATCH", url(admin.id), A.ownerToken, {
      role: "ORG_OWNER",
      stepUp: { method: "mfa", code: await ceremony.freshCode(A.ownerUserId) },
    });
    expect(proved.statusCode, proved.body).toBe(200);
    expect(await roleOf(admin.id)).toBe("ORG_OWNER");
    expect(await owners()).toBe(ownersBefore + 1);
  });
});
