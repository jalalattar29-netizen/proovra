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

import { SWEEP_NAMES, getWorkEntryOrThrow, normalizeWorkspaceKind } from "@proovra/shared";
import {
  LIFECYCLE_WEBHOOK_OUTBOUND_POLICY,
  checkOutboundUrlStatic,
  isWrappedWebhookSigningSecret,
  sendOutboundRequest,
  unwrapWebhookSigningSecret,
} from "@proovra/shared-runtime/outbound";
import {
  CREATOR_LOST_AUTHORITY_REASON,
  evaluateStandingCreatorAuthority,
  machineEgressRestricted,
  machineEgressTargetOf,
  resolveSharedSecretValue,
} from "@proovra/shared-runtime";
import { createHmac } from "node:crypto";
import { prisma } from "./db.js";
import { logger } from "./logger.js";
import { workerFeatureEntitled } from "./governance/workspace-entitlement.js";

/**
 * THE WORK THIS MODULE RECOVERS.
 *
 * Declared here so the canonical work registry's `reconciler` field can be
 * checked against the module it names rather than merely against the
 * filesystem. The topology gate proves the two agree in both directions: a
 * registry entry pointing at a module that does not claim its work fails, and
 * a module claiming work no entry assigns it fails.
 *
 * That check exists because the weaker one — "the declared file exists" —
 * passed three false declarations in a row: UPGRADE_OTS and
 * PURGE_DELETED_EVIDENCE both named a module containing no such code, and
 * EMBED_SEMANTIC_CHUNKS named one whose every scan keyed on a table the embed
 * chain never writes. All three resolved to a real file. None of them was true.
 *
 * Keys, not values: the registry addresses work through `JOB_NAMES` /
 * `SWEEP_NAMES`, and a literal string here would be a second spelling of a
 * name the shared authority already owns.
 */
export const RECOVERED_WORK_TYPES = [
  "WEBHOOK_DISPATCHER",
] as const;


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
  orderBy: Record<string, string | { sort: string; nulls: string }>;
  take: number;
  select: { id: true };
}): Promise<{ id: string }[]> {
  return (prisma.lifecycleWebhookDelivery.findMany as unknown as (
    a: typeof args,
  ) => Promise<{ id: string }[]>)(args);
}

/**
 * WS-SCHED / PRO-G1Z-07 — a write that settles THIS attempt. Fenced on the
 * DISPATCHING state the claim set, so a row released by the lease or replayed
 * meanwhile is never overwritten by a late attempt. Resolves to whether this
 * attempt's outcome was the one recorded.
 */
