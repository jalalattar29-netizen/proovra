/**
 * Lifecycle Phase 3 (2026-07-17) — Connected accounts / login methods.
 *
 *   GET    /v1/identity/links               — list this account's login methods
 *   POST   /v1/identity/links/google        — link a Google identity (step-up)
 *   POST   /v1/identity/links/apple         — link an Apple identity (step-up)
 *   POST   /v1/identity/password            — add a password to an OAuth-only
 *                                             account (step-up; NOT recovery)
 *   DELETE /v1/identity/links/:id           — unlink a method (step-up +
 *                                             last-usable-method protection)
 *
 * Security model:
 *   - PERSONAL methods only (password / Google / Apple). Organization
 *     SAML/SCIM/IdP federation is Organization Administration and is never
 *     represented as a personal link.
 *   - Linking verifies the PROVIDER TOKEN server-side with the exact same
 *     verifiers the login flow uses (verifyGoogleIdToken /
 *     verifyAppleIdToken) — the client can never assert an identity.
 *   - ANTI-TAKEOVER: one provider identity belongs to exactly one account
 *     (DB unique on provider+subject). A conflict — the identity already
 *     linked elsewhere, or a LEGACY user row carrying that
 *     (provider, providerUserId) pair — returns 409
 *     identity_already_linked. Accounts are NEVER merged, and email
 *     equality is NEVER treated as ownership.
 *   - Every mutation requires the canonical account step-up
 *     (password / current MFA code / recent OAuth session).
 *   - LAST-METHOD PROTECTION: an unlink that would leave zero usable
 *     login methods (ACTIVE links + configured password) is rejected with
 *     the stable code last_login_method_protected.
 *   - Unlink REVOKES (status flip + revokedAtUtc); rows are never erased,
 *     so the account's identity history stays auditable.
 *   - All mutations emit identity.* audit events (surfaced on the
 *     Account & Security Activity timeline via the existing identity.
 *     prefix — no new read path).
 *
 * TENANT_SCOPE_EXCEPTION: account_tier_user_scoped
 * Every read/mutation here is bound to getAuthUserId(req) — account-tier
 * identity data with no workspace/tenant dimension; queries are keyed by
 * the caller's userId (and DB-unique provider subject), never by team.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import prismaPkg from "@prisma/client";

import { prisma } from "../db.js";
import { getAuthUserId } from "../auth.js";
import { AppError, ErrorCode } from "../errors.js";
import { requireAuth } from "../middleware/auth.js";
import {
  verifyGoogleIdToken,
  verifyAppleIdToken,
} from "../services/auth.service.js";
import {
  hashPassword,
  isPasswordPolicyCompliant,
} from "../services/email-password-auth.service.js";
import {
  verifyAccountStepUp,
  type AccountStepUpProof,
} from "../services/identity-security/account-step-up.service.js";
import { appendPlatformAuditLog } from "../services/platform-audit-log.service.js";

const LinkBody = z.object({
  idToken: z.string().min(16),
  stepUp: z
    .object({
      method: z.enum(["password", "mfa"]).optional(),
      currentPassword: z.string().optional(),
      code: z.string().optional(),
    })
    .optional(),
});

const PasswordBody = z.object({
  newPassword: z.string().min(1).max(200),
  stepUp: LinkBody.shape.stepUp,
});

const LinkIdParams = z.object({ id: z.string().uuid() });

async function requireStepUp(
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  action: "login_method_link" | "login_method_unlink" | "password_add",
  proof: AccountStepUpProof | undefined,
): Promise<boolean> {
  const verdict = await verifyAccountStepUp({
    req,
    reply,
    userId,
    action,
    proof,
  });
  if (!verdict.ok) {
    reply.code(verdict.denial.status).send(verdict.denial.body);
    return false;
  }
  return true;
}

function auditIdentityEvent(
  req: FastifyRequest,
  userId: string,
  action: string,
  metadata: Record<string, unknown>,
): void {
  void appendPlatformAuditLog({
    userId,
    action,
    category: "identity",
    severity: "info",
    source: "api_identity_links",
    outcome: "success",
    resourceType: "user",
    resourceId: userId,
    requestId: req.id,
    metadata,
    ipAddress: null,
    userAgent: null,
  }).catch(() => null);
}

/**
 * Anti-takeover conflict check: the verified (provider, subject) identity
 * must not belong to any OTHER account — neither via an ACTIVE link nor
 * via a legacy user row still carrying the pair.
 */
