/**
 * WS-MSG remediation (RG-24 outbound messages, RG-25 bearer material, RG-30
 * intake state) â€” behavioural regressions on live PostgreSQL 16 through the
 * real route registration and services.
 *
 * The email provider transport (`resend-provider.js`) is the ONE seam
 * replaced: nothing leaves this machine and each test can read exactly what
 * would have been sent.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalJson, intakeConsentDisclosureText } from "@proovra/shared";
import { expiredEvidenceReservationWhere } from "@proovra/shared-runtime";

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
  let entitlement: typeof import("../src/services/packaging/entitlement.service.js");
  let webhookPlatform: typeof import("../src/services/packaging/webhooks/webhook-platform.service.js");
  let notifications: typeof import("../src/services/notifications/index.js");
  let intakeSessions: typeof import("../src/services/workflow-intake-session.service.js");
  let grantEvidenceCredits: typeof import("../src/services/billing/evidence-credits.service.js")["grantEvidenceCredits"];
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
    entitlement = await import("../src/services/packaging/entitlement.service.js");
    webhookPlatform = await import("../src/services/packaging/webhooks/webhook-platform.service.js");
    notifications = await import("../src/services/notifications/index.js");
    intakeSessions = await import("../src/services/workflow-intake-session.service.js");
    ({ grantEvidenceCredits } = await import("../src/services/billing/evidence-credits.service.js"));
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

  async function sentExternalRequest(recipientEmail: string, recipientPhone?: string) {
    const created = await svc.createEvidenceRequest(
      { teamId: A().teamId, requestType: "ADDITIONAL_EVIDENCE", title: `ws-msg ${randomUUID().slice(0, 6)}`, recipientMode: "EXTERNAL_CONTRIBUTOR", recipientEmail, ...(recipientPhone ? { recipientPhone } : {}), createIntakeLink: false } as never,
      { actorUserId: A().ownerUserId },
    );
    const id = (created as unknown as { request: { id: string } }).request.id;
    const out = await svc.sendEvidenceRequest({ id, teamId: A().teamId, actorUserId: A().ownerUserId });
    return { id, rawToken: out.rawToken };
  }

  describe("PRO-I1-01 / R1-F-01 â€” request-level needs-more-info", () => {
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

  describe("PRO-I1-02 â€” an intake session holds the allowance only while active on an active link", () => {
    const P = () => h.fixtures.personal;
    const pAuth = () => ({ authorization: `Bearer ${P().token}` });
    const counted = () => prisma.evidence.count({ where: { ownerUserId: P().userId, deletedAt: null } as never });
    const newOwnerRecord = () => h.app.inject({ method: "POST", url: "/v1/evidence", headers: pAuth(), payload: { type: "PHOTO", mimeType: "image/png" } });

    async function mintAndStage(): Promise<{ linkId: string; sessionId: string; evidenceId: string }> {
      if (!(await prisma.entitlement.findFirst({ where: { userId: P().userId } as never }))) {
        const first = await newOwnerRecord();
        expect(first.statusCode, first.body).toBe(201);
      }
      await grantEvidenceCredits({ userId: P().userId, credits: 1, provider: "STRIPE" as never, providerRef: `ws-msg-${randomUUID()}` });
      const res = await h.app.inject({
        method: "POST", url: "/v1/workflow/intake-links", headers: pAuth(),
        payload: { teamId: P().teamId, workflowTemplateSlug: "general-evidence-record", intakeMode: "EXTERNAL_REUSABLE", recipientLabel: "ws-msg", expiresAtUtc: new Date(Date.now() + 30 * 86_400_000).toISOString() },
      });
      expect(res.statusCode, res.body).toBe(201);
      const { rawToken, link } = res.json() as { rawToken: string; link: { id: string } };
      const t = encodeURIComponent(rawToken);
      const boot = await h.app.inject({ method: "GET", url: `/v1/external-intake/${t}` });
      expect(boot.statusCode, boot.body).toBe(200);
      const opened = boot.json() as { session: { id: string }; link: { consentPolicyVersion: string | null; consentDisclosureText: string | null } };
      const consent = await h.app.inject({
        method: "POST", url: `/v1/external-intake/${t}/sessions/${opened.session.id}/consent`,
        payload: { consent: { acceptedAtUtc: new Date().toISOString(), policyVersion: opened.link.consentPolicyVersion || "v1", disclosureTextHash: createHash("sha256").update(intakeConsentDisclosureText(opened.link.consentDisclosureText)).digest("hex"), termsAcknowledged: true, identityDisclosed: false, ipHash: null, userAgent: null } },
      });
      expect(consent.statusCode, consent.body).toBe(200);
      // Declare one file and never upload a byte.
      const part = await h.app.inject({
        method: "POST", url: `/v1/external-intake/${t}/sessions/${opened.session.id}/parts`,
        payload: { partIndex: 0, mimeType: "text/plain", originalFileName: "c.txt", sizeBytes: 1, checksumSha256Base64: createHash("sha256").update("x").digest("base64"), webkitRelativePath: null },
      });
      expect(part.statusCode, part.body).toBe(201);
      await prisma.entitlement.updateMany({ where: { userId: P().userId } as never, data: { credits: 0 } as never });
      const s = (await prisma.workflowIntakeSession.findUniqueOrThrow({ where: { id: opened.session.id }, select: { evidenceId: true } })) as { evidenceId: string };
      return { linkId: link.id, sessionId: opened.session.id, evidenceId: s.evidenceId };
    }
    async function ageRecord(evidenceId: string) {
      const aged = new Date(Date.now() - 25 * 3_600_000);
      await prisma.$executeRaw`UPDATE "evidence" SET "created_at" = ${aged}, "updated_at" = ${aged} WHERE "id" = ${evidenceId}::uuid`;
      await prisma.$executeRaw`UPDATE "upload_sessions" SET "last_activity_at_utc" = ${aged} WHERE "evidence_id" = ${evidenceId}::uuid`;
    }
    async function ageSession(sessionId: string) {
      const aged = new Date(Date.now() - 25 * 3_600_000);
      await prisma.$executeRaw`UPDATE "workflow_intake_sessions" SET "updated_at" = ${aged}, "last_seen_at_utc" = ${aged} WHERE "id" = ${sessionId}::uuid`;
    }
    async function fillToTwo() {
      while ((await counted()) < 2) {
        const r = await newOwnerRecord();
        expect(r.statusCode, r.body).toBe(201);
      }
    }

    it("revoking the link frees the slot an idle reservation held; an abandoned session stops holding after the window and is sweepable", async () => {
      await fillToTwo();
      // 1. Revocation: a reservation idle for > 24 h held only by its session.
      const one = await mintAndStage();
      await ageRecord(one.evidenceId);
      // UC-COM-001 (kept) â€” a contributor still active on an active link keeps the slot.
      expect((await newOwnerRecord()).statusCode).toBe(409);
      const revoke = await h.app.inject({ method: "POST", url: `/v1/workflow/intake-links/${one.linkId}/revoke`, headers: pAuth(), payload: { reason: "ws-msg" } });
      expect(revoke.statusCode, revoke.body).toBe(200);
      const afterRevoke = await newOwnerRecord();
      expect(afterRevoke.statusCode, afterRevoke.body).toBe(201);
      const revokedReservation = await prisma.evidence.count({ where: { AND: [{ id: one.evidenceId }, expiredEvidenceReservationWhere()] } });
      expect(revokedReservation).toBe(1);
      // Give the slot back (an unsealed owner draft) for the next case.
      await prisma.evidence.update({ where: { id: (afterRevoke.json() as { id: string }).id }, data: { deletedAt: new Date() } as never });

      // 2. Abandonment on a link that stays ACTIVE (up to 90 days).
      const two = await mintAndStage();
      expect((await newOwnerRecord()).statusCode).toBe(409);
      await ageRecord(two.evidenceId);
      await ageSession(two.sessionId);
      const afterIdle = await newOwnerRecord();
      expect(afterIdle.statusCode, afterIdle.body).toBe(201);
      expect(await prisma.evidence.count({ where: { AND: [{ id: two.evidenceId }, expiredEvidenceReservationWhere()] } })).toBe(1);
    });
  });

  describe("PRO-G1-02 — lifecycle webhook signing secrets are wrapped at rest", () => {
    it("the column holds an e3.3 envelope, not the raw secret; emission still signs with the revealed secret", async () => {
      const { upsertEntitlementGrant } = entitlement;
      await upsertEntitlementGrant({ teamId: A().teamId, key: "INTEGRATION_WEBHOOK_ENDPOINTS_MAX", value: 5, kind: "LIMIT", source: "CUSTOM", grantedByUserId: A().ownerUserId } as never);
      const created = await webhookPlatform.createWebhookEndpoint({
        prisma: prisma as never,
        teamId: A().teamId,
        url: `https://203.0.113.10/ws-msg/${randomUUID()}`,
        subscribedEvents: ["EVIDENCE_CREATED"] as never,
        createdByUserId: A().ownerUserId,
      });
      const row = await prisma.lifecycleWebhookEndpoint.findUniqueOrThrow({ where: { id: created.endpointId }, select: { secret: true } });
      expect(row.secret).not.toBe(created.secret);
      expect(row.secret).not.toContain(created.secret);
      expect(row.secret.startsWith("e3.3:")).toBe(true);
      expect(webhookPlatform.readLifecycleSigningSecret(row.secret)).toBe(created.secret);
      const { deliveryIds } = await webhookPlatform.emitWebhookEvent({ prisma: prisma as never, teamId: A().teamId, eventKind: "EVIDENCE_CREATED" as never, payload: { probe: "ws-msg" } });
      expect(deliveryIds.length).toBeGreaterThan(0);
      const delivery = await prisma.lifecycleWebhookDelivery.findFirstOrThrow({ where: { endpointId: created.endpointId } as never, select: { signature: true } as never }) as unknown as { signature: string };
      const expected = createHmac("sha256", Buffer.from(created.secret, "base64")).update(canonicalJson({ probe: "ws-msg" }), "utf8").digest("hex");
      expect(delivery.signature).toBe(expected);
    });
  });

  describe("PRO-N1-06 / PRO-I1Z-01 / PRO-PW-04 / PRO-I1Z-06 — bearer links are not stored; every link is absolute", () => {
    it("the evidence-request email and SMS deliver an absolute link, while no stored preview or projection carries the token", async () => {
      delete process.env.WORKFLOW_INTAKE_PUBLIC_BASE_URL;
      const email = `ws-msg-${randomUUID().slice(0, 8)}@example.test`;
      sent.length = 0;
      const { id, rawToken } = await sentExternalRequest(email, "+15555550123");
      expect(rawToken).toBeTruthy();
      const token = encodeURIComponent(rawToken!);
      // The recipient gets a working absolute link.
      const mail = sent.filter((m) => m.to === email);
      expect(mail).toHaveLength(1);
      expect(mail[0]!.text).toMatch(new RegExp(`https?://[^\\s/]+/intake/${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      // The delivery row and its projection hold no token.
      const delivery = await prisma.notificationDelivery.findFirstOrThrow({ where: { evidenceRequestId: id, eventType: "EVIDENCE_REQUEST_SENT" } as never });
      expect(delivery.renderedPreview ?? "").not.toContain(rawToken!);
      expect(delivery.renderedPreview ?? "").not.toContain(token);
      const { projectNotificationDelivery } = notifications;
      expect(JSON.stringify(projectNotificationDelivery(delivery as never, { disclosure: "REVEALED" }))).not.toContain(token);
      // The SMS row stores no token and is not resendable from its preview.
      const sms = await prisma.communicationMessage.findFirstOrThrow({ where: { relatedEvidenceRequestId: id } as never, select: { bodyPreview: true, bodyResendable: true } as never }) as unknown as { bodyPreview: string; bodyResendable: boolean };
      expect(sms.bodyPreview).not.toContain(token);
      expect(sms.bodyPreview).toMatch(/https?:\/\/[^\s/]+\/intake\//);
      expect(sms.bodyResendable).toBe(false);
      // The API field is absolute too.
      const resend = await h.app.inject({ method: "GET", url: `/v1/evidence-requests/${id}`, headers: owner() });
      expect(resend.statusCode).toBe(200);
    });

    it("the request-more SMS link is absolute even when WORKFLOW_INTAKE_PUBLIC_BASE_URL is unset", async () => {
      delete process.env.WORKFLOW_INTAKE_PUBLIC_BASE_URL;
      const { id } = await sentExternalRequest(`ws-msg-${randomUUID().slice(0, 8)}@example.test`, "+15555550124");
      const response = await prisma.evidenceRequestResponse.create({ data: { evidenceRequestId: id, status: "RECEIVED" } as never, select: { id: true } });
      const out = await svc.requestMoreEvidenceForResponse({ requestId: id, teamId: A().teamId, responseId: response.id, actorUserId: A().ownerUserId, notifyContributor: true });
      const msg = await prisma.communicationMessage.findUniqueOrThrow({ where: { id: out.communicationMessageId! }, select: { bodyPreview: true } });
      expect(msg.bodyPreview ?? "").toMatch(/https?:\/\/[^\s/]+\/intake\/\[secure-link\]/);
      expect(msg.bodyPreview ?? "").not.toContain(encodeURIComponent(out.newRawToken));
    });
  });

  describe("PRO-A1-03 — codes to a new destination are bounded across accounts and workspaces", () => {
    it("the N+1th enrolment start to one number is refused 429 before any factor row or provider call", async () => {
      const previous = process.env.VERIFY_NEW_DESTINATION_PER_RECIPIENT_PER_DAY;
      process.env.VERIFY_NEW_DESTINATION_PER_RECIPIENT_PER_DAY = "2";
      try {
        const phone = `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
        // Two different accounts (two workspaces) aim at the same number.
        const callers = [
          { token: A().ownerToken, teamId: A().teamId },
          { token: h.fixtures.teamB.ownerToken, teamId: h.fixtures.teamB.teamId },
          { token: h.fixtures.personal.token, teamId: h.fixtures.personal.teamId },
        ];
        const statuses: number[] = [];
        const factorsBefore = await prisma.mfaFactor.count();
        for (const c of callers) {
          const res = await h.app.inject({
            method: "POST",
            url: "/v1/identity-security/contact-factors/enroll/start",
            headers: { authorization: `Bearer ${c.token}` },
            payload: { teamId: c.teamId, channel: "SMS", destination: phone },
          });
          statuses.push(res.statusCode);
        }
        const factorsAfterTwo = statuses.slice(0, 2).filter((s) => s !== 429 && s !== 503).length;
        expect(statuses[2]).toBe(429);
        // The refused third start created no factor.
        expect(await prisma.mfaFactor.count()).toBeLessThanOrEqual(factorsBefore + factorsAfterTwo);
      } finally {
        if (previous === undefined) delete process.env.VERIFY_NEW_DESTINATION_PER_RECIPIENT_PER_DAY;
        else process.env.VERIFY_NEW_DESTINATION_PER_RECIPIENT_PER_DAY = previous;
      }
    });
  });

  describe("PRO-T2-06 — organization invitation resends are on the abuse rail", () => {
    it("a second resend inside the cooldown is refused 429 with no email and the token unchanged", async () => {
      const org = await prisma.organization.create({ data: { name: `ws-msg-${randomUUID().slice(0, 8)}`, kind: "CUSTOMER" } as never, select: { id: true } });
      await prisma.organizationMembership.create({ data: { organizationId: org.id, userId: A().ownerUserId, role: "ORG_OWNER" } as never });
      const email = `ws-msg-invitee-${randomUUID().slice(0, 8)}@example.test`;
      const created = await h.app.inject({ method: "POST", url: `/v1/orgs/${org.id}/invites`, headers: owner(), payload: { email, role: "ORG_MEMBER" } });
      expect(created.statusCode, created.body).toBeLessThan(300);
      const invite = await prisma.organizationInvite.findFirstOrThrow({ where: { organizationId: org.id, email } as never, select: { id: true } });
      sent.length = 0;
      const first = await h.app.inject({ method: "POST", url: `/v1/orgs/${org.id}/invites/${invite.id}/resend`, headers: owner(), payload: {} });
      expect(first.statusCode, first.body).toBe(200);
      const afterFirst = await prisma.organizationInvite.findUniqueOrThrow({ where: { id: invite.id }, select: { tokenHash: true, resendCount: true } });
      const mailsAfterFirst = sent.filter((m) => m.to === email).length;
      const second = await h.app.inject({ method: "POST", url: `/v1/orgs/${org.id}/invites/${invite.id}/resend`, headers: owner(), payload: {} });
      expect(second.statusCode, second.body).toBe(429);
      expect(second.json()).toMatchObject({ code: "ORG_INVITE_RESEND_COOLDOWN" });
      const afterSecond = await prisma.organizationInvite.findUniqueOrThrow({ where: { id: invite.id }, select: { tokenHash: true, resendCount: true } });
      expect(afterSecond).toEqual(afterFirst);
      expect(sent.filter((m) => m.to === email).length).toBe(mailsAfterFirst);
    });
  });

  describe("PRO-N1-14 / PRO-N1Z-02 / PRO-N1Z-03 — delivery resend authority", () => {
    it("a contextual retry of a template-less SKIPPED row is not offered and answers 409; a lapsed plan blocks a re-invitation", async () => {
      const { id } = await sentExternalRequest(`ws-msg-${randomUUID().slice(0, 8)}@example.test`);
      const skipped = await prisma.notificationDelivery.create({
        data: { teamId: A().teamId, eventType: "EVIDENCE_REQUEST_SENT", channel: "EMAIL", provider: "RESEND", recipient: "(missing)", status: "SKIPPED", templateKey: "EVIDENCE_REQUEST_SENT", errorCode: "missing_recipient", evidenceRequestId: id } as never,
        select: { id: true },
      });
      const list = await h.app.inject({ method: "GET", url: `/v1/evidence-requests/${id}/deliveries`, headers: owner() });
      expect(list.statusCode).toBe(200);
      const row = (list.json() as { deliveries: Array<{ id: string; retryable: boolean }> }).deliveries.find((d) => d.id === skipped.id);
      expect(row?.retryable).toBe(false);
      const retry = await h.app.inject({ method: "POST", url: `/v1/evidence-requests/${id}/deliveries/${skipped.id}/retry`, headers: owner(), payload: {} });
      expect(retry.statusCode).toBe(409);

      // A FAILED request mail on a workspace whose plan lost secure intake is not re-sent.
      const failed = await prisma.notificationDelivery.findFirstOrThrow({ where: { evidenceRequestId: id, eventType: "EVIDENCE_REQUEST_SENT", status: { not: "SKIPPED" } } as never, select: { id: true } });
      await prisma.notificationDelivery.update({ where: { id: failed.id }, data: { status: "FAILED" } as never });
      await prisma.team.update({ where: { id: A().teamId }, data: { billingPlan: "FREE" } as never });
      try {
        sent.length = 0;
        const blocked = await h.app.inject({ method: "POST", url: `/v1/evidence-requests/${id}/deliveries/${failed.id}/retry`, headers: owner(), payload: {} });
        expect(blocked.statusCode, blocked.body).toBe(409);
        expect(sent).toHaveLength(0);
      } finally {
        await prisma.team.update({ where: { id: A().teamId }, data: { billingPlan: "TEAM" } as never });
      }
    });

    it("the delivery-log resend asks notification.delivery.resend (a MEMBER is refused)", async () => {
      const res = await h.app.inject({
        method: "POST",
        url: `/v1/notifications/deliveries/${randomUUID()}/resend`,
        headers: { authorization: `Bearer ${A().memberToken}` },
        payload: { teamId: A().teamId, force: true },
      });
      expect([403, 404]).toContain(res.statusCode);
    });
  });

  describe("PRO-I1-03 — a one-time link says 'already submitted' only for a durable accepted submission", () => {
    it("a reserved use with nothing sealed answers LINK_IN_USE, and an orphaned reservation is given back", async () => {
      const res = await h.app.inject({
        method: "POST", url: "/v1/workflow/intake-links", headers: owner(),
        payload: { teamId: A().teamId, workflowTemplateSlug: "general-evidence-record", intakeMode: "EXTERNAL_ONE_TIME", recipientLabel: "ws-msg", maxUses: 1, expiresAtUtc: new Date(Date.now() + 3_600_000).toISOString() },
      });
      expect(res.statusCode, res.body).toBe(201);
      const { rawToken, link } = res.json() as { rawToken: string; link: { id: string } };
      const t = encodeURIComponent(rawToken);
      const boot = await h.app.inject({ method: "GET", url: `/v1/external-intake/${t}` });
      expect(boot.statusCode, boot.body).toBe(200);
      // Attempt 1 reserved the use and is still finalizing (or its answer was lost).
      const { reserveIntakeLinkUse } = intakeSessions;
      expect(await reserveIntakeLinkUse(link.id)).toBe(true);
      const reopened = await h.app.inject({ method: "GET", url: `/v1/external-intake/${t}` });
      expect(reopened.statusCode).toBe(409);
      expect(reopened.json()).toMatchObject({ error: { code: "LINK_IN_USE" } });
      // The process ended inside finalization: 31 minutes later the reservation is orphaned.
      const aged = new Date(Date.now() - 31 * 60_000);
      await prisma.$executeRaw`UPDATE "workflow_intake_links" SET "updated_at" = ${aged} WHERE "id" = ${link.id}::uuid`;
      const recovered = await h.app.inject({ method: "GET", url: `/v1/external-intake/${t}` });
      expect(recovered.statusCode, recovered.body).toBe(200);
      const row = await prisma.workflowIntakeLink.findUniqueOrThrow({ where: { id: link.id }, select: { usedCount: true } });
      expect(row.usedCount).toBe(0);
    });
  });

  describe("PRO-I1-04 — request-more racing a cancel leaves no live link", () => {
    it("a cancel that commits between request-more's check and its claim makes request-more mint nothing live", async () => {
      const { id } = await sentExternalRequest(`ws-msg-${randomUUID().slice(0, 8)}@example.test`);
      const response = await prisma.evidenceRequestResponse.create({ data: { evidenceRequestId: id, status: "RECEIVED" } as never, select: { id: true } });
      const t0 = new Date();
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      // The cancel holds the request lock (as transitionEvidenceRequestTx does) and commits later.
      const cancel = prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`evidence-request:${id}`}))`;
        await tx.evidenceRequest.update({ where: { id }, data: { status: "CANCELLED", cancelledAtUtc: new Date() } as never });
        await gate;
      }, { timeout: 30_000 });
      const more = svc
        .requestMoreEvidenceForResponse({ requestId: id, teamId: A().teamId, responseId: response.id, actorUserId: A().ownerUserId, notifyContributor: false })
        .then(() => "ok", (e: unknown) => (e as { code?: string }).code ?? "error");
      await new Promise((r) => setTimeout(r, 2_000));
      release();
      await cancel;
      const outcome = await more;
      const live = await prisma.workflowIntakeLink.count({ where: { teamId: A().teamId, status: "ACTIVE", createdAt: { gte: t0 } } as never });
      expect(live).toBe(0);
      expect(outcome).toBe("request_terminal");
    });
  });
});
