/**
 * Phase 8 — Notification orchestration service.
 *
 * Single entry point for every operational notification PROOVRA sends.
 * Business code calls `notificationService.sendEvidenceRequestSent({...})`
 * and never touches the Resend SDK directly.
 *
 * Responsibilities:
 *   1. Feature-flag gate — if NOTIFICATIONS_ENABLED is not "true", every
 *      send is a no-op recorded as a SKIPPED NotificationDelivery row.
 *   2. Persist a NotificationDelivery row in PENDING before send (so a
 *      crash mid-send leaves a recoverable record).
 *   3. Dispatch through the provider abstraction (Resend today; SMS /
 *      webhook in future phases).
 *   4. Update the delivery row to SENT (with providerMessageId) or
 *      FAILED + RETRY_SCHEDULED (with errorCode/message + nextAttemptAtUtc).
 *   5. Never throw to the business caller — workflow lifecycle is
 *      decoupled from email delivery. The caller may inspect the returned
 *      result if they care.
 *
 * Privacy contract:
 *   - The renderer is the ONLY place that builds outgoing message bodies.
 *     It scrubs reviewer notes, hides token internals, and renders ONLY
 *     the safe-to-show fields documented in renderers below.
 *   - NotificationDelivery.metadata never contains tokens, hashes, IPs,
 *     reviewer notes, or workspace internals.
 *   - The `rendered_preview` column carries a short plaintext snippet
 *     bounded to 2000 chars — useful for support but never sufficient to
 *     reconstruct the full HTML.
 */

