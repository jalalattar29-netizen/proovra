/**
 * TEAM REMEDIATION — STAGE C: SLA, escalation, counts and notification truth.
 *
 * Real routes and engines against PostgreSQL, each case in its own Team
 * workspace (a personal workspace on the TEAM plan), so no global sweep reads
 * another suite's rows.
 *
 *   T-044  the first-review dimension completes on the first decision.
 *   T-047  the sweep never stamps a dimension whose fact exists; the repair job
 *          clears sweep-stamped-after-the-fact deadlines (idempotent, audited).
 *   T-049  the Review page projection names the highest-severity active
 *          escalation and how many are active (ADD-SECURITY Q5.2).
 *   T-050  resolving the newer escalation keeps the review escalated on every
 *          review-unit surface; the pointer is re-derived; drift is repaired.
 *   T-052/3 the §9.2 fixture reads the same on the rail, the slice and the SLA
 *          tiles: 3 unassigned reviews, 2 of mine, 1 escalated review, 2 → 1
 *          active escalations.
 *   T-054  one "QC awaiting verdict" set.
 *   T-055  console tab counts are totals.
 *   T-056  metrics with no data are null.
 *   T-057  closed reviews are reported apart.
 *   T-058  "awaiting first review" counts open reviews only.
 *   T-060/T-169 an acknowledged escalation stays active in the inbox.
 *   T-061/2/3 queue signals: stored OVERDUE gets a signal with the real
 *          crossing time; no workload data → no pressure; finished → no age.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness } from "./integration-harness.js";

let harness: IntegrationHarness;
let prisma: typeof import("../src/db.js").prisma;
let requiredLegalVersions: Record<string, unknown>;
let escalations: typeof import("../src/services/reviewer-ops/escalation-engine.service.js");
let ops: typeof import("../src/services/review-operations/review-operations.service.js");
let repair: typeof import("../src/services/reviewer-ops/review-sla-truth-repair.service.js");
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
  const email = `trem-c-${label}-${Date.now()}-${seq}@test.proovra.local`;
  const user = await prisma.user.create({
    data: { email, firstName: "TremC", lastName: label, provider: "EMAIL", providerUserId: email, emailVerifiedAt: new Date() },
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
        title: `trem-c ${randomUUID().slice(0, 6)}`,
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

async function escalate(
  s: Space,
  w: { workflowId: string; evidenceId: string },
  severity: "WARNING" | "HIGH" | "CRITICAL",
  reason: "REVIEW_OVERDUE" | "INTEGRITY_RISK" | "REVIEWER_ESCALATED" = "REVIEW_OVERDUE",
) {
  const r = await escalations.createEscalation(
    {
      teamId: s.teamId,
      workflowId: w.workflowId,
      evidenceId: w.evidenceId,
      reason,
      severity,
      safeSummary: `stage C ${severity}`,
      createdByUserId: s.owner.userId,
      assignedToUserId: s.owner.userId,
      bypassDedup: true,
    } as never,
    prisma as never,
  );
  if (!r.ok) throw new Error(`escalation refused: ${JSON.stringify(r)}`);
  return r.escalation.id as string;
}

beforeAll(async () => {
  harness = await bootIntegrationHarness();
  ({ prisma } = await import("../src/db.js"));
  ({ REQUIRED_LEGAL_VERSIONS: requiredLegalVersions } = await import("../src/legal/legal-versioning.js"));
  escalations = await import("../src/services/reviewer-ops/escalation-engine.service.js");
  ops = await import("../src/services/review-operations/review-operations.service.js");
  repair = await import("../src/services/reviewer-ops/review-sla-truth-repair.service.js");
  ({ ensurePersonalWorkspace } = await import("../src/services/platform-context/workspace-bootstrap.service.js"));
}, 900_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
}, 300_000);

describe("T-049 / T-050 / T-052 / T-053 — Q5.2: one escalated review, two active escalations", () => {
  it("every surface reads 1 escalated review and the escalation count; resolving the newer keeps it escalated", async () => {
    const s = await teamSpace("q52");
    const me = s.owner;
    // §9.2 fixture: 3 NOT_STARTED unassigned, 1 ASSIGNED mine, 1 IN_REVIEW mine (escalated), 1 CLOSED.
    for (let i = 0; i < 3; i += 1) await workflow(s);
    await workflow(s, { status: "ASSIGNED", assignedToUserId: me.userId });
    const w1 = await workflow(s, { status: "IN_REVIEW", assignedToUserId: me.userId });
    await workflow(s, { status: "CLOSED", extra: { closedAt: new Date() } });

    // E1 HIGH (older, acknowledged), then E2 WARNING (newer, open).
    const e1 = await escalate(s, w1, "HIGH");
    await escalations.acknowledgeEscalation({ teamId: s.teamId, escalationId: e1, actorUserId: me.userId } as never, prisma as never);
    const e2 = await escalate(s, w1, "WARNING");

    // T-050 — the pointer names the governing escalation, not the newest.
    const row = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: w1.workflowId } });
    expect(row.activeEscalationId).toBe(e1);

    // T-049 — the Review page projection.
    const ws = await call(me.token, "GET", `/v1/reviewer-ops/workspace/${w1.workflowId}?teamId=${s.teamId}`);
    expect(ws.status, ws.raw).toBe(200);
    expect(ws.body.openEscalation.severity).toBe("HIGH");
    expect(ws.body.activeEscalationCount).toBe(2);
    // T-045 — an escalation is not an SLA state.
    expect(ws.body.projection.slaRollupState).not.toBe("ESCALATED");

    // T-053 — the focus-mode rail equals the slices it links to.
    const rail = await call(me.token, "GET", `/v1/reviewer/workspace?teamId=${s.teamId}`);
    expect(rail.status, rail.raw).toBe(200);
    expect(rail.body.workspace.queues.unassigned).toBe(3);
    expect(rail.body.workspace.queues.assigned).toBe(2);
    expect(rail.body.workspace.queues.escalated).toBe(1);

    const slice = async () =>
      (await call(me.token, "GET", `/v1/reviewer-ops/queue?teamId=${s.teamId}&queue=ESCALATED`)).body.rows.map(
        (r: { workflowId: string }) => r.workflowId,
      );
    expect(await slice()).toEqual([w1.workflowId]);

    // T-052 — SLA tiles: reviews and escalations are different units.
    let dash = await call(me.token, "GET", `/v1/reviewer-ops/dashboard?teamId=${s.teamId}`);
    expect(dash.status, dash.raw).toBe(200);
    expect(dash.body.counts.escalatedReviews).toBe(1);
    expect(dash.body.openEscalations).toBe(2);
    expect(dash.body.units).toMatchObject({ counts: "reviews", openEscalations: "escalations" });

    // Resolve the NEWER, lower escalation.
    await escalations.resolveEscalation(
      { teamId: s.teamId, escalationId: e2, actorUserId: null, resolutionNote: "handled", systemFinish: true } as never,
      prisma as never,
    );
    const after = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: w1.workflowId } });
    expect(after.activeEscalationId).toBe(e1);
    expect(await slice()).toEqual([w1.workflowId]);
    dash = await call(me.token, "GET", `/v1/reviewer-ops/dashboard?teamId=${s.teamId}`);
    expect(dash.body.counts.escalatedReviews).toBe(1);
    expect(dash.body.openEscalations).toBe(1);
    const ws2 = await call(me.token, "GET", `/v1/reviewer-ops/workspace/${w1.workflowId}?teamId=${s.teamId}`);
    expect(ws2.body.openEscalation.id).toBe(e1);
    expect(ws2.body.activeEscalationCount).toBe(1);

    // Reviewer performance still counts the escalated review.
    const perf = await call(me.token, "GET", `/v1/reviewer-ops/analytics/reviewers?teamId=${s.teamId}`);
    expect(perf.status, perf.raw).toBe(200);
    const mine = perf.body.rows.find((r: { reviewerUserId: string }) => r.reviewerUserId === me.userId);
    expect(mine.escalated).toBe(1);

    // The Escalations list is truly highest severity first (severity is text).
    const crit = await workflow(s, { status: "IN_REVIEW", assignedToUserId: me.userId });
    await escalate(s, crit, "WARNING");
    await escalate(s, crit, "CRITICAL");
    const list = await call(me.token, "GET", `/v1/reviewer-ops/escalations?teamId=${s.teamId}&status=ACTIVE`);
    expect(list.status, list.raw).toBe(200);
    const sev = (list.body.escalations ?? list.body.rows ?? list.body.items).map((e: { severity: string }) => e.severity);
    expect(sev[0]).toBe("CRITICAL");
    expect(sev.indexOf("HIGH")).toBeLessThan(sev.indexOf("WARNING"));
  });

  it("T-050: the repair job re-derives a drifted pointer, idempotently and audited", async () => {
    const s = await teamSpace("drift");
    const w = await workflow(s, { status: "IN_REVIEW", assignedToUserId: s.owner.userId });
    const high = await escalate(s, w, "HIGH");
    // Drift as the old engine left it: pointer cleared while HIGH is active.
    await prisma.evidenceReviewWorkflow.update({ where: { id: w.workflowId }, data: { activeEscalationId: null } });
    const dry = await repair.repairReviewSlaTruth({ apply: false, teamId: s.teamId }, prisma as never);
    expect(dry.changes).toEqual([
      expect.objectContaining({ workflowId: w.workflowId, kind: "escalation_pointer", before: null, after: high }),
    ]);
    expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: w.workflowId } })).activeEscalationId).toBeNull();
    const applied = await repair.repairReviewSlaTruth({ apply: true, teamId: s.teamId }, prisma as never);
    expect(applied.changes).toHaveLength(1);
    expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: w.workflowId } })).activeEscalationId).toBe(high);
    const audit = await prisma.adminAuditLog.findFirst({
      where: { resourceId: w.workflowId, action: "reviewer.review.sla_truth_repair" },
    });
    expect(audit).not.toBeNull();
    const again = await repair.repairReviewSlaTruth({ apply: true, teamId: s.teamId }, prisma as never);
    expect(again.changes).toHaveLength(0);
  });
});

describe("T-044 / T-047 — first review and sweep stamping", () => {
  it("T-047: the open-review sweep never stamps an assignment deadline on an assigned review", async () => {
    const s = await teamSpace("stamp");
    const assigned = await workflow(s, {
      status: "ASSIGNED",
      assignedToUserId: s.owner.userId,
      assignedAtUtc: new Date(Date.now() - 20 * 86400_000),
    });
    await ops.stampOpenReviewDeadlines({ teamId: s.teamId }, prisma as never);
    const row = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: assigned.workflowId } });
    expect(row.slaDueSoonHours).not.toBeNull(); // the sweep did stamp the row
    expect(row.assignmentDueAtUtc).toBeNull(); // …but not the dimension already met
    expect(row.firstResponseDueAtUtc).not.toBeNull();
    expect(row.completionDueAtUtc).not.toBeNull();
  });

  it("T-044: Start does not complete the first review; the first decision does", async () => {
    const s = await teamSpace("first");
    const w = await workflow(s, {
      status: "ASSIGNED",
      assignedToUserId: s.owner.userId,
      extra: { firstResponseDueAtUtc: new Date(Date.now() + 86400_000), completionDueAtUtc: new Date(Date.now() + 3 * 86400_000) },
    });
    const start = await call(s.owner.token, "POST", `/v1/reviewer-ops/reviews/${w.workflowId}/start`, { teamId: s.teamId });
    expect(start.status, start.raw).toBe(200);
    const read = async () =>
      (await call(s.owner.token, "GET", `/v1/reviewer-ops/workspace/${w.workflowId}?teamId=${s.teamId}`)).body.projection
        .slaDimensions as Array<{ dimension: string; state: string; completedAtUtc: string | null; metOnTime: boolean | null }>;
    const before = (await read()).find((d) => d.dimension === "FIRST_REVIEW")!;
    expect(before.state).not.toBe("COMPLETED");
    expect(before.completedAtUtc).toBeNull();
    const decided = await call(s.owner.token, "POST", `/v1/reviewer-ops/workspace/${w.workflowId}/decisions`, {
      teamId: s.teamId,
      decision: "REQUEST_INFO",
      rationale: "Need the original file.",
    });
    expect([200, 201], decided.raw).toContain(decided.status);
    const stored = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: w.workflowId } });
    expect(stored.firstDecidedAtUtc).not.toBeNull();
    const fr = (await read()).find((d) => d.dimension === "FIRST_REVIEW")!;
    expect(fr.state).toBe("COMPLETED");
    expect(fr.metOnTime).toBe(true);
    expect(fr.completedAtUtc).toBe(stored.firstDecidedAtUtc!.toISOString());
  });

  it("T-047: the repair clears deadlines the sweep stamped after the fact (29 Oct / 8 Nov fixture), never a decision", async () => {
    const s = await teamSpace("repair");
    const assignedAt = new Date("2026-10-29T10:00:00Z");
    const stampAt = new Date("2026-11-08T09:00:00Z");
    const h = (n: number) => new Date(stampAt.getTime() + n * 3600_000);
    const w = await workflow(s, {
      status: "IN_REVIEW",
      assignedToUserId: s.owner.userId,
      assignedAtUtc: assignedAt,
      extra: {
        assignmentDueAtUtc: h(4),
        firstResponseDueAtUtc: h(24),
        escalationDueAtUtc: h(48),
        completionDueAtUtc: h(72),
        dueAt: h(72),
        slaDueSoonHours: 6,
      },
    });
    const decision = await prisma.workflowReviewDecision.create({
      data: {
        workflowId: w.workflowId,
        teamId: s.teamId,
        stage: "FIRST",
        round: 0,
        reviewerUserId: s.owner.userId,
        decision: "REQUEST_INFO",
        rationale: "decided before the sweep",
        decidedAt: new Date("2026-10-30T10:00:00Z"),
      },
    });
    await prisma.evidenceReviewWorkflowEvent.create({
      data: {
        workflowId: w.workflowId,
        evidenceId: w.evidenceId,
        eventType: "SLA_UPDATED",
        nextValue: { source: "open_review_sweep" },
        createdAt: stampAt,
      } as never,
    });

    const dry = await repair.repairReviewSlaTruth({ apply: false, workflowIds: [w.workflowId] }, prisma as never);
    expect(dry.changes.map((c) => c.kind).sort()).toEqual([
      "first_decided_at",
      "sweep_stamped_assignment_deadline",
    ]);
    // Dry run writes nothing.
    expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: w.workflowId } })).assignmentDueAtUtc).not.toBeNull();

    await repair.repairReviewSlaTruth({ apply: true, workflowIds: [w.workflowId] }, prisma as never);
    // The first decision is backfilled; a second pass then finds the
    // sweep-stamped first-review deadline as well.
    await repair.repairReviewSlaTruth({ apply: true, workflowIds: [w.workflowId] }, prisma as never);
    const fixed = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: w.workflowId } });
    expect(fixed.assignmentDueAtUtc).toBeNull();
    expect(fixed.firstResponseDueAtUtc).toBeNull();
    expect(fixed.firstDecidedAtUtc?.toISOString()).toBe("2026-10-30T10:00:00.000Z");
    expect(fixed.completionDueAtUtc?.toISOString()).toBe(h(72).toISOString()); // kept
    expect(fixed.status).toBe("IN_REVIEW");
    const d = await prisma.workflowReviewDecision.findUniqueOrThrow({ where: { id: decision.id } });
    expect(d.decision).toBe("REQUEST_INFO");
    const last = await repair.repairReviewSlaTruth({ apply: true, workflowIds: [w.workflowId] }, prisma as never);
    expect(last.changes).toHaveLength(0);
  });
});

describe("T-054 / T-055 / T-056 / T-057 / T-058 — count definitions", () => {
  it("T-054: one IN_PROGRESS sample reads the same on the rail and the Queues card", async () => {
    const s = await teamSpace("qc");
    const w = await workflow(s, { status: "CLOSED", extra: { closedAt: new Date() } });
    await prisma.qcSample.create({ data: { teamId: s.teamId, workflowId: w.workflowId, state: "IN_PROGRESS" } as never });
    const rail = await call(s.owner.token, "GET", `/v1/reviewer/workspace?teamId=${s.teamId}`);
    const card = await call(s.owner.token, "GET", `/v1/reviewer-ops/qc/pending-count?teamId=${s.teamId}`);
    expect(card.status, card.raw).toBe(200);
    expect(rail.body.workspace.queues.qc).toBe(1);
    expect(card.body.pendingCount).toBe(1);
  });

  it("T-055: 40 unassigned reviews read 40 on the console tab, not the 25-row page", async () => {
    const s = await teamSpace("console");
    for (let i = 0; i < 40; i += 1) await workflow(s);
    const c = await call(s.owner.token, "GET", `/v1/reviewer-ops/console?teamId=${s.teamId}`);
    expect(c.status, c.raw).toBe(200);
    expect(c.body.queue.rows.length).toBe(25);
    expect(c.body.queue.count).toBe(40);
    expect(c.body.queue.unit).toBe("reviews");
    expect(c.body.escalations.unit).toBe("escalations");
  });

  it("T-056: a workspace with no decisions has no rates (null), not 0 % / 0 s", async () => {
    const s = await teamSpace("metrics");
    await workflow(s);
    const m = await call(s.owner.token, "GET", `/v1/reviewer/metrics?teamId=${s.teamId}`);
    expect(m.status, m.raw).toBe(200);
    expect(m.body.metrics.throughput7d).toBe(0);
    expect(m.body.metrics.escalationRate7dPct).toBeNull();
    expect(m.body.metrics.approvalRate7dPct).toBeNull();
    expect(m.body.metrics.avgReviewDurationMs7d).toBeNull();
    const rail = await call(s.owner.token, "GET", `/v1/reviewer/workspace?teamId=${s.teamId}`);
    expect(rail.body.workspace.metrics.escalationRate7dPct).toBeNull();
  });

  it("T-057: closed reviews are reported apart from open stages", async () => {
    const s = await teamSpace("stages");
    await workflow(s);
    await workflow(s, { status: "CLOSED", extra: { closedAt: new Date() } });
    const dash = await call(s.owner.token, "GET", `/v1/reviewer-ops/dashboard?teamId=${s.teamId}`);
    expect(dash.body.counts.openByStage).toEqual({ QUEUED: 1 });
    expect(dash.body.counts.closedByStage).toEqual({ CLOSED: 1 });
  });

  it("T-058: a CLOSED review with no decision is not 'awaiting first review'", async () => {
    const s = await teamSpace("summary");
    await workflow(s, { status: "CLOSED", extra: { closedAt: new Date() } });
    const open = await workflow(s);
    const r = await call(s.owner.token, "GET", `/v1/reviewer-ops/decisions/summary?teamId=${s.teamId}`);
    expect(r.status, r.raw).toBe(200);
    expect(r.body.summary.byState.first_required).toBe(1);
    expect(r.body.preview.first_required.map((p: { workflowId: string }) => p.workflowId)).toEqual([open.workflowId]);
    expect(r.body.summary.unit).toBe("reviews");
  });
});

describe("T-060 / T-169 — notifications follow the escalation's status", () => {
  it("an acknowledged escalation assigned to the caller is still active in the inbox", async () => {
    const s = await teamSpace("inbox");
    const w = await workflow(s, { status: "IN_REVIEW", assignedToUserId: s.owner.userId });
    const id = await escalate(s, w, "HIGH");
    await escalations.acknowledgeEscalation({ teamId: s.teamId, escalationId: id, actorUserId: s.owner.userId } as never, prisma as never);
    const current = await call(s.owner.token, "GET", "/v1/me/inbox");
    expect(current.status, current.raw).toBe(200);
    const item = current.body.items.find((i: { id: string }) => i.id === `review_escalation:${id}`);
    expect(item, "the acknowledged escalation fell out of current attention").toBeTruthy();
    const history = await call(s.owner.token, "GET", "/v1/me/inbox?include=resolved");
    const h = history.body.items.find((i: { id: string }) => i.id === `review_escalation:${id}`);
    expect(h).toBeTruthy();
    expect(h.resolvedAt ?? null).toBeNull();
  });
});

describe("T-061 / T-062 / T-063 — queue signals", () => {
  it("stored OVERDUE gets a signal with the real crossing time; no workload → no pressure; finished → no age", async () => {
    const s = await teamSpace("signals");
    const dueAt = new Date(Date.now() - 2 * 86400_000);
    const overdue = await workflow(s, {
      status: "IN_REVIEW",
      assignedToUserId: s.owner.userId,
      assignedAtUtc: new Date(Date.now() - 5 * 86400_000),
      extra: { slaStatus: "OVERDUE", dueAt, completionDueAtUtc: dueAt },
    });
    const closed = await workflow(s, { status: "CLOSED", extra: { closedAt: new Date(), completedAtUtc: new Date() } });
    const r = await call(s.owner.token, "POST", "/v1/reviewer-ops/queue-intelligence", {
      teamId: s.teamId,
      workflowIds: [overdue.workflowId, closed.workflowId],
    });
    expect(r.status, r.raw).toBe(200);
    const byId = new Map(r.body.projections.map((p: { workflowId: string }) => [p.workflowId, p]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const o = byId.get(overdue.workflowId) as any;
    expect(o.slaState.signal).toBe("OVERDUE");
    expect(o.slaState.status).toBe("BREACHED");
    expect(o.slaState.breachedAtUtc).toBe(dueAt.toISOString());
    expect(o.reviewerPressure).toBeNull(); // no workload snapshot exists
    expect(o.queueAging.agedFrom).toBe("assigned");
    expect(o.queueAging.daysOpen).toBe(5);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = byId.get(closed.workflowId) as any;
    expect(c.queueAging.daysOpen).toBeNull();
    expect(c.slaState.signal).toBeNull();
  });
});
