/**
 * TEAM REMEDIATION ROUND 2 (2026-11-25) — ONE SLA authority.
 *
 * Before: the stored `slaStatus` (queues Overdue/Due soon, counts, reminders,
 * the breach sweep and its overdue e-mail) counted Start as the first review and
 * rolled the automatic-escalation trigger up, while the Review header did
 * neither. Now the stored value IS the presented reading. Real routes and the
 * real sweep against PostgreSQL, each case in its own Team workspace.
 *
 *   1. Started, undecided, first-review deadline missed: header, Overdue queue,
 *      counts and the sweep all read BREACHED; the overdue e-mail goes out.
 *   2. Only the escalation trigger passed: nobody reads it overdue; no breach.
 *   3. Owner decision 2026-11-25: HISTORICAL backlog at rollout (deadline
 *      before the workspace's first presented-rules sweep, found within the
 *      bounded window) is recorded and escalated without the overdue e-mail;
 *      every breach occurring after rollout is e-mailed, however late it is
 *      found; concurrent sweeps record and notify once.
 *   4. A review decided before first_decided_at_utc existed is not breached.
 *   5. Resume moves a started-but-undecided review's first-review deadline.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness } from "./integration-harness.js";

let harness: IntegrationHarness;
let prisma: typeof import("../src/db.js").prisma;
let requiredLegalVersions: Record<string, unknown>;
let ops: typeof import("../src/services/review-operations/review-operations.service.js");
let engine: typeof import("../src/services/reviewer-ops/reviewer-operations-engine.service.js");
let ensurePersonalWorkspace: typeof import("../src/services/platform-context/workspace-bootstrap.service.js").ensurePersonalWorkspace;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- route bodies are asserted field by field
type Res = { status: number; body: any; raw: string };
type Actor = { userId: string; token: string };
type Space = { teamId: string; owner: Actor };

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
  return { status: res.statusCode, body, raw: res.body };
}

let seq = 0;
async function newUser(label: string): Promise<Actor> {
  seq += 1;
  const email = `trem-r2-${label}-${Date.now()}-${seq}@test.proovra.local`;
  const user = await prisma.user.create({
    data: { email, firstName: "TremR2", lastName: label, provider: "EMAIL", providerUserId: email, emailVerifiedAt: new Date() },
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

async function teamSpace(label: string): Promise<Space> {
  const owner = await newUser(label);
  const space = await ensurePersonalWorkspace({ userId: owner.userId });
  const updated = await prisma.entitlement.updateMany({ where: { userId: owner.userId }, data: { plan: "TEAM", active: true } });
  if (updated.count === 0) await prisma.entitlement.create({ data: { userId: owner.userId, plan: "TEAM" } });
  return { teamId: space.teamId, owner };
}

type WfOpts = {
  status?: string;
  assignedToUserId?: string | null;
  assignedAtUtc?: Date | null;
  extra?: Record<string, unknown>;
};
async function workflow(s: Space, o: WfOpts = {}) {
  const t = await prisma.team.findUniqueOrThrow({ where: { id: s.teamId }, select: { organizationId: true } });
  const evidenceId = (
    await prisma.evidence.create({
      data: {
        title: `trem-r2 ${randomUUID().slice(0, 6)}`,
        type: "PHOTO",
        status: "CREATED",
        teamId: s.teamId,
        organizationId: t.organizationId,
        ownerUserId: s.owner.userId,
      } as never,
      select: { id: true },
    })
  ).id;
  const row = await prisma.evidenceReviewWorkflow.create({
    data: {
      evidenceId,
      teamId: s.teamId,
      status: (o.status ?? "NOT_STARTED") as never,
      workspaceType: "TEAM",
      ...(o.assignedToUserId
        ? { assignedToUserId: o.assignedToUserId, assignedAtUtc: o.assignedAtUtc ?? new Date() }
        : {}),
      ...(o.extra ?? {}),
    } as never,
  });
  return { evidenceId, workflowId: row.id };
}

beforeAll(async () => {
  harness = await bootIntegrationHarness();
  ({ prisma } = await import("../src/db.js"));
  ({ REQUIRED_LEGAL_VERSIONS: requiredLegalVersions } = await import("../src/legal/legal-versioning.js"));
  ops = await import("../src/services/review-operations/review-operations.service.js");
  engine = await import("../src/services/reviewer-ops/reviewer-operations-engine.service.js");
  ({ ensurePersonalWorkspace } = await import("../src/services/platform-context/workspace-bootstrap.service.js"));
}, 900_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
}, 300_000);

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms);
const ahead = (ms: number) => new Date(Date.now() + ms);

async function header(s: Space, workflowId: string): Promise<string> {
  const ws = await call(s.owner.token, "GET", `/v1/reviewer-ops/workspace/${workflowId}?teamId=${s.teamId}`);
  expect(ws.status, ws.raw).toBe(200);
  return ws.body.projection.slaRollupState;
}
/** Records that the presented SLA rules first swept this workspace at `at`. */
const rolledOutAt = (teamId: string, at: Date) =>
  prisma.workerSweepCursor.upsert({
    where: { key: `sla_presented_rollout:${teamId}` },
    create: { key: `sla_presented_rollout:${teamId}`, cursorAt: at },
    update: { cursorAt: at },
  });

