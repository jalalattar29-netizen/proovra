"use client";

/**
 * MAY THIS ACTOR OPEN THIS ROUTE? — ONE ANSWER FOR THE GATE AND FOR EVERY LINK.
 *
 * A page is guarded twice: the route group's `SurfaceGate` (the surface tier —
 * Enterprise-only, plan-entitled, internal) and the page's own
 * `PageRouteGate` (the registry entry — active space, capabilities, plan
 * feature). A link that renders when either would refuse is a link to a 404
 * or a denial panel.
 *
 * That is exactly what the Collaboration Team header did: it showed
 * "External reviewers" on `REVIEWER_OPS_VIEW` plus the PRO+ external-review
 * entitlement, while `/review/external` is an Enterprise-tier surface and an
 * Organization-only registry route. A TEAM owner on their Personal Workspace
 * held both of the link's conditions and met the app's not-found page.
 *
 * `routeAccessInputFromEnvelope` is the input `PageRouteGate` evaluates, built
 * in one place so the gate and the links that point at it cannot be fed
 * different facts. `useCanOpenRoute` answers both gates for a registered
 * route. It reads the same envelope, fails closed while it is loading, and
 * decides nothing the server does not also refuse: every mutation behind the
 * destination is still authorized by the API.
 */

import { canAccessSurface } from "../surface/access";
import { useSurfaceUserContext } from "../surface/useSurfaceUserContext";
import {
  usePersonalSpaceFragment,
  usePlatformContext,
  useWorkspaceFragment,
} from "../platform-context";
import type { PlatformContextEnvelope } from "../platform-context/types";
import { getRouteDefinition, type RouteDefinition } from "./routeRegistry";
import {
  resolveRouteAccess,
  type RouteAccessInput,
  type RouteAccessResult,
} from "./routeAccessResolver";

type SpaceFragment = { id: string | null; status: string | null } | null;

export function routeAccessInputFromEnvelope(
  route: RouteDefinition,
  envelope: PlatformContextEnvelope | null | undefined,
  workspaceFragment: SpaceFragment,
  personalSpaceFragment: SpaceFragment,
): RouteAccessInput {
  return {
    route,
    activeSpaceType: envelope?.activeSpace?.type ?? null,
    isPlatformAdmin: envelope?.platform?.isPlatformAdmin === true,
    capabilities: envelope?.capabilities ?? {},
    accountPlan: envelope?.account?.accountPlan ?? null,
    /**
     * PHASE 13 (NEW-033) — the enterprise and plan-feature inputs.
     *
     * `resolveRouteAccess` is deliberately fail-closed about them:
     * `routeRequiresEnterpriseWorkspace(route)` denies with NEEDS_UPGRADE unless
     * `isEnterpriseWorkspace === true`, and an absent input is not `true`. When
     * the page gate did not pass them, every Enterprise-only page refused real
     * Enterprise workspaces while the sidebar, All Tools and the palette —
     * which do pass them — kept showing the link.
     */
    isEnterpriseWorkspace: envelope?.flags?.isEnterpriseWorkspace === true,
    planFeatures: envelope?.planFeatures ?? null,
    // PERSONAL-FIRST RESCUE — the fragments let the resolver fall back to
    // workspace.id / personalSpace.id when activeSpace.type is missing from a
    // partial envelope, so personal-only users are never blocked from core
    // routes by a degraded projection.
    workspace: workspaceFragment,
    personalSpace: personalSpaceFragment,
  };
}

/** The registry decision `PageRouteGate` applies, or `null` for an unknown id. */
export function useRouteAccess(routeId: string): RouteAccessResult | null {
  const { envelope } = usePlatformContext();
  const workspace = useWorkspaceFragment();
  const personalSpace = usePersonalSpaceFragment();
  const route = getRouteDefinition(routeId);
  if (!route) return null;
  return resolveRouteAccess(
    routeAccessInputFromEnvelope(route, envelope, workspace, personalSpace),
  );
}

/**
 * True only when BOTH gates on the destination would let this actor in: the
 * registry route (`PageRouteGate`) and the surface tier of its path
 * (`SurfaceGate`). An unknown route id, a missing envelope or an unknown
 * entitlement answers false.
 */
export function useCanOpenRoute(routeId: string): boolean {
  const { envelope } = usePlatformContext();
  const access = useRouteAccess(routeId);
  const surface = useSurfaceUserContext();
  const route = getRouteDefinition(routeId);
  if (!envelope || !route || !access) return false;
  return access.canLoad && canAccessSurface(surface, route.href);
}