import {
  classifyNotificationProviderError,
  NotificationEventType,
  notificationRetryDelaySeconds,
  NOTIFICATION_RETRY_MAX_ATTEMPTS,
} from "@proovra/shared";
import { createHash, randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";
import type {
  PrismaClient,
  NotificationDelivery as DbNotificationDelivery,
} from "@prisma/client";

import {
  mintEmailIdempotencyKey,
  readStoredIdempotencyKey,
  STORED_IDEMPOTENCY_KEY_FIELD,
} from "@proovra/shared-runtime";

import type { RecipientContactDisclosure } from "../privacy/recipient-contact-disclosure.js";
import { maskEmail, maskPhonePreview } from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { emitWebhookEvent } from "../integrations/webhook-dispatcher.js";
import { renderTransactionalTemplate, TemplateContext } from "./templates.js";
import { sendViaResend } from "./resend-provider.js";

// -----------------------------------------------------------------------------
// Phase closure — `notification.failed` lifecycle event.
//
// Fires AFTER the durable status transition to FAILED — never before, so a
// subscriber that triggers another webhook delivery cannot observe a row
// that the DB has not yet committed as terminal. Six call sites converge
// through this helper:
//   1. sendEmailNotification → provider threw, non-retriable
//   2. sendEmailNotification → provider returned error, non-retriable
//   3. dispatchDelivery       → missing_template_context (immediate FAILED)
//   4. dispatchDelivery       → provider threw, non-retriable
//   5. dispatchDelivery       → provider returned error, non-retriable
//   6. (none else — RETRY_SCHEDULED is NOT terminal and MUST NOT emit)
//
// Privacy contract:
//   - `recipient` is hashed (sha256, hex, full 64 chars). The raw value
//     never crosses into webhook payloads — only the deterministic hash so
//     a subscriber can correlate failures across deliveries without seeing
//     the email/phone.
//   - `errorMessage` is dropped entirely. Provider stack traces / SDK
//     error text frequently echo addresses, query strings, or token
//     fragments; we surface only the bounded `errorCode` literal which the
//     codebase always populates with a known sentinel ("provider_threw",
//     "missing_template_context", etc.).
//   - Never throws into the caller. Webhook persistence failures are
//     swallowed by the dispatcher; this helper additionally try/catches
//     to absorb a hashing or env-flag error.
// -----------------------------------------------------------------------------

const NOTIFICATION_FAILED_EVENT = "notification.failed" as const;

/** Operation discriminator for this family provider idempotency keys. */
export const NOTIFICATION_IDEMPOTENCY_OPERATION = "notification_delivery";

function hashRecipientForWebhook(recipient: string): string | null {
  if (!recipient) return null;
  try {
    return createHash("sha256").update(recipient, "utf8").digest("hex");
  } catch {
    return null;
  }
}

async function emitNotificationFailedWebhook(
  delivery: DbNotificationDelivery,
  client: PrismaClient,
): Promise<void> {
  try {
    // The integrations dispatcher already no-ops when the feature flag
    // is off and when no subscribed endpoint matches. We still gate on
    // teamId because deliveries without a workspace anchor cannot fan
    // out to any tenant's endpoints.
    if (!delivery.teamId) return;
    const payload: Record<string, unknown> = {
      teamId: delivery.teamId,
      notificationId: delivery.id,
      eventType: delivery.eventType,
      channel: delivery.channel,
      provider: delivery.provider,
      // Bounded sentinel set by every FAILED branch in this file
      // ("provider_threw", "missing_template_context", "feature_flag_off",
      // "missing_recipient", or a provider-returned <= 80 char code).
      reason: delivery.errorCode ?? "unknown",
      failedAtUtc:
        delivery.failedAtUtc?.toISOString() ?? new Date().toISOString(),
      // Hash, not raw — see privacy contract above.
      recipientHash: hashRecipientForWebhook(delivery.recipient),
      ...(delivery.evidenceRequestId
        ? { evidenceRequestId: delivery.evidenceRequestId }
        : {}),
      ...(delivery.evidenceId ? { evidenceId: delivery.evidenceId } : {}),
      ...(delivery.intakeLinkId ? { intakeLinkId: delivery.intakeLinkId } : {}),
    };
    await emitWebhookEvent(
      {
        teamId: delivery.teamId,
        eventType: NOTIFICATION_FAILED_EVENT,
        payload,
        // Defer to the retry sweeper — the notification lifecycle has
        // already terminated, no need to block the originating workflow
        // on an outbound webhook attempt.
        attemptInline: false,
      },
      client,
    );
  } catch {
    // Best-effort. A webhook emit MUST NEVER unwind the notification
    // failure write. The row is already FAILED in the DB.
  }
}

// -----------------------------------------------------------------------------
// Feature flag
// -----------------------------------------------------------------------------

const FLAG_ENV = "NOTIFICATIONS_ENABLED";

export function isNotificationsFeatureEnabled(): boolean {
  return process.env[FLAG_ENV] === "true";
}

// -----------------------------------------------------------------------------
// Input shapes
// -----------------------------------------------------------------------------

export type SendEmailNotificationInput = {
  eventType: NotificationEventType;
  teamId?: string | null;
  recipientEmail: string;
  recipientName?: string | null;
  recipientUserId?: string | null;
  evidenceRequestId?: string | null;
  evidenceId?: string | null;
  intakeLinkId?: string | null;
  initiatedByUserId?: string | null;
  /**
   * Template inputs — the renderer is responsible for using only the safe
   * fields below. Adding new fields here requires updating
   * templates.ts AND verifying privacy with a renderer test.
   */
  template: TemplateContext;
};

export type NotificationSendResult = {
  delivery: DbNotificationDelivery;
  status:
    | "sent"
    | "skipped_feature_disabled"
    | "skipped_no_recipient"
    | "failed"
    | "retry_scheduled";
};

// -----------------------------------------------------------------------------
// sendEmailNotification — the single dispatch entry point
// -----------------------------------------------------------------------------

export async function sendEmailNotification(
  input: SendEmailNotificationInput,
  client: PrismaClient = defaultPrisma,
): Promise<NotificationSendResult> {
  const recipientEmail = (input.recipientEmail ?? "").trim();
  if (!recipientEmail) {
    // We don't have anyone to send to. Record a SKIPPED row so the audit
    // trail explains the gap, but treat it as success from the caller's
    // perspective.
    const delivery = await client.notificationDelivery.create({
      data: {
        teamId: input.teamId ?? null,
        eventType: input.eventType,
        channel: "EMAIL",
        provider: "RESEND",
        recipient: "(missing)",
        recipientName: input.recipientName ?? null,
        recipientUserId: input.recipientUserId ?? null,
        evidenceRequestId: input.evidenceRequestId ?? null,
        evidenceId: input.evidenceId ?? null,
        intakeLinkId: input.intakeLinkId ?? null,
        status: "SKIPPED",
        templateKey: input.eventType,
        errorCode: "missing_recipient",
        initiatedByUserId: input.initiatedByUserId ?? null,
      },
    });
    return { delivery, status: "skipped_no_recipient" };
  }

  // Feature-flag short-circuit. The row is still persisted so admins see
  // the intent in the audit trail; production may have notifications off
  // intentionally during rollout.
  if (!isNotificationsFeatureEnabled()) {
    const delivery = await client.notificationDelivery.create({
      data: {
        teamId: input.teamId ?? null,
        eventType: input.eventType,
        channel: "EMAIL",
        provider: "RESEND",
        recipient: recipientEmail,
        recipientName: input.recipientName ?? null,
        recipientUserId: input.recipientUserId ?? null,
        evidenceRequestId: input.evidenceRequestId ?? null,
        evidenceId: input.evidenceId ?? null,
        intakeLinkId: input.intakeLinkId ?? null,
        status: "SKIPPED",
        templateKey: input.eventType,
        errorCode: "feature_flag_off",
        initiatedByUserId: input.initiatedByUserId ?? null,
      },
    });
    return { delivery, status: "skipped_feature_disabled" };
  }

  // Render the template before persisting. Rendering is pure — failure
  // here is a programming bug, not a transient runtime issue, so we let
  // it surface. The caller wraps the whole notification call in a
  // try/catch that does not abort the business workflow.
  const rendered = renderTransactionalTemplate(input.eventType, input.template);

  // PHASE 12 POINT 5 — the id is minted here so the provider idempotency
  // key can be derived from it and stored in the SAME insert. Every retry of
  // this delivery loads that key rather than re-deriving one.
  const deliveryId = randomUUID();
  const deliveryIdempotencyKey = mintEmailIdempotencyKey(
    NOTIFICATION_IDEMPOTENCY_OPERATION,
    deliveryId,
  );
  const delivery = await client.notificationDelivery.create({
    data: {
      id: deliveryId,
      teamId: input.teamId ?? null,
      eventType: input.eventType,
      channel: "EMAIL",
      provider: "RESEND",
      recipient: recipientEmail,
      recipientName: input.recipientName ?? null,
      recipientUserId: input.recipientUserId ?? null,
      evidenceRequestId: input.evidenceRequestId ?? null,
      evidenceId: input.evidenceId ?? null,
      intakeLinkId: input.intakeLinkId ?? null,
      status: "PENDING",
      subject: rendered.subject.slice(0, 400),
      templateKey: input.eventType,
      renderedPreview: rendered.plaintextPreview.slice(0, 2000),
      // Phase 8.5 — persist the exact context used to render this
      // notification so retries / manual resends can reproduce the
      // original message without re-reaching into workspace state.
      // The renderer's TemplateContext shape is the privacy boundary;
      // no reviewer note, no token hash, no IP/UA ever lands here.
      templateContextJson: input.template as unknown as Prisma.InputJsonValue,
      // Ids and the minted provider key ONLY — the metadata contract for this
      // model forbids tokens, hashes, IPs and workspace internals, and a key
      // derived through the idempotency authority discloses none of them.
      metadata: { [STORED_IDEMPOTENCY_KEY_FIELD]: deliveryIdempotencyKey },
      initiatedByUserId: input.initiatedByUserId ?? null,
    },
  });

  // Provider call. Wrapped so any throw is captured as a delivery
  // failure rather than propagating to the business workflow.
  let providerResult: Awaited<ReturnType<typeof sendViaResend>>;
  try {
    providerResult = await sendViaResend({
      to: recipientEmail,
      recipientName: input.recipientName ?? null,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      deliveryId: delivery.id,
      idempotencyKey:
        readStoredIdempotencyKey(delivery.metadata) ??
        mintEmailIdempotencyKey(
          NOTIFICATION_IDEMPOTENCY_OPERATION,
          delivery.id,
        ),
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "unknown_error";
    const classification = classifyNotificationProviderError(null, errorMessage);
    const retriable =
      classification === "transient" &&
      delivery.retryCount + 1 < NOTIFICATION_RETRY_MAX_ATTEMPTS;
    const updated = await client.notificationDelivery.update({
      where: { id: delivery.id },
      data: retriable
        ? {
            status: "RETRY_SCHEDULED",
            retryCount: { increment: 1 },
            nextAttemptAtUtc: new Date(
              Date.now() +
                notificationRetryDelaySeconds(delivery.retryCount + 2) * 1000,
            ),
            errorCode: "provider_threw",
            errorMessage: errorMessage.slice(0, 2000),
          }
        : {
            status: "FAILED",
            failedAtUtc: new Date(),
            errorCode: "provider_threw",
            errorMessage: errorMessage.slice(0, 2000),
          },
    });
    // Post-commit emit — only on the terminal FAILED branch. RETRY_SCHEDULED
    // is not terminal and MUST NOT advertise a failure to subscribers.
    if (!retriable) {
      await emitNotificationFailedWebhook(updated, client);
    }
    return {
      delivery: updated,
      status: retriable ? "retry_scheduled" : "failed",
    };
  }

  if (providerResult.ok) {
    const updated = await client.notificationDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "SENT",
        sentAtUtc: new Date(),
        providerMessageId: providerResult.providerMessageId ?? null,
      },
    });
    return { delivery: updated, status: "sent" };
  }

  // Provider returned a typed error.
  const classification = classifyNotificationProviderError(
    providerResult.errorCode,
    providerResult.errorMessage,
  );
  const retriable =
    classification === "transient" &&
    delivery.retryCount + 1 < NOTIFICATION_RETRY_MAX_ATTEMPTS;
  const updated = await client.notificationDelivery.update({
    where: { id: delivery.id },
    data: retriable
      ? {
          status: "RETRY_SCHEDULED",
          retryCount: { increment: 1 },
          nextAttemptAtUtc: new Date(
            Date.now() +
              notificationRetryDelaySeconds(delivery.retryCount + 2) * 1000,
          ),
          errorCode: providerResult.errorCode?.slice(0, 80) ?? null,
          errorMessage: providerResult.errorMessage?.slice(0, 2000) ?? null,
        }
      : {
          status: "FAILED",
          failedAtUtc: new Date(),
          errorCode: providerResult.errorCode?.slice(0, 80) ?? null,
          errorMessage: providerResult.errorMessage?.slice(0, 2000) ?? null,
        },
  });
  if (!retriable) {
    await emitNotificationFailedWebhook(updated, client);
  }
  return {
    delivery: updated,
    status: retriable ? "retry_scheduled" : "failed",
  };
}

