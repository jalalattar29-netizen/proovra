/**
 * THE REVIEW CAPABILITY × PLAN MATRIX, against a real PostgreSQL and the real
 * routes (owner correction 2026-10-24).
 *
 * The commercial contract, enforced through the ONE capability ladder
 * (`workspaceReviewCapabilities` ← `resolveEffectiveReviewCapabilities`):
 *
 *   FREE / PAY_PER_EVIDENCE  nothing — and credits never grant anything.
 *   PRO                      BASIC_RECORD_REVIEW only (claim / start, notes,
 *                            verdicts, request-info, Close, Reopen). None of
 *                            the TEAM orchestration tiers.
 *   TEAM                     everything except ADVANCED_REVIEW_WORKFLOWS.
 *   ENTERPRISE               the catalog answer, governed by the ACTIVE
 *                            organization contract: an explicit exclusion
 *                            withdraws the operations tiers; silence keeps
 *                            them; a non-ACTIVE contract excludes nothing
 *                            (lifecycle is asked upstream).
 *
 * Each denial here is a MUTANT KILL for one way of breaking the gate:
 * removing the reviewer-ops entitlement gate (FREE bulk / queue / assign
 * tests), granting review through credits (the credits test), allowing PRO
 * into TEAM tiers (the PRO orchestration tests), denying eligible TEAM (the
 * TEAM success tests), ignoring the Enterprise contract (the excluded /
 * silent / non-ACTIVE trio), and letting a downgrade keep mutating (the
 * downgrade block). The route-source test at the bottom kills "a new
 * reviewer-ops route forgot the gate".
 *
 * Expected refusals are TYPED 4xx replies sent by the route itself — they
 * never reach the error handler, so they cannot reach Sentry as errors; the
 * suite also asserts no 5xx and no internal text in any refusal body.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { bootIntegrationHarness, type IntegrationHarness, type TeamFixture } from "./integration-harness.js";

let harness: IntegrationHarness;
let A: TeamFixture;
let prisma: typeof import("../src/db.js").prisma;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- route bodies are asserted field by field
type Res = { status: number; body: any; raw: string };

async function call(
  token: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  payload?: unknown,
): Promise<Res> {
  const res = await harness.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}`, ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
    payload: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  let body: unknown = null;
  try {
    body = JSON.parse(res.body);
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body, raw: res.body };
}

/** A refusal must be typed, 4xx, and carry no internal detail. */
function expectCleanRefusal(res: Res, label: string) {
  expect(res.status, label).toBeGreaterThanOrEqual(400);
  expect(res.status, label).toBeLessThan(500);
  expect(res.raw, label).not.toMatch(/prisma|PrismaClient|findFirstOrThrow|\n\s+at |postgres|ECONN/i);
}

const setPlan = (team: TeamFixture, plan: "FREE" | "TEAM" | "ENTERPRISE") =>
  prisma.team.update({
    where: { id: team.teamId },
    data: { billingPlan: plan, billingStatus: plan === "FREE" ? "INACTIVE" : "ACTIVE" },
  });

async function orgOf(team: TeamFixture): Promise<string> {
  return (await prisma.team.findUniqueOrThrow({ where: { id: team.teamId }, select: { organizationId: true } }))
    .organizationId!;
}

async function setContract(
  team: TeamFixture,
  data: { status?: "ACTIVE" | "SUSPENDED"; reviewerOperationsEnabled?: boolean | null },
) {
  const organizationId = await orgOf(team);
  await prisma.enterpriseContract.upsert({
    where: { organizationId },
    create: {
      organizationId,
      status: data.status ?? "ACTIVE",
      reviewerOperationsEnabled: data.reviewerOperationsEnabled ?? null,
    },
    update: {
      status: data.status ?? "ACTIVE",
      reviewerOperationsEnabled: data.reviewerOperationsEnabled ?? null,
    },
  });
}

async function clearContract(team: TeamFixture) {
  await prisma.enterpriseContract.deleteMany({ where: { organizationId: await orgOf(team) } });
}

async function freshWorkflow(team: TeamFixture, title: string): Promise<{ evidenceId: string; workflowId: string }> {
  const t = await prisma.team.findUniqueOrThrow({ where: { id: team.teamId }, select: { organizationId: true } });
  const evidenceId = (
    await prisma.evidence.create({
      data: { title, type: "PHOTO", status: "CREATED", teamId: team.teamId, organizationId: t.organizationId, ownerUserId: team.ownerUserId },
      select: { id: true },
    })
  ).id;
  const workflowId = (
    await prisma.evidenceReviewWorkflow.create({
      data: { evidenceId, teamId: team.teamId, status: "NOT_STARTED", workspaceType: "TEAM" },
      select: { id: true },
    })
  ).id;
  return { evidenceId, workflowId };
}

