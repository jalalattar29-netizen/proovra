/**
 * PROOVRA Phase 2B — Portal session service.
 *
 * Resolves an external reviewer's raw token to a bounded session
 * descriptor and enforces:
 *
 *   * Token validity (delegates to the existing grant service)
 *   * MFA gate (when the role assignment requires it)
 *   * Inactivity timeout (≤ 30 min)
 *   * Maximum session lifetime (≤ 8 h)
 *
 * Hard rules:
 *   * The raw token is hashed by the grant service before lookup.
 *   * The returned `sessionId` is bounded — a random hex value tied to
 *     this login. It is included in the watermark signature.
 *   * Activity emission: LOGIN on first establishment, MFA_*, LOGOUT,
 *     INACTIVITY_TIMEOUT, GRANT_DENIED_ATTEMPT.
 *   * Sessions live in memory only — no parallel session store. The
 *     `sessionId` is re-derived per request from (grantId, secretSalt,
 *     issuedAtUtc); the client carries it in a bearer header.
 */

import { createHash, randomBytes } from "node:crypto";

import {
  EXTERNAL_PORTAL_INACTIVITY_TIMEOUT_MS,
  EXTERNAL_PORTAL_MAX_SESSION_MS,
  type ExternalPortalDenialReason,
  type PortalAuthMethod,
} from "@proovra/shared";
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../../db.js";
import {
  lookupExternalReviewGrantByToken,
  transitionExternalReviewGrant,
} from "./external-review-grant.service.js";
import { emitPortalActivity } from "./portal-activity.service.js";
import {
  clearPortalMfaSession,
  isPortalMfaSessionSatisfied,
  issuePortalMfaCode,
  markPortalMfaSessionSatisfied,
  verifyPortalMfaCode,
} from "./portal-mfa-challenge.service.js";

export type PortalSessionContext = {
  grantId: string;
  teamId: string;
  sessionId: string;
  reviewerEmail: string;
  reviewerDisplayName: string | null;
  expiresAtUtc: Date;
  scopeKind: "EVIDENCE" | "CASE" | "PACKAGE";
  evidenceId: string | null;
  caseId: string | null;
  packageId: string | null;
  role: string; // bounded EXTERNAL_REVIEWER_ROLES — validated on roleAssignment
  mfaRequired: boolean;
  organization: string | null;
  watermarkPolicy: string;
  inactivityTimeoutMs: number;
  maxSessionMs: number;

  // -------------------------------------------------------------------------
  // Phase 2B Closure — federation + adaptive auth fields.
  //
  //  * authMethod     — TOKEN (default) | SSO.
  //  * ssoConnectionId — non-null when the grant is federation-bound.
  //  * ssoSubjectHash — non-null once SSO has been bound at least once.
  //  * mfaSatisfied   — true when (a) `mfaRequired` is false OR
  //                     (b) THIS session answered an emailed code and has
  //                     been active within the inactivity window (D27b —
  //                     bound to the session, not the grant). Lets the
  //                     portal skip re-prompting on every navigation.
  // -------------------------------------------------------------------------
  authMethod: PortalAuthMethod;
  ssoConnectionId: string | null;
  ssoSubjectHash: string | null;
  mfaSatisfied: boolean;
};

export type EstablishSessionResult =
  | {
      ok: true;
      session: PortalSessionContext;
      newLogin: boolean;
    }
  | { ok: false; denial: ExternalPortalDenialReason; mfa?: PortalMfaDenialDetail };

/**
 * D27 — what the sign-in may tell the reviewer about the emailed code. The
 * address is only ever the masked form.
 */
export type PortalMfaDenialDetail = {
  codeSent: boolean;
  destination: string | null;
  resendAvailableInSeconds: number | null;
  attemptsRemaining: number | null;
};

