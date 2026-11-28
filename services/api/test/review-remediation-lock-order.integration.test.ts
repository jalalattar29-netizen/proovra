/**
 * Review remediation IR-06 (2026-11-28) — lock order between a verdict and the
 * loss of Review placement, with TWO real database connections and a
 * deterministic barrier (no timing guesses).
 *
 * A verdict locks the review row FIRST, then (when a placement rule applies)
 * reads the deciding member's Collaboration Team membership FOR SHARE.
 * Suspending / removing that member updates the membership and releases the
 * reviews they hold. Before IR-06 the release locked the reviews AFTER the
 * membership update — the opposite order — so a verdict holding the review and
 * waiting for the membership, and a suspension holding the membership and
 * waiting for the review, formed a cycle (PostgreSQL aborts one: a raw 500 or
 * a failed suspension).
 *
 * The barrier: the verdict is paused right after its review-row lock
 * (`testHooks.afterWorkflowLock`); the suspension / removal starts and the
 * test waits (pg_stat_activity) until it is BLOCKED on a lock; then the verdict
 * continues. Every outcome must be safe and explained: no deadlock error, no
 * raw 500, no review left assigned to a member who lost placement.
 *
 * Variants: Team workspace with the explicit Review placement policy
 * (suspension and removal; a verdict and a request for information) and an Enterprise workspace whose contract requires
 * placement (suspension). The reverse interleaving (placement lost first, then
 * the verdict) is refused with `reviewer_not_eligible`.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness } from "./integration-harness.js";

let harness: IntegrationHarness;
let prisma: typeof import("../src/db.js").prisma;
let decisions: typeof import("../src/services/reviewer-ops/review-decision.service.js");
let collab: typeof import("../src/services/collaboration-team/collaboration-team.service.js");
let requiredLegalVersions: Record<string, unknown>;

type Space = { teamId: string; ownerId: string; groupId: string };

async function newUserId(label: string): Promise<string> {
  const email = `rlo-${label}-${randomUUID().slice(0, 8)}@test.proovra.local`;
  const id = (
    await prisma.user.create({
      data: { email, firstName: "RLO", lastName: label, displayName: `RLO ${label}`, provider: "EMAIL", providerUserId: email },
      select: { id: true },
    })
  ).id;
  await prisma.userLegalAcceptance.createMany({
    data: Object.entries(requiredLegalVersions).map(([policyKey, policyVersion]) => ({
      userId: id,
      policyKey,
      policyVersion: policyVersion as string,
      source: "integration-harness",
    })),
  });
  return id;
}

/** A group led by the workspace owner (the actor of suspend / remove). */
async function group(space: { teamId: string; ownerId: string }): Promise<string> {
  const g = await prisma.collaborationTeam.create({
    data: { workspaceId: space.teamId, name: `RLO ${randomUUID().slice(0, 6)}`, createdByUserId: space.ownerId, status: "ACTIVE" },
    select: { id: true },
  });
  await prisma.collaborationTeamMember.create({ data: { teamId: g.id, userId: space.ownerId, role: "LEAD", status: "ACTIVE" } });
  return g.id;
}

/** A placed MEMBER holding one review in progress (single assigned reviewer). */
async function placedMemberWithReview(space: Space, label: string) {
  const memberId = await newUserId(label);
  await prisma.teamMember.create({ data: { teamId: space.teamId, userId: memberId, role: "MEMBER", status: "ACTIVE" } });
  const membership = await prisma.collaborationTeamMember.create({
    data: { teamId: space.groupId, userId: memberId, role: "MEMBER", status: "ACTIVE" },
    select: { id: true },
  });
  const t = await prisma.team.findUniqueOrThrow({ where: { id: space.teamId }, select: { organizationId: true } });
  const evidenceId = (
    await prisma.evidence.create({
      data: { title: `rlo ${label}`, type: "PHOTO", status: "CREATED", teamId: space.teamId, organizationId: t.organizationId, ownerUserId: space.ownerId },
      select: { id: true },
    })
  ).id;
  const workflowId = (
    await prisma.evidenceReviewWorkflow.create({
      data: { evidenceId, teamId: space.teamId, status: "IN_REVIEW", workspaceType: "TEAM", assignedToUserId: memberId } as never,
      select: { id: true },
    })
  ).id;
  await prisma.evidenceReviewWorkflowEvent.create({
    data: { workflowId, evidenceId, actorUserId: memberId, eventType: "REVIEW_STARTED", nextValue: { stage: "IN_REVIEW" } } as never,
  });
  return { memberId, membershipId: membership.id, workflowId };
}

