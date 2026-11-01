/**
 * WORKFLOW-006 / 007 / 011 / 012 / 013 / 014 — review deadlines come from the
 * policy, the SLA engine reads them, and the queues, counts and badge agree.
 *
 * Real tenants, real rows, the real routes and the real reconcile path. The clock
 * is moved by moving the row's own timestamps, as the audit's probe P7 specifies
 * with a shifted clock.
 */
import { randomUUID } from "node:crypto";

import { REVIEWER_OPS_CRON_HEADER } from "@proovra/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  seedOrganizationTenant,
  seedPersonalTenant,
  type FixtureDeps,
  type OrganizationTenant,
} from "./point7/product-fixtures.js";

const HOUR = 3_600_000;

describe("Review SLA authority (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let engine: typeof import("../src/services/reviewer-ops/reviewer-operations-engine.service.js");
  let workflowService: typeof import("../src/services/evidence-review/reviewer-workflow.service.js");
  let ops: typeof import("../src/services/review-operations/review-operations.service.js");
  let deps: FixtureDeps;
  const tag = `sla-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  async function record(org: OrganizationTenant) {
    const ev = await prisma.evidence.create({
      data: { ownerUserId: org.owner.userId, teamId: org.workspaceId, organizationId: org.organizationId, type: "PHOTO" },
      select: { id: true },
    });
    return ev.id;
  }

  /** The Capture write: every finalized record reaches review through this. */
  async function captureReview(org: OrganizationTenant) {
    const evidenceId = await record(org);
    await workflowService.upsertEvidenceReviewerWorkflow({
      evidenceId,
      workspaceType: "TEAM",
      teamId: org.workspaceId,
      actorUserId: org.owner.userId,
      status: "NOT_STARTED" as never,
      priority: "NORMAL" as never,
    });
    return prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { evidenceId } });
  }

  const setPolicy = (org: OrganizationTenant, hours: Partial<Record<string, number>>) =>
    prisma.workspaceGovernancePolicy.upsert({
      where: { teamId: org.workspaceId },
      create: { teamId: org.workspaceId, ...hours } as never,
      update: hours as never,
    });

  /** Moves the row into the past by shifting every timestamp on it. */
  async function age(workflowId: string, ms: number) {
    const r = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: workflowId } });
    const back = (d: Date | null) => (d ? new Date(d.getTime() - ms) : d);
    await prisma.evidenceReviewWorkflow.update({
      where: { id: workflowId },
      data: {
        assignmentDueAtUtc: back(r.assignmentDueAtUtc),
        firstResponseDueAtUtc: back(r.firstResponseDueAtUtc),
        completionDueAtUtc: back(r.completionDueAtUtc),
        dueAt: back(r.dueAt),
        escalationDueAtUtc: back(r.escalationDueAtUtc),
        assignedAtUtc: back(r.assignedAtUtc),
        slaPausedAtUtc: back(r.slaPausedAtUtc),
      },
    });
  }

  const ownerCtx = (org: OrganizationTenant) => ({
    teamId: org.workspaceId,
    actorUserId: org.owner.userId,
    isReviewerCapable: true,
    mayActOnOthersReviews: true,
    isServiceAccount: false,
  });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    engine = await import("../src/services/reviewer-ops/reviewer-operations-engine.service.js");
    workflowService = await import("../src/services/evidence-review/reviewer-workflow.service.js");
    ops = await import("../src/services/review-operations/review-operations.service.js");
    const { signJwt } = await import("../src/services/jwt.js");
    deps = {
      prisma: prisma as never,
      tag,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authAt: Math.floor(Date.now() / 1000), authMethod: "PASSWORD" } as never,
          process.env.AUTH_JWT_SECRET!,
          3600,
        ),
    };
  }, 180_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  it("WORKFLOW-006: a stated policy governs a captured review, and a workspace with none gets no SLA", async () => {
    const stated = await seedOrganizationTenant(deps);
    await setPolicy(stated, {
      defaultAssignmentDueHours: 2,
      defaultFirstResponseDueHours: 3,
      defaultCompletionDueHours: 5,
      defaultEscalationDueHours: 4,
      defaultDueSoonHours: 1,
    });
    const row = await captureReview(stated);
    const hoursAfter = (d: Date | null) => Math.round((d!.getTime() - row.createdAt.getTime()) / HOUR);
    expect(hoursAfter(row.assignmentDueAtUtc)).toBe(2);
    expect(hoursAfter(row.firstResponseDueAtUtc)).toBe(3);
    expect(hoursAfter(row.completionDueAtUtc)).toBe(5);
    expect(hoursAfter(row.dueAt)).toBe(5);
    expect(hoursAfter(row.escalationDueAtUtc)).toBe(4);
    expect(row.slaDueSoonHours).toBe(1);
    expect(row.slaStatus).toBe("ON_TRACK");
    const event = await prisma.evidenceReviewWorkflowEvent.findFirst({
      where: { workflowId: row.id, eventType: "SLA_UPDATED" },
    });
    expect((event?.nextValue as { source?: string } | null)?.source).toBe("capture_policy");

    // Negative control: Capture alone does not breach a workspace that stated nothing.
    const silent = await seedOrganizationTenant(deps);
    const unstated = await captureReview(silent);
    expect(unstated.dueAt).toBeNull();
    expect(unstated.slaStatus).toBeNull();
    const swept = await engine.runReconcile({ teamId: silent.workspaceId });
    expect(swept.flippedBreached).toBe(0);
    const after = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: unstated.id } });
    expect(after.dueAt).toBeNull();
  });

  it("WORKFLOW-006: every assignment door starts the effective policy, platform defaults included", async () => {
    const org = await seedOrganizationTenant(deps, { memberCount: 1 });
    const reviewer = org.members[0]!;
    await prisma.teamMember.updateMany({
      where: { teamId: org.workspaceId, userId: reviewer.userId },
      data: { role: "ADMIN" as never },
    });

    const viaAssign = await captureReview(org);
    await ops.assignReviewer({ evidenceId: viaAssign.evidenceId, assignedToUserId: reviewer.userId, actorUserId: org.owner.userId }, prisma as never);
    const viaClaim = await captureReview(org);
    await ops.claimReviewerWorkflow({ evidenceId: viaClaim.evidenceId, actorUserId: reviewer.userId }, prisma as never);
    const viaPatch = await captureReview(org);
    await workflowService.upsertEvidenceReviewerWorkflow({
      evidenceId: viaPatch.evidenceId,
      workspaceType: "TEAM",
      teamId: org.workspaceId,
      actorUserId: org.owner.userId,
      assignedToUserId: reviewer.userId,
    });

    for (const w of [viaAssign, viaClaim, viaPatch]) {
      const row = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: w.id } });
      expect(row.dueAt, "due date").not.toBeNull();
      expect(row.firstResponseDueAtUtc, "first response").not.toBeNull();
      expect(row.completionDueAtUtc, "completion").not.toBeNull();
      expect(row.escalationDueAtUtc, "escalation").not.toBeNull();
      expect(row.slaDueSoonHours).toBe(6);
      expect(row.slaStatus).toBe("ON_TRACK");
    }
  });

  it("WORKFLOW-006 (P7): a missed deadline breaches, escalates once, and the Overdue queue agrees with the badge", async () => {
    const org = await seedOrganizationTenant(deps);
    await setPolicy(org, {
      defaultAssignmentDueHours: 1,
      defaultFirstResponseDueHours: 1,
      defaultCompletionDueHours: 1,
      defaultEscalationDueHours: 1,
      defaultDueSoonHours: 1,
    });
    const row = await captureReview(org);
    await ops.claimReviewerWorkflow({ evidenceId: row.evidenceId, actorUserId: org.owner.userId }, prisma as never);
    await age(row.id, 2 * HOUR);

    const first = await engine.runReconcile({ teamId: org.workspaceId });
    expect(first.flippedBreached).toBe(1);
    expect(first.escalationsCreated).toBe(1);
    const breached = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: row.id } });
    expect(breached.slaStatus).toBe("BREACHED");
    expect(breached.activeEscalationId).not.toBeNull();
    expect(await prisma.evidenceReviewWorkflowEvent.count({ where: { workflowId: row.id, eventType: "SLA_BREACHED" } })).toBe(1);

    const queue = await engine.listReviewerOpsQueue({ teamId: org.workspaceId, meUserId: org.owner.userId, queue: "OVERDUE" });
    expect(queue.rows.map((r) => r.workflowId)).toEqual([row.id]);
    expect(queue.rows[0]!.slaRollupState).toBe("ESCALATED");
    const counts = await ops.getReviewQueueCounts({ teamId: org.workspaceId, meUserId: org.owner.userId });
    expect(counts.overdue).toBe(1);

    const second = await engine.runReconcile({ teamId: org.workspaceId });
    expect(second.flippedBreached).toBe(0);
    expect(second.escalationsCreated).toBe(0);
    expect(await prisma.evidenceReviewWorkflowEvent.count({ where: { workflowId: row.id, eventType: "SLA_BREACHED" } })).toBe(1);
  });

  it("WORKFLOW-006: an old open row is given the whole window from the sweep, never breached retroactively", async () => {
    const org = await seedOrganizationTenant(deps);
    const old = await captureReview(org);
    await prisma.$executeRaw`UPDATE evidence_review_workflows SET created_at = now() - interval '90 days' WHERE id = ${old.id}::uuid`;
    await setPolicy(org, { defaultCompletionDueHours: 2, defaultFirstResponseDueHours: 2, defaultAssignmentDueHours: 1, defaultEscalationDueHours: 2 });

    const swept = await engine.runReconcile({ teamId: org.workspaceId });
    const row = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: old.id } });
    expect(row.dueAt!.getTime()).toBeGreaterThan(Date.now());
    expect(row.firstResponseDueAtUtc!.getTime()).toBeGreaterThan(Date.now());
    expect(swept.escalationsCreated).toBe(0);
    expect(await prisma.evidenceReviewWorkflowEvent.count({ where: { workflowId: old.id, eventType: "SLA_BREACHED" } })).toBe(0);
  });

  it("WORKFLOW-007: queue and badge read one window, and it is the review's", async () => {
    const org = await seedOrganizationTenant(deps);
    await setPolicy(org, {
      defaultAssignmentDueHours: 100,
      defaultFirstResponseDueHours: 100,
      defaultCompletionDueHours: 100,
      defaultEscalationDueHours: 100,
      defaultDueSoonHours: 10,
    });
    const inside = await captureReview(org);
    const outside = await captureReview(org);
    await age(inside.id, 95 * HOUR); // 5h left, inside the 10h window; the old default read 60 minutes
    await age(outside.id, 80 * HOUR); // 20h left, outside it
    await engine.runReconcile({ teamId: org.workspaceId });

    const queue = await engine.listReviewerOpsQueue({ teamId: org.workspaceId, meUserId: org.owner.userId, queue: "DUE_SOON" });
    expect(queue.rows.map((r) => r.workflowId)).toEqual([inside.id]);
    expect(queue.rows[0]!.slaRollupState).toBe("DUE_SOON");
    const outsideRow = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: outside.id } });
    expect(engine.buildWorkflowProjection(outsideRow).slaRollupState).toBe("HEALTHY");
    expect(outsideRow.slaStatus).toBe("ON_TRACK");
  });

  it("WORKFLOW-011 (P10): pause is refused on a finished review and on someone else's, and resume moves the deadlines by the time held", async () => {
    const org = await seedOrganizationTenant(deps, { memberCount: 2 });
    const [holder, other] = org.members;
    for (const u of [holder!, other!]) {
      await prisma.teamMember.updateMany({ where: { teamId: org.workspaceId, userId: u.userId }, data: { role: "ADMIN" as never } });
    }
    await setPolicy(org, { defaultCompletionDueHours: 10, defaultFirstResponseDueHours: 10, defaultAssignmentDueHours: 10, defaultEscalationDueHours: 10 });
    const row = await captureReview(org);
    await ops.claimReviewerWorkflow({ evidenceId: row.evidenceId, actorUserId: holder!.userId }, prisma as never);

    const plain = (userId: string) => ({ teamId: org.workspaceId, actorUserId: userId, isReviewerCapable: true, isServiceAccount: false });
    await expect(engine.pauseReview(plain(other!.userId), { workflowId: row.id, pausedReason: "not mine" })).rejects.toMatchObject({
      code: "REVIEW_PERMISSION_DENIED",
    });
    const untouched = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: row.id } });
    expect(untouched.slaPausedAtUtc).toBeNull();

    await engine.pauseReview(plain(holder!.userId), { workflowId: row.id, pausedReason: "waiting on counsel" });
    const paused = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: row.id } });
    expect(paused.slaStatus).toBe("PAUSED");
    await age(row.id, 0);
    await prisma.evidenceReviewWorkflow.update({
      where: { id: row.id },
      data: { slaPausedAtUtc: new Date(Date.now() - 3 * HOUR) },
    });
    const dueBefore = paused.dueAt!.getTime();

    await expect(engine.pauseReview(plain(holder!.userId), { workflowId: row.id, pausedReason: "again" })).rejects.toMatchObject({
      code: "REVIEW_INVALID_TRANSITION",
    });
    const blocked = await engine.listReviewerOpsQueue({ teamId: org.workspaceId, meUserId: org.owner.userId, queue: "WORKFLOW_BLOCKED" });
    expect(blocked.rows.map((r) => r.workflowId)).toEqual([row.id]);

    await expect(engine.resumeReview(plain(other!.userId), { workflowId: row.id })).rejects.toMatchObject({ code: "REVIEW_PERMISSION_DENIED" });

    await engine.resumeReview(plain(holder!.userId), { workflowId: row.id, note: "counsel answered" });
    const resumed = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: row.id } });
    expect(resumed.slaPausedAtUtc).toBeNull();
    expect(resumed.pausedReason).toBeNull();
    expect(resumed.slaStatus).toBe("ON_TRACK");
    const moved = resumed.dueAt!.getTime() - dueBefore;
    expect(Math.abs(moved - 3 * HOUR)).toBeLessThan(60_000);
    const event = await prisma.evidenceReviewWorkflowEvent.findFirst({
      where: { workflowId: row.id, eventType: "SLA_UPDATED", note: "counsel answered" },
    });
    expect(event).not.toBeNull();
    const unblocked = await engine.listReviewerOpsQueue({ teamId: org.workspaceId, meUserId: org.owner.userId, queue: "WORKFLOW_BLOCKED" });
    expect(unblocked.rows).toEqual([]);
    await expect(engine.resumeReview(plain(holder!.userId), { workflowId: row.id })).rejects.toMatchObject({ code: "REVIEW_INVALID_TRANSITION" });

    // A finished review cannot be paused, by anyone.
    await prisma.evidenceReviewWorkflow.update({ where: { id: row.id }, data: { status: "CLOSED", closedAt: new Date() } });
    await expect(engine.pauseReview(ownerCtx(org), { workflowId: row.id, pausedReason: "closed" })).rejects.toMatchObject({
      code: "REVIEW_INVALID_TRANSITION",
    });
  });

  it("WORKFLOW-011: the resume route is authorized like pause", async () => {
    const org = await seedOrganizationTenant(deps);
    const stranger = await seedOrganizationTenant(deps);
    await setPolicy(org, { defaultCompletionDueHours: 10 });
    const row = await captureReview(org);
    await prisma.evidenceReviewWorkflow.update({
      where: { id: row.id },
      data: { slaPausedAtUtc: new Date(Date.now() - HOUR), pausedReason: "held", slaStatus: "PAUSED" },
    });
    const url = `/v1/reviewer-ops/reviews/${row.id}/resume`;
    const refused = await h.app.inject({
      method: "POST",
      url,
      headers: bearer(stranger.owner.token),
      payload: { teamId: org.workspaceId },
    });
    expect(refused.statusCode, refused.body).toBe(404);
    expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: row.id } })).slaPausedAtUtc).not.toBeNull();
    const ok = await h.app.inject({
      method: "POST",
      url,
      headers: bearer(org.owner.token),
      payload: { teamId: org.workspaceId },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: row.id } })).slaPausedAtUtc).toBeNull();
  });

  it("WORKFLOW-013 (P12): finished work leaves the queues and counts, and every count is open work", async () => {
    const org = await seedOrganizationTenant(deps);
    await setPolicy(org, { defaultCompletionDueHours: 1, defaultFirstResponseDueHours: 1, defaultAssignmentDueHours: 1, defaultEscalationDueHours: 1 });
    const live = await captureReview(org);
    const finished = await captureReview(org);
    await age(live.id, 2 * HOUR);
    await age(finished.id, 2 * HOUR);
    await prisma.evidenceReviewWorkflow.updateMany({
      where: { id: { in: [live.id, finished.id] } },
      data: { slaStatus: "BREACHED" },
    });
    await prisma.evidenceReviewWorkflow.update({
      where: { id: finished.id },
      data: { status: "APPROVED_INTERNAL", completedAtUtc: new Date() },
    });

    const counts = await ops.getReviewQueueCounts({ teamId: org.workspaceId, meUserId: org.owner.userId });
    expect(counts.overdue).toBe(1);
    expect(counts.unassigned).toBe(1);
    const overdue = await engine.listReviewerOpsQueue({ teamId: org.workspaceId, meUserId: org.owner.userId, queue: "OVERDUE" });
    expect(overdue.rows.map((r) => r.workflowId)).toEqual([live.id]);
    const recent = await engine.listReviewerOpsQueue({ teamId: org.workspaceId, meUserId: org.owner.userId, queue: "COMPLETED_RECENTLY" });
    expect(recent.rows.map((r) => r.workflowId)).toEqual([finished.id]);
    // The stored status is kept as history on the finished row.
    expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: finished.id } })).slaStatus).toBe("BREACHED");
    // A finished review carries no live deadline on its badge.
    const projected = engine.buildWorkflowProjection(await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: finished.id } }));
    expect(projected.slaRollupState).toBe("COMPLETED");
  });

  it("WORKFLOW-013: the integrity queue shows integrity escalations, not SLA ones", async () => {
    const org = await seedOrganizationTenant(deps);
    const slaRow = await captureReview(org);
    const integrityRow = await captureReview(org);
    const { createEscalation } = await import("../src/services/reviewer-ops/escalation-engine.service.js");
    await createEscalation(
      { teamId: org.workspaceId, workflowId: slaRow.id, reason: "REVIEW_OVERDUE", safeSummary: "late", severity: "WARNING", evidenceId: slaRow.evidenceId },
      prisma as never,
    );
    await createEscalation(
      { teamId: org.workspaceId, workflowId: integrityRow.id, reason: "VERIFICATION_MISMATCH", safeSummary: "mismatch", severity: "WARNING", evidenceId: integrityRow.evidenceId },
      prisma as never,
    );
    const queue = await engine.listReviewerOpsQueue({ teamId: org.workspaceId, meUserId: org.owner.userId, queue: "INTEGRITY_RISK" });
    expect(queue.rows.map((r) => r.workflowId)).toEqual([integrityRow.id]);
  });

  it("WORKFLOW-014: the stuck detector sees never-assigned work on the real status", async () => {
    const org = await seedOrganizationTenant(deps);
    const row = await captureReview(org);
    await prisma.$executeRaw`UPDATE evidence_review_workflows SET created_at = now() - interval '3 days' WHERE id = ${row.id}::uuid`;
    const { detectStuckWorkflow, stuckStatusFromDbStatus } = await import("@proovra/shared");
    const fresh = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: row.id } });
    expect(String(fresh.status)).toBe("NOT_STARTED");
    const facts = {
      nowEpochMs: Date.now(),
      status: stuckStatusFromDbStatus(String(fresh.status)),
      submittedAtEpochMs: fresh.createdAt.getTime(),
      assignedAtEpochMs: null,
      firstOpenedAtEpochMs: null,
      lastReviewerTouchAtEpochMs: null,
      lastContributorResponseAtEpochMs: null,
      slaStatus: null,
      hasOpenEscalation: false,
      escalationAcknowledged: false,
      approvedButExportBlocked: false,
    };
    expect(detectStuckWorkflow(facts).reasons.map((r) => r.code)).toEqual(["submitted_never_assigned"]);
    // Negative control: the raw column never matched the rule.
    expect(detectStuckWorkflow({ ...facts, status: String(fresh.status) }).isStuck).toBe(false);
  });

  it("WORKFLOW-012: a row past the first batch is reached, and the read wraps", async () => {
    const org = await seedOrganizationTenant(deps);
    await setPolicy(org, { defaultCompletionDueHours: 100, defaultFirstResponseDueHours: 100, defaultAssignmentDueHours: 100, defaultEscalationDueHours: 100 });
    const rows = [await captureReview(org), await captureReview(org), await captureReview(org)];
    const ordered = [...rows].sort((a, b) => a.id.localeCompare(b.id));
    const last = ordered.at(-1)!;
    await prisma.evidenceReviewWorkflow.update({ where: { id: last.id }, data: { dueAt: new Date(Date.now() - HOUR) } });

    const page1 = await ops.reconcileReviewSlas({ teamId: org.workspaceId, batchSize: 2 }, prisma as never);
    expect(page1.scanned).toBe(2);
    expect(page1.flippedBreached).toBe(0);
    expect(page1.wrapped).toBe(false);
    // Stable rows do not hold the read at the head: the next call moves past them.
    const page2 = await ops.reconcileReviewSlas({ teamId: org.workspaceId, batchSize: 2 }, prisma as never);
    expect(page2.scanned).toBe(1);
    expect(page2.flippedBreached).toBe(1);
    expect(page2.wrapped).toBe(true);
    expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: last.id } })).slaStatus).toBe("BREACHED");
    const page3 = await ops.reconcileReviewSlas({ teamId: org.workspaceId, batchSize: 2 }, prisma as never);
    expect(page3.scanned).toBe(2);
  });

  it("WORKFLOW-012 (P11): the all-teams sweep reaches a workspace past the per-sweep limit", async () => {
    const secret = "reviewer-ops-test-cron-secret-0123";
    process.env.REVIEWER_OPS_CRON_SECRET = secret;
    const orgs = [await seedOrganizationTenant(deps), await seedOrganizationTenant(deps), await seedOrganizationTenant(deps)];
    for (const org of orgs) await captureReview(org);
    await prisma.workerSweepCursor.deleteMany({ where: { key: "reviewer_ops_reconcile_teams" } });
    const eligible = await prisma.team.count({ where: { evidenceReviewWorkflows: { some: {} } } });

    const seen = new Set<string>();
    for (let tick = 0; tick < eligible + 1; tick += 1) {
      const res = await h.app.inject({
        method: "POST",
        url: "/v1/reviewer-ops/reconcile",
        headers: { [REVIEWER_OPS_CRON_HEADER]: secret },
        payload: { allTeams: true, maxTeamsPerSweep: 1 },
      });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json() as { perTeam: Array<{ teamId: string }> };
      for (const t of body.perTeam) seen.add(t.teamId);
    }
    for (const org of orgs) expect(seen.has(org.workspaceId), org.workspaceId).toBe(true);
    expect(seen.size).toBe(eligible);
  });

  it("WORKFLOW-006: a personal record is not put on the clock by Capture", async () => {
    const personal = await seedPersonalTenant(deps, "PAYG");
    const evidence = await prisma.evidence.create({
      data: { ownerUserId: personal.owner.userId, teamId: personal.personalTeamId, organizationId: personal.personalOrganizationId, type: "PHOTO" },
      select: { id: true },
    });
    await workflowService.upsertEvidenceReviewerWorkflow({
      evidenceId: evidence.id,
      workspaceType: "PERSONAL",
      teamId: personal.personalTeamId,
      actorUserId: personal.owner.userId,
    });
    const row = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { evidenceId: evidence.id } });
    expect(row.dueAt).toBeNull();
    expect(row.slaStatus).toBeNull();
  });
});