async function identityBelongsElsewhere(
  provider: prismaPkg.AuthProvider,
  subjectId: string,
  userId: string,
): Promise<boolean> {
  const link = await prisma.userIdentityLink.findFirst({
    where: { provider, providerSubjectId: subjectId, status: "ACTIVE" },
    select: { userId: true },
  });
  if (link && link.userId !== userId) return true;
  const legacy = await prisma.user.findUnique({
    where: {
      provider_providerUserId: { provider, providerUserId: subjectId },
    },
    select: { id: true },
  });
  if (legacy && legacy.id !== userId) return true;
  return false;
}

async function linkProviderIdentity(
  req: FastifyRequest,
  reply: FastifyReply,
  provider: prismaPkg.AuthProvider,
  verify: (idToken: string) => Promise<{
    provider: prismaPkg.AuthProvider;
    providerUserId: string;
    email?: string | null;
  }>,
) {
  const userId = getAuthUserId(req);
  if (!userId) throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
  const body = LinkBody.parse(req.body ?? {});

  if (!(await requireStepUp(req, reply, userId, "login_method_link", body.stepUp))) {
    return reply;
  }

  // Provider token verified server-side — the same trust anchor as login.
  let profile;
  try {
    profile = await verify(body.idToken);
  } catch {
    return reply.code(400).send({ error: { code: "invalid_id_token" } });
  }

  if (await identityBelongsElsewhere(provider, profile.providerUserId, userId)) {
    // No merge, no hint about the owning account.
    return reply.code(409).send({
      error: {
        code: "identity_already_linked",
        message:
          "This identity is already connected to a different PROOVRA account.",
      },
    });
  }

  // Upsert is the concurrency guard: a simultaneous duplicate link attempt
  // lands on the DB unique and resolves to the same row.
  const link = await prisma.userIdentityLink.upsert({
    where: {
      user_identity_links_provider_subject_uniq: {
        provider,
        providerSubjectId: profile.providerUserId,
      },
    },
    update: {
      status: "ACTIVE",
      revokedAtUtc: null,
      normalizedEmail: profile.email?.toLowerCase() ?? null,
      providerEmailVerified: Boolean(profile.email),
    },
    create: {
      userId,
      provider,
      providerSubjectId: profile.providerUserId,
      normalizedEmail: profile.email?.toLowerCase() ?? null,
      providerEmailVerified: Boolean(profile.email),
      status: "ACTIVE",
    },
    select: { id: true, provider: true, linkedAtUtc: true },
  });

  auditIdentityEvent(req, userId, "identity.login_method_linked", {
    provider,
    linkId: link.id,
  });

  return reply.code(200).send({ linked: true, link });
}