/** One representative route per reviewer-ops capability, as the ADMIN. */
function opsCalls(team: TeamFixture, workflowId: string) {
  return {
    REVIEW_TASKS_AND_QUEUES: [
      () => call(team.adminToken, "GET", `/v1/reviewer-ops/queue?teamId=${team.teamId}`),
      () => call(team.adminToken, "GET", `/v1/reviewer-ops/dashboard?teamId=${team.teamId}`),
      () => call(team.adminToken, "GET", `/v1/reviewer-ops/saved-views?teamId=${team.teamId}`),
      () => call(team.adminToken, "GET", `/v1/reviewer-ops/sla-policy?teamId=${team.teamId}`),
    ],
    REVIEW_ASSIGNMENTS: [
      () =>
        call(team.adminToken, "POST", `/v1/reviewer-ops/reviews/${workflowId}/assign`, {
          teamId: team.teamId,
          assignedToUserId: team.memberUserId,
        }),
      () => call(team.adminToken, "GET", `/v1/reviewer-ops/assignable-reviewers?teamId=${team.teamId}`),
    ],
    REVIEW_ESCALATION: [
      () => call(team.adminToken, "GET", `/v1/reviewer-ops/escalations?teamId=${team.teamId}`),
    ],
    BULK_REVIEW_OPERATIONS: [
      () =>
        call(team.adminToken, "POST", "/v1/reviewer-ops/reviews/bulk", {
          teamId: team.teamId,
          workflowIds: [workflowId],
          action: "PRIORITY_HIGH",
        }),
    ],
  } as const;
}

beforeAll(async () => {
  harness = await bootIntegrationHarness();
  A = harness.fixtures.teamA;
  ({ prisma } = await import("../src/db.js"));
});

afterAll(async () => {
  if (harness) await harness.cleanup();
});

// ===========================================================================
// The resolver itself: every capability × plan × contract cell, stated once.
// ===========================================================================

describe("resolveEffectiveReviewCapabilities — the full matrix", () => {
  it("answers every plan × contract cell exactly as sold", async () => {
    const { resolveEffectiveReviewCapabilities, NO_CONTRACT_LIMITS } = await import(
      "../src/services/billing/enterprise-contract-limits.js"
    );
    const excluded = { ...NO_CONTRACT_LIMITS, contractGovernsCapability: true, reviewerOperationsExcluded: true };
    const silent = { ...NO_CONTRACT_LIMITS, contractGovernsCapability: true };
    const rows: Array<[string, unknown, Record<string, boolean>]> = [
      ["FREE", null, { BASIC_RECORD_REVIEW: false, REVIEW_ASSIGNMENTS: false, REVIEW_TASKS_AND_QUEUES: false, REVIEW_ESCALATION: false, BULK_REVIEW_OPERATIONS: false, ADVANCED_REVIEW_WORKFLOWS: false }],
      ["PAYG", null, { BASIC_RECORD_REVIEW: false, REVIEW_ASSIGNMENTS: false, REVIEW_TASKS_AND_QUEUES: false, REVIEW_ESCALATION: false, BULK_REVIEW_OPERATIONS: false, ADVANCED_REVIEW_WORKFLOWS: false }],
      ["PRO", null, { BASIC_RECORD_REVIEW: true, REVIEW_ASSIGNMENTS: false, REVIEW_TASKS_AND_QUEUES: false, REVIEW_ESCALATION: false, BULK_REVIEW_OPERATIONS: false, ADVANCED_REVIEW_WORKFLOWS: false }],
      // A granting contract on a lower plan is inert: the catalog refuses first.
      ["PRO", silent, { BASIC_RECORD_REVIEW: true, REVIEW_ASSIGNMENTS: false, REVIEW_TASKS_AND_QUEUES: false, REVIEW_ESCALATION: false, BULK_REVIEW_OPERATIONS: false, ADVANCED_REVIEW_WORKFLOWS: false }],
      ["TEAM", null, { BASIC_RECORD_REVIEW: true, REVIEW_ASSIGNMENTS: true, REVIEW_TASKS_AND_QUEUES: true, REVIEW_ESCALATION: true, BULK_REVIEW_OPERATIONS: true, ADVANCED_REVIEW_WORKFLOWS: false }],
      ["ENTERPRISE", null, { BASIC_RECORD_REVIEW: true, REVIEW_ASSIGNMENTS: true, REVIEW_TASKS_AND_QUEUES: true, REVIEW_ESCALATION: true, BULK_REVIEW_OPERATIONS: true, ADVANCED_REVIEW_WORKFLOWS: true }],
      ["ENTERPRISE", silent, { BASIC_RECORD_REVIEW: true, REVIEW_ASSIGNMENTS: true, REVIEW_TASKS_AND_QUEUES: true, REVIEW_ESCALATION: true, BULK_REVIEW_OPERATIONS: true, ADVANCED_REVIEW_WORKFLOWS: true }],
      // The contract has the last word: an explicit exclusion withdraws the
      // operations tiers; the PRO-level basic lifecycle stays with the plan.
      ["ENTERPRISE", excluded, { BASIC_RECORD_REVIEW: true, REVIEW_ASSIGNMENTS: false, REVIEW_TASKS_AND_QUEUES: false, REVIEW_ESCALATION: false, BULK_REVIEW_OPERATIONS: false, ADVANCED_REVIEW_WORKFLOWS: false }],
      // A non-ACTIVE contract excludes nothing: NO_CONTRACT_LIMITS carries
      // reviewerOperationsExcluded=false, so the catalog answers.
      ["ENTERPRISE", NO_CONTRACT_LIMITS, { BASIC_RECORD_REVIEW: true, REVIEW_ASSIGNMENTS: true, REVIEW_TASKS_AND_QUEUES: true, REVIEW_ESCALATION: true, BULK_REVIEW_OPERATIONS: true, ADVANCED_REVIEW_WORKFLOWS: true }],
    ];
    for (const [plan, contract, want] of rows) {
      expect(
        resolveEffectiveReviewCapabilities({ plan: plan as never, contract: contract as never }),
        `${plan} / ${contract === null ? "no contract" : JSON.stringify(contract)}`,
      ).toEqual(want);
    }
  });
});

