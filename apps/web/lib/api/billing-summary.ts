"use client";

/**
 * PROOVRA Phase 10 — typed billing-summary client.
 *
 * Surfaces a tiny, plan-aware snapshot derived from the canonical
 * platform-context envelope (`/v1/platform-context` — already mounted).
 * No new backend route is added in this phase: the relevant plan +
 * limits already flow through the envelope, and the shared SoT
 * `getCollaborationTeamPlanLimits` is the authority for caps.
 *
 * Rules:
 *   - Plan resolution mirrors the backend ownership rules:
 *       1. active organization's plan when an org is the active space
 *       2. personal-space plan when active space is personal
 *       3. account.accountPlan fallback
 *   - The returned shape uses the literal `"unlimited"` string instead
 *     of a magic Infinity for "no cap" surfaces. ENTERPRISE-tier
 *     callers can render the unlimited variant honestly.
 *   - Returns `null` while the envelope is still loading; never
 *     fabricates a plan or a count.
 *   - No `any`. No `as` to silence the compiler. No secrets logged.
 */

import { useMemo } from "react";

import {
  useAccount,
  useActiveSpace,
  useOrganizations,
  usePersonalSpace,
  usePlatformContext,
} from "../platform-context";
import type { WorkspacePlan } from "../platform-context/types";
import {
  COLLABORATION_TEAM_PLAN_LIMITS,
  getCollaborationTeamPlanLimits,
  type CollaborationTeamPlanLimits,
} from "@proovra/shared";

export interface BillingSummary {
  /** Active plan key (e.g. "FREE", "PAYG", "PRO", "TEAM"). */
  plan: WorkspacePlan;
  /** Owned-team count if known to the caller; otherwise 0. */
  teamsUsed: number;
  /** Max teams allowed by the plan, or "unlimited". */
  teamsMax: number | "unlimited";
  /** Max members per team, or "unlimited". */
  membersMax: number | "unlimited";
  /** Whether SMS invites are included at the active plan tier. */
  smsInvitesIncluded: boolean;
  /** Whether guest collaborators are unlocked at the active plan tier. */
  guestsAllowed: boolean;
}

const UNLIMITED_THRESHOLD = 1000;

function projectMax(value: number): number | "unlimited" {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value >= UNLIMITED_THRESHOLD ? "unlimited" : value;
}

function projectFromLimits(
  plan: WorkspacePlan,
  limits: CollaborationTeamPlanLimits,
  teamsUsed: number,
): BillingSummary {
  // Guests are unlocked on PRO and TEAM (matches the backend rule in
  // services/api/src/services/collaboration-team/billing-guards.ts —
  // `assertCanCreateGuest`). We mirror it here without re-reading
  // legacy context.
  const guestsAllowed = plan === "PRO" || plan === "TEAM";
  return {
    plan,
    teamsUsed,
    teamsMax: projectMax(limits.maxTeams),
    membersMax: projectMax(limits.maxMembersPerTeam),
    smsInvitesIncluded: limits.smsInvitesEnabled,
    guestsAllowed,
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
  const account = useAccount();
  const personalSpace = usePersonalSpace();
  const activeSpace = useActiveSpace();
  const organizations = useOrganizations();

  const plan = useMemo<WorkspacePlan | null>(() => {
    if (!activeSpace) return account?.accountPlan ?? null;
    if (activeSpace.type === "ORGANIZATION") {
      const org = organizations.find((o) => o.id === activeSpace.id);
      return org?.plan ?? account?.accountPlan ?? null;
    }
    return personalSpace?.plan ?? account?.accountPlan ?? null;
  }, [account, activeSpace, organizations, personalSpace]);

  return useMemo<BillingSummary | null>(() => {
    if (plan === null) return null;
    const limits = getCollaborationTeamPlanLimits(plan);
    return projectFromLimits(plan, limits, teamsUsed);
  }, [plan, teamsUsed]);
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
  teamsUsed?: number;
}): Promise<BillingSummary | null> {
  if (!input.plan) return null;
  const limits = getCollaborationTeamPlanLimits(input.plan);
  return projectFromLimits(input.plan, limits, input.teamsUsed ?? 0);
}

/**
 * Test seam — exposes the per-plan limits table so unit tests can
 * verify cap projection without reaching into the shared package.
 */
export const __PLAN_LIMITS_FOR_TESTS__ = COLLABORATION_TEAM_PLAN_LIMITS;

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
  const active = envelope.activeSpace;
  let plan: WorkspacePlan | null = envelope.account?.accountPlan ?? null;
  if (active) {
    if (active.type === "ORGANIZATION") {
      const orgs = envelope.organizations ?? [];
      const org = orgs.find((o) => o.id === active.id);
      plan = org?.plan ?? plan;
    } else {
      plan = envelope.personalSpace?.plan ?? plan;
    }
  }
  if (plan === null) return null;
  const limits = getCollaborationTeamPlanLimits(plan);
  return projectFromLimits(plan, limits, teamsUsed);
}
