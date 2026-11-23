/**
 * ESCALATION / REMINDER EMAIL TRUTH (2026-11-23) — which review automation
 * actually mails a person, proven with persisted rows (ReviewEscalation,
 * ReviewerOpsReminder, NotificationDelivery) and the real send path.
 *
 * Companion doc: docs/architecture/review-escalation-notifications.md
 *
 *   (a) reconcile on a TEAM workspace with an overdue review opens an AUTOMATIC
 *       escalation and sends NO REVIEW_ESCALATED email; the only mail is the
 *       REVIEW_OVERDUE_REMINDER the SLA flip sends to the assignee.
 *   (b) a person's Escalate mails REVIEW_ESCALATED to the review's ASSIGNEE
 *       (not to the owners/admins the escalation is routed to).
 *   (c) the reconcile reminder sweep delivers on an entitled (TEAM) workspace
 *       and does nothing on a PRO workspace (reconcile is entitlement-gated) —
 *       and the separate cron SLA sweep (`reconcileReviewSlas`, route
 *       POST /v1/review-operations/reconcile-slas) is gated the same way
 *       (D-ESC-1, fixed 2026-11-23): a PRO workspace is neither flipped to
 *       BREACHED nor mailed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedPersonalTenant, seedUser, type FixtureDeps, type PersonalTenant } from "./point7/product-fixtures.js";

describe("Review escalation and reminder email truth (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let engine: typeof import("../src/services/reviewer-ops/reviewer-operations-engine.service.js");
  let reviewOps: typeof import("../src/services/review-operations/review-operations.service.js");
  let deps: FixtureDeps;
  let team: PersonalTenant;
  let pro: PersonalTenant;

  const optIn = (userId: string, teamId: string, type: string) =>
    prisma.workspaceNotificationPreference.upsert({
      where: { userId_teamId_preferenceType_channel: { userId, teamId, preferenceType: type, channel: "EMAIL" } } as never,
      create: { userId, teamId, preferenceType: type, channel: "EMAIL", enabled: true, frequency: "IMMEDIATE" } as never,
      update: { enabled: true, frequency: "IMMEDIATE" } as never,
    });

  async function review(teamId: string, assigneeUserId: string, ownerUserId: string, data: Record<string, unknown> = {}) {
    const t = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    const ev = await prisma.evidence.create({
      data: { ownerUserId, teamId, organizationId: t.organizationId, type: "PHOTO" },
      select: { id: true },
    });
    return prisma.evidenceReviewWorkflow.create({
      data: {
        evidenceId: ev.id,
        teamId,
        workspaceType: "TEAM",
        status: "ASSIGNED",
        assignedToUserId: assigneeUserId,
        assignedAtUtc: new Date(Date.now() - 96 * 3600_000),
        ...data,
      } as never,
    });
  }

  const overdue = () => {
    const past = new Date(Date.now() - 24 * 3600_000);
    return { dueAt: past, completionDueAtUtc: past, firstResponseDueAtUtc: past };
  };

  const deliveries = (teamId: string, eventType: string) =>
    prisma.notificationDelivery.findMany({
      where: { teamId, eventType: eventType as never },
      select: { status: true, errorCode: true, recipientUserId: true, evidenceId: true },
    });

  /** The SLA-flip and Escalate mails are fire-and-forget after the write: poll for the row. */
  async function settle(teamId: string, eventType: string, want: number) {
    let rows = await deliveries(teamId, eventType);
    for (let i = 0; i < 50 && rows.length < want; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      rows = await deliveries(teamId, eventType);
    }
    return rows;
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    engine = await import("../src/services/reviewer-ops/reviewer-operations-engine.service.js");
    reviewOps = await import("../src/services/review-operations/review-operations.service.js");
    const { signJwt } = await import("../src/services/jwt.js");
    deps = {
      prisma: prisma as never,
      tag: `esc-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authAt: Math.floor(Date.now() / 1000), authMethod: "PASSWORD" } as never,
          process.env.AUTH_JWT_SECRET!,
          3600,
        ),
    };
    team = await seedPersonalTenant(deps, "TEAM");
    pro = await seedPersonalTenant(deps, "PRO");
  }, 180_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  beforeEach(async () => {
    process.env.NOTIFICATIONS_ENABLED = "true";
    for (const t of [team.personalTeamId, pro.personalTeamId]) {
      await prisma.notificationDelivery.deleteMany({ where: { teamId: t } });
      await prisma.reviewerOpsReminder.deleteMany({ where: { teamId: t } });
    }
  });

  it("(a) reconcile on a TEAM workspace: automatic escalation persisted, NO REVIEW_ESCALATED email; the SLA flip mails REVIEW_OVERDUE_REMINDER to the assignee", async () => {
    const teamId = team.personalTeamId;
    const owner = team.owner.userId;
    await optIn(owner, teamId, "ESCALATION");
    await optIn(owner, teamId, "SLA_NEAR_BREACH");
    const wf = await review(teamId, owner, owner, overdue());

    const result = await engine.runReconcile({ teamId }, prisma as never);
    expect(result.skippedReason).toBeUndefined();

    const escalations = await prisma.reviewEscalation.findMany({ where: { teamId, workflowId: wf.id } });
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({ reason: "REVIEW_OVERDUE", status: "OPEN", createdByUserId: null });
    const after = await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: wf.id } });
    expect(after.slaStatus).toBe("BREACHED");
    expect(after.activeEscalationId).toBe(escalations[0]!.id);

    // The escalation itself mails nobody, even though the assignee opted in.
    expect(await deliveries(teamId, "REVIEW_ESCALATED")).toEqual([]);
    // The SLA flip (reconcileReviewSlas inside reconcile) mails the assignee once.
    const overdueMail = await settle(teamId, "REVIEW_OVERDUE_REMINDER", 1);
    expect(overdueMail).toHaveLength(1);
    expect(overdueMail[0]).toMatchObject({ recipientUserId: owner, evidenceId: wf.evidenceId });
    expect(overdueMail[0]!.status).not.toBe("SKIPPED");

    // A second pass neither re-escalates nor re-mails.
    await engine.runReconcile({ teamId }, prisma as never);
    await new Promise((r) => setTimeout(r, 300));
    expect(await prisma.reviewEscalation.count({ where: { teamId, workflowId: wf.id } })).toBe(1);
    expect(await deliveries(teamId, "REVIEW_OVERDUE_REMINDER")).toHaveLength(1);
  });

  it("(b) a person's Escalate mails REVIEW_ESCALATED to the review's assignee, not to the owner the escalation is routed to", async () => {
    const teamId = team.personalTeamId;
    const owner = team.owner.userId;
    const member = await seedUser(deps, "member");
    await prisma.teamMember.create({ data: { teamId, userId: member.userId, role: "MEMBER", status: "ACTIVE" } as never });
    await optIn(member.userId, teamId, "ESCALATION");
    await optIn(owner, teamId, "ESCALATION");
    const wf = await review(teamId, member.userId, owner, { status: "IN_REVIEW" });

    await reviewOps.recordLifecycleTransition(
      { evidenceId: wf.evidenceId, decision: "ESCALATE", actorUserId: owner, escalationReason: "Needs a second look" } as never,
      prisma as never,
    );

    const esc = await prisma.reviewEscalation.findFirstOrThrow({ where: { teamId, workflowId: wf.id } });
    expect(esc).toMatchObject({ reason: "REVIEWER_ESCALATED", createdByUserId: owner, assignedToUserId: null });
    const mail = (await settle(teamId, "REVIEW_ESCALATED", 1)).filter((d) => d.evidenceId === wf.evidenceId);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.recipientUserId).toBe(member.userId);
    expect(mail[0]!.status).not.toBe("SKIPPED");
  });

  it("(c) reconcile reminders: delivered on TEAM, nothing on PRO (reconcile is gated); the cron SLA sweep is gated too (D-ESC-1)", async () => {
    const reminder = (teamId: string, workflowId: string, reviewerUserId: string) =>
      prisma.reviewerOpsReminder.create({
        data: {
          teamId,
          kind: "DUE_SOON",
          dedupKey: `${workflowId.replace(/-/g, "").slice(0, 32)}ds`,
          dayBucket: new Date().toISOString().slice(0, 10),
          workflowId,
          reviewerUserId,
          safeSummary: "Review due soon.",
        } as never,
      });

    // Entitled: a scheduled reminder reaches the person.
    const tId = team.personalTeamId;
    await optIn(team.owner.userId, tId, "SLA_NEAR_BREACH");
    const tWf = await review(tId, team.owner.userId, team.owner.userId, { assignedAtUtc: new Date() });
    const tRow = await reminder(tId, tWf.id, team.owner.userId);
    await engine.runReconcile({ teamId: tId }, prisma as never);
    expect((await prisma.reviewerOpsReminder.findUniqueOrThrow({ where: { id: tRow.id } })).status).not.toBe("SCHEDULED");
    expect((await deliveries(tId, "REVIEW_DUE_SOON_REMINDER")).length).toBe(1);

    // PRO (not entitled to reviewer operations): reconcile does nothing at all.
    const pId = pro.personalTeamId;
    await optIn(pro.owner.userId, pId, "SLA_NEAR_BREACH");
    const pWf = await review(pId, pro.owner.userId, pro.owner.userId, overdue());
    const pRow = await reminder(pId, pWf.id, pro.owner.userId);
    const skipped = await engine.runReconcile({ teamId: pId }, prisma as never);
    expect(skipped.skippedReason).toBe("reviewer_operations_not_included");
    expect((await prisma.reviewerOpsReminder.findUniqueOrThrow({ where: { id: pRow.id } })).status).toBe("SCHEDULED");
    expect(await prisma.reviewEscalation.count({ where: { teamId: pId } })).toBe(0);
    expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: pWf.id } })).slaStatus).not.toBe("BREACHED");
    expect(await prisma.notificationDelivery.count({ where: { teamId: pId } })).toBe(0);

    // D-ESC-1 (fixed) — the cron SLA sweep the worker calls every 15 minutes
    // (POST /v1/review-operations/reconcile-slas → reconcileReviewSlas, no
    // teamId = every workspace) skips a workspace without reviewer-operations
    // entitlement: the PRO review is left untouched and nobody is mailed.
    const summary = await reviewOps.reconcileReviewSlas({ teamId: pId }, prisma as never);
    expect(summary.breachedWorkflowIds).not.toContain(pWf.id);
    expect(summary.skippedNotEntitled).toBeGreaterThanOrEqual(1);
    expect((await prisma.evidenceReviewWorkflow.findUniqueOrThrow({ where: { id: pWf.id } })).slaStatus).not.toBe("BREACHED");
    expect(await prisma.notificationDelivery.count({ where: { teamId: pId } })).toBe(0);
    expect(await prisma.reviewEscalation.count({ where: { teamId: pId } })).toBe(0);
    // The same sweep still serves an entitled workspace (TEAM): an overdue
    // review there is flipped and its assignee mailed once.
    const tOver = await review(tId, team.owner.userId, team.owner.userId, overdue());
    const tSummary = await reviewOps.reconcileReviewSlas({ teamId: tId }, prisma as never);
    expect(tSummary.breachedWorkflowIds).toContain(tOver.id);
  });
});
