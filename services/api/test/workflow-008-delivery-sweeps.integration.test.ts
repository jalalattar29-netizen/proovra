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
import { randomUUID } from "node:crypto";
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
