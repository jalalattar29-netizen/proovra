/**
 * PROOVRA Phase 4B — Webhook Platform Service.
 *
 * Outbound webhook lifecycle for the Phase 4B lifecycle product line:
 *   * Endpoint CRUD (create / deactivate / list).
 *   * Event emission (one canonical-JSON payload, HMAC-SHA256 signed
 *     per endpoint, one row per (endpoint, event) inserted PENDING).
 *   * Delivery itself is the worker dispatcher's (PRO-W2-12): bounded
 *     exponential backoff and dead-letter live there, once.
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
  isWrappedWebhookSigningSecret,
  unwrapWebhookSigningSecret,
  wrapWebhookSigningSecret,
  type OutboundUrlCheck,
} from "@proovra/shared-runtime/outbound";

import { prisma as defaultPrisma } from "../../../db.js";
import { getSecret } from "../../../config/runtime-secrets.js";
import { isLiveOperatingWorkspace } from "../../workspace/operating-workspace.js";
import {
  STANDING_CREDENTIAL_PERMISSION,
  evaluateCreatorAuthority,
  type CreatorAuthorityVerdict,
} from "../../sharing/standing-credential-authority.js";
import { inputRefusal } from "../../../errors.js";
import type { EntitlementProjection } from "@proovra/shared";
import { admitWebhookDelivery, assertLimitEntitlementTx, resolveEntitlement } from "../entitlement.service.js";
import { machineEgressRestricted, machineEgressTargetOf } from "../../access/record-reach.js";

// -----------------------------------------------------------------------------
// Bounded constants — keep all magic numbers here.
// -----------------------------------------------------------------------------

const SECRET_RANDOM_BYTES = 32;
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

/**
 * PRO-G1-02 — the key material the lifecycle secret wrap is derived from. The
 * Worker derives the same key from the same secret (AUTH_JWT_SECRET), so a
 * secret wrapped here is readable where it is signed.
 */
function lifecycleWrapKeyMaterial(): string {
  return getSecret("AUTH_JWT_SECRET") ?? "dev-jwt-secret-not-for-production";
}

/** Wrap a fresh lifecycle signing secret for the `webhook_endpoints.secret` column. */
export function wrapLifecycleSigningSecret(secretBase64: string): string {
  return wrapWebhookSigningSecret(secretBase64, lifecycleWrapKeyMaterial(), "lifecycle-webhook");
}

/**
 * The signing secret of a stored lifecycle endpoint: an `e3.3:` envelope is
 * opened (null when it does not authenticate — the caller fails closed); a
 * legacy row still holding the raw value is read as is until re-wrapped.
 */
