/**
 * TEAM-SPEC §2.2 — THE CLOSE GUARD, PROVEN AT EACH OF ITS TWO LAYERS.
 *
 * Close must never end a review whose current round still awaits its SECOND
 * decision (or an adjudication). Two independent layers enforce that:
 *
 *   1. ROUTE PRE-CHECK — `POST /v1/review-operations/evidence/:id/decision`
 *      reads the round before calling the lifecycle service and refuses
 *      `second_review_pending`. It answers the common case early, but a
 *      decision can commit between that read and the Close.
 *   2. IN-TRANSACTION GUARD — `recordLifecycleTransition` (every Close door
 *      funnels through it: the single-item route and both bulk paths) locks the
 *      workflow row `FOR UPDATE`, re-reads the round under the lock, and
 *      refuses. A FIRST decision still in flight cannot land afterwards,
 *      because its own status write is conditional on the status Close changes.
 *
 * The earlier suite exercised Close only through the route, where layer 1
 * answers first and layer 2 is never reached — so removing layer 2 changed no
 * result. Here layer 2 is driven DIRECTLY (no route), alone and racing a real
 * FIRST decision, and the persisted rows are the evidence.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness } from "./integration-harness.js";
import { placeInCollaborationTeam } from "./support/place-in-collaboration-team.js";

let harness: IntegrationHarness;
let prisma: typeof import("../src/db.js").prisma;
let recordLifecycleTransition: typeof import("../src/services/review-operations/review-operations.service.js").recordLifecycleTransition;
let requiredLegalVersions: Record<string, unknown>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- route bodies are asserted field by field
type Res = { status: number; body: any; raw: string };
type Actor = { userId: string; token: string };
let T: { teamId: string; owner: Actor; admin: Actor; member: Actor };

async function call(token: string, method: "GET" | "POST", url: string, payload?: unknown): Promise<Res> {
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

let seq = 0;
async function newUser(label: string): Promise<Actor> {
  seq += 1;
  const email = `tcg-${label}-${Date.now()}-${seq}@test.proovra.local`;
  const user = await prisma.user.create({
    data: { email, firstName: "TCG", lastName: label, provider: "EMAIL", providerUserId: email },
    select: { id: true },
  });
  await prisma.userLegalAcceptance.createMany({
    data: Object.entries(requiredLegalVersions).map(([policyKey, policyVersion]) => ({
      userId: user.id,
      policyKey,
      policyVersion: policyVersion as string,
      source: "integration-harness",
    })),
  });
  return { userId: user.id, token: await harness.mintSessionToken(user.id, email) };
}

/** A record under a legal hold (a second-review trigger), assigned to the member, IN_REVIEW. */
async function heldRecord(title: string) {
  const t = await prisma.team.findUniqueOrThrow({ where: { id: T.teamId }, select: { organizationId: true } });
  const evidenceId = (
    await prisma.evidence.create({
      data: { title, type: "PHOTO", status: "CREATED", teamId: T.teamId, organizationId: t.organizationId, ownerUserId: T.owner.userId },
      select: { id: true },
    })
  ).id;
  const workflowId = (
    await prisma.evidenceReviewWorkflow.create({
      data: {
        evidenceId,
        teamId: T.teamId,
        status: "IN_REVIEW",
        workspaceType: "TEAM",
        assignedToUserId: T.member.userId,
        assignedAtUtc: new Date(),
      },
      select: { id: true },
    })
  ).id;
  await prisma.evidenceLegalHold.create({
    data: { scope: "EVIDENCE", evidenceId, teamId: T.teamId, status: "ACTIVE", title: "Hold", placedByUserId: T.owner.userId } as never,
  });
  return { evidenceId, workflowId };
}

const approveAsMember = (workflowId: string) =>
  call(T.member.token, "POST", `/v1/reviewer-ops/reviews/${workflowId}/approve`, { teamId: T.teamId, note: null });
const closeViaRoute = (evidenceId: string) =>
  call(T.owner.token, "POST", `/v1/review-operations/evidence/${evidenceId}/decision`, { decision: "CLOSE", note: "done" });
/** Layer 2 alone: the lifecycle service, no route in front of it. */
const closeViaService = (evidenceId: string) =>
  recordLifecycleTransition({ evidenceId, decision: "CLOSE", actorUserId: T.owner.userId, note: "done" }, prisma);

const wfRow = (id: string) => prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id } });
const closedEvents = (workflowId: string) =>
  prisma.evidenceReviewWorkflowEvent.count({ where: { workflowId, eventType: "CLOSED" } });
const firstDecisions = (workflowId: string) =>
  prisma.workflowReviewDecision.count({ where: { workflowId, stage: "FIRST" } });

