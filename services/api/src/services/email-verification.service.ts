/**
 * Enterprise email verification — service layer.
 *
 * This module owns the business logic for the email-verification flow:
 *   - dispatchVerificationEmail: create token + build URL + send email,
 *     used by the register route AND the resend route.
 *   - consumeVerificationToken: validate + flip emailVerifiedAt,
 *     used by the verify route.
 *   - shouldThrottleResend: per-email 60 s cooldown for the resend
 *     route, on top of the per-IP rate limit applied in the route.
 *
 * The HTTP layer (services/api/src/routes/auth.routes.ts) only
 * orchestrates: it enforces per-IP rate limits, signs JWTs, sets
 * cookies, and emits audit events. Pulling the token + email +
 * cooldown logic out keeps auth.routes.ts back inside the R8.1.2
 * size-budget baseline and gives the verification flow a single
 * audit-able surface.
 */

import { z } from "zod";

import { prisma } from "../db.js";
import { getEmailService } from "./email.service.js";
import {
  createEmailVerificationToken,
  consumeEmailVerificationToken,
  findUnverifiedEmailUserByEmail,
  latestDeliverableVerificationTokenAt,
  settleEmailVerificationTokenDelivery,
  type ConsumeEmailVerificationTokenResult,
} from "./email-password-auth.service.js";
import type { EmailDeliveryOutcome } from "@proovra/shared-runtime";
// PHASE 11 — canonical internal URL builder.
import { absoluteInternalUrl, internalNavPath, isSafeRedirectAfter } from "@proovra/shared";

// Spec floor: 1 verification email per address per 60 seconds. Layered
// on top of the per-IP bucket so a rotating-IP attacker still cannot
// flood a real mailbox.
export const EMAIL_VERIFICATION_RESEND_COOLDOWN_MS = 60 * 1000;

function getWebBase(): string {
  return (process.env.WEB_BASE_URL || "https://www.proovra.com").replace(
    /\/$/,
    "",
  );
}

/**
 * F-26f — where the person was going when they signed up (an invitation, a
 * plan chosen on /pricing). Carried IN the emailed link, because the link is
 * opened in a new tab or on another device, where nothing the register page
 * stored survives. Only an in-app path passes (the shared open-redirect rule);
 * anything else is dropped and the verify page lands on its default.
 */
export function verificationReturnPath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 512 || !raw.startsWith("/")) return null;
  return isSafeRedirectAfter(raw) ? raw : null;
}

function buildVerifyUrl(rawToken: string, returnPath: string | null): string {
  // PHASE 11 — /auth/verify-email is a nav path (query-carried token,
  // not a resource id), composed via internalNavPath.
  const next = returnPath ? `&next=${encodeURIComponent(returnPath)}` : "";
  return absoluteInternalUrl(
    getWebBase(),
    internalNavPath(`/auth/verify-email?token=${encodeURIComponent(rawToken)}${next}`),
  );
}

/**
 * F-06 — what actually happened to a verification email.
 *
 *   - `sent`: the provider accepted it.
 *   - `unconfirmed`: the request left this process and no answer came back
 *     (timeout, dropped connection). It MAY have been accepted; the link stays
 *     live and the cooldown applies, so a retry does not double-send blindly.
 *   - `failed`: the provider refused, or no transport is configured. Nothing
 *     was sent; the link was removed and no cooldown applies.
 *   - `cooldown`: a link that may already be in the inbox was sent less than
 *     {@link EMAIL_VERIFICATION_RESEND_COOLDOWN_MS} ago, so nothing new was
 *     sent this time.
 */
export type VerificationDelivery = "sent" | "unconfirmed" | "failed" | "cooldown";

export type DispatchVerificationOutcome = {
  /** True only when the provider ACCEPTED the email (`delivery === "sent"`). */
  delivered: boolean;
  delivery: VerificationDelivery;
  /** Seconds until another send to this address would be attempted. */
  retryAfterSec: number;
  /** Populated when delivery is `failed` or `unconfirmed`. Audit only; never
   *  sent to the client. */
  error?: string;
  /** B8-F-302 — the refusal was "not now"; an automatic retry is scheduled. */
  retryable?: boolean;
};

const COOLDOWN_SEC = Math.ceil(EMAIL_VERIFICATION_RESEND_COOLDOWN_MS / 1000);

