/**
 * PROOVRA Phase 10 — Shared billing error-code vocabulary.
 *
 * This file is the canonical-shared bounded union of every billing-guard
 * error code that crosses the API/UI seam. It is intentionally broader
 * than the collaboration-team-specific union in
 * `collaboration-team-billing-codes.ts` so that:
 *
 *   - UI denial banners + upgrade-CTA gates can switch on a single
 *     shared union without importing a product-specific module.
 *   - Future billing-guarded surfaces (verification packages, governance
 *     packs, exports, etc.) can reuse the same vocabulary.
 *
 * The collaboration-team helpers in
 * `services/api/src/services/collaboration-team/billing-guards.ts`
 * already throw with codes drawn from a strict subset of this union
 * (see `COLLABORATION_TEAM_BILLING_ERROR_CODES`). The additional
 * `UPGRADE_REQUIRED` code in this file is the generic catch-all used
 * by non-collaboration-team surfaces that need to surface an upgrade
 * CTA without being more specific.
 *
 * Constitutional rules pinned by Phase 10:
 *
 *   - These codes describe billing/plan/entitlement gates only. They
 *     are NOT general validation errors and they are NOT permission
 *     errors. The denial-vocabulary file owns access denials.
 *   - The vocabulary is bounded. Adding a new code requires updating
 *     this union and the consuming UI surfaces in the same change.
 *   - Codes here MUST NOT be used to express workspace-admin (legacy
 *     /v1/teams) limits — those keep their own `TEAM_WORKSPACE_LIMIT_REACHED`
 *     code per the legacy surface contract.
 */

/**
 * Bounded union of canonical billing error codes shared across the
 * Phase 10 mutation surfaces.
 *
 * - TEAM_LIMIT_REACHED          → plan's `maxTeams` is hit on create.
 * - TEAM_MEMBER_LIMIT_REACHED   → adding a member past `maxMembersPerTeam`.
 * - TEAM_INVITE_LIMIT_REACHED   → invite gated by pending-per-team
 *                                 OR 24h rate window.
 * - SUBSCRIPTION_INACTIVE       → universal pre-mutation gate: plan
 *                                 exists but the subscription is
 *                                 cancelled / unpaid / past grace.
 * - UPGRADE_REQUIRED            → generic catch-all when the surface
 *                                 needs to surface an upgrade CTA
 *                                 without binding to a specific limit.
 */
export const BILLING_ERROR_CODES = [
  "TEAM_LIMIT_REACHED",
  "TEAM_MEMBER_LIMIT_REACHED",
  "TEAM_INVITE_LIMIT_REACHED",
  "SUBSCRIPTION_INACTIVE",
  "UPGRADE_REQUIRED",
] as const;

export type BillingErrorCode = (typeof BILLING_ERROR_CODES)[number];

/**
 * Canonical HTTP status mapping for the shared codes. Mirrors the
 * collaboration-team mapping so a downstream HTTP responder can switch
 * on either union without divergence.
 *
 *   - 402 PAYMENT_REQUIRED — plan does not include the capability.
 *   - 409 CONFLICT         — capability included but at-cap.
 *   - 429 TOO_MANY_REQUESTS — rate-window gate.
 */
export const BILLING_ERROR_HTTP_STATUS: Record<
  BillingErrorCode,
  402 | 409 | 429
> = {
  TEAM_LIMIT_REACHED: 409,
  TEAM_MEMBER_LIMIT_REACHED: 409,
  TEAM_INVITE_LIMIT_REACHED: 429,
  SUBSCRIPTION_INACTIVE: 402,
  UPGRADE_REQUIRED: 402,
};

/**
 * Canonical upgrade-CTA target for the shared codes. Single source of
 * truth so UI consumers (route gates, denial banners, command palette)
 * all link to the same surface. /billing is the canonical billing-
 * management page.
 */
export const BILLING_ERROR_UPGRADE_CTA = "/billing" as const;

export function isBillingErrorCode(value: unknown): value is BillingErrorCode {
  return (
    typeof value === "string" &&
    (BILLING_ERROR_CODES as ReadonlyArray<string>).includes(value)
  );
}