/** Wait until some backend of this database is blocked on a lock (the barrier). */
async function waitForLockWaiter(timeoutMs = 10_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active'`;
    if (Number(rows[0]?.n ?? 0) > 0) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

const isDeadlock = (e: unknown) => /40P01|deadlock|P2034/i.test(`${(e as { code?: string })?.code ?? ""} ${(e as Error)?.message ?? ""}`);

/**
 * The interleaving that used to deadlock: verdict holds the review row; the
 * placement loss starts and blocks; then the verdict continues.
 */
async function interleave(
  space: Space,
  r: Awaited<ReturnType<typeof placedMemberWithReview>>,
  lose: () => Promise<void>,
  decision: "APPROVE" | "REQUEST_INFO" = "APPROVE",
) {
  let reached!: () => void;
  const atLock = new Promise<void>((res) => (reached = res));
  let open!: () => void;
  const gate = new Promise<void>((res) => (open = res));
  const verdict = decisions.recordReviewDecision(
    {
      workflowId: r.workflowId,
      teamId: space.teamId,
      actorUserId: r.memberId,
      decision,
      rationale: decision === "APPROVE" ? "complete and consistent" : "Please send the original file and its export log.",
      actorIsAdjudicator: false,
      testHooks: {
        afterWorkflowLock: async () => {
          reached();
          await gate;
        },
      },
    } as never,
    prisma,
  );
  await atLock;
  const loss = lose();
  const blocked = await waitForLockWaiter();
  open();
  const [v, l] = await Promise.allSettled([verdict, loss]);
  return { blocked, v, l };
}

async function assertSafe(r: { workflowId: string; memberId: string; membershipId: string }, out: Awaited<ReturnType<typeof interleave>>, lostStatus: string) {
  expect(out.blocked, "the placement loss must block on a lock (barrier reached)").toBe(true);
  for (const s of [out.v, out.l]) {
    if (s.status === "rejected") expect(isDeadlock(s.reason), String((s.reason as Error)?.message)).toBe(false);
  }
  // The placement loss always completes.
  expect(out.l.status, out.l.status === "rejected" ? String((out.l.reason as Error)?.message) : "").toBe("fulfilled");
  expect(String((await prisma.collaborationTeamMember.findUniqueOrThrow({ where: { id: r.membershipId } })).status)).toBe(lostStatus);
  // The verdict either recorded (it held the review before the loss) or was refused as not eligible.
  if (out.v.status === "rejected") {
    expect(out.v.reason).toBeInstanceOf(decisions.ReviewDecisionAuthorityError);
    expect((out.v.reason as { code?: string }).code ?? String(out.v.reason)).toMatch(/reviewer_not_eligible/);
  }
  // Never stranded: an open review is no longer assigned to the member who lost placement.
  const wf = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: r.workflowId } });
  const finished = ["APPROVED_INTERNAL", "REJECTED_INSUFFICIENT", "CLOSED"].includes(String(wf.status));
  if (!finished) expect(wf.assignedToUserId).not.toBe(r.memberId);
}

let teamSpace: Space;
let enterpriseSpace: Space;

