"use client";

/**
 * Phase IA-surface-tier — shared hook that builds `SurfaceUserContext`
 * from the canonical PlatformContext envelope.
 *
 * Used by `SurfaceGate`, `AppSidebarV2`, the All Tools page, the
 * command palette, and any other consumer that needs to apply
 * surface-tier visibility / access logic.
 *
 * Pure projection over the canonical envelope fields
 * (`activeSpace` + `personalSpace` + `organizations` + `platform` +
 * `flags`). The legacy singular-workspace field is NOT read.
 *
 * Fails CLOSED: while the platform-context fetch is in flight (or has
 * failed), the hook returns `ANONYMOUS_SURFACE_CONTEXT` so hidden
 * surfaces stay hidden during loading.
 */

import { usePlatformContext } from "../platform-context/PlatformContextProvider";

import {
  ANONYMOUS_SURFACE_CONTEXT,
  type SurfaceUserContext,
} from "./access";

export function useSurfaceUserContext(): SurfaceUserContext {
  const ctx = usePlatformContext();
  const envelope = ctx?.envelope;
  if (!envelope) return ANONYMOUS_SURFACE_CONTEXT;

  // PHASE 12B Track 1A — the raw plan name is NOT projected into the surface
  // context. PHASE 12 POINT 4 STEP 1 — neither is the workspace role: the
  // surface-tier rules decide on server-projected flags/entitlements only, so
  // this hook no longer resolves an active-space membership role at all.
  return {
    isPlatformAdmin: Boolean(envelope.platform?.isPlatformAdmin),
    isEnterpriseWorkspace: Boolean(envelope.flags?.isEnterpriseWorkspace),
    // OpsCenter visibility remediation (2026-07-18) — the canonical
    // commercial entitlement (backend PLAN_CAPABILITIES projection).
    // Rules with an `entitlementOverride` follow this value; while the
    // envelope lacks it (older backend / degraded path) the value stays
    // null and those rules fall back to their tier (fail-closed).
    planFeatures: {
      intakeIncluded:
        typeof envelope.planFeatures?.intakeIncluded === "boolean"
          ? envelope.planFeatures.intakeIncluded
          : null,
      // PHASE 12B Track 1A — SERVER-projected PROFESSIONAL-tier entitlement
      // (commercial-catalog-derived). Unknown while loading → fail closed.
      professionalSurfacesIncluded:
        typeof envelope.planFeatures?.professionalSurfacesIncluded === "boolean"
          ? envelope.planFeatures.professionalSurfacesIncluded
          : null,
    },
  };
}
