/**
 * Review remediation (2026-11-27) — finding B: resolving a challenge
 * OVERTURNED / PARTIAL and superseding the challenged outcome are ONE atomic
 * operation (BEHAVIOUR-SPEC §7).
 *
 *   - finished review → the canonical Reopen (new round) in the resolution's
 *     transaction; open review → the round advances with the independence
 *     requirement carried;
 *   - revalidated under the workflow row lock: a challenge whose decision is no
 *     longer in the current round resolves "already_superseded" and changes no
 *     workflow;
 *   - a failure while superseding rolls the resolution back with it
 *     (DISAGREEMENT_SUPERSEDE_FAILED, 409);
 *   - concurrent resolutions: exactly one wins; a resolution racing a
 *     competing lifecycle move (held lock, released by the test) revalidates.
 *
 * Real routes, real PostgreSQL. Every case asserts together the disagreement
 * row, the workflow status and round, the decision rows (history unchanged)
 * and the audit rows.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness } from "./integration-harness.js";

let harness: IntegrationHarness;
let prisma: typeof import("../src/db.js").prisma;
let requiredLegalVersions: Record<string, unknown>;
let ensurePersonalWorkspace: typeof import("../src/services/platform-context/workspace-bootstrap.service.js").ensurePersonalWorkspace;
let ops: typeof import("../src/services/review-operations/review-operations.service.js");
let loadCurrentReviewDecision: typeof import("../src/services/evidence-review/review-outcome.service.js").loadCurrentReviewDecision;
let evidenceIsReviewed: typeof import("../src/services/governance.service.js").evidenceIsReviewed;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- route bodies are asserted field by field
type Res = { status: number; body: any; raw: string };
type Actor = { userId: string; token: string };

async function call(token: string, method: "GET" | "POST", url: string, payload?: unknown): Promise<Res> {
  const res = await harness.app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload !== undefined ? { "content-type": "application/json" } : {}),
    },
    payload: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  let body: unknown = null;
  try {
    body = JSON.parse(res.body);
  } catch {
    body = res.body;
  }
  await harness.handlersSettled();
  return { status: res.statusCode, body, raw: res.body };
}

let seq = 0;
async function newUser(label: string): Promise<Actor> {
  seq += 1;
  const email = `rchal-${label}-${Date.now()}-${seq}@test.proovra.local`;
  const user = await prisma.user.create({
    data: { email, firstName: "RChal", lastName: label, displayName: `RChal ${label}`, provider: "EMAIL", providerUserId: email },
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

let T: { teamId: string; owner: Actor; admin: Actor; admin2: Actor; member: Actor };

async function inReview(assignee: string) {
  const t = await prisma.team.findUniqueOrThrow({ where: { id: T.teamId }, select: { organizationId: true } });
  const evidenceId = (
    await prisma.evidence.create({
      data: { title: `rchal ${randomUUID().slice(0, 6)}`, type: "PHOTO", status: "CREATED", teamId: T.teamId, organizationId: t.organizationId, ownerUserId: T.owner.userId },
      select: { id: true },
    })
  ).id;
  const workflowId = (
    await prisma.evidenceReviewWorkflow.create({
      data: { evidenceId, teamId: T.teamId, status: "IN_REVIEW", workspaceType: "TEAM", assignedToUserId: assignee, assignedAtUtc: new Date() } as never,
      select: { id: true },
    })
  ).id;
  return { evidenceId, workflowId };
}

const api = {
  decide: (a: Actor, wf: string, decision: string) =>
    call(a.token, "POST", `/v1/reviewer-ops/workspace/${wf}/decisions`, { teamId: T.teamId, decision, rationale: `why ${decision}` }),
  lineage: (a: Actor, wf: string) => call(a.token, "GET", `/v1/reviewer-ops/workspace/${wf}/decisions?teamId=${T.teamId}`),
  requestIndependent: (a: Actor, wf: string) =>
    call(a.token, "POST", `/v1/reviewer-ops/reviews/${wf}/request-independent-review`, { teamId: T.teamId, note: "Second pair of eyes please" }),
  challenge: (a: Actor, wf: string, originalDecisionId: string) =>
    call(a.token, "POST", `/v1/reviewer/work/${wf}/disagree?teamId=${T.teamId}`, { originalDecisionId, rationale: "ignored the log" }),
  transition: (a: Actor, id: string, to: string, extra: Record<string, unknown> = {}) =>
    call(a.token, "POST", `/v1/reviewer/disagreements/${id}/transition?teamId=${T.teamId}`, { to, ...extra }),
};

const wfRow = (id: string) => prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id } });
const disRow = (id: string) => prisma.reviewerDisagreement.findUniqueOrThrow({ where: { id } });
const decisionRows = (workflowId: string) =>
  prisma.workflowReviewDecision.findMany({ where: { workflowId }, orderBy: { decidedAt: "asc" } });
const events = (workflowId: string, eventType: string) =>
  prisma.evidenceReviewWorkflowEvent.findMany({ where: { workflowId, eventType: eventType as never }, orderBy: { createdAt: "asc" } });
const reopenAudits = (evidenceId: string) =>
  prisma.evidenceReviewerAuditEvent.findMany({ where: { evidenceId, metadata: { path: ["event"], equals: "REVIEW_REOPENED" } } });
const challengeAudits = (disagreementId: string, action: string) =>
  prisma.adminAuditLog.findMany({ where: { action, resourceId: disagreementId }, orderBy: { createdAt: "asc" } });
const meta = (row: { metadata: unknown }) => (row.metadata ?? {}) as Record<string, unknown>;
const ref = (wf: { id: string; teamId: string | null; evidenceId: string; status: unknown; decisionRound: number }) => ({
  id: wf.id,
  teamId: wf.teamId!,
  evidenceId: wf.evidenceId,
  status: String(wf.status),
  decisionRound: wf.decisionRound,
});

/** A review the member decided, challenged by the owner, taken into second review by the admin. */
async function challengedReview(verdict: "APPROVE" | "REJECT") {
  const r = await inReview(T.member.userId);
  const dec = await api.decide(T.member, r.workflowId, verdict);
  expect(dec.status, dec.raw).toBe(201);
  const filed = await api.challenge(T.owner, r.workflowId, dec.body.decision.id);
  expect(filed.status, filed.raw).toBe(201);
  const disagreementId = filed.body.disagreementId as string;
  const taken = await api.transition(T.admin, disagreementId, "UNDER_SECOND_REVIEW");
  expect(taken.status, taken.raw).toBe(200);
  return { ...r, decisionId: dec.body.decision.id as string, disagreementId };
}

