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
// Phase O1.4 — bounded webhook-dispatch span. Attributes are
// bounded: eventType + endpointId hash prefix + status. NEVER the
// payload, signature, or destination URL.
import {
  PROOVRA_SPAN_NAMES,
  withProovraSpan,
} from "../../observability/otel.js";
import { isIntegrationsFeatureEnabled } from "./api-keys.service.js";
import {
  clearExpiredPreviousWebhookSecret,
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

/**
 * Phase 3 — Operator-initiated test event.
 *
 * Synthesises a delivery for a SPECIFIC endpoint id, regardless of its
 * subscribed event types. The synthetic delivery flows through the
 * SAME signing + retry path as a real production event — same
 * `attemptDelivery`, same HMAC, same retry ladder, same audit row
 * shape. The only differences are:
 *
 *   - eventType is canonically `"webhook.test"` (not in the public
 *     WEBHOOK_EVENT_TYPES enum — receivers will see this distinct
 *     literal in the `X-Proovra-Event` header and on the row).
 *   - payloadJson.kind = "test" so the operator UI can recognise
 *     test events and the receiver can ignore them in production.
 *   - The endpoint is matched by `endpointId` and `teamId` directly;
 *     subscription filtering is bypassed. Endpoint MUST be ACTIVE.
 *
 * Returns `null` when the endpoint is missing, belongs to another
 * team, or is not ACTIVE. Returns the created delivery row plus the
 * eventId otherwise. NEVER throws — same swallow-error posture as
 * `emitWebhookEvent` so the route stays simple.
 */
export type DispatchTestEventInput = {
  endpointId: string;
  teamId: string;
  /**
   * Optional small payload provided by the operator. We deep-bound it
   * (see TEST_EVENT_MAX_PAYLOAD_BYTES) so a runaway payload cannot
   * fill `payloadJson`. Defaults to {}.
   */
  payload?: Record<string, unknown>;
  /**
   * If true (default), attempt inline so the operator sees the result
   * immediately. Set false to defer to the retry sweeper.
   */
  attemptInline?: boolean;
};

export type DispatchTestEventResult = {
  deliveryId: string;
  eventId: string;
  outcome: "delivered" | "transient" | "permanent" | "queued";
};

/** Hard cap so an operator cannot wedge the table with a large blob. */
export const TEST_EVENT_MAX_PAYLOAD_BYTES = 4 * 1024; // 4 KiB
/** Canonical event-type literal for test deliveries. */
export const TEST_EVENT_TYPE = "webhook.test" as const;

export async function dispatchTestEventToEndpoint(
  input: DispatchTestEventInput,
  client: PrismaClient = defaultPrisma,
): Promise<DispatchTestEventResult | null> {
  if (!isIntegrationsFeatureEnabled()) return null;

  let endpoint: DbEndpoint | null;
  try {
    endpoint = await client.webhookEndpoint.findFirst({
      where: { id: input.endpointId, teamId: input.teamId },
    });
  } catch {
    return null;
  }
  if (!endpoint || endpoint.status !== "ACTIVE") return null;

  // Bound the supplied payload. Operator-provided JSON-stringifies to
  // < TEST_EVENT_MAX_PAYLOAD_BYTES; if it exceeds, we drop the
  // operator payload and use a sentinel marker instead of failing the
  // request — the test event still goes out so the connectivity
  // signal is preserved.
  let safePayload: Record<string, unknown> = { ok: true };
  if (input.payload && typeof input.payload === "object") {
    try {
      const serialised = JSON.stringify(input.payload);
      if (serialised.length <= TEST_EVENT_MAX_PAYLOAD_BYTES) {
        safePayload = input.payload;
      } else {
        safePayload = { ok: true, payload_omitted: "exceeded_size_cap" };
      }
    } catch {
      safePayload = { ok: true, payload_omitted: "not_serialisable" };
    }
  }

  const eventId = randomUUID();
  const payloadJson = {
    event: TEST_EVENT_TYPE,
    eventId,
    timestampUtc: new Date().toISOString(),
    teamId: input.teamId,
    // The `kind` marker is the canonical way to recognise an
    // operator-initiated test event on the receiver side; the bounded
    // operator payload is nested under `data`.
    kind: "test",
    data: safePayload,
  };

  let row: DbDelivery;
  try {
    row = await client.integrationWebhookDelivery.create({
      data: {
        endpointId: endpoint.id,
        teamId: input.teamId,
        eventId,
        eventType: TEST_EVENT_TYPE,
        payloadJson: payloadJson as unknown as Prisma.InputJsonValue,
        status: "PENDING",
        attemptCount: 0,
      },
    });
  } catch {
    return null;
  }

  if (input.attemptInline === false) {
    return { deliveryId: row.id, eventId, outcome: "queued" };
  }

  const outcome = await attemptDelivery(row, endpoint, client);
  return { deliveryId: row.id, eventId, outcome };
}

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
  // Phase O1.4 — emit a bounded webhook.dispatch span. NEVER carries
  // raw payload / signature / destination URL.
  return withProovraSpan(
    PROOVRA_SPAN_NAMES.WEBHOOK_DISPATCH,
    {
      "proovra.operation": "webhook_dispatch",
      "proovra.event_type": row.eventType,
      "proovra.attempt": row.attemptCount + 1,
      "proovra.team_id": row.teamId,
    },
    () => attemptDeliveryInner(row, endpoint, client),
  );
}

