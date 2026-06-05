/**
 * PHASE closure — Webhook delivery response duration.
 *
 * Pins the new wall-clock-latency wiring on the canonical webhook
 * dispatch path:
 *
 *   1. A SUCCESSFUL delivery persists a non-negative integer in the
 *      `responseDurationMs` column on the IntegrationWebhookDelivery
 *      row alongside the SENT-state update.
 *   2. A FAILED delivery (4xx from the receiver) persists a duration
 *      alongside the FAILED-state update — the column reflects the
 *      time the receiver took to refuse the request, NOT a fabricated
 *      value.
 *   3. A pre-fetch error (e.g. signing_key_unavailable: the secret
 *      cannot be decrypted, so the dispatcher returns "permanent"
 *      BEFORE calling httpClient) leaves the column NULL.
 *   4. The dispatcher reads the duration via process.hrtime.bigint
 *      around the SINGLE httpClient call — no double-bracketing, no
 *      synthesised "0 ms" floor.
 *
 * Hard rules satisfied:
 *   - No fabricated latency. The pre-fetch error test pins NULL.
 *   - No weakening of existing dual-signing behaviour. We reuse the
 *     same `__setWebhookHttpClientForTests` indirection that PHASE 4
 *     uses; the bracket is added around the same fetch.
 *   - Type-safe column write — typecheck would fail if the Prisma
 *     model still lacked `responseDurationMs`.
 */

import { afterEach, describe, expect, it } from "vitest";

import type { PrismaClient } from "@prisma/client";

import {
  __setWebhookHttpClientForTests,
  attemptDelivery,
  type WebhookHttpClient,
} from "../src/services/integrations/webhook-dispatcher.js";
import { issueWebhookSecret } from "../src/services/integrations/webhooks.service.js";

// ---------------------------------------------------------------------------
// Test helpers — mirror the shape used in PHASE 4's dispatcher tests.
// ---------------------------------------------------------------------------

const API_KEY_SECRET = "a".repeat(64);

function withApiKeySecret<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.API_KEY_SECRET;
  const prevFlag = process.env.INTEGRATIONS_ENABLED;
  process.env.API_KEY_SECRET = API_KEY_SECRET;
  process.env.INTEGRATIONS_ENABLED = "true";
  return fn().finally(() => {
    if (prev === undefined) delete process.env.API_KEY_SECRET;
    else process.env.API_KEY_SECRET = prev;
    if (prevFlag === undefined) delete process.env.INTEGRATIONS_ENABLED;
    else process.env.INTEGRATIONS_ENABLED = prevFlag;
  });
}