beforeAll(async () => {
  harness = await bootIntegrationHarness();
  ({ prisma } = await import("../src/db.js"));
  ({ REQUIRED_LEGAL_VERSIONS: requiredLegalVersions } = await import("../src/legal/legal-versioning.js"));
  ({ ensurePersonalWorkspace } = await import("../src/services/platform-context/workspace-bootstrap.service.js"));
  ops = await import("../src/services/review-operations/review-operations.service.js");
  ({ loadCurrentReviewDecision } = await import("../src/services/evidence-review/review-outcome.service.js"));
  ({ evidenceIsReviewed } = await import("../src/services/governance.service.js"));

  const owner = await newUser("owner");
  const space = await ensurePersonalWorkspace({ userId: owner.userId });
  const updated = await prisma.entitlement.updateMany({ where: { userId: owner.userId }, data: { plan: "TEAM", active: true } });
  if (updated.count === 0) await prisma.entitlement.create({ data: { userId: owner.userId, plan: "TEAM" } });
  const admin = await newUser("admin");
  const admin2 = await newUser("admin2");
  const member = await newUser("member");
  for (const [u, role] of [
    [admin, "ADMIN"],
    [admin2, "ADMIN"],
    [member, "MEMBER"],
  ] as const) {
    await prisma.teamMember.create({ data: { teamId: space.teamId, userId: u.userId, role, status: "ACTIVE" } });
  }
  T = { teamId: space.teamId, owner, admin, admin2, member };
});

afterAll(async () => {
  if (harness) await harness.cleanup();
});