const breachEvents = (workflowId: string) =>
  prisma.evidenceReviewWorkflowEvent.findMany({ where: { workflowId, eventType: "SLA_BREACHED" } });

describe("round 2 — the stored SLA status is the presented one", () => {
  it("started, undecided, first-review deadline missed: header, Overdue queue, counts and sweep agree", async () => {
    const s = await teamSpace("started");
    const w = await workflow(s, {
      status: "IN_REVIEW",
      assignedToUserId: s.owner.userId,
      assignedAtUtc: ago(30 * HOUR),
      extra: {
        lastReviewedAt: ago(29 * HOUR), // Start wrote it; no decision
        firstResponseDueAtUtc: ago(2 * HOUR),
        completionDueAtUtc: ahead(40 * HOUR),
        escalationDueAtUtc: ahead(10 * HOUR),
        slaStatus: "ON_TRACK", // what the old reading stored
      },
    });
    expect(await header(s, w.workflowId)).toBe("BREACHED");
    // A workspace the presented rules already swept before this deadline passed.
    await rolledOutAt(s.teamId, ago(3 * HOUR));

    const swept = await ops.reconcileReviewSlas({ teamId: s.teamId }, prisma as never);
    expect(swept.breachedWorkflowIds).toEqual([w.workflowId]);
    expect(swept.breachedStale).toBe(0);
    const row = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: w.workflowId } });
    expect(row.slaStatus).toBe("BREACHED");
    const [event] = await breachEvents(w.workflowId);
    expect((event!.nextValue as Record<string, unknown>).notified).toBeUndefined();

    const overdue = await engine.listReviewerOpsQueue({ teamId: s.teamId, meUserId: s.owner.userId, queue: "OVERDUE" });
    expect(overdue.rows.map((r) => r.workflowId)).toEqual([w.workflowId]);
    expect(overdue.rows[0]!.slaRollupState).toBe("BREACHED");
    expect((await ops.getReviewQueueCounts({ teamId: s.teamId, meUserId: s.owner.userId })).overdue).toBe(1);
  });

  it("only the escalation trigger passed: no surface reads it overdue and nothing is breached", async () => {
    const s = await teamSpace("trigger");
    const w = await workflow(s, {
      status: "IN_REVIEW",
      assignedToUserId: s.owner.userId,
      extra: {
        firstDecidedAtUtc: ago(5 * HOUR),
        lastReviewedAt: ago(5 * HOUR),
        firstResponseDueAtUtc: ago(1 * HOUR),
        completionDueAtUtc: ahead(40 * HOUR),
        escalationDueAtUtc: ago(1 * HOUR),
      },
    });
    expect(await header(s, w.workflowId)).not.toBe("BREACHED");
    const swept = await ops.reconcileReviewSlas({ teamId: s.teamId }, prisma as never);
    expect(swept.flippedBreached).toBe(0);
    expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: w.workflowId } })).slaStatus).toBe("ON_TRACK");
    expect(await breachEvents(w.workflowId)).toHaveLength(0);
    const overdue = await engine.listReviewerOpsQueue({ teamId: s.teamId, meUserId: s.owner.userId, queue: "OVERDUE" });
    expect(overdue.rows).toHaveLength(0);
  });

  const startedOverdue = (s: Space, missedAgoMs: number) =>
    workflow(s, {
      status: "IN_REVIEW",
      assignedToUserId: s.owner.userId,
      assignedAtUtc: ago(missedAgoMs + 24 * HOUR),
      extra: {
        lastReviewedAt: ago(missedAgoMs + 24 * HOUR),
        firstResponseDueAtUtc: ago(missedAgoMs),
        completionDueAtUtc: ahead(40 * HOUR),
        slaStatus: "ON_TRACK",
      },
    });

  it("historical backlog at rollout: recorded and escalated, not e-mailed; the rollout instant is written once", async () => {
    const s = await teamSpace("backlog");
    const w = await startedOverdue(s, 3 * 24 * HOUR);
    const swept = await ops.reconcileReviewSlas({ teamId: s.teamId }, prisma as never);
    expect(swept.flippedBreached).toBe(1);
    expect(swept.breachedStale).toBe(1);
    expect(swept.breachedWorkflowIds).toEqual([w.workflowId]); // escalated as usual
    expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: w.workflowId } })).slaStatus).toBe("BREACHED");
    const [event] = await breachEvents(w.workflowId);
    expect(event!.nextValue).toMatchObject({ slaStatus: "BREACHED", notified: false, reason: "historical_backlog_at_rollout" });

    const marker = await prisma.workerSweepCursor.findUniqueOrThrow({ where: { key: `sla_presented_rollout:${s.teamId}` } });
    const again = await ops.presentedSlaRolloutAt(s.teamId, new Date(), prisma as never);
    expect(again.getTime()).toBe(marker.cursorAt!.getTime()); // never moved by a later sweep
  });

  it("a breach whose deadline passes after rollout is e-mailed, however late the sweep finds it", async () => {
    const s = await teamSpace("after-rollout");
    await rolledOutAt(s.teamId, ago(5 * 24 * HOUR));
    const w = await startedOverdue(s, 3 * 24 * HOUR); // missed 2 days after rollout, found now
    const swept = await ops.reconcileReviewSlas({ teamId: s.teamId }, prisma as never);
    expect(swept.breachedStale).toBe(0);
    const [event] = await breachEvents(w.workflowId);
    expect((event!.nextValue as Record<string, unknown>).notified).toBeUndefined();
  });

  it("the suppression is bounded: once the rollout window has closed, even an old deadline is e-mailed", async () => {
    const s = await teamSpace("window-closed");
    await rolledOutAt(s.teamId, ago(8 * 24 * HOUR));
    const w = await startedOverdue(s, 9 * 24 * HOUR); // missed before rollout, found after the window
    const swept = await ops.reconcileReviewSlas({ teamId: s.teamId }, prisma as never);
    expect(swept.breachedStale).toBe(0);
    const [event] = await breachEvents(w.workflowId);
    expect((event!.nextValue as Record<string, unknown>).notified).toBeUndefined();
  });

  it("concurrent sweeps and retries record one breach and notify once; the rollout instant is one value", async () => {
    const s = await teamSpace("concurrent");
    await rolledOutAt(s.teamId, ago(3 * 24 * HOUR));
    const w = await startedOverdue(s, 2 * HOUR);
    const [one, two] = await Promise.all([
      ops.reconcileReviewSlas({ teamId: s.teamId }, prisma as never),
      ops.reconcileReviewSlas({ teamId: s.teamId }, prisma as never),
    ]);
    const third = await ops.reconcileReviewSlas({ teamId: s.teamId }, prisma as never); // a retry
    const winners = [...one.breachedWorkflowIds, ...two.breachedWorkflowIds, ...third.breachedWorkflowIds];
    expect(winners).toEqual([w.workflowId]); // the overdue e-mail is sent only by the winner
    expect(await breachEvents(w.workflowId)).toHaveLength(1);

    const fresh = await teamSpace("concurrent-marker");
    const instants = await Promise.all(
      [0, 1, 2, 3].map((i) => ops.presentedSlaRolloutAt(fresh.teamId, new Date(Date.now() + i * 1000), prisma as never)),
    );
    expect(new Set(instants.map((d) => d.getTime())).size).toBe(1);
  });

  it("isHistoricalBacklogBreach: only a deadline before rollout, only inside the window", () => {
    const rolloutAt = new Date("2026-11-25T08:00:00Z");
    const at = (iso: string) => new Date(iso);
    expect(ops.isHistoricalBacklogBreach({ since: at("2026-11-20T00:00:00Z"), now: at("2026-11-25T08:05:00Z"), rolloutAt })).toBe(true);
    expect(ops.isHistoricalBacklogBreach({ since: at("2026-11-25T09:00:00Z"), now: at("2026-11-25T09:05:00Z"), rolloutAt })).toBe(false);
    expect(ops.isHistoricalBacklogBreach({ since: at("2026-11-20T00:00:00Z"), now: at("2026-12-03T08:00:01Z"), rolloutAt })).toBe(false);
    expect(ops.isHistoricalBacklogBreach({ since: null, now: at("2026-11-25T08:05:00Z"), rolloutAt })).toBe(false);
  });

  it("a review decided before first_decided_at_utc existed is not breached by the sweep", async () => {
    const s = await teamSpace("legacy");
    const decidedAt = ago(3 * 24 * HOUR);
    const w = await workflow(s, {
      status: "IN_REVIEW",
      assignedToUserId: s.owner.userId,
      assignedAtUtc: ago(5 * 24 * HOUR),
      extra: {
        lastReviewedAt: decidedAt,
        firstResponseDueAtUtc: ago(2 * 24 * HOUR),
        completionDueAtUtc: ahead(2 * 24 * HOUR),
        slaStatus: "ON_TRACK",
      },
    });
    await prisma.workflowReviewDecision.create({
      data: {
        workflowId: w.workflowId,
        teamId: s.teamId,
        stage: "FIRST",
        round: 0,
        reviewerUserId: s.owner.userId,
        decision: "REQUEST_INFO",
        rationale: "legacy decision",
        decidedAt,
      },
    });
    const swept = await ops.reconcileReviewSlas({ teamId: s.teamId }, prisma as never);
    expect(swept.flippedBreached).toBe(0);
    expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: w.workflowId } })).slaStatus).toBe("ON_TRACK");
    expect(await header(s, w.workflowId)).not.toBe("BREACHED");
  });

  it("resume moves the first-review deadline of a started-but-undecided review by the time held", async () => {
    const s = await teamSpace("resume");
    const due = ahead(2 * HOUR);
    const pausedAt = ago(10 * HOUR);
    const w = await workflow(s, {
      status: "IN_REVIEW",
      assignedToUserId: s.owner.userId,
      extra: {
        lastReviewedAt: ago(20 * HOUR),
        firstResponseDueAtUtc: due,
        completionDueAtUtc: ahead(40 * HOUR),
        slaPausedAtUtc: pausedAt,
        slaStatus: "PAUSED",
      },
    });
    await engine.resumeReview(
      { teamId: s.teamId, actorUserId: s.owner.userId, isReviewerCapable: true, mayActOnOthersReviews: true, isServiceAccount: false } as never,
      { workflowId: w.workflowId },
      prisma as never,
    );
    const row = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: w.workflowId } });
    const moved = row.firstResponseDueAtUtc!.getTime() - due.getTime();
    expect(moved).toBeGreaterThan(9.9 * HOUR);
    expect(moved).toBeLessThan(10.5 * HOUR);
    expect(row.slaStatus).toBe("ON_TRACK");
  });
});