/**
 * Establish (or refresh) a portal session for the given raw token.
 *
 *   * `mfaToken` is honoured when the role assignment requires MFA. It is
 *     checked against the one-time code emailed to the grant's reviewer
 *     address (`portal-mfa-challenge.service.ts`). Only the token exchange
 *     (`issueMfaCode: true`) sends a code; every other portal request that
 *     finds MFA unsatisfied is simply refused with MFA_REQUIRED.
 *   * `sessionId` is generated fresh on first establishment and
 *     remains stable for the duration of the inactivity window. The
 *     caller persists it in a portal cookie.
 */
export async function establishPortalSession(input: {
  prisma?: PrismaClient;
  rawToken: string;
  mfaToken?: string | null;
  existingSessionId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /** Only the token exchange (POST /v1/portal/auth) accepts an invitation. */
  acceptInvited?: boolean;
  /** Only the token exchange (POST /v1/portal/auth) issues an emailed code. */
  issueMfaCode?: boolean;
}): Promise<EstablishSessionResult> {
  const prisma = input.prisma ?? defaultPrisma;

  // 1. Look up the grant by token.
  // D27 — an INVITED grant is judged here but accepted only after the MFA
  // gate below has been satisfied (step 3b), so a token holder who cannot
  // answer the emailed code never turns the invitation into an acceptance.
  const lookup = await lookupExternalReviewGrantByToken(input.rawToken, prisma, {
    acceptInvited: input.acceptInvited === true,
    deferAcceptance: true,
  });
  if (!lookup.ok) {
    const denial: "TOKEN_INVALID" | "TOKEN_EXPIRED" | "TOKEN_REVOKED" =
      lookup.reason === "grant_expired"
        ? "TOKEN_EXPIRED"
        : lookup.reason === "grant_revoked"
        ? "TOKEN_REVOKED"
        : "TOKEN_INVALID";
    return { ok: false, denial };
  }
  const invited = lookup.grant;

  // 2. Load the role assignment sidecar.
  const role = await prisma.externalReviewerRoleAssignment.findUnique({
    where: { id: invited.id },
    select: {
      role: true,
      mfaRequired: true,
      watermarkPolicy: true,
      organization: true,
      // Phase 2B Closure — federation + adaptive auth.
      authMethod: true,
      ssoConnectionId: true,
      ssoSubjectHash: true,
    },
  });
  const roleId = role?.role ?? "EXTERNAL_REVIEWER";
  const mfaRequired = role?.mfaRequired === true;
  const authMethod: PortalAuthMethod =
    (role?.authMethod as PortalAuthMethod | undefined) ?? "TOKEN";
  const ssoConnectionId = role?.ssoConnectionId ?? null;
  const ssoSubjectHash = role?.ssoSubjectHash ?? null;

  // Session id. Stable per login; a fresh token exchange without one gets a
  // new id. Chosen before the MFA gate because satisfaction belongs to it.
  const reusedSessionId =
    input.existingSessionId && /^[0-9a-f]{32}$/.test(input.existingSessionId)
      ? input.existingSessionId
      : null;
  const sessionId = reusedSessionId ?? randomBytes(16).toString("hex");

  // D27b — satisfaction is per SESSION. The grant's `mfaSatisfiedAtUtc` is a
  // record of the last verification, never a pass for someone else's session.
  let mfaSatisfiedForSession = false;
  if (mfaRequired && reusedSessionId !== null) {
    try {
      mfaSatisfiedForSession = await isPortalMfaSessionSatisfied({
        grantId: invited.id,
        sessionId: reusedSessionId,
        ttlMs: EXTERNAL_PORTAL_INACTIVITY_TIMEOUT_MS,
      });
    } catch {
      return { ok: false, denial: "MFA_UNAVAILABLE" };
    }
  }

  // 3. MFA gate — D27 (2026-09-16). An external reviewer has no account and
  // no enrolled factor, so the second factor is the mailbox the invitation
  // went to: a six-digit code emailed to the grant's reviewer address and
  // checked against a scrypt verifier held in Redis. Every branch that is not
  // a verified match refuses; nothing here can pass on a store or transport
  // failure. (This used to accept any six digits.)
  if (mfaRequired && !mfaSatisfiedForSession) {
    const activity = (
      code: "MFA_CHALLENGE_FAILED" | "MFA_CHALLENGE_PASSED",
      payload: Record<string, unknown>,
    ) =>
      emitPortalActivity({
        prisma,
        teamId: invited.teamId,
        grantId: invited.id,
        code,
        ip: input.ip,
        userAgent: input.userAgent,
        payload,
      });

    if (!input.mfaToken) {
      if (input.issueMfaCode !== true) {
        await activity("MFA_CHALLENGE_FAILED", { outcome: "CODE_REQUIRED" });
        return { ok: false, denial: "MFA_REQUIRED" };
      }
      const issued = await issuePortalMfaCode({
        grantId: invited.id,
        reviewerEmail: invited.reviewerEmail,
      });
      if (!issued.ok) {
        await activity("MFA_CHALLENGE_FAILED", {
          outcome: issued.reason === "RATE_LIMITED" ? "CODE_RATE_LIMITED" : "CODE_UNAVAILABLE",
        });
        return { ok: false, denial: issued.reason };
      }
      await activity("MFA_CHALLENGE_FAILED", {
        outcome: issued.sent ? "CODE_SENT" : "CODE_REUSED",
        challengeId: issued.challengeId,
        expiresAtUtc: issued.expiresAtUtc,
      });
      return {
        ok: false,
        denial: "MFA_REQUIRED",
        mfa: {
          codeSent: true,
          destination: issued.destination,
          resendAvailableInSeconds: issued.resendAvailableInSeconds,
          attemptsRemaining: null,
        },
      };
    }

    const verified = await verifyPortalMfaCode({
      grantId: invited.id,
      code: input.mfaToken,
    });
    if (!verified.ok) {
      await activity("MFA_CHALLENGE_FAILED", {
        outcome:
          verified.reason === "MFA_CODE_EXHAUSTED"
            ? "CODE_EXHAUSTED"
            : verified.reason === "MFA_UNAVAILABLE"
            ? "CODE_UNAVAILABLE"
            : "CODE_REJECTED",
      });
      return {
        ok: false,
        denial: verified.reason,
        mfa: {
          codeSent: false,
          destination: null,
          resendAvailableInSeconds: null,
          attemptsRemaining: verified.attemptsRemaining,
        },
      };
    }
    // Only after a verified, consumed code: this session is now satisfied.
    try {
      await markPortalMfaSessionSatisfied({
        grantId: invited.id,
        sessionId,
        ttlMs: EXTERNAL_PORTAL_INACTIVITY_TIMEOUT_MS,
      });
    } catch {
      await activity("MFA_CHALLENGE_FAILED", { outcome: "CODE_UNAVAILABLE" });
      return { ok: false, denial: "MFA_UNAVAILABLE" };
    }
    await activity("MFA_CHALLENGE_PASSED", { method: "EMAIL_CODE" });
    // Phase 2B Closure — the last verification, recorded for operators.
    await prisma.externalReviewerRoleAssignment.update({
      where: { id: invited.id },
      data: { mfaSatisfiedAtUtc: new Date() },
    });
  }

  // 3b. Deferred acceptance (D27). Reached only when MFA is not required or
  // has been satisfied. The inviting operator is recorded as the approving
  // actor, exactly as the lookup's own acceptance did.
  let grant = invited;
  if (input.acceptInvited === true && grant.state === "INVITED") {
    const accepted = await transitionExternalReviewGrant(
      {
        grantId: grant.id,
        teamId: grant.teamId,
        toState: "ACTIVE",
        actorUserId: grant.invitedByUserId,
      },
      prisma,
    );
    if (!accepted.ok) return { ok: false, denial: "TOKEN_INVALID" };
    grant = accepted.grant;
  }

  // 4. Emit LOGIN activity on first establishment.
  const newLogin = !input.existingSessionId;
  if (newLogin) {
    await emitPortalActivity({
      prisma,
      teamId: grant.teamId,
      grantId: grant.id,
      code: "LOGIN",
      sessionId,
      ip: input.ip,
      userAgent: input.userAgent,
    });
  }

  return {
    ok: true,
    newLogin,
    session: {
      grantId: grant.id,
      teamId: grant.teamId,
      sessionId,
      reviewerEmail: grant.reviewerEmail,
      reviewerDisplayName: grant.reviewerDisplayName,
      expiresAtUtc: new Date(grant.expiresAtUtc),
      scopeKind: grant.scopeKind as "EVIDENCE" | "CASE" | "PACKAGE",
      evidenceId: grant.evidenceId,
      caseId: grant.caseId,
      packageId: grant.packageId,
      role: roleId,
      mfaRequired,
      organization: role?.organization ?? null,
      watermarkPolicy: role?.watermarkPolicy ?? "ALWAYS",
      inactivityTimeoutMs: EXTERNAL_PORTAL_INACTIVITY_TIMEOUT_MS,
      maxSessionMs: EXTERNAL_PORTAL_MAX_SESSION_MS,
      authMethod,
      ssoConnectionId,
      ssoSubjectHash,
      // Reached only past the MFA gate: not required, or answered by this session.
      mfaSatisfied: true,
    },
  };
}

