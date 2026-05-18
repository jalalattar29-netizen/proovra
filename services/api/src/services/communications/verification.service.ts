/**
 * Phase 18 — Verification (OTP) service.
 *
 * Wraps the messaging provider's start/check flow. The OTP code value
 * is NEVER persisted or logged — Twilio Verify owns it.
 *
 * Audit rows on `verification_attempts` record:
 *   - start attempts (recipient hash + masked preview, no number)
 *   - check attempts (bounded by maxCheckAttempts; on exceed we mark
 *     the row as DENIED so a fresh start is required)
 *
 * Rate limit: per (teamId, recipientHash) — N starts per hour. Default
 * 5 starts / hour, capped by the existing per-recipient daily ceiling.
 */

import type { PrismaClient } from "@prisma/client";
import * as prismaPkg from "@prisma/client";
import {
  type CommunicationChannel,
  normaliseToE164,
  maskPhonePreview,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { appendPlatformAuditLog } from "../platform-audit-log.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";

import { hashRecipientPhone } from "./communication.service.js";
import { getMessagingProvider } from "./provider-registry.js";

const VERIFICATION_TTL_SECONDS = 10 * 60; // Twilio default
const MAX_CHECK_ATTEMPTS = 5;
const STARTS_PER_HOUR = 5;

export type VerificationErrorCode =
  | "feature_disabled"
  | "invalid_phone"
  | "channel_unsupported"
  | "rate_limited"
  | "provider_unconfigured"
  | "provider_unreachable"
  | "provider_rejected"
  | "verification_not_found"
  | "verification_expired"
  | "verification_check_exhausted"
  | "verification_check_failed";

export class VerificationError extends Error {
  readonly code: VerificationErrorCode;
  constructor(code: VerificationErrorCode) {
    super(code);
    this.code = code;
  }
}

// -----------------------------------------------------------------------------
// Start
// -----------------------------------------------------------------------------

export type StartVerificationInput = {
  teamId: string;
  channel: Extract<CommunicationChannel, "SMS" | "WHATSAPP">;
  phoneE164OrRaw: string;
  initiatedByUserId?: string | null;
  purpose?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export type StartVerificationResult = {
  attempt: prismaPkg.VerificationAttempt;
  status: "started" | "rate_limited";
};

export async function startVerification(
  input: StartVerificationInput,
  client: PrismaClient = defaultPrisma,
): Promise<StartVerificationResult> {
  const provider = getMessagingProvider();
  const phone = normaliseToE164(input.phoneE164OrRaw);
  if (!phone) throw new VerificationError("invalid_phone");
  const recipientHash = hashRecipientPhone(phone);
  const recipientPreview = maskPhonePreview(phone);

  // Per-recipient rate limit (per hour).
  const sinceHour = new Date(Date.now() - 3600 * 1000);
  const recentStarts = await client.verificationAttempt.count({
    where: {
      teamId: input.teamId,
      recipientHash,
      createdAt: { gte: sinceHour },
    },
  });
  if (recentStarts >= STARTS_PER_HOUR) {
    const blocked = await client.verificationAttempt.create({
      data: {
        teamId: input.teamId,
        channel: input.channel,
        purpose: prismaPkg.CommunicationPurpose.OTP,
        recipientHash,
        recipientPreview,
        status: prismaPkg.VerificationAttemptStatus.FAILED,
        errorCode: "rate_limited",
        errorMessage: "Too many verification starts for this recipient.",
        initiatedByUserId: input.initiatedByUserId ?? null,
      },
    });
    safeEmitSecurityEvent(
      {
        teamId: input.teamId,
        eventType: "communication_rate_limit_exceeded",
        severity: "WARNING",
        details: {
          purpose: "OTP",
          channel: input.channel,
          recipientHash,
          scope: "verification_starts",
        },
      },
      client,
    );
    return { attempt: blocked, status: "rate_limited" };
  }

  if (!provider.isConfigured()) {
    const failed = await client.verificationAttempt.create({
      data: {
        teamId: input.teamId,
        channel: input.channel,
        purpose: prismaPkg.CommunicationPurpose.OTP,
        recipientHash,
        recipientPreview,
        status: prismaPkg.VerificationAttemptStatus.FAILED,
        errorCode: "provider_unconfigured",
        errorMessage: provider.unconfiguredReason() ?? "Provider not configured.",
        initiatedByUserId: input.initiatedByUserId ?? null,
      },
    });
    safeEmitSecurityEvent(
      {
        teamId: input.teamId,
        eventType: "communication_provider_unconfigured",
        severity: "WARNING",
        details: {
          purpose: "OTP",
          channel: input.channel,
        },
      },
      client,
    );
    throw new VerificationError("feature_disabled");
  }

  const result = await provider.startVerification({
    toE164: phone,
    channel: input.channel,
  });
  if (!result.ok) {
    const failed = await client.verificationAttempt.create({
      data: {
        teamId: input.teamId,
        channel: input.channel,
        purpose: prismaPkg.CommunicationPurpose.OTP,
        recipientHash,
        recipientPreview,
        status: prismaPkg.VerificationAttemptStatus.FAILED,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        initiatedByUserId: input.initiatedByUserId ?? null,
      },
    });
    safeEmitSecurityEvent(
      {
        teamId: input.teamId,
        eventType: "communication_message_failed",
        severity: "WARNING",
        details: {
          purpose: "OTP",
          channel: input.channel,
          reason: result.reason,
        },
      },
      client,
    );
    throw new VerificationError("provider_rejected");
  }

  const row = await client.verificationAttempt.create({
    data: {
      teamId: input.teamId,
      channel: input.channel,
      purpose: prismaPkg.CommunicationPurpose.OTP,
      recipientHash,
      recipientPreview,
      providerVerificationSid: result.providerVerificationSid,
      status: prismaPkg.VerificationAttemptStatus.STARTED,
      initiatedByUserId: input.initiatedByUserId ?? null,
      expiresAtUtc: new Date(Date.now() + VERIFICATION_TTL_SECONDS * 1000),
    },
  });
  safeEmitSecurityEvent(
    {
      teamId: input.teamId,
      eventType: "verification_started",
      severity: "INFO",
      details: {
        channel: input.channel,
        recipientHash,
        purpose: input.purpose ?? "OTP",
      },
    },
    client,
  );
  await appendPlatformAuditLog({
    userId: input.initiatedByUserId ?? null,
    isPublic: input.initiatedByUserId === null,
    action: "communications.verify.start",
    category: "communications.verify",
    severity: "info",
    source: "communications_service",
    outcome: "success",
    resourceType: "verification_attempt",
    resourceId: row.id,
    metadata: {
      teamId: input.teamId,
      channel: input.channel,
      recipientHash,
      recipientPreview,
    },
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    db: client,
  });
  return { attempt: row, status: "started" };
}

// -----------------------------------------------------------------------------
// Check
// -----------------------------------------------------------------------------

export type CheckVerificationInput = {
  teamId: string;
  phoneE164OrRaw: string;
  // The code is passed STRAIGHT to the provider — never persisted,
  // never logged. The caller (route handler) is responsible for not
  // putting the code in any error response.
  code: string;
  initiatedByUserId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export type CheckVerificationResult = {
  attempt: prismaPkg.VerificationAttempt | null;
  status: "approved" | "denied";
};

export async function checkVerification(
  input: CheckVerificationInput,
  client: PrismaClient = defaultPrisma,
): Promise<CheckVerificationResult> {
  const provider = getMessagingProvider();
  const phone = normaliseToE164(input.phoneE164OrRaw);
  if (!phone) throw new VerificationError("invalid_phone");
  const recipientHash = hashRecipientPhone(phone);

  if (!provider.isConfigured()) {
    throw new VerificationError("feature_disabled");
  }

  // Find the most recent STARTED attempt for this recipient. Bounded
  // check-attempt count protects against brute force.
  const open = await client.verificationAttempt.findFirst({
    where: {
      teamId: input.teamId,
      recipientHash,
      status: prismaPkg.VerificationAttemptStatus.STARTED,
    },
    orderBy: { createdAt: "desc" },
  });
  if (!open) {
    throw new VerificationError("verification_not_found");
  }
  if (open.expiresAtUtc && open.expiresAtUtc.getTime() <= Date.now()) {
    await client.verificationAttempt.update({
      where: { id: open.id },
      data: { status: prismaPkg.VerificationAttemptStatus.EXPIRED },
    });
    throw new VerificationError("verification_expired");
  }
  if (open.checkAttemptCount >= MAX_CHECK_ATTEMPTS) {
    await client.verificationAttempt.update({
      where: { id: open.id },
      data: { status: prismaPkg.VerificationAttemptStatus.DENIED },
    });
    throw new VerificationError("verification_check_exhausted");
  }

  const result = await provider.checkVerification({
    toE164: phone,
    code: input.code,
    providerVerificationSid: open.providerVerificationSid,
  });
  const incremented = await client.verificationAttempt.update({
    where: { id: open.id },
    data: { checkAttemptCount: open.checkAttemptCount + 1 },
  });

  if (result.ok) {
    const approved = await client.verificationAttempt.update({
      where: { id: incremented.id },
      data: {
        status: prismaPkg.VerificationAttemptStatus.APPROVED,
        approvedAtUtc: new Date(),
      },
    });
    safeEmitSecurityEvent(
      {
        teamId: input.teamId,
        eventType: "verification_check_succeeded",
        severity: "INFO",
        details: { channel: open.channel, recipientHash },
      },
      client,
    );
    await appendPlatformAuditLog({
      userId: input.initiatedByUserId ?? null,
      isPublic: input.initiatedByUserId === null,
      action: "communications.verify.check.approved",
      category: "communications.verify",
      severity: "info",
      source: "communications_service",
      outcome: "success",
      resourceType: "verification_attempt",
      resourceId: approved.id,
      metadata: {
        teamId: input.teamId,
        channel: open.channel,
        recipientHash,
      },
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      db: client,
    });
    return { attempt: approved, status: "approved" };
  }

  // Denied path. We deliberately return a generic result — never echo
  // back which reason (wrong code vs expired vs unknown) so the route
  // cannot become an oracle for code guessing.
  safeEmitSecurityEvent(
    {
      teamId: input.teamId,
      eventType: "verification_check_failed",
      severity: "INFO",
      details: {
        channel: open.channel,
        recipientHash,
        reason: result.reason,
      },
    },
    client,
  );
  await appendPlatformAuditLog({
    userId: input.initiatedByUserId ?? null,
    isPublic: input.initiatedByUserId === null,
    action: "communications.verify.check.denied",
    category: "communications.verify",
    severity: "warning",
    source: "communications_service",
    outcome: "failure",
    resourceType: "verification_attempt",
    resourceId: incremented.id,
    metadata: {
      teamId: input.teamId,
      channel: open.channel,
      recipientHash,
      providerReason: result.reason,
    },
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    db: client,
  });
  return { attempt: incremented, status: "denied" };
}

// -----------------------------------------------------------------------------
// Read projection
// -----------------------------------------------------------------------------

export function projectVerificationAttempt(
  row: prismaPkg.VerificationAttempt,
): {
  id: string;
  channel: string;
  status: string;
  recipientPreview: string;
  checkAttemptCount: number;
  createdAt: string;
  approvedAtUtc: string | null;
  expiresAtUtc: string | null;
} {
  return {
    id: row.id,
    channel: row.channel,
    status: row.status,
    recipientPreview: row.recipientPreview,
    checkAttemptCount: row.checkAttemptCount,
    createdAt: row.createdAt.toISOString(),
    approvedAtUtc: row.approvedAtUtc?.toISOString() ?? null,
    expiresAtUtc: row.expiresAtUtc?.toISOString() ?? null,
  };
}
