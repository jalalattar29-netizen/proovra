/**
 * Account-level step-up re-authentication (2026-07-16).
 *
 * ONE canonical recent-auth verifier for SENSITIVE PERSONAL-ACCOUNT
 * mutations (MFA factor removal, recovery-code regeneration, revoke-other-
 * sessions). These are ACCOUNT-tier actions available to every plan and
 * every login provider, so the enterprise workspace step-up (SMS/WhatsApp
 * OTP, team-scoped `StepUpChallenge`) is NOT reused here — a Free personal
 * user has no team and no verified phone. Instead the smallest secure
 * model already supported by the codebase applies, in priority order:
 *
 *   1. `method: "password"` — current-password verification
 *      (`verifyPassword` against the stored hash). Password accounts.
 *   2. `method: "mfa"` — a valid CURRENT TOTP code from an ACTIVE factor
 *      (`verifyActiveTotp`). MFA-enabled accounts (any provider).
 *   3. RECENT-AUTH fallback — OAuth-only accounts with NO password and NO
 *      active factor have nothing to re-verify in-app (no OAuth re-auth
 *      flow exists in the codebase, and we do not invent one). For them
 *      the CURRENT AuthenticatedSession must have been issued within
 *      RECENT_AUTH_WINDOW_MS; otherwise the client is told to sign in
 *      again (a fresh Google/Apple sign-in mints a fresh session row).
 *
 * Enforcement properties:
 *   - backend-enforced (never a frontend boolean)
 *   - user-bound (verifies THIS caller's password / factor / session)
 *   - session-bound for the recent-auth path (req.sessionIdHash)
 *   - action-scoped + single-request (proof travels in the mutation body
 *     and is verified inline; nothing reusable is issued)
 *   - no secrets in URLs (proof is read from the JSON body only)
 *   - rate-limited per user+action
 *   - audited via SecurityEvent on denial and on success
 */

import type { FastifyReply, FastifyRequest } from "fastify";

import { getAuthSessionId } from "../../auth.js";
import { prisma } from "../../db.js";
import { verifyPassword } from "../email-password-auth.service.js";
import { verifyActiveTotp } from "../security/mfa.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";

/** OAuth-only recent-auth window — 10 minutes. */
export const RECENT_AUTH_WINDOW_MS = 10 * 60 * 1000;

