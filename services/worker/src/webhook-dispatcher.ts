/**
 * PROOVRA Phase 4B Final Closure — C4: Webhook Dispatcher Worker.
 *
 * Polls LifecycleWebhookDelivery rows in PENDING / RETRYING state and
 * dispatches them over HTTP with bounded exponential backoff, HMAC-SHA256
 * signing, per-row lifecycle event emission, and a concurrency cap.
 *
 * Design constraints:
 *   - Injectable httpFetcher for test stubbing.
 *   - Concurrency cap: 10 in-flight deliveries per tick.
 *   - Payload size cap: 64 KB (emitWebhookEvent must check before insert;
 *     this dispatcher also rejects any payload that exceeds the cap).
 *   - 30-second per-request timeout.
 *   - Inner loop errors are caught + logged; outer loop continues.
 *   - Dead-letter after 8 attempts (mirrors webhook-platform.service.ts).
 */

import { SWEEP_NAMES, getWorkEntryOrThrow } from "@proovra/shared";
import { createHmac } from "node:crypto";
import { prisma } from "./db.js";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Typed shim for Prisma fields not yet regenerated in the worker client.
// nextAttemptAtUtc was added to the LifecycleWebhookDelivery model in the
// API schema; the worker shares the same DB schema but its generated Prisma
// client will be stale until the next `prisma generate` run. Using a typed
// shim rather than sprinkling `as any` throughout the file.
// ---------------------------------------------------------------------------

type WebhookDeliveryUpdateData = Record<string, unknown>;
type WebhookDeliveryWhereInput = Record<string, unknown>;

function webhookDeliveryFindMany(args: {
  where: WebhookDeliveryWhereInput;
  orderBy: Record<string, string>;
  take: number;
  select: { id: true };
}): Promise<{ id: string }[]> {
  return (prisma.lifecycleWebhookDelivery.findMany as unknown as (
    a: typeof args,
  ) => Promise<{ id: string }[]>)(args);
}

function webhookDeliveryUpdate(args: {
  where: { id: string };
  data: WebhookDeliveryUpdateData;
}): Promise<unknown> {
  return (prisma.lifecycleWebhookDelivery.update as unknown as (
    a: typeof args,
  ) => Promise<unknown>)(args);
}

// ---------------------------------------------------------------------------
// Constants — mirror webhook-platform.service.ts where applicable.
// ---------------------------------------------------------------------------

const POLL_LIMIT = 50;

/**
 * How long a DISPATCHING claim is believed before another tick may reclaim it.
 *
 * Read from the registry so the claim window, the recovery window and the
 * operator projection cannot drift apart — the same reason the retry policy
 * comes from there rather than from a literal at the call site.
 */
const CLAIM_LEASE_MS =
  getWorkEntryOrThrow(SWEEP_NAMES.WEBHOOK_DISPATCHER).claim?.leaseMs ??
  5 * 60_000;
const CONCURRENCY_CAP = 10;
const DELIVERY_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS_BEFORE_DEAD_LETTER = 8;
const BACKOFF_BASE_SECONDS = 30;
const BACKOFF_CAP_SECONDS = 60 * 60; // 1 hour
const RESPONSE_PREVIEW_MAX_CHARS = 500;
const PAYLOAD_SIZE_LIMIT_BYTES = 64 * 1024; // 64 KB

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function computeBackoffSeconds(attemptCount: number): number {
  const exp = Math.min(attemptCount, 16);
  const raw = Math.pow(2, exp) * BACKOFF_BASE_SECONDS;
  return Math.min(raw, BACKOFF_CAP_SECONDS);
}

function signPayload(secretBase64: string, body: string): string {
  const key = Buffer.from(secretBase64, "base64");
  return createHmac("sha256", key).update(body, "utf8").digest("hex");
}

function truncatePreview(s: string): string {
  return s.length <= RESPONSE_PREVIEW_MAX_CHARS
    ? s
    : s.slice(0, RESPONSE_PREVIEW_MAX_CHARS);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HttpFetcher = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ status: number; text: () => Promise<string> }>;

const defaultFetcher: HttpFetcher = (url, init) =>
  fetch(url, init) as Promise<{ status: number; text: () => Promise<string> }>;

// ---------------------------------------------------------------------------
// Emit lifecycle event — writes to IntelligenceActivityEvent (canonical
// audit log). Non-fatal: delivery state is already committed before this
// call; a persistence failure here must not unwind the delivery outcome.
//
// IntelligenceActivityEvent is not yet on the worker's generated Prisma
// client; use a typed shim (consistent with the delivery shims above) so
// the call is schema-safe at the TypeScript layer without `as any`.
// ---------------------------------------------------------------------------

