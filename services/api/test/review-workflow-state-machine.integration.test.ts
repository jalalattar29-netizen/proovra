/**
 * Review workflow state machine — real PostgreSQL, real routes (2026-10-23).
 *
 * Every assertion goes through the real Fastify routes against a disposable
 * PostgreSQL with the repository's migrations applied, so what is proved is
 * what the database and the authorization layer actually do:
 *
 *   1. ROLES: who may claim and decide, and what the review workspace offers
 *      each role (Owner, Admin, Member/Reviewer, Viewer, another workspace,
 *      a Personal-space user).
 *   2. CLAIM is idempotent for the owner and refused for anyone else.
 *   3. VERDICTS follow the stage matrix (no approval of a review nobody has
 *      started) and a REOPENED review can take a NEW verdict — in a new
 *      decision round, with the earlier verdict still on the log.
 *   4. A request-more-information outcome is not final: the review takes a
 *      verdict afterwards.
 *   5. The workflow PATCH follows the stage matrix, refuses lifecycle
 *      decisions (Escalate / Reopen), refuses the legacy approval, and is
 *      optimistically concurrent: a stale edit is refused, and of two
 *      concurrent edits from the same version exactly one lands.
 *   6. ESCALATE opens a ReviewEscalation routed to the workspace's owners and
 *      admins (their inbox shows it, a member's does not), a repeat is
 *      refused, and Close resolves it.
 *   7. CREATION writes one event.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness, type TeamFixture } from "./integration-harness.js";

let harness: IntegrationHarness;
let A: TeamFixture;
let B: TeamFixture;
let prisma: typeof import("../src/db.js").prisma;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- route bodies are asserted field by field
type Res = { status: number; body: any };

async function call(token: string, method: "GET" | "POST" | "PATCH", url: string, payload?: unknown): Promise<Res> {
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
  return { status: res.statusCode, body };
}

/** A fresh team-bound evidence record, so every scenario starts clean. */
async function freshEvidence(team: TeamFixture, title: string): Promise<string> {
  const t = await prisma.team.findUniqueOrThrow({ where: { id: team.teamId }, select: { organizationId: true } });
  const ev = await prisma.evidence.create({
    data: { title, type: "PHOTO", status: "CREATED", teamId: team.teamId, organizationId: t.organizationId, ownerUserId: team.ownerUserId },
    select: { id: true },
  });
  return ev.id;
}

const patchWorkflow = (token: string, evidenceId: string, body: Record<string, unknown>) =>
  call(token, "PATCH", `/v1/evidence/${evidenceId}/reviewer-workflow`, body);
const claim = (token: string, evidenceId: string, teamId: string) =>
  call(token, "POST", `/v1/review-operations/evidence/${evidenceId}/claim`, { teamId });
const decide = (token: string, evidenceId: string, decision: string, note?: string) =>
  call(token, "POST", `/v1/review-operations/evidence/${evidenceId}/decision`, {
    decision,
    note: note ?? null,
    ...(decision === "ESCALATE" ? { escalationReason: note } : {}),
  });
const workflowOf = (evidenceId: string) =>
  prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { evidenceId } });
const eventsOf = (evidenceId: string) =>
  prisma.evidenceReviewWorkflowEvent.findMany({ where: { evidenceId }, orderBy: { createdAt: "asc" } });

/** Create a workflow (admin) and, optionally, move it to a stage. */
async function workflowAt(evidenceId: string, opts: { claimBy?: string; inReview?: boolean } = {}) {
  const created = await patchWorkflow(A.adminToken, evidenceId, { status: "NOT_STARTED" });
  expect(created.status).toBe(200);
  if (opts.claimBy) expect((await claim(opts.claimBy, evidenceId, A.teamId)).status).toBe(200);
  if (opts.inReview) {
    const wf = await workflowOf(evidenceId);
    const moved = await patchWorkflow(A.adminToken, evidenceId, {
      status: "IN_REVIEW",
      expectedUpdatedAt: wf.updatedAt.toISOString(),
    });
    expect(moved.status).toBe(200);
  }
}