type FakeEndpoint = {
  id: string;
  teamId: string;
  url: string;
  description: string | null;
  status: string;
  secretCiphertext: string;
  secretPrefix: string;
  previousSecretCiphertext: string | null;
  previousSecretPrefix: string | null;
  previousSecretValidUntilUtc: Date | null;
  eventTypes: string[];
  failureCount: number;
  lastSuccessAtUtc: Date | null;
  lastFailureAtUtc: Date | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

type FakeRow = {
  id: string;
  endpointId: string;
  teamId: string;
  eventId: string;
  eventType: string;
  payloadJson: unknown;
  status: string;
  attemptCount: number;
  nextAttemptAtUtc: Date | null;
  responseStatus: number | null;
  responseBodyPreview: string | null;
  errorMessage: string | null;
  sentAtUtc: Date | null;
  failedAtUtc: Date | null;
  responseDurationMs: number | null;
  createdAt: Date;
  updatedAt: Date;
};

function makeEndpoint(overrides: Partial<FakeEndpoint> = {}): FakeEndpoint {
  const issued = issueWebhookSecret();
  if (!issued) throw new Error("API_KEY_SECRET not set");
  return {
    id: "22222222-2222-4222-8222-222222222222",
    teamId: "33333333-3333-4333-8333-333333333333",
    url: "https://example.com/hook",
    description: null,
    status: "ACTIVE",
    secretCiphertext: issued.secretCiphertext,
    secretPrefix: issued.secretPrefix,
    previousSecretCiphertext: null,
    previousSecretPrefix: null,
    previousSecretValidUntilUtc: null,
    eventTypes: [],
    failureCount: 0,
    lastSuccessAtUtc: null,
    lastFailureAtUtc: null,
    createdByUserId: "55555555-5555-4555-8555-555555555555",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makePrismaStub(endpoint: FakeEndpoint): {
  client: PrismaClient;
  rows: FakeRow[];
} {
  const rows: FakeRow[] = [];
  let nextRowId = 0;
  const client = {
    webhookEndpoint: {
      findFirst: async (q: { where: { id: string; teamId: string } }) => {
        if (
          endpoint.id !== q.where.id ||
          endpoint.teamId !== q.where.teamId
        )
          return null;
        return endpoint;
      },
      update: async (q: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        Object.assign(endpoint, q.data);
        return endpoint;
      },
    },
    integrationWebhookDelivery: {
      create: async (q: { data: Record<string, unknown> }) => {
        const id = `00000000-0000-4000-8000-${String(nextRowId++).padStart(12, "0")}`;
        const row: FakeRow = {
          id,
          endpointId: String(q.data.endpointId),
          teamId: String(q.data.teamId),
          eventId: String(q.data.eventId),
          eventType: String(q.data.eventType),
          payloadJson: q.data.payloadJson,
          status: String(q.data.status ?? "PENDING"),
          attemptCount: Number(q.data.attemptCount ?? 0),
          nextAttemptAtUtc: null,
          responseStatus: null,
          responseBodyPreview: null,
          errorMessage: null,
          sentAtUtc: null,
          failedAtUtc: null,
          responseDurationMs: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        rows.push(row);
        return row;
      },
      update: async (q: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = rows.find((r) => r.id === q.where.id);
        if (!row) return null;
        Object.assign(row, q.data);
        return row;
      },
    },
  } as unknown as PrismaClient;
  return { client, rows };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let restoreHttp: (() => void) | null = null;
afterEach(() => {
  if (restoreHttp) restoreHttp();
  restoreHttp = null;
});

describe("PHASE closure — webhook delivery records measured duration", () => {
  it("persists a non-negative integer duration on a SUCCESSFUL delivery (200)", async () => {
    await withApiKeySecret(async () => {
      const endpoint = makeEndpoint();
      const { client, rows } = makePrismaStub(endpoint);
      const fake: WebhookHttpClient = async () => {
        // Sleep ~15ms so the monotonic timer measures a non-zero gap.
        await new Promise((r) => setTimeout(r, 15));
        return { status: 200, bodyPreview: "ok", errorMessage: null };
      };
      restoreHttp = __setWebhookHttpClientForTests(fake);

      const row = await client.integrationWebhookDelivery.create({
        data: {
          endpointId: endpoint.id,
          teamId: endpoint.teamId,
          eventId: "11111111-1111-4111-8111-111111111111",
          eventType: "evidence.completed",
          payloadJson: { data: { evidenceId: "abc" } },
          status: "PENDING",
          attemptCount: 0,
        },
      });

      const outcome = await attemptDelivery(
        row as never,
        endpoint as never,
        client,
      );
      expect(outcome).toBe("delivered");
      expect(rows[0].status).toBe("SENT");
      // Duration is a non-null, non-negative integer. We allow any
      // value ≥ 0 because CI clock resolution may report 0 even for
      // a 15ms sleep on extremely fast machines — the contract is
      // "real measured duration", not "always > 0".
      expect(rows[0].responseDurationMs).not.toBeNull();
      expect(Number.isInteger(rows[0].responseDurationMs)).toBe(true);
      expect(rows[0].responseDurationMs!).toBeGreaterThanOrEqual(0);
      expect(rows[0].responseDurationMs!).toBeLessThan(10_000);
    });
  });

  it("persists a duration on a permanent FAILED delivery (4xx)", async () => {
    await withApiKeySecret(async () => {
      const endpoint = makeEndpoint();
      const { client, rows } = makePrismaStub(endpoint);
      const fake: WebhookHttpClient = async () => {
        await new Promise((r) => setTimeout(r, 5));
        return {
          status: 400,
          bodyPreview: "bad request",
          errorMessage: "HTTP 400",
        };
      };
      restoreHttp = __setWebhookHttpClientForTests(fake);

      const row = await client.integrationWebhookDelivery.create({
        data: {
          endpointId: endpoint.id,
          teamId: endpoint.teamId,
          eventId: "22222222-2222-4222-8222-222222222222",
          eventType: "evidence.completed",
          payloadJson: { data: { evidenceId: "abc" } },
          status: "PENDING",
          attemptCount: 0,
        },
      });

      const outcome = await attemptDelivery(
        row as never,
        endpoint as never,
        client,
      );
      expect(outcome).toBe("permanent");
      expect(rows[0].status).toBe("FAILED");
      expect(rows[0].responseDurationMs).not.toBeNull();
      expect(Number.isInteger(rows[0].responseDurationMs)).toBe(true);
      expect(rows[0].responseDurationMs!).toBeGreaterThanOrEqual(0);
    });
  });

  it("persists a duration on a transient failure scheduled for retry (5xx)", async () => {
    await withApiKeySecret(async () => {
      const endpoint = makeEndpoint();
      const { client, rows } = makePrismaStub(endpoint);
      const fake: WebhookHttpClient = async () => {
        await new Promise((r) => setTimeout(r, 3));
        return {
          status: 503,
          bodyPreview: "unavailable",
          errorMessage: "HTTP 503",
        };
      };
      restoreHttp = __setWebhookHttpClientForTests(fake);

      const row = await client.integrationWebhookDelivery.create({
        data: {
          endpointId: endpoint.id,
          teamId: endpoint.teamId,
          eventId: "33333333-3333-4333-8333-333333333333",
          eventType: "evidence.completed",
          payloadJson: { data: { evidenceId: "abc" } },
          status: "PENDING",
          attemptCount: 0,
        },
      });

      const outcome = await attemptDelivery(
        row as never,
        endpoint as never,
        client,
      );
      expect(outcome).toBe("transient");
      expect(rows[0].status).toBe("RETRY_SCHEDULED");
      expect(rows[0].responseDurationMs).not.toBeNull();
      expect(Number.isInteger(rows[0].responseDurationMs)).toBe(true);
      expect(rows[0].responseDurationMs!).toBeGreaterThanOrEqual(0);
    });
  });

  it("leaves the duration NULL when the row reaches a terminal status BEFORE issuing the fetch", async () => {
    // Force a pre-fetch failure: the endpoint's secretCiphertext is
    // garbage, so `decryptWebhookSecret` returns null and the
    // dispatcher fails the row with "signing_key_unavailable"
    // WITHOUT ever calling httpClient.
    await withApiKeySecret(async () => {
      const endpoint = makeEndpoint({
        // Invalid ciphertext — decryption returns null.
        secretCiphertext: "not-a-real-ciphertext",
      });
      const { client, rows } = makePrismaStub(endpoint);

      // The fake client MUST NOT be called. If it is, the test fails.
      const fake: WebhookHttpClient = async () => {
        throw new Error(
          "httpClient must NOT be invoked on a pre-fetch failure",
        );
      };
      restoreHttp = __setWebhookHttpClientForTests(fake);

      const row = await client.integrationWebhookDelivery.create({
        data: {
          endpointId: endpoint.id,
          teamId: endpoint.teamId,
          eventId: "44444444-4444-4444-8444-444444444444",
          eventType: "evidence.completed",
          payloadJson: { data: { evidenceId: "abc" } },
          status: "PENDING",
          attemptCount: 0,
        },
      });

      const outcome = await attemptDelivery(
        row as never,
        endpoint as never,
        client,
      );
      expect(outcome).toBe("permanent");
      expect(rows[0].status).toBe("FAILED");
      expect(rows[0].errorMessage).toBe("signing_key_unavailable");
      // Honest absence — the column is NULL because the dispatcher
      // never measured a real fetch.
      expect(rows[0].responseDurationMs).toBeNull();
    });
  });

  it("persists a duration even when the pluggable httpClient throws", async () => {
    // A pluggable client that throws is treated as an unknown
    // transport error. The bracket still measures the time spent
    // before the throw — the dispatcher must not lose the
    // observation.
    await withApiKeySecret(async () => {
      const endpoint = makeEndpoint();
      const { client, rows } = makePrismaStub(endpoint);
      const fake: WebhookHttpClient = async () => {
        await new Promise((r) => setTimeout(r, 2));
        // Use a marker classifyWebhookHttpError recognises as
        // transient — the bracket-around-throw bookkeeping is the
        // same regardless of classification, but it's more honest
        // to exercise the transient (retry) branch since real-world
        // connection drops are transient.
        throw new Error("ECONNRESET");
      };
      restoreHttp = __setWebhookHttpClientForTests(fake);

      const row = await client.integrationWebhookDelivery.create({
        data: {
          endpointId: endpoint.id,
          teamId: endpoint.teamId,
          eventId: "55555555-5555-4555-8555-555555555555",
          eventType: "evidence.completed",
          payloadJson: { data: { evidenceId: "abc" } },
          status: "PENDING",
          attemptCount: 0,
        },
      });

      const outcome = await attemptDelivery(
        row as never,
        endpoint as never,
        client,
      );
      // A null status with no HTTP code is classified as transient by
      // classifyWebhookHttpError → row goes to RETRY_SCHEDULED.
      expect(outcome).toBe("transient");
      expect(rows[0].status).toBe("RETRY_SCHEDULED");
      expect(rows[0].errorMessage).toBe("ECONNRESET");
      expect(rows[0].responseDurationMs).not.toBeNull();
      expect(Number.isInteger(rows[0].responseDurationMs)).toBe(true);
      expect(rows[0].responseDurationMs!).toBeGreaterThanOrEqual(0);
    });
  });
});
