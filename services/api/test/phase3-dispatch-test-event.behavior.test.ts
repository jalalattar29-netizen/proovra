/**
 * PHASE 3 — Behavioral test for `dispatchTestEventToEndpoint`.
 *
 * Verifies the dispatcher helper using an in-memory prisma stub + the
 * pluggable HTTP transport. NEVER exercises the real Prisma client
 * (the schema is well-covered by the rotation behavior test suite);
 * these are surgical contract tests for the new helper.
 *
 *   - SENT outcome on 200 response (delivery row written with
 *     eventType="webhook.test", status="SENT").
 *   - FAILED outcome on 4xx response (classified as permanent).
 *   - null result when the endpoint is missing.
 *   - null result when the endpoint is DISABLED.
 *   - null result when the lookup is for the wrong team.
 *   - Bounded payload: a > TEST_EVENT_MAX_PAYLOAD_BYTES blob is
 *     replaced with the sentinel "exceeded_size_cap" so the
 *     connectivity signal is preserved.
 */

import { describe, expect, it, afterEach } from "vitest";

import type { PrismaClient } from "@prisma/client";

import {
  TEST_EVENT_MAX_PAYLOAD_BYTES,
  TEST_EVENT_TYPE,
  __setWebhookHttpClientForTests,
  dispatchTestEventToEndpoint,
  type WebhookHttpClient,
  type WebhookHttpResponse,
} from "../src/services/integrations/webhook-dispatcher.js";
import { issueWebhookSecret } from "../src/services/integrations/webhooks.service.js";

// ---------------------------------------------------------------------------
// Helpers
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

