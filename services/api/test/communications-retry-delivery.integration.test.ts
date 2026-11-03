/**
 * WORKFLOW-008 / 009 / 016 — retries deliver what was sent or do not send at all,
 * and a late delivery callback cannot move a message backwards.
 *
 * Real rows and the recording transport: the assertion is on what would reach the
 * provider. Probe P9 from the audit.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedOrganizationTenant, type FixtureDeps, type OrganizationTenant } from "./point7/product-fixtures.js";

const PHONE = "+14155550142";
const REQUEST_TYPE = "DOCUMENT";

describe("Communications retry truth (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let comm: typeof import("../src/services/communications/communication.service.js");
  let recording: typeof import("../src/services/communications/recording-provider.js");
  let org: OrganizationTenant;
  const cronSecret = "integration-cron-secret-test-0123";

  beforeAll(async () => {
    process.env.MESSAGING_TRANSPORT = "recording";
    process.env.INTEGRATION_CRON_SECRET = cronSecret;
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    comm = await import("../src/services/communications/communication.service.js");
    recording = await import("../src/services/communications/recording-provider.js");
    const { signJwt } = await import("../src/services/jwt.js");
    const deps: FixtureDeps = {
      prisma: prisma as never,
      tag: `comm-${Date.now().toString(36)}`,
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
    recording.resetRecordingMessagingProvider();
    await prisma.communicationMessage.deleteMany({ where: { teamId: org.workspaceId } });
    await prisma.communicationPreference.deleteMany({ where: { teamId: org.workspaceId } });
  });

  async function intakeLink() {
    const row = await prisma.workflowIntakeLink.create({
      data: {
        teamId: org.workspaceId,
        workflowTemplateSlug: "retry-proof",
        workflowTemplateVersion: 1,
        workflowTemplateSnapshot: {},
        intakeMode: "EXTERNAL_ONE_TIME",
        allowedAcceptedKinds: [],
        ipAllowlistCidrs: [],
        createdByUserId: org.owner.userId,
        tokenHash: randomUUID().replace(/-/g, ""),
        recipientPhone: PHONE,
        expiresAtUtc: new Date(Date.now() + 86_400_000),
      } as never,
      select: { id: true },
    });
    return row.id;
  }

  async function dueMessage(data: Record<string, unknown>) {
    const hash = comm.hashRecipientPhone(PHONE);
    return prisma.communicationMessage.create({
      data: {
        teamId: org.workspaceId,
        channel: "SMS",
        purpose: "EVIDENCE_REQUEST",
        provider: "TWILIO",
        recipientHash: hash,
        recipientPreview: "+••• 0142",
        status: "RETRY_SCHEDULED",
        nextAttemptAtUtc: new Date(Date.now() - 1000),
        attemptCount: 1,
        ...data,
      } as never,
    });
  }

  const processRetries = () =>
    h.app.inject({
      method: "POST",
      url: "/v1/communications/process-retries",
      headers: { "x-proovra-integration-cron-secret": cronSecret },
    });

  it("WORKFLOW-009 (P9): a token-bearing message is not resent as its redacted preview, and the row says why", async () => {
    const linkId = await intakeLink();
    const row = await dueMessage({
      bodyPreview: "Upload here: [secure-link]",
      bodyResendable: false,
      relatedIntakeLinkId: linkId,
    });
    const res = await processRetries();
    expect(res.statusCode, res.body).toBe(200);
    expect(recording.recordedMessages()).toEqual([]);
    const after = await prisma.communicationMessage.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe("FAILED");
    expect(after.errorCode).toBe("retry_requires_reissue");
    expect(after.nextAttemptAtUtc).toBeNull();
  });

  it("WORKFLOW-009: a resendable message is sent again with the exact text", async () => {
    const linkId = await intakeLink();
    const text = "Your evidence request is ready for review.";
    const row = await dueMessage({ bodyPreview: text, bodyResendable: true, relatedIntakeLinkId: linkId });
    const res = await processRetries();
    expect(res.statusCode, res.body).toBe(200);
    const sent = recording.recordedMessages();
    expect(sent.map((m) => m.body)).toEqual([text]);
    const after = await prisma.communicationMessage.findUniqueOrThrow({ where: { id: row.id } });
    expect(["SENT", "QUEUED"]).toContain(after.status);
    expect(after.attemptCount).toBe(2);
  });

  it("WORKFLOW-009: a recipient who replied STOP is not messaged by a retry", async () => {
    const linkId = await intakeLink();
    const row = await dueMessage({ bodyPreview: "Reminder.", bodyResendable: true, relatedIntakeLinkId: linkId });
    const { applyInboundOptOut } = await import("../src/services/communications/communication-preference.service.js");
    await applyInboundOptOut({ teamId: org.workspaceId, phoneE164: PHONE, channel: "SMS" });
    await processRetries();
    expect(recording.recordedMessages()).toEqual([]);
    const after = await prisma.communicationMessage.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe("CANCELLED");
    expect(after.errorCode).toBe("recipient_opted_out");
  });

  it("WORKFLOW-009: a closed evidence request is not chased", async () => {
    const request = await prisma.evidenceRequest.create({
      data: {
        teamId: org.workspaceId,
        requestedByUserId: org.owner.userId,
        title: "Closed request",
        requestType: REQUEST_TYPE,
        recipientMode: "EXTERNAL_CONTRIBUTOR",
        recipientPhone: PHONE,
        status: "CANCELLED",
      } as never,
      select: { id: true },
    });
    const row = await dueMessage({ bodyPreview: "Reminder.", bodyResendable: true, relatedEvidenceRequestId: request.id });
    await processRetries();
    expect(recording.recordedMessages()).toEqual([]);
    expect((await prisma.communicationMessage.findUniqueOrThrow({ where: { id: row.id } })).attemptCount).toBe(1);
  });

  it("WORKFLOW-009: the first send records whether its preview is the whole message", async () => {
    const plain = await comm.enqueueOutboundMessage({
      teamId: org.workspaceId,
      channel: "SMS",
      purpose: "EVIDENCE_REQUEST",
      recipientPhone: PHONE,
      body: "Short plain text.",
    } as never);
    expect(plain.message.bodyResendable).toBe(true);
    const redacted = await comm.enqueueOutboundMessage({
      teamId: org.workspaceId,
      channel: "SMS",
      purpose: "EVIDENCE_REQUEST",
      recipientPhone: PHONE,
      body: "Upload: https://example.test/i/secret-token",
      bodyPreviewOverride: "Upload: [secure-link]",
    } as never);
    expect(redacted.message.bodyResendable).toBe(false);
    const long = await comm.enqueueOutboundMessage({
      teamId: org.workspaceId,
      channel: "SMS",
      purpose: "EVIDENCE_REQUEST",
      recipientPhone: PHONE,
      body: "x".repeat(500),
    } as never);
    expect(long.message.bodyResendable).toBe(false);
  });

  it("WORKFLOW-009: the operator retry route refuses a message that cannot go twice, and keeps it unchanged", async () => {
    const row = await dueMessage({ status: "FAILED", nextAttemptAtUtc: null, bodyPreview: "[secure-link]", bodyResendable: false });
    const res = await h.app.inject({
      method: "POST",
      url: `/v1/communications/messages/${row.id}/retry`,
      headers: { authorization: `Bearer ${org.owner.token}` },
      payload: { teamId: org.workspaceId },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe("reissue_required");
    expect((await prisma.communicationMessage.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("FAILED");
  });

  it("WORKFLOW-009: two sweeps on one due row send once", async () => {
    const linkId = await intakeLink();
    const row = await dueMessage({ bodyPreview: "Once.", bodyResendable: true, relatedIntakeLinkId: linkId });
    await Promise.all([comm.dispatchPendingMessage(row.id), comm.dispatchPendingMessage(row.id)]);
    expect(recording.recordedMessages().length).toBe(1);
  });

  it("WORKFLOW-016: a late sent callback cannot undo delivered, and a duplicate changes nothing", async () => {
    expect(comm.communicationStatusesBefore("SENT")).toEqual(["QUEUED"]);
    expect(comm.communicationStatusesBefore("DELIVERED")).toContain("SENT");
    expect(comm.communicationStatusesBefore("QUEUED")).toEqual([]);
    const sid = `SM${randomUUID().replace(/-/g, "")}`;
    const row = await dueMessage({ status: "SENT", providerMessageId: sid, nextAttemptAtUtc: null, bodyPreview: "x" });
    const apply = async (status: string) => {
      await prisma.communicationMessage.updateMany({
        where: { id: row.id, status: { in: [...comm.communicationStatusesBefore(status)] } },
        data: { status: status as never },
      });
      return (await prisma.communicationMessage.findUniqueOrThrow({ where: { id: row.id } })).status;
    };
    expect(await apply("DELIVERED")).toBe("DELIVERED");
    expect(await apply("SENT")).toBe("DELIVERED");
    expect(await apply("FAILED")).toBe("DELIVERED");
  });

  it("WORKFLOW-016: a delivery report that arrives after a retry was scheduled cancels the resend", async () => {
    const linkId = await intakeLink();
    const sid = `SM${randomUUID().replace(/-/g, "")}`;
    const row = await dueMessage({
      status: "RETRY_SCHEDULED",
      providerMessageId: sid,
      bodyPreview: "Late but delivered.",
      bodyResendable: true,
      relatedIntakeLinkId: linkId,
    });
    expect(comm.communicationStatusesBefore("DELIVERED")).toContain("RETRY_SCHEDULED");
    await prisma.communicationMessage.updateMany({
      where: { id: row.id, status: { in: [...comm.communicationStatusesBefore("DELIVERED")] } },
      data: { status: "DELIVERED", deliveredAtUtc: new Date(), nextAttemptAtUtc: null },
    });
    await comm.dispatchPendingMessage(row.id);
    expect(recording.recordedMessages().filter((m) => JSON.stringify(m).includes("Late but delivered."))).toHaveLength(0);
    expect((await prisma.communicationMessage.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("DELIVERED");
  });
});
