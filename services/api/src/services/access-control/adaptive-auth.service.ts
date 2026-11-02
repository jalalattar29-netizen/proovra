/**
 * Phase 26.5 — Adaptive auth engine.
 *
 * Decides whether a sensitive action proceeds, requires a step-up
 * challenge, requires a full re-authentication, or is blocked. Pure
 * orchestration over:
 *   - the current session's risk score (Phase 26.5 detector)
 *   - the workspace governance policy flags (Phase 25.5)
 *   - the user's trusted-device status (Phase 19)
 *   - the canonical step-up middleware (Phase 19 / 25.5)
 *
 * Hard rules:
 *   - The decision is computed via the pure shared `evaluateAdaptiveAuth`
 *     helper. The engine just gathers inputs + dispatches the outcome.
 *   - When the decision is REQUIRE_STEP_UP, the engine returns the
 *     canonical purpose; the route layer is responsible for invoking
 *     `requireStepUpForSensitiveAction` with that purpose.
 *   - When the decision is REQUIRE_REAUTH, the engine writes a
 *     RevokedSession entry for the current session so the user is
 *     forced back through `/auth` on the next request.
 *   - When the decision is BLOCK, the engine writes a security event
 *     + bumps the block counter; the route layer surfaces a 403.
 */

import type { PrismaClient } from "@prisma/client";
import {
  evaluateAdaptiveAuth,
  type AdaptiveAuthDecision,
  type AdaptiveAuthInput,
  type AdaptiveAuthResult,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { bump } from "../ops/metrics.service.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { revokeSession } from "../identity-security/session-revocation.service.js";

// -----------------------------------------------------------------------------
// Decide
// -----------------------------------------------------------------------------

export type AdaptiveDecideInput = {
  teamId: string;
  userId: string;
  sessionId: string;
  highPrivilegeAction: boolean;
  workspaceRequiresStepUp: boolean;
};

export type AdaptiveDecideResult = AdaptiveAuthResult & {
  riskScore: number;
  trustedDevice: boolean;
  sessionId: string;
};

export async function decideAdaptiveAuth(
  input: AdaptiveDecideInput,
  client: PrismaClient = defaultPrisma,
): Promise<AdaptiveDecideResult> {
  const session = await client.authenticatedSession.findFirst({
    where: { id: input.sessionId, userId: input.userId },
    select: {
      id: true,
      userId: true,
      sessionIdHash: true,
      issuedAtUtc: true,
      riskScore: true,
      deviceIdHash: true,
      revokedAtUtc: true,
    },
  });
  if (!session) {
    return {
      decision: "BLOCK" as AdaptiveAuthDecision,
      reason: "session_not_found",
      riskScore: 100,
      trustedDevice: false,
      sessionId: input.sessionId,
    };
  }
  if (session.revokedAtUtc) {
    return {
      decision: "REQUIRE_REAUTH",
      reason: "session_already_revoked",
      riskScore: 100,
      trustedDevice: false,
      sessionId: input.sessionId,
    };
  }

  let trustedDevice = false;
  if (session.deviceIdHash) {
    const trusted = await client.trustedDevice.findFirst({
      where: {
        teamId: input.teamId,
        userId: input.userId,
        deviceIdHash: session.deviceIdHash,
        status: "ACTIVE",
        trustedUntilUtc: { gt: new Date() },
      },
      select: { id: true },
    });
    trustedDevice = !!trusted;
  }

  const sharedInput: AdaptiveAuthInput = {
    riskScore: session.riskScore ?? 0,
    trustedDevice,
    highPrivilegeAction: input.highPrivilegeAction,
    workspaceRequiresStepUp: input.workspaceRequiresStepUp,
    sessionIssuedAtMs: session.issuedAtUtc.getTime(),
  };
  const decision = evaluateAdaptiveAuth(sharedInput);

  // Force the session out — JWT middleware rejects on next request. Revoked by
  // the hash tokens are checked against (IDENT-019): the session's row id is a
  // value no token carries, so this used to revoke nothing. The caller answers
  // this request either way, so a failed write here is not a new refusal.
  const forceSessionOut = async () => {
    try {
      await revokeSession(
        {
          teamId: input.teamId,
          userId: input.userId,
          sessionIdHash: session.sessionIdHash,
          reason: "SUSPICIOUS_ACTIVITY",
          actorUserId: null,
          ipAddress: null,
          userAgent: null,
        },
        client,
      );
    } catch {
      /* best-effort */
    }
  };

  // Side-effects per decision.
  switch (decision.decision) {
    case "REQUIRE_STEP_UP": {
      bump("adaptive_step_up_total");
      safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "adaptive_step_up_triggered",
        severity: "INFO",
        details: {
          sessionId: input.sessionId,
          subjectUserId: input.userId,
          reason: decision.reason,
          purpose: decision.stepUpPurpose,
          riskScore: sharedInput.riskScore,
        },
      });
      break;
    }
    case "REQUIRE_REAUTH": {
      bump("forced_reauth_total");
      await forceSessionOut();
      safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "forced_reauthentication",
        severity: "WARNING",
        details: {
          sessionId: input.sessionId,
          subjectUserId: input.userId,
          reason: decision.reason,
          riskScore: sharedInput.riskScore,
        },
      });
      break;
    }
    case "BLOCK": {
      bump("adaptive_block_total");
      await forceSessionOut();
      safeEmitSecurityEvent({
        teamId: input.teamId,
        eventType: "adaptive_block_triggered",
        severity: "HIGH",
        details: {
          sessionId: input.sessionId,
          subjectUserId: input.userId,
          reason: decision.reason,
          riskScore: sharedInput.riskScore,
        },
      });
      break;
    }
    default:
      // ALLOW — no side-effects.
      break;
  }

  return {
    ...decision,
    riskScore: sharedInput.riskScore,
    trustedDevice,
    sessionId: input.sessionId,
  };
}

export { evaluateAdaptiveAuth };
