/**
 * Phase 10.5 — Webhook delivery operations.
 *
 * Two responsibilities:
 *
 *   1. Operator-facing actions on a single delivery row:
 *        - get one (scoped to workspace)
 *        - retry one (FAILED or RETRY_SCHEDULED → re-attempt)
 *        - cancel one (RETRY_SCHEDULED → CANCELLED)
 *
 *   2. Retention cleanup of old terminal deliveries (SENT / FAILED /
 *      CANCELLED only). Active rows (PENDING / RETRY_SCHEDULED) are
 *      NEVER swept.
 *
 * All projections deliberately exclude `payloadJson` because the body
 * may contain workspace-scoped data (titles, file hashes, etc.) that
 * should remain visible only to authorised operators. Routes are
 * already workspace-scoped via `requireMember` + the
 * `integration.webhook.manage` permission, but the projection still
 * leaves payload out by default.
 */

import type {
  IntegrationWebhookDelivery as DbDelivery,
  PrismaClient,
} from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import { attemptDelivery } from "./webhook-dispatcher.js";

export class WebhookDeliveryOpError extends Error {
  constructor(
    public readonly code:
      | "delivery_not_found"
      | "endpoint_not_found"
      | "endpoint_inactive"
      | "delivery_not_retryable"
      | "delivery_not_cancellable",
  ) {
    super(code);
    this.name = "WebhookDeliveryOpError";
  }
}

export async function getWebhookDelivery(
  input: { id: string; teamId: string },
  client: PrismaClient = defaultPrisma,
): Promise<DbDelivery | null> {
  return client.integrationWebhookDelivery.findFirst({
    where: { id: input.id, teamId: input.teamId },
  });
}

/**
 * Operator-triggered retry. Accepts deliveries in FAILED or
 * RETRY_SCHEDULED state (NOT PENDING — those are mid-flight). Resets
 * the row to PENDING and re-runs the dispatcher inline.
 *
 * Returns the post-attempt row so the caller can render the new state.
 */
export async function manuallyRetryWebhookDelivery(
  input: { id: string; teamId: string },
  client: PrismaClient = defaultPrisma,
): Promise<DbDelivery> {
  const delivery = await getWebhookDelivery(input, client);
  if (!delivery) throw new WebhookDeliveryOpError("delivery_not_found");
  if (
    delivery.status !== "FAILED" &&
    delivery.status !== "RETRY_SCHEDULED"
  ) {
    throw new WebhookDeliveryOpError("delivery_not_retryable");
  }
  const endpoint = await client.webhookEndpoint.findUnique({
    where: { id: delivery.endpointId },
  });
  if (!endpoint) throw new WebhookDeliveryOpError("endpoint_not_found");
  if (endpoint.status !== "ACTIVE") {
    throw new WebhookDeliveryOpError("endpoint_inactive");
  }

  // Atomic claim — only proceed if status is still what we observed.
  const claim = await client.integrationWebhookDelivery.updateMany({
    where: { id: delivery.id, status: delivery.status },
    data: {
      status: "PENDING",
      errorMessage: null,
      nextAttemptAtUtc: null,
    },
  });
  if (claim.count !== 1) {
    // Lost the race; return whatever's there now.
    const fresh = await client.integrationWebhookDelivery.findUnique({
      where: { id: delivery.id },
    });
    if (!fresh) throw new WebhookDeliveryOpError("delivery_not_found");
    return fresh;
  }

  const refreshed = await client.integrationWebhookDelivery.findUnique({
    where: { id: delivery.id },
  });
  if (!refreshed) throw new WebhookDeliveryOpError("delivery_not_found");

  await attemptDelivery(refreshed, endpoint, client);

  // Return the post-attempt state.
  const post = await client.integrationWebhookDelivery.findUnique({
    where: { id: delivery.id },
  });
  return post ?? refreshed;
}

export async function cancelWebhookDelivery(
  input: { id: string; teamId: string },
  client: PrismaClient = defaultPrisma,
): Promise<DbDelivery> {
  const delivery = await getWebhookDelivery(input, client);
  if (!delivery) throw new WebhookDeliveryOpError("delivery_not_found");
  if (delivery.status !== "RETRY_SCHEDULED") {
    throw new WebhookDeliveryOpError("delivery_not_cancellable");
  }
  const claim = await client.integrationWebhookDelivery.updateMany({
    where: { id: delivery.id, status: "RETRY_SCHEDULED" },
    data: {
      status: "CANCELLED",
      errorMessage: "cancelled_by_operator",
      nextAttemptAtUtc: null,
      failedAtUtc: new Date(),
    },
  });
  if (claim.count !== 1) {
    const fresh = await client.integrationWebhookDelivery.findUnique({
      where: { id: delivery.id },
    });
    if (!fresh) throw new WebhookDeliveryOpError("delivery_not_found");
    return fresh;
  }
  const updated = await client.integrationWebhookDelivery.findUnique({
    where: { id: delivery.id },
  });
  if (!updated) throw new WebhookDeliveryOpError("delivery_not_found");
  return updated;
}

