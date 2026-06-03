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
import { riskBlocksAction, } from "@proovra/shared";
import { prisma as defaultPrisma } from "../../db.js";
import { safeEmitSecurityEvent } from "../security/security-event.service.js";
import { StepUpError, consumeApprovedChallenge, } from "./step-up.service.js";
import { getRiskSnapshotForUser } from "./risk.service.js";
const STEP_UP_HEADER = "x-proovra-step-up-challenge-id";
/**
 * Returns { sent: false } on success — caller proceeds with the
 * mutation. Returns { sent: true } when the response has already
 * been sent (401/403); caller must early-return.
 */
export async function requireStepUpForSensitiveAction(input, client = defaultPrisma) {
    const headerValue = input.req.headers[STEP_UP_HEADER];
    const challengeId = typeof headerValue === "string"
        ? headerValue.trim()
        : Array.isArray(headerValue) && headerValue[0]
            ? String(headerValue[0]).trim()
            : "";
    if (!challengeId) {
        safeEmitSecurityEvent({
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
        }, client);
        input.reply.code(401).send({
            error: {
                code: "STEP_UP_REQUIRED",
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
        const risk = await getRiskSnapshotForUser({ teamId: input.teamId, userId: input.userId }, client);
        if (riskBlocksAction(risk.level)) {
            safeEmitSecurityEvent({
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
            }, client);
            input.reply.code(403).send({
                error: {
                    code: "HIGH_RISK_ACTION_BLOCKED",
                    message: "Access restricted. Contact a workspace administrator.",
                },
            });
            return { sent: true };
        }
    }
    catch {
        // Fail closed for sensitive actions on risk-evaluator outage.
        safeEmitSecurityEvent({
            teamId: input.teamId,
            eventType: "high_risk_action_blocked",
            severity: "WARNING",
            details: {
                actorUserId: input.userId,
                purpose: input.purpose,
                reason: "risk_evaluator_unavailable",
            },
        }, client);
        input.reply.code(503).send({
            error: { code: "RISK_EVALUATION_UNAVAILABLE" },
        });
        return { sent: true };
    }
    try {
        await consumeApprovedChallenge({
            teamId: input.teamId,
            userId: input.userId,
            challengeId,
            purpose: input.purpose,
            resourceKind: input.resourceKind ?? null,
            resourceId: input.resourceId ?? null,
        }, client);
        return { sent: false };
    }
    catch (err) {
        if (err instanceof StepUpError) {
            safeEmitSecurityEvent({
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
            }, client);
            input.reply.code(401).send({
                error: {
                    code: "STEP_UP_REQUIRED",
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