// Bounded in-memory rate limit: 5 proof attempts / 60s per user+action.
// Mirrors the enrollment-verify limiter in mfa.routes.ts (process-local by
// design there as well).
const ATTEMPT_WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 5;
const attempts = new Map<string, { count: number; windowStart: number }>();

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now - entry.windowStart > ATTEMPT_WINDOW_MS) {
    attempts.set(key, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_ATTEMPTS;
}

export type AccountStepUpProof = {
  method?: "password" | "mfa";
  currentPassword?: string;
  code?: string;
};

export type AccountStepUpAction =
  | "mfa_factor_remove"
  | "mfa_recovery_codes_regenerate"
  | "sessions_revoke_others"
  // Settings remediation (2026-07-17) — revoke ONE of the caller's own
  // other sessions from the session inventory.
  | "session_revoke"
  // Lifecycle Phase 3 — connected accounts / login methods.
  | "login_method_link"
  | "login_method_unlink"
  | "password_add"
  // Lifecycle Phase 4 — personal account data export.
  | "data_export_request"
  | "data_export_download"
  | "account_closure_request"
  // Lifecycle Phase 6 — organization ownership transfer + closure. Org
  // authorization (ORG_OWNER) is enforced separately by the route; the
  // step-up here proves the OWNER'S OWN recent authentication.
  | "org_ownership_transfer"
  | "org_closure_request"
  // Lifecycle Phase 7 — workspace closure (workspace-owner-only route;
  // step-up proves the owner's own recent authentication).
  | "workspace_closure_request"
  // PHASE 4 §7.4 (2026-07-22) — OWNED-workspace ownership transfer
  // (workspace-owner-only route; step-up proves the owner's own recent
  // authentication).
  | "workspace_ownership_transfer";

type StepUpDenial = {
  status: 401 | 429;
  body: {
    error: {
      code: "STEP_UP_REQUIRED" | "STEP_UP_INVALID" | "rate_limited";
      /** Which proof methods THIS account can use right now. */
      methods: Array<"password" | "mfa" | "reauth">;
      message: string;
    };
  };
};

/**
 * Verify step-up proof for a sensitive account action. Returns
 * `{ ok: true }` when the caller proved recent authentication; otherwise
 * sends nothing and returns the structured denial for the route to send.
 * The route MUST perform the mutation only on `{ ok: true }`.
 */
export async function verifyAccountStepUp(input: {
  req: FastifyRequest;
  reply: FastifyReply;
  userId: string;
  action: AccountStepUpAction;
  proof: AccountStepUpProof | null | undefined;
}): Promise<{ ok: true } | { ok: false; denial: StepUpDenial }> {
  const { userId, action } = input;
  const proof = input.proof ?? {};

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, passwordHash: true },
  });
  const activeFactor = await prisma.mfaFactor.findFirst({
    where: { userId, status: "ACTIVE" },
    select: { id: true },
  });

  const methods: Array<"password" | "mfa" | "reauth"> = [];
  if (user?.passwordHash) methods.push("password");
  if (activeFactor) methods.push("mfa");
  if (methods.length === 0) methods.push("reauth");

  const deny = (
    code: "STEP_UP_REQUIRED" | "STEP_UP_INVALID" | "rate_limited",
    status: 401 | 429,
    message: string,
  ): { ok: false; denial: StepUpDenial } => {
    safeEmitSecurityEvent({
      teamId: null,
      eventType: "step_up_denied",
      severity: "WARNING",
      details: { actorUserId: userId, action, reason: code },
    });
    return { ok: false, denial: { status, body: { error: { code, methods, message } } } };
  };

  // Proof supplied — verify it. Attempts are rate-limited BEFORE any
  // cryptographic comparison.
  if (proof.method === "password" || proof.method === "mfa") {
    if (isRateLimited(`account-stepup:${userId}:${action}`)) {
      return deny(
        "rate_limited",
        429,
        "Too many verification attempts. Wait a minute and try again.",
      );
    }
    if (proof.method === "password") {
      if (!user?.passwordHash) {
        return deny("STEP_UP_INVALID", 401, "This account has no password to verify.");
      }
      const okPw =
        typeof proof.currentPassword === "string" &&
        proof.currentPassword.length > 0 &&
        verifyPassword(proof.currentPassword, user.passwordHash);
      if (!okPw) {
        return deny("STEP_UP_INVALID", 401, "The current password is incorrect.");
      }
    } else {
      const code = (proof.code ?? "").trim();
      if (!activeFactor || code.length < 6) {
        return deny("STEP_UP_INVALID", 401, "A valid authenticator code is required.");
      }
      const verdict = await verifyActiveTotp({ userId, code });
      if (!verdict.ok) {
        return deny("STEP_UP_INVALID", 401, "That code didn't match. Try again.");
      }
    }
    safeEmitSecurityEvent({
      teamId: null,
      eventType: "step_up_approved",
      severity: "INFO",
      details: { actorUserId: userId, action, method: proof.method },
    });
    return { ok: true };
  }

  // No proof supplied. OAuth-only accounts (no password, no factor) may
  // proceed on a RECENT current session; everyone else must supply proof.
  if (methods.length === 1 && methods[0] === "reauth") {
    /*
     * THE SESSION WAS NEVER LOOKED UP.
     *
     * This read `req.sessionIdHash`. `requireAuth` does not write that
     * property — it hashes the JWT's `sid` claim onto `req.user.sessionIdHash`,
     * and `getAuthSessionId` is the one accessor for it (the same one the
     * support-context token binding uses).
     *
     * So the value was ALWAYS undefined, the `AuthenticatedSession` lookup
     * below never ran, and every request from an OAuth-only account fell
     * through to "sign in again, then retry". Signing out and back in could
     * not help: no session, however fresh, was ever consulted. That is the
     * loop — "please re-authenticate" answered a re-authentication it had not
     * read.
     *
     * The policy is unchanged and still server-side: a LIVE, unrevoked
     * session belonging to THIS user, issued inside RECENT_AUTH_WINDOW_MS.
     * Only the field being read is corrected. `getAuthSessionId` throws when
     * the session is unresolved (a token with no `sid`), and that must deny
     * rather than pass — an unbindable request is exactly the case this gate
     * exists for.
     */
    let sessionIdHash: string | null = null;
    try {
      sessionIdHash = getAuthSessionId(input.req);
    } catch {
      sessionIdHash = null;
    }
    if (sessionIdHash) {
      const session = await prisma.authenticatedSession.findFirst({
        where: { userId, sessionIdHash, revokedAtUtc: null },
        select: { issuedAtUtc: true },
      });
      if (
        session &&
        Date.now() - session.issuedAtUtc.getTime() <= RECENT_AUTH_WINDOW_MS
      ) {
        safeEmitSecurityEvent({
          teamId: null,
          eventType: "step_up_approved",
          severity: "INFO",
          details: { actorUserId: userId, action, method: "recent_auth" },
        });
        return { ok: true };
      }
    }
    return deny(
      "STEP_UP_REQUIRED",
      401,
      "Please sign in again to confirm it's you, then retry this action.",
    );
  }

  return deny(
    "STEP_UP_REQUIRED",
    401,
    "Confirm it's you to continue with this security change.",
  );
}