/**
 * Mint a link for `userId`, ask the provider to deliver it, and report the
 * provider's real answer. The transport never throws for a provider refusal or
 * a timeout (it returns an outcome kind); it used to be awaited and discarded,
 * so every refusal was reported as "sent". Only the not-configured email
 * service throws, which is a refusal too.
 *
 * Per-address cooldown: a link that may already be in the inbox and is younger
 * than the cooldown means nothing new is sent (one email per address per
 * minute, whichever endpoint asks).
 */
export async function dispatchVerificationEmail(params: {
  userId: string;
  toEmail: string;
  /** F-26f — validated with {@link verificationReturnPath}; null = none. */
  returnPath?: string | null;
  /** B8-F-302 — set by the retry sweep, which owns its outbox row. */
  fromOutbox?: boolean;
}): Promise<DispatchVerificationOutcome> {
  const { userId, toEmail } = params;

  const latestAt = await latestDeliverableVerificationTokenAt(userId);
  if (latestAt) {
    const remainingMs = EMAIL_VERIFICATION_RESEND_COOLDOWN_MS - (Date.now() - latestAt.getTime());
    if (remainingMs > 0) {
      return {
        delivered: false,
        delivery: "cooldown",
        retryAfterSec: Math.max(1, Math.ceil(remainingMs / 1000)),
      };
    }
  }

  const token = await createEmailVerificationToken(userId, { retirePriorTokens: false });
  const verifyUrl = buildVerifyUrl(token.rawToken, verificationReturnPath(params.returnPath));

  let outcome: EmailDeliveryOutcome | { kind: "threw"; message: string };
  try {
    outcome = await getEmailService().sendEmailVerificationEmail(toEmail, verifyUrl);
  } catch (err) {
    outcome = { kind: "threw", message: (err as Error)?.message ?? String(err) };
  }

  const settle = { tokenId: token.tokenId, userId, createdAt: token.createdAt };
  if (outcome.kind === "acknowledged") {
    await settleEmailVerificationTokenDelivery(settle, "acknowledged");
    return { delivered: true, delivery: "sent", retryAfterSec: COOLDOWN_SEC };
  }
  if (outcome.kind === "ambiguous") {
    await settleEmailVerificationTokenDelivery(settle, "ambiguous");
    return {
      delivered: false,
      delivery: "unconfirmed",
      retryAfterSec: COOLDOWN_SEC,
      error: `ambiguous:${outcome.errorCode}`,
    };
  }
  await settleEmailVerificationTokenDelivery(settle, "refused");
  // B8-F-302 — a "not now" refusal (429 / 408 / 5xx) is put on the outbox so
  // the notification-retries sweep delivers it without the person pressing
  // resend. Not for a retry run itself (it reschedules its own row), and never
  // for a permanent refusal or a missing configuration.
  if (outcome.kind === "retryable" && !params.fromOutbox) {
    await scheduleVerificationEmailRetry({ userId, toEmail, returnPath: params.returnPath ?? null });
  }
  return {
    delivered: false,
    delivery: "failed",
    retryAfterSec: 0,
    retryable: outcome.kind === "retryable",
    error:
      outcome.kind === "threw"
        ? outcome.message
        : outcome.kind === "not_configured"
          ? "not_configured"
          : `${outcome.kind}:${outcome.errorCode}`,
  };
}

/**
 * Audit-event spec returned by the resend pipeline. The route layer
 * passes these fields straight into auditAuthEvent — keeps the
 * neutral `{ ok: true }` response shape regardless of which branch ran.
 */
export type ResendAuditSpec = {
  userId: string | null;
  outcome: "success" | "failure" | "blocked";
  severity: "info" | "warning";
  reason?: string;
  error?: string;
};

/**
 * The cooldown the resend endpoint tells EVERY caller, whatever branch ran.
 * Answering with the real remaining time, or with a refusal, would tell a
 * stranger whether the address holds an account waiting for verification.
 */
export const EMAIL_VERIFICATION_RESEND_RETRY_AFTER_SEC = COOLDOWN_SEC;

/** Full resend pipeline: lookup unverified user → cooldown check →
 *  token + email. Returns a single audit-event spec the route emits. */
