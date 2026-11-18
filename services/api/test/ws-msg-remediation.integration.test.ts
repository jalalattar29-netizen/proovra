/**
 * WS-MSG remediation (RG-24 outbound messages, RG-25 bearer material, RG-30
 * intake state) — behavioural regressions on live PostgreSQL 16 through the
 * real route registration and services.
 *
 * The email provider transport (`resend-provider.js`) is the ONE seam
 * replaced: nothing leaves this machine and each test can read exactly what
 * would have been sent.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const sent = vi.hoisted(() => [] as Array<{ to: string; subject: string; text: string; html: string; deliveryId: string }>);
vi.mock("../src/services/notifications/resend-provider.js", () => ({
  sendViaResend: async (input: { to: string; subject: string; text: string; html: string; deliveryId: string }) => {
    sent.push({ to: input.to, subject: input.subject, text: input.text, html: input.html, deliveryId: input.deliveryId });
    return { ok: true, providerMessageId: `fake-${input.deliveryId}` };
  },
}));

describe("WS-MSG remediation (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let svc: typeof import("../src/services/evidence-request.service.js");
  const saved: Record<string, string | undefined> = {};
  const ENV = {
    WORKFLOW_INTAKE_LINKS_ENABLED: "true",
    EVIDENCE_REQUESTS_ENABLED: "true",
    NOTIFICATIONS_ENABLED: "true",
    WORKFLOW_INTAKE_TOKEN_SECRET: "ws-msg-throwaway-intake-hmac-0123456789abcdef",
  } as const;

  beforeAll(async () => {
    for (const [k, v] of Object.entries(ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as import("@prisma/client").PrismaClient;
    svc = await import("../src/services/evidence-request.service.js");
    await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } as never });
  }, 900_000);

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await h?.cleanup();
  }, 300_000);

  const A = () => h.fixtures.teamA;
  const owner = () => ({ authorization: `Bearer ${A().ownerToken}` });

  async function sentExternalRequest(recipientEmail: string) {
    const created = await svc.createEvidenceRequest(
      { teamId: A().teamId, requestType: "ADDITIONAL_EVIDENCE", title: `ws-msg ${randomUUID().slice(0, 6)}`, recipientMode: "EXTERNAL_CONTRIBUTOR", recipientEmail, createIntakeLink: false } as never,
      { actorUserId: A().ownerUserId },
    );
    const id = (created as unknown as { request: { id: string } }).request.id;
    const out = await svc.sendEvidenceRequest({ id, teamId: A().teamId, actorUserId: A().ownerUserId });
    return { id, rawToken: out.rawToken };
  }

  describe("PRO-I1-01 / R1-F-01 — request-level needs-more-info", () => {
    it("never emails the workspace-internal reviewer note; the explicit contributor message is what is sent", async () => {
      const email = `ws-msg-${randomUUID().slice(0, 8)}@example.test`;
      const { id } = await sentExternalRequest(email);
      await prisma.evidenceRequest.update({ where: { id }, data: { status: "RESPONSE_RECEIVED" } as never });
      sent.length = 0;
      const res = await h.app.inject({
        method: "POST",
        url: `/v1/evidence-requests/${id}/needs-more-info`,
        headers: owner(),
        payload: { reviewerNote: "INTERNAL-ONLY difficult client, check claim history", contributorMessage: "Please add a photo of the rear plate." },
      });
      expect(res.statusCode, res.body).toBe(200);
      const mail = sent.filter((m) => m.to === email);
      expect(mail).toHaveLength(1);
      expect(mail[0]!.text).not.toContain("INTERNAL-ONLY");
      expect(mail[0]!.html).not.toContain("INTERNAL-ONLY");
      expect(mail[0]!.text).toContain("Please add a photo of the rear plate.");
      // The stored copy of the message (delivery log / template context) carries no note either.
      const rows = await prisma.notificationDelivery.findMany({ where: { evidenceRequestId: id, eventType: "EVIDENCE_REQUEST_NEEDS_MORE_INFO" } as never });
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0])).not.toContain("INTERNAL-ONLY");
      // The note is kept inside the workspace.
      const row = await prisma.evidenceRequest.findUniqueOrThrow({ where: { id }, select: { reviewerNote: true, status: true } });
      expect(row).toEqual({ reviewerNote: "INTERNAL-ONLY difficult client, check claim history", status: "NEEDS_MORE_INFO" });
    });

    it("an empty note is accepted (the UI calls it optional) and the contributor gets the neutral sentence", async () => {
      const email = `ws-msg-${randomUUID().slice(0, 8)}@example.test`;
      const { id } = await sentExternalRequest(email);
      await prisma.evidenceRequest.update({ where: { id }, data: { status: "UNDER_REVIEW" } as never });
      sent.length = 0;
      const res = await h.app.inject({ method: "POST", url: `/v1/evidence-requests/${id}/needs-more-info`, headers: owner(), payload: {} });
      expect(res.statusCode, res.body).toBe(200);
      const mail = sent.filter((m) => m.to === email);
      expect(mail).toHaveLength(1);
      expect(mail[0]!.text).toContain(svc.NEEDS_MORE_INFO_NEUTRAL_MESSAGE);
    });

    it("two concurrent marks produce one transition and one email", async () => {
      const email = `ws-msg-${randomUUID().slice(0, 8)}@example.test`;
      const { id } = await sentExternalRequest(email);
      await prisma.evidenceRequest.update({ where: { id }, data: { status: "RESPONSE_RECEIVED" } as never });
      sent.length = 0;
      const [a, b] = await Promise.all([
        h.app.inject({ method: "POST", url: `/v1/evidence-requests/${id}/needs-more-info`, headers: owner(), payload: { reviewerNote: "one" } }),
        h.app.inject({ method: "POST", url: `/v1/evidence-requests/${id}/needs-more-info`, headers: owner(), payload: { reviewerNote: "two" } }),
      ]);
      expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
      expect(sent.filter((m) => m.to === email)).toHaveLength(1);
      expect(await prisma.evidenceRequestEvent.count({ where: { evidenceRequestId: id, eventType: "EVIDENCE_REQUEST_NEEDS_MORE_INFO" } })).toBe(1);
    });
  });
});