// ===========================================================================
// FREE and credits: the gate, through the real routes
// ===========================================================================

describe("FREE / PAY_PER_EVIDENCE — every capability refused, credits grant nothing", () => {
  it("a FREE workspace's ADMIN is refused on every reviewer-ops tier with a typed ENTITLEMENT_REQUIRED 403", async () => {
    await setPlan(A, "TEAM");
    const { workflowId } = await freshWorkflow(A, "free-matrix");
    await setPlan(A, "FREE");
    for (const [capability, calls] of Object.entries(opsCalls(A, workflowId))) {
      for (const run of calls) {
        const res = await run();
        expectCleanRefusal(res, capability);
        expect(res.status, capability).toBe(403);
        expect(res.body.error, capability).toMatchObject({
          code: "ENTITLEMENT_REQUIRED",
          reason: "reviewer_operations_not_included",
          entitlement: capability,
        });
        expect(res.body.error.requestId, capability).toBeTruthy();
      }
    }
    // Anti-enumeration ORDER (re-audit finding 1): the commercial gate runs
    // AFTER membership admission, so an outsider probing this FREE workspace
    // is answered 404 and never the plan-disclosing ENTITLEMENT_REQUIRED.
    const B = harness.fixtures.teamB;
    for (const url of [
      `/v1/reviewer-ops/queue?teamId=${A.teamId}`,
      `/v1/reviewer-ops/escalations?teamId=${A.teamId}`,
    ]) {
      const outsider = await call(B.ownerToken, "GET", url);
      expect(outsider.status, url).toBe(404);
      expect(JSON.stringify(outsider.body), url).not.toContain("ENTITLEMENT_REQUIRED");
    }
    const outsiderBulk = await call(B.ownerToken, "POST", "/v1/reviewer-ops/reviews/bulk", { teamId: A.teamId, workflowIds: [workflowId], action: "PRIORITY_HIGH" });
    expect(outsiderBulk.status).toBe(404);
    expect(JSON.stringify(outsiderBulk.body)).not.toContain("ENTITLEMENT_REQUIRED");

    // The single-item lifecycle and queue reads refuse with the single-route
    // posture (404, reviewer_operations_not_included).
    const claim = await call(A.adminToken, "POST", `/v1/review-operations/evidence/${(await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: workflowId } })).evidenceId}/claim`, { teamId: A.teamId });
    expectCleanRefusal(claim, "claim");
    expect(claim.status).toBe(404);
    expect(claim.body.error.code).toBe("reviewer_operations_not_included");
    const queue = await call(A.adminToken, "GET", `/v1/review-operations/queue?teamId=${A.teamId}`);
    expectCleanRefusal(queue, "queue");
    expect(queue.status).toBe(404);
    expect(queue.body.error.code).toBe("reviewer_operations_not_included");
  });

  it("evidence credits on the payer never grant review (PAY_PER_EVIDENCE is a FREE account with a wallet)", async () => {
    const P = harness.fixtures.personal;
    await prisma.entitlement.updateMany({ where: { userId: P.userId }, data: { plan: "FREE", credits: 25 } });
    const { evidenceId } = await freshWorkflow(
      { ...A, teamId: P.teamId, ownerUserId: P.userId } as TeamFixture,
      "credits-grant-nothing",
    );
    const res = await call(P.token, "POST", `/v1/review-operations/evidence/${evidenceId}/claim`, { teamId: P.teamId });
    expectCleanRefusal(res, "credits claim");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("reviewer_operations_not_included");
    const ops = await call(P.token, "GET", `/v1/reviewer-ops/queue?teamId=${P.teamId}`);
    expectCleanRefusal(ops, "credits ops queue");
  });
});

