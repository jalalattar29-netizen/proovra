/**
 * PROOVRA Teams Entitlement Alignment (2026-07-14) — shared honest copy
 * for the Teams plan gates.
 *
 * Pure + dependency-free so both the pages and the node:test suites can
 * import it. The canonical limits table lives in `@proovra/shared`
 * (`COLLABORATION_TEAM_PLAN_LIMITS`); this module only owns the
 * user-facing sentences derived from server-provided facts. Counts and
 * plan names are NEVER fabricated — when the server payload does not
 * carry them the helpers return `null` and the caller falls back to the
 * safe generic copy from `toSafeUserError`.
 */

/**
 * The single honest plan-locked sentence for FREE/PAYG (zero Teams
 * included). Used by the Teams landing, its empty state, and the
 * TEAM_PLAN_REQUIRED CODE_MAP entry.
 */
export const TEAMS_PLAN_LOCKED_COPY =
  "Teams are available on Pro, Team, and Enterprise plans.";

/**
 * Build the honest at-cap message from the server's TEAM_LIMIT_REACHED
 * `details` payload (`limit` + `plan`), e.g. "Your Pro plan includes up
 * to 2 Teams. Upgrade to create another Team." Returns `null` when the
 * payload does not carry a usable numeric limit.
 */
export function formatTeamLimitReachedMessage(
  details: Record<string, unknown> | undefined,
): string | null {
  if (!details || typeof details !== "object") return null;
  const limit =
    typeof details.limit === "number" && Number.isFinite(details.limit)
      ? details.limit
      : null;
  if (limit === null) return null;
  const rawPlan = typeof details.plan === "string" ? details.plan.trim() : "";
  const planLabel = rawPlan
    ? `${rawPlan.charAt(0).toUpperCase()}${rawPlan.slice(1).toLowerCase()}`
    : null;
  const planPart = planLabel ? `${planLabel} plan` : "plan";
  return `Your ${planPart} includes up to ${limit} Team${
    limit === 1 ? "" : "s"
  }. Upgrade to create another Team.`;
}