// -----------------------------------------------------------------------------
// Retention cleanup
// -----------------------------------------------------------------------------

const RETENTION_ENV = "WEBHOOK_DELIVERY_RETENTION_DAYS";
const RETENTION_DEFAULT_DAYS = 90;
const RETENTION_MIN_DAYS = 7;
const RETENTION_MAX_DAYS = 3650; // ~10 years cap

export function readWebhookDeliveryRetentionDays(): number {
  const raw = process.env[RETENTION_ENV];
  if (!raw) return RETENTION_DEFAULT_DAYS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return RETENTION_DEFAULT_DAYS;
  if (n < RETENTION_MIN_DAYS) return RETENTION_MIN_DAYS;
  if (n > RETENTION_MAX_DAYS) return RETENTION_MAX_DAYS;
  return n;
}

export type CleanupWebhookDeliveriesSummary = {
  retentionDays: number;
  cutoffUtc: string;
  deleted: number;
  // Defensive counters — these stay zero unless the SQL below is
  // changed to accidentally match an active row.
  preservedActive: number;
};

/**
 * Delete terminal deliveries (SENT / FAILED / CANCELLED) older than the
 * configured retention window. Never deletes PENDING / RETRY_SCHEDULED
 * rows, even if their `createdAt` is past the cutoff.
 *
 * Returns a small summary suitable for cron logs. Best-effort: if the
 * SQL fails the sweeper is safe to re-invoke.
 */
export async function cleanupOldWebhookDeliveries(
  input: { retentionDays?: number; batchSize?: number } = {},
  client: PrismaClient = defaultPrisma,
): Promise<CleanupWebhookDeliveriesSummary> {
  const retentionDays = (() => {
    if (typeof input.retentionDays === "number") {
      const r = Math.floor(input.retentionDays);
      if (r < RETENTION_MIN_DAYS) return RETENTION_MIN_DAYS;
      if (r > RETENTION_MAX_DAYS) return RETENTION_MAX_DAYS;
      return r;
    }
    return readWebhookDeliveryRetentionDays();
  })();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000);
  const batchSize = Math.min(Math.max(input.batchSize ?? 1000, 1), 10_000);

  // Defensive count of any active rows past the cutoff. Should always
  // be zero by design; surface it if not for operator visibility.
  const preservedActive = await client.integrationWebhookDelivery.count({
    where: {
      createdAt: { lt: cutoff },
      status: { in: ["PENDING", "RETRY_SCHEDULED"] },
    },
  });

  // Loop in fixed-size batches so a long sweep does not lock the table.
  let deleted = 0;
  // Single-batch implementation; Prisma's deleteMany cannot LIMIT, so
  // we select ids then delete.
  // Run up to N batches to bound worst-case execution time.
  const maxBatches = 50;
  for (let i = 0; i < maxBatches; i += 1) {
    const ids = await client.integrationWebhookDelivery.findMany({
      where: {
        createdAt: { lt: cutoff },
        status: { in: ["SENT", "FAILED", "CANCELLED"] },
      },
      select: { id: true },
      take: batchSize,
    });
    if (ids.length === 0) break;
    const result = await client.integrationWebhookDelivery.deleteMany({
      where: {
        id: { in: ids.map((r) => r.id) },
        status: { in: ["SENT", "FAILED", "CANCELLED"] },
      },
    });
    deleted += result.count;
    if (ids.length < batchSize) break;
  }

  return {
    retentionDays,
    cutoffUtc: cutoff.toISOString(),
    deleted,
    preservedActive,
  };
}

// -----------------------------------------------------------------------------
// Projection — used by routes. Excludes payloadJson by default.
// -----------------------------------------------------------------------------

export function projectWebhookDeliveryDetail(d: DbDelivery): {
  id: string;
  endpointId: string;
  teamId: string;
  eventId: string;
  eventType: string;
  status: string;
  attemptCount: number;
  nextAttemptAtUtc: string | null;
  responseStatus: number | null;
  responseBodyPreview: string | null;
  errorMessage: string | null;
  sentAtUtc: string | null;
  failedAtUtc: string | null;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: d.id,
    endpointId: d.endpointId,
    teamId: d.teamId,
    eventId: d.eventId,
    eventType: d.eventType,
    status: d.status,
    attemptCount: d.attemptCount,
    nextAttemptAtUtc: d.nextAttemptAtUtc?.toISOString() ?? null,
    responseStatus: d.responseStatus,
    responseBodyPreview: truncate(d.responseBodyPreview, 2000),
    errorMessage: truncate(d.errorMessage, 400),
    sentAtUtc: d.sentAtUtc?.toISOString() ?? null,
    failedAtUtc: d.failedAtUtc?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    // Deliberately NOT projected: payloadJson (workspace-scoped data),
    // signing secrets, raw bodies.
  };
}

function truncate(s: string | null, max: number): string | null {
  if (!s) return s;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
