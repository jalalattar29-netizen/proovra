/**
 * PROOVRA Phase 4B — Webhook Platform Service.
 *
 * Outbound webhook lifecycle for the Phase 4B lifecycle product line:
 *   * Endpoint CRUD (create / deactivate / list).
 *   * Event emission (one canonical-JSON payload, HMAC-SHA256 signed
 *     per endpoint, one row per (endpoint, event) inserted PENDING).
 *   * Single-attempt delivery worker entry point with bounded
 *     exponential backoff (cap 1h) and dead-letter after 8 attempts.
 *   * Static verification helper for downstream consumers.
 *
 * Hard rules:
 *   * Workspace-anchored. Every read/write filters teamId.
 *   * Bounded vocabularies — eventKind MUST be in WEBHOOK_EVENT_KINDS.
 *   * HTTPS-only endpoint URLs (length-bounded).
 *   * Secrets are 32 random bytes (base64). Raw secret returned ONLY
 *     at endpoint creation; never read back.
 *   * No PII in error logs. The receiver's response body is not stored or
 *     shown (PRO-061); only its status is recorded.
 *   * Destinations follow the shared outbound policy at create and at every
 *     send (PRO-061).
 *   * Delivery is at-least-once with bounded retries
 *     (PRODUCT_AND_LIFECYCLE_LIMITATIONS standing limitation).
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  WEBHOOK_EVENT_KINDS,
  canonicalJson,
  type WebhookEventKind,
} from "@proovra/shared";

import {
  LIFECYCLE_WEBHOOK_OUTBOUND_POLICY,
  checkOutboundUrlStatic,
  sendOutboundRequest,
  type OutboundSendInput,
  type OutboundSendResult,
  type OutboundUrlCheck,
} from "@proovra/shared-runtime/outbound";

import { prisma as defaultPrisma } from "../../../db.js";
import { inputRefusal } from "../../../errors.js";
import { assertLimitEntitlementTx } from "../entitlement.service.js";

// -----------------------------------------------------------------------------
// Bounded constants — keep all magic numbers here.
// -----------------------------------------------------------------------------

const SECRET_RANDOM_BYTES = 32;
/** Response bytes read (then discarded) before the connection is dropped. */
const RESPONSE_DRAIN_MAX_BYTES = 4 * 1024;
const DELIVERY_TIMEOUT_MS = 5_000;
const MAX_ATTEMPTS_BEFORE_DEAD_LETTER = 8;
const BACKOFF_BASE_SECONDS = 30;
const BACKOFF_CAP_SECONDS = 60 * 60; // 1h
const SUBSCRIBED_EVENTS_MAX = 64;
const SIGNATURE_HEX_LENGTH = 64; // sha256 hex

const VALID_EVENT_KINDS = new Set<string>(WEBHOOK_EVENT_KINDS);

// -----------------------------------------------------------------------------
// Helpers — pure, deterministic, NO PII.
// -----------------------------------------------------------------------------

function isValidEventKind(s: string): s is WebhookEventKind {
  return VALID_EVENT_KINDS.has(s);
}

/**
 * PRO-061 / BILLING-02 — the lifecycle webhook policy is the shared outbound
 * policy (`LIFECYCLE_WEBHOOK_OUTBOUND_POLICY`, the same constant the worker
 * sends under). This used to check the scheme only, while the refusal text
 * promised "a public https:// URL": loopback, private ranges, `localhost.` and
 * the cloud metadata address were all accepted, and the worker then fetched
 * them.
 */
function checkLifecycleUrl(raw: string): OutboundUrlCheck {
  const verdict = checkOutboundUrlStatic(raw, LIFECYCLE_WEBHOOK_OUTBOUND_POLICY);
  if (verdict.ok && verdict.url.protocol !== "https:") {
    return { ok: false, reason: "non_https_scheme" };
  }
  return verdict;
}

function computeBackoffSeconds(attemptCount: number): number {
  const exp = Math.min(attemptCount, 16);
  const raw = Math.pow(2, exp) * BACKOFF_BASE_SECONDS;
  return Math.min(raw, BACKOFF_CAP_SECONDS);
}