beforeAll(async () => {
  harness = await bootIntegrationHarness();
  ({ prisma } = await import("../src/db.js"));
  ({ REQUIRED_LEGAL_VERSIONS: requiredLegalVersions } = await import("../src/legal/legal-versioning.js"));
  decisions = await import("../src/services/reviewer-ops/review-decision.service.js");
  collab = await import("../src/services/collaboration-team/collaboration-team.service.js");
  const { ensurePersonalWorkspace } = await import("../src/services/platform-context/workspace-bootstrap.service.js");

  // Team (personal workspace, TEAM plan) with the explicit Review placement policy.
  const owner = await newUserId("owner");
  const space = await ensurePersonalWorkspace({ userId: owner });
  const updated = await prisma.entitlement.updateMany({ where: { userId: owner }, data: { plan: "TEAM", active: true } });
  if (updated.count === 0) await prisma.entitlement.create({ data: { userId: owner, plan: "TEAM" } });
  await prisma.workspaceGovernancePolicy.upsert({
    where: { teamId: space.teamId },
    create: { teamId: space.teamId, reviewRequiresTeamPlacement: true } as never,
    update: { reviewRequiresTeamPlacement: true },
  });
  teamSpace = { teamId: space.teamId, ownerId: owner, groupId: await group({ teamId: space.teamId, ownerId: owner }) };

  // Enterprise workspace whose ACTIVE contract requires placement.
  const a = harness.fixtures.teamA;
  const orgA = (await prisma.team.findUniqueOrThrow({ where: { id: a.teamId }, select: { organizationId: true } })).organizationId;
  await prisma.team.update({ where: { id: a.teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } });
  const { upsertEnterpriseContract } = await import("../src/services/organization/enterprise-contract.service.js");
  await upsertEnterpriseContract(prisma as never, { organizationId: orgA, status: "ACTIVE", activationState: "ACTIVATED", seatCount: 25 });
  await prisma.enterpriseContract.update({ where: { organizationId: orgA! }, data: { assignmentRequiresTeamPlacement: true } });
  enterpriseSpace = { teamId: a.teamId, ownerId: a.ownerUserId, groupId: await group({ teamId: a.teamId, ownerId: a.ownerUserId }) };
  const { reviewAssignmentRequiresPlacement } = await import("../src/services/assignment/placement-policy.js");
  expect(await reviewAssignmentRequiresPlacement(teamSpace.teamId, prisma)).toBe(true);
  expect(await reviewAssignmentRequiresPlacement(enterpriseSpace.teamId, prisma)).toBe(true);
}, 900_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
}, 300_000);

describe("IR-06 — verdict vs loss of placement: one lock order, safe outcomes", () => {
  it("Team placement policy — suspension while the verdict holds the review: no deadlock, verdict recorded, nothing stranded", async () => {
    const r = await placedMemberWithReview(teamSpace, "t-susp");
    const out = await interleave(teamSpace, r, () =>
      collab.suspendMember({ teamId: teamSpace.groupId, actorUserId: teamSpace.ownerId, memberId: r.membershipId, reason: "barrier" }),
    );
    await assertSafe(r, out, "SUSPENDED");
  });

  it("Team placement policy — removal while the verdict holds the review: no deadlock, nothing stranded", async () => {
    const r = await placedMemberWithReview(teamSpace, "t-rem");
    const out = await interleave(teamSpace, r, () =>
      collab.removeMember({ teamId: teamSpace.groupId, actorUserId: teamSpace.ownerId, memberId: r.membershipId }),
    );
    await assertSafe(r, out, "REMOVED");
  });

  it("Enterprise contract placement — suspension while the verdict holds the review: no deadlock, nothing stranded", async () => {
    const r = await placedMemberWithReview(enterpriseSpace, "e-susp");
    const out = await interleave(enterpriseSpace, r, () =>
      collab.suspendMember({ teamId: enterpriseSpace.groupId, actorUserId: enterpriseSpace.ownerId, memberId: r.membershipId, reason: "barrier" }),
    );
    await assertSafe(r, out, "SUSPENDED");
  });

  it("Team placement policy — suspension while a REQUEST FOR INFORMATION holds the review: no deadlock, nothing stranded", async () => {
    const r = await placedMemberWithReview(teamSpace, "t-info");
    const out = await interleave(
      teamSpace,
      r,
      () => collab.suspendMember({ teamId: teamSpace.groupId, actorUserId: teamSpace.ownerId, memberId: r.membershipId, reason: "barrier" }),
      "REQUEST_INFO",
    );
    await assertSafe(r, out, "SUSPENDED");
  });

  it("reverse order — placement lost first: the review is released and a late verdict is refused as not eligible", async () => {
    for (const space of [teamSpace, enterpriseSpace]) {
      const r = await placedMemberWithReview(space, "rev");
      await collab.suspendMember({ teamId: space.groupId, actorUserId: space.ownerId, memberId: r.membershipId, reason: "first" });
      const wf = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: r.workflowId } });
      expect(wf.assignedToUserId).toBeNull();
      await expect(
        decisions.recordReviewDecision(
          { workflowId: r.workflowId, teamId: space.teamId, actorUserId: r.memberId, decision: "APPROVE", rationale: "late", actorIsAdjudicator: false } as never,
          prisma,
        ),
      ).rejects.toBeInstanceOf(decisions.ReviewDecisionAuthorityError);
      expect(await prisma.workflowReviewDecision.count({ where: { workflowId: r.workflowId } })).toBe(0);
    }
  });
});
