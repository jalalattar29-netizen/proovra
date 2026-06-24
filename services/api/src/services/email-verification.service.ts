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

import { prisma } from "../db.js";
import { getEmailService } from "./email.service.js";
import {
  createEmailVerificationToken,
  consumeEmailVerificationToken,
  findUnverifiedEmailUserByEmail,
  type ConsumeEmailVerificationTokenResult,
} from "./email-password-auth.service.js";

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

function buildVerifyUrl(rawToken: string): string {
  return `${getWebBase()}/auth/verify-email?token=${encodeURIComponent(rawToken)}`;
}

export type DispatchVerificationOutcome = {
  /** True when Resend accepted the email send. False = send failed; the
   *  token still exists in the DB so a Resend retry can succeed. */
  delivered: boolean;
  /** Only populated when delivered === false. Surface this to the audit
   *  log; do NOT leak to the client. */
  error?: string;
};

/**
 * Create a fresh verification token for `userId`, build the verify URL,
 * and ask the email service to deliver it. Failure is non-fatal — the
 * token row is already persisted, so the resend endpoint can retry.
 */
export async function dispatchVerificationEmail(params: {
  userId: string;
  toEmail: string;
}): Promise<DispatchVerificationOutcome> {
  const { userId, toEmail } = params;

  const { rawToken } = await createEmailVerificationToken(userId);
  const verifyUrl = buildVerifyUrl(rawToken);

  try {
    const emailService = getEmailService();
    await emailService.sendEmailVerificationEmail(toEmail, verifyUrl);
    return { delivered: true };
  } catch (err) {
    return {
      delivered: false,
      error: (err as Error)?.message ?? String(err),
    };
  }
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

/** Full resend pipeline: lookup unverified user → cooldown check →
 *  token + email. Returns a single audit-event spec the route emits. */
export async function processResendVerification(
  emailRaw: string,
): Promise<ResendAuditSpec> {
  const target = await findUnverifiedEmailUserByEmail(emailRaw);
  if (!target) {
    return { userId: null, outcome: "blocked", severity: "info", reason: "no_unverified_user" };
  }

  const latest = await prisma.emailVerificationToken.findFirst({
    where: { userId: target.id, usedAt: null },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (
    latest &&
    Date.now() - latest.createdAt.getTime() < EMAIL_VERIFICATION_RESEND_COOLDOWN_MS
  ) {
    return { userId: target.id, outcome: "blocked", severity: "info", reason: "cooldown" };
  }

  const dispatch = await dispatchVerificationEmail({
    userId: target.id,
    toEmail: target.email ?? emailRaw,
  });
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
): Promise<ConsumeEmailVerificationTokenResult> {
  return consumeEmailVerificationToken(rawToken);
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