describe("finding B — challenge resolution and superseding are one operation", () => {
  it("OVERTURNED on a finished (approved) review reopens it in the same transaction; approval-dependent reads follow", async () => {
    const c = await challengedReview("APPROVE");
    const before = await wfRow(c.workflowId);
    expect(String(before.status)).toBe("APPROVED_INTERNAL");
    expect(await loadCurrentReviewDecision(ref(before))).toBe("APPROVED");
    expect(await evidenceIsReviewed(c.evidenceId)).toBe(true);
    const decisionsBefore = await decisionRows(c.workflowId);

    const res = await api.transition(T.admin, c.disagreementId, "RESOLVED_OVERTURNED", { verdict: "REJECT", rationale: "device log contradicts" });
    expect(res.status, res.raw).toBe(200);
    expect(res.body).toEqual({ ok: true, superseded: "reopen" });

    const dis = await disRow(c.disagreementId);
    expect(dis.state).toBe("RESOLVED_OVERTURNED");
    expect(dis.resolvedByUserId).toBe(T.admin.userId);
    const after = await wfRow(c.workflowId);
    expect(String(after.status)).toBe("REOPENED");
    expect(after.decisionRound).toBe(before.decisionRound + 1);
    expect(after.reopenCount).toBe(before.reopenCount + 1);
    expect(await decisionRows(c.workflowId)).toEqual(decisionsBefore); // immutable history
    const reopened = await events(c.workflowId, "REOPENED");
    expect(reopened).toHaveLength(1);
    expect(reopened[0]!.nextValue).toMatchObject({
      decision: "REOPEN",
      source: "challenge_overturned",
      disagreementId: c.disagreementId,
      resolution: "RESOLVED_OVERTURNED",
      supersededRound: before.decisionRound,
      supersededDecisionId: c.decisionId,
    });
    expect(await reopenAudits(c.evidenceId)).toHaveLength(1);
    const audit = await challengeAudits(c.disagreementId, "reviewer.disagreement.transitioned");
    expect(audit.map((a) => meta(a).toState)).toEqual(["UNDER_SECOND_REVIEW", "RESOLVED_OVERTURNED"]);
    expect(meta(audit[1]!)).toMatchObject({ superseded: "reopen", workflowRoundBefore: before.decisionRound, workflowRoundAfter: after.decisionRound });
    expect(await challengeAudits(c.disagreementId, "reviewer.disagreement.supersede_failed")).toHaveLength(0);

    // Approval-dependent reads and gates follow the reopened round.
    expect(await loadCurrentReviewDecision(ref(after))).toBe("NO_DECISION");
    expect(await evidenceIsReviewed(c.evidenceId)).toBe(false);
  });

  it("PARTIAL on a finished (rejected) review reopens it the same way", async () => {
    const c = await challengedReview("REJECT");
    const before = await wfRow(c.workflowId);
    expect(String(before.status)).toBe("REJECTED_INSUFFICIENT");
    expect(await loadCurrentReviewDecision(ref(before))).toBe("NOT_ACCEPTED");
    const decisionsBefore = await decisionRows(c.workflowId);

    const res = await api.transition(T.admin, c.disagreementId, "RESOLVED_PARTIAL", { verdict: "NEEDS_INFO", rationale: "partly right" });
    expect(res.status, res.raw).toBe(200);
    expect(res.body.superseded).toBe("reopen");

    expect((await disRow(c.disagreementId)).state).toBe("RESOLVED_PARTIAL");
    const after = await wfRow(c.workflowId);
    expect(String(after.status)).toBe("REOPENED");
    expect(after.decisionRound).toBe(before.decisionRound + 1);
    expect(await decisionRows(c.workflowId)).toEqual(decisionsBefore);
    const reopened = await events(c.workflowId, "REOPENED");
    expect(reopened).toHaveLength(1);
    expect(reopened[0]!.nextValue).toMatchObject({ disagreementId: c.disagreementId, resolution: "RESOLVED_PARTIAL" });
    expect(reopened[0]!.note).toMatch(/^Challenge partially overturned: partly right/);
    expect(await reopenAudits(c.evidenceId)).toHaveLength(1);
    const audit = await challengeAudits(c.disagreementId, "reviewer.disagreement.transitioned");
    expect(meta(audit.at(-1)!)).toMatchObject({ toState: "RESOLVED_PARTIAL", superseded: "reopen" });
    expect(await loadCurrentReviewDecision(ref(after))).toBe("NO_DECISION");
  });

  it("an open round holding the challenged decision advances; the independence requirement is carried into the new round", async () => {
    const r = await inReview(T.member.userId);
    const req = await api.requestIndependent(T.member, r.workflowId);
    expect(req.status, req.raw).toBe(201);
    const first = await api.decide(T.member, r.workflowId, "APPROVE");
    expect(first.status, first.raw).toBe(201);
    expect(first.body.outcome.nextRequirement).toBe("second_review");
    const filed = await api.challenge(T.owner, r.workflowId, first.body.decision.id);
    expect(filed.status, filed.raw).toBe(201);
    const id = filed.body.disagreementId as string;
    expect((await api.transition(T.admin, id, "UNDER_SECOND_REVIEW")).status).toBe(200);
    const before = await wfRow(r.workflowId);
    expect(String(before.status)).toBe("IN_REVIEW");
    const decisionsBefore = await decisionRows(r.workflowId);

    const res = await api.transition(T.admin, id, "RESOLVED_OVERTURNED", { verdict: "REJECT", rationale: "approval was premature" });
    expect(res.status, res.raw).toBe(200);
    expect(res.body.superseded).toBe("advance_round");

    expect((await disRow(id)).state).toBe("RESOLVED_OVERTURNED");
    const after = await wfRow(r.workflowId);
    expect(String(after.status)).toBe("IN_REVIEW");
    expect(after.decisionRound).toBe(before.decisionRound + 1);
    expect(after.reopenCount).toBe(before.reopenCount);
    expect(await decisionRows(r.workflowId)).toEqual(decisionsBefore);
    expect(await events(r.workflowId, "REOPENED")).toHaveLength(0);
    const stage = (await events(r.workflowId, "STAGE_CHANGED")).filter(
      (e) => (e.nextValue as Record<string, unknown>)?.disagreementId === id,
    );
    expect(stage).toHaveLength(1);
    expect(stage[0]!.nextValue).toMatchObject({
      round: before.decisionRound + 1,
      source: "challenge_overturned",
      supersededRound: before.decisionRound,
      supersededDecisionId: first.body.decision.id,
      carriedSecondReviewCause: "independent_review_requested",
    });
    const audit = await challengeAudits(id, "reviewer.disagreement.transitioned");
    expect(meta(audit.at(-1)!)).toMatchObject({ toState: "RESOLVED_OVERTURNED", superseded: "advance_round", workflowRoundAfter: after.decisionRound });
    // The new round starts over and still requires an independent second decision.
    const lin = await api.lineage(T.member, r.workflowId);
    expect(lin.status, lin.raw).toBe(200);
    expect(lin.body).toMatchObject({ state: "first_required", secondReview: { required: true } });
    expect(await loadCurrentReviewDecision(ref(after))).toBe("NO_DECISION");
  });

  it("a challenge whose decision is from a previous round resolves as already superseded and changes no workflow", async () => {
    const c = await challengedReview("APPROVE");
    // The review moved on through the canonical Reopen before the resolution.
    await ops.recordLifecycleTransition({ evidenceId: c.evidenceId, decision: "REOPEN", actorUserId: T.owner.userId, note: "new facts" });
    const before = await wfRow(c.workflowId);
    expect(String(before.status)).toBe("REOPENED");
    const decisionsBefore = await decisionRows(c.workflowId);

    const res = await api.transition(T.admin, c.disagreementId, "RESOLVED_OVERTURNED", { verdict: "REJECT", rationale: "stale" });
    expect(res.status, res.raw).toBe(200);
    expect(res.body).toEqual({ ok: true, superseded: "already_superseded" });

    expect((await disRow(c.disagreementId)).state).toBe("RESOLVED_OVERTURNED");
    const after = await wfRow(c.workflowId);
    expect(String(after.status)).toBe("REOPENED");
    expect(after.decisionRound).toBe(before.decisionRound);
    expect(after.reopenCount).toBe(before.reopenCount);
    expect(await decisionRows(c.workflowId)).toEqual(decisionsBefore);
    expect(await events(c.workflowId, "REOPENED")).toHaveLength(1); // only the earlier, unrelated Reopen
    expect((await events(c.workflowId, "STAGE_CHANGED")).filter((e) => (e.nextValue as Record<string, unknown>)?.disagreementId)).toHaveLength(0);
    expect(await reopenAudits(c.evidenceId)).toHaveLength(1);
    const audit = await challengeAudits(c.disagreementId, "reviewer.disagreement.transitioned");
    expect(meta(audit.at(-1)!)).toMatchObject({
      toState: "RESOLVED_OVERTURNED",
      superseded: "already_superseded",
      challengedDecisionRound: before.decisionRound - 1,
      workflowRoundBefore: before.decisionRound,
      workflowRoundAfter: before.decisionRound,
    });
  });

  it.each([
    ["reopen (finished review)", "APPROVE", "REOPENED"],
    ["round advance (open review)", "OPEN", "STAGE_CHANGED"],
  ] as const)("a failure while superseding — %s — rolls the resolution back: nothing recorded, typed 409, retry succeeds", async (_label, kind, failingEvent) => {
    let c: { workflowId: string; evidenceId: string; decisionId: string; disagreementId: string };
    if (kind === "APPROVE") {
      c = await challengedReview("APPROVE");
    } else {
      const r = await inReview(T.member.userId);
      expect((await api.requestIndependent(T.member, r.workflowId)).status).toBe(201);
      const first = await api.decide(T.member, r.workflowId, "APPROVE");
      expect(first.status, first.raw).toBe(201);
      const filed = await api.challenge(T.owner, r.workflowId, first.body.decision.id);
      expect((await api.transition(T.admin, filed.body.disagreementId, "UNDER_SECOND_REVIEW")).status).toBe(200);
      c = { ...r, decisionId: first.body.decision.id, disagreementId: filed.body.disagreementId };
    }
    const before = await wfRow(c.workflowId);
    const disBefore = await disRow(c.disagreementId);
    const decisionsBefore = await decisionRows(c.workflowId);
    const eventsBefore = await prisma.evidenceReviewWorkflowEvent.count({ where: { workflowId: c.workflowId } });
    const auditsBefore = await prisma.evidenceReviewerAuditEvent.count({ where: { evidenceId: c.evidenceId } });

    // The lifecycle write fails INSIDE the resolution's transaction: a trigger
    // scoped to this one workflow raises on the superseding event's insert.
    const tag = c.workflowId.replace(/-/g, "").slice(0, 16);
    const fn = `rchal_fail_${tag}`;
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected supersede failure'; END $$`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ${fn} BEFORE INSERT ON evidence_review_workflow_events FOR EACH ROW ` +
        `WHEN (NEW.workflow_id = '${c.workflowId}'::uuid AND NEW.event_type::text = '${failingEvent}') EXECUTE FUNCTION ${fn}()`,
    );
    let res: Res;
    try {
      res = await api.transition(T.admin, c.disagreementId, "RESOLVED_OVERTURNED", { verdict: "REJECT", rationale: "will fail" });
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${fn} ON evidence_review_workflow_events`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
    }
    expect(res.status, res.raw).toBe(409);
    expect(res.body).toMatchObject({ denial: "DISAGREEMENT_SUPERSEDE_FAILED", code: "DISAGREEMENT_SUPERSEDE_FAILED" });

    // Nothing changed: the challenge keeps its prior state, the review is untouched.
    const dis = await disRow(c.disagreementId);
    expect(dis.state).toBe("UNDER_SECOND_REVIEW");
    expect(dis.resolvedAtUtc).toBeNull();
    expect(dis.resolvedByUserId).toBeNull();
    expect(dis.resolution).toBe(disBefore.resolution);
    const after = await wfRow(c.workflowId);
    expect(String(after.status)).toBe(String(before.status));
    expect(after.decisionRound).toBe(before.decisionRound);
    expect(after.reopenCount).toBe(before.reopenCount);
    expect(await decisionRows(c.workflowId)).toEqual(decisionsBefore);
    expect(await prisma.evidenceReviewWorkflowEvent.count({ where: { workflowId: c.workflowId } })).toBe(eventsBefore);
    expect(await prisma.evidenceReviewerAuditEvent.count({ where: { evidenceId: c.evidenceId } })).toBe(auditsBefore);
    const transitioned = await challengeAudits(c.disagreementId, "reviewer.disagreement.transitioned");
    expect(transitioned.map((a) => meta(a).toState)).toEqual(["UNDER_SECOND_REVIEW"]);
    const failed = await challengeAudits(c.disagreementId, "reviewer.disagreement.supersede_failed");
    expect(failed).toHaveLength(1);
    expect(meta(failed[0]!)).toMatchObject({ toState: "RESOLVED_OVERTURNED", fromState: "UNDER_SECOND_REVIEW" });
    expect(String(meta(failed[0]!).reason)).toMatch(/injected supersede failure/);

    // The rationale-bearing retry, once the fault is gone, records both together.
    const retry = await api.transition(T.admin, c.disagreementId, "RESOLVED_OVERTURNED", { verdict: "REJECT", rationale: "retry" });
    expect(retry.status, retry.raw).toBe(200);
    expect(retry.body.superseded).toBe(kind === "APPROVE" ? "reopen" : "advance_round");
    expect((await disRow(c.disagreementId)).state).toBe("RESOLVED_OVERTURNED");
    expect((await wfRow(c.workflowId)).decisionRound).toBe(before.decisionRound + 1);
  });

  it("two concurrent resolutions of the same challenge: exactly one wins and supersedes once", async () => {
    const c = await challengedReview("APPROVE");
    const before = await wfRow(c.workflowId);
    const decisionsBefore = await decisionRows(c.workflowId);

    const [a, b] = await Promise.all([
      api.transition(T.admin, c.disagreementId, "RESOLVED_OVERTURNED", { verdict: "REJECT", rationale: "first" }),
      api.transition(T.admin, c.disagreementId, "RESOLVED_PARTIAL", { verdict: "NEEDS_INFO", rationale: "second" }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses, `${a.raw} | ${b.raw}`).toEqual([200, 409]);
    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    expect(winner.body.superseded).toBe("reopen");
    expect(loser.body.denial).toBe("DISAGREEMENT_STATE_INVALID");
    const winnerState = winner === a ? "RESOLVED_OVERTURNED" : "RESOLVED_PARTIAL";

    expect((await disRow(c.disagreementId)).state).toBe(winnerState);
    const after = await wfRow(c.workflowId);
    expect(String(after.status)).toBe("REOPENED");
    expect(after.decisionRound).toBe(before.decisionRound + 1);
    expect(after.reopenCount).toBe(before.reopenCount + 1);
    expect(await decisionRows(c.workflowId)).toEqual(decisionsBefore);
    expect(await events(c.workflowId, "REOPENED")).toHaveLength(1);
    expect(await reopenAudits(c.evidenceId)).toHaveLength(1);
    const audit = await challengeAudits(c.disagreementId, "reviewer.disagreement.transitioned");
    expect(audit.map((x) => meta(x).toState)).toEqual(["UNDER_SECOND_REVIEW", winnerState]);
  });

  it("a resolution racing a competing lifecycle move waits on the workflow lock and revalidates: no second reopen of the newer round", async () => {
    const c = await challengedReview("APPROVE");
    const before = await wfRow(c.workflowId);
    const decisionsBefore = await decisionRows(c.workflowId);

    // A competing transaction takes the workflow row lock and reopens the
    // review through the canonical Tx entry point; it commits only when the
    // test releases it — after the resolution is seen waiting on that lock.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let onLocked!: (pid: number) => void;
    const locked = new Promise<number>((r) => (onLocked = r));
    const held = prisma.$transaction(
      async (tx) => {
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
        await tx.$queryRaw`SELECT "id" FROM "evidence_review_workflows" WHERE "id" = ${c.workflowId}::uuid FOR UPDATE`;
        await ops.recordLifecycleTransitionTx(tx, {
          evidenceId: c.evidenceId,
          decision: "REOPEN",
          actorUserId: T.owner.userId,
          note: "competing reopen",
        });
        onLocked(pid);
        await gate;
      },
      { timeout: 25_000, maxWait: 10_000 },
    );
    const holderPid = await locked;
    const resolving = api.transition(T.admin, c.disagreementId, "RESOLVED_OVERTURNED", { verdict: "REJECT", rationale: "raced" });
    // Controlled interleaving: proceed once PostgreSQL reports the resolution
    // blocked by the holder (no sleeps).
    for (let i = 0; ; i += 1) {
      const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid))`;
      if (n > 0) break;
      if (i > 5_000) throw new Error("the resolution never waited on the workflow lock");
    }
    release();
    await held;
    const res = await resolving;
    expect(res.status, res.raw).toBe(200);
    expect(res.body.superseded).toBe("already_superseded");

    expect((await disRow(c.disagreementId)).state).toBe("RESOLVED_OVERTURNED");
    const after = await wfRow(c.workflowId);
    expect(String(after.status)).toBe("REOPENED");
    expect(after.decisionRound).toBe(before.decisionRound + 1); // the competing reopen only
    expect(after.reopenCount).toBe(before.reopenCount + 1);
    expect(await decisionRows(c.workflowId)).toEqual(decisionsBefore);
    const reopened = await events(c.workflowId, "REOPENED");
    expect(reopened).toHaveLength(1);
    expect((reopened[0]!.nextValue as Record<string, unknown>).disagreementId).toBeUndefined();
    expect(await reopenAudits(c.evidenceId)).toHaveLength(1);
    const audit = await challengeAudits(c.disagreementId, "reviewer.disagreement.transitioned");
    expect(meta(audit.at(-1)!)).toMatchObject({ superseded: "already_superseded", workflowRoundBefore: after.decisionRound });
  });
});