// ===========================================================================
// PRO: the basic record lifecycle works; every orchestration tier is refused
// ===========================================================================

describe("PRO — BASIC_RECORD_REVIEW included, the TEAM tiers refused", () => {
  it("a PRO personal account runs claim → request-info → approve → close → reopen, and Escalate stays TEAM", async () => {
    const P = harness.fixtures.personal;
    await prisma.entitlement.updateMany({ where: { userId: P.userId }, data: { plan: "PRO", credits: 0 } });
    const { evidenceId } = await freshWorkflow(
      { ...A, teamId: P.teamId, ownerUserId: P.userId } as TeamFixture,
      "pro-basic-lifecycle",
    );
    const decide = (decision: string, note?: string) =>
      call(P.token, "POST", `/v1/review-operations/evidence/${evidenceId}/decision`, {
        decision,
        note: note ?? null,
        ...(decision === "ESCALATE" ? { escalationReason: note } : {}),
      });
    const moveInReview = async () => {
      const wf = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { evidenceId } });
      const res = await call(P.token, "PATCH", `/v1/evidence/${evidenceId}/reviewer-workflow`, {
        status: "IN_REVIEW",
        expectedUpdatedAt: wf.updatedAt.toISOString(),
      });
      expect(res.status, res.raw).toBe(200);
    };

    const claim = await call(P.token, "POST", `/v1/review-operations/evidence/${evidenceId}/claim`, { teamId: P.teamId });
    expect(claim.status, claim.raw).toBe(200);
    await moveInReview();
    expect((await decide("REQUEST_MORE_INFO", "need the original file")).status).toBe(200);
    await moveInReview();
    expect((await decide("APPROVE_INTERNAL")).status).toBe(200);
    expect((await decide("CLOSE")).status).toBe(200);
    expect((await decide("REOPEN", "second look")).status).toBe(200);

    // Escalate opens an escalation routed to admins — TEAM's shared routing.
    const esc = await decide("ESCALATE", "needs a supervisor");
    expectCleanRefusal(esc, "PRO escalate");
    expect(esc.status).toBe(404);
    expect(esc.body.error.code).toBe("reviewer_operations_not_included");
    expect(await prisma.reviewEscalation.count({ where: { evidenceId } })).toBe(0);
  });

  it("PRO is refused on queues, assignment, escalations and bulk — hidden controls cannot be called directly", async () => {
    const P = harness.fixtures.personal;
    await prisma.entitlement.updateMany({ where: { userId: P.userId }, data: { plan: "PRO", credits: 0 } });
    const { workflowId } = await freshWorkflow(
      { ...A, teamId: P.teamId, ownerUserId: P.userId } as TeamFixture,
      "pro-orchestration-refused",
    );
    const refusals: Array<[string, Promise<Res>]> = [
      ["queue", call(P.token, "GET", `/v1/reviewer-ops/queue?teamId=${P.teamId}`)],
      ["single queue", call(P.token, "GET", `/v1/review-operations/queue?teamId=${P.teamId}`)],
      ["assign", call(P.token, "POST", `/v1/reviewer-ops/reviews/${workflowId}/assign`, { teamId: P.teamId, assignedToUserId: P.userId })],
      ["escalations", call(P.token, "GET", `/v1/reviewer-ops/escalations?teamId=${P.teamId}`)],
      ["bulk", call(P.token, "POST", "/v1/reviewer-ops/reviews/bulk", { teamId: P.teamId, workflowIds: [workflowId], action: "PRIORITY_HIGH" })],
      ["single bulk", call(P.token, "POST", "/v1/review-operations/bulk", { teamId: P.teamId, evidenceIds: [workflowId], action: "CLOSE" })],
    ];
    for (const [label, pending] of refusals) {
      const res = await pending;
      expectCleanRefusal(res, label);
      expect([403, 404], label).toContain(res.status);
    }
    expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: workflowId } })).priority).toBe("NORMAL");
  });
});