export async function identityLinksRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------
  // GET /v1/identity/links — the account's login methods.
  // ---------------------------------------------------------------------
  app.get(
    "/v1/identity/links",
    { preHandler: requireAuth },
    async (req: FastifyRequest) => {
      const userId = getAuthUserId(req);
      if (!userId) throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
      const me = await prisma.user.findUnique({
        where: { id: userId },
        select: { passwordHash: true, provider: true, providerUserId: true },
      });
      const links = await prisma.userIdentityLink.findMany({
        where: { userId, status: "ACTIVE" },
        select: {
          id: true,
          provider: true,
          normalizedEmail: true,
          linkedAtUtc: true,
          lastUsedAtUtc: true,
        },
        orderBy: { linkedAtUtc: "asc" },
      });
      // Legacy compatibility: an OAuth account created before the link
      // model whose link row is missing (backfill covers this, but fail
      // safe) is still surfaced read-only from the legacy pair.
      const hasLegacyOnly =
        (me?.provider === "GOOGLE" || me?.provider === "APPLE") &&
        !links.some(
          (l) =>
            l.provider === me.provider &&
            true /* subject match implied by backfill uniqueness */,
        );
      const passwordConfigured = Boolean(me?.passwordHash);
      const usableMethods =
        links.length + (passwordConfigured ? 1 : 0) + (hasLegacyOnly ? 1 : 0);
      return {
        passwordConfigured,
        links,
        legacyProvider: hasLegacyOnly ? me?.provider : null,
        usableMethods,
      };
    },
  );

  // ---------------------------------------------------------------------
  // POST /v1/identity/links/google | /apple — link (step-up enforced).
  // ---------------------------------------------------------------------
  app.post(
    "/v1/identity/links/google",
    { preHandler: requireAuth },
    async (req, reply) =>
      linkProviderIdentity(
        req,
        reply,
        prismaPkg.AuthProvider.GOOGLE,
        verifyGoogleIdToken,
      ),
  );
  app.post(
    "/v1/identity/links/apple",
    { preHandler: requireAuth },
    async (req, reply) =>
      linkProviderIdentity(
        req,
        reply,
        prismaPkg.AuthProvider.APPLE,
        verifyAppleIdToken,
      ),
  );

  // ---------------------------------------------------------------------
  // POST /v1/identity/password — add a password to an OAuth-only account.
  // NOT password recovery (the account must be signed in + step-up); NOT
  // password change (that stays on /v1/identity-security/password with
  // its current-password gate).
  // ---------------------------------------------------------------------
  app.post(
    "/v1/identity/password",
    { preHandler: requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const userId = getAuthUserId(req);
      if (!userId) throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
      const body = PasswordBody.parse(req.body ?? {});

      if (!(await requireStepUp(req, reply, userId, "password_add", body.stepUp))) {
        return reply;
      }

      const me = await prisma.user.findUnique({
        where: { id: userId },
        select: { passwordHash: true },
      });
      if (me?.passwordHash) {
        return reply.code(409).send({
          error: {
            code: "password_already_set",
            message:
              "A password already exists. Use Change password instead.",
          },
        });
      }
      if (!isPasswordPolicyCompliant(body.newPassword)) {
        return reply.code(400).send({
          error: {
            code: "weak_new_password",
            message:
              "Use at least 12 characters with upper- and lower-case letters and a number.",
          },
        });
      }
      await prisma.user.update({
        where: { id: userId },
        data: { passwordHash: hashPassword(body.newPassword) },
      });
      auditIdentityEvent(req, userId, "identity.password_added", {});
      return reply.code(200).send({ passwordConfigured: true });
    },
  );

  // ---------------------------------------------------------------------
  // DELETE /v1/identity/links/:id — unlink (step-up + last-method guard).
  // ---------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    "/v1/identity/links/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      const userId = getAuthUserId(req);
      if (!userId) throw new AppError(ErrorCode.UNAUTHORIZED, "Sign in.");
      const params = LinkIdParams.parse(req.params);
      const body = (req.body ?? {}) as { stepUp?: AccountStepUpProof };

      if (
        !(await requireStepUp(req, reply, userId, "login_method_unlink", body.stepUp))
      ) {
        return reply;
      }

      // Own links only — a link id belonging to another user is a 404,
      // never an authorization oracle.
      const target = await prisma.userIdentityLink.findFirst({
        where: { id: params.id, userId, status: "ACTIVE" },
        select: { id: true, provider: true },
      });
      if (!target) {
        return reply.code(404).send({ error: { code: "link_not_found" } });
      }

      // LAST-METHOD PROTECTION: after this unlink at least one usable
      // method (another ACTIVE link or a configured password) must remain.
      const [activeLinks, me] = await Promise.all([
        prisma.userIdentityLink.count({ where: { userId, status: "ACTIVE" } }),
        prisma.user.findUnique({
          where: { id: userId },
          select: { passwordHash: true },
        }),
      ]);
      const usableAfter = activeLinks - 1 + (me?.passwordHash ? 1 : 0);
      if (usableAfter < 1) {
        return reply.code(409).send({
          error: {
            code: "last_login_method_protected",
            message:
              "This is your only way to sign in. Add a password or connect another login method first.",
          },
        });
      }

      await prisma.userIdentityLink.update({
        where: { id: target.id },
        data: { status: "REVOKED", revokedAtUtc: new Date() },
      });
      auditIdentityEvent(req, userId, "identity.login_method_unlinked", {
        provider: target.provider,
        linkId: target.id,
      });
      return reply.code(200).send({ unlinked: true });
    },
  );
}
