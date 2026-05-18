/**
 * Phase 10 — Webhook dispatcher.
 *
 * Single entry point for "an interesting thing happened in this
 * workspace; tell subscribers." Producers (evidence service, requests
 * service, governance service, etc.) call `emitWebhookEvent({ teamId,
 * eventType, payload })` with a SAFE projection - no internal notes,
 * no legal-hold reasons, no token hashes.
 *
 * Per call we:
 *   1. Look up every ACTIVE endpoint for the workspace that subscribes
 *      to the event type (or to all events).
 *   2. Insert one IntegrationWebhookDelivery row per matching endpoint
 *      with status PENDING.
 *   3. Optionally attempt inline delivery once (best-effort). Failures
 *      transition the row to RETRY_SCHEDULED with `nextAttemptAtUtc`
 *      computed from the retry ladder; the retry processor takes over.
 *
 * NEVER throws into the producer. All errors are swallowed.
 */

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type {
  PrismaClient,
  IntegrationWebhookDelivery as DbDelivery,
  WebhookEndpoint as DbEndpoint,
} from "@prisma/client";
import {
  WEBHOOK_HEADER_EVENT,
  WEBHOOK_HEADER_EVENT_ID,
  WEBHOOK_HEADER_SIGNATURE,
  WEBHOOK_HEADER_TIMESTAMP,
  WEBHOOK_RETRY_MAX_ATTEMPTS,
  WebhookEventType,
  classifyWebhookHttpError,
  webhookRetryDelaySeconds,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { isIntegrationsFeatureEnabled } from "./api-keys.service.js";
import {
  decryptWebhookSecret,
  recordWebhookEndpointFailure,
  recordWebhookEndpointSuccess,
  signWebhookPayload,
} from "./webhooks.service.js";

// -----------------------------------------------------------------------------
// HTTP transport — pluggable for tests
// -----------------------------------------------------------------------------

export type WebhookHttpResponse = {
  status: number | null;
  bodyPreview: string | null;
  errorMessage: string | null;
};

export type WebhookHttpClient = (req: {
  url: string;
  body: string;
  headers: Record<string, string>;
  timeoutMs: number;
}) => Promise<WebhookHttpResponse>;

const DEFAULT_TIMEOUT_MS = 10_000;
const RESPONSE_BODY_PREVIEW_LIMIT = 2_000;
const RESPONSE_BODY_HARD_LIMIT = 64 * 1024;

/**
 * Phase 11 — SSRF hardening for outbound webhook delivery.
 *
 * Defaults:
 *   - `redirect: "manual"` so 3xx responses do not silently follow
 *     to a different host (the receiver could otherwise redirect us
 *     to localhost / metadata IPs).
 *   - Response body capped at 64 KiB before we touch the buffer;
 *     the on-record preview is then trimmed to 2 KiB.
 *   - Already enforced upstream: HTTPS-only, no private-network
 *     hosts, no credentials in the URL (see `validateWebhookUrl`).
 */
const defaultHttpClient: WebhookHttpClient = async ({
  url,
  body,
  headers,
  timeoutMs,
}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) {
      // Refuse to follow redirects. Common SSRF attack vector: an
      // attacker-controlled webhook URL replies 302 to an internal
      // host. We treat 3xx as a permanent classify-as-error.
      return {
        status: res.status,
        bodyPreview: null,
        errorMessage: "redirect_blocked",
      };
    }
    let text = "";
    try {
      const reader = res.body?.getReader();
      if (reader) {
        let received = 0;
        const chunks: Uint8Array[] = [];
        while (received < RESPONSE_BODY_HARD_LIMIT) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            const remaining = RESPONSE_BODY_HARD_LIMIT - received;
            chunks.push(
              value.length <= remaining ? value : value.subarray(0, remaining),
            );
            received += value.length;
          }
        }
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        const joined = Buffer.concat(chunks.map((c) => Buffer.from(c)));
        text = joined.toString("utf8");
      } else {
        text = await res.text();
      }
    } catch {
      text = "";
    }
    return {
      status: res.status,
      bodyPreview: text.slice(0, RESPONSE_BODY_PREVIEW_LIMIT),
      errorMessage:
        res.status >= 200 && res.status < 300
          ? null
          : `HTTP ${res.status}`,
    };
  } catch (err) {
    const msg =
      err && typeof err === "object" && "message" in err
        ? String((err as { message: unknown }).message)
        : String(err);
    return { status: null, bodyPreview: null, errorMessage: msg };
  } finally {
    clearTimeout(timer);
  }
};

let httpClient: WebhookHttpClient = defaultHttpClient;

export function __setWebhookHttpClientForTests(
  fn: WebhookHttpClient,
): () => void {
  const prev = httpClient;
  httpClient = fn;
  return () => {
    httpClient = prev;
  };
}

// -----------------------------------------------------------------------------
// Emit
// -----------------------------------------------------------------------------

export type EmitWebhookEventInput = {
  teamId: string;
  eventType: WebhookEventType;
  payload: Record<string, unknown>;
  /**
   * If true (default), each created delivery is attempted inline before
   * the call returns. Failures are recorded and rescheduled.
   * Set to false to defer to the retry sweeper.
   */
  attemptInline?: boolean;
};

export type EmitWebhookEventResult = {
  enqueued: number;
  delivered: number;
  failedTransient: number;
  failedPermanent: number;
};

const EMPTY_RESULT: EmitWebhookEventResult = Object.freeze({
  enqueued: 0,
  delivered: 0,
  failedTransient: 0,
  failedPermanent: 0,
});