// ===========================================================================
// TEAM: everything but ADVANCED works
// ===========================================================================

describe("TEAM — eligible workspaces are never denied", () => {
  it("a TEAM ADMIN succeeds on every reviewer-ops tier", async () => {
    await clearContract(A);
    await setPlan(A, "TEAM");
    const { workflowId } = await freshWorkflow(A, "team-succeeds");
    for (const [capability, calls] of Object.entries(opsCalls(A, workflowId))) {
      for (const run of calls) {
        const res = await run();
        expect([200, 201, 207], `${capability}: ${res.raw.slice(0, 200)}`).toContain(res.status);
      }
    }
  });
});

// ===========================================================================
// ENTERPRISE: the contract governs
// ===========================================================================

describe("ENTERPRISE — the organization contract has the last word", () => {
  it("a silent (NULL) contract keeps reviewer operations; an explicit exclusion withdraws them but not basic review", async () => {
    await setPlan(A, "ENTERPRISE");
    await setContract(A, { status: "ACTIVE", reviewerOperationsEnabled: null });
    const { evidenceId, workflowId } = await freshWorkflow(A, "ent-contract");
    expect((await call(A.adminToken, "GET", `/v1/reviewer-ops/queue?teamId=${A.teamId}`)).status).toBe(200);

    await setContract(A, { status: "ACTIVE", reviewerOperationsEnabled: false });
    for (const [capability, calls] of Object.entries(opsCalls(A, workflowId))) {
      for (const run of calls) {
        const res = await run();
        expectCleanRefusal(res, capability);
        expect(res.status, capability).toBe(403);
        expect(res.body.error.entitlement, capability).toBe(capability);
      }
    }
    // The PRO-level basic lifecycle stays with the plan through the exclusion.
    const claim = await call(A.memberToken, "POST", `/v1/review-operations/evidence/${evidenceId}/claim`, { teamId: A.teamId });
    expect(claim.status, claim.raw).toBe(200);

    // A non-ACTIVE contract governs nothing: the catalog answer returns.
    await setContract(A, { status: "SUSPENDED", reviewerOperationsEnabled: false });
    expect((await call(A.adminToken, "GET", `/v1/reviewer-ops/queue?teamId=${A.teamId}`)).status).toBe(200);
    await clearContract(A);
  });
});

// ===========================================================================
// Downgrade: history preserved and readable; new mutations refused; nothing
// deleted; the refusal is typed.
// ===========================================================================