export async function processResendVerification(
  emailRaw: string,
  returnPath: string | null = null,
): Promise<ResendAuditSpec> {
  const target = await findUnverifiedEmailUserByEmail(emailRaw);
  if (!target) {
    return { userId: null, outcome: "blocked", severity: "info", reason: "no_unverified_user" };
  }

  const dispatch = await dispatchVerificationEmail({
    userId: target.id,
    toEmail: target.email ?? emailRaw,
    returnPath,
  });
  if (dispatch.delivery === "cooldown") {
    return { userId: target.id, outcome: "blocked", severity: "info", reason: "cooldown" };
  }
  if (dispatch.delivered) {
    return { userId: target.id, outcome: "success", severity: "info" };
  }
  return {
    userId: target.id,
    outcome: "failure",
    severity: "warning",
    error: dispatch.error ?? "unknown",
  };
}

/** Pass-through to the lower-level consume helper. Kept in this
 *  service so route code only has to import one module. */
export async function confirmVerificationToken(
  rawToken: string,
  options: { password?: string | null } = {},
): Promise<ConsumeEmailVerificationTokenResult> {
  return consumeEmailVerificationToken(rawToken, options);
}

export const EmailVerifyBody = z.object({
  token: z.string().min(1).max(256),
  password: z.string().min(1).max(1024).optional(),
});

/**
 * PROV-001 — the link is good and stays good; it needs the account's password
 * beside it. Only someone holding the emailed token reaches this answer, so it
 * tells an outsider nothing.
 */
export function passwordProofRefusal(reason: string): {
  error: { code: string; message: string; timestamp: string };
} | null {
  if (reason !== "password_required" && reason !== "password_incorrect") return null;
  return {
    error: {
      code:
        reason === "password_required"
          ? "EMAIL_VERIFICATION_PASSWORD_REQUIRED"
          : "EMAIL_VERIFICATION_PASSWORD_INCORRECT",
      message:
        reason === "password_required"
          ? "Enter the password chosen for this account to finish verifying it."
          : "That password is not the one chosen for this account.",
      timestamp: new Date().toISOString(),
    },
  };
}

/** Re-fetch the canonical user row after a successful token consume.
 *  The consume helper returns a narrow projection — JWT payload and
 *  session inventory need the full record. Returns null if the row
 *  disappeared between the consume and the lookup (a near-impossible
 *  race that the route maps to a 500). */
export async function loadFullUserForSession(
  userId: string,
): Promise<{
  id: string;
  email: string | null;
  provider: string;
  currentWorkspaceId: string | null;
} | null> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, provider: true, currentWorkspaceId: true },
  });
  return u;
}


// ===========================================================================
// B8-F-302 (free-audit 0ea0) — THE VERIFICATION-EMAIL OUTBOX.
//
// The sign-up verification email was sent inside the request with nothing
// behind it: a provider rate limit during a sign-up burst left the person on
// "we couldn't send it" until they pressed resend after the cooldown. A
// retryable refusal now writes a NotificationDelivery row (eventType
// EMAIL_VERIFICATION, provider INTERNAL so the generic RESEND retry sweep
// never tries to render it) carrying ONLY the recipient and user id — never a
// token or link: each retry mints a fresh link through dispatchVerificationEmail,
// with the same per-address cooldown and the same honest settlement. The
// notification-retries cron (POST /v1/notifications/process-retries) drains it.
// ===========================================================================

export const VERIFICATION_EMAIL_EVENT = "EMAIL_VERIFICATION";
export const VERIFICATION_EMAIL_MAX_ATTEMPTS = 5;

function verificationRetryDelayMs(attempt: number): number {
  // 60 s (the per-address cooldown), doubling, at most 30 min.
  return Math.min(30 * 60 * 1000, EMAIL_VERIFICATION_RESEND_COOLDOWN_MS * 2 ** Math.max(0, attempt - 1));
}

