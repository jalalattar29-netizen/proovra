/**
 * PHASE 13 (NEW-058) — CONTACT FACTOR ENROLLMENT.
 *
 *   GET    /v1/identity-security/contact-factors             — list own factors
 *   POST   /v1/identity-security/contact-factors/enroll/start
 *   POST   /v1/identity-security/contact-factors/enroll/verify
 *   POST   /v1/identity-security/contact-factors/:id/revoke
 *
 * The step-up gate can no longer be handed a destination, so an account needs a
 * way to acquire one. These four routes are that way, and they are
 * account-scoped rather than workspace-scoped: a factor belongs to the USER,
 * and the same enrolment serves every workspace they can act in.
 *
 * The verification round-trip reuses the SAME Phase-18 verification service the
 * step-up challenge uses, so the enrolment is proven by the same mechanism it
 * later authorises — there is no second, weaker path by which a number can
 * become "verified".
 *
 * WHY THIS IS ITS OWN PLUGIN
 * ---------------------------------------------------------------------------
 * It was written inside `identity-security.routes.ts` and pushed that file 11 KB
 * past the size at which its own guard says it has stopped being an
 * orchestrator. The guard was right about the boundary and wrong only about how
 * to express it: this is a distinct capability with a distinct authority
 * (`verified-contact-factor.service.ts`), so it gets a module, not a bigger
 * ceiling. `identity-security.routes.ts` is back inside its canonical baseline
 * as a consequence of the extraction rather than of a rebaseline.
 *
 * The boundary this file must keep is the same one: every handler below parses,
 * authorises, delegates and audits. The factor lifecycle — normalising a
 * destination, minting a generation, deciding what ACTIVE means, masking what
 * is projected — belongs to the factor service and is never re-decided here.
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";

import { getAuthUserId } from "../auth.js";
import { requireAuth } from "../middleware/auth.js";
import { enforceRateLimit } from "../services/rate-limit.js";
import {
  VerifiedContactFactorError,
  completeContactFactorEnrollment,
  listContactFactors,
  resolveEnrollingDestination,
  revokeContactFactor,
  startContactFactorEnrollment,
} from "../services/security/verified-contact-factor.service.js";
import {
  VerificationError,
  checkVerification,
  startVerification,
} from "../services/communications/verification.service.js";
import {
  auditIdentitySecurityEvent,
  requestIp,
  requestUa,
  requireSecurityActor,
} from "./identity-security-shared.js";

const ParamsId = z.object({ id: z.string().uuid() });

export async function identitySecurityContactFactorRoutes(app: FastifyInstance) {
  app.get(
    "/v1/identity-security/contact-factors",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = getAuthUserId(req);
      const factors = await listContactFactors(userId);
      // Only the mask is ever projected. There is no route that returns the
      // enrolled destination, and none may be added.
      return reply.code(200).send({ factors });
    },
  );

  const EnrollStartBody = z
    .object({
      // The verification attempt is tenant-scoped (its rate limit and audit
      // trail are), so enrolment is performed from inside a workspace the
      // caller belongs to. The FACTOR itself stays account-owned: one
      // enrolment serves every workspace the user can act in.
      teamId: z.string().uuid(),
      channel: z.enum(["SMS", "WHATSAPP"]).default("SMS"),
      destination: z.string().min(3).max(32),
      label: z.string().min(1).max(60).optional(),
    })
    .strict();

  app.post(
    "/v1/identity-security/contact-factors/enroll/start",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = EnrollStartBody.parse(req.body ?? {});
      const actor = await requireSecurityActor(
        req,
        reply,
        body.teamId,
        "identity.member.read",
      );
      if (!actor) return;
      const userId = actor.userId;

      /**
       * The destination IS an input here, and only here — that is what
       * enrolment means. What makes it safe is that it becomes a factor only
       * after the code sent TO it comes back, and that the step-up gate reads
       * the factor rather than a request field.
       */
      await enforceRateLimit({
        key: `contact-factor-enroll:${userId}`,
        max: 5,
        windowSec: 3600,
      });

      try {
        const { factor, destinationE164 } = await startContactFactorEnrollment({
          userId,
          kind: body.channel,
          destinationRaw: body.destination,
          label: body.label,
        });

        const verification = await startVerification({
          teamId: body.teamId,
          channel: body.channel,
          phoneE164OrRaw: destinationE164,
          initiatedByUserId: userId,
          purpose: `CONTACT_FACTOR_ENROLL:${factor.factorId}`,
          ipAddress: requestIp(req),
          userAgent: requestUa(req),
        });
        if (verification.status === "rate_limited") {
          return reply.code(429).send({ error: { code: "rate_limited" } });
        }

        auditIdentitySecurityEvent(req, {
          userId,
          action: "identity_security.contact_factor.enroll_start",
          outcome: "success",
          resourceType: "mfa_factor",
          resourceId: factor.factorId,
          metadata: { kind: factor.kind, destinationMask: factor.destinationMask },
          ip: requestIp(req),
          ua: requestUa(req),
        });

        // The verification attempt id is returned so the completion call can
        // name the EXACT attempt this enrolment started — that is what stops
        // one concurrent enrolment's code activating another.
        //
        // `codeExpiresAtUtc` is the attempt's OWN expiry, projected so the
        // enrolment surface can tell the user which of two different things
        // went wrong. `checkVerification` deliberately collapses "wrong code"
        // and "expired code" into one `{ status: "denied" }` so an attacker
        // learns nothing from the response — correct, and it leaves the
        // enrolling user with "denied" and no idea whether to retype the code
        // or ask for a new one. The expiry is not a secret (the code itself
        // never appears here, and the caller just asked for it to be sent), so
        // the surface can distinguish the two locally without weakening the
        // server's single denial shape.
        return reply.code(200).send({
          factor,
          verificationAttemptId: verification.attempt.id,
          codeExpiresAtUtc:
            verification.attempt.expiresAtUtc?.toISOString() ?? null,
        });
      } catch (err) {
        if (err instanceof VerifiedContactFactorError) {
          return reply.code(409).send({ error: { code: err.code } });
        }
        if (err instanceof VerificationError) {
          return reply.code(502).send({ error: { code: "provider_error" } });
        }
        throw err;
      }
    },
  );

  const EnrollVerifyBody = z
    .object({
      teamId: z.string().uuid(),
      factorId: z.string().uuid(),
      verificationAttemptId: z.string().uuid(),
      code: z.string().min(3).max(16),
    })
    .strict();

  app.post(
    "/v1/identity-security/contact-factors/enroll/verify",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = EnrollVerifyBody.parse(req.body ?? {});
      const actor = await requireSecurityActor(
        req,
        reply,
        body.teamId,
        "identity.member.read",
      );
      if (!actor) return;
      const userId = actor.userId;

      // Generic denial: an attacker must not learn whether the factor exists,
      // belongs to someone else, or is simply not pending. The resolver
      // returns null for all three.
      const pendingDestination = await resolveEnrollingDestination(
        { userId, factorId: body.factorId },
      );
      if (!pendingDestination) return reply.code(400).send({ status: "denied" });
      const destination = pendingDestination.destination;

      try {
        const result = await checkVerification({
          teamId: body.teamId,
          phoneE164OrRaw: destination,
          code: body.code,
          initiatedByUserId: userId,
          // NEW-055: the EXACT attempt this enrolment started. Without it the
          // verification service takes the newest STARTED attempt for the
          // recipient, so two concurrent enrolments could approve each other.
          verificationAttemptId: body.verificationAttemptId,
        });
        if (result.status !== "approved") {
          return reply.code(400).send({ status: "denied" });
        }
      } catch {
        return reply.code(400).send({ status: "denied" });
      }

      const factor = await completeContactFactorEnrollment({
        userId,
        factorId: body.factorId,
      });

      auditIdentitySecurityEvent(req, {
        userId,
        action: "identity_security.contact_factor.enrolled",
        outcome: "success",
        resourceType: "mfa_factor",
        resourceId: factor.factorId,
        metadata: { kind: factor.kind, generation: factor.generation },
        ip: requestIp(req),
        ua: requestUa(req),
      });
      return reply.code(200).send({ factor });
    },
  );

  app.post(
    "/v1/identity-security/contact-factors/:id/revoke",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = ParamsId.parse(req.params);
      const userId = getAuthUserId(req);
      try {
        const factor = await revokeContactFactor({ userId, factorId: id });
        auditIdentitySecurityEvent(req, {
          userId,
          action: "identity_security.contact_factor.revoked",
          outcome: "success",
          resourceType: "mfa_factor",
          resourceId: factor.factorId,
          metadata: { kind: factor.kind, generation: factor.generation },
          ip: requestIp(req),
          ua: requestUa(req),
        });
        return reply.code(200).send({ factor });
      } catch (err) {
        if (err instanceof VerifiedContactFactorError) {
          return reply.code(404).send({ error: { code: "not_found" } });
        }
        throw err;
      }
    },
  );
}