function signPayload(secretBase64: string, canonicalPayload: string): string {
  const key = Buffer.from(secretBase64, "base64");
  return createHmac("sha256", key).update(canonicalPayload, "utf8").digest("hex");
}

// -----------------------------------------------------------------------------
// Public API — createWebhookEndpoint
// -----------------------------------------------------------------------------

export type CreateWebhookEndpointInput = {
  prisma?: PrismaClient;
  teamId: string;
  url: string;
  subscribedEvents: ReadonlyArray<WebhookEventKind>;
  createdByUserId: string;
};

export type CreateWebhookEndpointResult = {
  ok: true;
  endpointId: string;
  secret: string;
};

export async function createWebhookEndpoint(
  input: CreateWebhookEndpointInput,
): Promise<CreateWebhookEndpointResult> {
  // Batch C sweep — these were bare Errors, so an http:// URL, an empty or
  // oversized event list, or an unknown event answered 500 and paged
  // critical. They are rejected inputs; the developer message is unchanged.
  const urlCheck = checkLifecycleUrl(input.url);
  if (!urlCheck.ok) {
    throw inputRefusal({
      code: "WEBHOOK_ENDPOINT_URL_INVALID",
      message: "The endpoint address must be a public https:// URL.",
      developerMessage: `webhook_endpoint_invalid_url:${urlCheck.reason}`,
    });
  }
  if (
    !Array.isArray(input.subscribedEvents) ||
    input.subscribedEvents.length === 0 ||
    input.subscribedEvents.length > SUBSCRIBED_EVENTS_MAX
  ) {
    throw inputRefusal({
      code: "WEBHOOK_ENDPOINT_EVENTS_INVALID",
      message: `Choose between 1 and ${SUBSCRIBED_EVENTS_MAX} events for this endpoint.`,
      developerMessage: "webhook_endpoint_invalid_subscribed_events",
    });
  }
  for (const ev of input.subscribedEvents) {
    if (!isValidEventKind(ev)) {
      throw inputRefusal({
        code: "WEBHOOK_ENDPOINT_EVENT_UNKNOWN",
        message: "One of the selected events is not available for webhooks.",
        developerMessage: "webhook_endpoint_unknown_event_kind",
      });
    }
  }

  const prisma = input.prisma ?? defaultPrisma;
  const secret = randomBytes(SECRET_RANDOM_BYTES).toString("base64");

  // PRO-062 / BILLING-03 — the endpoint ceiling is a live count of ACTIVE
  // endpoints, taken under a per-workspace lock in the same transaction as
  // the insert. It used to be compared with a usage meter nothing wrote, so
  // it never tripped; and a count outside the insert's transaction would
  // admit every concurrent create at the boundary.
  const row = await prisma.$transaction(async (tx) => {
    const admitted = await assertLimitEntitlementTx({
      tx,
      prisma,
      teamId: input.teamId,
      key: "INTEGRATION_WEBHOOK_ENDPOINTS_MAX",
      requested: 1,
    });
    if (!admitted.ok) {
      throw new WebhookEndpointLimitError(admitted.limit, admitted.current);
    }
    return tx.lifecycleWebhookEndpoint.create({
      data: {
        teamId: input.teamId,
        url: input.url.trim(),
        secret,
        subscribedEvents: Array.from(input.subscribedEvents),
        state: "ACTIVE",
        createdByUserId: input.createdByUserId,
      },
      select: { id: true },
    });
  });

  return { ok: true, endpointId: row.id, secret };
}

/** The workspace already has as many ACTIVE endpoints as it is allowed. */
export class WebhookEndpointLimitError extends Error {
  constructor(
    public readonly limit: number,
    public readonly current: number,
  ) {
    super("webhook_endpoint_limit_reached");
    this.name = "WebhookEndpointLimitError";
  }
}

// -----------------------------------------------------------------------------
// Public API — deactivateWebhookEndpoint
// -----------------------------------------------------------------------------

export type DeactivateWebhookEndpointInput = {
  prisma?: PrismaClient;
  teamId: string;
  endpointId: string;
  actorUserId: string;
};