export async function scheduleVerificationEmailRetry(input: {
  userId: string;
  toEmail: string;
  returnPath: string | null;
}): Promise<void> {
  try {
    // One open retry per person: a second refusal while one is scheduled does
    // not stack a second row.
    const open = await prisma.notificationDelivery.findFirst({
      where: {
        eventType: VERIFICATION_EMAIL_EVENT,
        recipientUserId: input.userId,
        status: { in: ["RETRY_SCHEDULED", "PENDING"] },
      },
      select: { id: true },
    });
    if (open) return;
    await prisma.notificationDelivery.create({
      data: {
        eventType: VERIFICATION_EMAIL_EVENT,
        channel: "EMAIL",
        provider: "INTERNAL",
        recipient: input.toEmail,
        recipientUserId: input.userId,
        status: "RETRY_SCHEDULED",
        templateKey: VERIFICATION_EMAIL_EVENT,
        retryCount: 0,
        nextAttemptAtUtc: new Date(Date.now() + verificationRetryDelayMs(1)),
        errorCode: "provider_retryable",
        // The validated return path only (a same-site path), never a token.
        metadata: input.returnPath ? { returnPath: verificationReturnPath(input.returnPath) } : {},
      },
    });
  } catch {
    // The outbox is best effort: the person can still press resend.
  }
}

export type VerificationRetrySummary = {
  pickedUp: number;
  sent: number;
  rescheduled: number;
  cancelled: number;
  failed: number;
};

export async function processDueVerificationEmailRetries(
  input: { batchSize?: number; now?: Date } = {},
): Promise<VerificationRetrySummary> {
  const summary: VerificationRetrySummary = { pickedUp: 0, sent: 0, rescheduled: 0, cancelled: 0, failed: 0 };
  const now = input.now ?? new Date();
  const rows = await prisma.notificationDelivery.findMany({
    where: {
      eventType: VERIFICATION_EMAIL_EVENT,
      provider: "INTERNAL",
      status: "RETRY_SCHEDULED",
      nextAttemptAtUtc: { lte: now },
    },
    orderBy: { nextAttemptAtUtc: "asc" },
    take: Math.min(Math.max(input.batchSize ?? 50, 1), 500),
  });
  for (const row of rows) {
    // Claim: exactly one sweeper takes the row.
    const claim = await prisma.notificationDelivery.updateMany({
      where: { id: row.id, status: "RETRY_SCHEDULED" },
      data: { status: "PENDING" },
    });
    if (claim.count !== 1) continue;
    summary.pickedUp += 1;
    const finish = (data: Record<string, unknown>) =>
      prisma.notificationDelivery.update({ where: { id: row.id }, data: data as never });

    // Still owed? A verified, deleted, or re-addressed account is not.
    const user = row.recipientUserId
      ? await prisma.user.findUnique({
          where: { id: row.recipientUserId },
          select: { email: true, emailVerifiedAt: true },
        })
      : null;
    if (!user || user.emailVerifiedAt || (user.email ?? "").toLowerCase() !== row.recipient.toLowerCase()) {
      await finish({ status: "CANCELLED", errorCode: "no_longer_owed", nextAttemptAtUtc: null });
      summary.cancelled += 1;
      continue;
    }
    const returnPath =
      row.metadata && typeof row.metadata === "object" && typeof (row.metadata as { returnPath?: unknown }).returnPath === "string"
        ? ((row.metadata as { returnPath: string }).returnPath)
        : null;
    const outcome = await dispatchVerificationEmail({
      userId: row.recipientUserId!,
      toEmail: row.recipient,
      returnPath,
      fromOutbox: true,
    });
    if (outcome.delivered) {
      await finish({ status: "SENT", sentAtUtc: new Date(), errorCode: null, nextAttemptAtUtc: null });
      summary.sent += 1;
      continue;
    }
    if (outcome.delivery === "cooldown" || outcome.delivery === "unconfirmed") {
      // A link that may already be in the inbox exists (the person pressed
      // resend, or the provider may have accepted it): nothing more is owed.
      await finish({ status: "CANCELLED", errorCode: `superseded_${outcome.delivery}`, nextAttemptAtUtc: null });
      summary.cancelled += 1;
      continue;
    }
    const attempt = row.retryCount + 1;
    if (outcome.retryable && attempt < VERIFICATION_EMAIL_MAX_ATTEMPTS) {
      await finish({
        status: "RETRY_SCHEDULED",
        retryCount: attempt,
        nextAttemptAtUtc: new Date(Date.now() + verificationRetryDelayMs(attempt + 1)),
        errorCode: "provider_retryable",
      });
      summary.rescheduled += 1;
      continue;
    }
    await finish({
      status: "FAILED",
      retryCount: attempt,
      failedAtUtc: new Date(),
      errorCode: outcome.retryable ? "retry_budget_exhausted" : "provider_refused",
      nextAttemptAtUtc: null,
    });
    summary.failed += 1;
  }
  return summary;
}
