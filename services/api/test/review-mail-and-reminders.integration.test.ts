/**
 * WORKFLOW-010 / WORKFLOW-015 — a reminder reaches a person, and a member's email
 * choice governs operational mail. Real rows and the real send path, with the
 * recording email transport the point-5 suites use.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedOrganizationTenant, type FixtureDeps, type OrganizationTenant } from "./point7/product-fixtures.js";

describe("Review mail and reminders (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let notifications: typeof import("../src/services/review-operations/review-notifications.service.js");
  let reminders: typeof import("../src/services/reviewer-ops/reminder-engine.service.js");
  let org: OrganizationTenant;

  const setEmail = (type: string, enabled: boolean, frequency: string = "IMMEDIATE") =>
    prisma.workspaceNotificationPreference.upsert({
      where: {
        userId_teamId_preferenceType_channel: {
          userId: org.owner.userId,
          teamId: org.workspaceId,
          preferenceType: type,
          channel: "EMAIL",
        },
      } as never,
      create: { userId: org.owner.userId, teamId: org.workspaceId, preferenceType: type, channel: "EMAIL", enabled, frequency } as never,
      update: { enabled, frequency } as never,
    });

  async function review(data: Record<string, unknown> = {}) {
    const ev = await prisma.evidence.create({
      data: { ownerUserId: org.owner.userId, teamId: org.workspaceId, organizationId: org.organizationId, type: "PHOTO" },
      select: { id: true },
    });
    return prisma.evidenceReviewWorkflow.create({
      data: {
        evidenceId: ev.id,
        teamId: org.workspaceId,
        workspaceType: "TEAM",
        status: "ASSIGNED",
        assignedToUserId: org.owner.userId,
        assignedAtUtc: new Date(),
        ...data,
      } as never,
    });
  }

  const deliveries = (eventType: string) =>
    prisma.notificationDelivery.findMany({
      where: { teamId: org.workspaceId, eventType: eventType as never },
      orderBy: { createdAt: "desc" },
      select: { status: true, errorCode: true },
    });

  const reminder = (workflowId: string, kind = "DUE_SOON", data: Record<string, unknown> = {}) =>
    prisma.reviewerOpsReminder.create({
      data: {
        teamId: org.workspaceId,
        kind,
        dedupKey: randomUUID().replace(/-/g, "").slice(0, 40),
        dayBucket: new Date().toISOString().slice(0, 10),
        workflowId,
        reviewerUserId: org.owner.userId,
        safeSummary: "Review due soon.",
        ...data,
      } as never,
    });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    notifications = await import("../src/services/review-operations/review-notifications.service.js");
    reminders = await import("../src/services/reviewer-ops/reminder-engine.service.js");
    const { signJwt } = await import("../src/services/jwt.js");
    const deps: FixtureDeps = {
      prisma: prisma as never,
      tag: `mail-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authAt: Math.floor(Date.now() / 1000), authMethod: "PASSWORD" } as never,
          process.env.AUTH_JWT_SECRET!,
          3600,
        ),
    };
    org = await seedOrganizationTenant(deps);
  }, 180_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  beforeEach(async () => {
    process.env.NOTIFICATIONS_ENABLED = "true";
    await prisma.notificationDelivery.deleteMany({ where: { teamId: org.workspaceId } });
    await prisma.workspaceNotificationPreference.deleteMany({ where: { teamId: org.workspaceId } });
    await prisma.reviewerOpsReminder.deleteMany({ where: { teamId: org.workspaceId } });
  });

  it("WORKFLOW-015 (P13): a member who has email off is not mailed, and the log says why", async () => {
    const wf = await review();
    await setEmail("REVIEWER_ASSIGNMENT", false);
    await notifications.notifyReviewAssigned({ workflow: wf, actorUserId: org.owner.userId, isReassignment: false }, prisma as never);
    expect(await deliveries("REVIEW_REQUEST_ASSIGNED")).toEqual([{ status: "SKIPPED", errorCode: "recipient_preference_off" }]);
  });

  it("WORKFLOW-015: email is opt-in, as the panel says", async () => {
    const wf = await review();
    await notifications.notifyReviewAssigned({ workflow: wf, actorUserId: org.owner.userId, isReassignment: false }, prisma as never);
    expect((await deliveries("REVIEW_REQUEST_ASSIGNED"))[0]?.errorCode).toBe("recipient_preference_off");
  });

  it("WORKFLOW-015: a digest choice is not also sent at once", async () => {
    const wf = await review();
    await setEmail("ESCALATION", true, "DAILY");
    await notifications.notifyReviewEscalated({ workflow: wf, actorUserId: org.owner.userId }, prisma as never);
    expect((await deliveries("REVIEW_ESCALATED"))[0]?.errorCode).toBe("recipient_preference_digest");
  });

  it("WORKFLOW-015: immediate means immediate (positive control)", async () => {
    const wf = await review();
    await setEmail("REVIEWER_ASSIGNMENT", true);
    await notifications.notifyReviewAssigned({ workflow: wf, actorUserId: org.owner.userId, isReassignment: false }, prisma as never);
    const [row] = await deliveries("REVIEW_REQUEST_ASSIGNED");
    expect(row?.errorCode ?? "").not.toMatch(/recipient_preference/);
    expect(row?.status).not.toBe("SKIPPED");
  });

  it("WORKFLOW-010: a reminder is sent once and the row records it", async () => {
    await setEmail("SLA_NEAR_BREACH", true);
    const wf = await review();
    const row = await reminder(wf.id);
    const first = await reminders.deliverScheduledReminders({ teamId: org.workspaceId }, prisma as never);
    const second = await reminders.deliverScheduledReminders({ teamId: org.workspaceId }, prisma as never);
    expect(first.delivered + first.failed).toBe(1);
    expect(second).toEqual({ delivered: 0, suppressed: 0, failed: 0 });
    expect((await deliveries("REVIEW_DUE_SOON_REMINDER")).length).toBe(1);
    const after = await prisma.reviewerOpsReminder.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).not.toBe("SCHEDULED");
  });

  it("WORKFLOW-010: a member who has not opted in sends nothing, and the row closes", async () => {
    const wf = await review();
    const row = await reminder(wf.id, "REVIEWER_INACTIVE");
    const out = await reminders.deliverScheduledReminders({ teamId: org.workspaceId }, prisma as never);
    expect(out.suppressed).toBe(1);
    expect((await prisma.reviewerOpsReminder.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("SUPPRESSED");
  });

  it("WORKFLOW-010: a finished, paused or reassigned review is not chased, and a stale row is closed unsent", async () => {
    await setEmail("SLA_NEAR_BREACH", true);
    const finished = await review({ status: "APPROVED_INTERNAL" });
    const paused = await review({ slaPausedAtUtc: new Date(), pausedReason: "held" });
    const moved = await review();
    await prisma.evidenceReviewWorkflow.update({ where: { id: moved.id }, data: { assignedToUserId: null } });
    const live = await review();
    await reminder(finished.id);
    await reminder(paused.id);
    await reminder(moved.id);
    const stale = await reminder(live.id);
    await prisma.$executeRaw`UPDATE reviewer_ops_reminders SET created_at = now() - interval '3 days' WHERE id = ${stale.id}::uuid`;

    const out = await reminders.deliverScheduledReminders({ teamId: org.workspaceId }, prisma as never);
    expect(out).toEqual({ delivered: 0, suppressed: 4, failed: 0 });
    expect(await deliveries("REVIEW_DUE_SOON_REMINDER")).toEqual([]);
  });

  it("WORKFLOW-010: the reminders route lists the team's for someone who can reassign, and is closed to another tenant", async () => {
    const wf = await review();
    await reminder(wf.id);
    await prisma.user.update({ where: { id: org.owner.userId }, data: { currentWorkspaceId: org.workspaceId } });
    const ok = await h.app.inject({
      method: "GET",
      url: `/v1/reviewer-ops/reminders?teamId=${org.workspaceId}`,
      headers: { authorization: `Bearer ${org.owner.token}` },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((ok.json() as { reminders: unknown[] }).reminders.length).toBe(1);
    const outsider = await h.app.inject({
      method: "GET",
      url: `/v1/reviewer-ops/reminders?teamId=${randomUUID()}`,
      headers: { authorization: `Bearer ${org.owner.token}` },
    });
    expect(outsider.statusCode).toBe(404);
  });
});