export async function deactivateWebhookEndpoint(
  input: DeactivateWebhookEndpointInput,
): Promise<{ ok: boolean; deactivated?: boolean; previousState?: string }> {
  const prisma = input.prisma ?? defaultPrisma;
  const existing = await prisma.lifecycleWebhookEndpoint.findFirst({
    where: { id: input.endpointId, teamId: input.teamId },
    select: { id: true, state: true },
  });
  if (!existing) return { ok: false };
  if (existing.state === "DEACTIVATED") {
    return { ok: true, deactivated: false, previousState: existing.state };
  }

  // Conditional on the state read above, so only the call that actually
  // deactivated the endpoint reports `deactivated: true` (and is audited as
  // a change); a concurrent or replayed call is a no-op.
  const moved = await prisma.lifecycleWebhookEndpoint.updateMany({
    where: { id: existing.id, teamId: input.teamId, state: existing.state },
    data: { state: "DEACTIVATED", deactivatedAtUtc: new Date() },
  });
  return {
    ok: true,
    deactivated: moved.count === 1,
    previousState: existing.state,
  };
}

// -----------------------------------------------------------------------------
// Public API — listWebhookEndpoints
// -----------------------------------------------------------------------------

export type ListWebhookEndpointsInput = {
  prisma?: PrismaClient;
  teamId: string;
  state?: "ACTIVE" | "DEACTIVATED";
};

export type WebhookEndpointProjection = {
  id: string;
  teamId: string;
  url: string;
  subscribedEvents: ReadonlyArray<WebhookEventKind>;
  state: string;
  createdByUserId: string;
  createdAt: string;
  deactivatedAtUtc: string | null;
};

