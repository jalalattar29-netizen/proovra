/**
 * Phase 19 — `requireStepUpForSensitiveAction` middleware helper.
 *
 * One reusable helper that every sensitive route calls AFTER its
 * permission check but BEFORE its mutation. Returns null on success;
 * on failure it writes a structured response and returns the response
 * so the route can early-return.
 *
 * Failure modes:
 *   - missing `x-proovra-step-up-challenge-id` header -> 401
 *     STEP_UP_REQUIRED (frontend can start a challenge and retry).
 *   - challenge not found / expired / wrong purpose / wrong resource
 *     -> 401 STEP_UP_REQUIRED.
 *   - challenge OK but current risk level is CRITICAL -> 403
 *     HIGH_RISK_ACTION_BLOCKED.
 *
 * Hard invariants:
 *   - The challenge is consumed (single-use) inside this helper.
 *     The caller MUST proceed with the mutation in the same request.
 *   - The risk level is read AFTER consumption — so risk that arrived
 *     between challenge approval and action still blocks. The order
 *     is: consume -> read risk -> proceed or block.
 *   - Critical risk fires `high_risk_action_blocked` SecurityEvent;
 *     step-up-required fires `high_risk_action_step_up_required`.
 *   - Errors never leak the OTP code, raw phone, or session token.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import {
  type StepUpPurpose,
  riskBlocksAction,
} from "@proovra/shared";

import { prisma as defaultPrisma } from "../../db.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import {
  StepUpError,
  consumeApprovedChallenge,
} from "./step-up.service.js";
import { getRiskSnapshotForUser } from "./risk.service.js";

const STEP_UP_HEADER = "x-proovra-step-up-challenge-id";

export type RequireStepUpInput = {
  req: FastifyRequest;
  reply: FastifyReply;
  teamId: string;
  userId: string;
  purpose: StepUpPurpose;
  resourceKind?: string | null;
  resourceId?: string | null;
};

export type RequireStepUpFailure = {
  sent: true;
};

export type RequireStepUpSuccess = {
  sent: false;
  /**
   * The SERVER-VERIFIED challenge id (consumed via `consumeApprovedChallenge`,
   * bound to actor + org + purpose). Callers that must record a strong-auth
   * proof reference (break-glass, high-security) use THIS, never a raw header.
   */
  verifiedChallengeId: string;
};

/**
 * Returns { sent: false } on success — caller proceeds with the
 * mutation. Returns { sent: true } when the response has already
 * been sent (401/403); caller must early-return.
 */
export async function requireStepUpForSensitiveAction(
  input: RequireStepUpInput,
  client: PrismaClient = defaultPrisma,
): Promise<RequireStepUpFailure | RequireStepUpSuccess> {
  const headerValue = input.req.headers[STEP_UP_HEADER];
  const challengeId =
    typeof headerValue === "string"
      ? headerValue.trim()
      : Array.isArray(headerValue) && headerValue[0]
        ? String(headerValue[0]).trim()
        : "";

  if (!challengeId) {
    safeEmitSecurityEvent(
      {
        teamId: input.teamId,
        eventType: "high_risk_action_step_up_required",
        severity: "INFO",
        details: {
          actorUserId: input.userId,
          purpose: input.purpose,
          resourceKind: input.resourceKind ?? null,
          resourceId: input.resourceId ?? null,
          reason: "no_challenge_header",
        },
      },
      client,
    );
    input.reply.code(401).send({
      error: {
        code: "STEP_UP_REQUIRED",
        // PHASE 12B CLUSTER 9 — `message` + `details` are REQUIRED for the
        // canonical client error normalizer (`apps/web/lib/api.ts`) to
        // recognise this body as a structured error. Without a `message` it
        // fell through to the status bucket and re-coded the response as
        // plain `UNAUTHORIZED`, so `useStepUpAction` never saw
        // STEP_UP_REQUIRED and the challenge modal never opened — the gate
        // read as "you are signed out" on every sensitive action.
        // The gate itself is unchanged: still 401, still unsatisfiable
        // without a verified challenge id.
        message: "Step-up verification required.",
        details: {
          purpose: input.purpose,
          resourceKind: input.resourceKind ?? null,
          resourceId: input.resourceId ?? null,
        },
        // Retained at the top level for pre-existing consumers.
        purpose: input.purpose,
        resourceKind: input.resourceKind ?? null,
        resourceId: input.resourceId ?? null,
      },
    });
    return { sent: true };
  }

  // Risk check FIRST so a CRITICAL actor never gets to consume an
  // approval. CRITICAL blocks the action entirely.
  try {
    const risk = await getRiskSnapshotForUser(
      { teamId: input.teamId, userId: input.userId },
      client,
    );
    if (riskBlocksAction(risk.level)) {
      safeEmitSecurityEvent(
        {
          teamId: input.teamId,
          eventType: "high_risk_action_blocked",
          severity: "HIGH",
          details: {
            actorUserId: input.userId,
            purpose: input.purpose,
            resourceKind: input.resourceKind ?? null,
            resourceId: input.resourceId ?? null,
            score: risk.score,
            level: risk.level,
          },
        },
        client,
      );
      input.reply.code(403).send({
        error: {
          code: "HIGH_RISK_ACTION_BLOCKED",
          message: "Access restricted. Contact a workspace administrator.",
        },
      });
      return { sent: true };
    }
  } catch {
    // Fail closed for sensitive actions on risk-evaluator outage.
    safeEmitSecurityEvent(
      {
        teamId: input.teamId,
        eventType: "high_risk_action_blocked",
        severity: "WARNING",
        details: {
          actorUserId: input.userId,
          purpose: input.purpose,
          reason: "risk_evaluator_unavailable",
        },
      },
      client,
    );
    input.reply.code(503).send({
      error: { code: "RISK_EVALUATION_UNAVAILABLE" },
    });
    return { sent: true };
  }

  try {
    await consumeApprovedChallenge(
      {
        teamId: input.teamId,
        userId: input.userId,
        challengeId,
        purpose: input.purpose,
        resourceKind: input.resourceKind ?? null,
        resourceId: input.resourceId ?? null,
        // PHASE 12B B3 — the session spending the elevation. Read from the
        // AUTHENTICATED request (never a body/header field the caller controls),
        // so a challenge approved in one session cannot be replayed from
        // another. `req.user.sessionIdHash` is the same canonical value the
        // session-revocation store keys on.
        sessionIdHash:
          (input.req as { user?: { sessionIdHash?: string | null } }).user
            ?.sessionIdHash ?? null,
      },
      client,
    );
    return { sent: false, verifiedChallengeId: challengeId };
  } catch (err) {
    if (err instanceof StepUpError) {
      safeEmitSecurityEvent(
        {
          teamId: input.teamId,
          eventType: "high_risk_action_step_up_required",
          severity: "INFO",
          details: {
            actorUserId: input.userId,
            purpose: input.purpose,
            resourceKind: input.resourceKind ?? null,
            resourceId: input.resourceId ?? null,
            reason: err.code,
          },
        },
        client,
      );
      input.reply.code(401).send({
        error: {
          code: "STEP_UP_REQUIRED",
          // Same normalizer contract as the no-header branch above.
          message: "Step-up verification required.",
          details: {
            purpose: input.purpose,
            resourceKind: input.resourceKind ?? null,
            resourceId: input.resourceId ?? null,
          },
          purpose: input.purpose,
          resourceKind: input.resourceKind ?? null,
          resourceId: input.resourceId ?? null,
        },
      });
      return { sent: true };
    }
    throw err;
  }
}