beforeAll(async () => {
  harness = await bootIntegrationHarness();
  A = harness.fixtures.teamA;
  B = harness.fixtures.teamB;
  ({ prisma } = await import("../src/db.js"));
});

afterAll(async () => {
  if (harness) await harness.cleanup();
});

// ===========================================================================
// 1. Roles
// ===========================================================================

describe("1 — the role matrix, through the real authorization layer", () => {
  it("claim: Owner, Admin and Member may; a Viewer is refused (403, a member of the workspace); another workspace and a Personal user get the anti-enumeration 404", async () => {
    for (const [label, token, expected] of [
      ["viewer", A.viewerToken, 403],
      ["other workspace admin", B.adminToken, 404],
      ["personal user", harness.fixtures.personal.token, 404],
    ] as const) {
      const ev = await freshEvidence(A, `claim-refused-${label}`);
      await workflowAt(ev);
      const res = await claim(token, ev, A.teamId);
      expect(res.status, label).toBe(expected);
      expect((await workflowOf(ev)).assignedToUserId, label).toBeNull();
    }
    for (const [label, token, userId] of [
      ["owner", A.ownerToken, A.ownerUserId],
      ["admin", A.adminToken, A.adminUserId],
      ["member", A.memberToken, A.memberUserId],
    ] as const) {
      const ev = await freshEvidence(A, `claim-allowed-${label}`);
      await workflowAt(ev);
      const res = await claim(token, ev, A.teamId);
      expect(res.status, label).toBe(200);
      expect((await workflowOf(ev)).assignedToUserId, label).toBe(userId);
    }
  });

  it("decisions: a Viewer is refused without a trace", async () => {
    const ev = await freshEvidence(A, "viewer-decides");
    await workflowAt(ev, { claimBy: A.memberToken, inReview: true });
    const res = await decide(A.viewerToken, ev, "ESCALATE", "viewer tries");
    expect(res.status).toBe(403);
    expect(await prisma.reviewEscalation.count({ where: { evidenceId: ev } })).toBe(0);
    expect((await workflowOf(ev)).status).toBe("IN_REVIEW");
  });

  it("the review workspace offers each role exactly what the routes allow", async () => {
    const ev = await freshEvidence(A, "available-actions");
    await workflowAt(ev);
    const offered = async (token: string) => {
      const res = await call(token, "GET", `/v1/evidence/${ev}/review-workspace`);
      expect(res.status).toBe(200);
      const actions = res.body.reviewWorkflow.availableActions as Array<{ action: string; enabled: boolean; blockedBy: string | null }>;
      return Object.fromEntries(actions.map((a) => [a.action, a]));
    };
    for (const token of [A.ownerToken, A.adminToken, A.memberToken]) {
      const a = await offered(token);
      expect(a.CLAIM.enabled).toBe(true);
      expect(a.APPROVE_INTERNAL.blockedBy).toBe("NOT_FROM_STAGE");
    }
    const viewer = await offered(A.viewerToken);
    expect(Object.values(viewer).every((x) => !x.enabled)).toBe(true);
    expect(viewer.CLAIM.blockedBy).toBe("NOT_PERMITTED");
    // Another workspace cannot even read the record.
    expect((await call(B.adminToken, "GET", `/v1/evidence/${ev}/review-workspace`)).status).toBe(404);
  });
});

// ===========================================================================
// 2–4. Claim and verdicts
// ===========================================================================

describe("2 — claim", () => {
  it("is idempotent for the owner and refused for anyone else", async () => {
    const ev = await freshEvidence(A, "claim-idempotent");
    await workflowAt(ev);
    expect((await claim(A.memberToken, ev, A.teamId)).status).toBe(200);
    expect((await claim(A.memberToken, ev, A.teamId)).status).toBe(200);
    const claimed = (await eventsOf(ev)).filter((e) => e.eventType === "CLAIMED");
    expect(claimed).toHaveLength(1);
    const other = await claim(A.adminToken, ev, A.teamId);
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("already_assigned_elsewhere");
  });
});

