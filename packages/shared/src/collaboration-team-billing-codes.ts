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
 * - TEAM_PLAN_REQUIRED          → the plan includes ZERO Teams (FREE /
 *                                  PAYG): creation is a plan feature,
 *                                  not a capacity problem.
 * - TEAM_INVITES_NOT_INCLUDED   → the Team exists (grandfathered) but
 *                                  the owner's current plan includes no
 *                                  Teams, so ALL membership growth
 *                                  (invites of every channel, member
 *                                  adds, accepts) is locked.
 * - SUBSCRIPTION_INACTIVE       → universal pre-mutation gate: plan
 *                                  exists but the subscription is
 *                                  cancelled / unpaid / past grace.
 */
export const COLLABORATION_TEAM_BILLING_ERROR_CODES = [
  "TEAM_PLAN_REQUIRED",
  "TEAM_INVITES_NOT_INCLUDED",
  "TEAM_LIMIT_REACHED",
  "TEAM_MEMBER_LIMIT_REACHED",
  "TEAM_INVITE_LIMIT_REACHED",
  "SUBSCRIPTION_INACTIVE",
  "EVIDENCE_RECORD_LIMIT_REACHED",
  "EVIDENCE_RECORD_MONTHLY_LIMIT_REACHED",
  "AI_MONTHLY_LIMIT_REACHED",
  /*
   * "The plan does not include AI" is not "you have used up your AI".
   *
   * This table already draws that distinction everywhere else —
   * TEAM_INVITES_NOT_INCLUDED (402) beside TEAM_LIMIT_REACHED (409) — and the
   * header above states the rule: 402 means the capability is not included,
   * 409 means it is included and at cap. AI was the one capability that
   * skipped it, so a plan with no AI allowance threw AI_MONTHLY_LIMIT_REACHED
   * and a FREE user's very FIRST message was answered with "you have reached
   * your AI usage limit" — a limit they never had.
   */
  "AI_NOT_INCLUDED",
  "ENTERPRISE_FEATURE_REQUIRED",
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
  TEAM_PLAN_REQUIRED: 402,
  TEAM_INVITES_NOT_INCLUDED: 402,
  TEAM_LIMIT_REACHED: 409,
  TEAM_MEMBER_LIMIT_REACHED: 409,
  TEAM_INVITE_LIMIT_REACHED: 429,
  SUBSCRIPTION_INACTIVE: 402,
  EVIDENCE_RECORD_LIMIT_REACHED: 409,
  EVIDENCE_RECORD_MONTHLY_LIMIT_REACHED: 409,
  AI_MONTHLY_LIMIT_REACHED: 429,
  // 402, per the rule above: the capability is not included at all.
  AI_NOT_INCLUDED: 402,
  ENTERPRISE_FEATURE_REQUIRED: 402,
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