// -----------------------------------------------------------------------------
// safeSend — wrapper that NEVER throws.
//
// Business code calls this. Even if the entire notification stack is
// broken (DB unreachable, render throws), the caller's workflow continues
// unaffected; the failure is logged.
// -----------------------------------------------------------------------------

export async function safeSendEmailNotification(
  input: SendEmailNotificationInput,
  client: PrismaClient = defaultPrisma,
): Promise<NotificationSendResult | null> {
  try {
    return await sendEmailNotification(input, client);
  } catch {
    // Last-resort safety. The business flow MUST continue.
    return null;
  }
}

// -----------------------------------------------------------------------------
// dispatchDelivery — internal helper shared by send / retry / resend paths.
//
// Reads the stored templateContextJson, re-renders, calls the provider,
// updates the row. Pure of any business workflow side-effects.
// -----------------------------------------------------------------------------

async function dispatchDelivery(
  delivery: DbNotificationDelivery,
  client: PrismaClient,
): Promise<NotificationSendResult> {
  if (!isNotificationsFeatureEnabled()) {
    const updated = await client.notificationDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "SKIPPED",
        errorCode: "feature_flag_off",
      },
    });
    return { delivery: updated, status: "skipped_feature_disabled" };
  }
  if (!delivery.recipient || delivery.recipient === "(missing)") {
    return { delivery, status: "skipped_no_recipient" };
  }

  // Re-render from the stored context if available; otherwise we cannot
  // safely retry (we don't have the original payload) — mark FAILED so
  // operators see the gap rather than silently giving up.
  const ctx = delivery.templateContextJson;
  if (!ctx || typeof ctx !== "object") {
    const failed = await client.notificationDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "FAILED",
        failedAtUtc: new Date(),
        errorCode: "missing_template_context",
        errorMessage:
          "Cannot retry: stored template context is missing. Re-issue the original notification through the business workflow.",
      },
    });
    await emitNotificationFailedWebhook(failed, client);
    return { delivery: failed, status: "failed" };
  }

  const rendered = renderTransactionalTemplate(
    delivery.eventType as NotificationEventType,
    ctx as unknown as TemplateContext,
  );

  let providerResult: Awaited<ReturnType<typeof sendViaResend>>;
  try {
    providerResult = await sendViaResend({
      to: delivery.recipient,
      recipientName: delivery.recipientName,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      deliveryId: delivery.id,
      idempotencyKey:
        readStoredIdempotencyKey(delivery.metadata) ??
        mintEmailIdempotencyKey(
          NOTIFICATION_IDEMPOTENCY_OPERATION,
          delivery.id,
        ),
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "unknown_error";
    const classification = classifyNotificationProviderError(null, errorMessage);
    const retriable =
      classification === "transient" &&
      delivery.retryCount + 1 < NOTIFICATION_RETRY_MAX_ATTEMPTS;
    const updated = await client.notificationDelivery.update({
      where: { id: delivery.id },
      data: retriable
        ? {
            status: "RETRY_SCHEDULED",
            retryCount: { increment: 1 },
            nextAttemptAtUtc: new Date(
              Date.now() +
                notificationRetryDelaySeconds(delivery.retryCount + 2) * 1000,
            ),
            errorCode: "provider_threw",
            errorMessage: errorMessage.slice(0, 2000),
          }
        : {
            status: "FAILED",
            failedAtUtc: new Date(),
            errorCode: "provider_threw",
            errorMessage: errorMessage.slice(0, 2000),
          },
    });
    if (!retriable) {
      await emitNotificationFailedWebhook(updated, client);
    }
    return {
      delivery: updated,
      status: retriable ? "retry_scheduled" : "failed",
    };
  }

  if (providerResult.ok) {
    const updated = await client.notificationDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "SENT",
        sentAtUtc: new Date(),
        providerMessageId: providerResult.providerMessageId ?? null,
        errorCode: null,
        errorMessage: null,
        nextAttemptAtUtc: null,
      },
    });
    return { delivery: updated, status: "sent" };
  }

  const classification = classifyNotificationProviderError(
    providerResult.errorCode,
    providerResult.errorMessage,
  );
  const retriable =
    classification === "transient" &&
    delivery.retryCount + 1 < NOTIFICATION_RETRY_MAX_ATTEMPTS;
  const updated = await client.notificationDelivery.update({
    where: { id: delivery.id },
    data: retriable
      ? {
          status: "RETRY_SCHEDULED",
          retryCount: { increment: 1 },
          nextAttemptAtUtc: new Date(
            Date.now() +
              notificationRetryDelaySeconds(delivery.retryCount + 2) * 1000,
          ),
          errorCode: providerResult.errorCode?.slice(0, 80) ?? null,
          errorMessage: providerResult.errorMessage?.slice(0, 2000) ?? null,
        }
      : {
          status: "FAILED",
          failedAtUtc: new Date(),
          errorCode: providerResult.errorCode?.slice(0, 80) ?? null,
          errorMessage: providerResult.errorMessage?.slice(0, 2000) ?? null,
        },
  });
  if (!retriable) {
    await emitNotificationFailedWebhook(updated, client);
  }
  return {
    delivery: updated,
    status: retriable ? "retry_scheduled" : "failed",
  };
}