export async function listWebhookEndpoints(
  input: ListWebhookEndpointsInput,
): Promise<ReadonlyArray<WebhookEndpointProjection>> {
  const prisma = input.prisma ?? defaultPrisma;
  const rows = await prisma.lifecycleWebhookEndpoint.findMany({
    where: {
      teamId: input.teamId,
      ...(input.state ? { state: input.state } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return rows.map((r) => ({
    id: r.id,
    teamId: r.teamId,
    url: r.url,
    subscribedEvents: normalizeSubscribedEvents(r.subscribedEvents),
    state: r.state,
    createdByUserId: r.createdByUserId,
    createdAt: r.createdAt.toISOString(),
    deactivatedAtUtc: r.deactivatedAtUtc?.toISOString() ?? null,
  }));
}

function normalizeSubscribedEvents(
  raw: unknown,
): ReadonlyArray<WebhookEventKind> {
  if (!Array.isArray(raw)) return [];
  const out: WebhookEventKind[] = [];
  for (const v of raw) {
    if (typeof v === "string" && isValidEventKind(v)) out.push(v);
  }
  return out;
}

// -----------------------------------------------------------------------------
// Public API — emitWebhookEvent
// -----------------------------------------------------------------------------

export type EmitWebhookEventInput = {
  prisma?: PrismaClient;
  teamId: string;
  eventKind: WebhookEventKind;
  payload: Record<string, unknown>;
};

export async function emitWebhookEvent(
  input: EmitWebhookEventInput,
): Promise<{ deliveryIds: ReadonlyArray<string> }> {
  if (!isValidEventKind(input.eventKind)) {
    throw new Error("webhook_event_invalid_kind");
  }
  const prisma = input.prisma ?? defaultPrisma;
  const endpoints = await prisma.lifecycleWebhookEndpoint.findMany({
    where: { teamId: input.teamId, state: "ACTIVE" },
    select: {
      id: true,
      secret: true,
      subscribedEvents: true,
    },
  });

  if (endpoints.length === 0) return { deliveryIds: [] };

  const canonical = canonicalJson(input.payload);
  const deliveryIds: string[] = [];

  for (const ep of endpoints) {
    const subs = normalizeSubscribedEvents(ep.subscribedEvents);
    if (!subs.includes(input.eventKind)) continue;
    const signature = signPayload(ep.secret, canonical);
    const row = await prisma.lifecycleWebhookDelivery
      .create({
        data: {
          teamId: input.teamId,
          endpointId: ep.id,
          eventKind: input.eventKind,
          payload: input.payload as object,
          signature,
          state: "PENDING",
          attemptCount: 0,
        },
        select: { id: true },
      })
      .catch(() => null);
    if (row) deliveryIds.push(row.id);
  }

  return { deliveryIds };
}

// -----------------------------------------------------------------------------
// Public API — deliverWebhookDelivery (worker entry point)
// -----------------------------------------------------------------------------

export type DeliverWebhookDeliveryInput = {
  prisma?: PrismaClient;
  deliveryId: string;
  /** Test seam; production uses the shared outbound transport. */
  send?: (input: OutboundSendInput) => Promise<OutboundSendResult>;
};

export type DeliverWebhookDeliveryResult = {
  ok: boolean;
  nextRetryAtUtc?: Date;
};

export async function deliverWebhookDelivery(
  input: DeliverWebhookDeliveryInput,
): Promise<DeliverWebhookDeliveryResult> {
  const prisma = input.prisma ?? defaultPrisma;
  const delivery = await prisma.lifecycleWebhookDelivery.findUnique({
    where: { id: input.deliveryId },
    include: {
      endpoint: {
        select: { id: true, url: true, state: true },
      },
    },
  });
  if (!delivery) return { ok: false };
  if (delivery.state === "DELIVERED" || delivery.state === "DEAD_LETTERED") {
    return { ok: delivery.state === "DELIVERED" };
  }
  if (!delivery.endpoint || delivery.endpoint.state !== "ACTIVE") {
    await prisma.lifecycleWebhookDelivery
      .update({
        where: { id: delivery.id },
        data: { state: "FAILED", lastAttemptAtUtc: new Date() },
      })
      .catch(() => null);
    return { ok: false };
  }

  const nextAttemptCount = delivery.attemptCount + 1;
  const eventKind = delivery.eventKind;
  const signature = delivery.signature;
  const canonical = canonicalJson(delivery.payload as unknown);

  let responseStatus: number | null = null;
  // PRO-061 — the receiver's body is never stored or shown; only its status.
  const responseBodyPreview: string | null = null;
  let networkError = false;

  // PRO-061 — the same policy at send: the stored URL is checked again (a row
  // written before the policy is not trusted), the name is resolved inside the
  // connection so the checked address is the connected address, and no
  // redirect is followed.
  const send = input.send ?? sendOutboundRequest;
  const result = await send({
    url: delivery.endpoint.url,
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-proovra-event": eventKind,
      "x-proovra-signature": signature,
      "x-proovra-delivery": delivery.id,
    },
    body: canonical,
    timeoutMs: DELIVERY_TIMEOUT_MS,
    policy: LIFECYCLE_WEBHOOK_OUTBOUND_POLICY,
    maxResponseBytes: RESPONSE_DRAIN_MAX_BYTES,
  });
  if (result.kind === "refused") {
    await prisma.lifecycleWebhookDelivery
      .update({
        where: { id: delivery.id },
        data: {
          state: "FAILED",
          attemptCount: nextAttemptCount,
          lastAttemptAtUtc: new Date(),
          responseStatus: null,
          responseBodyPreview: null,
        },
      })
      .catch(() => null);
    return { ok: false };
  }
  if (result.kind === "response") responseStatus = result.status;
  else networkError = true;

  const now = new Date();
  const baseUpdate: {
    attemptCount: number;
    lastAttemptAtUtc: Date;
    responseStatus: number | null;
    responseBodyPreview: string | null;
  } = {
    attemptCount: nextAttemptCount,
    lastAttemptAtUtc: now,
    responseStatus,
    responseBodyPreview,
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
  // A redirect (3xx) is not followed and is not retried: like a 4xx it is
  // the receiver's definite answer.
  const isHardFailure =
    !success &&
    !isRetryable &&
    responseStatus !== null &&
    responseStatus >= 300 &&
    responseStatus < 500;

  if (success) {
    await prisma.lifecycleWebhookDelivery
      .update({
        where: { id: delivery.id },
        data: {
          ...baseUpdate,
          state: "DELIVERED",
          deliveredAtUtc: now,
        },
      })
      .catch(() => null);
    return { ok: true };
  }

  if (isHardFailure) {
    await prisma.lifecycleWebhookDelivery
      .update({
        where: { id: delivery.id },
        data: { ...baseUpdate, state: "FAILED" },
      })
      .catch(() => null);
    return { ok: false };
  }

  // Retryable path (5xx / 429 / network).
  if (nextAttemptCount >= MAX_ATTEMPTS_BEFORE_DEAD_LETTER) {
    await prisma.lifecycleWebhookDelivery
      .update({
        where: { id: delivery.id },
        data: {
          ...baseUpdate,
          state: "DEAD_LETTERED",
          deadLetteredAtUtc: now,
        },
      })
      .catch(() => null);
    // Bounded audit signal — no PII, only ids.
    // eslint-disable-next-line no-console
    console.warn(
      `webhook_dead_lettered:${delivery.id}`,
    );
    return { ok: false };
  }

  const nextRetryAtUtc = new Date(
    now.getTime() + computeBackoffSeconds(nextAttemptCount) * 1000,
  );
  await prisma.lifecycleWebhookDelivery
    .update({
      where: { id: delivery.id },
      data: { ...baseUpdate, state: "RETRYING" },
    })
    .catch(() => null);
  return { ok: false, nextRetryAtUtc };
}

// -----------------------------------------------------------------------------
// Public API — getDeliveryAudit
// -----------------------------------------------------------------------------

export type DeliveryAuditProjection = {
  id: string;
  teamId: string;
  endpointId: string;
  eventKind: string;
  state: string;
  attemptCount: number;
  signature: string;
  responseStatus: number | null;
  responseBodyPreview: string | null;
  enqueuedAtUtc: string;
  lastAttemptAtUtc: string | null;
  deliveredAtUtc: string | null;
  deadLetteredAtUtc: string | null;
};

export async function getDeliveryAudit(input: {
  prisma?: PrismaClient;
  teamId: string;
  deliveryId: string;
}): Promise<DeliveryAuditProjection | null> {
  const prisma = input.prisma ?? defaultPrisma;
  const row = await prisma.lifecycleWebhookDelivery.findFirst({
    where: { id: input.deliveryId, teamId: input.teamId },
    select: {
      id: true,
      teamId: true,
      endpointId: true,
      eventKind: true,
      state: true,
      attemptCount: true,
      signature: true,
      responseStatus: true,
      enqueuedAtUtc: true,
      lastAttemptAtUtc: true,
      deliveredAtUtc: true,
      deadLetteredAtUtc: true,
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    teamId: row.teamId,
    endpointId: row.endpointId,
    eventKind: row.eventKind,
    state: row.state,
    attemptCount: row.attemptCount,
    signature: row.signature,
    responseStatus: row.responseStatus,
    // PRO-061 — never the receiver's body (older rows may still hold one).
    responseBodyPreview: null,
    enqueuedAtUtc: row.enqueuedAtUtc.toISOString(),
    lastAttemptAtUtc: row.lastAttemptAtUtc?.toISOString() ?? null,
    deliveredAtUtc: row.deliveredAtUtc?.toISOString() ?? null,
    deadLetteredAtUtc: row.deadLetteredAtUtc?.toISOString() ?? null,
  };
}

// -----------------------------------------------------------------------------
// Public API — verifyIncomingSignature (downstream consumer helper)
// -----------------------------------------------------------------------------

export function verifyIncomingSignature(input: {
  rawBody: string;
  signature: string;
  secret: string;
}): boolean {
  if (
    typeof input.rawBody !== "string" ||
    typeof input.signature !== "string" ||
    typeof input.secret !== "string"
  ) {
    return false;
  }
  if (input.signature.length !== SIGNATURE_HEX_LENGTH) return false;
  let expectedBuf: Buffer;
  let providedBuf: Buffer;
  try {
    expectedBuf = Buffer.from(signPayload(input.secret, input.rawBody), "hex");
    providedBuf = Buffer.from(input.signature, "hex");
  } catch {
    return false;
  }
  if (expectedBuf.length !== providedBuf.length) return false;
  try {
    return timingSafeEqual(expectedBuf, providedBuf);
  } catch {
    return false;
  }
}
