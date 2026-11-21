/**
 * EP-0450 / PRO-CENZ-01 (closure phase 2) — WHO MAY RENEW AN EXTERNAL-REVIEW
 * GRANT, projected for the viewer.
 *
 * POST /v1/external-review/grants/:id/renew (members audit SEC-08: "renewal
 * an explicit audited action") is decided by, in order:
 *   1. `governance.legal_hold.manage` in the grant's workspace;
 *   2. the operator's reach to the grant's subject (else a missing grant);
 *   3. the workspace's External Review entitlement (a downgrade stops
 *      extensions, never revocation);
 *   4. a fresh step-up (EXTERNAL_REVIEW_GRANT_ISSUE, bound to the grant);
 *   5. the grant itself: INVITED or ACTIVE and not yet expired (an expired
 *      grant is never revived: PRO-LEAD-06).
 *
 * The web offers Renew only where the API says this viewer could renew, so
 * the list routes project `viewerCanRenew` from THESE functions — the renew
 * route uses the same permission constant — rather than the page guessing a
 * role. Reach is already applied by the lists (A2-08 hides closed subjects);
 * step-up is asked at the click. The renew route re-checks everything.
 */
import type { FastifyRequest } from "fastify";

import { evaluateAuthorize } from "../../middleware/authorize.js";
import { workspaceIncludesExternalReview } from "../billing-enforcement.service.js";

/** The one permission the renew route asks (also used by its projection). */
export const EXTERNAL_REVIEW_RENEW_PERMISSION = "governance.legal_hold.manage" as const;

/**
 * Whether this caller holds the workspace-level renew authority: the renew
 * permission AND the plan entitlement. Never sends a response, never throws
 * (a failed decision is "no").
 */
export async function viewerHoldsExternalReviewRenewAuthority(
  req: FastifyRequest,
  teamId: string,
): Promise<boolean> {
  try {
    const outcome = await evaluateAuthorize(req, {
      teamId,
      permission: EXTERNAL_REVIEW_RENEW_PERMISSION,
      antiEnumeration: true,
    });
    if (!outcome.allowed) return false;
    return await workspaceIncludesExternalReview(teamId);
  } catch {
    return false;
  }
}

/** Whether the grant itself can still be renewed (the service's own rule). */
export function externalReviewGrantRenewableNow(
  grant: { state: string | null; expiresAtUtc: string | Date | null },
  now: Date = new Date(),
): boolean {
  if (grant.state !== "INVITED" && grant.state !== "ACTIVE") return false;
  if (!grant.expiresAtUtc) return false;
  const expires = grant.expiresAtUtc instanceof Date ? grant.expiresAtUtc : new Date(grant.expiresAtUtc);
  return expires.getTime() > now.getTime();
}
