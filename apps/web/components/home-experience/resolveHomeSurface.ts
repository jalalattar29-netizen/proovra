/**
 * Phase IA-home-fork / Track 1A (surface-tier removal) — the single
 * source of truth for which Home surface `/home` renders.
 *
 * Track 1A migration (2026-07-28): the decision no longer reads a raw
 * plan string. Its inputs are SERVER-projected booleans only:
 *
 *   - `isPlatformAdmin`        — envelope.platform.isPlatformAdmin
 *   - `isEnterpriseWorkspace`  — envelope.flags.isEnterpriseWorkspace,
 *     which the backend derives from ENTERPRISE_PLAN_KEYS =
 *     {"ENTERPRISE"} for the ACTIVE workspace (TEAM is NOT enterprise —
 *     locked model, pinned server-side). This single flag therefore
 *     covers both the old `plan === "ENTERPRISE"` check and the old
 *     TEAM-flag exception.
 *   - `planResolved`           — whether the envelope has resolved a
 *     plan/entitlement for the active context at all (null while the
 *     envelope loads). Used ONLY to pick the loading skeleton, never to
 *     branch on a plan name.
 *
 * The corrected contract — CommandCenter is isolated behind an EXPLICIT
 * enterprise condition, and is NEVER the fallback:
 *
 *   1. Enterprise (platform admin OR enterprise workspace)
 *      .............................................. "command-center"
 *   2. Plan unresolved / loading ..................... "loading"
 *      → render a skeleton, NEVER CommandCenter.
 *   3. Everyone else (every resolved self-serve context)
 *      .............................................. "self-serve"
 *      → the single Home V2 (`SelfServeHomeDashboard`).
 *
 * Pure function: no React, no envelope access — trivially unit-testable.
 */

export type HomeSurfaceDecision = "command-center" | "loading" | "self-serve";

export type HomeSurfaceInput = {
  isPlatformAdmin: boolean;
  isEnterpriseWorkspace: boolean;
  /** True once the envelope has resolved the active context's plan. */
  planResolved: boolean;
};

export function resolveHomeSurface(input: HomeSurfaceInput): HomeSurfaceDecision {
  // 1. CommandCenter renders ONLY behind an explicit enterprise signal.
  //    This is the only path to CommandCenter — there is no fallback.
  const isEnterprise =
    input.isPlatformAdmin === true || input.isEnterpriseWorkspace === true;
  if (isEnterprise) return "command-center";

  // 2. Envelope not yet resolved (loading, or no entitlement row).
  //    Show a skeleton — NEVER the enterprise dashboard.
  if (!input.planResolved) return "loading";

  // 3. Default for every resolved, non-enterprise user: the single
  //    self-serve Home V2.
  return "self-serve";
}