// -----------------------------------------------------------------------------
// resendNotificationDelivery — manual operator action.
//
// Allowed status transitions:
//   FAILED          → re-dispatch
//   RETRY_SCHEDULED → re-dispatch immediately (bypasses nextAttemptAtUtc)
//   SKIPPED         → re-dispatch (e.g., feature was disabled before; now on)
//   SENT/DELIVERED  → blocked unless `force: true`
//
// Always safe — failure does not throw to the caller's workflow.
// -----------------------------------------------------------------------------

export type ResendOutcome =
  | "resent"
  | "skipped_terminal"
  | "blocked_already_sent"
  | "not_found"
  | "failed_to_dispatch";

export async function resendNotificationDelivery(
  input: {
    id: string;
    teamId: string;
    actorUserId: string;
    force?: boolean;
  },
  client: PrismaClient = defaultPrisma,
): Promise<{ delivery: DbNotificationDelivery | null; outcome: ResendOutcome }> {
  const delivery = await client.notificationDelivery.findUnique({
    where: { id: input.id },
  });
  if (!delivery || delivery.teamId !== input.teamId) {
    return { delivery: null, outcome: "not_found" };
  }
  if (delivery.status === "CANCELLED") {
    return { delivery, outcome: "skipped_terminal" };
  }
  if (
    (delivery.status === "SENT" || delivery.status === "DELIVERED") &&
    !input.force
  ) {
    return { delivery, outcome: "blocked_already_sent" };
  }

  // Reset the row to PENDING before dispatch so the lifecycle remains
  // observable to a concurrent reader.
  const refreshed = await client.notificationDelivery.update({
    where: { id: delivery.id },
    data: {
      status: "PENDING",
      errorCode: null,
      errorMessage: null,
      nextAttemptAtUtc: null,
      initiatedByUserId: input.actorUserId,
    },
  });

  try {
    const result = await dispatchDelivery(refreshed, client);
    return {
      delivery: result.delivery,
      outcome: result.status === "sent" ? "resent" : "failed_to_dispatch",
    };
  } catch {
    return { delivery: refreshed, outcome: "failed_to_dispatch" };
  }
}

