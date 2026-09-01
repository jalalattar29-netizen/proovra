/**
 * THE AUTHORITY FOR THE PLATFORM `/v1/operations/*` FAMILIES.
 *
 * ===========================================================================
 * WHAT THIS REPLACES, AND WHAT WAS WRONG WITH IT
 * ===========================================================================
 * Four route families — queues, exports, signers, recovery — each carried its
 * own private `requireOpsActor`, three of them byte-identical. All four did the
 * same two things:
 *
 *     const member = await prisma.teamMember.findUnique({ teamId, userId })
 *     evaluateMemberAccess({ teamId, userId, permission: "identity.member.read" })
 *
 * `identity.member.read` is the weakest read permission there is. Every
 * authenticated user is an ACTIVE member of their own personal workspace, so
 * every authenticated user passed, by supplying their OWN `teamId`.
 *
 * The data behind those routes is not per-workspace:
 *
 *   - `listAllSigners` begins with `getCurrentActiveSigners()`, which takes no
 *     `teamId`. It returns the platform's live signing identities, including
 *     `kmsKeyArn`, `keyId` and `keyVersion`.
 *   - the queues routes say it in their own header: "The queues themselves are
 *     global (not per-workspace) … We do NOT filter jobs by team in the
 *     listing." The `teamId` is the AUDIT scope, not a filter.
 *   - exports surfaces the platform's Object Lock status.
 *   - recovery surfaces DR readiness, and `validate-backup` / `validate-restore`
 *     START WORK rather than reading anything.
 *
 * Proven against a live database before this existed: an ordinary member of a
 * seeded workspace read all eight endpoints, received `kmsKeyArn` in a 200, and
 * successfully triggered a platform DR backup validation. The only thing
 * standing between an ordinary user and those endpoints was a web route gate,
 * and a web route gate is a UX affordance — the API is the boundary.
 *
 * ===========================================================================
 * WHY BOTH CHECKS, AND IN THIS ORDER
 * ===========================================================================
 * Platform authority is the new requirement, but workspace membership is NOT
 * dropped: `teamId` is the audit scope these routes record operator actions
 * against, so it has to be a workspace the actor genuinely belongs to. An
 * operator auditing their actions against a workspace they are not in would
 * produce an audit trail that names the wrong place.
 *
 * Platform authority is evaluated FIRST. Running the membership lookup first
 * would let a non-operator distinguish "that workspace does not exist" (404)
 * from "you are not a member" (403) by probing ids — a small enumeration
 * oracle, but a free one to close.
 *
 * ===========================================================================
 * THIS IS A TIGHTENING
 * ===========================================================================
 * Every consumer of these four families is a single page under
 * `/admin/platform/*`, already behind the `platform.admin` route gate. Nothing
 * a user could legitimately reach becomes unreachable. Widening this helper —
 * pointing a tenant surface at it — is the change that would need argument, and
 * `test/adm013-operations-platform-authority.integration.test.ts` asserts both
 * directions so that argument cannot be skipped.
 */

import type { FastifyReply, FastifyRequest } from "fastify";

import { prisma } from "../db.js";
import { getAuthUserId } from "../auth.js";
import { evaluateMemberAccess } from "../services/identity/access-policy.service.js";
import { resolvePlatformAdmin } from "../services/platform-admin.service.js";

export type PlatformOpsActor = { userId: string };

/**
 * Resolve the actor for a platform operations route, or send the refusal.
 *
 * Returns `null` when it has already replied — callers must return immediately
 * on `null` and must not send a second response.
 */
export async function requirePlatformOpsActor(
  req: FastifyRequest,
  reply: FastifyReply,
  teamId: string,
): Promise<PlatformOpsActor | null> {
  const userId = getAuthUserId(req);

  // ---- 1. Platform authority, before anything workspace-shaped ------------
  const role =
    (req.user as { platformRole?: string | null; role?: string | null } | undefined)
      ?.platformRole ??
    (req.user as { role?: string | null } | undefined)?.role ??
    null;

  const platform = await resolvePlatformAdmin(userId, role);
  if (!platform.allowed) {
    if (platform.claimedAdmin) {
      // A token asserting `role: admin` that the database does not confirm is
      // worth a line in the log. The claim is advisory; this is where the
      // discrepancy becomes visible.
      req.log.warn(
        { userId, source: platform.source, url: req.url },
        "platform-ops actor claimed admin but the database did not confirm it",
      );
    }
    // The body names no signer, no queue and no key. A 403 that describes what
    // it is protecting is a 403 that leaks.
    reply.code(403).send({
      error: {
        code: "permission_denied",
        reason: "platform_operations_authority_required",
      },
    });
    return null;
  }

  // ---- 2. The audit scope must be a workspace the actor is really in ------
  const member = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { id: true, status: true },
  });
  if (!member) {
    reply.code(404).send({ error: { code: "not_found" } });
    return null;
  }
  if (member.status !== "ACTIVE") {
    reply.code(403).send({ error: { code: "member_inactive" } });
    return null;
  }

  const decision = await evaluateMemberAccess({
    teamId,
    userId,
    permission: "identity.member.read",
  });
  if (!decision.allowed) {
    reply.code(403).send({
      error: {
        code: "permission_denied",
        reason: decision.reason,
        detail: decision.detail ?? null,
      },
    });
    return null;
  }

  return { userId };
}