async function attemptDeliveryInner(
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

  // Phase 4 — dual-signing during rotation grace.
  //
  // If the endpoint has a non-null previousSecretCiphertext AND the
  // grace window has not yet expired, compute the OLD signature too
  // and append it to the `X-Proovra-Signature` header as a comma-
  // separated list `v1=<new>,v1=<old>` (Stripe-style multi-sig).
  // Receivers can verify against either, which lets them roll the new
  // secret into production without dropping events.
  //
  // Lazy cleanup: if the grace window has expired, fire-and-forget a
  // clear of the previous_* triple so the endpoint reverts to single-
  // sign on subsequent deliveries. Best-effort — never blocks the
  // dispatch.
  const timestampMs = Date.now();
  const bodyStr = JSON.stringify(row.payloadJson);
  const newSignature = signWebhookPayload(rawSecret, timestampMs, bodyStr);

  let signatureHeader = newSignature;
  const graceUntil = endpoint.previousSecretValidUntilUtc;
  if (
    endpoint.previousSecretCiphertext &&
    graceUntil &&
    graceUntil.getTime() > timestampMs
  ) {
    const prevRaw = decryptWebhookSecret(endpoint.previousSecretCiphertext);
    if (prevRaw) {
      const prevSignature = signWebhookPayload(prevRaw, timestampMs, bodyStr);
      // Comma-separated multi-sig — the order is "new first, prev
      // second" so receivers that only parse the first entry pick up
      // the new secret immediately after they finish rolling it out.
      signatureHeader = `${newSignature},${prevSignature}`;
    }
  } else if (
    endpoint.previousSecretCiphertext &&
    graceUntil &&
    graceUntil.getTime() <= timestampMs
  ) {
    // Grace window expired — clear the previous_* triple as a side
    // effect of normal traffic. The clear is best-effort and never
    // blocks the dispatch.
    void clearExpiredPreviousWebhookSecret(endpoint.id, client);
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    [WEBHOOK_HEADER_EVENT]: row.eventType,
    [WEBHOOK_HEADER_EVENT_ID]: row.eventId,
    [WEBHOOK_HEADER_TIMESTAMP]: String(timestampMs),
    [WEBHOOK_HEADER_SIGNATURE]: signatureHeader,
    "user-agent": "PROOVRA-Webhooks/1",
  };

  // Phase closure — bracket the SINGLE outbound HTTP call with a
  // monotonic timer. `defaultHttpClient` already catches its own
  // network errors and returns a `WebhookHttpResponse` either way, so
  // the bracket is symmetric across success / 4xx / 5xx / abort. If a
  // pluggable client throws, the catch around the bracket still
  // records a duration — we only leave it null when the row reached a
  // terminal status BEFORE we ever called httpClient (e.g.
  // signing_key_unavailable above).
  const startNs = process.hrtime.bigint();
  let resp: WebhookHttpResponse;
  try {
    resp = await httpClient({
      url: endpoint.url,
      body: bodyStr,
      headers,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  } catch (err) {
    // A pluggable client throwing is treated as an unknown transport
    // error — same shape as `defaultHttpClient` would return on a
    // fetch reject. The duration is still measured.
    const msg =
      err && typeof err === "object" && "message" in err
        ? String((err as { message: unknown }).message)
        : String(err);
    resp = { status: null, bodyPreview: null, errorMessage: msg };
  }
  const durationMs = measureDurationMs(startNs);

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
          responseDurationMs: durationMs,
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
          responseDurationMs: durationMs,
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
        responseDurationMs: durationMs,
      },
    })
    .catch(() => null);
  await recordWebhookEndpointFailure(endpoint.id, client);
  return "transient";
}

/**
 * Phase closure — convert a `process.hrtime.bigint()` start nanosecond
 * reading into a wall-clock millisecond duration relative to "now".
 * Clamped at 0 so a clock jump can never produce a negative latency
 * (defensive — bigint subtraction from the same monotonic source is
 * already monotonic on every supported platform).
 */
function measureDurationMs(startNs: bigint): number {
  const elapsedNs = process.hrtime.bigint() - startNs;
  const elapsedMs = Number(elapsedNs / 1_000_000n);
  return elapsedMs < 0 ? 0 : elapsedMs;
}
