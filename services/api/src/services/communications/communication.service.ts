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
      bodyPreview: safeBodyPreview(input.body),
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
  };

  const result =
    input.channel === "WHATSAPP"
      ? await provider.sendWhatsApp(sendInput)
      : await provider.sendSms(sendInput);

  return updateAfterProviderAttempt(queued, result, provider, client);
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
  if (
    row.status !== prismaPkg.CommunicationStatus.RETRY_SCHEDULED &&
    row.status !== prismaPkg.CommunicationStatus.QUEUED
  ) {
    return { status: "not_eligible", message: row };
  }
  if (!isPhoneChannel(row.channel as CommunicationChannel)) {
    return { status: "not_eligible", message: row };
  }
  if (!provider.isConfigured()) {
    return { status: "not_eligible", message: row };
  }
  // Re-derive phone? We do NOT store it. Retrying requires the original
  // dispatch path to have set `recipientPreview` only — we cannot reach
  // the provider without the raw phone, so for Phase 18 retries are
  // gated on `relatedIntakeLinkId` / `relatedEvidenceRequestId` to
  // re-derive the phone from the source record. Generic retries
  // without a source are marked as not-eligible.
  const phone = await resolvePhoneFromSource(row, client);
  if (!phone) {
    return { status: "not_eligible", message: row };
  }
  const updated = await client.communicationMessage.update({
    where: { id: row.id },
    data: {
      attemptCount: row.attemptCount + 1,
      status: prismaPkg.CommunicationStatus.QUEUED,
      nextAttemptAtUtc: null,
    },
  });
  const sendInput: ProviderSendInput = {
    toE164: phone,
    body: row.bodyPreview ?? "(retry)",
    externalId: row.id,
  };
  const result =
    row.channel === "WHATSAPP"
      ? await provider.sendWhatsApp(sendInput)
      : await provider.sendSms(sendInput);
  return updateAfterProviderAttempt(updated, result, provider, client);
}

async function resolvePhoneFromSource(
  row: prismaPkg.CommunicationMessage,
  client: PrismaClient,
): Promise<string | null> {
  if (row.relatedEvidenceRequestId) {
    const req = await client.evidenceRequest.findUnique({
      where: { id: row.relatedEvidenceRequestId },
      select: { recipientPhone: true },
    });
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
  if (result.ok) {
    const updated = await client.communicationMessage.update({
      where: { id: row.id },
      data: {
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
      },
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
    const updated = await client.communicationMessage.update({
      where: { id: row.id },
      data: {
        status: prismaPkg.CommunicationStatus.RETRY_SCHEDULED,
        nextAttemptAtUtc: nextAt,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
      },
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
  const updated = await client.communicationMessage.update({
    where: { id: row.id },
    data: {
      status: prismaPkg.CommunicationStatus.FAILED,
      failedAtUtc: new Date(),
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
    },
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
    createdAt: row.createdAt.toISOString(),
    sentAtUtc: row.sentAtUtc?.toISOString() ?? null,
    deliveredAtUtc: row.deliveredAtUtc?.toISOString() ?? null,
    failedAtUtc: row.failedAtUtc?.toISOString() ?? null,
  };
}
