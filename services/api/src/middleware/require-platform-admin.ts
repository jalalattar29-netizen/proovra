import type { FastifyReply, FastifyRequest } from "fastify";
import { createErrorResponse, ErrorCode } from "../errors.js";
import { requireAuth } from "./auth.js";
import { resolvePlatformAdmin } from "../services/platform-admin.service.js";

/**
 * AUD-0021 — did this request's session verify a second factor? (`mfaAt` is set
 * only by an MFA challenge or enrollment.) Every place that grants PLATFORM
 * authority asks this as well as the platform-admin resolver.
 */
export function platformSessionVerifiedMfa(req: FastifyRequest): boolean {
  return typeof (req.user as { mfaAt?: number | null } | undefined)?.mfaAt === "number";
}

/**
 * THE platform-admin gate for every `/v1/admin/*` route.
 *
 * ADM-001 (2026-08-27): the decision now comes from `resolvePlatformAdmin`,
 * which reads current authoritative state on every request. A token carrying a
 * historical `role: "admin"` claim no longer grants anything — see the module
 * comment on `platform-admin.service.ts` for why the claim is advisory only.
 *
 * A presented-but-withdrawn grant is logged at WARN. It is not an error (the
 * denial is correct and expected after an offboarding) but it is the signal an
 * operator wants when a demoted account keeps knocking, and it would otherwise
 * be indistinguishable from an ordinary non-admin 403.
 */
export async function requirePlatformAdmin(
  req: FastifyRequest,
  reply: FastifyReply
) {
  await requireAuth(req, reply);
  if (reply.sent) return;

  const userId = req.user!.sub;
  const role =
    (req.user as { platformRole?: string | null; role?: string | null } | undefined)
      ?.platformRole ??
    (req.user as { role?: string | null } | undefined)?.role ??
    null;

  const decision = await resolvePlatformAdmin(userId, role);

  if (!decision.allowed) {
    if (decision.claimedAdmin) {
      req.log.warn(
        {
          userId,
          source: decision.source,
          url: req.url,
        },
        "admin.stale_platform_admin_claim_refused"
      );
    }
    return reply.code(403).send(
      createErrorResponse(
        ErrorCode.FORBIDDEN,
        req.id,
        undefined,
        "Admin access required"
      )
    );
  }
  // AUD-0021 — platform authority needs a session that VERIFIED a second
  // factor (`mfaAt`, set only by an MFA challenge or enrollment). Sign-in
  // already requires it for platform administrators; this refuses every other
  // way a session could arrive here without one (tokens issued before the
  // rule, an OAuth or SSO session, an extension token).
  if (!platformSessionVerifiedMfa(req)) {
    req.log.warn({ userId, url: req.url }, "admin.platform_session_without_mfa_refused");
    return reply.code(403).send(
      createErrorResponse(
        ErrorCode.FORBIDDEN,
        req.id,
        { reason: "PLATFORM_ADMIN_MFA_REQUIRED" },
        "Platform administration requires a session verified with a second factor. Sign in again and complete the second-factor check."
      )
    );
  }
}
