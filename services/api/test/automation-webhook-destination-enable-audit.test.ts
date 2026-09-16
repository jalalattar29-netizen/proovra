/**
 * BATCH J — enabling an automation webhook destination is audited.
 *
 * POST /v1/automation/webhooks/:id/disable always emitted
 * automation_webhook_destination_disabled; the enable leg emitted nothing,
 * although it is the control that resumes outbound deliveries after the
 * runtime auto-disabled a failing receiver. The production route module is
 * registered on a real Fastify instance; authentication, authorization, the
 * database client and the security-event sink are substituted at their
 * module boundaries.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  authorized: true,
  exists: true,
}));

vi.mock("../src/middleware/auth.js", () => ({ requireAuth: async () => undefined }));

vi.mock("../src/middleware/authorize.js", () => ({
  authorizeOrFail: async (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
    if (!H.authorized) {
      reply.code(404).send({ message: "Not found" });
      return null;
    }
    return { actorUserId: "actor-1" };
  },
}));

vi.mock("../src/services/security/security-event.service.js", () => ({
  safeEmitSecurityEvent: (input: Record<string, unknown>) => {
    H.events.push(input);
  },
}));

const TEAM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEST = "11111111-1111-4111-8111-111111111111";

function destination(enabled: boolean) {
  const now = new Date("2026-09-01T10:00:00.000Z");
  return {
    id: DEST, teamId: TEAM, name: "Receiver", url: "https://receiver.example/hook",
    urlOrigin: "https://receiver.example", secretFingerprint: "fp", encryptedSecret: "never-projected",
    enabled, createdByUserId: "u", updatedByUserId: "actor-1", createdAt: now, updatedAt: now,
    disabledAt: enabled ? null : now, lastSuccessAt: null, lastFailureAt: now, failureCount: 5,
  };
}

vi.mock("../src/db.js", () => ({
  prisma: {
    automationWebhookDestination: {
      findUnique: async () => (H.exists ? destination(false) : null),
      update: async (args: { data: Record<string, unknown> }) => {
        H.updates.push(args.data);
        return destination(args.data.enabled === true);
      },
    },
  },
}));

import { automationWebhooksRoutes } from "../src/routes/automation-webhooks.routes.js";

let app: FastifyInstance;
beforeEach(async () => {
  H.events = [];
  H.updates = [];
  H.authorized = true;
  H.exists = true;
  app = Fastify();
  await app.register(automationWebhooksRoutes);
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

const post = (leg: "enable" | "disable") =>
  app.inject({ method: "POST", url: `/v1/automation/webhooks/${DEST}/${leg}`, payload: {} });

describe("automation webhook destination enable/disable audit", () => {
  it("enable writes the state change and an audit event naming the actor", async () => {
    const res = await post("enable");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: DEST, enabled: true, disabledAt: null });
    expect(res.json()).not.toHaveProperty("revealedSecret");
    expect(res.body).not.toContain("never-projected");
    expect(H.updates[0]).toMatchObject({ enabled: true, disabledAt: null, updatedByUserId: "actor-1" });
    expect(H.events).toEqual([
      expect.objectContaining({
        teamId: TEAM,
        eventType: "automation_webhook_destination_updated",
        details: { destinationId: DEST, actorUserId: "actor-1", enabledChanged: true, enabled: true },
      }),
    ]);
  });

  it("disable keeps its dedicated audit event", async () => {
    const res = await post("disable");
    expect(res.statusCode).toBe(200);
    expect(H.events).toEqual([
      expect.objectContaining({ eventType: "automation_webhook_destination_disabled", details: { destinationId: DEST, actorUserId: "actor-1" } }),
    ]);
  });

  it("a refused or missing destination writes nothing and audits nothing", async () => {
    H.authorized = false;
    expect((await post("enable")).statusCode).toBe(404);
    H.authorized = true;
    H.exists = false;
    expect((await post("enable")).statusCode).toBe(404);
    expect(H.updates).toHaveLength(0);
    expect(H.events).toHaveLength(0);
  });
});
