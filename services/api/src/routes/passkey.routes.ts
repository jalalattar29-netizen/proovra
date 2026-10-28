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
 * challenges itself. So beginning a registration requires the workspace
 * step-up LADDER (PASSKEY_REGISTER): the strongest authenticator the person
 * already holds answers it — never a password or a young session (closure
 * audit N-2) — and the ticket it returns is bound to that user and session.
 * Removal needs it too (PASSKEY_REMOVE): stripping the holder's passkey is how
 * an attacker would downgrade the account to a factor it controls.
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
import { prisma } from "../db.js";
import { requireStepUpForSensitiveAction } from "../services/identity-security/step-up-middleware.js";
import { cancelOutstandingStepUpChallenges } from "../services/identity-security/step-up.service.js";
import {
  PASSKEY_LABEL_MAX,
  beginPasskeyRegistration,
  completePasskeyRegistration,
  listOwnPasskeys,
  revokeOwnPasskey,
} from "../services/identity-security/passkey.service.js";
import { enforceRateLimit } from "../services/rate-limit.js";

/**
 * The workspace the step-up is answered in. A passkey belongs to the account,
 * but the ladder is resolved against an Organization's policy, so the person
 * names a workspace they are an ACTIVE member of (the one they are in).
 */
const OptionsBody = z.object({ workspaceId: z.string().uuid() }).strict();

const VerifyBody = z
  .object({
    ticket: z.string().min(16).max(2048),
    label: z.string().trim().min(1).max(PASSKEY_LABEL_MAX),
    response: z.record(z.string(), z.unknown()),
  })
  .strict();

const FactorParams = z.object({ factorId: z.string().uuid() });
const DeleteBody = z.object({ workspaceId: z.string().uuid() }).strict();

/** The workspace must be one the caller is an ACTIVE member of; else 404. */
async function memberWorkspace(reply: FastifyReply, userId: string, workspaceId: string): Promise<boolean> {
  const membership = await prisma.teamMember.findFirst({
    where: { teamId: workspaceId, userId, status: "ACTIVE" },
    select: { id: true },
  });
  if (membership) return true;
  reply.code(404).send({
    error: { code: "not_found", message: "Workspace not found.", requestId: reply.request.id },
  });
  return false;
}

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
      if (!(await memberWorkspace(reply, userId, body.workspaceId))) return;
      /*
       * CLOSURE AUDIT N-2 — binding a passkey is answered by the STRONGEST
       * authenticator already held (an existing passkey, the Organization's
       * IdP reauthentication, an authenticator app, an allowed phone code),
       * never by a password or a young session: otherwise a stolen session
       * plus a password would mint the very factor that answers every
       * archive. Bound to this person (resourceId) and this workspace.
       */
      const gate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: body.workspaceId,
        userId,
        purpose: "PASSKEY_REGISTER",
        resourceKind: "user",
        resourceId: userId,
      });
      if (gate.sent) return;
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
      // N-6 — a new factor changes who can prove they are this person.
      await cancelOutstandingStepUpChallenges(userId);
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
      if (!(await memberWorkspace(reply, userId, body.workspaceId))) return;
      // Step-up FIRST: without it the route answers nothing about which ids
      // exist. Removing a passkey can weaken every ladder purpose, so it is
      // answered by the strongest authenticator held (N-2), bound to this
      // factor id.
      const gate = await requireStepUpForSensitiveAction({
        req,
        reply,
        teamId: body.workspaceId,
        userId,
        purpose: "PASSKEY_REMOVE",
        resourceKind: "mfa_factor",
        resourceId: factorId,
      });
      if (gate.sent) return;
      await revokeOwnPasskey({ userId, factorId });
      await cancelOutstandingStepUpChallenges(userId);
      return reply.code(200).send({ ok: true });
    },
  );
}