type WebhookLifecycleCode =
  | "WEBHOOK_DELIVERED"
  | "WEBHOOK_FAILED"
  | "WEBHOOK_DEAD_LETTERED";

type ActivityEventCreateData = Record<string, unknown>;

function activityEventCreate(data: ActivityEventCreateData): Promise<unknown> {
  const client = prisma as unknown as {
    intelligenceActivityEvent?: { create: (a: { data: ActivityEventCreateData }) => Promise<unknown> };
  };
  if (!client.intelligenceActivityEvent) return Promise.resolve();
  return client.intelligenceActivityEvent.create({ data });
}

async function emitLifecycleEvent(input: {
  teamId: string;
  deliveryId: string;
  code: WebhookLifecycleCode;
  detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    await activityEventCreate({
      teamId: input.teamId,
      category: "WEBHOOK",
      code: input.code,
      operation: input.code,
      targetType: "WEBHOOK_DELIVERY",
      targetId: input.deliveryId,
    });
  } catch {
    // Non-fatal — delivery state is already written.
  }
}

// ---------------------------------------------------------------------------
// Single delivery dispatch
// ---------------------------------------------------------------------------

// Typed shims for LifecycleWebhookDelivery findUnique (no include, just core fields)
// and WebhookEndpoint lookup (status + secretCiphertext).
type DeliveryRow = {
  id: string;
  teamId: string;
  endpointId: string;
  eventKind: string;
  payload: unknown;
  state: string;
  attemptCount: number;
};

/**
 * PHASE 12 — POINT 5: this row comes from `LifecycleWebhookEndpoint`.
 *
 * It previously came from `WebhookEndpoint`, and the two are different tables
 * with different columns — see the note on `endpointFindUnique` below.
 */
type EndpointRow = {
  id: string;
  url: string;
  state: string;
  secret: string;
};

function deliveryFindUnique(id: string): Promise<DeliveryRow | null> {
  return (prisma.lifecycleWebhookDelivery.findUnique as unknown as (
    a: { where: { id: string }; select: Record<string, true> }
  ) => Promise<DeliveryRow | null>)({
    where: { id },
    select: { id: true, teamId: true, endpointId: true, eventKind: true, payload: true, state: true, attemptCount: true },
  });
}

/**
 * PHASE 12 — POINT 5: FIXED — the dispatcher was reading the WRONG TABLE.
 *
 * `LifecycleWebhookDelivery.endpointId` has a foreign key to
 * `LifecycleWebhookEndpoint` (`webhook_endpoints`). This function looked the
 * same id up in `prisma.webhookEndpoint`, which is a DIFFERENT model mapping to
 * `integration_webhook_endpoints`.
 *
 * The lookup therefore returned `null` for every real delivery, and the caller
 * treats a missing endpoint as unrecoverable: it marked the delivery FAILED and
 * returned WITHOUT EVER ATTEMPTING THE REQUEST. Lifecycle webhook delivery was
 * a total silent outage — every delivery failed, none was retried, and the
 * failure looked like a legitimately deactivated endpoint.
 *
 * It survived because nothing exercised the dispatcher against a real database:
 * the two models have similarly-shaped fields, the id is a UUID that is valid
 * against both, and the typed shim (`as unknown as`) that exists to work around
 * a stale generated client also suppressed the type error that would have
 * caught it.
 *
 * The column names differ too and are corrected with it: `status` -> `state`,
 * `secretCiphertext` -> `secret`.
 */
/**
 * Move a delivery out of PENDING/RETRYING into DISPATCHING, atomically.
 *
 * Returns true only for the caller whose UPDATE matched a row, which is what
 * makes "exactly one dispatcher sends this" a database guarantee rather than a
 * scheduling assumption.
 *
 * The signature is written here rather than after the response so the durable
 * record shows what was signed even if the process dies mid-flight.
 */
async function webhookDeliveryClaim(
  id: string,
  signature: string,
): Promise<boolean> {
  const res = await (prisma.lifecycleWebhookDelivery.updateMany as unknown as (
    a: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    },
  ) => Promise<{ count: number }>)({
    where: { id, state: { in: ["PENDING", "RETRYING"] } },
    data: { state: "DISPATCHING", signature, lastAttemptAtUtc: new Date() },
  });
  return res.count === 1;
}

function endpointFindUnique(id: string): Promise<EndpointRow | null> {
  return (prisma.lifecycleWebhookEndpoint.findUnique as unknown as (
    a: { where: { id: string }; select: Record<string, true> }
  ) => Promise<EndpointRow | null>)({
    where: { id },
    select: { id: true, url: true, state: true, secret: true },
  });
}