// -----------------------------------------------------------------------------
// processDueNotificationRetries — sweeper.
//
// Picks N rows where status = RETRY_SCHEDULED, nextAttemptAtUtc <= now,
// retryCount < max attempts, channel = EMAIL. Re-dispatches each.
//
// Idempotency: each row is flipped to PENDING with a single conditional
// UPDATE before dispatch so two concurrent sweepers can't both pick the
// same row.
// -----------------------------------------------------------------------------

export type ProcessRetriesSummary = {
  pickedUp: number;
  resent: number;
  rescheduled: number;
  failed: number;
};

export async function processDueNotificationRetries(
  input: { batchSize?: number } = {},
  client: PrismaClient = defaultPrisma,
): Promise<ProcessRetriesSummary> {
  const batchSize = Math.min(Math.max(input.batchSize ?? 50, 1), 500);
  const summary: ProcessRetriesSummary = {
    pickedUp: 0,
    resent: 0,
    rescheduled: 0,
    failed: 0,
  };
  if (!isNotificationsFeatureEnabled()) return summary;

  const now = new Date();
  const candidates = await client.notificationDelivery.findMany({
    where: {
      status: "RETRY_SCHEDULED",
      channel: "EMAIL",
      provider: "RESEND",
      retryCount: { lt: NOTIFICATION_RETRY_MAX_ATTEMPTS },
      nextAttemptAtUtc: { lte: now },
    },
    orderBy: { nextAttemptAtUtc: "asc" },
    take: batchSize,
  });

  for (const row of candidates) {
    // Atomic claim: only proceed if the row is still RETRY_SCHEDULED. If a
    // concurrent sweeper picked it up first, updateMany returns count 0
    // and we skip it.
    const claim = await client.notificationDelivery.updateMany({
      where: { id: row.id, status: "RETRY_SCHEDULED" },
      data: { status: "PENDING" },
    });
    if (claim.count !== 1) continue;
    summary.pickedUp += 1;

    const refreshed = await client.notificationDelivery.findUnique({
      where: { id: row.id },
    });
    if (!refreshed) continue;
    try {
      const result = await dispatchDelivery(refreshed, client);
      if (result.status === "sent") summary.resent += 1;
      else if (result.status === "retry_scheduled") summary.rescheduled += 1;
      else summary.failed += 1;
    } catch {
      summary.failed += 1;
    }
  }

  return summary;
}