describe("3 — verdicts follow the stage matrix; a reopened review takes a new verdict", () => {
  it("refuses a verdict on a review nobody has started", async () => {
    const ev = await freshEvidence(A, "verdict-from-assigned");
    await workflowAt(ev, { claimBy: A.memberToken });
    const res = await decide(A.memberToken, ev, "APPROVE_INTERNAL");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("decision_not_from_stage");
    expect(await prisma.workflowReviewDecision.count({ where: { workflow: { evidenceId: ev } } })).toBe(0);
  });

  it("approve → reopen → a NEW verdict in round 1, the first still on the log", async () => {
    const ev = await freshEvidence(A, "reopen-new-verdict");
    await workflowAt(ev, { claimBy: A.memberToken, inReview: true });
    expect((await decide(A.memberToken, ev, "APPROVE_INTERNAL")).status).toBe(200);
    expect((await workflowOf(ev)).status).toBe("APPROVED_INTERNAL");
    // A second, different verdict in the same round is refused.
    const again = await decide(A.memberToken, ev, "REJECT_INSUFFICIENT", "changed my mind");
    expect(again.status).toBe(409);

    expect((await decide(A.memberToken, ev, "REOPEN", "new material arrived")).status).toBe(200);
    let wf = await workflowOf(ev);
    expect(wf.status).toBe("REOPENED");
    expect(wf.decisionRound).toBe(1);
    // Repeating the reopen is refused, not a second reopen.
    expect((await decide(A.memberToken, ev, "REOPEN", "again")).body.error.code).toBe("already_in_stage");

    const resume = await patchWorkflow(A.memberToken, ev, { status: "IN_REVIEW", expectedUpdatedAt: wf.updatedAt.toISOString() });
    expect(resume.status).toBe(200);
    const reject = await decide(A.memberToken, ev, "REJECT_INSUFFICIENT", "material is insufficient");
    expect(reject.status).toBe(200);
    wf = await workflowOf(ev);
    expect(wf.status).toBe("REJECTED_INSUFFICIENT");
    const rows = await prisma.workflowReviewDecision.findMany({ where: { workflowId: wf.id }, orderBy: { decidedAt: "asc" } });
    expect(rows.map((r) => [r.round, r.stage, r.decision])).toEqual([
      [0, "FIRST", "APPROVE"],
      [1, "FIRST", "REJECT"],
    ]);
  });
});

describe("4 — request more information is not final", () => {
  it("the review takes a verdict after information was requested", async () => {
    const ev = await freshEvidence(A, "request-info-then-verdict");
    await workflowAt(ev, { claimBy: A.memberToken, inReview: true });
    expect((await decide(A.memberToken, ev, "REQUEST_MORE_INFO", "need the original file")).status).toBe(200);
    expect((await workflowOf(ev)).status).toBe("NEEDS_INFO");
    const reject = await decide(A.memberToken, ev, "REJECT_INSUFFICIENT", "the original was not provided");
    expect(reject.status).toBe(200);
    const wf = await workflowOf(ev);
    expect(wf.status).toBe("REJECTED_INSUFFICIENT");
    expect(wf.decisionRound).toBe(1);
  });
});

// ===========================================================================
// 5. PATCH
// ===========================================================================

