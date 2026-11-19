/**
 * WS-SCHED / PRO-W2-06, PRO-G1Z-02 — an integration webhook delivery left
 * PENDING by a stopped process is reclaimed by the retry sweeper, against a
 * disposable PostgreSQL.
 *
 * At base processDueWebhookRetries read RETRY_SCHEDULED only and nothing read
 * PENDING again, so a delivery whose sender died stayed "in progress" forever.
 * Now a PENDING row untouched for longer than the lease returns to the pool
 * with the stranded attempt counted (FAILED `stranded` at the ceiling), and a
 * row inside its lease is not touched. No network: the endpoint's destination
 * is refused by the dispatcher's own outbound policy before any transport.
 */
import { randomUUID } from "node:crypto";

import { WEBHOOK_RETRY_MAX_ATTEMPTS } from "@proovra/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("PRO-W2-06 webhook PENDING lease (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let retry: typeof import("../src/services/integrations/webhook-retry-processor.js");
  let endpointId: string;
  const savedFlag = process.env.INTEGRATIONS_ENABLED;

  beforeAll(async () => {
    process.env.INTEGRATIONS_ENABLED = "true";
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    retry = await import("../src/services/integrations/webhook-retry-processor.js");
    const ep = await prisma.webhookEndpoint.create({
      data: {
        teamId: h.fixtures.teamA.teamId,
        // Refused by the dispatcher's outbound policy: nothing is sent.
        url: "http://localhost:1/hook",
        secretCiphertext: "not-a-real-ciphertext",
        secretPrefix: "whsec_test",
        createdByUserId: h.fixtures.teamA.ownerUserId,
      } as never,
      select: { id: true },
    });
    endpointId = ep.id;
  }, 900_000);

  afterAll(async () => {
    if (savedFlag === undefined) delete process.env.INTEGRATIONS_ENABLED;
    else process.env.INTEGRATIONS_ENABLED = savedFlag;
    await h?.cleanup();
  }, 300_000);

  async function pending(attemptCount: number, ageMinutes: number) {
    const row = await prisma.integrationWebhookDelivery.create({
      data: {
        endpointId,
        teamId: h.fixtures.teamA.teamId,
        eventId: randomUUID(),
        eventType: "evidence.created",
        payloadJson: { ok: true },
        status: "PENDING",
        attemptCount,
      },
      select: { id: true },
    });
    if (ageMinutes > 0) {
      await prisma.$executeRaw`UPDATE integration_webhook_deliveries SET updated_at = now() - make_interval(mins => ${ageMinutes}) WHERE id = ${row.id}::uuid`;
    }
    return row.id;
  }

  it("a stranded PENDING row is reclaimed and settled; one inside its lease is left alone; the last attempt ends FAILED stranded", async () => {
    const stranded = await pending(0, 30);
    const atCeiling = await pending(WEBHOOK_RETRY_MAX_ATTEMPTS - 1, 30);
    const live = await pending(0, 0);

    await retry.processDueWebhookRetries({});

    const s = await prisma.integrationWebhookDelivery.findUniqueOrThrow({ where: { id: stranded } });
    expect(s.status).not.toBe("PENDING");
    expect(s.attemptCount).toBeGreaterThanOrEqual(1);
    const c = await prisma.integrationWebhookDelivery.findUniqueOrThrow({ where: { id: atCeiling } });
    expect(c).toMatchObject({ status: "FAILED", errorMessage: "stranded", attemptCount: WEBHOOK_RETRY_MAX_ATTEMPTS });
    const l = await prisma.integrationWebhookDelivery.findUniqueOrThrow({ where: { id: live } });
    expect(l.status).toBe("PENDING");
  });
});
