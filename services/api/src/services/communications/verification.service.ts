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
import { emitTenantAudit } from "../audit/tenant-audit.service.js";
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

  /**
   * Per-recipient rate limit (per hour).
   *
   * PHASE 13 (NEW-056) — the limiter does NOT count its own refusals.
   *
   * Every refusal below writes a `FAILED` / `rate_limited` row, and this count
   * had no predicate excluding them — so the rows the limiter created were
   * counted by the next call. Once the limit tripped, each further attempt
   * pushed the window forward by another hour: a user who briefly exceeded the
   * limit stayed locked out for as long as they kept trying, which is the
   * opposite of a limit that decays. A rate limit must measure the thing being
   * limited — verification STARTS — and a refusal is not a start.
   */
  //
  // PRO-086 / FEATURES-04 — and it must COUNT the starts. `NOT: { errorCode:
  // "rate_limited" }` compiles to `NOT (error_code = 'rate_limited')`, which
  // is NULL — not true — for a successful start (errorCode NULL), so every
  // successful start was dropped and the limit could never trip. The NULL
  // case is now named explicitly.
  const sinceHour = new Date(Date.now() - 3600 * 1000);
  const recentStarts = await client.verificationAttempt.count({
    where: {
      teamId: input.teamId,
      recipientHash,
      createdAt: { gte: sinceHour },
      OR: [{ errorCode: null }, { errorCode: { not: "rate_limited" } }],
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
    await client.verificationAttempt.create({
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
    await client.verificationAttempt.create({
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
  await emitTenantAudit({
    action: "communications.verify.start",
    outcome: "success",
    sourceApp: "API",
    actorUserId: input.initiatedByUserId ?? null,
    workspaceId: input.teamId,
    resourceType: "verification_attempt",
    resourceId: row.id,
    metadata: {
      channel: input.channel,
      recipientHash,
      recipientPreview,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
  }, client);
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
  /**
   * PHASE 13 (NEW-055) — check THIS attempt, not merely the newest one.
   *
   * A caller that already owns a verification attempt — the step-up challenge
   * does, it persists `verificationAttemptId` at start — must be able to say
   * so. Without it, the lookup below takes the most recent STARTED attempt for
   * the recipient, so two concurrent challenges on one number let the code
   * minted for the second approve the FIRST. The binding was written and never
   * enforced.
   *
   * Optional, because callers that do NOT own a specific attempt (a bare
   * verification with no challenge behind it) still legitimately want "the one
   * in flight". Supplying it narrows; omitting it is exactly today's
   * behaviour.
   */
  verificationAttemptId?: string | null;
  /**
   * PRO-087 (FEATURES-05) — the bare `/v1/communications/verify/check` route.
   *
   * Without a bound attempt the lookup took the newest STARTED attempt for the
   * tenant and number, whoever started it and for whatever purpose. A step-up
   * challenge (`step-up.service.ts`) starts its attempt on the same tenant and
   * the colleague's own phone, so any co-member who knew that number could
   * post five wrong codes and spend the colleague's step-up attempt — a
   * targeted, repeatable denial of their privileged actions.
   *
   * A caller with no challenge of its own may only check an attempt IT started
   * (`initiatedByUserId`), and never one a step-up challenge has claimed: those
   * are answered through `/v1/identity-security/step-up/check`, which binds the
   * attempt id (NEW-055). Required with `verificationAttemptId` absent or not.
   */
  callerScoped?: { userId: string };
};

/** How many of the caller's own open attempts a bare check considers. */
const CALLER_SCOPED_CANDIDATES = 20;

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

  // Find the STARTED attempt this check is FOR. Bounded check-attempt count
  // protects against brute force.
  //
  // NEW-055: when the caller names its own attempt, that id is part of the
  // predicate — so a code minted for one challenge cannot approve another that
  // happens to share the recipient. The recipient and tenant predicates are
  // kept alongside it rather than replaced by it: an id supplied by a caller is
  // still checked against the tenant and number it must belong to.
  const where: prismaPkg.Prisma.VerificationAttemptWhereInput = {
    teamId: input.teamId,
    recipientHash,
    status: prismaPkg.VerificationAttemptStatus.STARTED,
    ...(input.verificationAttemptId ? { id: input.verificationAttemptId } : {}),
    ...(input.callerScoped ? { initiatedByUserId: input.callerScoped.userId } : {}),
  };
  let open: prismaPkg.VerificationAttempt | null;
  if (input.callerScoped) {
    // PRO-087: the caller's own attempts only, minus any a step-up challenge
    // owns. The challenge row is the only durable mark of that ownership.
    const candidates = await client.verificationAttempt.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: CALLER_SCOPED_CANDIDATES,
    });
    const claimed = candidates.length
      ? new Set(
          (
            await client.stepUpChallenge.findMany({
              where: { verificationAttemptId: { in: candidates.map((c) => c.id) } },
              select: { verificationAttemptId: true },
            })
          ).map((c) => c.verificationAttemptId),
        )
      : new Set<string | null>();
    open = candidates.find((c) => !claimed.has(c.id)) ?? null;
  } else {
    open = await client.verificationAttempt.findFirst({
      where,
      orderBy: { createdAt: "desc" },
    });
  }
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
  /*
   * PRO-028 (AUTH-22) — THE ATTEMPT IS COUNTED BEFORE THE CODE IS CHECKED.
   *
   * The count used to be read here and written back as `read + 1` after the
   * provider answered, so eight concurrent wrong codes all read the same count
   * and the limit of five never tripped: the right code was then still
   * accepted. Each check now RESERVES its slot with one conditional increment
   * (`checkAttemptCount < MAX` on a STARTED row). A check that cannot reserve
   * a slot is refused without reaching the provider, and the attempt is spent.
   */
  const reserved = await client.verificationAttempt.updateMany({
    where: {
      id: open.id,
      status: prismaPkg.VerificationAttemptStatus.STARTED,
      checkAttemptCount: { lt: MAX_CHECK_ATTEMPTS },
    },
    data: { checkAttemptCount: { increment: 1 } },
  });
  if (reserved.count !== 1) {
    await client.verificationAttempt.updateMany({
      where: { id: open.id, status: prismaPkg.VerificationAttemptStatus.STARTED },
      data: { status: prismaPkg.VerificationAttemptStatus.DENIED },
    });
    throw new VerificationError("verification_check_exhausted");
  }

  const result = await provider.checkVerification({
    toE164: phone,
    code: input.code,
    providerVerificationSid: open.providerVerificationSid,
  });
  const incremented = await client.verificationAttempt.findUniqueOrThrow({
    where: { id: open.id },
  });

  // An approval is only ever written onto a still-STARTED attempt: a
  // concurrent check that spent or approved it first wins, and this one is a
  // denial.
  const approvedNow =
    result.ok &&
    (
      await client.verificationAttempt.updateMany({
        where: { id: open.id, status: prismaPkg.VerificationAttemptStatus.STARTED },
        data: {
          status: prismaPkg.VerificationAttemptStatus.APPROVED,
          approvedAtUtc: new Date(),
        },
      })
    ).count === 1;

  if (approvedNow) {
    const approved = await client.verificationAttempt.findUniqueOrThrow({
      where: { id: open.id },
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
    await emitTenantAudit({
      action: "communications.verify.check.approved",
      outcome: "success",
      sourceApp: "API",
      actorUserId: input.initiatedByUserId ?? null,
      workspaceId: input.teamId,
      resourceType: "verification_attempt",
      resourceId: approved.id,
      metadata: {
        channel: open.channel,
        recipientHash,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
    }, client);
    return { attempt: approved, status: "approved" };
  }

  // Denied path. We deliberately return a generic result — never echo
  // back which reason (wrong code vs expired vs unknown) so the route
  // cannot become an oracle for code guessing.
  const denialReason = result.ok ? "attempt_already_resolved" : result.reason;
  safeEmitSecurityEvent(
    {
      teamId: input.teamId,
      eventType: "verification_check_failed",
      severity: "INFO",
      details: {
        channel: open.channel,
        recipientHash,
        reason: denialReason,
      },
    },
    client,
  );
  await emitTenantAudit({
    action: "communications.verify.check.denied",
    outcome: "denied",
    denialReason,
    sourceApp: "API",
    actorUserId: input.initiatedByUserId ?? null,
    workspaceId: input.teamId,
    resourceType: "verification_attempt",
    resourceId: incremented.id,
    metadata: {
      channel: open.channel,
      recipientHash,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
  }, client);
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