async function webhookDeliveryFencedUpdate(args: {
  where: { id: string };
  data: WebhookDeliveryUpdateData;
}): Promise<boolean> {
  const res = await (prisma.lifecycleWebhookDelivery.updateMany as unknown as (a: {
    where: Record<string, unknown>;
    data: WebhookDeliveryUpdateData;
  }) => Promise<{ count: number }>)({
    where: { id: args.where.id, state: "DISPATCHING" },
    data: args.data,
  });
  return res.count === 1;
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
/** Response bytes read (then discarded) before the connection is dropped. */
const RESPONSE_DRAIN_MAX_BYTES = 4 * 1024;
const PAYLOAD_SIZE_LIMIT_BYTES = 64 * 1024; // 64 KB
/** PRO-G1-09 — how long a delivery of a non-operating workspace waits before it is looked at again. */
const NOT_OPERATING_DEFER_MS = 15 * 60_000;

/**
 * PRO-G1-09 — the worker's reading of the API's `isLiveOperatingWorkspace`
 * (services/api/src/services/workspace/operating-workspace.ts): the same shared
 * classifier (`normalizeWorkspaceKind`), the same rule — a closed workspace is
 * not operating; an ORGANIZATION workspace operates only while its organization
 * is ACTIVE; an unprovable kind or a failed read fails CLOSED.
 */
async function workspaceIsOperating(teamId: string): Promise<boolean> {
  try {
    const team = await prisma.team.findUnique({
      where: { id: teamId },
      select: {
        isPersonal: true,
        workspaceKind: true,
        billingPlan: true,
        closedAtUtc: true,
        organization: { select: { status: true } },
      },
    });
    if (!team || team.closedAtUtc !== null) return false;
    const kind = normalizeWorkspaceKind({
      workspaceKind: team.workspaceKind,
      isPersonal: team.isPersonal,
      billingPlan: team.billingPlan,
      teamLoaded: true,
    });
    if (kind === "UNKNOWN") return false;
    if (kind === "ORGANIZATION") return team.organization?.status === "ACTIVE";
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function computeBackoffSeconds(attemptCount: number): number {
  const exp = Math.min(attemptCount, 16);
  const raw = Math.pow(2, exp) * BACKOFF_BASE_SECONDS;
  return Math.min(raw, BACKOFF_CAP_SECONDS);
}

/**
 * PRO-G1-02 — the endpoint's signing secret as stored: an `e3.3:` envelope
 * (AES-256-GCM, key derived from AUTH_JWT_SECRET exactly as the API derives
 * it) is opened; a legacy raw row is read as is until re-wrapped. Null when an
 * envelope does not authenticate (or the key is absent) — the delivery then
 * fails closed and nothing is sent.
 *
 * The key is resolved through the shared secrets authority (hydrated bundle,
 * then the trimmed environment) — the API's `getSecret` order. Reading
 * `process.env` alone split the two sides whenever AUTH_JWT_SECRET came from
 * Secrets Manager or carried surrounding whitespace (ROLLOUT-HANDOFF D5).
 */
export function readLifecycleSigningSecret(stored: string): string | null {
  if (isWrappedWebhookSigningSecret(stored)) {
    const material = resolveSharedSecretValue("AUTH_JWT_SECRET");
    if (!material) return null;
    return unwrapWebhookSigningSecret(stored, [material], "lifecycle-webhook");
  }
  return stored.length > 0 ? stored : null;
}

function signPayload(secretBase64: string, body: string): string {
  const key = Buffer.from(secretBase64, "base64");
  return createHmac("sha256", key).update(body, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Test seam. When a test injects one, the dispatcher still applies the
 * outbound policy to the endpoint URL before calling it; only the network
 * half (resolution inside the connection) is the injected function's.
 */
export type HttpFetcher = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ status: number; text: () => Promise<string> }>;

type Attempt =
  | { kind: "response"; status: number }
  | { kind: "network_error" }
  | { kind: "refused"; reason: string };

/**
 * PRO-061 / BILLING-02 — the production send is the shared outbound
 * transport. It used to be plain `fetch`, which followed redirects (so a
 * public endpoint could bounce the worker to the metadata service) and whose
 * body was stored and shown to the tenant. The shared send resolves the name
 * inside the connection and refuses any loopback, private, link-local or
 * metadata answer, so the address checked is the address connected to; it
 * never follows a redirect; and only the status is kept.
 */
async function sendViaSharedTransport(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<Attempt> {
  const result = await sendOutboundRequest({
    url,
    method: "POST",
    headers,
    body,
    timeoutMs: DELIVERY_TIMEOUT_MS,
    policy: LIFECYCLE_WEBHOOK_OUTBOUND_POLICY,
    maxResponseBytes: RESPONSE_DRAIN_MAX_BYTES,
  });
  if (result.kind === "refused") return { kind: "refused", reason: result.reason };
  if (result.kind === "error") return { kind: "network_error" };
  return { kind: "response", status: result.status };
}

async function sendViaInjectedFetcher(
  fetcher: HttpFetcher,
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<Attempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const res = await fetcher(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    // The body is never read: it is not stored and not shown (PRO-061).
    return { kind: "response", status: res.status };
  } catch {
    return { kind: "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

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
  /** NEW-RG-07-1 — the member the endpoint acts for. */
  createdByUserId: string;
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
    select: { id: true, url: true, state: true, secret: true, createdByUserId: true },
  });
}

async function dispatchOne(
  deliveryId: string,
  fetcher: HttpFetcher | undefined,
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

  // PRO-G1-09 / B7B-F02 — a closed workspace, or one whose organization is
  // suspended, sends nothing out. The emit path already refuses to queue in
  // that state; a delivery queued BEFORE the transition is deferred here
  // (attempt count untouched, nothing signed or claimed) and delivers after
  // the organization resumes. Closure also disables the endpoint, which the
  // check above turns into FAILED.
  if (!(await workspaceIsOperating(delivery.teamId))) {
    await webhookDeliveryUpdate({
      where: { id: deliveryId },
      data: {
        state: "RETRYING",
        nextAttemptAtUtc: new Date(Date.now() + NOT_OPERATING_DEFER_MS),
      },
    }).catch(() => null);
    logger.info({ deliveryId }, "webhook.dispatcher.workspace_not_operating_deferred");
    return;
  }

  // Integration: asked AFTER the operating check above, so a delivery of a
  // suspended (reversible) organization is deferred, not withheld for good.
  // PRO-W2-05 / PRO-G1-14 / DEC-09 — a delivery is sent only while the
  // workspace still holds FEATURE_WEBHOOKS (the API's emit asks it before the
  // row is written; this asks it again at send, so a delivery queued or
  // retrying when the entitlement was lost is not sent). Withheld, terminal,
  // with its reason; the endpoint stays ACTIVE, so the pause is reversible for
  // new events. Fails closed.
  if (!(await workerFeatureEntitled(delivery.teamId, "FEATURE_WEBHOOKS"))) {
    await webhookDeliveryUpdate({
      where: { id: deliveryId },
      data: {
        state: "WITHHELD",
        responseBodyPreview: "withheld:entitlement_required",
        lastAttemptAtUtc: new Date(),
      },
    }).catch(() => null);
    logger.info({ deliveryId }, "webhook.dispatcher.withheld_not_entitled");
    return;
  }

  // PRO-LEAD-01 / PRO-G1Z-01 / DEC-09 (matrix review NEW-RG-07-1) — the
  // endpoint acts in its creator's name: it sends only while the creator still
  // holds integration.lifecycle_webhook.manage by the canonical member
  // decision (role, live capability grant or delegated scope; access-window
  // expiry set aside, A2-26), the same shared authority the API's emit, its
  // integration sends and its retries ask. A capability or scope that expired
  // is ended by no transition, so this use-time check is what stops a queued
  // or retrying delivery. LOST deactivates the endpoint (as the emit does) and
  // settles the delivery FAILED with the reason; an unreadable or
  // workspace-blocked answer defers it without sending or counting an attempt.
  const creator = await evaluateStandingCreatorAuthority(prisma as never, {
    teamId: delivery.teamId,
    userId: endpoint.createdByUserId,
    permission: "integration.lifecycle_webhook.manage",
  });
  if (creator.verdict === "LOST") {
    await (prisma.lifecycleWebhookEndpoint.updateMany as unknown as (a: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => Promise<unknown>)({
      where: { id: endpoint.id, state: "ACTIVE" },
      data: { state: "DEACTIVATED", deactivatedAtUtc: new Date() },
    }).catch(() => null);
    await webhookDeliveryUpdate({
      where: { id: deliveryId },
      data: {
        state: "FAILED",
        responseBodyPreview: CREATOR_LOST_AUTHORITY_REASON,
        lastAttemptAtUtc: new Date(),
      },
    }).catch(() => null);
    logger.info({ deliveryId, reason: creator.reason }, "webhook.dispatcher.creator_lost_authority");
    return;
  }
  if (creator.verdict !== "HOLDS") {
    await webhookDeliveryUpdate({
      where: { id: deliveryId },
      data: {
        state: "RETRYING",
        nextAttemptAtUtc: new Date(Date.now() + NOT_OPERATING_DEFER_MS),
      },
    }).catch(() => null);
    logger.info({ deliveryId, verdict: creator.verdict }, "webhook.dispatcher.creator_authority_deferred");
    return;
  }

  // PRO-LEAD-02 / AZ-R04 (matrix review NEW-RG-11-2) — the machine-egress rule
  // is asked again at send, as the integration retry processor does: a
  // delivery queued before its record or case became closed by a restricted
  // case does not leave. Withheld, terminal, with its reason; the endpoint
  // stays ACTIVE (new events about open records still deliver). Fails closed.
  const egressPayload =
    delivery.payload && typeof delivery.payload === "object" && !Array.isArray(delivery.payload)
      ? (delivery.payload as Record<string, unknown>)
      : {};
  if (await machineEgressRestricted(machineEgressTargetOf(egressPayload), prisma as never)) {
    await webhookDeliveryUpdate({
      where: { id: deliveryId },
      data: {
        state: "WITHHELD",
        responseBodyPreview: "withheld:machine_egress_restricted",
        lastAttemptAtUtc: new Date(),
      },
    }).catch(() => null);
    logger.info({ deliveryId }, "webhook.dispatcher.withheld_machine_egress");
    return;
  }

  // PRO-061 — the stored URL is checked against the shared policy at every
  // send. An endpoint written before the policy existed (loopback, private,
  // metadata, `localhost.`) is refused permanently and nothing is sent.
  const destination = checkOutboundUrlStatic(
    endpoint.url,
    LIFECYCLE_WEBHOOK_OUTBOUND_POLICY,
  );
  if (!destination.ok || destination.url.protocol !== "https:") {
    logger.warn(
      {
        deliveryId,
        reason: destination.ok ? "non_https_scheme" : destination.reason,
      },
      "webhook.dispatcher.destination_refused",
    );
    await webhookDeliveryUpdate({
      where: { id: deliveryId },
      data: { state: "FAILED", lastAttemptAtUtc: new Date() },
    }).catch(() => null);
    await emitLifecycleEvent({
      teamId: delivery.teamId,
      deliveryId,
      code: "WEBHOOK_FAILED",
    });
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
  const signingSecret = readLifecycleSigningSecret(endpoint.secret);
  if (!signingSecret) {
    logger.warn({ deliveryId }, "webhook.dispatcher.signing_secret_unreadable");
    await webhookDeliveryUpdate({
      where: { id: deliveryId },
      data: { state: "FAILED", lastAttemptAtUtc: new Date() },
    }).catch(() => null);
    await emitLifecycleEvent({
      teamId: delivery.teamId,
      deliveryId,
      code: "WEBHOOK_FAILED",
    });
    return;
  }
  const signature = signPayload(signingSecret, canonical);
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

  const headers = {
    "content-type": "application/json",
    "x-proovra-signature": signature,
    "x-proovra-delivery-id": delivery.id,
    "x-proovra-event-kind": delivery.eventKind,
  };
  const attempt = fetcher
    ? await sendViaInjectedFetcher(fetcher, endpoint.url, headers, canonical)
    : await sendViaSharedTransport(endpoint.url, headers, canonical);

  if (attempt.kind === "refused") {
    // Resolution answered a refused address (or the policy refused the URL):
    // nothing was sent, and the same name will answer the same way.
    logger.warn(
      { deliveryId, reason: attempt.reason },
      "webhook.dispatcher.destination_refused",
    );
    const recorded = await webhookDeliveryFencedUpdate({
      where: { id: deliveryId },
      data: {
        state: "FAILED",
        attemptCount: nextAttemptCount,
        lastAttemptAtUtc: new Date(),
        responseStatus: null,
        responseBodyPreview: null,
      },
    }).catch(() => false);
    if (recorded) {
      await emitLifecycleEvent({
        teamId: delivery.teamId,
        deliveryId,
        code: "WEBHOOK_FAILED",
      });
    }
    return;
  }
  const responseStatus: number | null =
    attempt.kind === "response" ? attempt.status : null;
  const networkError = attempt.kind === "network_error";

  const now = new Date();
  const baseUpdate = {
    attemptCount: nextAttemptCount,
    lastAttemptAtUtc: now,
    responseStatus,
    // PRO-061 — the receiver's body is never stored (it was returned to the
    // tenant by the deliveries route).
    responseBodyPreview: null,
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
    const recorded = await webhookDeliveryFencedUpdate({
      where: { id: deliveryId },
      data: { ...baseUpdate, state: "DELIVERED", deliveredAtUtc: now },
    }).catch(() => false);
    if (!recorded) return;
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

  // Hard 3xx/4xx failure (not 429) — do not retry. A redirect is not
  // followed (PRO-061) and is the receiver's definite answer.
  if (
    !isRetryable &&
    responseStatus !== null &&
    responseStatus >= 300 &&
    responseStatus < 500
  ) {
    const recorded = await webhookDeliveryFencedUpdate({
      where: { id: deliveryId },
      data: { ...baseUpdate, state: "FAILED" },
    }).catch(() => false);
    if (!recorded) return;
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
    const recorded = await webhookDeliveryFencedUpdate({
      where: { id: deliveryId },
      data: {
        ...baseUpdate,
        state: "DEAD_LETTERED",
        deadLetteredAtUtc: now,
      },
    }).catch(() => false);
    if (!recorded) return;
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
  const recorded = await webhookDeliveryFencedUpdate({
    where: { id: deliveryId },
    data: {
      ...baseUpdate,
      state: "RETRYING",
      nextAttemptAtUtc,
    },
  }).catch(() => false);
  if (!recorded) return;
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

/**
 * WS-SCHED / PRO-W2-07 — one tick at a time per process. The scheduler fires
 * every 5 s and a tick against slow endpoints can run for minutes; without a
 * guard ticks stacked, so outbound concurrency grew to (running ticks x
 * CONCURRENCY_CAP) instead of CONCURRENCY_CAP. A tick that starts while one is
 * running returns at once (the next due rows are picked up when it finishes).
 * Across replicas the row claim still makes each send exclusive.
 */
let tickRunning = false;

export async function runWebhookDispatcherTick(options?: {
  fetcher?: HttpFetcher;
}): Promise<void> {
  if (tickRunning) return;
  tickRunning = true;
  try {
    await runWebhookDispatcherTickInner(options);
  } finally {
    tickRunning = false;
  }
}

async function runWebhookDispatcherTickInner(options?: {
  fetcher?: HttpFetcher;
}): Promise<void> {
  const fetcher = options?.fetcher;

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
      // PRO-W2-07 — first attempts (PENDING, nextAttemptAtUtc NULL) are not
      // queued behind every due retry: Postgres sorts NULL last by default.
      orderBy: { nextAttemptAtUtc: { sort: "asc", nulls: "first" } },
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
