/**
 * ADM-013 PHASE 1 — THE one place that decides where "check the health" goes.
 *
 * ===========================================================================
 * THE DEAD END THIS REMOVES
 * ===========================================================================
 * Eleven tenant surfaces — the six investigation pages, the Command Center,
 * the governance control plane, the reviewer console, the global runtime
 * indicator and the runtime status banner — offered a "diagnostics" link when
 * `useCan("OBSERVABILITY_VIEW")` was true, and the link went to
 * `/admin/platform/observability`.
 *
 * `OBSERVABILITY_VIEW` is a PLATFORM key. It is granted to platform staff and
 * to nobody else. So on every one of those surfaces the branch resolved the
 * same way for the same population, and the outcome for a workspace operator
 * looking at a degraded banner was: no link at all, and no statement that a
 * different surface would answer their question. The banner said something is
 * wrong and offered nowhere to go.
 *
 * Two capabilities, two destinations, one resolver:
 *
 *   PLATFORM_TELEMETRY_VIEW → /admin/platform/observability
 *                             "Open Platform Observability"
 *   WORKSPACE_HEALTH_VIEW   → /operations/health
 *                             "View workspace health"
 *
 * Platform wins when an actor holds both: a platform operator reading a
 * degraded banner wants the global runtime, and the workspace view is one
 * click further on from there.
 *
 * ===========================================================================
 * WHY A RESOLVER AND NOT A CAPABILITY CHECK AT EACH SITE
 * ===========================================================================
 * Because eleven sites each spelling their own two-branch check is eleven
 * chances to spell one of them as the old single branch — which is how all
 * eleven came to have the same defect in the first place. A site now asks
 * "where does health live for THIS actor?" and renders what it gets back, or
 * renders nothing when it gets null.
 *
 * `label` is part of the return value on purpose. A link whose text does not
 * say which scope it opens is how "Observability" came to sit on a workspace
 * page and read as that workspace's observability.
 */

import { useCan } from "../platform-context";

/** Canonical platform runtime telemetry surface. Platform staff only. */
export const PLATFORM_OBSERVABILITY_HREF = "/admin/platform/observability";
/** Canonical workspace operational health surface. Tenant-scoped. */
export const WORKSPACE_HEALTH_HREF = "/operations/health";

export type HealthDestinationScope = "PLATFORM" | "WORKSPACE";

export type HealthDestination = {
  href: string;
  /** Explicit, scope-naming link text. Render it verbatim. */
  label: string;
  scope: HealthDestinationScope;
};

export const PLATFORM_HEALTH_DESTINATION: HealthDestination = {
  href: PLATFORM_OBSERVABILITY_HREF,
  label: "Open Platform Observability",
  scope: "PLATFORM",
};

export const WORKSPACE_HEALTH_DESTINATION: HealthDestination = {
  href: WORKSPACE_HEALTH_HREF,
  label: "View workspace health",
  scope: "WORKSPACE",
};

/**
 * Pure resolver. Exported separately from the hook so tests can drive every
 * combination without a provider, and so a server component can reuse it.
 */
export function resolveHealthDestination(input: {
  canPlatformTelemetry: boolean;
  canWorkspaceHealth: boolean;
}): HealthDestination | null {
  if (input.canPlatformTelemetry) return PLATFORM_HEALTH_DESTINATION;
  if (input.canWorkspaceHealth) return WORKSPACE_HEALTH_DESTINATION;
  return null;
}

/**
 * The hook every surface should call.
 *
 * Returns `null` when the actor holds neither authority — render no link at
 * all rather than a disabled one. A visible control that refuses on click is
 * worse than an absent control, and a disabled control with no explanation is
 * worse than both.
 */
export function useHealthDestination(): HealthDestination | null {
  const canPlatformTelemetry = useCan("PLATFORM_TELEMETRY_VIEW");
  const canWorkspaceHealth = useCan("WORKSPACE_HEALTH_VIEW");
  return resolveHealthDestination({ canPlatformTelemetry, canWorkspaceHealth });
}