// -----------------------------------------------------------------------------
// listNotificationDeliveries — admin helper. The route layer applies the
// safe projection.
// -----------------------------------------------------------------------------

export async function listNotificationDeliveries(
  input: {
    teamId: string;
    evidenceRequestId?: string;
    status?: string;
    eventType?: string;
    recipient?: string;
    channel?: string;
    provider?: string;
    createdAfter?: Date;
    createdBefore?: Date;
    limit?: number;
  },
  client: PrismaClient = defaultPrisma,
): Promise<DbNotificationDelivery[]> {
  const dateFilter: Prisma.DateTimeFilter = {};
  if (input.createdAfter) dateFilter.gte = input.createdAfter;
  if (input.createdBefore) dateFilter.lte = input.createdBefore;
  const hasDate =
    Object.keys(dateFilter).length > 0
      ? { createdAt: dateFilter as Prisma.DateTimeFilter }
      : {};

  return client.notificationDelivery.findMany({
    where: {
      teamId: input.teamId,
      ...(input.evidenceRequestId
        ? { evidenceRequestId: input.evidenceRequestId }
        : {}),
      ...(input.status
        ? { status: input.status as Prisma.NotificationDeliveryWhereInput["status"] }
        : {}),
      ...(input.eventType ? { eventType: input.eventType } : {}),
      ...(input.recipient ? { recipient: input.recipient } : {}),
      ...(input.channel
        ? { channel: input.channel as Prisma.NotificationDeliveryWhereInput["channel"] }
        : {}),
      ...(input.provider
        ? { provider: input.provider as Prisma.NotificationDeliveryWhereInput["provider"] }
        : {}),
      ...hasDate,
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(input.limit ?? 50, 1), 200),
  });
}