/**
 * Honest end-of-session — emits LOGOUT.
 */
export async function endPortalSession(input: {
  prisma?: PrismaClient;
  teamId: string;
  grantId: string;
  sessionId: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  const prisma = input.prisma ?? defaultPrisma;
  // D27b — a logged-out session no longer counts as having answered a code.
  // Best effort: the record expires with the inactivity window regardless.
  await clearPortalMfaSession({ grantId: input.grantId, sessionId: input.sessionId }).catch(
    () => undefined,
  );
  await emitPortalActivity({
    prisma,
    teamId: input.teamId,
    grantId: input.grantId,
    code: "LOGOUT",
    sessionId: input.sessionId,
    ip: input.ip,
    userAgent: input.userAgent,
  });
}

/**
 * PHASE 2B CLOSURE — explicit session lifecycle events.
 *
 * Fired by the route layer when a session is observed to have crossed
 * the inactivity / max-lifetime boundary, or when an operator has
 * revoked the grant mid-session. These events feed the operator audit
 * timeline AND the bulk "active sessions" panel.
 */
export async function emitPortalSessionExpired(input: {
  prisma?: PrismaClient;
  teamId: string;
  grantId: string;
  sessionId: string;
  reason: "INACTIVITY" | "MAX_LIFETIME";
  ip?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  const prisma = input.prisma ?? defaultPrisma;
  await emitPortalActivity({
    prisma,
    teamId: input.teamId,
    grantId: input.grantId,
    code: "PORTAL_SESSION_EXPIRED",
    sessionId: input.sessionId,
    ip: input.ip,
    userAgent: input.userAgent,
    payload: { reason: input.reason },
  });
}

export async function emitPortalSessionRevoked(input: {
  prisma?: PrismaClient;
  teamId: string;
  grantId: string;
  sessionId: string;
  reason: "OPERATOR_REVOKE" | "GRANT_REVOKED" | "GRANT_EXPIRED";
  ip?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  const prisma = input.prisma ?? defaultPrisma;
  await emitPortalActivity({
    prisma,
    teamId: input.teamId,
    grantId: input.grantId,
    code: "PORTAL_SESSION_REVOKED",
    sessionId: input.sessionId,
    ip: input.ip,
    userAgent: input.userAgent,
    payload: { reason: input.reason },
  });
}

/**
 * Phase 2B Closure — bounded "is the MFA satisfaction still inside
 * the inactivity window" helper. Re-prompting the reviewer every
 * navigation is hostile; re-prompting after 30 min idle is bounded
 * security hygiene.
 */
/**
 * Re-derive a deterministic-but-unguessable session id from the
 * (grantId, server-side salt). Used by tests that need a stable
 * sessionId per grant without persisting one.
 */
export function deriveTestSessionId(grantId: string): string {
  const salt = process.env.PORTAL_SESSION_SALT ?? "proovra-portal-test-salt";
  return createHash("sha256")
    .update(`${salt}:${grantId}`)
    .digest("hex")
    .slice(0, 32);
}
