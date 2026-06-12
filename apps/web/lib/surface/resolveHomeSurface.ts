/**
 * Phase IA-home-fork — the single source of truth for which Home
 * surface `/home` renders.
 *
 * This replaces the previous fork in `app/(app)/home/page.tsx`, whose
 * `else` branch sent EVERY non-self-serve case — including the very
 * common `plan === null` (loading or no-entitlement) case — to the
 * enterprise `CommandCenter`. That meant self-serve users (and every
 * user during the envelope-loading window) saw the wrong dashboard:
 * the dense, nav-duplicating, enterprise-jargon CommandCenter that no
 * amount of `SelfServeHomeDashboard` editing could change.
 *
 * The corrected contract — CommandCenter is isolated behind an
 * EXPLICIT enterprise condition, and is NEVER the fallback:
 *
 *   1. Enterprise (platform admin OR enterprise workspace OR the
 *      `ENTERPRISE` plan) ............................ "command-center"
 *   2. Plan unresolved / loading (`plan == null`) ..... "loading"
 *      → render a skeleton, NEVER CommandCenter.
 *   3. Everyone else (FREE / PAYG / PRO / TEAM, or any other resolved
 *      non-enterprise plan) ........................... "self-serve"
 *      → the single Home V2 (`SelfServeHomeDashboard`).
 *
 * Pure function: no React, no envelope access — it takes the three
 * already-derived fields so it is trivially unit-testable.
 */

export type HomeSurfaceDecision = "command-center" | "loading" | "self-serve";

export type HomeSurfaceInput = {
  /** Resolved account/workspace plan, or null while loading/unresolved. */
  plan: string | null | undefined;
  isPlatformAdmin: boolean;
  isEnterpriseWorkspace: boolean;
};

export function resolveHomeSurface(input: HomeSurfaceInput): HomeSurfaceDecision {
  // 1. CommandCenter renders ONLY behind an explicit enterprise signal.
  //    This is the only path to CommandCenter — there is no fallback.
  //
  //    Phase HOME-DATA-OWNERSHIP correction: the backend envelope flag
  //    `flags.isEnterpriseWorkspace` is derived from
  //    ENTERPRISE_PLAN_KEYS = {"TEAM"} (platform-context.service.ts) —
  //    i.e. it currently means "TEAM-billed workspace", NOT a real
  //    Enterprise tier (PlanType has no ENTERPRISE value yet). The Home
  //    contract counts TEAM as SELF-SERVE, so a resolved TEAM plan must
  //    never be routed to CommandCenter by that flag alone. When a real
  //    ENTERPRISE tier ships, `plan === "ENTERPRISE"` already covers it.
  const isEnterprise =
    input.isPlatformAdmin === true ||
    input.plan === "ENTERPRISE" ||
    (input.isEnterpriseWorkspace === true && input.plan !== "TEAM");
  if (isEnterprise) return "command-center";

  // 2. Plan not yet resolved (envelope loading, or no entitlement row).
  //    Show a skeleton — NEVER the enterprise dashboard.
  if (input.plan === null || input.plan === undefined) return "loading";

  // 3. Default for every resolved, non-enterprise user: the single
  //    self-serve Home V2. FREE / PAYG / PRO / TEAM all land here.
  return "self-serve";
}
