/**
 * BATCH J — POST /v1/integrations/webhook-deliveries/:id/cancel writes an
 * audit record.
 *
 * The production route module is registered on a real Fastify instance and
 * driven with injected requests. Authentication, the canonical authorization
 * gate, the feature flag, the delivery service and the database client are
 * substituted at their module boundaries; the routing, the request schema,
 * the status mapping and the audit write are the shipped ones.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  activity: [] as Array<Record<string, unknown>>,
  cancel: null as null | ((input: { id: string; teamId: string }) => Promise<Record<string, unknown>>),
  authorized: true,
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: async () => undefined,
}));

vi.mock("../src/middleware/authorize.js", () => ({
  authorizeOrFail: async (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
    if (!H.authorized) {
      reply.code(404).send({ error: { code: "NOT_FOUND" } });
      return null;
    }
    return { actorUserId: "actor-1" };
  },
}));

vi.mock("../src/db.js", () => ({
  prisma: {
    teamActivity: {
      create: async (args: { data: Record<string, unknown> }) => {
        H.activity.push(args.data);
        return args.data;
      },
    },
  },
}));

vi.mock("../src/services/integrations/api-keys.service.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "../src/services/integrations/api-keys.service.js",
  );
  return { ...actual, integrationsFeatureDisabledReason: () => null };
});

vi.mock("../src/services/integrations/webhook-deliveries.service.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "../src/services/integrations/webhook-deliveries.service.js",
  );
  return {
    ...actual,
    cancelWebhookDelivery: (input: { id: string; teamId: string }) => H.cancel!(input),
  };
});

import { integrationsRoutes } from "../src/routes/integrations.routes.js";
import { WebhookDeliveryOpError } from "../src/services/integrations/webhook-deliveries.service.js";

const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DELIVERY = "11111111-1111-4111-8111-111111111111";
const ENDPOINT = "22222222-2222-4222-8222-222222222222";

function row(status: string): Record<string, unknown> {
  const now = new Date("2026-09-01T10:00:00.000Z");
  return {
    id: DELIVERY,
    endpointId: ENDPOINT,
    teamId: TEAM,
    eventId: "33333333-3333-4333-8333-333333333333",
    eventType: "evidence.created",
    payload: { secret: "must-not-leak" },
    status,
    attemptCount: 2,
    nextAttemptAtUtc: null,
    responseStatus: 500,
    responseBodyPreview: "server said no",
    errorMessage: "cancelled_by_operator",
    sentAtUtc: null,
    failedAtUtc: now,
    createdAt: now,
    updatedAt: now,
  };
}

let app: FastifyInstance;
beforeEach(async () => {
  H.activity = [];
  H.authorized = true;
  H.cancel = async () => row("CANCELLED");
  app = Fastify();
  await app.register(integrationsRoutes);
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

function cancel() {
  return app.inject({
    method: "POST",
    url: `/v1/integrations/webhook-deliveries/${DELIVERY}/cancel`,
    payload: { teamId: TEAM },
  });
}

describe("webhook delivery cancel — audit", () => {
  it("records integration.webhook.delivery_cancelled with bounded metadata", async () => {
    const res = await cancel();
    expect(res.statusCode).toBe(200);
    expect(res.json().delivery.status).toBe("CANCELLED");
    expect(H.activity).toHaveLength(1);
    expect(H.activity[0]).toMatchObject({
      teamId: TEAM,
      actorUserId: "actor-1",
      eventType: "integration.webhook.delivery_cancelled",
      targetType: "webhook_endpoint",
      targetId: ENDPOINT,
      metadata: { deliveryId: DELIVERY, eventType: "evidence.created", status: "CANCELLED", attemptCount: 2 },
    });
    const serialized = JSON.stringify(H.activity[0]);
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("server said no");
  });

  it("writes no audit when the delivery was not cancellable (409)", async () => {
    H.cancel = async () => {
      throw new WebhookDeliveryOpError("delivery_not_cancellable");
    };
    const res = await cancel();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: { code: "delivery_not_cancellable" } });
    expect(H.activity).toHaveLength(0);
  });

  it("writes no audit when the delivery does not exist (404)", async () => {
    H.cancel = async () => {
      throw new WebhookDeliveryOpError("delivery_not_found");
    };
    const res = await cancel();
    expect(res.statusCode).toBe(404);
    expect(H.activity).toHaveLength(0);
  });

  it("writes no audit when a concurrent change left the row in another state", async () => {
    H.cancel = async () => row("SENT");
    const res = await cancel();
    expect(res.statusCode).toBe(200);
    expect(H.activity).toHaveLength(0);
  });

  it("writes no audit and never reaches the service when authorization refuses", async () => {
    H.authorized = false;
    let reached = false;
    H.cancel = async () => {
      reached = true;
      return row("CANCELLED");
    };
    const res = await cancel();
    expect(res.statusCode).toBe(404);
    expect(reached).toBe(false);
    expect(H.activity).toHaveLength(0);
  });
});
