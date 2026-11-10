/**
 * WORKFLOW-008 — a due row is drained without anybody posting by hand.
 *
 * `services/worker/test/api-delivery-sweeps.test.ts` proves the worker's sweep
 * against a stubbed fetch, and the API suites call the cron routes directly. What
 * neither shows is the two halves meeting: the real worker sweep, over real HTTP,
 * on its own header and secret, against the real API and database.
 *
 * Whether production's worker carries the base URL and secrets is a deployment
 * fact no local test can reach.
 */
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { API_DELIVERY_SWEEPS, runApiDeliverySweep } from "../../worker/src/api-delivery-sweeps.js";
import type { IntegrationHarness } from "./integration-harness.js";
import { seedOrganizationTenant, type FixtureDeps, type OrganizationTenant } from "./point7/product-fixtures.js";

const PHONE = "+15550100142";
const NOTIFICATION_SECRET = "notification-cron-secret-test-0123";
const INTEGRATION_SECRET = "integration-cron-secret-test-0123";

describe("WORKFLOW-008 the worker sweeps against the real API", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let comm: typeof import("../src/services/communications/communication.service.js");
  let recording: typeof import("../src/services/communications/recording-provider.js");
  let org: OrganizationTenant;

  beforeAll(async () => {
    process.env.MESSAGING_TRANSPORT = "recording";
    process.env.NOTIFICATION_CRON_SECRET = NOTIFICATION_SECRET;
    process.env.INTEGRATION_CRON_SECRET = INTEGRATION_SECRET;
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    comm = await import("../src/services/communications/communication.service.js");
    recording = await import("../src/services/communications/recording-provider.js");
    const { signJwt } = await import("../src/services/jwt.js");
    const deps: FixtureDeps = {
      prisma: prisma as never,
      tag: `w008-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authAt: Math.floor(Date.now() / 1000), authMethod: "PASSWORD" } as never,
          process.env.AUTH_JWT_SECRET!,
          3600,
        ),
    };
    org = await seedOrganizationTenant(deps);
    await h.app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = h.app.server.address() as AddressInfo;
    process.env.INTERNAL_API_BASE_URL = `http://127.0.0.1:${port}`;
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  it.each(API_DELIVERY_SWEEPS.map((s) => [s.name, s] as const))("%s reaches its route on its own secret", async (_name, sweep) => {
    const result = await runApiDeliverySweep(sweep, { timeoutMs: 60_000 });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  });

  it("the wrong secret is a failed sweep, so a misconfigured worker cannot read as a healthy one", async () => {
    // Worker and API share this process's env, so the mismatch is another route's secret.
    const sweep = API_DELIVERY_SWEEPS.find((s) => s.name === "communication-retries")!;
    const result = await runApiDeliverySweep({ ...sweep, secretEnv: "NOTIFICATION_CRON_SECRET" }, { timeoutMs: 60_000 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^http_40/);
  });

  it("a due SMS is sent by the sweep, with no operator action", async () => {
    recording.resetRecordingMessagingProvider();
    const link = await prisma.workflowIntakeLink.create({
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
    const due = await prisma.communicationMessage.create({
      data: {
        teamId: org.workspaceId,
        channel: "SMS",
        purpose: "EVIDENCE_REQUEST",
        provider: "TWILIO",
        recipientHash: comm.hashRecipientPhone(PHONE),
        recipientPreview: "+••• 0142",
        status: "RETRY_SCHEDULED",
        nextAttemptAtUtc: new Date(Date.now() - 1000),
        attemptCount: 1,
        bodyPreview: "Please add your photos to the request.",
        bodyResendable: true,
        relatedIntakeLinkId: link.id,
      } as never,
      select: { id: true },
    });
    const sweep = API_DELIVERY_SWEEPS.find((s) => s.name === "communication-retries")!;
    const result = await runApiDeliverySweep(sweep, { timeoutMs: 60_000 });
    expect(result.ok).toBe(true);
    expect(recording.recordedMessages().map((m) => m.body)).toEqual(["Please add your photos to the request."]);
    const after = await prisma.communicationMessage.findUniqueOrThrow({ where: { id: due.id } });
    expect(["SENT", "QUEUED"]).toContain(after.status);
    expect(after.attemptCount).toBe(2);
  });

  it("AUD-0003 — a due webhook retry is picked up by the sweep, with no operator action", async () => {
    // At the audit a retry due in 30 s was still RETRY_SCHEDULED 40 s later and
    // moved only when the route was called by hand. The endpoint here is
    // disabled, so picking the row up ends it CANCELLED without any network call.
    const prior = process.env.INTEGRATIONS_ENABLED;
    process.env.INTEGRATIONS_ENABLED = "true";
    try {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          teamId: org.workspaceId,
          url: "https://hooks.example.com/aud-0003",
          secretCiphertext: "not-used",
          secretPrefix: "whsec_test",
          createdByUserId: org.owner.userId,
          status: "DISABLED",
        } as never,
        select: { id: true },
      });
      const delivery = await prisma.integrationWebhookDelivery.create({
        data: {
          endpointId: endpoint.id,
          teamId: org.workspaceId,
          eventId: randomUUID(),
          eventType: "evidence.created",
          payloadJson: {},
          status: "RETRY_SCHEDULED",
          attemptCount: 1,
          nextAttemptAtUtc: new Date(Date.now() - 1000),
        },
        select: { id: true },
      });
      const sweep = API_DELIVERY_SWEEPS.find((s) => s.path === "/v1/integrations/process-webhook-retries");
      expect(sweep, "no worker sweep calls the webhook retry route").toBeDefined();
      const result = await runApiDeliverySweep(sweep!, { timeoutMs: 60_000 });
      expect(result.ok).toBe(true);
      const after = await prisma.integrationWebhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
      expect(after.status).toBe("CANCELLED");
      expect(after.errorMessage).toBe("endpoint_inactive");
    } finally {
      if (prior === undefined) delete process.env.INTEGRATIONS_ENABLED;
      else process.env.INTEGRATIONS_ENABLED = prior;
    }
  });

  it("AUD-0042 — a slow webhook receiver does not delay capture; the sweep delivers the queued event", async () => {
    // At the audit POST /v1/evidence took 10.2 s with one slow receiver
    // subscribed, because evidence.created was sent inline. Here the receiver
    // takes 3 s: the request must return well before that, with the event
    // queued, and the worker sweep must then deliver it.
    const saved = { INTEGRATIONS_ENABLED: process.env.INTEGRATIONS_ENABLED, API_KEY_SECRET: process.env.API_KEY_SECRET };
    process.env.INTEGRATIONS_ENABLED = "true";
    process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "ab".repeat(32);
    const { issueWebhookSecret } = await import("../src/services/integrations/webhooks.service.js");
    const { __setWebhookHttpClientForTests } = await import("../src/services/integrations/webhook-dispatcher.js");
    const sends: string[] = [];
    const restore = __setWebhookHttpClientForTests(async (req) => {
      sends.push(req.url);
      await new Promise((r) => setTimeout(r, 3_000));
      return { status: 200, bodyPreview: null, errorMessage: null };
    });
    try {
      const A = h.fixtures.teamA;
      await prisma.team.update({ where: { id: A.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
      const secret = issueWebhookSecret()!;
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          teamId: A.teamId,
          url: "https://hooks.example.com/aud-0042-slow",
          secretCiphertext: secret.secretCiphertext,
          secretPrefix: secret.secretPrefix,
          createdByUserId: A.ownerUserId,
          eventTypes: ["evidence.created"],
        } as never,
        select: { id: true },
      });
      const bytes = Buffer.from(`aud-0042 ${randomUUID()}`);
      const t0 = Date.now();
      const res = await h.app.inject({
        method: "POST",
        url: "/v1/evidence",
        headers: { authorization: `Bearer ${A.adminToken}` },
        payload: {
          type: "DOCUMENT",
          mimeType: "text/plain",
          originalFileName: "t.txt",
          checksumSha256Base64: createHash("sha256").update(bytes).digest("base64"),
          teamId: A.teamId,
        },
      });
      const elapsed = Date.now() - t0;
      expect(res.statusCode, res.body).toBe(201);
      expect(elapsed, `capture waited ${elapsed} ms on the receiver`).toBeLessThan(2_500);
      expect(sends).toEqual([]);
      const queued = await prisma.integrationWebhookDelivery.findMany({ where: { endpointId: endpoint.id } });
      expect(queued.map((d) => d.status)).toEqual(["RETRY_SCHEDULED"]);

      const sweep = API_DELIVERY_SWEEPS.find((s) => s.path === "/v1/integrations/process-webhook-retries")!;
      const result = await runApiDeliverySweep(sweep, { timeoutMs: 60_000 });
      expect(result.ok).toBe(true);
      expect(sends).toEqual(["https://hooks.example.com/aud-0042-slow"]);
      const after = await prisma.integrationWebhookDelivery.findUniqueOrThrow({ where: { id: queued[0]!.id } });
      expect(after.status).toBe("SENT");
    } finally {
      restore();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }, 60_000);

  it("AUD-0003 — every maintenance route the audit found uncalled has a worker sweep", () => {
    const paths = API_DELIVERY_SWEEPS.map((s) => s.path);
    for (const p of [
      "/v1/governance/reconcile-retention",
      "/v1/integrations/process-webhook-retries",
      "/v1/integrations/webhooks/cleanup-deliveries",
      "/v1/integrations/process-secret-cleanup",
      "/v1/review-operations/reconcile-slas",
    ]) {
      expect(paths, p).toContain(p);
    }
  });

  it("a requested personal data export is produced by the lifecycle tick", async () => {
    const user = await prisma.user.create({
      data: { email: `w008-${randomUUID().slice(0, 8)}@test.proovra.local`, provider: "EMAIL", providerUserId: randomUUID() },
      select: { id: true },
    });
    const request = await prisma.accountDataExportRequest.create({
      data: { userId: user.id, status: "REQUESTED" } as never,
      select: { id: true },
    });
    const { runLifecycleTick } = await import("../src/services/lifecycle/lifecycle-scheduler.service.js");
    await runLifecycleTick();
    const after = await prisma.accountDataExportRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(after.status).toBe("READY");
    expect(after.packageSha256).toBeTruthy();
  });
});
