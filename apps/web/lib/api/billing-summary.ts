"use client";

/**
 * PROOVRA Phase 10 — typed billing-summary client.
 *
 * Surfaces a tiny, plan-aware snapshot derived from the canonical
 * platform-context envelope (`/v1/platform-context` — already mounted).
 * No new backend route is added in this phase: the relevant plan +
 * limits already flow through the envelope: POINT 7 added
 * `planFeatures.limits`, the SERVER projection of the one catalog for the
 * ACTIVE workspace, so the browser READS caps rather than deriving them.
 *
 * Rules:
 *   - PHASE 12 POINT 4 STEP 1 — plan resolution is the SERVER's, not the
 *     browser's. `envelope.activeSpace.plan` is the backend-resolved plan of
 *     the ACTIVE workspace (organization billing plan for an ORGANIZATION
 *     space, personal Entitlement overlay for the Personal Space). The
 *     browser no longer re-derives it from `activeSpace` + `organizations`,
 *     and the `?? account.accountPlan` fallbacks are GONE: an OWNED or
 *     ORGANIZATION workspace must never inherit the owner's Account plan.
 *     `null` = envelope loading / degraded → the summary is `null` and the
 *     surface renders no capacity claim (fail closed).
 *   - The returned shape uses the literal `"unlimited"` string instead
 *     of a magic Infinity for "no cap" surfaces. ENTERPRISE-tier
 *     callers can render the unlimited variant honestly.
 *   - Returns `null` while the envelope is still loading; never
 *     fabricates a plan or a count.
 *   - No `any`. No `as` to silence the compiler. No secrets logged.
 */

import { useMemo } from "react";

import { usePlatformContext } from "../platform-context";
import type { WorkspacePlan } from "../platform-context/types";
import type { ServerWorkspaceLimits } from "../platform-context";

export interface BillingSummary {
  /** Active plan key (e.g. "FREE", "PAYG", "PRO", "TEAM"). */
  plan: WorkspacePlan;
  /** Owned-team count if known to the caller; otherwise 0. */
  teamsUsed: number;
  /** Max teams allowed by the plan, or "unlimited". */
  teamsMax: number | "unlimited";
  /** Max members per team, or "unlimited". */
  membersMax: number | "unlimited";
}

/**
 * Pricing-hardening: the published catalog never advertises "unlimited"
 * for self-serve plans. Only ENTERPRISE — the Sales-provisioned tier —
 * reads as "unlimited" semantically, because its caps are Custom and
 * intentionally not enforced at the catalog level. Every other plan
 * surfaces its real numeric cap so in-product chips never lie about
 * what the backend actually enforces.
 */
function projectMax(
  plan: WorkspacePlan,
  value: number,
): number | "unlimited" {
  if (plan === "ENTERPRISE") return "unlimited";
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value;
}

function projectFromLimits(
  plan: WorkspacePlan,
  limits: ServerWorkspaceLimits,
  teamsUsed: number,
): BillingSummary {
  // Entitlement Alignment (2026-07-14): SMS invites, shareable invite
  // links and external guests were removed from the product entirely, so
  // the summary no longer projects those flags — only the canonical
  // Teams capacity numbers remain.
  return {
    plan,
    teamsUsed,
    teamsMax: projectMax(plan, limits.maxCollaborationTeamsPerWorkspace),
    membersMax: projectMax(
      plan,
      limits.maxAcceptedMembersPerCollaborationTeam,
    ),
  };
}

/**
 * Stable hook that returns the canonical billing summary for the
 * active space, or `null` while the envelope is loading.
 *
 * The `teamsUsed` value is sourced from the caller via the optional
 * `teamsUsed` argument so we never recount or shadow the
 * `listTeams()` payload that pages already hold.
 */
export function useBillingSummary(
  teamsUsed: number = 0,
): BillingSummary | null {
  const { envelope } = usePlatformContext();
  // The SERVER-resolved plan of the ACTIVE workspace. No client fallback
  // chain, no owner-account inheritance.
  const plan: WorkspacePlan | null = envelope?.activeSpace?.plan ?? null;
  // PHASE 12 — POINT 7: and the SERVER-resolved LIMITS for that same
  // workspace. The plan SUBJECT was already correct here; the table LOOKUP was
  // still happening in the browser, which kept a second copy of the mapping
  // from plan to cap alive. Both now come from one projection, so a catalog
  // change cannot leave this module a version behind.
  const limits = envelope?.planFeatures?.limits ?? null;

  return useMemo<BillingSummary | null>(() => {
    if (plan === null || limits === null) return null;
    return projectFromLimits(plan, limits, teamsUsed);
  }, [plan, limits, teamsUsed]);
}

/**
 * Promise-style accessor used by call sites that prefer a `Promise`
 * facade (e.g. mixing with other client-side fetches in `useEffect`).
 *
 * Implementation note: this does NOT issue a network call. It reads
 * the same canonical envelope the hook does. The promise shape exists
 * purely to satisfy the documented signature in the Phase 10 brief —
 * if a dedicated `/v1/billing-summary` endpoint ships later this is
 * the seam to swap to `apiFetch`.
 *
 * Pass `getEnvelopePlan` as a thin closure from a context-bearing
 * call site; we never read `window` or other ambient globals.
 */
export async function getBillingSummary(input: {
  plan: WorkspacePlan | null;
  /**
   * POINT 7 — the SERVER projection, read off the envelope by the caller.
   * Passing it in rather than looking it up is the point: this module no
   * longer holds a plan → limits table.
   */
  limits: ServerWorkspaceLimits | null;
  teamsUsed?: number;
}): Promise<BillingSummary | null> {
  if (!input.plan || !input.limits) return null;
  return projectFromLimits(input.plan, input.limits, input.teamsUsed ?? 0);
}

/**
 * Convenience: capture the canonical envelope plan resolution for
 * pages that already hold a `usePlatformContext` reference and want
 * a `BillingSummary` without consuming the dedicated hook.
 */
export function resolveBillingSummaryFromContext(
  context: ReturnType<typeof usePlatformContext>,
  teamsUsed: number = 0,
): BillingSummary | null {
  const envelope = context.envelope;
  if (!envelope) return null;
  // Same SERVER-resolved plan AND limits the hook reads — one resolution, no
  // fallbacks, and no second limit table in the browser.
  const plan: WorkspacePlan | null = envelope.activeSpace?.plan ?? null;
  const limits = envelope.planFeatures?.limits ?? null;
  if (plan === null || limits === null) return null;
  return projectFromLimits(plan, limits, teamsUsed);
}
