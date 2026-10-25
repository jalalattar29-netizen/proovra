/**
 * PHASE E — ATOMIC AUDIT, LIFECYCLE NOTICES, APPEND-ONLY HISTORY
 * (members audit AUD-01, AUD-03, AUD-04, AUD-06, SEC-13, DOM-06, DOM-12,
 * LIFE-05, LIFE-17, ENT-12).
 *
 * Every case drives real code against a real PostgreSQL. The email provider is
 * the ONE seam replaced (`resend-provider.js`), so a test can count what was
 * sent and nothing ever leaves this machine:
 *
 *   - a membership change and its audit row (with the transition in sealed
 *     columns and the request id) and its notice commit together, and a
 *     refused change leaves neither;
 *   - the notification outbox: a rolled-back transaction enqueues nothing, a
 *     committed one is delivered exactly once even with two sweepers racing;
 *   - closure engines record COMPLETED, the audit row (caused by the request)
 *     and the members' notices in the closure's own transaction;
 *   - account closure confirms to the address the account had;
 *   - member removal with a records transfer appends a custody event to each
 *     moved record;
 *   - team_activities, organization_audit_events and evidence_lifecycle_events
 *     refuse UPDATE and DELETE; a user who owns a workspace cannot be deleted;
 *   - the plan writer records from → to, on the webhook path too.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";

const sent = vi.hoisted(() => [] as Array<{ to: string; subject: string; deliveryId: string }>);
vi.mock("../src/services/notifications/resend-provider.js", () => ({
  sendViaResend: async (input: { to: string; subject: string; deliveryId: string }) => {
    sent.push({ to: input.to, subject: input.subject, deliveryId: input.deliveryId });
    return { ok: true, providerMessageId: `fake-${input.deliveryId}` };
  },
}));

describe("Phase E — atomic audit and lifecycle notices (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let stepUp: ReturnType<typeof createStepUpCeremony>;
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let rbac: typeof import("../src/services/identity/rbac.service.js");
  let notifications: typeof import("../src/services/notifications/index.js");
  let notice: typeof import("../src/services/notifications/membership-lifecycle-notice.js");
  let workspaceClosure: typeof import("../src/services/workspace/workspace-closure.service.js");
  let accountClosure: typeof import("../src/services/identity/account-closure.service.js");
  let billing: typeof import("../src/services/billing.service.js");
  const A = () => h.fixtures.teamA;
  const previousFlag = process.env.NOTIFICATIONS_ENABLED;

  beforeAll(async () => {
    process.env.NOTIFICATIONS_ENABLED = "true";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as import("@prisma/client").PrismaClient;
    ({ signJwt } = await import("../src/services/jwt.js"));
    rbac = await import("../src/services/identity/rbac.service.js");
    notifications = await import("../src/services/notifications/index.js");
    notice = await import("../src/services/notifications/membership-lifecycle-notice.js");
    workspaceClosure = await import("../src/services/workspace/workspace-closure.service.js");
    accountClosure = await import("../src/services/identity/account-closure.service.js");
    billing = await import("../src/services/billing.service.js");
    stepUp = createStepUpCeremony({
      prisma,
      inject: (o) => h.app.inject({ method: o.method, url: o.url, headers: o.headers, payload: o.payload as never }) as never,
    });
  }, 900_000);

  afterAll(async () => {
    if (previousFlag === undefined) delete process.env.NOTIFICATIONS_ENABLED;
    else process.env.NOTIFICATIONS_ENABLED = previousFlag;
    await h?.cleanup();
  }, 300_000);

  const tag = () => randomUUID().slice(0, 8);
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  async function person(teamId: string, role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER" | null) {
    const { REQUIRED_LEGAL_VERSIONS } = await import("../src/legal/legal-versioning.js");
    const email = `phase-e-${tag()}@test.proovra.local`;
    const user = await prisma.user.create({
      data: { email, displayName: "Phase E", provider: "EMAIL", providerUserId: email },
      select: { id: true },
    });
    await prisma.userLegalAcceptance.createMany({
      data: Object.entries(REQUIRED_LEGAL_VERSIONS).map(([policyKey, policyVersion]) => ({
        userId: user.id,
        policyKey,
        policyVersion: policyVersion as string,
        source: "integration-harness",
      })),
    });
    const token = signJwt(
      { sub: user.id, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
      process.env.AUTH_JWT_SECRET as string,
      3600,
    );
    const membership = role
      ? await prisma.teamMember.create({ data: { teamId, userId: user.id, role, status: "ACTIVE" } })
      : null;
    return { id: user.id, email, token, memberId: membership?.id ?? null };
  }

  /** An owned (non-personal, non-organization) workspace with its owner. */
  async function ownedWorkspace() {
    const owner = await person(A().teamId, null);
    const org = await prisma.organization.create({
      data: { name: `Phase E container ${tag()}`, billingOwnerUserId: owner.id, status: "ACTIVE", kind: "SYSTEM" } as never,
      select: { id: true },
    });
    const team = await prisma.team.create({
      data: {
        name: `Owned ${tag()}`,
        ownerUserId: owner.id,
        billingOwnerUserId: owner.id,
        isPersonal: false,
        organizationId: org.id,
        workspaceKind: "OWNED",
      } as never,
      select: { id: true },
    });
    await prisma.teamMember.create({ data: { teamId: team.id, userId: owner.id, role: "OWNER", status: "ACTIVE" } });
    return { teamId: team.id, owner };
  }

  const deliveriesTo = (email: string) =>
    prisma.notificationDelivery.findMany({ where: { recipient: email }, orderBy: { createdAt: "asc" } });

  // -------------------------------------------------------------------------
  // AUD-01 / AUD-03 / AUD-04 — one unit: the change, its audit, its notice.
  // -------------------------------------------------------------------------

  it("a revocation commits its audit (transition in sealed columns, request id) and its notice, which is sent once after commit", async () => {
    const m = await person(A().teamId, "MEMBER");
    const correlationId = `req-${tag()}`;
    await rbac.revokeMember({
      teamId: A().teamId,
      teamMemberId: m.memberId!,
      actorUserId: A().ownerUserId,
      reason: "phase-e",
      correlationId,
    });
    const audit = await prisma.adminAuditLog.findFirstOrThrow({
      where: { action: "identity.member.revoke", resourceId: m.memberId! },
    });
    expect(audit.previousState).toBe("ACTIVE");
    expect(audit.resultingState).toBe("REVOKED");
    expect(audit.requestId).toBe(correlationId);

    const rows = await deliveriesTo(m.email);
    expect(rows.map((r) => [r.eventType, r.status])).toEqual([["WORKSPACE_ACCESS_REMOVED", "SENT"]]);
    expect(sent.filter((s) => s.to === m.email)).toHaveLength(1);
    expect(rows[0]!.renderedPreview).toContain("was removed");
  });

  it("a refused change writes no audit row and sends nothing", async () => {
    const m = await person(A().teamId, "MEMBER");
    // An ADMIN cannot act on themselves: the transaction refuses and rolls back.
    const self = await prisma.teamMember.findFirstOrThrow({ where: { teamId: A().teamId, userId: A().adminUserId } });
    await expect(
      rbac.suspendMember({ teamId: A().teamId, teamMemberId: self.id, actorUserId: A().adminUserId }),
    ).rejects.toMatchObject({ code: "self_action_forbidden" });
    expect(await prisma.adminAuditLog.count({ where: { action: "identity.member.suspend", resourceId: self.id } })).toBe(0);
    expect(await prisma.notificationDelivery.count({ where: { recipientUserId: A().adminUserId, eventType: "WORKSPACE_ACCESS_SUSPENDED" } })).toBe(0);
    expect(await deliveriesTo(m.email)).toHaveLength(0);
  });

  it("a role change records MEMBER → VIEWER and tells the person their new role", async () => {
    const m = await person(A().teamId, "MEMBER");
    await rbac.changeMemberRole({ teamId: A().teamId, teamMemberId: m.memberId!, actorUserId: A().ownerUserId, newRole: "VIEWER" });
    const audit = await prisma.adminAuditLog.findFirstOrThrow({
      where: { action: "identity.member.role.change", resourceId: m.memberId! },
    });
    expect([audit.previousState, audit.resultingState]).toEqual(["MEMBER", "VIEWER"]);
    const rows = await deliveriesTo(m.email);
    expect(rows.map((r) => r.eventType)).toEqual(["WORKSPACE_ROLE_CHANGED"]);
    expect(rows[0]!.renderedPreview).toContain("is now Viewer");
  });

  it("suspend then restore: two notices, two audit transitions", async () => {
    const m = await person(A().teamId, "MEMBER");
    await rbac.suspendMember({ teamId: A().teamId, teamMemberId: m.memberId!, actorUserId: A().ownerUserId });
    await rbac.restoreMember({ teamId: A().teamId, teamMemberId: m.memberId!, actorUserId: A().ownerUserId });
    expect((await deliveriesTo(m.email)).map((r) => r.eventType)).toEqual([
      "WORKSPACE_ACCESS_SUSPENDED",
      "WORKSPACE_ACCESS_RESTORED",
    ]);
    const transitions = await prisma.adminAuditLog.findMany({
      where: { resourceId: m.memberId!, action: { in: ["identity.member.suspend", "identity.member.restore"] } },
      orderBy: { createdAt: "asc" },
      select: { previousState: true, resultingState: true },
    });
    expect(transitions).toEqual([
      { previousState: "ACTIVE", resultingState: "SUSPENDED" },
      { previousState: "SUSPENDED", resultingState: "ACTIVE" },
    ]);
  });

  // -------------------------------------------------------------------------
  // AUD-04 — the outbox itself.
  // -------------------------------------------------------------------------

  it("the outbox: a rolled-back transaction enqueues nothing; a committed notice is delivered once with two sweepers racing", async () => {
    const m = await person(A().teamId, "MEMBER");
    await expect(
      prisma.$transaction(async (tx) => {
        await notice.enqueueMembershipLifecycleNoticeTx(tx, {
          eventType: "WORKSPACE_ACCESS_REMOVED",
          teamId: A().teamId,
          recipientUserId: m.id,
          actorUserId: A().ownerUserId,
        });
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    expect(await deliveriesTo(m.email)).toHaveLength(0);

    const id = await prisma.$transaction((tx) =>
      notice.enqueueMembershipLifecycleNoticeTx(tx, {
        eventType: "WORKSPACE_ACCESS_REMOVED",
        teamId: A().teamId,
        recipientUserId: m.id,
        actorUserId: A().ownerUserId,
      }),
    );
    const queued = await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: id! } });
    expect(queued.status).toBe("RETRY_SCHEDULED");
    expect(queued.retryCount).toBe(0);
    expect(queued.templateContextJson).not.toBeNull();

    await Promise.all([
      notifications.processDueNotificationRetries({ batchSize: 500 }),
      notifications.processDueNotificationRetries({ batchSize: 500 }),
    ]);
    expect(sent.filter((s) => s.deliveryId === id)).toHaveLength(1);
    expect((await prisma.notificationDelivery.findUniqueOrThrow({ where: { id: id! } })).status).toBe("SENT");
  });

  // -------------------------------------------------------------------------
  // AUD-01 / AUD-03 / AUD-04 — closure engines.
  // -------------------------------------------------------------------------

  it("a workspace closure records COMPLETED and its audit (caused by the request) together, and tells each member but not the actor", async () => {
    const w = await ownedWorkspace();
    const m = await person(w.teamId, "MEMBER");
    const req = await prisma.workspaceClosureRequest.create({
      data: {
        teamId: w.teamId,
        requestedByUserId: w.owner.id,
        status: "SCHEDULED",
        coolingOffEndsAtUtc: new Date(Date.now() - 60_000),
      },
      select: { id: true },
    });
    await workspaceClosure.processWorkspaceClosures(new Date());
    const row = await prisma.workspaceClosureRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.status).toBe("COMPLETED");
    const audit = await prisma.adminAuditLog.findFirstOrThrow({
      where: { action: "identity.workspace_closure_completed", resourceId: req.id },
    });
    expect([audit.previousState, audit.resultingState]).toEqual(["PROCESSING", "COMPLETED"]);
    expect((audit.metadata as Record<string, unknown>).causationId).toBe(req.id);
    expect((await deliveriesTo(m.email)).map((r) => r.eventType)).toEqual(["WORKSPACE_CLOSED"]);
    expect(await deliveriesTo(w.owner.email)).toHaveLength(0);
  });

  it("account closure confirms to the address the account had, and records COMPLETED with its audit", async () => {
    const u = await person(A().teamId, null);
    const req = await prisma.accountClosureRequest.create({
      data: { userId: u.id, status: "SCHEDULED", coolingOffEndsAtUtc: new Date(Date.now() - 60_000) },
      select: { id: true },
    });
    await accountClosure.processAccountClosures(new Date());
    expect((await prisma.accountClosureRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("COMPLETED");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).email).toBeNull();
    const rows = await deliveriesTo(u.email);
    expect(rows.map((r) => [r.eventType, r.status])).toEqual([["ACCOUNT_CLOSED", "SENT"]]);
    const audit = await prisma.adminAuditLog.findFirstOrThrow({
      where: { action: "identity.account_closure_completed", resourceId: req.id },
    });
    expect(audit.resultingState).toBe("COMPLETED");
  });

  // -------------------------------------------------------------------------
  // LIFE-17 — the custody chain explains an ownership move.
  // -------------------------------------------------------------------------

  it("removing a member with a records transfer appends EVIDENCE_OWNERSHIP_TRANSFERRED to each moved record, in the removal", async () => {
    const leaver = await person(A().teamId, "MEMBER");
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    const evidence = await prisma.evidence.create({
      data: { title: `E ${tag()}`, type: "PHOTO", status: "CREATED", teamId: A().teamId, organizationId: team.organizationId, ownerUserId: leaver.id },
      select: { id: true },
    });
    const res = await h.app.inject({
      method: "DELETE",
      url: `/v1/teams/${A().teamId}/members/${leaver.memberId}`,
      headers: {
        ...bearer(A().ownerToken),
        ...(await stepUp.approvedHeader({
          token: A().ownerToken,
          userId: A().ownerUserId,
          teamId: A().teamId,
          purpose: "MEMBER_REVOKE",
          resourceKind: "team_member",
          resourceId: leaver.memberId!,
        })),
      },
      payload: { transferToUserId: A().ownerUserId },
    });
    expect(res.statusCode).toBeLessThan(300);
    expect((await prisma.evidence.findUniqueOrThrow({ where: { id: evidence.id } })).ownerUserId).toBe(A().ownerUserId);
    const custody = await prisma.custodyEvent.findMany({
      where: { evidenceId: evidence.id, eventType: "EVIDENCE_OWNERSHIP_TRANSFERRED" },
    });
    expect(custody).toHaveLength(1);
    expect(custody[0]!.payload).toMatchObject({ fromUserId: leaver.id, toUserId: A().ownerUserId, reason: "member_removed" });
    // The trail, the audit and the notice belong to the same removal.
    expect(await prisma.teamActivity.count({ where: { teamId: A().teamId, eventType: "ownership_transferred", targetId: leaver.id } })).toBe(1);
    const audit = await prisma.adminAuditLog.findFirstOrThrow({
      where: { action: "teams.member_delete", outcome: "success", workspaceId: A().teamId, requestId: res.headers["x-request-id"] as string },
    });
    expect(audit.resultingState).toBe("REVOKED");
    expect((await deliveriesTo(leaver.email)).map((r) => r.eventType)).toEqual(["WORKSPACE_ACCESS_REMOVED"]);
  });

  // -------------------------------------------------------------------------
  // DOM-12 / LIFE-05 / DOM-06 — history is append-only; owners are not deletable.
  // -------------------------------------------------------------------------

  it("team_activities, organization_audit_events and evidence_lifecycle_events refuse UPDATE and DELETE", async () => {
    const activity = await prisma.teamActivity.create({
      data: { teamId: A().teamId, eventType: "phase_e_probe", targetType: "team", actorUserId: A().ownerUserId },
      select: { id: true },
    });
    await expect(prisma.teamActivity.update({ where: { id: activity.id }, data: { eventType: "rewritten" } })).rejects.toThrow(/append-only/);
    await expect(prisma.teamActivity.delete({ where: { id: activity.id } })).rejects.toThrow(/append-only/);

    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    const orgEvent = await prisma.organizationAuditEvent.create({
      data: { organizationId: team.organizationId!, eventType: "ORG_CLOSURE_REQUESTED", targetType: "organization", targetId: team.organizationId! },
      select: { id: true },
    });
    await expect(prisma.organizationAuditEvent.update({ where: { id: orgEvent.id }, data: { targetType: "x" } })).rejects.toThrow(/append-only/);
    await expect(prisma.organizationAuditEvent.delete({ where: { id: orgEvent.id } })).rejects.toThrow(/append-only/);

    const ev = await prisma.evidence.create({
      data: { title: `E ${tag()}`, type: "PHOTO", status: "CREATED", teamId: A().teamId, organizationId: team.organizationId, ownerUserId: A().ownerUserId },
      select: { id: true },
    });
    const lifecycle = await prisma.evidenceLifecycleEvent.create({
      data: { teamId: A().teamId, evidenceId: ev.id, toState: "ACTIVE", eventType: "lifecycle_transition", summary: "phase-e probe" },
      select: { id: true },
    });
    await expect(prisma.evidenceLifecycleEvent.update({ where: { id: lifecycle.id }, data: { summary: "rewritten" } })).rejects.toThrow(/append-only/);
    await expect(prisma.evidenceLifecycleEvent.delete({ where: { id: lifecycle.id } })).rejects.toThrow(/append-only/);
    // A cascade from the parent is refused too: the record and its ledger stay.
    await expect(prisma.evidence.delete({ where: { id: ev.id } })).rejects.toThrow(/append-only/);
    expect(await prisma.evidenceLifecycleEvent.count({ where: { id: lifecycle.id } })).toBe(1);

    const trigger = await prisma.$queryRawUnsafe<Array<{ tgname: string }>>(
      `SELECT tgname FROM pg_trigger WHERE tgname IN ('team_activities_append_only','organization_audit_events_append_only','evidence_lifecycle_events_append_only') ORDER BY tgname`,
    );
    expect(trigger.map((t) => t.tgname)).toEqual([
      "evidence_lifecycle_events_append_only",
      "organization_audit_events_append_only",
      "team_activities_append_only",
    ]);
  });

  it("a user who owns a workspace cannot be deleted (the owner FK restricts; it never cascades a workspace away)", async () => {
    const w = await ownedWorkspace();
    await expect(prisma.$executeRawUnsafe(`DELETE FROM "users" WHERE "id" = '${w.owner.id}'`)).rejects.toThrow(/teams_owner_user_id_fkey|foreign key/);
    expect(await prisma.team.count({ where: { id: w.teamId } })).toBe(1);
    const rule = await prisma.$queryRawUnsafe<Array<{ confdeltype: string }>>(
      `SELECT confdeltype::text AS confdeltype FROM pg_constraint WHERE conname = 'teams_owner_user_id_fkey'`,
    );
    expect(rule[0]?.confdeltype).toBe("r");
  });

  // -------------------------------------------------------------------------
  // DOM-10 — one pending organization invitation per address.
  // -------------------------------------------------------------------------

  it("two concurrent organization invitations to one address produce exactly one pending invite", async () => {
    const { seedOrganizationTenant } = await import("./point7/product-fixtures.js");
    const deps = {
      prisma: prisma as never,
      tag: `phase-e-${tag()}`,
      mintToken: (userId: string, email: string) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          process.env.AUTH_JWT_SECRET as string,
          3600,
        ),
    };
    const org = await seedOrganizationTenant(deps, {});
    const email = `dup-${tag()}@invitee.test`;
    const invite = () =>
      h.app.inject({
        method: "POST",
        url: `/v1/orgs/${org.organizationId}/invites`,
        headers: bearer(org.owner.token),
        payload: { email, role: "ORG_MEMBER" },
      });
    const [a, b] = await Promise.all([invite(), invite()]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect(
      await prisma.organizationInvite.count({
        where: { organizationId: org.organizationId, email, acceptedAt: null, revokedAt: null },
      }),
    ).toBe(1);
  });

  // -------------------------------------------------------------------------
  // ENT-12 — the plan writer records from → to on every path.
  // -------------------------------------------------------------------------

  it("a provider-driven plan change records from → to; an unchanged plan records nothing", async () => {
    const u = await person(A().teamId, null);
    await billing.setPersonalPlan(u.id, "PRO", { serviceActor: "billing_provider_webhook", providerSubId: `sub_${tag()}` });
    await billing.setPersonalPlan(u.id, "TEAM", { serviceActor: "billing_provider_webhook", providerSubId: `sub_${tag()}` });
    await billing.setPersonalPlan(u.id, "TEAM", { serviceActor: "billing_provider_webhook" });
    const rows = await prisma.adminAuditLog.findMany({
      where: { action: "billing.entitlement_plan_changed", resourceId: u.id },
      orderBy: { createdAt: "asc" },
      select: { previousState: true, resultingState: true, metadata: true },
    });
    expect(rows.map((r) => [r.previousState, r.resultingState])).toEqual([
      ["FREE", "PRO"],
      ["PRO", "TEAM"],
    ]);
    expect((rows[0]!.metadata as Record<string, unknown>).serviceActor).toBe("billing_provider_webhook");
  });
});