beforeAll(async () => {
  harness = await bootIntegrationHarness();
  ({ prisma } = await import("../src/db.js"));
  ({ recordLifecycleTransition } = await import("../src/services/review-operations/review-operations.service.js"));
  ({ REQUIRED_LEGAL_VERSIONS: requiredLegalVersions } = await import("../src/legal/legal-versioning.js"));
  const { ensurePersonalWorkspace } = await import("../src/services/platform-context/workspace-bootstrap.service.js");
  const owner = await newUser("owner");
  const space = await ensurePersonalWorkspace({ userId: owner.userId });
  const updated = await prisma.entitlement.updateMany({ where: { userId: owner.userId }, data: { plan: "TEAM", active: true } });
  if (updated.count === 0) await prisma.entitlement.create({ data: { userId: owner.userId, plan: "TEAM" } });
  const admin = await newUser("admin");
  const member = await newUser("member");
  for (const [u, role] of [
    [admin, "ADMIN"],
    [member, "MEMBER"],
  ] as const) {
    await prisma.teamMember.create({ data: { teamId: space.teamId, userId: u.userId, role, status: "ACTIVE" } });
  }
  await placeInCollaborationTeam(prisma, { workspaceId: space.teamId, createdByUserId: owner.userId, userIds: [admin.userId, member.userId] });
  T = { teamId: space.teamId, owner, admin, member };
});

afterAll(async () => {
  if (harness) await harness.cleanup();
});

describe("Close guard — layer 1 (route pre-check)", () => {
  it("refuses Close through the route once a FIRST decision is waiting for its SECOND", async () => {
    const r = await heldRecord("tcg-route");
    const first = await approveAsMember(r.workflowId);
    expect(first.status, first.raw.slice(0, 300)).toBe(200);
    expect(first.body.outcome).toMatchObject({ stageRecorded: "FIRST", statusChanged: false, nextRequirement: "second_review" });

    const closed = await closeViaRoute(r.evidenceId);
    expect(closed.status, closed.raw.slice(0, 300)).toBe(409);
    expect(JSON.stringify(closed.body)).toContain("second_review_pending");
    expect((await wfRow(r.workflowId)).status).toBe("IN_REVIEW");
    expect(await closedEvents(r.workflowId)).toBe(0);
  });
});

describe("Close guard — layer 2 (in-transaction, no route)", () => {
  it("the lifecycle service itself refuses Close while the round awaits its SECOND decision", async () => {
    const r = await heldRecord("tcg-service");
    const first = await approveAsMember(r.workflowId);
    expect(first.status, first.raw.slice(0, 300)).toBe(200);

    await expect(closeViaService(r.evidenceId)).rejects.toMatchObject({ code: "second_review_pending" });
    const row = await wfRow(r.workflowId);
    expect(row.status).toBe("IN_REVIEW");
    expect(row.closedAt).toBeNull();
    expect(await closedEvents(r.workflowId)).toBe(0);
    expect(await firstDecisions(r.workflowId)).toBe(1);
  });

  it("with no decision pending, the same service closes (the guard refuses only what it must)", async () => {
    const r = await heldRecord("tcg-service-ok");
    await prisma.evidenceLegalHold.updateMany({ where: { evidenceId: r.evidenceId }, data: { status: "RELEASED" } as never });
    const closed = await closeViaService(r.evidenceId);
    expect(String(closed.status)).toBe("CLOSED");
    expect(await closedEvents(r.workflowId)).toBe(1);
  });

  it("Close (service, no route) racing a FIRST decision never leaves a Closed review that still awaits its SECOND", async () => {
    const outcomes: string[] = [];
    // Staggered starts so both orders occur: Close first, together, and
    // Close starting after the decision is already in flight.
    const delaysMs = [0, 0, 5, 15, 30, 60, 120, 200];
    for (let i = 0; i < delaysMs.length; i += 1) {
      const r = await heldRecord(`tcg-race-${i}`);
      const delayed = new Promise<void>((resolve) => setTimeout(resolve, delaysMs[i]));
      const [decision, close] = await Promise.allSettled([
        approveAsMember(r.workflowId),
        delayed.then(() => closeViaService(r.evidenceId)),
      ]);
      const row = await wfRow(r.workflowId);
      const firsts = await firstDecisions(r.workflowId);
      const decided = decision.status === "fulfilled" && decision.value.status === 200;
      const closedOk = close.status === "fulfilled";

      // Never both: a Closed review with a recorded FIRST decision in a round
      // that requires a second review is exactly what the guard forbids.
      expect(String(row.status) === "CLOSED" && firsts > 0, `iteration ${i}: closed with a pending second review`).toBe(false);
      // The persisted state agrees with the answers each caller received.
      if (closedOk) {
        expect(String(row.status)).toBe("CLOSED");
        expect(firsts).toBe(0);
        expect(decided).toBe(false);
        outcomes.push("close-won");
      } else {
        expect(close.status === "rejected" && (close.reason as { code?: string }).code).toBe("second_review_pending");
        expect(decided).toBe(true);
        expect(firsts).toBe(1);
        expect(String(row.status)).not.toBe("CLOSED");
        outcomes.push("decision-won");
      }
    }
    // Both interleavings must actually have happened for the race to mean
    // anything; otherwise the run proved only one order.
    expect(outcomes).toContain("close-won");
    expect(outcomes).toContain("decision-won");
    console.info(`[close-guard race] ${outcomes.join(", ")}`);
  });
});
