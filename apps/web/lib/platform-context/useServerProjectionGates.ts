"use client";

/**
 * Track 1A (surface-tier removal, 2026-07-28) — SERVER-projection gate
 * hooks.
 *
 * These hooks replace the deleted `lib/surface/*` tier layer. Every
 * boolean they return is read DIRECTLY from the canonical
 * platform-context envelope the backend computed:
 *
 *   - `envelope.platform.isPlatformAdmin`   — platform elevation
 *   - `envelope.flags.isEnterpriseWorkspace` — ACTIVE workspace is on an
 *     Enterprise agreement (backend ENTERPRISE_PLAN_KEYS = {"ENTERPRISE"})
 *   - `envelope.planFeatures.*`             — commercial entitlements
 *     (backend PLAN_CAPABILITIES projection)
 *
 * The client NEVER derives these from a raw plan string. All hooks fail
 * CLOSED while the envelope is loading or degraded so gated surfaces
 * stay hidden until the server projection arrives.
 */

import { usePlatformContext } from "./PlatformContextProvider";
import type { PlatformContextPlanFeatures } from "./types";

/** Boolean keys of the server planFeatures projection. */
export type PlanFeatureBooleanKey = {
  [K in keyof PlatformContextPlanFeatures]-?: PlatformContextPlanFeatures[K] extends boolean
    ? K
    : never;
}[keyof PlatformContextPlanFeatures];

/**
 * True when the actor may use the ENTERPRISE workspace experience:
 * platform admin, or the ACTIVE workspace carries the server-computed
 * enterprise flag. The one sanctioned client read for "is this an
 * enterprise surface context" — the direct successor of the deleted
 * ENTERPRISE surface tier.
 */
export function useEnterpriseSurfaceAccess(): boolean {
  const ctx = usePlatformContext();
  const envelope = ctx?.envelope;
  if (!envelope) return false;
  return (
    envelope.platform?.isPlatformAdmin === true ||
    envelope.flags?.isEnterpriseWorkspace === true
  );
}

/**
 * Server-projected commercial entitlement. `null` = unknown (envelope
 * loading/degraded or an older backend that predates the key) — callers
 * must fail closed (treat as not-included) for gating, and avoid showing
 * "not included" upsells until the value is a real `false`.
 */
/**
 * PHASE 12 — POINT 7 (2026-08-05): the server-projected NUMERIC limits for the
 * ACTIVE workspace.
 *
 * `null` = UNKNOWN — the envelope is loading or degraded, or it predates the
 * projection. Callers must render an honest unknown state (no capacity badge,
 * no "at capacity" claim) rather than substituting a number. Fabricating a
 * limit is what the three collaboration surfaces used to do, by calling
 * `getCollaborationTeamPlanLimits(accountPlan)` in the browser: a duplicate
 * authority, keyed on the wrong commercial subject.
 *
 * The server remains the enforcement authority regardless of what this
 * returns. These values decide what a capacity badge SAYS, never what an
 * operation is ALLOWED to do.
 */
export type ServerWorkspaceLimits = {
  // BILLING PERSONAL/ORGANIZATION MODEL (2026-08-28) — see
  // `platform-context/types.ts`: no plan grants additional workspaces, so
  // there is no such limit to project or badge.
  maxCollaborationTeamsPerWorkspace: number;
  maxAcceptedMembersPerCollaborationTeam: number;
  maxWorkspaceSeats: number;
  maxPendingInvitesPerTeam: number;
  maxInvitesPer24h: number;
};

export function useWorkspaceLimits(): ServerWorkspaceLimits | null {
  const ctx = usePlatformContext();
  const limits = ctx?.envelope?.planFeatures?.limits;
  if (!limits || typeof limits.maxWorkspaceSeats !== "number") return null;
  return limits;
}

export function usePlanFeature(key: PlanFeatureBooleanKey): boolean | null {
  const ctx = usePlatformContext();
  const value = ctx?.envelope?.planFeatures?.[key];
  return typeof value === "boolean" ? value : null;
}

/**
 * Gate form of `usePlanFeature`: true iff the entitlement is KNOWN true,
 * or the actor is a platform admin (admins pass every commercial gate,
 * matching the historical surface behavior).
 */
export function usePlanFeatureGate(key: PlanFeatureBooleanKey): boolean {
  const ctx = usePlatformContext();
  const envelope = ctx?.envelope;
  if (!envelope) return false;
  if (envelope.platform?.isPlatformAdmin === true) return true;
  return envelope.planFeatures?.[key] === true;
}
