/**
 * THIRD RE-AUDIT B-N2 — the audit trail records whether an invitation email
 * went out (live PostgreSQL, real routes).
 *
 * AUD-01 moved the `teams.invite_create` / `teams.invite_resend` rows into the
 * invitation's transaction, which is written before delivery — so `emailSent`
 * vanished from every audit row. The fix keeps the decision row in the
 * transaction and writes a `teams.invite_delivery` row after the send:
 *
 *   - create, repeat invite (same role) and explicit resend each leave one
 *     delivery row for that invitation, with `emailSent` and the trigger;
 *   - an undelivered email (provider throws) is `emailSent:false`, outcome
 *     error; a delivered one is `emailSent:true`, outcome success (control);
 *   - the decision row is still written (AUD-01 unchanged).
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Prisma = import("@prisma/client").PrismaClient;

describe("B-N2 — invitation delivery is in the audit trail (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let emailModule: typeof import("../src/services/email.service.js");
  const A = () => h.fixtures.teamA;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as Prisma;
    emailModule = await import("../src/services/email.service.js");
    await prisma.team.updateMany({ where: { id: A().teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
  }, 900_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const invitee = () => `bn2-inv-${randomUUID().slice(0, 8)}@invitee.test`;

  const invite = (email: string, role = "MEMBER") =>
    h.app.inject({
      method: "POST",
      url: `/v1/teams/${A().teamId}/invites`,
      headers: bearer(A().ownerToken),
      payload: { email, role },
    });

  const resend = (inviteId: string) =>
    h.app.inject({
      method: "POST",
      url: `/v1/teams/${A().teamId}/invites/${inviteId}/resend`,
      headers: bearer(A().ownerToken),
      payload: {},
    });

  async function deliveryRows(inviteId: string) {
    const rows = await prisma.adminAuditLog.findMany({
      where: { action: "teams.invite_delivery", resourceId: A().teamId },
      orderBy: { createdAt: "asc" },
      select: { outcome: true, metadata: true, workspaceId: true },
    });
    return rows.filter((r) => (r.metadata as { inviteId?: string } | null)?.inviteId === inviteId);
  }

  function mockDelivery(ok: boolean) {
    const service = emailModule.getEmailService();
    vi.spyOn(service, "isConfigured").mockReturnValue(true);
    const send = vi.spyOn(service, "sendTeamInvitation");
    if (ok) send.mockResolvedValue(undefined as never);
    else send.mockRejectedValue(new Error("provider down"));
    return send;
  }

  it("create: an undelivered email is audited emailSent:false; a delivered one emailSent:true", async () => {
    const send = mockDelivery(false);
    const failedEmail = invitee();
    const failed = await invite(failedEmail);
    expect(failed.statusCode, failed.body).toBe(201);
    expect(failed.json()).toMatchObject({ emailSent: false });
    expect(send).toHaveBeenCalledTimes(1);
    const failedId = (failed.json() as { invite: { id: string } }).invite.id;

    const failedRows = await deliveryRows(failedId);
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0].outcome).toBe("error");
    expect(failedRows[0].workspaceId).toBe(A().teamId);
    expect(failedRows[0].metadata).toMatchObject({ inviteId: failedId, emailSent: false, trigger: "create" });

    // AUD-01 unchanged: the decision row for the same invitation exists.
    const decision = await prisma.adminAuditLog.findMany({
      where: { action: "teams.invite_create", resourceId: A().teamId, outcome: "success" },
      select: { metadata: true },
    });
    expect(decision.some((r) => (r.metadata as { inviteId?: string }).inviteId === failedId)).toBe(true);

    // Control: delivered.
    send.mockResolvedValue(undefined as never);
    const ok = await invite(invitee());
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ emailSent: true });
    const okId = (ok.json() as { invite: { id: string } }).invite.id;
    const okRows = await deliveryRows(okId);
    expect(okRows).toHaveLength(1);
    expect(okRows[0].outcome).toBe("success");
    expect(okRows[0].metadata).toMatchObject({ inviteId: okId, emailSent: true, trigger: "create" });
  });

  it("repeat invite and explicit resend each record their own delivery outcome", async () => {
    const send = mockDelivery(true);
    const email = invitee();
    const first = await invite(email);
    expect(first.statusCode, first.body).toBe(201);
    const inviteId = (first.json() as { invite: { id: string } }).invite.id;

    // Same role again = a resend through the create route; this one fails.
    send.mockRejectedValue(new Error("provider down"));
    const again = await invite(email);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ existing: true, emailSent: false });

    // Explicit resend, delivered.
    send.mockResolvedValue(undefined as never);
    const r = await resend(inviteId);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ emailSent: true });

    const rows = await deliveryRows(inviteId);
    expect(rows.map((x) => [x.outcome, (x.metadata as { trigger: string }).trigger, (x.metadata as { emailSent: boolean }).emailSent])).toEqual([
      ["success", "create", true],
      ["error", "repeat_invite", false],
      ["success", "resend", true],
    ]);
    // The decision rows are still there (two resends: repeat + explicit).
    const resendDecisions = await prisma.adminAuditLog.findMany({
      where: { action: "teams.invite_resend", resourceId: A().teamId, outcome: "success" },
      select: { metadata: true },
    });
    expect(resendDecisions.filter((d) => (d.metadata as { inviteId?: string }).inviteId === inviteId)).toHaveLength(2);
  });
});