// In-memory prisma stub. Captures every delivery row create and every
// subsequent update so tests can assert the final shape.
function makePrismaStub(endpoint: FakeEndpoint | null): {
  client: PrismaClient;
  rows: FakeRow[];
  endpointFindCalls: Array<{ id: string; teamId: string }>;
} {
  const rows: FakeRow[] = [];
  const endpointFindCalls: Array<{ id: string; teamId: string }> = [];
  let nextRowId = 0;
  const client = {
    webhookEndpoint: {
      findFirst: async (q: { where: { id: string; teamId: string } }) => {
        endpointFindCalls.push({
          id: q.where.id,
          teamId: q.where.teamId,
        });
        if (
          !endpoint ||
          endpoint.id !== q.where.id ||
          endpoint.teamId !== q.where.teamId
        ) {
          return null;
        }
        return endpoint;
      },
      update: async (q: { where: { id: string }; data: Record<string, unknown> }) => {
        // Operational counter updates from recordWebhookEndpointSuccess /
        // recordWebhookEndpointFailure — ignored for the assertions.
        void q;
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
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        rows.push(row);
        return row;
      },
      update: async (q: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.find((r) => r.id === q.where.id);
        if (!row) return null;
        Object.assign(row, q.data);
        return row;
      },
    },
  } as unknown as PrismaClient;
  return { client, rows, endpointFindCalls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let restoreHttp: (() => void) | null = null;
afterEach(() => {
  if (restoreHttp) restoreHttp();
  restoreHttp = null;
});

describe("PHASE 3 — dispatchTestEventToEndpoint behavior", () => {
  it("happy path: SENT outcome on a 200 response, row marked SENT with eventType webhook.test", async () => {
    await withApiKeySecret(async () => {
      const endpoint = makeEndpoint();
      const { client, rows } = makePrismaStub(endpoint);
      const captured: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
      const fake: WebhookHttpClient = async (req) => {
        captured.push({ url: req.url, body: req.body, headers: req.headers });
        const resp: WebhookHttpResponse = {
          status: 200,
          bodyPreview: "ok",
          errorMessage: null,
        };
        return resp;
      };
      restoreHttp = __setWebhookHttpClientForTests(fake);

      const result = await dispatchTestEventToEndpoint(
        {
          endpointId: endpoint.id,
          teamId: endpoint.teamId,
          payload: { hello: "from-test" },
        },
        client,
      );

      expect(result).not.toBeNull();
      expect(result!.outcome).toBe("delivered");
      expect(rows).toHaveLength(1);
      expect(rows[0].eventType).toBe(TEST_EVENT_TYPE);
      expect(rows[0].status).toBe("SENT");
      // payloadJson carries the canonical `kind="test"` marker.
      expect((rows[0].payloadJson as { kind: string }).kind).toBe("test");
      expect((rows[0].payloadJson as { data: { hello: string } }).data.hello).toBe(
        "from-test",
      );
      // The HTTP request was actually issued to the endpoint URL with
      // a signed X-Proovra-Signature header (canonical scheme).
      expect(captured).toHaveLength(1);
      expect(captured[0].url).toBe(endpoint.url);
      expect(captured[0].headers["x-proovra-event"]).toBe(TEST_EVENT_TYPE);
      expect(captured[0].headers["x-proovra-signature"]).toMatch(
        /^v1=[0-9a-f]{64}$/,
      );
    });
  });

  it("permanent failure on 400: delivery row marked FAILED", async () => {
    await withApiKeySecret(async () => {
      const endpoint = makeEndpoint();
      const { client, rows } = makePrismaStub(endpoint);
      const fake: WebhookHttpClient = async () => ({
        status: 400,
        bodyPreview: "bad",
        errorMessage: "HTTP 400",
      });
      restoreHttp = __setWebhookHttpClientForTests(fake);

      const result = await dispatchTestEventToEndpoint(
        { endpointId: endpoint.id, teamId: endpoint.teamId },
        client,
      );

      expect(result).not.toBeNull();
      expect(result!.outcome).toBe("permanent");
      expect(rows[0].status).toBe("FAILED");
      expect(rows[0].responseStatus).toBe(400);
    });
  });

  it("returns null when the endpoint is missing", async () => {
    await withApiKeySecret(async () => {
      const { client, rows } = makePrismaStub(null);
      const fake: WebhookHttpClient = async () => ({
        status: 200,
        bodyPreview: null,
        errorMessage: null,
      });
      restoreHttp = __setWebhookHttpClientForTests(fake);

      const result = await dispatchTestEventToEndpoint(
        {
          endpointId: "11111111-1111-4111-8111-111111111111",
          teamId: "33333333-3333-4333-8333-333333333333",
        },
        client,
      );
      expect(result).toBeNull();
      expect(rows).toHaveLength(0);
    });
  });

  it("returns null when the endpoint is DISABLED", async () => {
    await withApiKeySecret(async () => {
      const endpoint = makeEndpoint({ status: "DISABLED" });
      const { client, rows } = makePrismaStub(endpoint);
      const fake: WebhookHttpClient = async () => ({
        status: 200,
        bodyPreview: null,
        errorMessage: null,
      });
      restoreHttp = __setWebhookHttpClientForTests(fake);

      const result = await dispatchTestEventToEndpoint(
        { endpointId: endpoint.id, teamId: endpoint.teamId },
        client,
      );
      expect(result).toBeNull();
      expect(rows).toHaveLength(0);
    });
  });

  it("returns null when caller's teamId does not match (workspace isolation)", async () => {
    await withApiKeySecret(async () => {
      const endpoint = makeEndpoint();
      const { client, rows, endpointFindCalls } = makePrismaStub(endpoint);
      const fake: WebhookHttpClient = async () => ({
        status: 200,
        bodyPreview: null,
        errorMessage: null,
      });
      restoreHttp = __setWebhookHttpClientForTests(fake);

      const result = await dispatchTestEventToEndpoint(
        {
          endpointId: endpoint.id,
          teamId: "99999999-9999-4999-8999-999999999999",
        },
        client,
      );
      expect(result).toBeNull();
      expect(rows).toHaveLength(0);
      // The teamId was passed to the lookup; the stub rejected the
      // mismatch so isolation is enforced inside the helper.
      expect(endpointFindCalls).toHaveLength(1);
      expect(endpointFindCalls[0].teamId).toBe(
        "99999999-9999-4999-8999-999999999999",
      );
    });
  });

  it("payload exceeding cap is replaced with sentinel; the test event still goes out", async () => {
    await withApiKeySecret(async () => {
      const endpoint = makeEndpoint();
      const { client, rows } = makePrismaStub(endpoint);
      const fake: WebhookHttpClient = async () => ({
        status: 200,
        bodyPreview: "ok",
        errorMessage: null,
      });
      restoreHttp = __setWebhookHttpClientForTests(fake);

      // Build a payload deliberately larger than the cap.
      const huge: Record<string, unknown> = {
        blob: "x".repeat(TEST_EVENT_MAX_PAYLOAD_BYTES + 100),
      };
      const result = await dispatchTestEventToEndpoint(
        { endpointId: endpoint.id, teamId: endpoint.teamId, payload: huge },
        client,
      );

      expect(result).not.toBeNull();
      expect(result!.outcome).toBe("delivered");
      // The stored payload's `data` is the sentinel, not the huge blob.
      const stored = rows[0].payloadJson as {
        data: { ok?: boolean; payload_omitted?: string; blob?: string };
      };
      expect(stored.data.payload_omitted).toBe("exceeded_size_cap");
      expect(stored.data.blob).toBeUndefined();
    });
  });

  it("attemptInline=false enqueues without dispatching", async () => {
    await withApiKeySecret(async () => {
      const endpoint = makeEndpoint();
      const { client, rows } = makePrismaStub(endpoint);
      let httpCalls = 0;
      const fake: WebhookHttpClient = async () => {
        httpCalls += 1;
        return { status: 200, bodyPreview: null, errorMessage: null };
      };
      restoreHttp = __setWebhookHttpClientForTests(fake);

      const result = await dispatchTestEventToEndpoint(
        {
          endpointId: endpoint.id,
          teamId: endpoint.teamId,
          attemptInline: false,
        },
        client,
      );
      expect(result).not.toBeNull();
      expect(result!.outcome).toBe("queued");
      expect(httpCalls).toBe(0);
      // The row was still written so the retry sweeper can pick it up.
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("PENDING");
    });
  });
});
