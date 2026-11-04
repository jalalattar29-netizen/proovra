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
  detachedLegacySubject,
  isDetachedLegacySubject,
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
import { emitPlatformAudit } from "../services/audit/tenant-audit.service.js";
import { cancelOutstandingStepUpChallenges } from "../services/identity-security/step-up.service.js";

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

/** A concurrent add-password already set one; the guarded write found none to fill. */
class PasswordAlreadySetError extends Error {}

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

// PHASE 11 §3 Batch B — account-tier login-method events (see the
// TENANT_SCOPE_EXCEPTION note above: no workspace/tenant dimension) →
// genuinely GLOBAL platform events, routed through `emitPlatformAudit`.
function auditIdentityEvent(
  req: FastifyRequest,
  userId: string,
  action: string,
  metadata: Record<string, unknown>,
): void {
  void emitPlatformAudit({
    action,
    outcome: "success",
    sourceApp: "API",
    actorUserId: userId,
    resourceType: "user",
    resourceId: userId,
    correlationId: req.id,
    metadata,
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
    emailVerified?: boolean;
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

  const conflict = () =>
    // No merge, no hint about the owning account.
    reply.code(409).send({
      error: {
        code: "identity_already_linked",
        message:
          "This identity is already connected to a different PROOVRA account.",
      },
    });

  if (await identityBelongsElsewhere(provider, profile.providerUserId, userId)) {
    return conflict();
  }

  const fields = {
    normalizedEmail: profile.email?.toLowerCase() ?? null,
    providerEmailVerified: profile.emailVerified === true,
  };
  /*
   * PRO-009 (AUTH-03) — THE LINK BELONGS TO THE ACCOUNT THAT LINKS IT.
   *
   * The row is unique per provider identity and outlives an unlink as a
   * REVOKED record. Re-linking used to flip that row back to ACTIVE without
   * touching its owner, so after A unlinked Google, B "linking" it re-activated
   * A's row and Google sign-in landed in A. The claim is now one guarded write:
   * the row is taken only while it is this caller's own or REVOKED, and it is
   * re-owned by the caller. An ACTIVE row of another account is never touched,
   * even when it went ACTIVE after the check above (it answers 409).
   */
  const now = new Date();
  const claimed = await prisma.userIdentityLink.updateMany({
    where: {
      provider,
      providerSubjectId: profile.providerUserId,
      OR: [{ userId }, { status: "REVOKED" }],
    },
    data: {
      userId,
      status: "ACTIVE",
      revokedAtUtc: null,
      linkedAtUtc: now,
      ...fields,
    },
  });
  if (claimed.count === 0) {
    try {
      await prisma.userIdentityLink.create({
        data: {
          userId,
          provider,
          providerSubjectId: profile.providerUserId,
          status: "ACTIVE",
          ...fields,
        },
      });
    } catch (err) {
      // The DB unique: another account holds this identity ACTIVE.
      if ((err as { code?: unknown })?.code === "P2002") return conflict();
      throw err;
    }
  }
  const link = await prisma.userIdentityLink.findUniqueOrThrow({
    where: {
      user_identity_links_provider_subject_uniq: {
        provider,
        providerSubjectId: profile.providerUserId,
      },
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
      // A pair detached by an unlink is no longer a way in, and a pair whose
      // link row exists in any state is represented by that row.
      const legacyPairLinkRow =
        me && (me.provider === "GOOGLE" || me.provider === "APPLE")
          ? await prisma.userIdentityLink.findUnique({
              where: {
                user_identity_links_provider_subject_uniq: {
                  provider: me.provider,
                  providerSubjectId: me.providerUserId,
                },
              },
              select: { id: true },
            })
          : null;
      const hasLegacyOnly =
        (me?.provider === "GOOGLE" || me?.provider === "APPLE") &&
        !isDetachedLegacySubject(me.providerUserId) &&
        !legacyPairLinkRow;
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
        select: { passwordHash: true, provider: true, providerUserId: true, email: true },
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
      /*
       * PRO-010 (AUTH-04) — A PASSWORD ADDED HERE MUST SIGN IN.
       *
       * Email sign-in resolves the account by its (EMAIL, address) pair. An
       * account Google or Apple created carries that provider's pair instead,
       * so the hash was stored on a row email sign-in can never reach (401).
       * Adding the password now makes the account an email account: the pair
       * becomes (EMAIL, address), and the provider identity that created it is
       * kept as an ACTIVE login-method link, so that provider still signs in
       * here (and an unlink of it now actually ends that). This is the same
       * conversion a password reset already performs. Refused when the account
       * has no address to sign in with, or another account already owns the
       * address as an email account — never a silent second owner.
       */
      const legacyOAuth =
        me && (me.provider === "GOOGLE" || me.provider === "APPLE")
          ? { provider: me.provider, subject: me.providerUserId }
          : null;
      const address = me?.email ? me.email.trim().toLowerCase() : null;
      if (legacyOAuth && !address) {
        return reply.code(409).send({
          error: {
            code: "password_requires_email",
            message: "This account has no email address to sign in with a password.",
          },
        });
      }
      if (legacyOAuth && address) {
        const holder = await prisma.user.findFirst({
          where: { provider: "EMAIL", providerUserId: address, id: { not: userId } },
          select: { id: true },
        });
        if (holder) {
          return reply.code(409).send({
            error: {
              code: "email_account_exists",
              message:
                "Another PROOVRA account already signs in with this email address.",
            },
          });
        }
      }
      try {
        await prisma.$transaction(async (tx) => {
          if (legacyOAuth && address && !isDetachedLegacySubject(legacyOAuth.subject)) {
            await tx.userIdentityLink.upsert({
              where: {
                user_identity_links_provider_subject_uniq: {
                  provider: legacyOAuth.provider,
                  providerSubjectId: legacyOAuth.subject,
                },
              },
              // An existing row of this account keeps its status: an unlinked
              // identity stays unlinked.
              update: {},
              create: {
                userId,
                provider: legacyOAuth.provider,
                providerSubjectId: legacyOAuth.subject,
                normalizedEmail: address,
                providerEmailVerified: true,
                status: "ACTIVE",
              },
            });
          }
          const written = await tx.user.updateMany({
            where: { id: userId, passwordHash: null },
            data: {
              passwordHash: hashPassword(body.newPassword),
              ...(legacyOAuth && address
                ? { provider: "EMAIL", providerUserId: address }
                : {}),
            },
          });
          if (written.count === 0) throw new PasswordAlreadySetError();
        });
      } catch (err) {
        if (err instanceof PasswordAlreadySetError) {
          return reply.code(409).send({
            error: {
              code: "password_already_set",
              message: "A password already exists. Use Change password instead.",
            },
          });
        }
        if ((err as { code?: unknown })?.code === "P2002") {
          return reply.code(409).send({
            error: {
              code: "email_account_exists",
              message:
                "Another PROOVRA account already signs in with this email address.",
            },
          });
        }
        throw err;
      }
      // Closure reconciliation (N-6) — a new password is a security change
      // like a changed one: no approval granted before it is spent after it.
      await cancelOutstandingStepUpChallenges(userId);
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
        select: { id: true, provider: true, providerSubjectId: true },
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

      /*
       * PRO-010 (AUTH-04) — AN UNLINK ENDS THE IDENTITY'S WAY IN.
       *
       * Sign-in resolves an account by its own (provider, subject) pair before
       * it looks at links, so revoking the link of an account that provider
       * CREATED changed nothing: the next sign-in found the row by its pair and
       * re-activated the link. The pair is now detached in the same transaction
       * (`detachedLegacySubject`): it can never equal a provider subject again,
       * so the identity resolves to this account only if it is linked again.
       */
      const revokedAt = new Date();
      await prisma.$transaction(async (tx) => {
        await tx.userIdentityLink.update({
          where: { id: target.id },
          data: { status: "REVOKED", revokedAtUtc: revokedAt },
        });
        await tx.user.updateMany({
          where: {
            id: userId,
            provider: target.provider,
            providerUserId: target.providerSubjectId,
          },
          data: { providerUserId: detachedLegacySubject(target.id) },
        });
      });
      auditIdentityEvent(req, userId, "identity.login_method_unlinked", {
        provider: target.provider,
        linkId: target.id,
      });
      return reply.code(200).send({ unlinked: true });
    },
  );
}
