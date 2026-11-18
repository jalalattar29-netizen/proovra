/**
 * Phase 18 — Communication service.
 *
 * The single mutation surface for outbound + inbound communication
 * messages. Every business caller goes through `enqueueOutboundMessage`
 * (or one of its wrappers); no route handler talks to a provider
 * directly.
 *
 * Responsibilities:
 *   1. Feature-flag gate via the provider registry. If the active
 *      provider is NOOP (feature disabled OR Twilio unconfigured), the
 *      send is recorded as a CANCELLED row and `safeEmitSecurityEvent`
 *      fires `communication_provider_unconfigured` so operators see
 *      that the request never reached a provider.
 *   2. Phone normalisation + recipient hash + masked preview. The raw
 *      destination is NEVER stored on the message row.
 *   3. Opt-out check. CRITICAL purposes (OTP / SECURITY_ALERT) bypass
 *      opt-out where the brief allows; everything else is blocked.
 *   4. Per-recipient + per-team rate limit. Defaults from env. On
 *      exceeded → CANCELLED row + `communication_rate_limit_exceeded`.
 *   5. Persist the CommunicationMessage row in QUEUED state, dispatch
 *      through the provider abstraction, then update to SENT or
 *      FAILED/RETRY_SCHEDULED based on the result + retry eligibility.
 *   6. Never throw to the business caller — workflow lifecycle is
 *      decoupled from message delivery.
 *
 * The retry processor (process-retries route) reuses
 * `dispatchPendingMessage` so the dispatch path is exactly one
 * function.
 */

import { createHmac } from "node:crypto";