async function dispatchOne(
  deliveryId: string,
  fetcher: HttpFetcher,
): Promise<void> {
  const delivery = await deliveryFindUnique(deliveryId);

  if (!delivery) return;
  if (
    delivery.state === "DELIVERED" ||
    delivery.state === "DEAD_LETTERED" ||
    delivery.state === "FAILED"
  ) {
    return;
  }

  const endpoint = await endpointFindUnique(delivery.endpointId);
  if (!endpoint || endpoint.state !== "ACTIVE") {
    await webhookDeliveryUpdate({
      where: { id: deliveryId },
      data: { state: "FAILED", lastAttemptAtUtc: new Date() },
    }).catch(() => null);
    return;
  }

  // Payload size guard — canonical JSON of the stored payload object.
  const canonical = JSON.stringify(delivery.payload);
  const payloadBytes = Buffer.byteLength(canonical, "utf8");
  if (payloadBytes > PAYLOAD_SIZE_LIMIT_BYTES) {
    logger.warn(
      { deliveryId, payloadBytes },
      "webhook.dispatcher.payload_too_large",
    );
    await webhookDeliveryUpdate({
      where: { id: deliveryId },
      data: { state: "FAILED", lastAttemptAtUtc: new Date() },
    }).catch(() => null);
    return;
  }

  // The endpoint's stored signing secret is used directly as HMAC key
  // material. It is read HERE, at execution, and never travels on a payload.
  const signature = signPayload(endpoint.secret, canonical);
  const nextAttemptCount = delivery.attemptCount + 1;

  // PHASE 12 — POINT 5: ATOMIC CLAIM — this did not exist.
  //
  // The registry documented `PENDING -> DISPATCHING (conditional_update_many)`
  // and `conditional_state_claim` idempotency for this sweep. The code
  // implemented neither: `DISPATCHING` appeared nowhere in this module. The
  // tick polled due rows and dispatched them, so two dispatcher instances —
  // or two overlapping ticks of one instance, since the interval is 5 seconds
  // and the HTTP timeout is longer — both saw the same PENDING row and both
  // POSTed it. Customer endpoints received DUPLICATE webhook deliveries, and
  // the only thing standing between the platform and that was single-replica
  // deployment.
  //
  // The claim is a conditional UPDATE: exactly one caller can move a row out
  // of PENDING/RETRYING, and the loser exits before the network call. The
  // signature is persisted with it, so the delivery record shows what was
  // actually signed rather than leaving an empty column behind.
  const claimed = await webhookDeliveryClaim(deliveryId, signature);
  if (!claimed) {
    logger.info(
      { deliveryId },
      "webhook.dispatcher.claim_lost",
    );
    return;
  }

  let responseStatus: number | null = null;
  let responseBodyExcerpt: string | null = null;
  let networkError = false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const res = await fetcher(endpoint.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-proovra-signature": signature,
        "x-proovra-delivery-id": delivery.id,
        "x-proovra-event-kind": delivery.eventKind,
      },
      body: canonical,
      signal: controller.signal,
    });
    responseStatus = res.status;
    try {
      const text = await res.text();
      responseBodyExcerpt = truncatePreview(text);
    } catch {
      responseBodyExcerpt = null;
    }
  } catch {
    networkError = true;
  } finally {
    clearTimeout(timer);
  }

  const now = new Date();
  const baseUpdate = {
    attemptCount: nextAttemptCount,
    lastAttemptAtUtc: now,
    responseStatus,
    responseBodyPreview: responseBodyExcerpt,
  };

  const success =
    !networkError &&
    responseStatus !== null &&
    responseStatus >= 200 &&
    responseStatus < 300;

  const isRetryable =
    networkError ||
    responseStatus === 429 ||
    (responseStatus !== null && responseStatus >= 500);

  if (success) {
    await webhookDeliveryUpdate({
      where: { id: deliveryId },
      data: { ...baseUpdate, state: "DELIVERED", deliveredAtUtc: now },
    }).catch(() => null);
    await emitLifecycleEvent({
      teamId: delivery.teamId,
      deliveryId,
      code: "WEBHOOK_DELIVERED",
    });
    logger.info(
      { deliveryId, responseStatus },
      "webhook.dispatcher.delivered",
    );
    return;
  }

  // Hard 4xx failure (not 429) — do not retry.
  if (
    !isRetryable &&
    responseStatus !== null &&
    responseStatus >= 400 &&
    responseStatus < 500
  ) {
    await webhookDeliveryUpdate({
      where: { id: deliveryId },
      data: { ...baseUpdate, state: "FAILED" },
    }).catch(() => null);
    await emitLifecycleEvent({
      teamId: delivery.teamId,
      deliveryId,
      code: "WEBHOOK_FAILED",
    });
    logger.warn(
      { deliveryId, responseStatus },
      "webhook.dispatcher.hard_failed",
    );
    return;
  }

  // Retryable: 5xx / 429 / network error.
  if (nextAttemptCount >= MAX_ATTEMPTS_BEFORE_DEAD_LETTER) {
    await webhookDeliveryUpdate({
      where: { id: deliveryId },
      data: {
        ...baseUpdate,
        state: "DEAD_LETTERED",
        deadLetteredAtUtc: now,
      },
    }).catch(() => null);
    await emitLifecycleEvent({
      teamId: delivery.teamId,
      deliveryId,
      code: "WEBHOOK_DEAD_LETTERED",
    });
    logger.warn({ deliveryId }, "webhook.dispatcher.dead_lettered");
    return;
  }

  const nextAttemptAtUtc = new Date(
    now.getTime() + computeBackoffSeconds(nextAttemptCount) * 1000,
  );
  await webhookDeliveryUpdate({
    where: { id: deliveryId },
    data: {
      ...baseUpdate,
      state: "RETRYING",
      nextAttemptAtUtc,
    },
  }).catch(() => null);
  await emitLifecycleEvent({
    teamId: delivery.teamId,
    deliveryId,
    code: "WEBHOOK_FAILED",
  });
  logger.info(
    { deliveryId, nextAttemptAtUtc },
    "webhook.dispatcher.retrying",
  );
}