describe("downgrade — history stays, mutation stops, nothing is deleted", () => {
  it("TEAM work survives a downgrade to FREE: readable history, refused mutations, identical row counts", async () => {
    await clearContract(A);
    await setPlan(A, "TEAM");
    const { evidenceId, workflowId } = await freshWorkflow(A, "downgrade");
    // Real TEAM-era activity: claim, a note, a verdict.
    expect((await call(A.memberToken, "POST", `/v1/review-operations/evidence/${evidenceId}/claim`, { teamId: A.teamId })).status).toBe(200);
    expect(
      (
        await call(A.memberToken, "POST", `/v1/reviewer-ops/workspace/${workflowId}/notes`, {
          teamId: A.teamId,
          type: "observation",
          body: "noted while entitled",
        })
      ).status,
    ).toBe(201);
    {
      // Verdicts follow the stage matrix: move the claimed review into
      // IN_REVIEW before approving.
      const wf = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: workflowId } });
      const moved = await call(A.memberToken, "PATCH", `/v1/evidence/${evidenceId}/reviewer-workflow`, {
        status: "IN_REVIEW",
        expectedUpdatedAt: wf.updatedAt.toISOString(),
      });
      expect(moved.status, moved.raw).toBe(200);
    }
    expect((await call(A.memberToken, "POST", `/v1/review-operations/evidence/${evidenceId}/decision`, { decision: "APPROVE_INTERNAL", note: null })).status).toBe(200);

    const before = {
      workflows: await prisma.evidenceReviewWorkflow.count({ where: { teamId: A.teamId } }),
      decisions: await prisma.workflowReviewDecision.count({ where: { workflowId } }),
      events: await prisma.evidenceReviewWorkflowEvent.count({ where: { workflowId } }),
      status: (await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: workflowId } })).status,
    };
    expect(before.decisions).toBeGreaterThan(0);

    await setPlan(A, "FREE");

    // History is still readable under the existing access rules.
    const notes = await call(A.memberToken, "GET", `/v1/reviewer-ops/workspace/${workflowId}/notes?teamId=${A.teamId}`);
    expect(notes.status, notes.raw).toBe(200);
    const decisions = await call(A.memberToken, "GET", `/v1/reviewer-ops/workspace/${workflowId}/decisions?teamId=${A.teamId}`);
    expect(decisions.status, decisions.raw).toBe(200);

    // New privileged mutations are refused, typed, 4xx.
    const addNote = await call(A.memberToken, "POST", `/v1/reviewer-ops/workspace/${workflowId}/notes`, { teamId: A.teamId, type: "observation", body: "after downgrade" });
    expectCleanRefusal(addNote, "note after downgrade");
    expect(addNote.status).toBe(403);
    const bulk = await call(A.adminToken, "POST", "/v1/reviewer-ops/reviews/bulk", { teamId: A.teamId, workflowIds: [workflowId], action: "CLOSE" });
    expectCleanRefusal(bulk, "bulk after downgrade");
    expect(bulk.status).toBe(403);
    expect(bulk.body.error).toMatchObject({ code: "ENTITLEMENT_REQUIRED", entitlement: "BULK_REVIEW_OPERATIONS" });

    // Nothing deleted, nothing moved.
    expect({
      workflows: await prisma.evidenceReviewWorkflow.count({ where: { teamId: A.teamId } }),
      decisions: await prisma.workflowReviewDecision.count({ where: { workflowId } }),
      events: await prisma.evidenceReviewWorkflowEvent.count({ where: { workflowId } }),
      status: (await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: workflowId } })).status,
    }).toEqual(before);
    await setPlan(A, "TEAM");
  });
});

// ===========================================================================
// Projection parity: platform-context offers exactly what the routes allow
// ===========================================================================

describe("projection parity", () => {
  it("planFeatures.reviewerOperationsIncluded is the routes' TEAM-tier answer, contract exclusion included", async () => {
    const { workspaceReviewCapabilities, workspaceIncludesReviewerOperations } = await import(
      "../src/services/billing-enforcement.service.js"
    );
    await setPlan(A, "ENTERPRISE");
    await setContract(A, { status: "ACTIVE", reviewerOperationsEnabled: false });
    expect(await workspaceIncludesReviewerOperations(A.teamId)).toBe(false);
    expect((await workspaceReviewCapabilities(A.teamId)).BASIC_RECORD_REVIEW).toBe(true);
    await setContract(A, { status: "ACTIVE", reviewerOperationsEnabled: null });
    expect(await workspaceIncludesReviewerOperations(A.teamId)).toBe(true);
    await clearContract(A);
    await setPlan(A, "TEAM");
  });
});

// ===========================================================================
// Source anchor: no reviewer-ops route can skip the gate
// ===========================================================================

describe("every reviewer-ops route states its capability", () => {
  it("each requireReviewerActor call site passes a capability or 'history', and only the two history reads pass 'history'", () => {
    const src = readFileSync(join(__dirname, "../src/routes/reviewer-ops.routes.ts"), "utf8");
    const sites = src.match(/requireReviewerActor\(req, reply, [^)]*\)/g) ?? [];
    expect(sites.length).toBeGreaterThanOrEqual(34);
    const untyped = sites.filter(
      (s) =>
        !/,\s*"(BASIC_RECORD_REVIEW|REVIEW_ASSIGNMENTS|REVIEW_TASKS_AND_QUEUES|REVIEW_ESCALATION|BULK_REVIEW_OPERATIONS|ADVANCED_REVIEW_WORKFLOWS|history)"\)$/.test(s),
    );
    expect(untyped).toEqual([]);
    expect(sites.filter((s) => s.endsWith('"history")'))).toHaveLength(2);
  });
});