import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import {
  type CommunicationChannel,
  type CommunicationPurpose,
  type CommunicationStatus,
  classifyCommunicationProviderError,
  communicationRetryDelaySeconds,
  isCriticalCommunicationPurpose,
  isPhoneChannel,
  isRetryEligibleCommunicationPurpose,
  maskPhonePreview,
  normaliseToE164,
  COMMUNICATION_RETRY_MAX_ATTEMPTS,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { resolveSecret } from "../../config/index.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";

import type {
  MessagingProvider,
  ProviderSendInput,
  ProviderSendResult,
} from "./provider.js";
import { getMessagingProvider } from "./provider-registry.js";

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

const DEFAULT_PER_RECIPIENT_PER_DAY = 10;
const DEFAULT_PER_TEAM_PER_DAY = 500;
const DEFAULT_RETRY_BASE_SECONDS = 60;

function readRateLimits(): {
  perRecipientPerDay: number;
  perTeamPerDay: number;
  retryBaseSeconds: number;
} {
  const perRecipient = numberFromEnv(
    process.env.COMMUNICATIONS_MAX_SENDS_PER_RECIPIENT_PER_DAY,
    DEFAULT_PER_RECIPIENT_PER_DAY,
    1,
    10_000,
  );
  const perTeam = numberFromEnv(
    process.env.COMMUNICATIONS_MAX_SENDS_PER_TEAM_PER_DAY,
    DEFAULT_PER_TEAM_PER_DAY,
    1,
    1_000_000,
  );
  const retryBase = numberFromEnv(
    process.env.COMMUNICATIONS_RETRY_BASE_SECONDS,
    DEFAULT_RETRY_BASE_SECONDS,
    10,
    24 * 3600,
  );
  return {
    perRecipientPerDay: perRecipient,
    perTeamPerDay: perTeam,
    retryBaseSeconds: retryBase,
  };
}

function numberFromEnv(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(n, max);
}

// -----------------------------------------------------------------------------
// Recipient hashing
//
// HMAC-SHA256 keyed by a per-deployment secret. We DELIBERATELY do not
// fail closed on an unset secret in development — instead we fall back
// to a static, non-secret prefix so dev environments can still operate.
// In production deployments this should always be set.
// -----------------------------------------------------------------------------

const RECIPIENT_HASH_SECRET_ENV = "COMMUNICATIONS_RECIPIENT_HASH_SECRET";

export function hashRecipientPhone(phoneE164: string): string {
  // Phase 20 — `resolveSecret` throws in production when the env var is
  // missing, so we can never silently fall back to a non-prod fallback
  // key in a prod deployment. In non-prod it returns a deterministic
  // namespaced fallback so local dev continues to work.
  const secret = resolveSecret(RECIPIENT_HASH_SECRET_ENV);
  return createHmac("sha256", secret)
    .update(phoneE164.toLowerCase(), "utf8")
    .digest("hex");
}

// -----------------------------------------------------------------------------
// Inputs / results
// -----------------------------------------------------------------------------

export type EnqueueOutboundMessageInput = {
  teamId: string;
  channel: Extract<CommunicationChannel, "SMS" | "WHATSAPP">;
  purpose: CommunicationPurpose;
  recipientPhone: string;
  body: string;
  sender?: string | null;
  related?: {
    evidenceId?: string | null;
    evidenceRequestId?: string | null;
    discussionThreadId?: string | null;
    intakeSessionId?: string | null;
    intakeLinkId?: string | null;
  };
  createdByUserId?: string | null;
  /** Reserved for future per-call retry-policy override. */
  forceCritical?: boolean;
  /**
   * Caller-supplied sanitized preview for CommunicationMessage.bodyPreview.
   * When set, replaces the default `safeBodyPreview(input.body)`. Used by
   * the intake-link channel so the raw token never lands in the DB
   * preview — the body still contains the full URL (the provider must
   * see it), but the persisted preview is redacted via
   * sanitizeIntakeMessagePreview from @proovra/shared.
   */
  bodyPreviewOverride?: string | null;
  /**
   * Optional Twilio Content Template payload. Only consumed for the
   * WHATSAPP channel; SMS sends ignore it and use `body`. When
   * present, the provider sends ContentSid + ContentVariables
   * instead of `Body`, satisfying Meta's "approved template
   * required" rule for business-initiated WhatsApp messages
   * outside the 24h customer window.
   */
  template?: {
    contentSid: string;
    variables: Record<string, string>;
    language?: string;
  };
};

export type EnqueueOutboundMessageResult = {
  message: prismaPkg.CommunicationMessage;
  status:
    | "sent"
    | "queued"
    | "failed"
    | "retry_scheduled"
    | "cancelled_feature_disabled"
    | "cancelled_invalid_phone"
    | "cancelled_opted_out"
    | "cancelled_rate_limited";
};

// -----------------------------------------------------------------------------
// Enqueue + dispatch (single attempt)
// -----------------------------------------------------------------------------

export async function enqueueOutboundMessage(
  input: EnqueueOutboundMessageInput,
  client: PrismaClient = defaultPrisma,
): Promise<EnqueueOutboundMessageResult> {
  const provider = getMessagingProvider();
  const phone = normaliseToE164(input.recipientPhone);
  if (!phone) {
    const cancelled = await client.communicationMessage.create({
      data: {
        teamId: input.teamId,
        channel: input.channel,
        direction: prismaPkg.CommunicationDirection.OUTBOUND,
        purpose: input.purpose as prismaPkg.CommunicationPurpose,
        provider: prismaPkg.CommunicationProvider.NOOP,
        recipientHash: "invalid",
        recipientPreview: maskPhonePreview(input.recipientPhone) || "(invalid)",
        status: prismaPkg.CommunicationStatus.CANCELLED,
        errorCode: "invalid_phone",
        errorMessage: "Recipient phone could not be normalised to E.164.",
        bodyPreview:
          input.bodyPreviewOverride ?? safeBodyPreview(input.body),
        sender: input.sender ?? null,
        relatedEvidenceId: input.related?.evidenceId ?? null,
        relatedEvidenceRequestId: input.related?.evidenceRequestId ?? null,
        relatedDiscussionThreadId: input.related?.discussionThreadId ?? null,
        relatedIntakeSessionId: input.related?.intakeSessionId ?? null,
        relatedIntakeLinkId: input.related?.intakeLinkId ?? null,
        createdByUserId: input.createdByUserId ?? null,
      },
    });
    return { message: cancelled, status: "cancelled_invalid_phone" };
  }

  const recipientHash = hashRecipientPhone(phone);
  const preview = maskPhonePreview(phone);

  // Provider not configured / feature disabled — cancel and audit.
  if (!provider.isConfigured()) {
    const cancelled = await client.communicationMessage.create({
      data: {
        teamId: input.teamId,
        channel: input.channel,
        direction: prismaPkg.CommunicationDirection.OUTBOUND,
        purpose: input.purpose as prismaPkg.CommunicationPurpose,
        provider: prismaPkg.CommunicationProvider.NOOP,
        recipientHash,
        recipientPreview: preview,
        status: prismaPkg.CommunicationStatus.CANCELLED,
        errorCode: "provider_unconfigured",
        errorMessage:
          provider.unconfiguredReason() ?? "Provider not configured.",
        bodyPreview:
          input.bodyPreviewOverride ?? safeBodyPreview(input.body),
        sender: input.sender ?? null,
        relatedEvidenceId: input.related?.evidenceId ?? null,
        relatedEvidenceRequestId: input.related?.evidenceRequestId ?? null,
        relatedDiscussionThreadId: input.related?.discussionThreadId ?? null,
        relatedIntakeSessionId: input.related?.intakeSessionId ?? null,
        relatedIntakeLinkId: input.related?.intakeLinkId ?? null,
        createdByUserId: input.createdByUserId ?? null,
      },
    });
    safeEmitSecurityEvent(
      {
        teamId: input.teamId,
        eventType: "communication_provider_unconfigured",
        severity: "WARNING",
        details: {
          purpose: input.purpose,
          channel: input.channel,
          reason: provider.unconfiguredReason() ?? null,
        },
      },
      client,
    );
    return { message: cancelled, status: "cancelled_feature_disabled" };
  }

  // Opt-out check.
  if (
    !input.forceCritical &&
    !isCriticalCommunicationPurpose(input.purpose) &&
    (await isRecipientOptedOut(
      { teamId: input.teamId, recipientHash, channel: input.channel },
      client,
    ))
  ) {
    const cancelled = await client.communicationMessage.create({
      data: {
        teamId: input.teamId,
        channel: input.channel,
        direction: prismaPkg.CommunicationDirection.OUTBOUND,
        purpose: input.purpose as prismaPkg.CommunicationPurpose,
        provider: prismaPkg.CommunicationProvider.NOOP,
        recipientHash,
        recipientPreview: preview,
        status: prismaPkg.CommunicationStatus.CANCELLED,
        errorCode: "recipient_opted_out",
        errorMessage: "Recipient has opted out of this channel.",
        bodyPreview:
          input.bodyPreviewOverride ?? safeBodyPreview(input.body),
        sender: input.sender ?? null,
        relatedEvidenceId: input.related?.evidenceId ?? null,
        relatedEvidenceRequestId: input.related?.evidenceRequestId ?? null,
        relatedDiscussionThreadId: input.related?.discussionThreadId ?? null,
        relatedIntakeSessionId: input.related?.intakeSessionId ?? null,
        relatedIntakeLinkId: input.related?.intakeLinkId ?? null,
        createdByUserId: input.createdByUserId ?? null,
      },
    });
    safeEmitSecurityEvent(
      {
        teamId: input.teamId,
        eventType: "communication_recipient_opted_out",
        severity: "INFO",
        details: {
          purpose: input.purpose,
          channel: input.channel,
          recipientHash,
        },
      },
      client,
    );
    return { message: cancelled, status: "cancelled_opted_out" };
  }

  // Rate limit.
  const limits = readRateLimits();
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const [recipientCount, teamCount] = await Promise.all([
    client.communicationMessage.count({
      where: {
        teamId: input.teamId,
        recipientHash,
        direction: prismaPkg.CommunicationDirection.OUTBOUND,
        createdAt: { gte: since },
      },
    }),
    client.communicationMessage.count({
      where: {
        teamId: input.teamId,
        direction: prismaPkg.CommunicationDirection.OUTBOUND,
        createdAt: { gte: since },
      },
    }),
  ]);
  if (
    recipientCount >= limits.perRecipientPerDay ||
    teamCount >= limits.perTeamPerDay
  ) {
    const cancelled = await client.communicationMessage.create({
      data: {
        teamId: input.teamId,
        channel: input.channel,
        direction: prismaPkg.CommunicationDirection.OUTBOUND,
        purpose: input.purpose as prismaPkg.CommunicationPurpose,
        provider: prismaPkg.CommunicationProvider.NOOP,
        recipientHash,
        recipientPreview: preview,
        status: prismaPkg.CommunicationStatus.CANCELLED,
        errorCode: "rate_limited",
        errorMessage:
          recipientCount >= limits.perRecipientPerDay
            ? "Per-recipient daily limit reached."
            : "Per-team daily limit reached.",
        bodyPreview:
          input.bodyPreviewOverride ?? safeBodyPreview(input.body),
        sender: input.sender ?? null,
        relatedEvidenceId: input.related?.evidenceId ?? null,
        relatedEvidenceRequestId: input.related?.evidenceRequestId ?? null,
        relatedDiscussionThreadId: input.related?.discussionThreadId ?? null,
        relatedIntakeSessionId: input.related?.intakeSessionId ?? null,
        relatedIntakeLinkId: input.related?.intakeLinkId ?? null,
        createdByUserId: input.createdByUserId ?? null,
      },
    });
    safeEmitSecurityEvent(
      {
        teamId: input.teamId,
        eventType: "communication_rate_limit_exceeded",
        severity: "WARNING",
        details: {
          purpose: input.purpose,
          channel: input.channel,
          recipientHash,
          scope:
            recipientCount >= limits.perRecipientPerDay ? "recipient" : "team",
        },
      },
      client,
    );
    return { message: cancelled, status: "cancelled_rate_limited" };
  }

  // Persist QUEUED, then dispatch.
  //
  // Intake-links P0 bugfix — the QUEUED-row write previously ignored
  // the `bodyPreviewOverride` parameter and called `safeBodyPreview`
  // directly. That meant the sanitizer wired in Phase A only applied
  // to the cancelled-fallback rows; every successful SMS / WhatsApp
  // send (which goes through this branch) was writing the raw intake
  // URL (including the secret token) to `body_preview`. The fix is
  // the same `??` precedence used at the cancelled-row sites above.
  const queued = await client.communicationMessage.create({
    data: {
      teamId: input.teamId,
      channel: input.channel,
      direction: prismaPkg.CommunicationDirection.OUTBOUND,
      purpose: input.purpose as prismaPkg.CommunicationPurpose,
      provider: prismaPkg.CommunicationProvider.TWILIO,
      recipientHash,
      recipientPreview: preview,
      status: prismaPkg.CommunicationStatus.QUEUED,
      bodyPreview:
        input.bodyPreviewOverride ?? safeBodyPreview(input.body),
      bodyResendable: isBodyResendable(input),
      sender: input.sender ?? null,
      relatedEvidenceId: input.related?.evidenceId ?? null,
      relatedEvidenceRequestId: input.related?.evidenceRequestId ?? null,
      relatedDiscussionThreadId: input.related?.discussionThreadId ?? null,
      relatedIntakeSessionId: input.related?.intakeSessionId ?? null,
      relatedIntakeLinkId: input.related?.intakeLinkId ?? null,
      createdByUserId: input.createdByUserId ?? null,
      attemptCount: 1,
    },
  });

  const sendInput: ProviderSendInput = {
    toE164: phone,
    body: input.body,
    externalId: queued.id,
    // Intake-links P0 bugfix — opt every Twilio send into the
    // /v1/communications/webhooks/twilio/status webhook so the row
    // moves out of QUEUED/SENT into DELIVERED / FAILED / UNDELIVERED
    // when the carrier (or the WhatsApp sandbox) confirms outcome.
    // Without this, every WhatsApp message that failed delivery
    // (e.g. recipient not joined to sandbox, template not approved,
    // number not WA-enabled) read "SENT" forever in the UI. The
    // webhook handler at communications.routes.ts is already wired;
    // it just never knew Twilio existed because we never told
    // Twilio our callback URL. Operators set the public callback URL via
    // TWILIO_STATUS_CALLBACK_URL (typically
    // https://api.proovra.com/v1/communications/webhooks/twilio/status).
    statusCallbackUrl: resolveTwilioStatusCallbackUrl(),
    // WhatsApp template path (Meta-required for business-initiated
    // messages outside the 24h customer window). When the caller
    // hands us a template, the provider drops `Body` and sends via
    // ContentSid + ContentVariables. SMS sends ignore this field.
    template: input.template,
  };

  const result =
    input.channel === "WHATSAPP"
      ? await provider.sendWhatsApp(sendInput)
      : await provider.sendSms(sendInput);

  return updateAfterProviderAttempt(queued, result, provider, client);
}

function resolveTwilioStatusCallbackUrl(): string | undefined {
  const url = (process.env.TWILIO_STATUS_CALLBACK_URL ?? "").trim();
  return url.length > 0 ? url : undefined;
}

// -----------------------------------------------------------------------------
// Retry processor — single message dispatch
// -----------------------------------------------------------------------------

export async function dispatchPendingMessage(
  messageId: string,
  client: PrismaClient = defaultPrisma,
): Promise<EnqueueOutboundMessageResult | { status: "not_eligible"; message: prismaPkg.CommunicationMessage }> {
  const provider = getMessagingProvider();
  const row = await client.communicationMessage.findUnique({
    where: { id: messageId },
  });
  if (!row) throw new Error("communication_message_not_found");
  const purpose = row.purpose as CommunicationPurpose;
  if (
    row.status !== prismaPkg.CommunicationStatus.RETRY_SCHEDULED &&
    row.status !== prismaPkg.CommunicationStatus.QUEUED
  ) {
    return { status: "not_eligible", message: row };
  }
  // WS-SCHED / PRO-W2C2-05, PRO-I1Z-04 — a row the sweep cannot send is
  // SETTLED or pushed back, never left due: unchanged not_eligible rows were
  // re-selected every minute and could fill the take-100 window for every
  // tenant. A non-phone channel can never be retried here; an unconfigured
  // provider is a platform condition, retried on a backoff.
  if (!isPhoneChannel(row.channel as CommunicationChannel)) {
    return closeRetry(row, prismaPkg.CommunicationStatus.FAILED, "channel_not_retryable",
      "This channel is not retried by the messaging sweep.", client);
  }
  if (!provider.isConfigured()) {
    await client.communicationMessage.updateMany({
      where: { id: row.id, status: row.status, attemptCount: row.attemptCount },
      data: { nextAttemptAtUtc: new Date(Date.now() + PROVIDER_UNCONFIGURED_BACKOFF_MS) },
    });
    return { status: "not_eligible", message: row };
  }
  // Re-derive phone? We do NOT store it. Retrying requires the original
  // dispatch path to have set `recipientPreview` only — we cannot reach
  // the provider without the raw phone, so for Phase 18 retries are
  // gated on `relatedIntakeLinkId` / `relatedEvidenceRequestId` to
  // re-derive the phone from the source record. Generic retries
  // without a source are marked as not-eligible.
  // WORKFLOW-009 — what was sent is not stored unless the preview is the whole
  // message. A token-bearing link, a template or a cut-off text cannot be sent
  // again, and sending the preview would reach the recipient as a false success.
  // The row says so, and the operator issues a new one.
  if (!row.bodyResendable || !row.bodyPreview) {
    return closeRetry(row, prismaPkg.CommunicationStatus.FAILED, "retry_requires_reissue",
      "This message cannot be sent again as it was. Issue it again from its source.", client);
  }
  const phone = await resolvePhoneFromSource(row, client);
  if (!phone) {
    // The request was closed / cancelled / fulfilled, or the link / session was
    // revoked or expired (workspace closure revokes every link): its source is
    // gone, so the retry ends here, with the reason.
    return closeRetry(row, prismaPkg.CommunicationStatus.CANCELLED, "source_closed",
      "The request or link this message belonged to is no longer open.", client);
  }
  // A recipient can reply STOP after the first attempt, and the limits apply to
  // a retry as they do to a first send.
  const recipientHash = hashRecipientPhone(phone);
  if (
    !isCriticalCommunicationPurpose(purpose) &&
    (await isRecipientOptedOut(
      { teamId: row.teamId, recipientHash, channel: row.channel as CommunicationChannel },
      client,
    ))
  ) {
    return closeRetry(row, prismaPkg.CommunicationStatus.CANCELLED, "recipient_opted_out",
      "Recipient has opted out of this channel.", client);
  }
  if (await retryExceedsRateLimit(row, recipientHash, client)) {
    return closeRetry(row, prismaPkg.CommunicationStatus.CANCELLED, "rate_limited",
      "Daily message limit reached.", client);
  }
  // The claim. Two sweeps reading one due row send once: a host crontab may run
  // beside the worker's timer.
  const claimed = await client.communicationMessage.updateMany({
    where: { id: row.id, status: row.status, attemptCount: row.attemptCount },
    data: {
      attemptCount: row.attemptCount + 1,
      status: prismaPkg.CommunicationStatus.QUEUED,
      nextAttemptAtUtc: null,
    },
  });
  if (claimed.count !== 1) {
    return { status: "not_eligible", message: row };
  }
  const updated = await client.communicationMessage.findUniqueOrThrow({ where: { id: row.id } });
  const sendInput: ProviderSendInput = {
    toE164: phone,
    body: row.bodyPreview,
    externalId: row.id,
    statusCallbackUrl: resolveTwilioStatusCallbackUrl(),
  };
  const result =
    row.channel === "WHATSAPP"
      ? await provider.sendWhatsApp(sendInput)
      : await provider.sendSms(sendInput);
  return updateAfterProviderAttempt(updated, result, provider, client);
}

/** The preview is the message only when nothing replaced or shortened it. */
function isBodyResendable(input: EnqueueOutboundMessageInput): boolean {
  if (input.bodyPreviewOverride != null || input.template) return false;
  const preview = safeBodyPreview(input.body);
  return preview !== null && preview === input.body;
}

/** PRO-W2C2-05 — an unconfigured provider is retried on this backoff, not every minute. */
export const PROVIDER_UNCONFIGURED_BACKOFF_MS = 15 * 60 * 1000;

/**
 * WS-SCHED / PRO-W2-06 — THE LEASE on a QUEUED message. A row is QUEUED (with
 * no provider id) only while one process is sending it: the first send, or a
 * retry this sweep claimed. A process that dies before the provider answer is
 * written leaves it QUEUED. Platform maintenance used to CANCEL such rows after
 * five minutes (`stuck_queued_reconciled`), so the message was lost instead of
 * retried — and, because it read `createdAt`, it could cancel a retry claimed a
 * moment earlier. Now a QUEUED row untouched (`updatedAt`) for longer than the
 * lease returns to RETRY_SCHEDULED when its purpose and body allow a retry and
 * it has attempts left, and is otherwise settled FAILED `stranded`. Each move is
 * conditional on the row as read, so a live send is never touched and two
 * reconciles settle a row once.
 */
export const COMMUNICATION_QUEUED_LEASE_MS = 5 * 60 * 1000;

export async function reclaimStrandedCommunicationMessages(
  client: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<{ retried: number; failed: number }> {
  const cutoff = new Date(now.getTime() - COMMUNICATION_QUEUED_LEASE_MS);
  const stranded = await client.communicationMessage.findMany({
    where: {
      status: prismaPkg.CommunicationStatus.QUEUED,
      direction: prismaPkg.CommunicationDirection.OUTBOUND,
      providerMessageId: null,
      updatedAt: { lte: cutoff },
    },
    orderBy: { updatedAt: "asc" },
    take: 100,
  });
  let retried = 0;
  let failed = 0;
  for (const row of stranded) {
    const retryable =
      row.bodyResendable &&
      isRetryEligibleCommunicationPurpose(row.purpose as CommunicationPurpose) &&
      row.attemptCount < COMMUNICATION_RETRY_MAX_ATTEMPTS;
    const moved = await client.communicationMessage.updateMany({
      where: { id: row.id, status: row.status, attemptCount: row.attemptCount, updatedAt: { lte: cutoff } },
      data: retryable
        ? {
            status: prismaPkg.CommunicationStatus.RETRY_SCHEDULED,
            nextAttemptAtUtc: now,
            errorCode: "stranded",
            errorMessage: "The sending process stopped before the provider answered; retried.",
          }
        : {
            status: prismaPkg.CommunicationStatus.FAILED,
            failedAtUtc: now,
            nextAttemptAtUtc: null,
            errorCode: "stranded",
            errorMessage: "The sending process stopped before the provider answered.",
          },
    });
    if (moved.count === 1) {
      if (retryable) retried += 1;
      else failed += 1;
    }
  }
  return { retried, failed };
}

async function closeRetry(
  row: prismaPkg.CommunicationMessage,
  status: "FAILED" | "CANCELLED",
  errorCode: string,
  errorMessage: string,
  client: PrismaClient,
): Promise<EnqueueOutboundMessageResult | { status: "not_eligible"; message: prismaPkg.CommunicationMessage }> {
  const closed = await client.communicationMessage.updateMany({
    where: { id: row.id, status: row.status, attemptCount: row.attemptCount },
    data: {
      status,
      errorCode,
      errorMessage,
      nextAttemptAtUtc: null,
      ...(status === "FAILED" ? { failedAtUtc: new Date() } : {}),
    },
  });
  if (closed.count !== 1) return { status: "not_eligible", message: row };
  const message = await client.communicationMessage.findUniqueOrThrow({ where: { id: row.id } });
  if (errorCode === "recipient_opted_out") return { status: "cancelled_opted_out", message };
  if (errorCode === "rate_limited") return { status: "cancelled_rate_limited", message };
  return { status: "failed", message };
}

async function retryExceedsRateLimit(
  row: prismaPkg.CommunicationMessage,
  recipientHash: string,
  client: PrismaClient,
): Promise<boolean> {
  const limits = readRateLimits();
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const others = {
    teamId: row.teamId,
    direction: prismaPkg.CommunicationDirection.OUTBOUND,
    createdAt: { gte: since },
    id: { not: row.id },
  };
  const [recipientCount, teamCount] = await Promise.all([
    client.communicationMessage.count({ where: { ...others, recipientHash } }),
    client.communicationMessage.count({ where: others }),
  ]);
  return recipientCount >= limits.perRecipientPerDay || teamCount >= limits.perTeamPerDay;
}

/** A callback may arrive late. Status moves forward only (WORKFLOW-016). */
const COMMUNICATION_STATUS_MAY_FOLLOW: Readonly<Record<string, ReadonlyArray<prismaPkg.CommunicationStatus>>> = {
  SENT: [prismaPkg.CommunicationStatus.QUEUED],
  FAILED: [prismaPkg.CommunicationStatus.QUEUED, prismaPkg.CommunicationStatus.SENT],
  UNDELIVERED: [prismaPkg.CommunicationStatus.QUEUED, prismaPkg.CommunicationStatus.SENT],
  // A retry is scheduled from a failure report. A later DELIVERED for the same
  // message says it arrived after all, and a resend would deliver it twice.
  DELIVERED: [
    prismaPkg.CommunicationStatus.QUEUED,
    prismaPkg.CommunicationStatus.SENT,
    prismaPkg.CommunicationStatus.FAILED,
    prismaPkg.CommunicationStatus.UNDELIVERED,
    prismaPkg.CommunicationStatus.RETRY_SCHEDULED,
  ],
};

/** The statuses a delivery callback reporting `status` may replace. */
export function communicationStatusesBefore(status: string): ReadonlyArray<prismaPkg.CommunicationStatus> {
  return COMMUNICATION_STATUS_MAY_FOLLOW[status] ?? [];
}

const CLOSED_EVIDENCE_REQUEST_STATUSES: ReadonlySet<string> = new Set(["CANCELLED", "CLOSED", "FULFILLED"]);

async function resolvePhoneFromSource(
  row: prismaPkg.CommunicationMessage,
  client: PrismaClient,
): Promise<string | null> {
  if (row.relatedEvidenceRequestId) {
    const req = await client.evidenceRequest.findUnique({
      where: { id: row.relatedEvidenceRequestId },
      select: { recipientPhone: true, status: true },
    });
    if (req && CLOSED_EVIDENCE_REQUEST_STATUSES.has(String(req.status))) return null;
    return normaliseToE164(req?.recipientPhone ?? null);
  }
  if (row.relatedIntakeLinkId) {
    const link = await client.workflowIntakeLink.findUnique({
      where: { id: row.relatedIntakeLinkId },
      select: { recipientPhone: true, revokedAtUtc: true, expiresAtUtc: true },
    });
    if (!link) return null;
    // Phase 18 brief: revoked or expired link must not be resent.
    if (link.revokedAtUtc) return null;
    if (link.expiresAtUtc && link.expiresAtUtc.getTime() <= Date.now()) return null;
    return normaliseToE164(link.recipientPhone ?? null);
  }
  if (row.relatedIntakeSessionId) {
    const session = await client.workflowIntakeSession.findUnique({
      where: { id: row.relatedIntakeSessionId },
      select: { submitterPhone: true, revokedAtUtc: true, expiresAtUtc: true },
    });
    if (!session) return null;
    if (session.revokedAtUtc) return null;
    if (session.expiresAtUtc.getTime() <= Date.now()) return null;
    return normaliseToE164(session.submitterPhone ?? null);
  }
  return null;
}

// -----------------------------------------------------------------------------
// Provider result -> row update
// -----------------------------------------------------------------------------

async function updateAfterProviderAttempt(
  row: prismaPkg.CommunicationMessage,
  result: ProviderSendResult,
  _provider: MessagingProvider,
  client: PrismaClient,
): Promise<EnqueueOutboundMessageResult> {
  // PRO-W2-06 — every write here is FENCED on the attempt this process made:
  // a row reclaimed, cancelled or settled meanwhile is not overwritten. A
  // provider SUCCESS still wins over a reclaim of the same attempt (the row
  // went back to RETRY_SCHEDULED with the same attemptCount), so an accepted
  // message is never sent again.
  const fenced = async (
    statuses: prismaPkg.CommunicationStatus[],
    data: prismaPkg.Prisma.CommunicationMessageUpdateManyMutationInput,
  ) => {
    await client.communicationMessage.updateMany({
      where: { id: row.id, attemptCount: row.attemptCount, status: { in: statuses } },
      data,
    });
    return client.communicationMessage.findUniqueOrThrow({ where: { id: row.id } });
  };
  if (result.ok) {
    const updated = await fenced([prismaPkg.CommunicationStatus.QUEUED, prismaPkg.CommunicationStatus.RETRY_SCHEDULED], {
        provider: prismaPkg.CommunicationProvider.TWILIO,
        providerMessageId: result.providerMessageId,
        status:
          result.status === "QUEUED"
            ? prismaPkg.CommunicationStatus.QUEUED
            : prismaPkg.CommunicationStatus.SENT,
        sentAtUtc: result.sentAtUtc,
        errorCode: null,
        errorMessage: null,
        nextAttemptAtUtc: null,
    });
    return {
      message: updated,
      status: result.status === "QUEUED" ? "queued" : "sent",
    };
  }
  // Failure path. Decide retry vs terminal.
  const classification = classifyCommunicationProviderError(
    result.errorCode,
    result.errorMessage,
  );
  const purpose = row.purpose as CommunicationPurpose;
  const allowRetry =
    classification === "transient" &&
    isRetryEligibleCommunicationPurpose(purpose) &&
    row.attemptCount < COMMUNICATION_RETRY_MAX_ATTEMPTS;
  if (allowRetry) {
    const delay = communicationRetryDelaySeconds(row.attemptCount + 1);
    const nextAt = new Date(Date.now() + delay * 1000);
    const updated = await fenced([prismaPkg.CommunicationStatus.QUEUED], {
        status: prismaPkg.CommunicationStatus.RETRY_SCHEDULED,
        nextAttemptAtUtc: nextAt,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
    });
    safeEmitSecurityEvent(
      {
        teamId: row.teamId,
        eventType: "communication_message_failed",
        severity: "INFO",
        details: {
          purpose: row.purpose,
          channel: row.channel,
          reason: result.reason,
          attempt: row.attemptCount,
          retry: true,
        },
      },
      client,
    );
    return { message: updated, status: "retry_scheduled" };
  }
  const updated = await fenced([prismaPkg.CommunicationStatus.QUEUED], {
      status: prismaPkg.CommunicationStatus.FAILED,
      failedAtUtc: new Date(),
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
  });
  safeEmitSecurityEvent(
    {
      teamId: row.teamId,
      eventType: "communication_message_failed",
      severity: "WARNING",
      details: {
        purpose: row.purpose,
        channel: row.channel,
        reason: result.reason,
        attempt: row.attemptCount,
        retry: false,
      },
    },
    client,
  );
  return { message: updated, status: "failed" };
}

// -----------------------------------------------------------------------------
// Opt-out check
// -----------------------------------------------------------------------------

async function isRecipientOptedOut(
  input: {
    teamId: string;
    recipientHash: string;
    channel: CommunicationChannel;
  },
  client: PrismaClient,
): Promise<boolean> {
  const pref = await client.communicationPreference.findFirst({
    where: {
      teamId: input.teamId,
      externalContactHash: input.recipientHash,
    },
    select: { smsOptOut: true, whatsappOptOut: true },
  });
  if (!pref) return false;
  if (input.channel === "SMS") return pref.smsOptOut;
  if (input.channel === "WHATSAPP") return pref.whatsappOptOut;
  return false;
}

// -----------------------------------------------------------------------------
// Body preview safety
// -----------------------------------------------------------------------------

function safeBodyPreview(body: string | null | undefined): string | null {
  if (!body) return null;
  const t = body.trim();
  if (t.length === 0) return null;
  return t.length > 400 ? t.slice(0, 399) + "…" : t;
}

// -----------------------------------------------------------------------------
// Read projections (for /communications UI)
// -----------------------------------------------------------------------------

export type CommunicationMessageProjection = {
  id: string;
  channel: CommunicationChannel;
  direction: "OUTBOUND" | "INBOUND";
  purpose: CommunicationPurpose;
  status: CommunicationStatus;
  provider: string;
  recipientPreview: string;
  bodyPreview: string | null;
  attemptCount: number;
  nextAttemptAtUtc: string | null;
  errorCode: string | null;
  relatedEvidenceId: string | null;
  relatedEvidenceRequestId: string | null;
  relatedDiscussionThreadId: string | null;
  relatedIntakeSessionId: string | null;
  /**
   * The intake link a delivery was sent for. The column is written on every
   * intake send and the list route filters by it, but it was never projected —
   * so Home (web and native) could not match a message to its link: no
   * per-link delivery status, and "Failed sends" was always 0.
   */
  relatedIntakeLinkId: string | null;
  createdAt: string;
  sentAtUtc: string | null;
  deliveredAtUtc: string | null;
  failedAtUtc: string | null;
};

export function projectCommunicationMessage(
  row: prismaPkg.CommunicationMessage,
): CommunicationMessageProjection {
  return {
    id: row.id,
    channel: row.channel as CommunicationChannel,
    direction: row.direction as "OUTBOUND" | "INBOUND",
    purpose: row.purpose as CommunicationPurpose,
    status: row.status as CommunicationStatus,
    provider: row.provider,
    recipientPreview: row.recipientPreview,
    bodyPreview: row.bodyPreview,
    attemptCount: row.attemptCount,
    nextAttemptAtUtc: row.nextAttemptAtUtc?.toISOString() ?? null,
    errorCode: row.errorCode,
    relatedEvidenceId: row.relatedEvidenceId,
    relatedEvidenceRequestId: row.relatedEvidenceRequestId,
    relatedDiscussionThreadId: row.relatedDiscussionThreadId,
    relatedIntakeSessionId: row.relatedIntakeSessionId,
    relatedIntakeLinkId: row.relatedIntakeLinkId,
    createdAt: row.createdAt.toISOString(),
    sentAtUtc: row.sentAtUtc?.toISOString() ?? null,
    deliveredAtUtc: row.deliveredAtUtc?.toISOString() ?? null,
    failedAtUtc: row.failedAtUtc?.toISOString() ?? null,
  };
}

/**
 * B3C-F-002 (free-audit 0ea0) — the RECORD-SCOPED delivery summary a reader
 * without the messaging operator authority receives: whether and when a
 * message about the record they opened went out, and nothing about whom it
 * went to or what it said. Recipient, body, provider, provider error and the
 * links to other records are withheld (null, not omitted, so a client reading
 * them gets an absence); `contentWithheld` says which projection this is.
 *
 * It mirrors the contextual delivery surface on an evidence request
 * (`GET /v1/evidence-requests/:id/deliveries`): status, timestamps, attempt
 * count — the global delivery log stays an operations surface.
 */
export type CommunicationMessageSummaryProjection = Omit<
  CommunicationMessageProjection,
  "provider" | "recipientPreview" | "errorCode"
> & {
  provider: null;
  recipientPreview: null;
  bodyPreview: null;
  errorCode: null;
  contentWithheld: true;
};

export function projectCommunicationMessageSummary(
  row: prismaPkg.CommunicationMessage,
): CommunicationMessageSummaryProjection {
  const full = projectCommunicationMessage(row);
  return {
    ...full,
    provider: null,
    recipientPreview: null,
    bodyPreview: null,
    errorCode: null,
    relatedEvidenceId: null,
    relatedDiscussionThreadId: null,
    relatedIntakeSessionId: null,
    contentWithheld: true,
  };
}