export function readLifecycleSigningSecret(stored: string): string | null {
  if (isWrappedWebhookSigningSecret(stored)) {
    return unwrapWebhookSigningSecret(stored, [lifecycleWrapKeyMaterial()], "lifecycle-webhook");
  }
  return stored.length > 0 ? stored : null;
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
  // AUD-0017 (TXP-019) — the ceiling is resolved before the transaction; only
  // the live count is taken under the lock, on the transaction's connection.
  const resolved = await resolveEntitlement({
    prisma,
    teamId: input.teamId,
    key: "INTEGRATION_WEBHOOK_ENDPOINTS_MAX",
  });
  const row = await prisma.$transaction(async (tx) => {
    const admitted = await assertLimitEntitlementTx({
      tx,
      prisma,
      teamId: input.teamId,
      key: "INTEGRATION_WEBHOOK_ENDPOINTS_MAX",
      requested: 1,
      resolved,
    });
    if (!admitted.ok) {
      throw new WebhookEndpointLimitError(admitted.limit, admitted.current);
    }
    return tx.lifecycleWebhookEndpoint.create({
      data: {
        teamId: input.teamId,
        url: input.url.trim(),
        // PRO-G1-02 — never the raw secret at rest: the shared AES-GCM envelope.
        secret: wrapLifecycleSigningSecret(secret),
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

/**
 * PRO-LEAD-01 / PRO-G1Z-01 / NEW-RG-07-2 — THE creator-standing decision for a
 * lifecycle endpoint, shared by every API path that queues a delivery to it
 * (`emitWebhookEvent` and the manual replay). The endpoint acts in its
 * creator's name, so the creator's standing is asked by the canonical decision
 * (access-window expiry set aside, A2-26). LOST deactivates the endpoint (a
 * conditional write); any answer other than HOLDS queues nothing.
 */
export async function lifecycleEndpointCreatorStanding(
  input: { teamId: string; endpointId: string; createdByUserId: string },
  prisma: PrismaClient = defaultPrisma,
): Promise<CreatorAuthorityVerdict> {
  const creator = await evaluateCreatorAuthority(
    {
      teamId: input.teamId,
      userId: input.createdByUserId,
      permission: STANDING_CREDENTIAL_PERMISSION.lifecycleWebhook,
    },
    prisma,
  );
  if (creator.verdict === "LOST") {
    await prisma.lifecycleWebhookEndpoint
      .updateMany({
        where: { id: input.endpointId, teamId: input.teamId, state: "ACTIVE" },
        data: { state: "DEACTIVATED", deactivatedAtUtc: new Date() },
      })
      .catch(() => null);
  }
  return creator;
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
      createdByUserId: true,
    },
  });

  if (endpoints.length === 0) return { deliveryIds: [] };
  // B7B-F02 — a closed workspace, or one whose organization is suspended,
  // queues no lifecycle delivery (closure and workspace suspension also
  // DEACTIVATE the endpoints; an organization suspension is reversible).
  if (!(await isLiveOperatingWorkspace(input.teamId, prisma))) return { deliveryIds: [] };
  // PRO-LEAD-02 / B7B-F01 — a lifecycle endpoint is a machine on no access
  // list: an event about a record or case a restricted case closes (a hold on
  // it, a package built from it) is not queued. Fails closed.
  if (await machineEgressRestricted(machineEgressTargetOf(input.payload), prisma)) return { deliveryIds: [] };

  const canonical = canonicalJson(input.payload);
  const deliveryIds: string[] = [];
  const admissionCache = new Map<string, EntitlementProjection>();

  for (const ep of endpoints) {
    const subs = normalizeSubscribedEvents(ep.subscribedEvents);
    if (!subs.includes(input.eventKind)) continue;
    // PRO-LEAD-01 / PRO-G1Z-01 — the endpoint acts in its creator's name. This
    // is the one place a lifecycle delivery is queued (the worker only sends
    // queued rows), so the creator's standing is asked here by the canonical
    // decision (access-window expiry set aside, A2-26). LOST — e.g. a
    // capability or delegated scope that expired, which no transition ends —
    // deactivates the endpoint and queues nothing; an unreadable or
    // workspace-blocked answer queues nothing and ends nothing.
    const creator = await lifecycleEndpointCreatorStanding(
      { teamId: input.teamId, endpointId: ep.id, createdByUserId: ep.createdByUserId },
      prisma,
    );
    if (creator.verdict !== "HOLDS") continue;
    // PRO-W2-05 / PRO-G1-04 / B7B-F05 / DEC-09 — entitlement and the daily
    // delivery quota at USE time, per delivery (the same gate the integration
    // channel asks). A withheld delivery is recorded WITHHELD (terminal; the
    // dispatcher polls only PENDING/RETRYING) with its reason, and nothing is
    // sent. Reversible: the endpoint stays ACTIVE.
    const admission = await admitWebhookDelivery({
      prisma,
      teamId: input.teamId,
      featureKey: "FEATURE_WEBHOOKS",
      cache: admissionCache,
    });
    if (!admission.ok) {
      await prisma.lifecycleWebhookDelivery
        .create({
          data: {
            teamId: input.teamId,
            endpointId: ep.id,
            eventKind: input.eventKind,
            payload: input.payload as object,
            signature: "",
            state: "WITHHELD",
            attemptCount: 0,
            responseBodyPreview: `withheld:${admission.reason}`,
          },
          select: { id: true },
        })
        .catch(() => null);
      continue;
    }
    // PRO-G1-02 — an envelope that does not authenticate signs nothing.
    const signingSecret = readLifecycleSigningSecret(ep.secret);
    if (!signingSecret) continue;
    const signature = signPayload(signingSecret, canonical);
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
// Delivery
// -----------------------------------------------------------------------------
//
// WS-SCHED / PRO-W2-12 — there is ONE dispatcher: the worker's
// (services/worker/src/webhook-dispatcher.ts, the module the work registry
// names). A second, caller-less `deliverWebhookDelivery` lived here with a
// different wire contract (other header names, another timeout, no row claim,
// no persisted next attempt). It was removed rather than kept as a trap for a
// future caller; this module emits PENDING rows and the worker sends them.

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
