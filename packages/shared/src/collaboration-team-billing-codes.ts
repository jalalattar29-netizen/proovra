/**
 * PROOVRA Phase 10 — Canonical billing-guard error codes for the
 * Collaboration Team product.
 *
 * The /v1/collaboration-teams* mutation surface gates on the canonical
 * helpers in `services/api/src/services/collaboration-team/billing-guards.ts`.
 * Those helpers throw a structured error whose `.code` value MUST come
 * from the bounded union below.
 *
 * Constitutional rules pinned by Phase 10:
 *
 *   - These codes describe billing/plan/entitlement gates only. They are
 *     NOT general validation errors and they are NOT permission errors.
 *   - The shape is fixed: a string code, an HTTP status (402 / 409 / 429),
 *     and an upgrade CTA target (always "/billing" in the canonical
 *     product).
 *   - The Collaboration Team is NOT a workspace; codes here MUST NOT
 *     reuse the legacy `TEAM_WORKSPACE_LIMIT_REACHED` shape from
 *     `/v1/teams`. The canonical Team product is /collaboration-teams.
 */

/**
 * Bounded union of every canonical Phase 10 billing-guard error code.
 *
 * - TEAM_LIMIT_REACHED          → POST /v1/collaboration-teams when
 *                                  the plan's `maxTeams` is hit.
 * - TEAM_MEMBER_LIMIT_REACHED   → adding a member (direct OR via accept)
 *                                  past the plan's `maxMembersPerTeam`.
 * - TEAM_INVITE_LIMIT_REACHED   → invite gated by pending-per-team or
 *                                  24h rate window.
 * - SMS_INVITE_NOT_INCLUDED     → invite channel SMS not available on plan.
 * - LINK_INVITE_NOT_INCLUDED    → invite channel LINK not available on plan.
 * - GUEST_LIMIT_REACHED         → guest creation when the plan does not
 *                                  permit guests OR the cap is reached.
 * - SUBSCRIPTION_INACTIVE       → universal pre-mutation gate: plan
 *                                  exists but the subscription is
 *                                  cancelled / unpaid / past grace.
 */
export const COLLABORATION_TEAM_BILLING_ERROR_CODES = [
  "TEAM_LIMIT_REACHED",
  "TEAM_MEMBER_LIMIT_REACHED",
  "TEAM_INVITE_LIMIT_REACHED",
  "SMS_INVITE_NOT_INCLUDED",
  "LINK_INVITE_NOT_INCLUDED",
  "GUEST_LIMIT_REACHED",
  "SUBSCRIPTION_INACTIVE",
] as const;

export type CollaborationTeamBillingErrorCode =
  (typeof COLLABORATION_TEAM_BILLING_ERROR_CODES)[number];

/**
 * Canonical HTTP status mapping for the billing error codes. Mirrors
 * the legacy /v1/teams helpers:
 *
 *   - 402 PAYMENT_REQUIRED — plan does not include the capability.
 *   - 409 CONFLICT         — capability included but at-cap.
 *   - 429 TOO_MANY_REQUESTS — rate-window gate (invite 24h).
 */
export const COLLABORATION_TEAM_BILLING_ERROR_HTTP_STATUS: Record<
  CollaborationTeamBillingErrorCode,
  402 | 409 | 429
> = {
  TEAM_LIMIT_REACHED: 409,
  TEAM_MEMBER_LIMIT_REACHED: 409,
  TEAM_INVITE_LIMIT_REACHED: 429,
  SMS_INVITE_NOT_INCLUDED: 402,
  LINK_INVITE_NOT_INCLUDED: 402,
  GUEST_LIMIT_REACHED: 409,
  SUBSCRIPTION_INACTIVE: 402,
};

/**
 * Canonical upgrade-CTA target. Single source of truth so UI consumers
 * (route gates, denial banners, command palette) all link to the same
 * surface. /billing is the canonical billing-management page.
 */
export const COLLABORATION_TEAM_BILLING_UPGRADE_CTA = "/billing" as const;

export function isCollaborationTeamBillingErrorCode(
  value: unknown,
): value is CollaborationTeamBillingErrorCode {
  return (
    typeof value === "string" &&
    (COLLABORATION_TEAM_BILLING_ERROR_CODES as ReadonlyArray<string>).includes(
      value,
    )
  );
}
