/**
 * PASSKEYS AND SECURITY KEYS (2026-10-28) — the account's own WebAuthn
 * factors, which answer the strongest rung of the step-up ladder.
 *
 * TENANT_SCOPE_EXCEPTION: account_tier_user_scoped
 * A passkey belongs to the ACCOUNT, not a workspace: every query is keyed by
 * the authenticated user id; no workspace dimension.
 *
 *   GET    /v1/identity-security/passkeys                       — list own
 *   POST   /v1/identity-security/passkeys/registration/options  — begin (step-up)
 *   POST   /v1/identity-security/passkeys/registration/verify   — bind
 *   DELETE /v1/identity-security/passkeys/:factorId             — revoke (step-up)
 *
 * WHY REGISTRATION NEEDS AN ACCOUNT STEP-UP. A passkey satisfies the strongest
 * workspace step-up (archiving a Collaboration Team, and anything else a
 * PHISHING_RESISTANT Organization gates). If a stolen session could bind the
 * attacker's own authenticator, it could then answer every one of those
 * challenges itself. So beginning a registration requires the same
 * account-tier re-authentication that removing a factor does (password, a
 * current authenticator code, or for OAuth-only accounts a recent sign-in),
 * and the ticket it returns is bound to that user and session. Removal needs
 * it too: stripping the holder's passkey is how an attacker would downgrade
 * the account to a factor it controls.
 *
 * Account-scoped, not workspace-scoped: a passkey belongs to the person and
 * serves every workspace they act in, exactly as an authenticator app does.
 * Every expected refusal is a bounded DomainError (never a Sentry incident);
 * the account step-up denial keeps the envelope its clients already parse.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { getAuthUserId } from "../auth.js";
import { AppError, ErrorCode } from "../errors.js";
import { requireAuth } from "../middleware/auth.js";
import {
  verifyAccountStepUp,
  type AccountStepUpProof,
} from "../services/identity-security/account-step-up.service.js";
import {
  PASSKEY_LABEL_MAX,
  beginPasskeyRegistration,
  completePasskeyRegistration,
  listOwnPasskeys,
  revokeOwnPasskey,
} from "../services/identity-security/passkey.service.js";
import { enforceRateLimit } from "../services/rate-limit.js";

const StepUpProofSchema = z
  .object({
    method: z.enum(["password", "mfa"]).optional(),
    currentPassword: z.string().max(1024).optional(),
    code: z.string().max(16).optional(),
  })
  .strict();

const OptionsBody = z.object({ stepUp: StepUpProofSchema.optional() }).strict();

const VerifyBody = z
  .object({
    ticket: z.string().min(16).max(2048),
    label: z.string().trim().min(1).max(PASSKEY_LABEL_MAX),
    response: z.record(z.string(), z.unknown()),
  })
  .strict();

const FactorParams = z.object({ factorId: z.string().uuid() });
const DeleteBody = z.object({ stepUp: StepUpProofSchema.optional() }).strict();

function sessionOf(req: FastifyRequest): string | null {
  return req.user?.sessionIdHash ?? null;
}

function requireUser(req: FastifyRequest): string {
  const userId = getAuthUserId(req);
  if (!userId) throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
  return userId;
}

async function rateLimited(reply: FastifyReply, key: string, max: number): Promise<boolean> {
  const rl = await enforceRateLimit({ key, max, windowSec: 600 });
  if (rl.allowed) return false;
  reply.code(429).send({
    error: { code: "rate_limited", message: "Too many attempts. Wait a few minutes and try again.", requestId: reply.request.id },
  });
  return true;
}

export async function passkeyRoutes(app: FastifyInstance) {
  app.get(
    "/v1/identity-security/passkeys",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = requireUser(req);
      const passkeys = await listOwnPasskeys(userId);
      return reply.code(200).send({ passkeys });
    },
  );

  app.post(
    "/v1/identity-security/passkeys/registration/options",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = requireUser(req);
      const body = OptionsBody.parse(req.body ?? {});
      const stepUp = await verifyAccountStepUp({
        req,
        reply,
        userId,
        action: "passkey_register",
        proof: body.stepUp as AccountStepUpProof | undefined,
      });
      if (!stepUp.ok) return reply.code(stepUp.denial.status).send(stepUp.denial.body);
      if (await rateLimited(reply, `passkey-registration-options:${userId}`, 10)) return;
      const begun = await beginPasskeyRegistration({ userId, sessionIdHash: sessionOf(req) });
      return reply.code(200).send(begun);
    },
  );

  app.post(
    "/v1/identity-security/passkeys/registration/verify",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = requireUser(req);
      const body = VerifyBody.parse(req.body ?? {});
      if (await rateLimited(reply, `passkey-registration-verify:${userId}`, 10)) return;
      const passkey = await completePasskeyRegistration({
        userId,
        sessionIdHash: sessionOf(req),
        ticket: body.ticket,
        label: body.label,
        response: body.response,
      });
      return reply.code(201).send({ passkey });
    },
  );

  app.delete(
    "/v1/identity-security/passkeys/:factorId",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = requireUser(req);
      const { factorId } = FactorParams.parse(req.params);
      const body = DeleteBody.parse(req.body ?? {});
      // Step-up FIRST: without it the route answers nothing about which ids
      // exist.
      const stepUp = await verifyAccountStepUp({
        req,
        reply,
        userId,
        action: "passkey_remove",
        proof: body.stepUp as AccountStepUpProof | undefined,
      });
      if (!stepUp.ok) return reply.code(stepUp.denial.status).send(stepUp.denial.body);
      await revokeOwnPasskey({ userId, factorId });
      return reply.code(200).send({ ok: true });
    },
  );
}
