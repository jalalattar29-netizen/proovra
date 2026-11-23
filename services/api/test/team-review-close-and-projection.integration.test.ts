/**
 * TEAM-SPEC (2026-11-23) follow-up — against a real PostgreSQL and the real
 * routes, in a TEAM-plan Personal Workspace with invited members:
 *
 *   1. The Evidence page's review actions (`GET /v1/evidence/:id/review-workspace`)
 *      offer a verdict only to the current assignee, never offer adjudication
 *      through the plain verdict buttons, and never offer Close while the round
 *      awaits its SECOND decision or an adjudication — each refusal carries the
 *      server's own `reason`.
 *   2. Bulk CLOSE (`POST /v1/review-operations/bulk`) refuses
 *      `second_review_pending` per item and closes the rest.
 *   3. Close racing a FIRST decision under a second-review requirement never
 *      ends in a Closed review whose round still awaits its second review.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness } from "./integration-harness.js";
import { placeInCollaborationTeam } from "./support/place-in-collaboration-team.js";

let harness: IntegrationHarness;
let prisma: typeof import("../src/db.js").prisma;
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
  const email = `trc-${label}-${Date.now()}-${seq}@test.proovra.local`;
  const user = await prisma.user.create({
    data: { email, firstName: "TRC", lastName: label, provider: "EMAIL", providerUserId: email },
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

async function record(title: string, opts: { assignedToUserId?: string | null; hold?: boolean } = {}) {
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
        assignedToUserId: opts.assignedToUserId ?? null,
        assignedAtUtc: opts.assignedToUserId ? new Date() : null,
      },
      select: { id: true },
    })
  ).id;
  if (opts.hold) {
    await prisma.evidenceLegalHold.create({
      data: { scope: "EVIDENCE", evidenceId, teamId: T.teamId, status: "ACTIVE", title: "Hold", placedByUserId: T.owner.userId } as never,
    });
  }
  return { evidenceId, workflowId };
}

type Offered = Record<string, { action: string; enabled: boolean; blockedBy: string | null; reason?: string }>;
async function offered(a: Actor, evidenceId: string): Promise<Offered> {
  const res = await call(a.token, "GET", `/v1/evidence/${evidenceId}/review-workspace`);
  expect(res.status, res.raw.slice(0, 300)).toBe(200);
  return Object.fromEntries(
    (res.body.reviewWorkflow.availableActions as Offered[string][]).map((x) => [x.action, x]),
  );
}

const approve = (a: Actor, workflowId: string) =>
  call(a.token, "POST", `/v1/reviewer-ops/reviews/${workflowId}/approve`, { teamId: T.teamId, note: null });
const reject = (a: Actor, workflowId: string) =>
  call(a.token, "POST", `/v1/reviewer-ops/reviews/${workflowId}/reject`, { teamId: T.teamId, note: "custody gap" });
const reassign = (a: Actor, workflowId: string, to: string) =>
  call(a.token, "POST", `/v1/reviewer-ops/reviews/${workflowId}/reassign`, { teamId: T.teamId, newAssigneeUserId: to });
const closeOne = (a: Actor, evidenceId: string) =>
  call(a.token, "POST", `/v1/review-operations/evidence/${evidenceId}/decision`, { decision: "CLOSE", note: "done" });
const wfRow = (id: string) => prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  harness = await bootIntegrationHarness();
  ({ prisma } = await import("../src/db.js"));
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

describe("Evidence page review actions follow the decision authority", () => {
  it("offers a verdict only to the assignee", async () => {
    const assigned = await record("trc-assigned", { assignedToUserId: T.member.userId });
    const mine = await offered(T.member, assigned.evidenceId);
    expect(mine.APPROVE_INTERNAL!.enabled).toBe(true);
    expect(mine.REQUEST_MORE_INFO!.enabled).toBe(true);
    for (const who of [T.owner, T.admin]) {
      const theirs = await offered(who, assigned.evidenceId);
      for (const verdict of ["APPROVE_INTERNAL", "REJECT_INSUFFICIENT", "REQUEST_MORE_INFO"]) {
        expect(theirs[verdict], verdict).toMatchObject({ enabled: false, blockedBy: "OWNED_BY_SOMEONE_ELSE", reason: "not_assignee" });
      }
      // ...and the server agrees.
      expect((await approve(who, assigned.workflowId)).body.error.details.reason).toBe("not_assignee");
    }
    const unassigned = await record("trc-unassigned");
    expect((await offered(T.owner, unassigned.evidenceId)).APPROVE_INTERNAL).toMatchObject({
      enabled: false,
      blockedBy: "CLAIM_FIRST",
      reason: "not_assignee",
    });
  });

  it("second review: offered only to the reassigned reviewer; Close is not offered; a conflict is never decided by a verdict button", async () => {
    const r = await record("trc-second", { assignedToUserId: T.member.userId, hold: true });
    expect((await approve(T.member, r.workflowId)).body.outcome.reviewState).toBe("second_required");

    expect((await offered(T.member, r.evidenceId)).APPROVE_INTERNAL).toMatchObject({ enabled: false, blockedBy: "AWAITING_SECOND_REVIEWER" });
    const admin = await offered(T.admin, r.evidenceId);
    expect(admin.APPROVE_INTERNAL).toMatchObject({ enabled: false, reason: "second_stage_needs_reassignment" });
    for (const who of [T.member, T.admin, T.owner]) {
      expect((await offered(who, r.evidenceId)).CLOSE, "close").toMatchObject({ enabled: false, reason: "second_review_pending" });
    }
    expect((await closeOne(T.admin, r.evidenceId)).body.error.code).toBe("second_review_pending");

    expect((await reassign(T.owner, r.workflowId, T.admin.userId)).status).toBe(200);
    expect((await offered(T.admin, r.evidenceId)).REJECT_INSUFFICIENT!.enabled).toBe(true);
    expect((await reject(T.admin, r.workflowId)).body.outcome.reviewState).toBe("conflict_detected");

    // The owner is an independent adjudicator — but not through a verdict button.
    const owner = await offered(T.owner, r.evidenceId);
    for (const verdict of ["APPROVE_INTERNAL", "REJECT_INSUFFICIENT"]) {
      expect(owner[verdict], verdict).toMatchObject({ enabled: false, blockedBy: "ADJUDICATION_REQUIRED", reason: "use_adjudication" });
    }
    expect(owner.CLOSE).toMatchObject({ enabled: false, reason: "second_review_pending" });
    expect((await approve(T.owner, r.workflowId)).body.error.details.reason).toBe("use_adjudication");
  });
});

describe("bulk CLOSE and the Close race", () => {
  it("bulk CLOSE refuses second_review_pending per item and closes the rest", async () => {
    const pending = await record("trc-bulk-pending", { assignedToUserId: T.member.userId, hold: true });
    expect((await approve(T.member, pending.workflowId)).status).toBe(200);
    const plain = await record("trc-bulk-plain", { assignedToUserId: T.member.userId });
    const res = await call(T.owner.token, "POST", "/v1/review-operations/bulk", {
      teamId: T.teamId,
      evidenceIds: [pending.evidenceId, plain.evidenceId],
      action: "CLOSE",
      note: "bulk close",
    });
    expect(res.status, res.raw.slice(0, 300)).toBeLessThan(300);
    const items = Object.fromEntries((res.body.result.items as Array<{ evidenceId: string; ok: boolean; reason?: string }>).map((i) => [i.evidenceId, i]));
    expect(items[pending.evidenceId]).toMatchObject({ ok: false, reason: "second_review_pending" });
    expect(items[plain.evidenceId]).toMatchObject({ ok: true });
    expect((await wfRow(pending.workflowId)).status).toBe("IN_REVIEW");
    expect((await wfRow(plain.workflowId)).status).toBe("CLOSED");
    expect(await prisma.evidenceReviewWorkflowEvent.count({ where: { workflowId: pending.workflowId, eventType: "CLOSED" } })).toBe(0);
  });

  it("Close racing the FIRST decision never leaves a Closed review awaiting its second review", async () => {
    for (let i = 0; i < 5; i += 1) {
      const r = await record(`trc-race-${i}`, { assignedToUserId: T.member.userId, hold: true });
      const [closed, decided] = await Promise.all([closeOne(T.admin, r.evidenceId), approve(T.member, r.workflowId)]);
      await harness.handlersSettled();
      const row = await wfRow(r.workflowId);
      const rows = await prisma.workflowReviewDecision.count({ where: { workflowId: r.workflowId, round: row.decisionRound } });
      const label = `race ${i}: close ${closed.status} approve ${decided.status} status ${row.status} rows ${rows}`;
      // Exactly one of them took effect, and the record says which.
      expect((closed.status === 200) !== (decided.status === 200), label).toBe(true);
      if (row.status === "CLOSED") {
        expect(rows, label).toBe(0);
        expect(decided.status, label).not.toBe(200);
      } else {
        expect(row.status, label).toBe("IN_REVIEW");
        expect(rows, label).toBe(1);
        expect(closed.body.error.code, label).toBe("second_review_pending");
      }
    }
  });
});