describe("5 — the workflow PATCH: stage matrix, lifecycle decisions, concurrency", () => {
  it("refuses an unreachable state, a lifecycle decision and the legacy approval", async () => {
    const ev = await freshEvidence(A, "patch-matrix");
    await workflowAt(ev, { claimBy: A.memberToken });
    expect((await decide(A.memberToken, ev, "CLOSE")).status).toBe(200);
    expect((await workflowOf(ev)).status).toBe("CLOSED");

    const back = await patchWorkflow(A.adminToken, ev, { status: "NOT_STARTED" });
    expect(back.status).toBe(422);
    expect(back.body.error?.details?.reason ?? back.body.details?.reason).toBe("invalid_stage_transition");

    const esc = await patchWorkflow(A.adminToken, ev, { status: "ESCALATED" });
    expect(esc.status).toBe(422);

    const legacy = await patchWorkflow(A.adminToken, ev, { status: "READY_FOR_EXTERNAL_REVIEW" });
    expect(legacy.status).toBe(400);
    expect((await workflowOf(ev)).status).toBe("CLOSED");
  });

  it("a stale edit is refused; of two concurrent edits from one version exactly one lands", async () => {
    const ev = await freshEvidence(A, "patch-concurrency");
    await workflowAt(ev);
    const base = (await workflowOf(ev)).updatedAt.toISOString();
    const first = await patchWorkflow(A.adminToken, ev, { priority: "HIGH", expectedUpdatedAt: base });
    expect(first.status).toBe(200);
    const stale = await patchWorkflow(A.ownerToken, ev, { priority: "LOW", expectedUpdatedAt: base });
    expect(stale.status).toBe(409);
    expect((await workflowOf(ev)).priority).toBe("HIGH");

    const v = (await workflowOf(ev)).updatedAt.toISOString();
    const both = await Promise.all([
      patchWorkflow(A.adminToken, ev, { priority: "URGENT", expectedUpdatedAt: v }),
      patchWorkflow(A.ownerToken, ev, { priority: "LOW", expectedUpdatedAt: v }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = both[0]!.status === 200 ? "URGENT" : "LOW";
    expect((await workflowOf(ev)).priority).toBe(winner);
    const priorityEvents = (await eventsOf(ev)).filter((e) => e.eventType === "PRIORITY_CHANGED");
    expect(priorityEvents).toHaveLength(2);
  });
});

// ===========================================================================
// 6. Escalation
// ===========================================================================

describe("6 — Escalate opens a real escalation for the workspace's admins", () => {
  it("routes to admins' inbox, is refused twice, and Close resolves it", async () => {
    const ev = await freshEvidence(A, "escalate-real");
    await workflowAt(ev, { claimBy: A.memberToken, inReview: true });
    const res = await decide(A.memberToken, ev, "ESCALATE", "Needs counsel review");
    expect(res.status).toBe(200);
    const wf = await workflowOf(ev);
    expect(wf.status).toBe("ESCALATED");
    expect(wf.escalationLevel).toBe(1);
    const esc = await prisma.reviewEscalation.findFirstOrThrow({ where: { workflowId: wf.id } });
    expect(esc).toMatchObject({
      status: "OPEN",
      reason: "REVIEWER_ESCALATED",
      assignedToUserId: null,
      createdByUserId: A.memberUserId,
      safeSummary: "Needs counsel review",
    });
    expect(wf.activeEscalationId).toBe(esc.id);

    const inboxKeys = async (token: string) => {
      const r = await call(token, "GET", "/v1/me/inbox");
      expect(r.status).toBe(200);
      return (r.body.items as Array<{ id: string; href?: string; title?: string }>).filter((i) => i.id === `review_escalation:${esc.id}`);
    };
    const adminItems = await inboxKeys(A.adminToken);
    expect(adminItems).toHaveLength(1);
    expect(adminItems[0]!.href).toBe(`/evidence/${ev}?tab=review`);
    expect(adminItems[0]!.title).toContain("escalated to your workspace");
    expect(await inboxKeys(A.ownerToken)).toHaveLength(1);
    expect(await inboxKeys(A.memberToken)).toHaveLength(0);
    expect(await inboxKeys(B.adminToken)).toHaveLength(0);

    const again = await decide(A.memberToken, ev, "ESCALATE", "still blocked");
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("already_in_stage");
    expect(await prisma.reviewEscalation.count({ where: { workflowId: wf.id } })).toBe(1);
    expect((await workflowOf(ev)).escalationLevel).toBe(1);

    expect((await decide(A.adminToken, ev, "CLOSE")).status).toBe(200);
    const resolved = await prisma.reviewEscalation.findUniqueOrThrow({ where: { id: esc.id } });
    expect(resolved.status).toBe("RESOLVED");
    expect(await inboxKeys(A.adminToken)).toHaveLength(0);
  });
});

// ===========================================================================
// 7. Creation
// ===========================================================================

describe("7 — creating a workflow writes ONE event", () => {
  it("no spurious UNASSIGNED / STATUS_CHANGED / PRIORITY_CHANGED", async () => {
    const ev = await freshEvidence(A, "creation-events");
    await workflowAt(ev);
    expect((await eventsOf(ev)).map((e) => e.eventType)).toEqual(["CREATED"]);
  });
});
