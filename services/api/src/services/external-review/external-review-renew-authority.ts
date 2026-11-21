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
 * the list routes project `viewerCanRenew` from `viewerRenewableGrantIds`,
 * which applies every gate the route applies BEFORE the step-up challenge:
 * the same permission constant, the same subject-reach predicate (batched:
 * `externalReviewGrantIdsInReach`, the rule behind
 * `externalReviewGrantSubjectInReach` — a live, reachable record or case, or
 * a published package), the entitlement, the step-up middleware's own
 * session-quarantine refusal (`quarantinedStepUpSessionId`), and the grant's
 * renewability. Only answering the challenge is left to the click (review L-1:
 * a trashed subject or a quarantined session no longer shows a Renew that the
 * route always refuses). The renew route re-checks everything.
 */
import type { FastifyRequest } from "fastify";

import { evaluateAuthorize } from "../../middleware/authorize.js";
import { workspaceIncludesExternalReview } from "../billing-enforcement.service.js";
import { quarantinedStepUpSessionId } from "../identity-security/step-up-middleware.js";
import { externalReviewGrantIdsInReach } from "./external-review-grant.service.js";

/** The one permission the renew route asks (also used by its projection). */
export const EXTERNAL_REVIEW_RENEW_PERMISSION = "governance.legal_hold.manage" as const;

/**
 * Of these listed grants, the ones THIS caller could renew now (all of the
 * renew route's gates but the challenge itself). Never sends a response and
 * never throws: a failed decision is "none".
 */
export async function viewerRenewableGrantIds(
  req: FastifyRequest,
  teamId: string,
  grants: ReadonlyArray<{ id: string; state: string | null; expiresAtUtc: string | Date | null }>,
  now: Date = new Date(),
): Promise<Set<string>> {
  try {
    const live = grants.filter((g) => externalReviewGrantRenewableNow(g, now)).map((g) => g.id);
    if (live.length === 0) return new Set();
    const outcome = await evaluateAuthorize(req, {
      teamId,
      permission: EXTERNAL_REVIEW_RENEW_PERMISSION,
      antiEnumeration: true,
    });
    if (!outcome.allowed) return new Set();
    if (!(await workspaceIncludesExternalReview(teamId))) return new Set();
    if (await quarantinedStepUpSessionId(req, outcome.actorUserId)) return new Set();
    return await externalReviewGrantIdsInReach({ teamId, actorUserId: outcome.actorUserId, grantIds: live });
  } catch {
    return new Set();
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
