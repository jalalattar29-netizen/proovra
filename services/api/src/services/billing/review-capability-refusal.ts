/**
 * PRO-R2-14 — ONE wire shape for "the workspace's plan does not include this
 * review capability".
 *
 * The same commercial refusal used to leave the API in three shapes:
 *   reviewer-ops        403 { error: { code: "ENTITLEMENT_REQUIRED", entitlement } }
 *   review-operations,
 *   reviewer-criteria   404 { error: { code: "reviewer_operations_not_included" } }
 *   reviewer workspace  403 { denial: "ENTITLEMENT_REQUIRED", entitlement }
 * and the pages, each reading one of them, showed "The publish action failed",
 * a raw client error or "Could not load" instead of "your plan does not
 * include this". Every gate now answers the reviewer-ops shape. It is sent
 * only AFTER membership is proven, so a 403 discloses nothing a non-member
 * could learn (a non-member still gets the route's anti-enumeration 404).
 *
 * `reason` keeps the old code word so a reader that matched it still finds it.
 */
import type { ReviewCapability } from "../billing-enforcement.service.js";

export type ReviewCapabilityRefusalBody = {
  error: {
    code: "ENTITLEMENT_REQUIRED";
    reason: "reviewer_operations_not_included";
    entitlement: ReviewCapability;
    requestId: string | null;
  };
};

export function reviewCapabilityRefusalBody(
  capability: ReviewCapability,
  requestId: string | null | undefined,
): ReviewCapabilityRefusalBody {
  return {
    error: {
      code: "ENTITLEMENT_REQUIRED",
      reason: "reviewer_operations_not_included",
      entitlement: capability,
      requestId: requestId ?? null,
    },
  };
}
