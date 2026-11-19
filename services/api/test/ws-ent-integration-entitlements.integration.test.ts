/**
 * WS-ENT / RG-13 — use-time entitlements and per-use quotas of the machine
 * channels (PRO-G1-04, PRO-G1-05, PRO-G1-14, PRO-W2-05, PRO-BL2-04, B7B-F05).
 * Live PostgreSQL, the real routes and services; the webhook HTTP boundary is a
 * RECORDING client (nothing leaves the process).
 *
 * At base cdcb8aef8:
 *   - a key issued while entitled kept authenticating after the entitlement
 *     resolved to 0 (G1-14);
 *   - QUOTA_API_REQUESTS_PER_DAY / QUOTA_WEBHOOK_DELIVERIES_PER_DAY had no
 *     reader and no writer (G1-04 / BL2-04);
 *   - integration webhook endpoints had no count limit (G1-05);
 *   - emitWebhookEvent delivered to ACTIVE endpoints of a workspace without
 *     FEATURE_WEBHOOKS (G1-14 / W2-05).
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("RG-13 machine-channel entitlements and quotas (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let ent: typeof import("../src/services/packaging/entitlement.service.js");
  let hooks: typeof import("../src/services/integrations/webhooks.service.js");
  let dispatcher: typeof import("../src/services/integrations/webhook-dispatcher.js");
  let lifecycle: typeof import("../src/services/packaging/webhooks/webhook-platform.service.js");
  const sent: string[] = [];
  let restoreHttp: (() => void) | null = null;
  const savedEnv: Record<string, string | undefined> = {};

  const grant = (teamId: string, key: string, value: number | boolean) =>
    ent.upsertEntitlementGrant({
      teamId,
      key: key as never,
      value,
      kind: typeof value === "boolean" ? "FEATURE" : key.startsWith("QUOTA_") ? "QUOTA" : "LIMIT",
      source: "CUSTOM",
      grantedByUserId: h.fixtures.teamA.ownerUserId,
    });

  const apiGet = (key: string) =>
    h.app.inject({
      method: "GET",
      url: "/v1/integrations/api/evidence?limit=1",
      headers: { authorization: `Bearer ${key}` },
    });

  beforeAll(async () => {
    for (const k of ["INTEGRATIONS_ENABLED", "API_KEY_SECRET", "WEBHOOK_ALLOW_PRIVATE_NETWORKS"]) savedEnv[k] = process.env[k];
    process.env.INTEGRATIONS_ENABLED = "true";
    process.env.API_KEY_SECRET = "ef".repeat(32);
    delete process.env.WEBHOOK_ALLOW_PRIVATE_NETWORKS;
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    await import("../src/register-shared-runtime.js");
    ent = await import("../src/services/packaging/entitlement.service.js");
    hooks = await import("../src/services/integrations/webhooks.service.js");
    dispatcher = await import("../src/services/integrations/webhook-dispatcher.js");
    lifecycle = await import("../src/services/packaging/webhooks/webhook-platform.service.js");
    restoreHttp = dispatcher.__setWebhookHttpClientForTests(async ({ url }) => {
      sent.push(url);
      return { status: 200, bodyPreview: null, errorMessage: null };
    });
  }, 180_000);

  afterAll(async () => {
    restoreHttp?.();
    if (prisma && h) {
      const where = { teamId: { in: [h.fixtures.teamA.teamId, h.fixtures.teamB.teamId] } };
      await prisma.lifecycleWebhookDelivery.deleteMany({ where }).catch(() => undefined);
      await prisma.lifecycleWebhookEndpoint.deleteMany({ where }).catch(() => undefined);
      await prisma.integrationWebhookDelivery.deleteMany({ where }).catch(() => undefined);
      await prisma.webhookEndpoint.deleteMany({ where }).catch(() => undefined);
      await prisma.entitlementUsage.deleteMany({ where }).catch(() => undefined);
      await prisma.entitlementGrant.deleteMany({ where }).catch(() => undefined);
    }
    await h?.cleanup();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("PRO-G1-14: an issued key is refused (403 ENTITLEMENT_REQUIRED, not revoked) once the entitlement is gone, and works again when restored", async () => {
    const { teamB } = h.fixtures;
    await grant(teamB.teamId, "INTEGRATION_API_KEYS_MAX", 3);
    await grant(teamB.teamId, "QUOTA_API_REQUESTS_PER_DAY", 100);
    const { createApiCredential } = await import("../src/services/integrations/api-keys.service.js");
    const { rawKey, credential } = await createApiCredential({
      teamId: teamB.teamId,
      name: "g1-14",
      scopes: ["integration.evidence.read"],
      actorUserId: teamB.ownerUserId,
    });
    const entitled = await apiGet(rawKey);
    expect(entitled.statusCode, entitled.body).toBe(200);

    // The grant is removed (an operator, a lapsed product line): the value resolves to the default 0.
    await prisma.entitlementGrant.deleteMany({ where: { teamId: teamB.teamId, key: "INTEGRATION_API_KEYS_MAX" } });
    const lapsed = await apiGet(rawKey);
    expect(lapsed.statusCode, lapsed.body).toBe(403);
    expect(lapsed.json()).toMatchObject({ error: { code: "ENTITLEMENT_REQUIRED", key: "INTEGRATION_API_KEYS_MAX" } });
    const row = await prisma.apiCredential.findUniqueOrThrow({ where: { id: credential.id }, select: { status: true } });
    expect(row.status).toBe("ACTIVE");

    await grant(teamB.teamId, "INTEGRATION_API_KEYS_MAX", 3);
    const restored = await apiGet(rawKey);
    expect(restored.statusCode, restored.body).toBe(200);
  });

  it("PRO-G1-04 / BL2-04: QUOTA_API_REQUESTS_PER_DAY is metered per UTC day; at quota the call is 429 and nothing more is counted", async () => {
    const { teamA } = h.fixtures;
    await grant(teamA.teamId, "INTEGRATION_API_KEYS_MAX", 3);
    await grant(teamA.teamId, "QUOTA_API_REQUESTS_PER_DAY", 2);
    const { createApiCredential } = await import("../src/services/integrations/api-keys.service.js");
    const { rawKey } = await createApiCredential({
      teamId: teamA.teamId,
      name: "g1-04",
      scopes: ["integration.evidence.read"],
      actorUserId: teamA.ownerUserId,
    });
    expect((await apiGet(rawKey)).statusCode).toBe(200);
    expect((await apiGet(rawKey)).statusCode).toBe(200);
    const over = await apiGet(rawKey);
    expect(over.statusCode, over.body).toBe(429);
    expect(over.json()).toMatchObject({ error: { code: "QUOTA_EXCEEDED", key: "QUOTA_API_REQUESTS_PER_DAY", limit: 2 } });
    expect(Number(over.headers["retry-after"])).toBeGreaterThan(0);
    const meter = await prisma.entitlementUsage.findMany({
      where: { teamId: teamA.teamId, key: "QUOTA_API_REQUESTS_PER_DAY" },
    });
    expect(meter).toHaveLength(1);
    expect(Number(meter[0]!.consumed)).toBe(2);
    const d = new Date();
    expect(meter[0]!.periodStartUtc.toISOString()).toBe(
      new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString(),
    );
  });

  it("the per-use meter admits exactly one of N concurrent units at limit - 1", async () => {
    const { teamB } = h.fixtures;
    await grant(teamB.teamId, "QUOTA_WEBHOOK_DELIVERIES_PER_DAY", 5);
    await prisma.entitlementUsage.deleteMany({ where: { teamId: teamB.teamId, key: "QUOTA_WEBHOOK_DELIVERIES_PER_DAY" } });
    for (let i = 0; i < 4; i += 1) {
      expect((await ent.consumeQuotaEntitlement({ teamId: teamB.teamId, key: "QUOTA_WEBHOOK_DELIVERIES_PER_DAY" })).ok).toBe(true);
    }
    const results = await Promise.all(
      Array.from({ length: 8 }, () => ent.consumeQuotaEntitlement({ teamId: teamB.teamId, key: "QUOTA_WEBHOOK_DELIVERIES_PER_DAY" })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const meter = await prisma.entitlementUsage.findFirstOrThrow({
      where: { teamId: teamB.teamId, key: "QUOTA_WEBHOOK_DELIVERIES_PER_DAY" },
    });
    expect(Number(meter.consumed)).toBe(5);
  });

  it("PRO-G1-05: integration webhook endpoints are counted against INTEGRATION_WEBHOOK_ENDPOINTS_MAX; concurrent creates at limit - 1 admit one; re-enable is counted", async () => {
    const { teamA } = h.fixtures;
    await grant(teamA.teamId, "FEATURE_WEBHOOKS", true);
    await grant(teamA.teamId, "INTEGRATION_WEBHOOK_ENDPOINTS_MAX", 2);
    const create = () =>
      hooks.createWebhookEndpoint({
        teamId: teamA.teamId,
        url: `https://203.0.113.10/hook/${randomUUID()}`,
        eventTypes: [],
        actorUserId: teamA.ownerUserId,
      });
    const first = await create();
    const racers = await Promise.allSettled(Array.from({ length: 6 }, () => create()));
    expect(racers.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = racers.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: "webhook_endpoint_limit_reached", details: { limit: 2, current: 2 } });
    expect(await prisma.webhookEndpoint.count({ where: { teamId: teamA.teamId, status: "ACTIVE" } })).toBe(2);

    await hooks.updateWebhookEndpoint({ id: first.endpoint.id, teamId: teamA.teamId, status: "DISABLED" });
    await create(); // the freed place is taken
    await expect(
      hooks.updateWebhookEndpoint({ id: first.endpoint.id, teamId: teamA.teamId, status: "ACTIVE" }),
    ).rejects.toMatchObject({ code: "webhook_endpoint_limit_reached" });
  });

  it("PRO-G1-14 / W2-05 / BL2-04: integration emit asks FEATURE_WEBHOOKS and the daily delivery quota per delivery, and records withheld deliveries", async () => {
    const { teamA } = h.fixtures;
    await prisma.integrationWebhookDelivery.deleteMany({ where: { teamId: teamA.teamId } });
    await prisma.entitlementUsage.deleteMany({ where: { teamId: teamA.teamId, key: "QUOTA_WEBHOOK_DELIVERIES_PER_DAY" } });
    const active = await prisma.webhookEndpoint.count({ where: { teamId: teamA.teamId, status: "ACTIVE" } });
    expect(active).toBe(2);
    await grant(teamA.teamId, "QUOTA_WEBHOOK_DELIVERIES_PER_DAY", 3);
    sent.length = 0;

    const first = await dispatcher.emitWebhookEvent({ teamId: teamA.teamId, eventType: "evidence.created", payload: {} });
    expect(first).toMatchObject({ enqueued: 2, delivered: 2 });
    // One unit left: one endpoint delivers, the other is withheld for the quota.
    const second = await dispatcher.emitWebhookEvent({ teamId: teamA.teamId, eventType: "evidence.created", payload: {} });
    expect(second.enqueued).toBe(1);
    expect(sent).toHaveLength(3);
    expect(
      await prisma.integrationWebhookDelivery.count({
        where: { teamId: teamA.teamId, status: "CANCELLED", errorMessage: "withheld:quota_exceeded" },
      }),
    ).toBe(1);

    // The entitlement is lost: nothing is sent, the deliveries record why, the endpoints stay ACTIVE.
    await prisma.entitlementGrant.deleteMany({ where: { teamId: teamA.teamId, key: "FEATURE_WEBHOOKS" } });
    await grant(teamA.teamId, "QUOTA_WEBHOOK_DELIVERIES_PER_DAY", 1000);
    const lapsed = await dispatcher.emitWebhookEvent({ teamId: teamA.teamId, eventType: "evidence.created", payload: {} });
    expect(lapsed.enqueued).toBe(0);
    expect(sent).toHaveLength(3);
    expect(
      await prisma.integrationWebhookDelivery.count({
        where: { teamId: teamA.teamId, status: "CANCELLED", errorMessage: "withheld:entitlement_required" },
      }),
    ).toBe(2);
    expect(await prisma.webhookEndpoint.count({ where: { teamId: teamA.teamId, status: "ACTIVE" } })).toBe(2);
  });

  it("PRO-G1-14: a scheduled retry of a delivery admitted while entitled is withheld after the entitlement is lost", async () => {
    const { teamA } = h.fixtures;
    const endpoint = await prisma.webhookEndpoint.findFirstOrThrow({ where: { teamId: teamA.teamId, status: "ACTIVE" } });
    const row = await prisma.integrationWebhookDelivery.create({
      data: {
        endpointId: endpoint.id,
        teamId: teamA.teamId,
        eventId: randomUUID(),
        eventType: "evidence.created",
        payloadJson: {},
        status: "RETRY_SCHEDULED",
        attemptCount: 1,
        nextAttemptAtUtc: new Date(Date.now() - 1000),
      },
    });
    sent.length = 0;
    const { processDueWebhookRetries } = await import("../src/services/integrations/webhook-retry-processor.js");
    await processDueWebhookRetries({ batchSize: 50 });
    expect(sent).toHaveLength(0);
    const after = await prisma.integrationWebhookDelivery.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ status: "CANCELLED", errorMessage: "withheld:entitlement_required" });
  });

  it("PRO-R3-07: a product-line (PLAN) grant stops answering while the paid subscription is terminally lapsed; a bounded CUSTOM exception does not", async () => {
    const { teamB } = h.fixtures;
    await prisma.team.update({ where: { id: teamB.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
    await ent.upsertEntitlementGrant({
      teamId: teamB.teamId,
      key: "FEATURE_REDACTION",
      value: true,
      kind: "FEATURE",
      source: "PLAN",
      productLine: "CAPTURE_AND_VERIFY",
      grantedByUserId: teamB.ownerUserId,
    });
    const read = () => ent.resolveEntitlement({ teamId: teamB.teamId, key: "FEATURE_REDACTION" }).then((p) => p.value);
    expect(await read()).toBe(true);
    // The paid subscription ended (cancelled, period over): lifecycle CANCELLED.
    const sub = await prisma.subscription.create({
      data: {
        userId: teamB.ownerUserId,
        teamId: teamB.teamId,
        provider: "STRIPE",
        providerSubId: `sub_wsent_${randomUUID()}`,
        status: "CANCELED",
        plan: "TEAM",
        currentPeriodEnd: new Date(Date.now() - 86_400_000),
      } as never,
    });
    try {
      expect(await read()).toBe(false);
      // An operator exception with a stated end still answers.
      await ent.upsertEntitlementGrant({
        teamId: teamB.teamId,
        key: "FEATURE_REDACTION",
        value: true,
        kind: "FEATURE",
        source: "CUSTOM",
        grantedByUserId: teamB.ownerUserId,
        expiresAtUtc: new Date(Date.now() + 86_400_000),
      });
      expect(await read()).toBe(true);
    } finally {
      await prisma.subscription.delete({ where: { id: sub.id } });
      await prisma.team.update({ where: { id: teamB.teamId }, data: { billingStatus: "ACTIVE", billingPlan: "FREE" } });
      await prisma.entitlementGrant.deleteMany({ where: { teamId: teamB.teamId, key: "FEATURE_REDACTION" } });
    }
  });

  it("PRO-W2-05: the lifecycle emit withholds deliveries of an unentitled workspace and records the reason", async () => {
    const { teamA } = h.fixtures;
    const ep = await prisma.lifecycleWebhookEndpoint.create({
      data: {
        teamId: teamA.teamId,
        url: "https://203.0.113.10/lifecycle",
        secret: Buffer.from(randomUUID()).toString("base64"),
        subscribedEvents: ["EVIDENCE_CREATED"],
        state: "ACTIVE",
        createdByUserId: teamA.ownerUserId,
      },
    });
    const out = await lifecycle.emitWebhookEvent({ teamId: teamA.teamId, eventKind: "EVIDENCE_CREATED" as never, payload: { a: 1 } });
    expect(out.deliveryIds).toHaveLength(0);
    const rows = await prisma.lifecycleWebhookDelivery.findMany({ where: { endpointId: ep.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "WITHHELD", responseBodyPreview: "withheld:entitlement_required" });

    await grant(teamA.teamId, "FEATURE_WEBHOOKS", true);
    const resumed = await lifecycle.emitWebhookEvent({ teamId: teamA.teamId, eventKind: "EVIDENCE_CREATED" as never, payload: { a: 2 } });
    expect(resumed.deliveryIds).toHaveLength(1);
  });
});