export async function emitWebhookEvent(
  input: EmitWebhookEventInput,
  client: PrismaClient = defaultPrisma,
): Promise<EmitWebhookEventResult> {
  if (!isIntegrationsFeatureEnabled()) return { ...EMPTY_RESULT };

  let endpoints: DbEndpoint[];
  try {
    endpoints = await client.webhookEndpoint.findMany({
      where: { teamId: input.teamId, status: "ACTIVE" },
    });
  } catch {
    return { ...EMPTY_RESULT };
  }

  const matching = endpoints.filter(
    (e) =>
      e.eventTypes.length === 0 || e.eventTypes.includes(input.eventType),
  );
  if (matching.length === 0) return { ...EMPTY_RESULT };

  const eventId = randomUUID();
  const payloadJson = {
    event: input.eventType,
    eventId,
    timestampUtc: new Date().toISOString(),
    teamId: input.teamId,
    data: input.payload,
  };

  let delivered = 0;
  let failedTransient = 0;
  let failedPermanent = 0;
  let enqueued = 0;

  for (const endpoint of matching) {
    let row: DbDelivery | null = null;
    try {
      row = await client.integrationWebhookDelivery.create({
        data: {
          endpointId: endpoint.id,
          teamId: input.teamId,
          eventId,
          eventType: input.eventType,
          payloadJson: payloadJson as unknown as Prisma.InputJsonValue,
          status: "PENDING",
          attemptCount: 0,
        },
      });
      enqueued += 1;
    } catch {
      continue;
    }

    if (input.attemptInline === false) continue;

    const outcome = await attemptDelivery(row, endpoint, client);
    if (outcome === "delivered") delivered += 1;
    else if (outcome === "transient") failedTransient += 1;
    else failedPermanent += 1;
  }

  return { enqueued, delivered, failedTransient, failedPermanent };
}

// -----------------------------------------------------------------------------
// Attempt a single delivery row.
//
// Used by both the inline emit path and the retry sweeper. Recovers
// the raw signing secret by decrypting the endpoint's stored
// AES-GCM ciphertext; the recovered raw value matches what was shown
// to the operator at creation and is what receivers use to verify.
// -----------------------------------------------------------------------------

export async function attemptDelivery(
  row: DbDelivery,
  endpoint: DbEndpoint,
  client: PrismaClient,
): Promise<"delivered" | "transient" | "permanent"> {
  const nextAttemptCount = row.attemptCount + 1;

  const rawSecret = decryptWebhookSecret(endpoint.secretCiphertext);
  if (!rawSecret) {
    await client.integrationWebhookDelivery
      .update({
        where: { id: row.id },
        data: {
          status: "FAILED",
          attemptCount: nextAttemptCount,
          errorMessage: "signing_key_unavailable",
          failedAtUtc: new Date(),
          nextAttemptAtUtc: null,
        },
      })
      .catch(() => null);
    return "permanent";
  }

  const timestampMs = Date.now();
  const bodyStr = JSON.stringify(row.payloadJson);
  const signature = signWebhookPayload(rawSecret, timestampMs, bodyStr);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [WEBHOOK_HEADER_EVENT]: row.eventType,
    [WEBHOOK_HEADER_EVENT_ID]: row.eventId,
    [WEBHOOK_HEADER_TIMESTAMP]: String(timestampMs),
    [WEBHOOK_HEADER_SIGNATURE]: signature,
    "user-agent": "PROOVRA-Webhooks/1",
  };

  const resp = await httpClient({
    url: endpoint.url,
    body: bodyStr,
    headers,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });

  const isSuccess =
    typeof resp.status === "number" &&
    resp.status >= 200 &&
    resp.status < 300;

  if (isSuccess) {
    await client.integrationWebhookDelivery
      .update({
        where: { id: row.id },
        data: {
          status: "SENT",
          attemptCount: nextAttemptCount,
          responseStatus: resp.status,
          responseBodyPreview: resp.bodyPreview,
          errorMessage: null,
          sentAtUtc: new Date(),
          nextAttemptAtUtc: null,
        },
      })
      .catch(() => null);
    await recordWebhookEndpointSuccess(endpoint.id, client);
    return "delivered";
  }

  const classification = classifyWebhookHttpError(
    resp.status,
    resp.errorMessage,
  );
  const reachedMax = nextAttemptCount >= WEBHOOK_RETRY_MAX_ATTEMPTS;

  if (classification === "permanent" || reachedMax) {
    await client.integrationWebhookDelivery
      .update({
        where: { id: row.id },
        data: {
          status: "FAILED",
          attemptCount: nextAttemptCount,
          responseStatus: resp.status,
          responseBodyPreview: resp.bodyPreview,
          errorMessage: resp.errorMessage,
          failedAtUtc: new Date(),
          nextAttemptAtUtc: null,
        },
      })
      .catch(() => null);
    await recordWebhookEndpointFailure(endpoint.id, client);
    return "permanent";
  }

  const delaySec = webhookRetryDelaySeconds(nextAttemptCount + 1);
  await client.integrationWebhookDelivery
    .update({
      where: { id: row.id },
      data: {
        status: "RETRY_SCHEDULED",
        attemptCount: nextAttemptCount,
        responseStatus: resp.status,
        responseBodyPreview: resp.bodyPreview,
        errorMessage: resp.errorMessage,
        nextAttemptAtUtc: new Date(Date.now() + delaySec * 1000),
      },
    })
    .catch(() => null);
  await recordWebhookEndpointFailure(endpoint.id, client);
  return "transient";
}
