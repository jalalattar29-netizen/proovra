/**
 * EP-0450 / PRO-CENZ-01 (closure phase 2) — renew an external-review grant.
 *
 * POST /v1/external-review/grants/:id/renew is the explicit, audited renewal
 * (members audit SEC-08). The surfaces that list grants (the record/case
 * panel and the External Review console) offer it only where the API
 * projects `viewerCanRenew` for the row, run it through the step-up flow
 * (EXTERNAL_REVIEW_GRANT_ISSUE, bound to the grant), and say the route's own
 * refusals. Mirrors the owner share-link Renew: one confirmed click, a fixed
 * period stated up front, recorded in the workspace audit log.
 */
import { SHARE_GRANT_DEFAULT_LIFETIME_DAYS } from "@proovra/shared";

import { apiFetch } from "../api";
import { toSafeUserError } from "../feedback/toSafeUserError";

/** The renewal period the confirmation states and the request sends. */
export const EXTERNAL_REVIEW_RENEW_DAYS = SHARE_GRANT_DEFAULT_LIFETIME_DAYS;

export async function renewExternalReviewGrant(
  teamId: string,
  grantId: string,
  headers?: Record<string, string>,
): Promise<{ grant: { id: string; expiresAtUtc: string; state: string } }> {
  return apiFetch(`/v1/external-review/grants/${encodeURIComponent(grantId)}/renew`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(headers ?? {}) },
    body: JSON.stringify({ teamId, days: EXTERNAL_REVIEW_RENEW_DAYS }),
  });
}

/** The sentence for a refused renewal, from the route's own answer. */
export function externalReviewRenewRefusal(err: unknown): string {
  const e = err as { code?: string; statusCode?: number } | null;
  switch (e?.code) {
    case "EXTERNAL_REVIEW_GRANT_NOT_RENEWABLE":
      return "This access can no longer be renewed: it has ended, expired or been revoked. Issue a new invitation instead. Nothing was changed.";
    case "ENTITLEMENT_REQUIRED":
      return "External Review is no longer included on this workspace's plan, so access cannot be extended. It can still be revoked.";
    case "EXTERNAL_REVIEW_GRANT_NOT_FOUND":
      return "This invitation is no longer available to you. Nothing was changed.";
    default:
      break;
  }
  if (e?.statusCode === 403) {
    return "Your role does not include renewing external-review access in this workspace. Nothing was changed.";
  }
  if (e?.statusCode === 404) return "This invitation is no longer available to you. Nothing was changed.";
  return toSafeUserError(err, { message: "The access could not be renewed." }).message;
}