// ---------------------------------------------------------------------------
// Public tick — called by the scheduler in index.ts every 5 seconds.
// ---------------------------------------------------------------------------

export async function runWebhookDispatcherTick(options?: {
  fetcher?: HttpFetcher;
}): Promise<void> {
  const fetcher = options?.fetcher ?? defaultFetcher;

  const now = new Date();

  // PHASE 12 — POINT 5: release expired DISPATCHING claims BEFORE polling.
  //
  // The atomic claim added in this phase is what stops two dispatchers sending
  // the same delivery twice — but a claim with no expiry is a new way to lose
  // work: a process that dies between claiming and responding would leave the
  // row DISPATCHING forever, invisible to every future tick because
  // DISPATCHING is not a polled state.
  //
  // The lease bound is the registry's (`leaseMs`), so the claim window and the
  // recovery window cannot drift apart.
  const leaseFloor = new Date(now.getTime() - CLAIM_LEASE_MS);
  try {
    const released = await (
      prisma.lifecycleWebhookDelivery.updateMany as unknown as (a: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => Promise<{ count: number }>
    )({
      where: { state: "DISPATCHING", lastAttemptAtUtc: { lt: leaseFloor } },
      data: { state: "RETRYING" },
    });
    if (released.count > 0) {
      logger.warn(
        { released: released.count },
        "webhook.dispatcher.stale_claims_released",
      );
    }
  } catch (err) {
    logger.error({ err }, "webhook.dispatcher.lease_release_failed");
  }

  // Poll up to POLL_LIMIT rows that are due.
  // PENDING rows have nextAttemptAtUtc = null → dispatch immediately.
  // RETRYING rows have a scheduled nextAttemptAtUtc → only pick up when due.
  let rows: { id: string }[];
  try {
    rows = await webhookDeliveryFindMany({
      where: {
        state: { in: ["PENDING", "RETRYING"] },
        OR: [
          { nextAttemptAtUtc: null },
          { nextAttemptAtUtc: { lte: now } },
        ],
      },
      orderBy: { nextAttemptAtUtc: "asc" },
      take: POLL_LIMIT,
      select: { id: true },
    });
  } catch (err) {
    logger.error({ err }, "webhook.dispatcher.poll_failed");
    return;
  }

  if (rows.length === 0) return;

  logger.info(
    { count: rows.length },
    "webhook.dispatcher.tick_started",
  );

  // Process in batches of CONCURRENCY_CAP to avoid hammering the same endpoint.
  for (let i = 0; i < rows.length; i += CONCURRENCY_CAP) {
    const batch = rows.slice(i, i + CONCURRENCY_CAP);
    await Promise.all(
      batch.map(async (row) => {
        try {
          await dispatchOne(row.id, fetcher);
        } catch (err) {
          // Inner errors must never crash the loop.
          logger.error(
            { err, deliveryId: row.id },
            "webhook.dispatcher.delivery_error",
          );
        }
      }),
    );
  }

  logger.info(
    { count: rows.length },
    "webhook.dispatcher.tick_finished",
  );
}
