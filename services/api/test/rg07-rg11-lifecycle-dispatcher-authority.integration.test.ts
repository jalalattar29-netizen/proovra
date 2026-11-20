/**
 * Matrix review NEW-RG-07-1 / NEW-RG-11-2 — the Worker's lifecycle-webhook
 * dispatcher (services/worker/src/webhook-dispatcher.ts) sent a queued or
 * retrying delivery after its endpoint's creator lost
 * integration.lifecycle_webhook.manage (PRO-LEAD-01 / PRO-G1Z-01, DEC-09: a
 * capability or scope that expires is ended by no transition, only by a
 * use-time check), and after the record it names became closed by a restricted
 * case (PRO-LEAD-02 / AZ-R04: the machine-egress rule). The API's emit and the
 * integration retry path ask both; the Worker asked neither. It now asks the
 * same shared authorities at send. Real Worker tick, injected transport,
 * live PostgreSQL.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bootIntegrationHarness, type IntegrationHarness } from "./integration-harness.js";

describe("NEW-RG-07-1 / NEW-RG-11-2 — the Worker lifecycle dispatcher asks creator authority and machine egress at send", () => {
  let h: IntegrationHarness;
  let prisma: import("@prisma/client").PrismaClient;
  let dispatcher: typeof import("../../worker/src/webhook-dispatcher.js");

  beforeAll(async () => {
    h = await bootIntegrationHarness();
    // The application graph reads DATABASE_URL at import time; the harness sets it at boot.
    prisma = (await import("../src/db.js")).prisma as unknown as import("@prisma/client").PrismaClient;
    await import("../src/register-shared-runtime.js");
    dispatcher = await import("../../worker/src/webhook-dispatcher.js");
    const { teamA } = h.fixtures;
    const { upsertEntitlementGrant } = await import("../src/services/packaging/entitlement.service.js");
    // The workspace holds webhooks, so a refusal below is never the entitlement's.
    await upsertEntitlementGrant({
      teamId: teamA.teamId,
      key: "FEATURE_WEBHOOKS",
      value: true,
      kind: "FEATURE",
      source: "CUSTOM",
      grantedByUserId: teamA.ownerUserId,
    });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  async function seed(createdByUserId: string, payload: Record<string, unknown>) {
    const { teamA } = h.fixtures;
    const ep = await prisma.lifecycleWebhookEndpoint.create({
      data: {
        teamId: teamA.teamId,
        url: `https://203.0.113.10/rg07/${randomUUID()}`,
        secret: Buffer.from(randomUUID()).toString("base64"),
        subscribedEvents: ["EVIDENCE_CREATED"],
        state: "ACTIVE",
        createdByUserId,
      },
      select: { id: true, url: true },
    });
    const d = await prisma.lifecycleWebhookDelivery.create({
      data: { teamId: teamA.teamId, endpointId: ep.id, eventKind: "EVIDENCE_CREATED", payload, signature: "", state: "PENDING" } as never,
      select: { id: true },
    });
    return { url: ep.url, endpointId: ep.id, deliveryId: d.id };
  }

  async function record(): Promise<string> {
    const { teamA } = h.fixtures;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamA.teamId }, select: { organizationId: true } });
    return (
      await prisma.evidence.create({
        data: { title: `rg07 ${randomUUID().slice(0, 6)}`, type: "PHOTO", status: "SIGNED", teamId: teamA.teamId, organizationId: team.organizationId, ownerUserId: teamA.ownerUserId } as never,
        select: { id: true },
      })
    ).id;
  }

  async function tick(): Promise<string[]> {
    const calls: string[] = [];
    await dispatcher.runWebhookDispatcherTick({
      fetcher: (async (url: string) => {
        calls.push(url);
        return { status: 200, text: async () => "" };
      }) as never,
    });
    return calls;
  }

  const delivery = (id: string) => prisma.lifecycleWebhookDelivery.findUniqueOrThrow({ where: { id } });
  const endpointState = async (id: string) =>
    (await prisma.lifecycleWebhookEndpoint.findUniqueOrThrow({ where: { id }, select: { state: true } })).state;

  it("NEW-RG-07-1: a delivery whose endpoint creator no longer holds the permission is not sent; the endpoint is deactivated", async () => {
    const { teamA } = h.fixtures;
    // A MEMBER does not hold integration.lifecycle_webhook.manage (an expired
    // capability grant leaves the creator exactly here).
    const lost = await seed(teamA.memberUserId, { evidenceId: await record() });
    const control = await seed(teamA.ownerUserId, { evidenceId: await record() });
    const calls = await tick();
    expect(calls).not.toContain(lost.url);
    const row = await delivery(lost.deliveryId);
    expect(row.state).toBe("FAILED");
    expect(row.responseStatus).toBeNull();
    expect(row.responseBodyPreview).toBe("creator_lost_authority");
    expect(await endpointState(lost.endpointId)).toBe("DEACTIVATED");
    // Positive control: the owner's endpoint delivers.
    expect(calls.filter((u) => u === control.url)).toHaveLength(1);
    expect((await delivery(control.deliveryId)).state).toBe("DELIVERED");
  });

  it("NEW-RG-07-1: a creator who left the workspace sends nothing either", async () => {
    const { teamA } = h.fixtures;
    const email = `rg07-${randomUUID().slice(0, 8)}@test.proovra.local`;
    const gone = await prisma.user.create({ data: { email, provider: "EMAIL", providerUserId: email }, select: { id: true } });
    await prisma.teamMember.create({ data: { teamId: teamA.teamId, userId: gone.id, role: "ADMIN", status: "REVOKED" } as never });
    const lost = await seed(gone.id, { evidenceId: await record() });
    const calls = await tick();
    expect(calls).not.toContain(lost.url);
    expect((await delivery(lost.deliveryId)).state).toBe("FAILED");
    expect(await endpointState(lost.endpointId)).toBe("DEACTIVATED");
  });

  it("NEW-RG-11-2: a delivery naming a record a restricted case closes is withheld at send; the endpoint stays ACTIVE", async () => {
    const { teamA } = h.fixtures;
    const closed = await record();
    const restricted = await prisma.case.create({
      data: { name: `rg11 ${randomUUID().slice(0, 6)}`, teamId: teamA.teamId, ownerUserId: teamA.ownerUserId, restrictedAtUtc: new Date() } as never,
      select: { id: true },
    });
    const queued = await seed(teamA.ownerUserId, { evidenceId: closed });
    // The record becomes restricted AFTER the delivery was queued.
    await prisma.caseEvidenceLink.create({ data: { caseId: restricted.id, evidenceId: closed, teamId: teamA.teamId } as never });
    const byCase = await seed(teamA.ownerUserId, { caseId: restricted.id });
    const calls = await tick();
    for (const row of [queued, byCase]) {
      expect(calls).not.toContain(row.url);
      const d = await delivery(row.deliveryId);
      expect(d.state).toBe("WITHHELD");
      expect(d.responseBodyPreview).toBe("withheld:machine_egress_restricted");
      expect(d.responseStatus).toBeNull();
      // Reversible for new events: the endpoint is not ended.
      expect(await endpointState(row.endpointId)).toBe("ACTIVE");
    }
  });
});