export async function getNotificationDelivery(
  id: string,
  teamId: string,
  client: PrismaClient = defaultPrisma,
): Promise<DbNotificationDelivery | null> {
  const row = await client.notificationDelivery.findUnique({
    where: { id },
  });
  if (!row || row.teamId !== teamId) return null;
  return row;
}

// -----------------------------------------------------------------------------
// Safe public projection — used by the route handlers. The renderedPreview
// is plaintext-only (bounded), templateContextJson is NEVER returned, and
// recipient is partially masked when it contains an email.
// -----------------------------------------------------------------------------

/**
 * THE OUTBOUND DELIVERY LOG'S PROJECTION.
 *
 * `recipient` here is the address a message was actually sent to. For a
 * delivery carrying an `intakeLinkId` that is the External Intake recipient —
 * the same data class the recipient-contact policy governs everywhere else —
 * so this surface has to obey the same rule.
 *
 * It used to be raw by DEFAULT, masked only if the client passed
 * `?maskRecipient=true`, and SMS/WhatsApp were never masked at all because
 * the branch tested `channel === "EMAIL"`. A disclosure the caller opts out
 * of is not a policy. The decision now arrives from the server-side authority
 * and the client cannot influence it.
 */
export function projectNotificationDelivery(
  delivery: DbNotificationDelivery,
  opts: { disclosure?: RecipientContactDisclosure } = {},
): {
  id: string;
  eventType: string;
  channel: string;
  provider: string;
  recipient: string;
  recipientName: string | null;
  status: string;
  subject: string | null;
  templateKey: string;
  renderedPreview: string | null;
  providerMessageId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryCount: number;
  nextAttemptAtUtc: string | null;
  sentAtUtc: string | null;
  deliveredAtUtc: string | null;
  failedAtUtc: string | null;
  evidenceRequestId: string | null;
  evidenceId: string | null;
  intakeLinkId: string | null;
  initiatedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
} {
  /*
   * Masked unless the caller was resolved as REVEALED, and masked for every
   * channel rather than only for email — a phone number is not less personal
   * than an address. MASKED is the default so a caller that forgets to pass a
   * decision discloses less, not more.
   */
  const disclosure = opts.disclosure ?? "MASKED";
  const recipient =
    disclosure === "REVEALED"
      ? delivery.recipient
      : delivery.channel === "EMAIL"
        ? (maskEmail(delivery.recipient) ?? "")
        : maskPhonePreview(delivery.recipient);
  return {
    id: delivery.id,
    eventType: delivery.eventType,
    channel: delivery.channel,
    provider: delivery.provider,
    recipient,
    recipientName: delivery.recipientName,
    status: delivery.status,
    subject: delivery.subject,
    templateKey: delivery.templateKey,
    // renderedPreview is plaintext (per Phase 8 schema). It is bounded
    // 2000 chars and the renderer never includes reviewer notes, token
    // hashes, or IP/UA — only safe message body fragments.
    renderedPreview: delivery.renderedPreview,
    providerMessageId: delivery.providerMessageId,
    errorCode: delivery.errorCode,
    errorMessage: delivery.errorMessage,
    retryCount: delivery.retryCount,
    nextAttemptAtUtc: delivery.nextAttemptAtUtc?.toISOString() ?? null,
    sentAtUtc: delivery.sentAtUtc?.toISOString() ?? null,
    deliveredAtUtc: delivery.deliveredAtUtc?.toISOString() ?? null,
    failedAtUtc: delivery.failedAtUtc?.toISOString() ?? null,
    evidenceRequestId: delivery.evidenceRequestId,
    evidenceId: delivery.evidenceId,
    intakeLinkId: delivery.intakeLinkId,
    initiatedByUserId: delivery.initiatedByUserId,
    createdAt: delivery.createdAt.toISOString(),
    updatedAt: delivery.updatedAt.toISOString(),
    // Intentionally NOT returned:
    //   - metadata (may contain operator-only context)
    //   - templateContextJson (renderer payload; never exposed)
  };
}
